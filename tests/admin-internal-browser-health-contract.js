const fs = require('fs');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const browser = fs.readFileSync(path.join(root, 'public/js/admin-browser.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/admin-browser.css'), 'utf8');

assert(browser.includes('function getFrameHealthContract(type)'), 'frame health contracts missing');
for (const selector of ['#nameField', '#list', '#joinCard']) assert(browser.includes(selector), `expected game root selector missing: ${selector}`);
assert(browser.includes('reason: "document_unavailable"'), 'document availability must be checked');
assert(browser.includes('reason: "frame_access_failed"'), 'cross-frame access failures must be classified');
assert(browser.includes('handleFrameLoadError(tabId, health.reason)'), 'failed health must use the visible fallback/error path');
assert(browser.includes('เส้นทาง ${sanitizeDisplayUrl(tab.url)}'), 'visible failure must expose sanitized page path');
assert(css.includes('.admin-browser-frame-notice'), 'visible frame failure UI style missing');
assert(css.includes('.admin-browser-frame-notice[hidden]{display:none !important;}'), 'frame failure notice must support hiding');
console.log('admin-internal-browser-health-contract: PASS');
