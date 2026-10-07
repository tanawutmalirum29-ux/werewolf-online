'use strict';
const crypto = require('node:crypto');
const roles = require('../roles.json');
const roleMap = new Map(roles.map(role => [role.id, role]));
const MAX_PLAYERS = 40;
function fail(message) { throw new Error(message); }
function name(value) {
    const result = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30);
    if (!result) fail('กรุณาใส่ชื่อ');
    return result;
}
function token() { return crypto.randomBytes(32).toString('hex'); }
function config(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('จำนวนบทบาทไม่ถูกต้อง');
    const result = {};
    let sum = 0;
    for (const role of roles) {
        const count = value[role.id] ?? 0;
        if (!Number.isInteger(count) || count < 0 || count > MAX_PLAYERS) fail('จำนวนบทบาทต้องเป็นจำนวนเต็ม 0–40');
        result[role.id] = count;
        sum += count;
    }
    if (sum > MAX_PLAYERS) fail('การ์ดรวมต้องไม่เกิน 40 ใบ');
    return result;
}
function createRoom(id, hostName) {
    return { id, hostName: name(hostName), hostToken: token(), hostSockets: new Set(), players: new Map(),
        config: config({ 'หมาป่า': 1 }), phase: 'lobby', round: 1, winner: '', lastActivity: Date.now() };
}
function addPlayer(room, playerName) {
    if (room.phase !== 'lobby') fail('ห้องนี้เริ่มเกมแล้ว รอให้โฮสต์เปิดรอบใหม่');
    if (room.players.size >= MAX_PLAYERS) fail('ห้องเต็มแล้ว (สูงสุด 40 คน)');
    const cleanName = name(playerName);
    if ([...room.players.values()].some(player => player.name.toLowerCase() === cleanName.toLowerCase())) fail('มีคนใช้ชื่อนี้แล้ว กรุณาเปลี่ยนชื่อ');
    const player = { id: crypto.randomUUID(), token: token(), name: cleanName, role: null,
        alive: true, protected: false, killed: false, sockets: new Set() };
    room.players.set(player.id, player);
    return player;
}
function shuffled(array) {
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}
function deal(room) {
    if (room.phase !== 'lobby') fail('กลับห้องรอก่อนแจกการ์ดรอบใหม่');
    const players = [...room.players.values()];
    if (!players.length) fail('ต้องมีผู้เล่นอย่างน้อยหนึ่งคน โฮสต์เป็นผู้คุมเกม');
    if (players.some(player => !player.sockets.size)) fail('มีผู้เล่นออฟไลน์ ให้รอเชื่อมต่อหรือนำออกก่อนแจก');
    const deck = Object.entries(room.config).flatMap(([id, count]) => Array(count).fill(id));
    if (deck.length > players.length) fail('การ์ดมากกว่าผู้เล่น ลดจำนวนบทบาทก่อนแจก');
    while (deck.length < players.length) deck.push('ชาวบ้าน');
    const randomized = shuffled(deck);
    players.forEach((player, i) => Object.assign(player, { role: randomized[i], alive: true, protected: false, killed: false }));
    room.phase = 'night'; room.round = 1; room.winner = '';
}
function setPhase(room, phase) {
    if (!['day', 'night', 'ended'].includes(phase)) fail('ช่วงเกมไม่ถูกต้อง');
    if (room.phase === 'lobby') fail('แจกการ์ดก่อนเริ่มเกม');
    if (room.phase === 'ended') fail('เกมจบแล้ว กลับห้องรอเพื่อเล่นรอบใหม่');
    if (phase === 'night' && room.phase === 'day') {
        room.round++;
        for (const player of room.players.values()) { player.protected = false; player.killed = false; }
    }
    room.phase = phase;
}
function lobby(room) {
    room.phase = 'lobby'; room.round = 1; room.winner = '';
    for (const player of room.players.values()) Object.assign(player, { role: null, alive: true, protected: false, killed: false });
}
function playerInfo(player, includeRole) {
    const info = { id: player.id, name: player.name, alive: player.alive, connected: player.sockets.size > 0 };
    if (includeRole) Object.assign(info, { role: player.role, protected: player.protected, killed: player.killed });
    return info;
}
function view(room, kind, playerId) {
    const host = kind === 'host';
    const result = { id: room.id, hostName: room.hostName, hostConnected: room.hostSockets.size > 0,
        phase: room.phase, round: room.round, winner: room.winner,
        players: [...room.players.values()].map(player => playerInfo(player, host || room.phase === 'ended')) };
    if (host) result.config = { ...room.config };
    else {
        const self = room.players.get(playerId);
        if (!self) fail('คุณไม่ได้อยู่ในห้องนี้แล้ว');
        result.self = { ...playerInfo(self, false), role: self.role, card: self.role ? roleMap.get(self.role) : null };
    }
    return result;
}
module.exports = { roles, roleMap, MAX_PLAYERS, createRoom, addPlayer, config, deal, setPhase, lobby, view };
