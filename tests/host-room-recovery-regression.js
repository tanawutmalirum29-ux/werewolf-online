const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const host = fs.readFileSync('public/js/host.main.js', 'utf8');

assert(server.includes('async function recoverPersistedRoomById(roomId'), 'missing on-demand room recovery helper');
assert(server.includes('recoverPersistedRoomById(roomId, { reason: "host_login" })'), 'host_login does not recover a missing RAM room');
assert(server.includes('recoverPersistedRoomById(roomId, { reason: "join_room" })'), 'join_room does not recover a missing RAM room');
assert(server.includes('Key: { playerName: SYSTEM_PLAYER_KEY, statKey: ROOM_INDEX_STAT_KEY }'), 'recovery does not consult active room index');
assert(host.includes('let hostLoginInFlight = "";'), 'host login single-flight guard missing');
assert(host.includes('res.code === "ROOM_NOT_FOUND"'), 'host client does not distinguish missing room');
assert(host.includes('list_open_rooms'), 'host client does not revalidate a stale room card');
assert(host.includes('ACCOUNT_AUTH_FAILED'), 'host client does not expose account auth failure separately');
assert(host.includes('function wwHostRelogin(attempt)'), 'host reconnect handler missing');
assert(host.includes('ห้องที่จำไว้ยังไม่ถูกลบ'), 'host reconnect path still treats non-room errors as room deletion');
console.log('host-room-recovery-regression: PASS');
