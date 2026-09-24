'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const server = read('server.js');
const player = read('public/js/player.main.js');
const playerCss = read('public/css/player.css');
const host = read('public/js/host.main.js');
const hostCss = read('public/css/host.css');
const shared = read('public/js/shared.server-control.js');
const version = read('utils/getAppVersion.js');
const admin = read('public/admin.html');
const runner = read('utils/bug-replay-runner.js');

function fail(message) { throw new Error(message); }
function assertOk(condition, message) { assert(condition, message); }

// ----- Player Grid: execute the real pure layout function through VM -----
const start = player.indexOf('function computePlayerGridLayout');
const end = player.indexOf('\nfunction getPlayerGridMetrics', start);
assertOk(start >= 0 && end > start, 'Player grid pure function boundaries must exist');
const sandbox = { module: { exports: null } };
vm.runInNewContext(player.slice(start, end) + '\nmodule.exports = computePlayerGridLayout;', sandbox);
const compute = sandbox.module.exports;
assertOk(typeof compute === 'function', 'Player grid calculator must be executable in isolation');

const options = { gap: 6, min: 50, max: 160, rowGap: 6 };
function layout(w, h, count) { return compute(w, h, count, options.gap, options.min, options.max, options.rowGap); }

const fixed = [
    [340,470,1], [340,470,5], [340,470,6], [340,470,12], [340,470,18], [340,470,30],
    [540,760,5], [540,760,12], [540,760,24], [760,720,12], [760,720,37],
    [720,730,12], [690,600,37], [340,190,30], [390,844,37], [1024,640,12],
];
for (const [w,h,count] of fixed) {
    const x = layout(w,h,count);
    assertOk(x && x.columns >= 1 && x.rows >= 1 && x.size > 0, `invalid Player grid layout ${w}x${h}/${count}`);
    assertOk(x.columns <= count, `columns exceed player count at ${w}x${h}/${count}`);
    assertOk(x.rows === Math.ceil(count / x.columns), `row calculation mismatch at ${w}x${h}/${count}`);
}
assertOk(layout(720,730,12).size >= 150, 'wide 12-player layout regressed to tiny cards');
assertOk(layout(720,730,12).columns <= 6, 'wide 12-player layout became over-dense');
assertOk(layout(340,190,30).size > 0 && layout(340,190,30).fits === false, 'cramped layout must use explicit non-fit emergency state');

// Deterministic stress matrix: resize, rotation, background recovery, add/remove players.
let seed = 0x5eed1234;
function rnd() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
}
let stress = 0;
for (let i = 0; i < 30000; i += 1) {
    const w = 180 + Math.floor(rnd() * 1300);
    const h = 120 + Math.floor(rnd() * 1100);
    const count = 1 + Math.floor(rnd() * 80);
    const x = layout(w,h,count);
    assertOk(x && Number.isFinite(x.size) && x.size > 0, `stress ${i}: invalid size`);
    assertOk(Number.isInteger(x.columns) && x.columns >= 1 && x.columns <= count, `stress ${i}: invalid columns`);
    assertOk(Number.isInteger(x.rows) && x.rows === Math.ceil(count / x.columns), `stress ${i}: invalid rows`);
    stress += 1;
}
assert.strictEqual(stress, 30000, 'grid stress matrix did not complete');

// The recent fallback/lifecycle fixes must remain wired to diagnostics and actual render flow.
for (const needle of [
    'function renderPlayerCardFallback',
    'window.WWDiagnostic.breadcrumb("player-grid.render-fallback"',
    'playerGridSmallFitStreak',
    'const suspiciousCollapsedHeight = metrics.height < 120',
    'el.dataset.gridFitStatus = "empty"',
    'window.addEventListener("pageshow", refit, { passive: true });',
    'window.addEventListener("orientationchange", refit, { passive: true });',
    'window.visualViewport.addEventListener("resize", () => scheduleFitPlayerGrid(true)',
    'scheduleFitPlayerGrid(false);\n\n    return mode;',
]) assertOk(player.includes(needle), `Player recent-fix hook missing: ${needle}`);
for (const needle of [
    'justify-items:start;',
    'justify-content:start;',
    '--player-grid-min:50px;',
]) assertOk(playerCss.includes(needle), `Player CSS stability hook missing: ${needle}`);

