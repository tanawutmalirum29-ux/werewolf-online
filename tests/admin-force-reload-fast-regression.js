const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'public', 'js', 'shared.server-control.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'public', 'js', 'host.main.js'), 'utf8');

assert(server.includes('async function closeAllRoomsSilently({ fast = false } = {})'), 'closeAllRoomsSilently must support a fast path');
assert(server.includes('if (fast) {\n        wipeAllRoomsInMemory({ keepTesterRooms: true });'), 'fast room close must wipe RAM immediately');
assert(server.includes('Promise.all(ids.map((id) => deletePersistedRoom(id).catch'), 'fast room close must clean persistence in background');
const fastEndpoint = server.match(/app\.post\("\/api\/admin\/force-reload"[\s\S]*?\n\}\);\n\n\/\/ ============================================================/);
assert(fastEndpoint, 'force-reload endpoint block missing');
assert(fastEndpoint[0].includes('closeAllRoomsSilently({ fast: true })'), 'force-reload must use the non-blocking cleanup path');
assert(fastEndpoint[0].includes('const stateSavePromise = saveServerState().catch'), 'state persistence must be started without blocking notification');
assert(fastEndpoint[0].includes('targets.forEach((s) => { try { s.emit("force_reload"'), 'force_reload must be emitted directly from the endpoint');
assert(fastEndpoint[0].includes('const notificationStartedAt = Date.now();'), 'force-reload must measure notification dispatch time');
assert(fastEndpoint[0].includes('const dispatchMs = Date.now() - notificationStartedAt;'), 'force-reload dispatch timing must be recorded');
assert(fastEndpoint[0].includes('dispatchMs'), 'force-reload response must expose dispatch timing');
assert(fastEndpoint[0].indexOf('targets.forEach((s) => { try { s.emit("force_reload"') < fastEndpoint[0].indexOf('await stateSavePromise'), 'notification must be sent before waiting for state persistence');

const startReload = shared.match(/function startReload\([\s\S]*?\n    \}\n\n    \/\/ ---------- version display/);
assert(startReload, 'startReload block missing');
assert(startReload[0].includes('var jitter = reason === "reopen" ? Math.random() * 2500 : 0;'), 'admin reload jitter must be removed');
assert(!startReload[0].includes('refreshAssetCache(kind)'), 'admin force reload must not wait for asset prefetch before navigation');
assert(startReload[0].includes('goHome(true);'), 'admin force reload must navigate immediately');
assert(shared.includes('var POLL_MS = 5000;'), 'control-state fallback polling must not wait 20 seconds');

const chromeBlock = host.match(/function updateHostControlChrome\(room\)\s*\{[\s\S]*?\n\}/);
assert(chromeBlock, 'host control chrome function missing');
assert(chromeBlock[0].includes('roomId || r.id'), 'focus visibility must fall back to room.id during host_login race');
const applyRoomId = host.match(/function applyRoomId\(id\)\s*\{[\s\S]*?\n\}/);
assert(applyRoomId, 'applyRoomId function missing');
assert(applyRoomId[0].includes('updateHostControlChrome('), 'applyRoomId must sync focus button immediately');

console.log('admin-force-reload-fast-regression: PASS');
