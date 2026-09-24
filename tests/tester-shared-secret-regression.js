const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');

assert(server.includes('let testerPassSecretReadyPromise = null;'), 'shared tester secret lock must exist');
assert(server.includes('ConditionExpression: "attribute_not_exists(#secret)"'), 'tester secret bootstrap must use atomic conditional write');
assert(server.includes('ConsistentRead: true'), 'tester secret winner must be read consistently after a race');
assert(server.includes('await ensureTesterPassSecretPersistent(st.testerPassSecret);'), 'server boot must initialize shared tester secret before accepting tester auth');
assert(server.includes('await doc.send(new UpdateCommand({'), 'server state writes must use partial UpdateCommand');
assert(!/async function saveServerState\(\)[\s\S]*?new PutCommand\(/.test(server), 'saveServerState must not PutCommand the whole SERVER_STATE and delete the shared tester secret');
assert(!/async function saveServerState\(\)[\s\S]*?testerPassSecret:\s*testerPassSecret/.test(server), 'saveServerState must never snapshot-write testerPassSecret');
assert(server.includes('TESTER_PASS_UNAVAILABLE'), 'tester pass issuance must fail closed if shared secret cannot be established');
assert(server.includes('socket.data.testerPassPresented = testerPassPresented;'), 'server must remember tester pass presentation for diagnosis');
assert(server.includes('socket.data.testerPassValid = testerPassValid;'), 'server must remember tester pass validation result for diagnosis');
assert(server.includes('TESTER_PASS_INVALID'), 'invalid tester pass must not surface as a generic account-token error');
assert(server.includes('TESTER_ROOM_REQUIRED'), 'valid tester pass must not silently join a normal room as a tester');

// Durable room metadata is also stored outside the JSON blob so a second instance can preserve tester classification.
assert(server.includes('isTesterRoom: room.isTesterRoom === true,'), 'room snapshot record must persist tester classification metadata');
assert(server.includes('if (item.isTesterRoom === true) room.isTesterRoom = true;'), 'room recovery must restore trusted tester metadata');

console.log('tester-shared-secret regression: PASS');
