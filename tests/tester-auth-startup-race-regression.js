const fs = require('fs');
const assert = require('assert');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const middlewareStart = server.indexOf('io.use(async (socket, next) => {');
const middlewareEnd = server.indexOf('// SERVER VERSION:', middlewareStart);
assert(middlewareStart >= 0 && middlewareEnd > middlewareStart, 'Socket middleware block must exist');
const middleware = server.slice(middlewareStart, middlewareEnd);

const presented = middleware.indexOf('const testerPassPresented = !!authTpToken;');
const awaitShared = middleware.indexOf('await ensureTesterPassSecretPersistent();', presented);
const validate = middleware.indexOf('testerPassValid = isTesterPassValid(authTpToken);', awaitShared);
assert(presented >= 0, 'middleware must detect a presented tester pass');
assert(awaitShared > presented, 'middleware must wait for shared tester secret when tester pass is presented');
assert(validate > awaitShared, 'tester pass must be validated only after shared secret bootstrap');
assert(middleware.includes('socket.data.testerPassBootstrapError'), 'bootstrap failure must be captured on socket for deterministic diagnostics');

const joinStart = server.indexOf('socket.on("join_room"');
const joinEnd = server.indexOf('    // ----------------------------------------------------------------\n    // REQUEST SYNC', joinStart);
assert(joinStart >= 0 && joinEnd > joinStart, 'join_room handler must exist');
const join = server.slice(joinStart, joinEnd);
assert(join.includes('code: "TESTER_PASS_UNAVAILABLE"'), 'tester join must expose secret bootstrap failure instead of falling through to account auth');
assert(join.includes('code: "TESTER_PASS_INVALID"'), 'tester join must expose invalid/expired tester pass directly');
assert(join.includes('code: "TESTER_PASS_REQUIRED"'), 'tester join must distinguish missing tester credentials');

const createStart = server.indexOf('socket.on("create_room"');
const createEnd = server.indexOf('    // ----------------------------------------------------------------\n    // LIST OPEN ROOMS', createStart);
assert(createStart >= 0 && createEnd > createStart, 'create_room handler must exist');
const create = server.slice(createStart, createEnd);
assert(create.includes('code: "TESTER_PASS_UNAVAILABLE"'), 'tester room creation must expose secret bootstrap failure');
assert(create.includes('code: "TESTER_PASS_REQUIRED"'), 'tester room creation must distinguish missing tester credentials');
assert(create.includes('code: "TESTER_PASS_INVALID"'), 'tester room creation must expose invalid/expired tester pass');

console.log('tester-auth-startup-race regression: PASS');
