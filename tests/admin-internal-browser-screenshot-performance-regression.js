'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const adminBrowser = fs.readFileSync(path.join(ROOT, 'public/js/admin-browser.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
const adminCss = fs.readFileSync(path.join(ROOT, 'public/css/admin-browser.css'), 'utf8');

assert.ok(adminBrowser.includes('scheduleHtml2CanvasWarmup();'), 'html2canvas must be warmed during Admin initialization');
assert.ok(adminBrowser.includes('CAPTURE_READY_BUDGET_MS = 360'), 'capture readiness needs a bounded overall budget');
assert.ok(adminBrowser.includes('CAPTURE_MAX_TRACKED_IMAGES = 64'), 'capture readiness must cap tracked pending images');
assert.ok(adminBrowser.includes('requestAnimationFrame(resolve)'), 'capture readiness must only use one final animation frame');
assert.ok(!adminBrowser.includes('showCaptureResultCanvas'), 'capture must not mount a visual preview');
assert.ok(!adminHtml.includes('adminBrowserCapturePreview'), 'Admin capture UI must not include a preview image');
assert.ok(!adminCss.includes('admin-browser-capture-preview-wrap'), 'capture result CSS must not retain preview layout');
assert.ok(adminBrowser.includes('capture.timing.pngEncodeMs'), 'capture must record PNG encode duration');
assert.ok(adminBrowser.includes('getLastCaptureTiming'), 'capture timing must be inspectable for diagnostics/regression');
assert.ok(adminBrowser.includes('const blobPromise = new Promise'), 'PNG encoding must run as a separate asynchronous promise');
assert.ok(adminBrowser.includes('return {canvas, blobPromise'), 'capture must return the canvas only as an off-DOM PNG source');
assert.ok(adminBrowser.includes('save.disabled = !anyReady || !allCaptureSettled;'), 'download must stay disabled until PNG preparation settles');
assert.ok(adminBrowser.includes('item.status = "ready";'), 'PNG completion must mark the result item ready');
assert.ok(adminHtml.includes('adminBrowserCaptureResultList'), 'capture UI must expose a lightweight result list instead of a preview');
assert.ok(adminHtml.includes('adminBrowserCaptureGithubBtn'), 'capture UI must expose a GitHub action');
assert.ok(adminHtml.includes('adminBrowserCaptureSaveBtn'), 'capture UI must expose a download action');

console.log('admin-internal-browser-screenshot-performance-regression: PASS');
