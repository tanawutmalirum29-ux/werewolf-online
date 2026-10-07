'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: client } = require('socket.io-client');
const { createServer } = require('../server');
async function fixture(t, options) {
    const runtime = createServer(options), sockets = [];
    await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${runtime.server.address().port}`;
    t.after(async () => {
        for (const socket of sockets) socket.disconnect();
        await new Promise(resolve => runtime.io.close(resolve));
    });
    async function connect(transport = 'websocket', origin) {
        const socket = client(url, { transports:[transport], reconnection:false, ...(origin ? { extraHeaders:{ Origin:origin } } : {}) }); sockets.push(socket);
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
        return socket;
    }
    return { ...runtime, url, connect };
}
const ask = (socket, event, data = {}) => socket.timeout(3000).emitWithAck(event, data);
test('online room lifecycle: scoped host control, private deal, normal reconnect, manual role/phase changes and close', async t => {
    const { connect, rooms } = await fixture(t);
    const host = await connect(), playerA = await connect(), playerB = await connect();
    const created = await ask(host, 'room:create', { name:'Host' }); assert.equal(created.ok, true);
    const a = await ask(playerA, 'room:join', { roomId:created.roomId.toLowerCase(), name:'A' });
    const b = await ask(playerB, 'room:join', { roomId:created.roomId, name:'B' }); assert.equal(b.ok, true);
    assert.equal((await ask(playerA, 'host:deal')).ok, false);
    assert.equal((await ask(playerA, 'room:resume', { roomId:created.roomId, kind:'host', token:a.token })).ok, false);
    assert.equal((await ask(host, 'host:config', { config:{ 'หมาป่า':1, 'หมอ':1 } })).ok, true);
    const aState = new Promise(resolve => { const listener = state => { if (state.phase === 'night') { playerA.off('room:state', listener); resolve(state); } }; playerA.on('room:state', listener); });
    assert.equal((await ask(host, 'host:deal')).ok, true);
    const dealt = await aState; assert.ok(dealt.self.card); assert.equal(dealt.players[1].role, undefined);
    assert.equal((await ask(host, 'host:config', { config:{} })).ok, false);
    const late = await connect(); assert.equal((await ask(late, 'room:join', { roomId:created.roomId, name:'late' })).ok, false);
    playerA.disconnect(); await new Promise(resolve => setImmediate(resolve));
    const resumed = await connect(); const response = await ask(resumed, 'room:resume', { kind:'player', roomId:created.roomId, token:a.token });
    assert.equal(response.ok, true); assert.equal(response.state.self.card.id, dealt.self.card.id);
    assert.equal((await ask(host, 'host:player', { playerId:a.state.self.id, alive:false, protected:true, role:'คนบ้า' })).ok, true);
    assert.equal((await ask(host, 'host:phase', { phase:'day' })).ok, true);
    assert.equal((await ask(host, 'host:phase', { phase:'ended', winner:'Test winner' })).ok, true);
    assert.equal((await ask(resumed, 'player:leave')).ok, true);
    assert.equal((await ask(host, 'host:lobby')).ok, true);
    assert.equal((await ask(host, 'host:remove', { playerId:b.state.self.id })).ok, true);
    assert.equal(rooms.get(created.roomId).players.size, 0);
    assert.equal((await ask(host, 'host:close')).ok, true); assert.equal(rooms.size, 0);
});
test('one host cannot control another room; removed users cannot resume and replacement server has no rooms', async t => {
    const first = await fixture(t), second = await fixture(t);
    const hostA = await first.connect(), hostB = await first.connect(), player = await first.connect();
    const roomA = await ask(hostA, 'room:create', { name:'Host A' });
    const roomB = await ask(hostB, 'room:create', { name:'Host B' });
    const joined = await ask(player, 'room:join', { roomId:roomA.roomId, name:'Player' });
    assert.equal((await ask(hostB, 'host:remove', { roomId:roomA.roomId, playerId:joined.state.self.id })).ok, false);
    assert.equal(first.rooms.get(roomA.roomId).players.size, 1);
    await ask(hostA, 'host:remove', { playerId:joined.state.self.id });
    assert.equal((await ask(player, 'room:resume', { roomId:roomA.roomId, token:joined.token })).ok, false);
    const fresh = await second.connect();
    assert.equal((await ask(fresh, 'room:resume', { kind:'host', roomId:roomB.roomId, token:roomB.token })).ok, false);
});
test('three pages and role assets are served; admin/API/deployment endpoints are gone; polling fallback works', async t => {
    const { url, connect } = await fixture(t);
    for (const page of ['/', '/host.html', '/player.html', '/api/roles', '/health', '/style.css', '/js/app.js', '/images/werewolf.jpg']) {
        const response = await fetch(url + page); assert.equal(response.status, 200, page);
    }
    for (const page of ['/admin.html', '/api/admin/session', '/api/config', '/ready']) assert.equal((await fetch(url + page)).status, 404, page);
    const socket = await connect('polling'); assert.equal((await ask(socket, 'room:create', { name:'Polling Host' })).ok, true);
});
test('Amplify frontend can fetch roles and play across origins with polling and WebSocket; other origins are rejected', async t => {
    const origin = 'https://main.example.amplifyapp.com';
    const { url, connect } = await fixture(t, { allowedOrigins:origin });
    const response = await fetch(url + '/api/roles', { headers:{ Origin:origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.ok((await response.json()).length);
    assert.equal((await fetch(url + '/api/roles', { headers:{ Origin:'https://unlisted.example' } })).status, 403);
    const host = await connect('polling', origin), player = await connect('websocket', origin);
    const room = await ask(host, 'room:create', { name:'Amplify Host' });
    const joined = await ask(player, 'room:join', { roomId:room.roomId, name:'Amplify Player' });
    assert.equal(joined.ok, true);
    assert.equal((await ask(host, 'host:deal')).ok, true);
    const restored = await ask(player, 'room:resume', { kind:'player', roomId:room.roomId, token:joined.token });
    assert.equal(restored.ok, true);
    assert.ok(restored.state.self.card);
    assert.equal(restored.state.players[0].role, undefined);
    for (const transport of ['polling', 'websocket']) {
        await assert.rejects(connect(transport, 'https://unlisted.example'));
    }
});
