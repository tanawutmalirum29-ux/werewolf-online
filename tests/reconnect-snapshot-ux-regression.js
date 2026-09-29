const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const player = fs.readFileSync(path.join(root, 'public/js/player.main.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'public/js/host.main.js'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'public/js/game-runtime-client.js'), 'utf8');
const checks = [
  ['player request_sync on visible', /request_sync[\s\S]{0,400}currentRoomId[\s\S]{0,400}/],
  ['player auto rejoin', /wwRejoinRoom\(rejoinRoomId, 0\)/],
  ['host relogin', /if \(roomId\) wwHostRelogin\(0\)/],
  ['runtime disconnect UX', /setBanner\("syncing", "🔄 การเชื่อมต่อขาดหาย/],
  ['runtime state version', /let lastStateVersion = Number\(getRoom\(\)\?\.stateVersion/],
  ['runtime sync success', /lastStateVersion = version/],
];
for (const [label, re] of checks) {
  if (!(re.test(player) || re.test(host) || re.test(runtime))) throw new Error(`missing reconnect contract: ${label}`);
}
console.log('PASS reconnect-snapshot-ux-regression');
