(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.WerewolfAWS = api;
        root.io = () => new api.GameSocket({
            events: new api.EventConnection(root.WEREWOLF_CONFIG.events),
            game: root.WerewolfGame,
            kind: document.body.dataset.page,
            expectedHost: new URLSearchParams(location.hash.slice(1)).get('host') || ''
        });
    }
})(globalThis, function () {
    'use strict';
    const enc = new TextEncoder(), dec = new TextDecoder();
    const uuid = () => crypto.randomUUID();
    const b64 = bytes => btoa(Array.from(new Uint8Array(bytes), x => String.fromCharCode(x)).join(''));
    const unb64 = text => Uint8Array.from(atob(text), x => x.charCodeAt(0));
    const safeParse = text => { try { return JSON.parse(text); } catch (_) { return null; } };
    const delayError = () => new Error('ไม่พบโฮสต์ที่ออนไลน์ หรือคำขอหมดเวลา ให้โฮสต์เปิดหน้าห้องไว้แล้วลองใหม่');
    class Emitter {
        constructor() { this.listeners = new Map(); }
        on(event, action) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event).add(action); return this; }
        fire(event, data) { for (const action of this.listeners.get(event) || []) action(data); }
    }
    // Implements the documented AppSync Events WebSocket protocol, without AWS credentials or an SDK in the browser.
    class EventConnection extends Emitter {
        constructor(config, WebSocketImpl = globalThis.WebSocket) {
            super(); this.config = config; this.WebSocketImpl = WebSocketImpl;
            this.subscriptions = new Map(); this.pending = new Map(); this.connected = false; this.attempt = 0;
        }
        connect() {
            this.stopped = false;
            if (this.ws && this.ws.readyState < 2) return;
            if (!this.config?.httpUrl || !this.config?.realtimeUrl || !this.config?.apiKey) {
                this.fire('error', new Error('เว็บยังไม่พร้อมเล่น กรุณาให้เจ้าของเว็บตั้งค่า AppSync ตามคู่มือ deploy')); return;
            }
            this.authorization = { host: new URL(this.config.httpUrl).host, 'x-api-key': this.config.apiKey };
            const header = b64(enc.encode(JSON.stringify(this.authorization))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const ws = this.ws = new this.WebSocketImpl(this.config.realtimeUrl, ['aws-appsync-event-ws', `header-${header}`]);
            this.armWatchdog(15000);
            ws.onopen = () => ws.send(JSON.stringify({ type:'connection_init' }));
            ws.onmessage = event => {
                const message = safeParse(event.data); if (!message) return;
                if (message.type === 'connection_ack') {
                    this.keepAliveMs = message.connectionTimeoutMs || 300000;
                    this.armWatchdog(this.keepAliveMs);
                    (async () => {
                        try {
                            for (const [channel, sub] of this.subscriptions) await this.register(channel, sub);
                            if (this.ws !== ws || ws.readyState !== 1) return;
                            this.connected = true; this.attempt = 0; this.fire('connect');
                        } catch (error) { this.fire('error', error); ws.close(); }
                    })();
                } else if (message.type === 'ka') this.armWatchdog(this.keepAliveMs || 300000);
                else if (message.type === 'connection_error') {
                    this.stopped = true; this.fire('error', new Error('AppSync ปฏิเสธการเชื่อมต่อ ตรวจ API key และวันหมดอายุ')); ws.close();
                } else if (message.type === 'data') {
                    const sub = [...this.subscriptions.values()].find(item => item.id === message.id);
                    for (const value of message.event || []) { const data = safeParse(value); if (data) sub?.handler(data); }
                } else {
                    const pending = this.pending.get(message.id); if (!pending) return;
                    this.pending.delete(message.id); clearTimeout(pending.timer);
                    if (message.type.endsWith('_error') || message.failed?.length) pending.reject(new Error('AppSync ปฏิเสธคำขอ ตรวจ namespace default และสิทธิ์ API key'));
                    else pending.resolve();
                }
            };
            ws.onerror = () => this.fire('error', new Error('เชื่อมต่อ AppSync ไม่ได้ ตรวจ endpoint, API key และเครือข่าย'));
            ws.onclose = () => {
                clearTimeout(this.watchdog); this.connected = false;
                for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('ขาดการเชื่อมต่อ')); }
                this.pending.clear(); this.fire('disconnect');
                if (!this.stopped) this.retry = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) * (0.75 + Math.random() * 0.5));
            };
        }
        armWatchdog(ms) { clearTimeout(this.watchdog); this.watchdog = setTimeout(() => this.ws?.close(), ms); }
        operation(message) {
            return new Promise((resolve, reject) => {
                if (this.ws?.readyState !== 1) return reject(new Error('ยังไม่เชื่อมต่อ AppSync'));
                const id = message.id || uuid();
                const timer = setTimeout(() => { this.pending.delete(id); reject(delayError()); }, 10000);
                this.pending.set(id, { resolve, reject, timer });
                this.ws.send(JSON.stringify({ ...message, id, authorization:this.authorization }));
            });
        }
        register(channel, sub) { sub.id = uuid(); return this.operation({ type:'subscribe', channel, id:sub.id }); }
        async subscribe(channel, handler) {
            if (this.subscriptions.has(channel)) return;
            const sub = { handler }; this.subscriptions.set(channel, sub);
            try { await this.register(channel, sub); } catch (error) { this.subscriptions.delete(channel); throw error; }
        }
        async unsubscribe(channel) {
            const sub = this.subscriptions.get(channel); if (!sub) return;
            this.subscriptions.delete(channel);
            if (this.connected) await this.operation({ type:'unsubscribe', id:sub.id });
        }
        publish(channel, data) { return this.operation({ type:'publish', channel, events:[JSON.stringify(data)] }); }
        disconnect() { this.stopped = true; clearTimeout(this.retry); clearTimeout(this.watchdog); this.ws?.close(); }
    }
    async function identity() {
        const pair = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey']);
        const publicKey = b64(await crypto.subtle.exportKey('raw', pair.publicKey));
        return { pair, publicKey, fingerprint: await fingerprint(publicKey) };
    }
    async function fingerprint(publicKey) {
        const hash = await crypto.subtle.digest('SHA-256', unb64(publicKey));
        return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
    }
    async function sharedKey(privateKey, publicKey) {
        const key = await crypto.subtle.importKey('raw', unb64(publicKey), { name:'ECDH', namedCurve:'P-256' }, false, []);
        return crypto.subtle.deriveKey({ name:'ECDH', public:key }, privateKey, { name:'AES-GCM', length:256 }, false, ['encrypt', 'decrypt']);
    }
    async function seal(key, value, context) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:enc.encode(context) }, key, enc.encode(JSON.stringify(value)));
        return { iv:b64(iv), cipher:b64(encrypted) };
    }
    async function open(key, value, context) {
        if (typeof value.iv !== 'string' || typeof value.cipher !== 'string' || value.cipher.length > 100000) throw new Error('Invalid encrypted message');
        return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name:'AES-GCM', iv:unb64(value.iv), additionalData:enc.encode(context) }, key, unb64(value.cipher))));
    }
    class GameSocket extends Emitter {
        constructor({ events, game, kind, expectedHost = '' }) {
            super(); this.events = events; this.game = game; this.kind = kind; this.expectedHost = expectedHost; this.initialHost = expectedHost;
            this.clientId = uuid(); this.inbox = `/default/inbox/${this.clientId}`;
            this.peers = new Map(); this.pending = new Map(); this.connected = false; this.sequence = 0; this.counter = 0;
            this.queue = Promise.resolve(); this.inboxQueue = Promise.resolve();
            events.on('connect', () => {
                (async () => {
                    await events.subscribe(this.inbox, data => { this.inboxQueue = this.inboxQueue.then(() => this.receive(data)).catch(() => {}); });
                    if (this.room) { this.room.hostSockets.add(this.clientId); await this.publishState(); }
                    this.connected = true; this.fire('connect');
                    clearInterval(this.heartbeat); this.heartbeat = setInterval(() => this.tick().catch(() => {}), 30000);
                })().catch(error => this.fire('connect_error', error));
            });
            events.on('error', error => this.fire('connect_error', error));
            events.on('disconnect', () => {
                this.connected = false; clearInterval(this.heartbeat);
                if (this.room) this.room.hostSockets.clear();
                this.fire('disconnect');
            });
        }
        connect() { this.events.connect(); }
        disconnect() { clearInterval(this.heartbeat); this.events.disconnect(); for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(delayError()); } this.pending.clear(); }
        timeout(ms) {
            return { emit: (event, data, reply) => {
                this.invoke(event, data, ms).then(result => reply(null, { ok:true, ...result }), error => reply(null, { ok:false, error:error.message }));
            } };
        }
        async receive(data) {
            if (data.type === 'welcome' && this.hello && data.nonce === this.hello.nonce) {
                const hash = await fingerprint(data.publicKey);
                if (this.expectedHost && hash !== this.expectedHost) return;
                const key = await sharedKey((await this.getIdentity()).pair.privateKey, data.publicKey);
                const value = await open(key, data, `${this.roomId}:${this.clientId}:host`);
                if (value.nonce !== this.hello.nonce) return;
                if (this.peerEpoch !== value.epoch) this.lastStamp = 0;
                this.peerEpoch = value.epoch; this.peerKey = key; this.expectedHost = hash; this.hello.resolve(); this.hello = null;
                return;
            }
            if (!this.peerKey || !this.roomId) return;
            const value = await open(this.peerKey, data, `${this.roomId}:${this.clientId}:host:${this.peerEpoch}`);
            if (!Number.isSafeInteger(value.stamp) || value.stamp <= (this.lastStamp || 0)) return;
            this.lastStamp = value.stamp;
            if (value.type === 'reply') {
                const p = this.pending.get(value.id); if (!p) return;
                this.pending.delete(value.id); clearTimeout(p.timer);
                if (value.ok) p.resolve(value.result); else p.reject(new Error(value.error));
            } else if (value.type === 'state' && value.seq > (this.lastSequence || 0)) {
                this.lastSequence = value.seq; this.lastState = value.state; this.lastHostAt = Date.now(); this.fire('room:state', value.state);
            } else if (value.type === 'pong') {
                this.lastHostAt = Date.now();
                if (this.lastState && !this.lastState.hostConnected) { this.lastState = { ...this.lastState, hostConnected:true }; this.fire('room:state', this.lastState); }
            } else if (['room:closed', 'room:removed', 'room:left'].includes(value.type)) {
                this.lastState = null; this.member = false; this.initialHost = ''; this.fire(value.type, { message:value.message });
            }
        }
        getIdentity() { return this.identityPromise ||= identity(); }
        async handshake(roomId, ms) {
            if (this.roomId !== roomId) this.lastSequence = 0;
            this.roomId = roomId;
            const current = await this.getIdentity();
            await new Promise((resolve, reject) => {
                const nonce = uuid();
                const timer = setTimeout(() => { this.hello = null; reject(delayError()); }, ms);
                this.hello = { nonce, resolve: () => { clearTimeout(timer); resolve(); } };
                this.events.publish(`/default/${roomId}/requests`, { type:'hello', client:this.clientId, publicKey:current.publicKey, nonce })
                    .catch(error => { clearTimeout(timer); this.hello = null; reject(error); });
            });
        }
        transmit(id, event, data) {
            const task = (this.outQueue || Promise.resolve()).then(async () => {
                const payload = await seal(this.peerKey, { id, counter:++this.counter, event, data }, `${this.roomId}:${this.clientId}:player:${this.peerEpoch}`);
                await this.events.publish(`/default/${this.roomId}/requests`, { client:this.clientId, ...payload });
            });
            this.outQueue = task.catch(() => {}); return task;
        }
        request(event, data, ms = 15000) {
            const id = uuid();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { this.pending.delete(id); reject(delayError()); }, ms);
                this.pending.set(id, { resolve, reject, timer });
                this.transmit(id, event, data).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
            });
        }
        async invoke(event, data = {}, ms = 15000) {
            if (!this.connected) throw new Error('ยังไม่เชื่อมต่อ');
            if (this.kind === 'host') {
                const action = this.queue.then(() => this.hostAction(event, data));
                this.queue = action.catch(() => {}); return action;
            }
            if (event.startsWith('host:') || event === 'room:create') throw new Error('เฉพาะโฮสต์เท่านั้น');
            if (event === 'room:join' || event === 'room:resume') {
                const roomId = String(data.roomId || '').trim().toUpperCase();
                if (!/^[A-Z2-9]{5}$/.test(roomId)) throw new Error('รหัสห้องไม่ถูกต้อง');
                if (this.roomId !== roomId) this.expectedHost = data.hostFingerprint || this.initialHost || '';
                else if (data.hostFingerprint) this.expectedHost = data.hostFingerprint;
                await this.handshake(roomId, ms);
            }
            if (!this.peerKey) throw new Error('เข้าห้องก่อน');
            const result = await this.request(event, data, ms);
            if (event === 'room:join' || event === 'room:resume') { this.member = true; this.lastHostAt = Date.now(); result.hostFingerprint = this.expectedHost; }
            return result;
        }
        async create(data) {
            if (this.room) throw new Error('ปิดห้องเดิมก่อนสร้างห้องใหม่');
            const current = await this.getIdentity();
            const id = Array.from({ length:5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[this.gameRandom(32)]).join('');
            const room = this.game.createRoom(id, data.name);
            await this.events.subscribe(`/default/${id}/requests`, message => {
                this.queue = this.queue.then(() => this.hostReceive(message)).catch(() => {});
            });
            this.room = room; this.roomId = id; room.hostSockets.add(this.clientId);
            this.inviteFragment = `host=${current.fingerprint}`;
            this.fire('room:state', this.game.view(room, 'host'));
            return { roomId:id, token:room.hostToken, hostFingerprint:current.fingerprint, state:this.game.view(room, 'host') };
        }
        gameRandom(max) {
            const bound = Math.floor(0x100000000 / max) * max;
            let n; do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= bound);
            return n % max;
        }
        async hostReceive(message) {
            if (!this.room || !/^[a-f0-9-]{36}$/.test(message.client || '')) return;
            if (message.type === 'hello') {
                if (typeof message.nonce !== 'string' || message.nonce.length > 50 || typeof message.publicKey !== 'string' || message.publicKey.length > 100) return;
                // Only the initial public-key exchange is unencrypted. It contains no cards, names or tokens.
                if (this.peers.size >= 100 && !this.peers.has(message.client)) return;
                const old = this.peers.get(message.client);
                if (old && old.publicKey !== message.publicKey) return;
                const current = await this.getIdentity();
                const peer = old || { key:await sharedKey(current.pair.privateKey, message.publicKey), publicKey:message.publicKey, client:message.client, epoch:uuid(), counter:0, lastSeen:Date.now() };
                this.peers.set(message.client, peer);
                await this.events.publish(`/default/inbox/${message.client}`, {
                    type:'welcome', nonce:message.nonce, publicKey:current.publicKey,
                    ...await seal(peer.key, { nonce:message.nonce, epoch:peer.epoch }, `${this.roomId}:${message.client}:host`)
                });
                return;
            }
            const peer = this.peers.get(message.client); if (!peer) return;
            const value = await open(peer.key, message, `${this.roomId}:${message.client}:player:${peer.epoch}`);
            if (!Number.isSafeInteger(value.counter) || value.counter <= peer.counter || typeof value.id !== 'string' || value.id.length > 50) return;
            peer.counter = value.counter; peer.lastSeen = Date.now();
            if (!peer.bucketAt || Date.now() - peer.bucketAt > 10000) { peer.bucketAt = Date.now(); peer.bucketCount = 0; }
            if (++peer.bucketCount > 100) return;
            if (value.event === 'room:heartbeat') {
                if (!peer.playerId || !this.room.players.has(peer.playerId)) return;
                const player = this.room.players.get(peer.playerId), offline = !player.sockets.size;
                player.sockets.add(peer.client);
                await this.send(peer, { type:'pong' }); if (offline) await this.publishState(); return;
            }
            let result;
            try {
                result = { ok:true, result:await this.playerAction(peer, value.event, value.data || {}) };
            } catch (error) { result = { ok:false, error:error.message }; }
            await this.send(peer, { type:'reply', id:value.id, ...result });
        }
        send(peer, value) {
            const task = (peer.outQueue || Promise.resolve()).then(async () => {
                peer.stamp = (peer.stamp || 0) + 1;
                await this.events.publish(`/default/inbox/${peer.client}`, await seal(peer.key, { ...value, stamp:peer.stamp }, `${this.roomId}:${peer.client}:host:${peer.epoch}`));
            });
            peer.outQueue = task.catch(() => {}); return task;
        }
        async publishState() {
            if (!this.room) return;
            const room = this.room, seq = ++this.sequence;
            this.fire('room:state', this.game.view(room, 'host'));
            await Promise.all([...this.peers.values()].filter(peer => room.players.has(peer.playerId) && room.players.get(peer.playerId).sockets.has(peer.client)).map(peer =>
                this.send(peer, { type:'state', seq, state:this.game.view(room, 'player', peer.playerId) }).catch(() => {})
            ));
        }
        async playerAction(peer, event, data) {
            const room = this.room; let player = room.players.get(peer.playerId);
            if (event === 'room:join') {
                if (!player) { player = this.game.addPlayer(room, data.name); peer.playerId = player.id; }
                player.sockets.add(peer.client); await this.publishState();
                return { roomId:room.id, token:player.token, state:this.game.view(room, 'player', player.id) };
            }
            if (event === 'room:resume') {
                if (data.kind !== 'player') throw new Error('เฉพาะโฮสต์เท่านั้น');
                player = [...room.players.values()].find(item => item.token === data.token);
                if (!player) throw new Error('คุณไม่ได้อยู่ในห้องนี้แล้ว');
                peer.playerId = player.id; player.sockets.add(peer.client); await this.publishState();
                return { state:this.game.view(room, 'player', player.id) };
            }
            if (!player) throw new Error('คุณไม่ได้อยู่ในห้องนี้แล้ว');
            if (event !== 'player:leave') throw new Error('เฉพาะโฮสต์เท่านั้น');
            if (!['lobby', 'ended'].includes(room.phase)) throw new Error('ระหว่างเกมให้โฮสต์นำออก');
            await this.removePlayer(player, 'room:left', 'ออกจากห้องแล้ว'); return {};
        }
        async removePlayer(player, event, message) {
            await Promise.all([...this.peers.values()].filter(peer => peer.playerId === player.id).map(peer => this.send(peer, { type:event, message }).catch(() => {})));
            this.room.players.delete(player.id);
            for (const peer of this.peers.values()) if (peer.playerId === player.id) peer.playerId = null;
            await this.publishState();
        }
        async hostAction(event, data) {
            if (event === 'room:create') return this.create(data);
            const room = this.room;
            if (!room) throw new Error('ห้องหายแล้ว เมื่อรีเฟรชหรือปิดหน้าโฮสต์ ต้องสร้างห้องใหม่');
            if (event === 'room:resume') {
                if (data.kind !== 'host' || data.token !== room.hostToken) throw new Error('สิทธิ์โฮสต์ไม่ถูกต้อง');
                return { state:this.game.view(room, 'host') };
            }
            if (event === 'host:config') {
                if (room.phase !== 'lobby') throw new Error('แก้จำนวนบทบาทได้เฉพาะห้องรอ');
                room.config = this.game.config(data.config);
            } else if (event === 'host:deal') this.game.deal(room);
            else if (event === 'host:phase') {
                this.game.setPhase(room, data.phase);
                if (data.phase === 'ended') room.winner = String(data.winner || 'โฮสต์ประกาศจบเกม').trim().slice(0, 100);
            } else if (event === 'host:lobby') this.game.lobby(room);
            else if (event === 'host:player') {
                const player = room.players.get(data.playerId); if (!player) throw new Error('ไม่พบผู้เล่น');
                if (data.role !== undefined) {
                    if (['lobby', 'ended'].includes(room.phase) || !this.game.roleMap.has(data.role)) throw new Error('เปลี่ยนการ์ดได้ระหว่างเกมเท่านั้น');
                    player.role = data.role;
                }
                for (const field of ['alive', 'protected', 'killed']) if (typeof data[field] === 'boolean') player[field] = data[field];
            } else if (event === 'host:remove') {
                const player = room.players.get(data.playerId); if (!player) throw new Error('ไม่พบผู้เล่น');
                await this.removePlayer(player, 'room:removed', 'โฮสต์นำคุณออกจากห้อง'); return {};
            } else if (event === 'host:close') {
                await Promise.all([...this.peers.values()].filter(peer => room.players.has(peer.playerId)).map(peer => this.send(peer, { type:'room:closed', message:'โฮสต์ปิดห้องแล้ว' }).catch(() => {})));
                await this.events.unsubscribe(`/default/${room.id}/requests`);
                this.room = null; this.roomId = null; this.peers.clear(); this.inviteFragment = '';
                this.fire('room:closed', { message:'โฮสต์ปิดห้องแล้ว' }); return {};
            } else throw new Error('คำสั่งไม่ถูกต้อง');
            await this.publishState(); return {};
        }
        async tick() {
            if (!this.connected) return;
            if (this.kind === 'host' && this.room) {
                let changed = false;
                for (const [id, peer] of this.peers) {
                    if (Date.now() - peer.lastSeen > 90000) {
                        const player = this.room.players.get(peer.playerId);
                        if (player?.sockets.delete(peer.client)) changed = true;
                        this.peers.delete(id);
                    }
                }
                if (changed) await this.publishState();
            } else if (this.member && this.peerKey) {
                if (Date.now() - this.lastHostAt > 90000 && this.lastState?.hostConnected) {
                    this.lastState = { ...this.lastState, hostConnected:false }; this.fire('room:state', this.lastState);
                }
                await this.transmit(uuid(), 'room:heartbeat', {});
            }
        }
    }
    return { EventConnection, GameSocket, identity, sharedKey, seal, open, fingerprint };
});
