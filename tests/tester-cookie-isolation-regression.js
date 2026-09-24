const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');

const marker = 'const authTpToken = String(socket.handshake?.auth?.testerPass || "").trim();';
assert(server.includes(marker), 'Socket.IO tester auth must use handshake testerPass');

const middlewareStart = server.indexOf('io.use(async (socket, next) => {');
const middlewareEnd = server.indexOf('// SERVER VERSION:', middlewareStart);
assert(middlewareStart >= 0 && middlewareEnd > middlewareStart, 'Socket middleware block must be present');
const middleware = server.slice(middlewareStart, middlewareEnd);

assert(!middleware.includes('testerTokenFromCookie(socket.handshake'),
    'Socket.IO middleware must not promote the shared ww_tp cookie into tester socket identity');
assert(middleware.includes('isTesterPassValid(authTpToken)'),
    'Socket.IO middleware must validate the signed tester pass from handshake');
assert(middleware.includes('isProtectedHandshake(socket)'),
    'Room tester identity fallback must remain available');

// Guard the exact regression: a normal socket with only the browser cookie must not get
// socket.data.testerToken. This is the condition that caused account_bootstrap/presence_hello=IGNORED.
assert(/testerPassValid\s*=\s*[^;]*isTesterPassValid\(authTpToken\)/.test(middleware),
    'Only a handshake tester pass may determine Socket.IO tester validity');
assert(middleware.includes('if (testerPassValid) socket.data.testerToken = authTpToken;'),
    'Only a validated handshake tester pass may populate socket.data.testerToken');

assert(server.includes('const testerPageHeader = String(req.headers["x-ww-tester-page"] || "") === "1"'),
    'HTTP protection must not trust ww_tp cookie without an explicit tester-page marker');
assert(server.includes('if (testerPageHeader && isTesterPassValid(testerTokenFromCookie(req.headers))) return true;'),
    'HTTP tester protection must require both explicit tester marker and valid tester cookie');

console.log('tester-cookie-isolation regression: PASS');
