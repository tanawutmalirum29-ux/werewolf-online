const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'public', 'js', 'host.main.js'), 'utf8');
const player = fs.readFileSync(path.join(root, 'public', 'js', 'player.main.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'public', 'js', 'ww-ui.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const needle of [
    'BROWSER_EXIT_HOST_GRACE_MS',
    'BROWSER_EXIT_PLAYER_GRACE_MS',
    'pendingBrowserExits',
    'armPendingBrowserExit',
    'clearPendingBrowserExit',
    "app.post('/api/room/browser-exit-host'",
    "app.post('/api/room/browser-exit-player'",
    'closeRoomNow',
    'isPlayerCurrentlyConnected',
    'browser_exit_signal',
    'browser_exit_armed',
    'browser_exit_applied',
    'room_closed_after_browser_exit',
]) {
    assert(server.includes(needle), `server browser-exit contract missing: ${needle}`);
}

assert(host.includes('beforeunload'), 'host must guard direct tab close with beforeunload');
assert(host.includes('pagehide'), 'host must observe actual page exit with pagehide');
assert(host.includes('event.persisted'), 'host must ignore BFCache pagehide');
assert(host.includes('/api/room/browser-exit-host'), 'host must signal server on page exit');
assert(host.includes('hostAllowIntentionalExit'), 'host intentional exits must disable duplicate native guard');
assert(!/addEventListener\(["']unload["']/.test(host), 'host must not rely on unload');

assert(player.includes('beforeunload'), 'player must guard direct tab close with beforeunload');
assert(player.includes('pagehide'), 'player must observe actual page exit with pagehide');
assert(player.includes('event.persisted'), 'player must ignore BFCache pagehide');
assert(player.includes('/api/room/browser-exit-player'), 'player must signal server on page exit');
assert(player.includes('playerAllowIntentionalExit'), 'player intentional exits must disable duplicate native guard');
assert(!/addEventListener\(["']unload["']/.test(player), 'player must not rely on unload');

assert(ui.includes('wwSendBrowserExitBeacon'), 'shared browser-exit beacon helper is missing');
assert(/sendBeacon/.test(ui) && /keepalive/.test(ui), 'browser-exit beacon helper must have sendBeacon + keepalive fallback');

const hostEndpoint = server.slice(server.indexOf("app.post('/api/room/browser-exit-host'"), server.indexOf("app.post('/api/room/browser-exit-player'"));
assert(hostEndpoint.includes('activeHostIds.length > 0'), 'host exit must keep room open while another host screen remains active');
assert(hostEndpoint.includes('pendingHostSocketConnected'), 'host exit must verify the original socket is actually disconnected before applying exit');
assert(hostEndpoint.includes("source: 'host_socket_still_connected'"), 'host exit must cancel when pagehide occurs while the socket remains connected');
assert(hostEndpoint.includes('closeRoomNow'), 'last host exit must close the room through shared close helper');
assert(server.includes('x-forwarded-host') && server.includes('PUBLIC_WEB_ORIGIN'), 'browser-exit origin guard must work behind reverse proxy/CloudFront');
const playerEndpoint = server.slice(server.indexOf("app.post('/api/room/browser-exit-player'"), server.indexOf('// ============================================================\n// SOCKET EVENTS', server.indexOf("app.post('/api/room/browser-exit-player'")));
assert(playerEndpoint.includes('isPlayerCurrentlyConnected(livePlayer)'), 'player exit must cancel when the same player reconnects during grace');
assert(playerEndpoint.includes('applyVoluntaryPlayerExit'), 'player exit must reuse the existing voluntary leave/death path');

assert(pkg.scripts.test.includes('browser-exit-guard-regression.js'), 'npm test must include browser-exit regression');
assert(pkg.scripts.test.includes('browser-exit-guard-behavior.js'), 'npm test must include browser-exit behavior test');

console.log('browser-exit guard regression: PASS');
