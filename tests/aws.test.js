'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../lib/game');
const { GameSocket, EventConnection, identity, sharedKey, open } = require('../public/js/aws-events');
function broker() {
    const clients = new Set(), audit = [];
    class Events {
        constructor() { this.subs = new Map(); this.handlers = new Map(); this.connected = false; clients.add(this); }
        on(event, callback) { this.handlers.set(event, callback); }
        connect() { this.connected = true; queueMicrotask(() => this.handlers.get('connect')?.()); }
        async subscribe(channel, handler) { this.subs.set(channel, handler); }
        async unsubscribe(channel) { this.subs.delete(channel); }
        async publish(channel, data) {
            if (!this.connected) throw new Error('offline');
            audit.push({ channel, data:structuredClone(data) });
            for (const client of clients) if (client.connected) queueMicrotask(() => client.subs.get(channel)?.(structuredClone(data)));
        }
        disconnect() { this.connected = false; this.handlers.get('disconnect')?.(); }
    }
    return { Events, audit };
}
async function fixture(t) {
    const { Events, audit } = broker(), sockets = [];
    t.after(() => sockets.forEach(socket => socket.disconnect()));
    async function connect(kind, options = {}) {
        const socket = new GameSocket({ events:new Events(), game, kind, ...options }); sockets.push(socket);
        const connected = new Promise(resolve => socket.on('connect', resolve)); socket.connect(); await connected; return socket;
    }
    return { connect, audit };
}
test('AWS relay: private cards, host-only control, manual phases, player refresh, kick and close without database', async t => {
    const { connect, audit } = await fixture(t);
    const host = await connect('host');
    const room = await host.invoke('room:create', { name:'Host' });
    const a = await connect('player', { expectedHost:room.hostFingerprint }), b = await connect('player', { expectedHost:room.hostFingerprint });
    const joinedA = await a.invoke('room:join', { roomId:room.roomId, name:'Alice' });
    const joinedB = await b.invoke('room:join', { roomId:room.roomId, name:'Bob' });
    assert.equal(host.room.players.size, 2);
    await assert.rejects(a.invoke('host:deal'), /เฉพาะโฮสต์/);
    await assert.rejects(a.request('host:deal', {}), /เฉพาะโฮสต์/);
    await assert.rejects(a.request('room:resume', { kind:'host', token:joinedA.token }), /เฉพาะโฮสต์/);
    await host.invoke('host:config', { config:{ 'หมาป่า':1, 'หมอ':1 } });
    await host.invoke('host:deal');
    await a.inboxQueue;
    assert.ok(a.lastState.self.card); assert.equal(a.lastState.players[1].role, undefined);
    assert.equal(a.lastState.config, undefined);
    const card = a.lastState.self.card.id;
    const transcript = JSON.stringify(audit);
    for (const secret of [room.token, joinedA.token, joinedB.token, 'Alice', 'Bob', 'หมาป่า', 'หมอ']) assert.ok(!transcript.includes(secret), secret);
    const bad = await identity();
    const otherKey = await sharedKey(bad.pair.privateKey, (await host.getIdentity()).publicKey);
    const statePacket = [...audit].reverse().find(item => item.channel === a.inbox && item.data.cipher);
    await assert.rejects(open(otherKey, statePacket.data, `${room.roomId}:${a.clientId}:host:${a.peerEpoch}`));
    a.disconnect();
    const refreshed = await connect('player');
    const resumed = await refreshed.invoke('room:resume', { roomId:room.roomId, kind:'player', token:joinedA.token, hostFingerprint:room.hostFingerprint });
    assert.equal(resumed.state.self.card.id, card);
    await host.invoke('host:player', { playerId:joinedA.state.self.id, alive:false, protected:true, role:'คนบ้า' });
    await refreshed.inboxQueue;
    assert.equal(refreshed.lastState.self.alive, false); assert.equal(refreshed.lastState.self.card.id, 'คนบ้า');
    await host.invoke('host:phase', { phase:'day' });
    await host.invoke('host:phase', { phase:'ended', winner:'Test' });
    await refreshed.inboxQueue;
    assert.ok(refreshed.lastState.players.every(player => player.role));
    await b.invoke('player:leave');
    await host.invoke('host:lobby');
    await host.invoke('host:remove', { playerId:joinedA.state.self.id });
    await assert.rejects(refreshed.invoke('room:resume', { roomId:room.roomId, kind:'player', token:joinedA.token }), /ไม่ได้อยู่/);
    await host.invoke('host:close'); assert.equal(host.room, null);
    const newHost = await connect('host');
    await assert.rejects(newHost.invoke('room:resume', { kind:'host', roomId:room.roomId, token:room.token }), /ห้องหาย/);
});
test('AWS relay rejects replay, wrong host fingerprint and tampering; presence expires offline clients', async t => {
    const { connect, audit } = await fixture(t);
    const host = await connect('host'), room = await host.invoke('room:create', { name:'Host' });
    const a = await connect('player');
    const joined = await a.invoke('room:join', { roomId:room.roomId, name:'Alice' });
    const joinPacket = audit.find(item => item.channel.endsWith('/requests') && item.data.cipher);
    await a.invoke('player:leave');
    const oldTerminal = [...audit].reverse().find(item => item.channel === a.inbox && item.data.cipher);
    await a.events.publish(joinPacket.channel, joinPacket.data); await host.queue;
    assert.equal(host.room.players.size, 0);
    await a.invoke('room:join', { roomId:room.roomId, name:'Alice' });
    await a.events.publish(a.inbox, oldTerminal.data); await a.inboxQueue;
    assert.equal(a.member, true, 'replayed leave response must not evict a new membership');
    await a.events.publish(joinPacket.channel, { ...joinPacket.data, cipher:'tampered' }); await host.queue;
    assert.equal(host.room.players.size, 1);
    const wrong = await connect('player', { expectedHost:'0'.repeat(64) });
    await assert.rejects(wrong.invoke('room:join', { roomId:room.roomId, name:'wrong' }, 100), /หมดเวลา/);
    const b = await connect('player');
    const bJoined = await b.invoke('room:join', { roomId:room.roomId, name:'Bob' });
    host.peers.get(b.clientId).lastSeen = Date.now() - 91000;
    await host.tick(); assert.equal(host.room.players.get(bJoined.state.self.id).sockets.size, 0);
    await assert.rejects(host.invoke('host:deal'), /ออฟไลน์/);
    host.disconnect();
    const reconnect = new Promise(resolve => host.on('connect', resolve)); host.connect(); await reconnect;
    assert.equal(host.room.id, room.roomId, 'a transient connection loss preserves the open host tab');
    assert.ok(joined.token);
});
test('AppSync protocol: API-key subprotocol, acknowledged subscribe/publish, string event parsing and failed-publish rejection', async t => {
    const frames = [];
    class FakeWS {
        constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; FakeWS.instance = this; queueMicrotask(() => { this.readyState = 1; this.onopen(); }); }
        send(text) {
            const m = JSON.parse(text); frames.push(m);
            queueMicrotask(() => {
                let result;
                if (m.type === 'connection_init') result = { type:'connection_ack', connectionTimeoutMs:300000 };
                if (m.type === 'subscribe') result = { type:'subscribe_success', id:m.id };
                if (m.type === 'publish') result = { type:'publish_success', id:m.id, failed:this.fail ? [{ index:0 }] : [] };
                if (m.type === 'unsubscribe') result = { type:'unsubscribe_success', id:m.id };
                if (result) this.onmessage({ data:JSON.stringify(result) });
            });
        }
        close() { this.readyState = 3; this.onclose?.(); }
    }
    const connection = new EventConnection({ httpUrl:'https://example.appsync-api.ap-southeast-2.amazonaws.com/event', realtimeUrl:'wss://example.appsync-realtime-api.ap-southeast-2.amazonaws.com/event/realtime', apiKey:'da2-test' }, FakeWS);
    t.after(() => connection.disconnect());
    const ready = new Promise(resolve => connection.on('connect', resolve)); connection.connect(); await ready;
    assert.equal(FakeWS.instance.protocols[0], 'aws-appsync-event-ws');
    const auth = JSON.parse(Buffer.from(FakeWS.instance.protocols[1].slice(7), 'base64url').toString());
    assert.equal(auth.host, 'example.appsync-api.ap-southeast-2.amazonaws.com'); assert.equal(auth['x-api-key'], 'da2-test');
    let received; await connection.subscribe('/default/test', value => { received = value; });
    const sub = frames.find(frame => frame.type === 'subscribe');
    FakeWS.instance.onmessage({ data:JSON.stringify({ type:'data', id:sub.id, event:[JSON.stringify({ hello:'world' })] }) });
    assert.deepEqual(received, { hello:'world' });
    await connection.publish('/default/test', { hello:'world' });
    assert.equal(typeof frames.find(frame => frame.type === 'publish').events[0], 'string');
    FakeWS.instance.fail = true; await assert.rejects(connection.publish('/default/test', {}), /ปฏิเสธ/);
    connection.disconnect();
    const reconnected = new Promise(resolve => connection.on('connect', resolve)); connection.connect(); await reconnected;
    assert.equal(frames.filter(frame => frame.type === 'subscribe').length, 2, 'subscriptions are restored before reconnect completes');
    await connection.unsubscribe('/default/test');
});
