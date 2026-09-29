'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const start = server.indexOf('    function buildAdminRoomDetail(room)');
const end = server.indexOf('    socket.on("admin_list_rooms"', start);
assert(start >= 0 && end > start, 'Admin room detail helper must exist before admin_list_rooms');
const helperBlock = server.slice(start, end).split('    socket.on("admin_get_room_detail"', 1)[0].trim();
const runtimeStateStart = server.indexOf('const ROOM_TIMELINE_MAX');
const runtimeStateEnd = server.indexOf('function roomActionError(code, extra = {})', runtimeStateStart);
assert(runtimeStateStart >= 0 && runtimeStateEnd > runtimeStateStart, 'runtime state helper must exist');
const runtimeStateBlock = server.slice(runtimeStateStart, runtimeStateEnd).trim();
const runtimeHelpers = new Function(`${runtimeStateBlock}\nreturn { ensureRoomRuntimeState, publicTimeline };`)();
const factory = new Function('io', 'isPlayerCurrentlyConnected', 'ensureRoomRuntimeState', 'publicTimeline', `${helperBlock}\nreturn buildAdminRoomDetail;`);

const connected = new Set(['host-socket', 'alice-socket']);
const fakeIo = { sockets: { sockets: { get(id) { return connected.has(id) ? { connected: true } : null; } } } };
const isConnected = (player) => connected.has(String(player?.id || ''));
const build = factory(fakeIo, isConnected, runtimeHelpers.ensureRoomRuntimeState, runtimeHelpers.publicTimeline);

const room = {
  id: 'AB12C',
  isTesterRoom: false,
  isClosing: false,
  createdAt: '2026-09-26T05:00:00Z',
  startedAt: '2026-09-26T05:05:00Z',
  gameRoundId: 'round-1',
  started: true,
  gameOver: false,
  nightCount: 2,
  dayCount: 1,
  isNight: true,
  voteMode: false,
  voteDeadline: 1234567890,
  hostPassword: 'SUPER-SECRET',
  joinCode: 'JOIN-SECRET',
  config: { 'หมาป่า': 1, 'ชาวบ้าน': 1 },
  revealDeadRole: true,
  voteTimerEnabled: true,
  botAI: { enabled: true, perBot: {} },
  testerConditions: {},
  gameResult: {
    team: 'wolf', label: 'หมาป่า', title: 'ทีมหมาป่าชนะ',
    winners: [{ id: 'alice-socket', token: 'PLAYER-TOKEN-SECRET' }],
  },
  selectedTargets: { 'alice-socket': 'bot-socket' },
  votes: { 'bot-socket': 'alice-socket' },
  shieldTargets: {},
  wolfKillVotes: { 'bot-socket': 'alice-socket' },
  banditKillVotes: {},
  continueReady: {},
  chatSeq: 4,
  hostIds: ['host-socket'],
  players: [
    { id:'host-socket', accountId:'HOST-ACCOUNT', token:'HOST-TOKEN-SECRET', name:'Host', isHost:true, alive:true },
    { id:'alice-socket', accountId:'ACC-A', token:'PLAYER-TOKEN-SECRET', name:'Alice', isHost:false, isBot:false, isTester:false, alive:true, role:'ชาวบ้าน', displayRole:'ชาวบ้าน', originalRole:'ชาวบ้าน' },
    { id:'bot-socket', token:'BOT-TOKEN-SECRET', name:'🤖 บอท 1', isHost:false, isBot:true, isTester:false, alive:true, role:'หมาป่า', displayRole:'หมาป่า', originalRole:'หมาป่า' },
  ],
};

const out = build(room);
assert.strictEqual(out.roomId, 'AB12C');
assert.strictEqual(out.phase, 'night');
assert.strictEqual(out.settings.hasHostPassword, true);
assert.strictEqual(out.settings.hasJoinCode, true);
assert.strictEqual(out.counts.players, 1);
assert.strictEqual(out.counts.bots, 1);
assert.strictEqual(out.host.connected, true);
assert.strictEqual(out.players[1].accountId, 'ACC-A');
assert.deepStrictEqual(out.players[1].selectedTarget, { slot:3, name:'🤖 บอท 1', isBot:true, isHost:false });
assert.deepStrictEqual(out.players[2].voteTarget, { slot:2, name:'Alice', isBot:false, isHost:false });
assert.deepStrictEqual(out.gameResult.winners, [{ slot:2, name:'Alice', isBot:false, isHost:false }]);

const json = JSON.stringify(out);
assert(!json.includes('SUPER-SECRET'), 'room host password leaked');
assert(!json.includes('JOIN-SECRET'), 'room join code leaked');
assert(!json.includes('PLAYER-TOKEN-SECRET'), 'player token leaked');
assert(!json.includes('HOST-TOKEN-SECRET'), 'host token leaked');
assert(!json.includes('BOT-TOKEN-SECRET'), 'bot token leaked');
assert(!json.includes('host-socket'), 'host socket id leaked');
assert(!json.includes('alice-socket'), 'player socket id leaked');
assert(!json.includes('bot-socket'), 'bot socket id leaked');

assert(server.includes('socket.on("admin_get_room_detail"'), 'admin room detail event missing');
assert(server.includes('recoverPersistedRoomById(id, { reason: "admin_room_inspector" })'), 'room inspector recovery path missing');
console.log('admin-room-inspector-contract: PASS');
