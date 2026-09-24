const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const hostJs = fs.readFileSync(path.join(root, 'public', 'js', 'host.main.js'), 'utf8');
const playerJs = fs.readFileSync(path.join(root, 'public', 'js', 'player.main.js'), 'utf8');
const sharedJs = fs.readFileSync(path.join(root, 'public', 'js', 'shared.server-control.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

// A possessed bot must launch as an isolated tester player, not as a normal player/index session.
assertOk(hostJs.includes('url.searchParams.set("tester", "1");'), 'bot launch does not set tester mode');
assertOk(hostJs.includes('url.searchParams.set("t", token);'), 'bot launch does not pass the bot room token');
assertOk(hostJs.includes('url.searchParams.set("jr", roomId);'), 'bot launch does not pin the bot to its room');
assertOk(hostJs.includes('const testerPass = testerQuery.get("tp");'), 'bot launch does not propagate tester pass');
assertOk(hostJs.includes('if (testerPass) url.searchParams.set("tp", testerPass);'), 'bot launch does not attach tester pass');
assertOk(hostJs.includes('url.searchParams.set("ts", makeBotTesterLaunchId());'), 'bot launch does not create a unique tester launch id');
assertOk(hostJs.includes('url.searchParams.set("hc", testerHostControllerId);'), 'bot launch does not carry Host controller identity');

// A bot tab should never enter the normal account bootstrap path or previous-room decision.
assertOk(playerJs.includes('if (TESTER_MODE || !window.wwAccount || !socket.connected) return Promise.resolve(null);'), 'bot/tester account bootstrap is not bypassed');
assertOk(playerJs.includes('if (BOT_CONTROLLED_TAB && ww_urlRejoinRoom) {'), 'bot tab auto-join path missing');
assertOk(playerJs.includes('testerSessionId: TESTER_MODE ? (urlParams.get("ts") || "") : ""'), 'tester rejoin no longer carries its launch session identity');
assertOk(playerJs.includes('if (TESTER_MODE) {'), 'tester failure return path missing');

// Shared controller must clear cloned sessionStorage using the bot-specific ts and may return to Host without navigating.
assertOk(sharedJs.includes('testerHostControllerId = testerQs.get("hc") || "";'), 'shared controller does not read Host controller id');
assertOk(sharedJs.includes('testerIsHostPage = /\\/host(?:\\.html)?$/i.test'), 'shared controller cannot identify tester Host');
assertOk(sharedJs.includes('function notifyTesterHostController()'), 'direct Host return channel missing');
assertOk(sharedJs.includes('if (testerHostControllerId && notifyTesterHostController()) {'), 'bot does not use direct Host return before fallback navigation');
assertOk(sharedJs.includes('var key = "ww_tester_return_host_" + testerHostControllerId;'), 'Host return storage fallback missing');

// Server still treats the bot token as the authority for reconnecting an existing bot.
assertOk(serverJs.includes('let player = token ? room.players.find((p) => p.token === token) : null;'), 'join_room bot token reconnect path missing');
assertOk(serverJs.includes('if (player.isBot || player.isTester) {'), 'bot reconnect must bypass normal account authentication');
const botReconnectPos = serverJs.indexOf('if (player.isBot || player.isTester) {');
const normalReconnectAuthPos = serverJs.indexOf('ensureNormalAccountIdentity(reconnectAccountId, player.name', botReconnectPos);
assertOk(botReconnectPos >= 0 && normalReconnectAuthPos > botReconnectPos, 'bot reconnect branch must execute before normal account authentication');
assertOk(serverJs.includes('const existingPlayerIsBot = !!(player && player.isBot);'), 'bot reconnect discriminator missing');
assertOk(serverJs.includes('const botTesterAuthorized = testerGranted || socket.data.roomTesterAuth === true;'), 'protected tester-room bot reconnect authorization missing');
assertOk(serverJs.includes('if (!room.isTesterRoom) return cb && cb({ error: "tester room required", code: "TESTER_ROOM_REQUIRED" });'), 'normal rooms must reject bot creation');
assertOk(serverJs.includes('isTester: true,\n            testerPlayerSlot: 0,'), 'new bots must be marked as tester synthetic players');
assertOk(serverJs.includes('room.players.some((p) => p && p.id === socket.id);'), 'possessed bot socket must count as room member for protection');
assertOk(sharedJs.includes('if (launchRoom && launchToken) return { roomId: String(launchRoom), token: String(launchToken) };'), 'tester bot URL identity must override shared storage');
assertOk(playerJs.includes('// Do not emit a second join here.'), 'bot auto-join duplicate-race guard missing');
assertOk(playerJs.includes('if (socket.connected) wwRejoinRoom(ww_urlRejoinRoom, 0);'), 'bot tab must start one controlled rejoin when already connected');

// Protect against the exact regression where possession creates/reloads a Host page instead of opening a player page.
assertOk(hostJs.includes('new URL(location.origin + "/player.html")'), 'possessBot target is not player.html');
assertOk(!hostJs.includes('win.location.href = location.origin + "/host.html"'), 'possessBot contains a Host navigation regression');

console.log('bot-possession-regression: PASS');
