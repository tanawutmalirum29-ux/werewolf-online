const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const reporter = fs.readFileSync(path.join(__dirname, '..', 'public/js/error-reporter.js'), 'utf8');
const start = reporter.indexOf('function addDiagnosticSocketAuth(authValue)');
const end = reporter.indexOf('\n    function instrumentSocket(socket)', start);
assert(start >= 0 && end > start, 'could not isolate production socket-auth normalizer');
const helperSource = reporter.slice(start, end) + '\nthis.__addDiagnosticSocketAuth = addDiagnosticSocketAuth;';
const window = {};
const sandbox = { window, sessionId: 'diag-abc', Object, defineProperty: Object.defineProperty };
vm.runInNewContext(helperSource, sandbox);
const addDiagnosticSocketAuth = sandbox.__addDiagnosticSocketAuth;
assert.strictEqual(typeof addDiagnosticSocketAuth, 'function', 'production socket-auth normalizer must be executable');

let callbackPayload = null;
const original = (cb) => cb({ admin: true, adminToken: 'signed-token', adminTabId: 'tab-1234567890abcdef' });
const wrapped = addDiagnosticSocketAuth(original);
assert.strictEqual(typeof wrapped, 'function', 'callback-form Socket.IO auth must remain a function');
wrapped((payload) => { callbackPayload = payload; });
assert.deepStrictEqual(JSON.parse(JSON.stringify(callbackPayload)), {
  admin: true,
  adminToken: 'signed-token',
  adminTabId: 'tab-1234567890abcdef',
  wwDiagSessionId: 'diag-abc',
}, 'callback-form auth must preserve dynamic admin credentials and append only diagnostic session');
assert.strictEqual(window.__WW_DIAG_LAST_SOCKET_AUTH__.hasAdminIntent, true);
assert.strictEqual(window.__WW_DIAG_LAST_SOCKET_AUTH__.hasAdminToken, true);
assert.strictEqual(window.__WW_DIAG_LAST_SOCKET_AUTH__.hasAdminTabId, true);

const objectWrapped = addDiagnosticSocketAuth({ admin: true, adminToken: 'x' });
assert.deepStrictEqual(JSON.parse(JSON.stringify(objectWrapped)), { admin: true, adminToken: 'x', wwDiagSessionId: 'diag-abc' });

// The helper is intentionally idempotent for an already wrapped callback.
const wrappedAgain = addDiagnosticSocketAuth(wrapped);
assert.strictEqual(wrappedAgain, wrapped, 'diagnostic auth wrapper must not double-wrap the same callback');

console.log('✅ production admin diagnostic socket-auth behavior passed');
