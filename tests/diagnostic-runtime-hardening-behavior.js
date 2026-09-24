const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const start = serverSource.indexOf('async function withTimeout(promise, timeoutMs, code, message)');
assert(start >= 0, 'withTimeout helper missing');
const end = serverSource.indexOf('\n}\n\n// ', start);
assert(end > start, 'withTimeout helper boundary missing');
const helperSource = serverSource.slice(start, end + 3);

const sandbox = { setTimeout, clearTimeout, Promise, Object, Math, Number };
vm.runInNewContext(`${helperSource}; this.withTimeout = withTimeout;`, sandbox, { filename: 'withTimeout-harness.js' });

(async () => {
    const quick = await sandbox.withTimeout(Promise.resolve('ok'), 10000, 'TIMEOUT', 'should not time out');
    assert.strictEqual(quick, 'ok', 'fast promise should resolve normally');

    const started = Date.now();
    let timeoutError = null;
    try {
        await sandbox.withTimeout(new Promise(() => {}), 1000, 'ACCOUNT_AUTH_TIMEOUT', 'verification timed out');
    } catch (e) {
        timeoutError = e;
    }
    const elapsed = Date.now() - started;
    assert(timeoutError, 'slow promise should reject at the deadline');
    assert.strictEqual(timeoutError.code, 'ACCOUNT_AUTH_TIMEOUT', 'timeout error code must survive');
    assert(elapsed >= 950 && elapsed < 1800, `timeout should fire near 1s, got ${elapsed}ms`);

    let uncaught = null;
    const oldListener = process.listeners('unhandledRejection');
    const handler = (reason) => { uncaught = reason; };
    process.on('unhandledRejection', handler);
    const lateRejecting = new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 1200));
    try {
        await sandbox.withTimeout(lateRejecting, 1000, 'LATE_TIMEOUT', 'late promise timed out');
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 350));
    process.removeListener('unhandledRejection', handler);
    assert.strictEqual(uncaught, null, 'late rejection after timeout must be observed and must not become unhandled');
    assert.deepStrictEqual(process.listeners('unhandledRejection'), oldListener, 'unhandledRejection listeners must be restored');

    console.log('✅ diagnostic runtime hardening behavior checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
