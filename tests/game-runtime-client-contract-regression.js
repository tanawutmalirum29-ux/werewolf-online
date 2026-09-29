const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'public/js/game-runtime-client.js'), 'utf8');
for (const needle of [
  'WEREWOLF GAME RUNTIME CLIENT',
  'ACTION_TIMEOUT',
  'room_update',
  'renderTimeline',
  'renderSpectator',
  'socket.emit = function',
  'stateBefore',
  'hasCallback',
]) {
  if (!src.includes(needle)) throw new Error(`missing runtime-client contract: ${needle}`);
}
if (!src.includes('if (!item.hasCallback && item.stateBefore < version)')) {
  throw new Error('room_update must only auto-complete actions without explicit ack callbacks');
}
console.log('PASS game-runtime-client-contract-regression');
