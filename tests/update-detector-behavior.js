const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shared.update-check.js'), 'utf8');

function makeSandbox(initialValue, configVersions) {
    let stored = initialValue;
    let index = 0;
    const requestedUrls = [];
    const storage = {
        getItem(key) { return stored; },
        setItem(key, value) { stored = String(value); },
        removeItem() {},
    };
    const sandbox = {
        window: {},
        localStorage: storage,
        Promise,
        String,
        Object,
        console,
    };
    sandbox.window.wwGetConfig = async (options = {}) => {
        requestedUrls.push(String(options && options.url || '/api/config'));
        const item = configVersions[Math.min(index++, configVersions.length - 1)];
        if (typeof item === 'string') return { version: item, deploymentState: 'ready' };
        return item;
    };
    vm.runInNewContext(source, sandbox);
    return { sandbox, storage, getStored: () => stored, requestedUrls };
}

(async () => {
    const first = makeSandbox(null, ['version-a', 'version-a', 'version-b', 'version-b']);
    assert.strictEqual(first.sandbox.window.WWUpdateDetector.getKnownVersion(), null);
    let result = await first.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'baseline');
    assert.strictEqual(result.version, 'version-a');
    assert.strictEqual(first.getStored(), 'version-a');

    result = await first.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'current');

    result = await first.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'update');
    assert.strictEqual(result.knownVersion, 'version-a');
    assert.strictEqual(result.version, 'version-b');
    assert.strictEqual(first.getStored(), 'version-a', 'update detection must not silently advance the baseline');

    first.sandbox.window.WWUpdateDetector.setKnownVersion('version-b');
    assert.strictEqual(first.getStored(), 'version-b');

    const blank = makeSandbox('', ['version-c']);
    result = await blank.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'baseline', 'blank localStorage baseline should behave like first visit');
    assert.strictEqual(blank.getStored(), 'version-c');

    const deploying = makeSandbox('version-a', [
        { version: 'version-b', deploymentState: 'updating' },
        { version: 'version-b', deploymentState: 'ready' },
    ]);
    result = await deploying.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'deployment', 'Immutable Updating must suppress the update notice');
    assert.strictEqual(deploying.getStored(), 'version-a', 'deployment transition must not advance the baseline');
    result = await deploying.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'update', 'Ready after deployment must expose the new release');
    assert.strictEqual(deploying.getStored(), 'version-a');

    const staleReady = makeSandbox('version-a', [
        { version: 'version-b', deploymentState: 'ready' },
        { version: 'version-b', deploymentState: 'updating' },
        { version: 'version-b', deploymentState: 'ready' },
        { version: 'version-b', deploymentState: 'ready' },
    ]);
    result = await staleReady.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'deployment', 'fresh probe must suppress a mismatch when Immutable has just started');
    assert.strictEqual(staleReady.getStored(), 'version-a');
    assert.strictEqual(staleReady.requestedUrls[0], '/api/config');
    assert.strictEqual(staleReady.requestedUrls[1], '/api/config?deploymentProbe=1', 'version mismatch must trigger a forced deployment-status probe');

    result = await staleReady.sandbox.window.WWUpdateDetector.check();
    assert.strictEqual(result.state, 'update', 'fresh Ready probe must allow the update notice');
    assert.strictEqual(staleReady.getStored(), 'version-a');

    console.log('update-detector behavior: PASS');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
