const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const player = fs.readFileSync('public/js/player.main.js', 'utf8');
const host = fs.readFileSync('public/js/host.main.js', 'utf8');

assert(server.includes('const authTpToken = String(socket.handshake?.auth?.testerPass || "").trim();'),
    'server must read testerPass from Socket.IO handshake');
assert(server.includes('isTesterPassValid(authTpToken)'),
    'server must validate handshake testerPass with the same signed credential validator');
assert(/testerPassValid\s*=\s*[^;]*isTesterPassValid\(authTpToken\)/.test(server),
    'server must derive tester pass validity from the handshake credential');
assert(server.includes('if (testerPassValid) socket.data.testerToken = authTpToken;'),
    'a validated handshake tester pass must populate socket.data.testerToken');
assert(!server.includes('socket.data.testerToken = tpToken;'),
    'socket tester identity must not be promoted from the shared ww_tp cookie');
assert(player.includes('const playerSocketAuth = Object.assign('),
    'player must build Socket.IO auth explicitly');
assert(player.includes('return tp ? { testerPass: tp } : {};'),
    'player tester tab must pass tp in handshake auth');
assert(player.includes('const socket = io({ auth: playerSocketAuth });'),
    'player socket must use the enriched auth object');
assert(host.includes('const hostSocketAuth = Object.assign('),
    'host must build Socket.IO auth explicitly');
assert(host.includes('const socket = io({ auth: hostSocketAuth });'),
    'host socket must use the enriched auth object');

// Ensure the ordinary join payload remains free of the tester pass.
const joinSlice = player.slice(player.indexOf('socket.emit(\n        "join_room"'), player.indexOf('socket.emit(\n        "join_room"') + 700);
assert(!joinSlice.includes('testerPass'), 'testerPass must not be copied into join_room payload');

console.log('tester-pass-handshake regression: PASS');
