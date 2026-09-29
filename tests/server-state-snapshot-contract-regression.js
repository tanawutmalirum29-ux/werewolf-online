const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const checks = [
  ['ROOM_SNAPSHOT_SCHEMA = 2', /const ROOM_SNAPSHOT_SCHEMA\s*=\s*2/],
  ['ensureRoomRuntimeState', /function ensureRoomRuntimeState\(/],
  ['recordRoomTimeline', /function recordRoomTimeline\(/],
  ['bumpRoomState', /function bumpRoomState\(/],
  ['publicTimeline', /function publicTimeline\(/],
  ['public stateVersion', /publicRoom\.stateVersion\s*=\s*room\.stateVersion/],
  ['public timeline', /publicRoom\.timeline\s*=\s*publicTimeline\(room, 24\)/],
  ['sensitive account removed', /const \{ accountId, testerSessionId, testerPlayerSlot, \.\.\.safePlayer \} = p;/],
  ['sensitive room passwords removed', /const \{ wolfChatHistory, globalChatHistory, instigatorChatHistory, hostPassword, joinCode, \.\.\.publicRoom \} = room;/],
  ['recovery initializes runtime state', /ensureRoomRuntimeState\(room\);/],
];
for (const [label, re] of checks) if (!re.test(src)) throw new Error(`missing snapshot contract: ${label}`);
const timelineBlock = src.slice(src.indexOf('function publicTimeline'), src.indexOf('function roomActionError'));
for (const forbidden of ['accountId', 'token', 'hostPassword', 'joinCode']) {
  if (timelineBlock.includes(forbidden)) throw new Error(`timeline helper references forbidden field: ${forbidden}`);
}
console.log('PASS server-state-snapshot-contract-regression');
