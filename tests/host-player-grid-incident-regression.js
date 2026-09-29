const fs = require('fs');
const assert = require('assert');

const hostJs = fs.readFileSync('public/js/host.main.js', 'utf8');
const hostCss = fs.readFileSync('public/css/host.css', 'utf8');
const auditJs = fs.readFileSync('public/js/runtime-audit.js', 'utf8');
const auditEngine = fs.readFileSync('public/js/runtime-audit-engine.js', 'utf8');
const serverJs = fs.readFileSync('server.js', 'utf8');

assert(hostJs.includes('function countComputedGridTracks(template)'), 'computed grid-track counter missing');
assert(hostJs.includes('function publishHostGridLayoutMetrics(reason = \'grid-layout\')'), 'grid metric publisher missing');
assert(hostJs.includes('function scheduleHostPlayerGridStabilization(reason = \'grid-stabilize\')'), 'grid stabilizer missing');
assert(hostJs.includes('list.dataset.gridColumns = String(columns);'), 'grid columns must be published to diagnostics');
assert(hostJs.includes('list.dataset.gridRows = String(rows);'), 'grid rows must be published to diagnostics');
assert(hostJs.includes('refreshGridColsForBreakpoint(force = false)'), 'grid refresh must support forced reapply');
assert(hostJs.includes("refreshGridColsForBreakpoint(true)"), 'forced grid refresh hook missing');
assert(hostJs.includes("scheduleHostPlayerGridStabilization('player-list-mutation')"), 'live player mutation must trigger grid stabilization');
assert(hostJs.includes("scheduleHostPlayerGridStabilization('card-resize')"), 'card resize must trigger grid stabilization');
assert(hostJs.includes("scheduleHostPlayerGridStabilization('player-focus-exit')"), 'focus exit must trigger grid stabilization');
assert(hostJs.includes("scheduleHostPlayerGridStabilization('startup')"), 'startup grid stabilization missing');
assert(hostJs.includes("scheduleHostPlayerGridStabilization('window-resize')"), 'resize grid stabilization missing');
assert(hostJs.includes("try { document.querySelector('.app')?.scrollTo?.({ top: 0, behavior: 'auto' }); } catch (_) {}"), 'focus exit must reset app scroll');
assert(hostJs.includes("try { window.scrollTo?.({ top: 0, behavior: 'auto' }); } catch (_) {}"), 'focus exit must reset document scroll');

assert(hostCss.includes('ACTIVE GAME / SMALL-VIEWPORT GRID PRIORITY PASS'), 'small viewport active-game priority pass missing');
assert(hostCss.includes('@media (max-width:1080px){\n    body.host-game-mode .seal-wrap{'), 'compact active-game header must cover compact tablet widths');
assert(hostCss.includes('body.host-game-mode .host-room-facts{\n        display:grid !important;'), 'compact tablet header must retain room facts');
assert(hostCss.includes('body.host-game-mode .host-room-facts{ display:none !important; }'), 'very narrow phones must be allowed to hide secondary room facts');
assert(hostCss.includes('body.host-game-mode .player-toolbar{\n        flex-wrap:wrap;'), 'phone toolbar must wrap instead of clipping');
assert(hostCss.includes(`.layout.role-hidden #rightCol{
        grid-template-columns:minmax(0,1fr);
    }`), 'active game must keep player board dominant on compact widths');

assert(hostCss.includes('COMPACT LANDSCAPE / FIRST-VIEWPORT PRIORITY v2'), 'compact landscape first-viewport hardening missing');
assert(hostCss.includes('@media (max-width:1080px) and (orientation:landscape) and (max-height:760px)'), 'compact landscape height-scoped media rule missing');
assert(hostCss.includes('grid-template-columns:minmax(120px,155px) minmax(0,1fr) !important'), 'landscape room shell must stay side-by-side');
assert(hostCss.includes('grid-template-columns:repeat(5,minmax(0,1fr))'), 'compact command deck must fit tester + room actions in one row');
assert(hostCss.includes('margin:0 !important;'), 'compact command buttons must remove inherited top margin');
assert(auditJs.includes('const rootOffscreenBelowAtTop'), 'audit must detect grid root below first viewport');
assert(auditJs.includes('const rootFullyVisible'), 'audit must track whether grid root is fully visible');
assert(auditJs.includes('if (viewportAvailable && rootIntersectsViewport'), 'card outside-viewport counting must be scoped to intersecting root');
assert(auditJs.includes('rootOffscreenBelowAtTop, rootOffscreenAboveAtBottom'), 'audit snapshot must expose root offscreen direction');
assert(auditJs.includes('documentScrollTop'), 'audit snapshot must expose document scroll position');
assert(auditJs.includes('gridLayoutReady'), 'audit snapshot must expose grid layout readiness');

assert(auditEngine.includes('DOM_GRID_OFFSCREEN'), 'engine must classify root-offscreen grid layout');
assert(auditEngine.includes("rootFullyVisible: dom.rootFullyVisible === true"), 'outside-viewport diagnostic must explain root visibility context');
assert(auditEngine.includes('gridRootEffectivelyOffscreen'), 'outside-viewport finding must honor root-offscreen classification');
assert(auditEngine.includes('!gridRootEffectivelyOffscreen'), 'outside-viewport finding must not duplicate root-offscreen findings');
assert(auditEngine.includes('dom.rootIntersectsViewport !== false'), 'outside-viewport check must remain backward-compatible with older snapshots');
assert(serverJs.includes('if (code === "DOM_GRID_OFFSCREEN")'), 'server causal classifier must understand DOM_GRID_OFFSCREEN');
assert(serverJs.includes('if (code === "DOM_GRID_OFFSCREEN") score += 24;'), 'grid-offscreen evidence must outrank generic summary noise');
assert(serverJs.includes('effective.code === "DOM_GRID_OFFSCREEN"'), 'server next-step guidance must recognize grid offscreen');

console.log('host-player-grid-incident-regression: PASS');
