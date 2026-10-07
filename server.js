'use strict';
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const game = require('./lib/game');

function createServer({ allowedOrigins = process.env.ALLOWED_ORIGINS || '' } = {}) {
    const origins = new Set(allowedOrigins.split(',').map(value => value.trim()).filter(Boolean).map(value => {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('ALLOWED_ORIGINS must contain only comma-separated HTTP(S) origins');
        }
        return url.origin;
    }));
    function permitsOrigin(req) {
        const origin = req.headers.origin;
        if (!origin || origins.has(origin)) return true;
        try {
            const url = new URL(origin);
            return ['http:', 'https:'].includes(url.protocol) && url.origin === origin && url.host === req.headers.host;
        } catch (_) { return false; }
    }
    const app = express();
    app.disable('x-powered-by');
    const server = http.createServer(app);
    const io = new Server(server, {
        maxHttpBufferSize: 16 * 1024, pingInterval: 25000, pingTimeout: 60000,
        cors: { origin: [...origins], methods: ['GET', 'POST'] },
        allowRequest: (req, done) => done(null, permitsOrigin(req))
    });
    const rooms = new Map(); // All game state is RAM-only. Restart starts with no rooms.
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/roles', (req, res) => {
        if (!permitsOrigin(req)) return res.sendStatus(403);
        if (origins.has(req.headers.origin)) {
            res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
            res.vary('Origin');
        }
        res.json(game.roles);
    });
    app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
    app.use(express.static(path.join(__dirname, 'public')));

    function roomCode(value) { return String(value || '').trim().toUpperCase(); }
    function findRoom(value) {
        const room = rooms.get(roomCode(value));
        if (!room) throw new Error('ไม่พบห้อง ห้องอาจปิดไปแล้วหรือเซิร์ฟเวอร์เริ่มใหม่');
        return room;
    }
    function membership(socket, hostOnly = false) {
        const room = findRoom(socket.data.roomId);
        if (hostOnly && socket.data.kind !== 'host') throw new Error('เฉพาะโฮสต์เท่านั้น');
        if (socket.data.kind === 'host' && !room.hostSockets.has(socket.id)) throw new Error('ไม่ใช่โฮสต์ของห้องนี้');
        if (socket.data.kind === 'player' && !room.players.get(socket.data.playerId)?.sockets.has(socket.id)) throw new Error('คุณไม่ได้อยู่ในห้องนี้');
        room.lastActivity = Date.now();
        return room;
    }
    function publish(room) {
        for (const id of room.hostSockets) io.sockets.sockets.get(id)?.emit('room:state', game.view(room, 'host'));
        for (const player of room.players.values()) for (const id of player.sockets) {
            io.sockets.sockets.get(id)?.emit('room:state', game.view(room, 'player', player.id));
        }
    }
    function detach(socket) {
        const room = rooms.get(socket.data.roomId);
        if (room) {
            room.hostSockets.delete(socket.id);
            room.players.get(socket.data.playerId)?.sockets.delete(socket.id);
            room.lastActivity = Date.now();
            socket.leave(room.id);
        }
        socket.data = {};
        return room;
    }
    function attach(socket, room, kind, player) {
        const previous = detach(socket);
        if (previous && previous !== room) publish(previous);
        socket.data = { roomId: room.id, kind, playerId: player?.id };
        (kind === 'host' ? room.hostSockets : player.sockets).add(socket.id);
        socket.join(room.id);
        room.lastActivity = Date.now();
    }
    function sameToken(a, b) {
        return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    }
    function closeRoom(room) {
        io.to(room.id).emit('room:closed', { message: 'โฮสต์ปิดห้องแล้ว' });
        for (const socket of io.sockets.sockets.values()) if (socket.data.roomId === room.id) { socket.leave(room.id); socket.data = {}; }
        rooms.delete(room.id);
    }
    io.on('connection', socket => {
        let bucketAt = Date.now(), bucketCount = 0;
        function on(event, action) {
            socket.on(event, (payload, reply) => {
                if (typeof payload === 'function') { reply = payload; payload = {}; }
                if (typeof reply !== 'function') reply = () => {};
                try {
                    if (Date.now() - bucketAt > 10000) { bucketAt = Date.now(); bucketCount = 0; }
                    if (++bucketCount > 100) throw new Error('ส่งคำสั่งเร็วเกินไป รอสักครู่');
                    const result = action(payload && typeof payload === 'object' ? payload : {});
                    reply({ ok: true, ...result });
                } catch (error) { reply({ ok: false, error: error.message }); }
            });
        }
        on('room:create', data => {
            if (rooms.size >= 100) throw new Error('เซิร์ฟเวอร์มีห้องเต็มแล้ว ลองใหม่ภายหลัง');
            if (socket.data.roomId) throw new Error('ออกจากห้องเดิมก่อนสร้างห้องใหม่');
            let id;
            do { id = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''); } while (rooms.has(id));
            const room = game.createRoom(id, data.name);
            rooms.set(id, room); attach(socket, room, 'host');
            publish(room);
            return { roomId: id, token: room.hostToken, state: game.view(room, 'host') };
        });
        on('room:join', data => {
            if (socket.data.roomId) throw new Error('ออกจากห้องเดิมก่อนเข้าห้องใหม่');
            const room = findRoom(data.roomId);
            const player = game.addPlayer(room, data.name);
            attach(socket, room, 'player', player); publish(room);
            return { roomId: room.id, token: player.token, state: game.view(room, 'player', player.id) };
        });
        on('room:resume', data => {
            const room = findRoom(data.roomId);
            if (data.kind === 'host') {
                if (!sameToken(data.token, room.hostToken)) throw new Error('สิทธิ์โฮสต์ไม่ถูกต้อง');
                attach(socket, room, 'host'); publish(room);
                return { state: game.view(room, 'host') };
            }
            const player = [...room.players.values()].find(player => sameToken(data.token, player.token));
            if (!player) throw new Error('คุณไม่ได้อยู่ในห้องนี้แล้ว');
            attach(socket, room, 'player', player); publish(room);
            return { state: game.view(room, 'player', player.id) };
        });
        on('host:config', data => {
            const room = membership(socket, true);
            if (room.phase !== 'lobby') throw new Error('แก้จำนวนบทบาทได้เฉพาะตอนรอแจกการ์ด');
            room.config = game.config(data.config); publish(room); return {};
        });
        on('host:deal', () => { const room = membership(socket, true); game.deal(room); publish(room); return {}; });
        on('host:phase', data => {
            const room = membership(socket, true); game.setPhase(room, data.phase);
            if (data.phase === 'ended') room.winner = String(data.winner || 'โฮสต์ประกาศจบเกม').trim().slice(0, 100);
            publish(room); return {};
        });
        on('host:lobby', () => { const room = membership(socket, true); game.lobby(room); publish(room); return {}; });
        on('host:player', data => {
            const room = membership(socket, true), player = room.players.get(data.playerId);
            if (!player) throw new Error('ไม่พบผู้เล่น');
            if (data.role !== undefined) {
                if (room.phase === 'lobby' || room.phase === 'ended' || !game.roleMap.has(data.role)) throw new Error('เปลี่ยนการ์ดได้ระหว่างเกมเท่านั้น');
                player.role = data.role;
            }
            for (const field of ['alive', 'protected', 'killed']) if (typeof data[field] === 'boolean') player[field] = data[field];
            publish(room); return {};
        });
        on('host:remove', data => {
            const room = membership(socket, true), player = room.players.get(data.playerId);
            if (!player) throw new Error('ไม่พบผู้เล่น');
            for (const id of player.sockets) {
                const target = io.sockets.sockets.get(id);
                target?.emit('room:removed', { message: 'โฮสต์นำคุณออกจากห้อง' });
                if (target) { target.leave(room.id); target.data = {}; }
            }
            room.players.delete(player.id); publish(room); return {};
        });
        on('host:close', () => { closeRoom(membership(socket, true)); return {}; });
        on('player:leave', () => {
            const room = membership(socket);
            if (socket.data.kind !== 'player') throw new Error('โฮสต์ต้องใช้ปุ่มปิดห้อง');
            if (room.phase !== 'lobby' && room.phase !== 'ended') throw new Error('ระหว่างเกมให้โฮสต์นำออก หรือปิดแท็บเพื่อพักการเชื่อมต่อ');
            const player = room.players.get(socket.data.playerId);
            for (const id of player.sockets) {
                const target = io.sockets.sockets.get(id);
                if (target) { target.leave(room.id); target.data = {}; target.emit('room:left'); }
            }
            room.players.delete(player.id); publish(room); return {};
        });
        socket.on('disconnect', () => { const room = detach(socket); if (room) publish(room); });
    });
    // Bound RAM usage without storing rooms or restoring them after server failure.
    const cleanup = setInterval(() => {
        for (const room of rooms.values()) {
            const connected = room.hostSockets.size || [...room.players.values()].some(player => player.sockets.size);
            if (!connected && Date.now() - room.lastActivity > 30 * 60000) rooms.delete(room.id);
        }
    }, 60000);
    cleanup.unref();
    server.on('close', () => clearInterval(cleanup));
    return { app, server, io, rooms };
}
if (require.main === module) {
    const { server } = createServer();
    server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('Werewolf Basic is running'));
}
module.exports = { createServer };