// Host focus/recovery fix must survive future refactors.
assertOk(host.includes('roomId || r.id'), 'Host fullscreen visibility must use room.id fallback');
assertOk(host.includes('function applyRoomId(id)'), 'Host room id setter missing');
assertOk(/function applyRoomId\(id\)[\s\S]*?updateHostControlChrome\(/.test(host), 'Host room id setter must sync focus chrome');
assertOk(hostCss.includes('body.host-player-focus #list .player{'), 'Host focus player rule missing');
assertOk(hostCss.includes('grid-auto-flow:row;'), 'Host focus grid must remain row-flow');

// Fast forced reload: event dispatch must happen before slow persistence/cleanup.
const endpoint = server.match(/app\.post\("\/api\/admin\/force-reload"[\s\S]*?\n\}\);\n\n\/\/ ============================================================/);
assertOk(endpoint, 'force-reload endpoint not found');
const forceBlock = endpoint[0];
assertOk(forceBlock.includes('targets.forEach((s) => { try { s.emit("force_reload"'), 'force_reload dispatch missing');
assertOk(forceBlock.indexOf('targets.forEach((s) => { try { s.emit("force_reload"') < forceBlock.indexOf('await stateSavePromise'), 'force reload must notify before persistence wait');
assertOk(server.includes('async function closeAllRoomsSilently({ fast = false } = {})'), 'fast room close helper missing');
assertOk(shared.includes('var POLL_MS = 5000;'), 'fast stale-client fallback polling regression');
assertOk(shared.includes('var jitter = reason === "reopen" ? Math.random() * 2500 : 0;'), 'reopen jitter must remain isolated to server reopening');
assertOk(shared.includes('if (reason === "admin") {'), 'admin force reload must have its own immediate path');
assertOk(shared.includes('goHome(true);'), 'admin force reload must navigate immediately');

// Version drift: cache cannot be permanently frozen at one deployment label.
assertOk(version.includes('getAppVersion({ force: false } = {})') || version.includes('getAppVersion({ force = false }'), 'version getter must support refresh semantics');
assertOk(version.includes('DEFAULT_REFRESH_INTERVAL_MS'), 'version cache must have bounded freshness');
assertOk(version.includes('configuredRefreshIntervalMs'), 'version refresh interval must be configurable');
assertOk(version.includes('cachedAt'), 'version cache timestamp missing');
assertOk(server.includes('getAppVersion({ force: true })') || server.includes('refreshAppVersion'), 'server must have an explicit fresh-version path');
assertOk(version.includes('startAppVersionRefresh'), 'version module must refresh in the background');
assertOk(server.includes('startAppVersionRefresh();'), 'server must start the version refresher at boot');

// Bug Replay itself must self-test the fixes, and the deep mode must be available.
for (const needle of [
    'BUG_REPLAY_SCENARIOS = [',
    "id:'preflight-integrity'",
    "id:'player-grid-deep'",
    "id:'admin-ops'",
    "id:'host-focus'",
    "id:'version-deploy'",
    "id:'replay-engine'",
    'continueOnFailure',
]) assertOk(runner.includes(needle) || server.includes(needle), `replay depth hook missing: ${needle}`);
assertOk(admin.includes('bugReplayDeepBtn'), 'Admin deep replay button missing');
assertOk(admin.includes("startBugReplay('deep')"), 'Admin deep replay must use deep mode');
assertOk(admin.includes('failureCount'), 'Admin UI must display deep replay failure count');
assertOk(server.includes('remainingSteps'), 'Bug Replay job must expose accurate remaining-step progress');
assertOk(admin.includes('bugReplayDeepBtn') && admin.includes("startBugReplay('deep')"), 'Admin deep replay wiring must remain available');
assertOk(runner.includes('SKIP: python3 unavailable'), 'Python browser harness must degrade to an explicit skip when Python is unavailable');

console.log(`bug-replay recent fixes: PASS (30,000 randomized grid states + reload/version/Host/Replay guards)`);
