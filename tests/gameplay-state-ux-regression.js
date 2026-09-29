const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const playerHtml = fs.readFileSync(path.join(root, 'public/player.html'), 'utf8');
const hostHtml = fs.readFileSync(path.join(root, 'public/host.html'), 'utf8');
const playerJs = fs.readFileSync(path.join(root, 'public/js/player.main.js'), 'utf8');
const hostJs = fs.readFileSync(path.join(root, 'public/js/host.main.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const assertions = [
  ['player action status', playerHtml.includes('id="gameActionStatus"')],
  ['player spectator card', playerHtml.includes('id="spectatorCard"')],
  ['player timeline card', playerHtml.includes('id="gameTimelineCard"')],
  ['player timeline hook', playerJs.includes('gameRuntime.renderTimeline("gameTimeline", roomData.timeline)')],
  ['player spectator hook', playerJs.includes('gameRuntime.renderSpectator(roomData, myPlayer, "spectatorCard")')],
  ['player state payload', playerJs.includes('function withRoomState(payload = {})')],
  ['host action status', hostHtml.includes('id="gameActionStatus"')],
  ['host preset panel', hostHtml.includes('id="hostPresetPanel"')],
  ['host preset actions', /applyHostPreset\('classic-plus'\)/.test(hostHtml)],
  ['host timeline hook', hostJs.includes('gameRuntime.renderTimeline("gameTimeline", room.timeline)')],
  ['host preset engine', hostJs.includes('function buildHostPresetConfig(preset)')],
  ['host recommendation', hostJs.includes('function renderHostPresetPanel()')],
  ['index action status', indexHtml.includes('id="gameActionStatus"')],
];
for (const [label, ok] of assertions) if (!ok) throw new Error(`missing gameplay UX contract: ${label}`);
console.log('PASS gameplay-state-ux-regression');
