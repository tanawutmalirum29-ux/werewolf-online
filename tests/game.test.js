'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const game = require('../lib/game');
function fixture(count = 5) {
    const room = game.createRoom('ABCDE', 'Host');
    for (let i = 0; i < count; i++) game.addPlayer(room, 'Player ' + i).sockets.add('socket-' + i);
    return room;
}
test('deal uses exact chosen roles, fills villagers and rejects extra cards without changing room', () => {
    const room = fixture();
    room.config = game.config({ 'หมาป่า':2, 'หมอ':1 });
    game.deal(room);
    const cards = [...room.players.values()].map(player => player.role);
    assert.equal(cards.filter(role => role === 'หมาป่า').length, 2);
    assert.equal(cards.filter(role => role === 'หมอ').length, 1);
    assert.equal(cards.filter(role => role === 'ชาวบ้าน').length, 2);
    assert.equal(room.phase, 'night');
    assert.throws(() => game.deal(room));
    game.lobby(room); room.config = game.config({ 'หมาป่า':6 });
    assert.throws(() => game.deal(room), /การ์ดมากกว่า/);
    assert.equal(room.phase, 'lobby');
    assert.ok([...room.players.values()].every(player => player.role === null));
});
test('player payload excludes other roles, marks and every membership credential until manual ending', () => {
    const room = fixture(3); game.deal(room);
    const players = [...room.players.values()]; players[1].protected = true; players[1].killed = true;
    const result = game.view(room, 'player', players[0].id);
    assert.equal(result.self.role, players[0].role);
    assert.equal(result.self.card.id, players[0].role);
    for (const player of result.players) {
        assert.equal(player.role, undefined); assert.equal(player.token, undefined);
        assert.equal(player.killed, undefined); assert.equal(player.protected, undefined);
    }
    assert.equal(result.self.killed, undefined);
    assert.equal(result.config, undefined);
    for (const secret of [room.hostToken, ...players.map(player => player.token)]) assert.ok(!JSON.stringify(result).includes(secret));
    const host = game.view(room, 'host'); assert.ok(host.players.every(player => player.role));
    game.setPhase(room, 'ended'); assert.ok(game.view(room, 'player', players[0].id).players.every(player => player.role));
});
test('manual phases clear night marks but do not automatically kill protected or targeted players', () => {
    const room = fixture(); game.deal(room);
    const player = [...room.players.values()][0]; player.protected = true; player.killed = true;
    game.setPhase(room, 'day'); assert.equal(player.alive, true); assert.equal(player.killed, true);
    game.setPhase(room, 'night'); assert.equal(room.round, 2); assert.equal(player.killed, false); assert.equal(player.protected, false);
    player.alive = false; game.lobby(room); assert.equal(player.alive, true); assert.equal(player.role, null);
});
test('input boundaries enforce unique names, room capacity and whole-number role counts', () => {
    const room = fixture(40);
    assert.throws(() => game.addPlayer(room, 'extra'), /ห้องเต็ม/);
    assert.throws(() => game.config({ 'หมาป่า': -1 }));
    assert.throws(() => game.config({ 'หมาป่า': 1.5 }));
    assert.throws(() => game.config({ 'หมาป่า': 40, 'หมอ':1 }));
    assert.throws(() => game.createRoom('ABCDE', '  '));
    const small = fixture(1); assert.throws(() => game.addPlayer(small, 'Player 0'), /ใช้ชื่อนี้แล้ว/);
    [...small.players.values()][0].sockets.clear(); assert.throws(() => game.deal(small), /ออฟไลน์/);
});
