'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const idle = require('../utils/room-idle');
const start = 1_000_000;
const room = () => ({ id:'ABCDE', hostIds:[], players:[], lastRoomActivityAt:start });
const liveSocket = (id = 'ABCDE') => ({ connected:true, rooms:new Set([id]) });
test('expires exactly at ten minutes, not before', () => {
    const r = room(); const sockets = new Map();
    assert.equal(idle.roomIdleExpired(r, sockets, start + 599999), false);
    assert.equal(idle.roomIdleExpired(r, sockets, start + 600000), true);
});
test('an idle but connected host keeps the room alive', () => {
    const r = room(); r.hostIds = ['h'];
    assert.equal(idle.roomIdleExpired(r, new Map([['h', liveSocket()]]), start + 700000), false);
});
test('one remaining host tab keeps the room alive', () => {
    const r = room(); r.hostIds = ['closed', 'active'];
    assert.equal(idle.hasLiveRoomMember(r, new Map([['active', liveSocket()]])), true);
});
test('player keeps the room alive while host sleeps, including dead players', () => {
    const r = room(); r.players = [{id:'p', alive:false}];
    assert.equal(idle.roomIdleExpired(r, new Map([['p',liveSocket()]]), start + 700000), false);
});
test('bots cannot keep abandoned rooms alive', () => {
    const r = room(); r.players = [{id:'b',isBot:true}];
    assert.equal(idle.roomIdleExpired(r, new Map([['b',liveSocket()]]), start + 600000), true);
});
test('visitor and connection in a different room cannot keep it alive', () => {
    const r = room(); r.players = [{id:'p'}];
    const sockets = new Map([['visitor',liveSocket()], ['p',liveSocket('OTHER')]]);
    assert.equal(idle.roomIdleExpired(r, sockets, start + 600000), true);
});
test('disconnected transport does not count as presence', () => {
    const r = room(); r.hostIds = ['h'];
    assert.equal(idle.hasLiveRoomMember(r, new Map([['h',{...liveSocket(), connected:false}]])), false);
});
test('returning just before expiry gives a fresh ten minutes', () => {
    const r = room(); idle.touchRoomActivity(r, start + 599999);
    assert.equal(idle.roomIdleExpired(r, new Map(), start + 600000), false);
    assert.equal(idle.roomIdleExpired(r, new Map(), start + 1199999), true);
});
test('snapshot recovery retains its original absolute deadline', () => {
    const r = room(); idle.initializeRoomActivity(r, start);
    const restored = JSON.parse(JSON.stringify(r));
    idle.initializeRoomActivity(restored, start + 590000);
    assert.equal(restored.roomIdleExpiresAt, start + 600000);
    assert.equal(idle.roomIdleExpired(restored, new Map(), start + 600000), true);
});
test('legacy snapshot gets a single migration window', () => {
    const r = {id:'ABCDE',players:[]}; idle.initializeRoomActivity(r,start);
    idle.initializeRoomActivity(r,start+10000);
    assert.equal(r.roomIdleExpiresAt,start+600000);
});
test('closing room cannot be touched or treated as available', () => {
    const r = room(); r.isClosing = true;
    assert.equal(idle.touchRoomActivity(r,start+900000),false);
    assert.equal(r.lastRoomActivityAt,start);
    assert.equal(idle.hasLiveRoomMember(r,new Map()),false);
});
