
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const indexMain = fs.readFileSync(path.join(ROOT, 'public/js/index.main.js'), 'utf8');
const errorReporter = fs.readFileSync(path.join(ROOT, 'public/js/error-reporter.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

assert.ok(indexMain.includes('async function touchIndexAccount(reason = "touch")'), 'index must use a dedicated lifecycle-safe account_touch helper');
assert.ok(indexMain.includes('await new Promise((resolve, reject) => {'), 'account_touch helper must explicitly await socket reconnection');
assert.ok(indexMain.includes('if (!indexSocket.connected) return { ok:false, code:"ACCOUNT_SOCKET_UNAVAILABLE" };'), 'helper must not emit account_touch while disconnected');
assert.ok(indexMain.includes('touchIndexAccount("open_profile")'), 'open profile must use lifecycle-safe account_touch');
assert.ok(!indexMain.includes('indexSocket.emit("account_touch", window.wwAccount?.payload'), 'open profile must not directly emit account_touch anymore');
assert.ok(indexMain.includes('code:"ACCOUNT_TOUCH_SOCKET_DISCONNECTED"'), 'helper must settle its own lifecycle wait when socket disconnects');

assert.ok(errorReporter.includes('"ack.cancelled"'), 'diagnostics must record ACK cancellation breadcrumbs when socket disconnects');
assert.ok(errorReporter.includes('socket_disconnected_before_ack'), 'ACK cancellation must distinguish disconnect from a real timeout');
assert.ok(errorReporter.includes('clearTimeout(operation.timer)'), 'disconnect must cancel the pending ACK timer');
assert.ok(errorReporter.includes('delete diagnosticOperations[id]'), 'disconnect must remove cancelled pending operations');
assert.ok(indexHtml.includes('error-reporter.js?v=8'), 'index must cache-bust the updated socket diagnostic lifecycle');

console.log('index-account-touch-lifecycle-regression: PASS');
