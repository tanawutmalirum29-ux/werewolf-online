'use strict';
const assert = require('assert');
const {
  createRoomRegistry,
  createSimulatedRoom,
  joinSimulatedRoom,
  hostLoginSimulated,
  simulateRoomSecurityMatrix,
} = require('../utils/bug-replay-game-simulator');

const matrix = simulateRoomSecurityMatrix();
for (const [name, ok] of Object.entries(matrix)) assert.strictEqual(ok, true, `room simulation failed: ${name}`);

const reg = createRoomRegistry();
const room = createSimulatedRoom(reg, 'ROOM1', { hostPassword:'HOST', joinCode:'JOIN', maxPlayers:2 });
assert.strictEqual(joinSimulatedRoom(reg, room.id, { name:'A', code:'BAD' }).code, 'WRONG_ROOM_CODE');
const first = joinSimulatedRoom(reg, room.id, { name:'A', code:'JOIN' });
assert.strictEqual(first.ok, true);
assert.strictEqual(first.reconnect, false);
assert.strictEqual(joinSimulatedRoom(reg, room.id, { token:first.player.token }).reconnect, true);
assert.strictEqual(joinSimulatedRoom(reg, room.id, { name:'B', code:'JOIN' }).ok, true);
assert.strictEqual(joinSimulatedRoom(reg, room.id, { name:'C', code:'JOIN' }).code, 'ROOM_FULL');
room.started = true;
assert.strictEqual(joinSimulatedRoom(reg, room.id, { name:'D', code:'JOIN' }).code, 'ROOM_STARTED');
assert.strictEqual(hostLoginSimulated(reg, room.id, 'JOIN').code, 'AUTH_FAILED');
assert.strictEqual(hostLoginSimulated(reg, room.id, 'HOST').ok, true);

console.log('room state-machine simulation regression: PASS (collision, code scope, reconnect, full, started-lock, host-password separation)');
