const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const reporter = fs.readFileSync(path.join(root, 'public', 'js', 'error-reporter.js'), 'utf8');
const htmlFiles = ['index.html', 'player.html', 'host.html', 'admin.html'];

// First-visit / index bootstrap: :one must not be sent when join=false.
assert(server.includes('if (join) {\n                values[":one"] = 1;\n                updateExpression += " ADD joinCount :one";\n            }'), 'account bootstrap must add :one only when join=true');
assert(!server.includes(':zero": 0, ":one": join ? 1 : 0'), 'account bootstrap must not pre-populate unused :one');

const configClient = fs.readFileSync(path.join(root, 'public', 'js', 'shared.config-client.js'), 'utf8');
assert(configClient.includes('window.wwGetConfig = wwGetConfig'), 'shared config client must expose wwGetConfig');
assert(configClient.includes('var inflight = Object.create(null)'), 'shared config client must keep an inflight registry');
assert(configClient.includes('return res.json();'), 'shared config client must share parsed config data, not a Response body');
assert(configClient.includes('x-ww-room') && configClient.includes('x-ww-token'), 'config dedupe key must separate room identities');
for (const file of ['index.html', 'player.html', 'host.html']) {
    const html = fs.readFileSync(path.join(root, 'public', file), 'utf8');
    assert(html.includes('js/shared.config-client.js?v=1'), `${file} must load shared config client`);
}
assert(fs.readFileSync(path.join(root, 'public', 'js', 'index.auto-update.js'), 'utf8').includes('var wwCheckVersionPending = null'), 'index config checks must have a local pending guard');

// Short client disconnects are navigation/background lifecycle noise, not incidents.
assert(server.includes('if (durationMs < 2000) return;'), 'fast /api/config client disconnect must not be stored as an incident');

// /api/config network failure must recover once before reporting.
assert(reporter.includes('var isConfigGet = cleanEndpoint === "/api/config"'), 'config request classifier missing');
assert(reporter.includes('request.retry.start'), 'config retry breadcrumb missing');
assert(reporter.includes('configRetry: true'), 'config retry context missing');
assert(reporter.includes('initialErrorName: err && err.name || ""'), 'original config error must be preserved in retry diagnostics');
assert(reporter.includes('request.ignored'), 'navigation abort must be ignored for background config');
assert(reporter.includes('isPageLifecycleTeardown'), 'config lifecycle teardown must cover non-AbortError browser failures');
assert(reporter.includes('navigation_or_pagehide_network_error'), 'non-AbortError pagehide config failure must be classified as lifecycle noise');
assert(reporter.includes('window.__WW_DIAG_PAGEHIDE__ = true'), 'pagehide lifecycle marker missing');
assert(reporter.includes('originalFetch.apply(fetchThis, [rawArgs[0], retryInit])'), 'retry must preserve fetch invocation context');

// Cache-busting: all pages must load the corrected reporter.
for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(root, 'public', file), 'utf8');
    assert(html.includes('js/error-reporter.js?v=3'), `${file} must load error-reporter v3`);
}

console.log('✅ config/diagnostics regression checks passed');
