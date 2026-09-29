const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const expected = [
  ['start_game callback', /socket\.on\("start_game", \(payload, cb\)/],
  ['start game validation', /validateRoomAction\(socket, room, \{ host: true/],
  ['update config callback', /socket\.on\("update_config", \(\{ roomId, config, stateVersion \} = \{}, cb\)/],
  ['update config stale validation', /validateRoomAction\(socket, room, \{ host: true, member: false, notStarted: true, stateVersion \}\)/],
  ['cast vote validation', /validateRoomAction\(socket, room, \{ member: true, alive: true, started: true, phases: \["day_vote"\], stateVersion \}\)/],
  ['wolf kill validation', /validateRoomAction\(socket, room, \{ member: true, alive: true, started: true, phases: \["night"\], stateVersion \}\)/],
  ['continue validation', /validateRoomAction\(socket, room, \{ member: true, alive: false, stateVersion \}\)/],
  ['invalid phase code', /"INVALID_PHASE"/],
  ['stale state code', /"STALE_STATE"/],
  ['not alive code', /"NOT_ALIVE"/],
];
for (const [label, re] of expected) if (!re.test(src)) throw new Error(`missing validation contract: ${label}`);
console.log('PASS server-action-validation-regression');
