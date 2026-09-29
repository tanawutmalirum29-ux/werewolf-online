const fs = require('fs');
const assert = require('assert');
const { createRuntimeAudit } = require('../utils/runtime-audit-engine');
const a = fs.readFileSync('public/js/runtime-audit.js','utf8');
const e = fs.readFileSync('public/js/runtime-audit-engine.js','utf8');
const nodeEngine = fs.readFileSync('utils/runtime-audit-engine.js','utf8');
assert.strictEqual(e, nodeEngine, 'browser and Node audit engines must remain identical');
assert(a.includes('const viewportAvailable = viewportW > 0 && viewportH > 0'), 'viewport availability capture missing');
assert(a.includes('if (viewportAvailable && rootIntersectsViewport && (rect.right < 0'), 'outside viewport guard missing');
assert(a.includes('viewportAvailable, viewportW, viewportH'), 'viewport fields missing from snapshot');
assert(a.includes('rootOffscreenBelowAtTop'), 'root offscreen capture missing');
assert(e.includes('DOM_VIEWPORT_UNAVAILABLE'), 'unavailable viewport finding missing');
assert(e.includes('if (viewportAvailable && (Number(dom.overflowPx)'), 'overflow guard missing');
assert(e.includes('DOM_GRID_OFFSCREEN'), 'grid offscreen finding missing');
assert(e.includes('const gridRootEffectivelyOffscreen'), 'outside viewport guard in engine missing');
assert(e.includes('!gridRootEffectivelyOffscreen && Number(dom.outsideViewportCount)'), 'outside viewport guard must exclude root-offscreen cases');
assert(e.includes('dom.rootIntersectsViewport !== false'), 'outside viewport guard must preserve older snapshot behavior');

const unavailableAudit = createRuntimeAudit({ source: 'test', runId: 'viewport-unavailable' });
unavailableAudit.checkDomSnapshot({ selector:'#list', cardCount:29, zeroSizeCount:0, outsideViewportCount:29, overflowPx:200, scrollOverflowPx:200, viewportAvailable:false, viewportW:0, viewportH:0, width:0, height:226 });
const unavailableCodes = unavailableAudit.snapshot().findings.map((f) => f.code);
assert(unavailableCodes.includes('DOM_VIEWPORT_UNAVAILABLE'), '0x0 viewport must emit the dedicated finding');
assert(!unavailableCodes.includes('DOM_OUTSIDE_VIEWPORT'), '0x0 viewport must not emit a false outside-viewport finding');
assert(!unavailableCodes.includes('DOM_OVERFLOW'), '0x0 viewport must not emit a false overflow finding');

const offscreenAudit = createRuntimeAudit({ source: 'test', runId: 'grid-offscreen' });
offscreenAudit.checkDomSnapshot({ selector:'#list', cardCount:29, zeroSizeCount:0, outsideViewportCount:0, overflowPx:0, scrollOverflowPx:0, viewportAvailable:true, viewportW:696, viewportH:601, width:640, height:170, rootX:28, rootY:660, rootRight:668, rootBottom:830, rootFullyVisible:false, rootIntersectsViewport:false, rootOffscreenBelowAtTop:true, rootOffscreenAboveAtBottom:false, documentScrollTop:0, gridColumns:11, gridRows:3, gridLayoutReady:true });
const offscreenCodes = offscreenAudit.snapshot().findings.map((f) => f.code);
assert(offscreenCodes.includes('DOM_GRID_OFFSCREEN'), 'whole grid below the first viewport must emit DOM_GRID_OFFSCREEN');
assert(!offscreenCodes.includes('DOM_OUTSIDE_VIEWPORT'), 'whole offscreen grid must not manufacture per-card outside-viewport errors');
const availableAudit = createRuntimeAudit({ source: 'test', runId: 'viewport-available' });
availableAudit.checkDomSnapshot({ selector:'#list', cardCount:1, zeroSizeCount:0, outsideViewportCount:1, overflowPx:3, scrollOverflowPx:2, viewportAvailable:true, viewportW:1024, viewportH:640, width:500, height:500 });
const availableCodes = availableAudit.snapshot().findings.map((f) => f.code);
assert(availableCodes.includes('DOM_OUTSIDE_VIEWPORT'), 'valid viewport must retain outside-viewport detection');
assert(availableCodes.includes('DOM_OVERFLOW'), 'valid viewport must retain overflow detection');

const visibleRootAudit = createRuntimeAudit({ source: 'test', runId: 'visible-root-outside' });
visibleRootAudit.checkDomSnapshot({ selector:'#list', cardCount:1, zeroSizeCount:0, outsideViewportCount:1, overflowPx:0, scrollOverflowPx:0, viewportAvailable:true, viewportW:1024, viewportH:640, width:500, height:500, rootX:10, rootY:10, rootRight:510, rootBottom:510, rootFullyVisible:true, rootIntersectsViewport:true, rootOffscreenBelowAtTop:false, rootOffscreenAboveAtBottom:false, documentScrollTop:0, gridColumns:2, gridRows:1, gridLayoutReady:true });
assert(visibleRootAudit.snapshot().findings.some((f) => f.code === 'DOM_OUTSIDE_VIEWPORT'), 'visible grid root must retain per-card outside detection');

const clockState = { now: 0 };
const startupAudit = createRuntimeAudit({ source: 'test', runId: 'mutation-grace', clock: () => clockState.now });
startupAudit.observeMutation(726, { records: 716 });
assert(!startupAudit.snapshot().findings.some((f) => f.code === 'DOM_MUTATION_BURST'), 'startup mutation burst must be suppressed during grace period');
clockState.now = 1501;
startupAudit.observeMutation(726, { records: 716 });
assert(startupAudit.snapshot().findings.some((f) => f.code === 'DOM_MUTATION_BURST'), 'post-startup mutation burst must still be detectable');

const consistentAudit = createRuntimeAudit({ source: 'test', runId: 'capture-consistency' });
consistentAudit.checkStateInvariants({ roomId:'JRDCR', players:[], started:false, gameOver:false }, { captureId:'capture-1' });
consistentAudit.checkDomSnapshot({ selector:'#list', cardCount:0, zeroSizeCount:0, viewportAvailable:true, viewportW:1024, viewportH:640, width:500, height:500, captureId:'capture-1' }, { stateCaptureId:'capture-1' });
assert(consistentAudit.snapshot().captureConsistency.sameCapture === true, 'state and DOM snapshots from one audit pass must share a capture id');

const mismatchAudit = createRuntimeAudit({ source: 'test', runId: 'capture-mismatch' });
mismatchAudit.checkStateInvariants({ roomId:'JRDCR', players:[], started:false, gameOver:false }, { captureId:'state-1' });
mismatchAudit.checkDomSnapshot({ selector:'#list', cardCount:0, zeroSizeCount:0, viewportAvailable:true, viewportW:1024, viewportH:640, width:500, height:500, captureId:'dom-2' }, { stateCaptureId:'state-1' });
assert(mismatchAudit.snapshot().findings.some((f) => f.code === 'STATE_DOM_CAPTURE_MISMATCH'), 'mismatched state/DOM capture must be diagnosed');
console.log('PASS runtime-audit-viewport-unavailable-regression');
