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
assert(configClient.includes('return res.text().then(function (text)'), 'shared config client must parse config JSON before resolving');
assert(configClient.includes('JSON.parse(text)'), 'shared config client must parse JSON explicitly');
assert(configClient.includes('x-ww-room') && configClient.includes('x-ww-token'), 'config dedupe key must separate room identities');
for (const file of ['index.html', 'player.html', 'host.html']) {
    const html = fs.readFileSync(path.join(root, 'public', file), 'utf8');
    assert(html.includes('js/shared.config-client.js?v=1'), `${file} must load shared config client`);
}
assert(fs.readFileSync(path.join(root, 'public', 'js', 'index.auto-update.js'), 'utf8').includes('var wwCheckVersionPending = null'), 'index config checks must have a local pending guard');

// Short client disconnects are navigation/background lifecycle noise, not incidents.
assert(server.includes('if (durationMs < 2000) return;'), 'fast /api/config client disconnect must not be stored as an incident');
assert(server.includes('req.__wwDiagnostic?.requestId ||'), '/api/config must reuse the generic HTTP request ID');
assert(server.includes('configLogicalId') && server.includes('configAttempt'), 'config logical/attempt correlation must be recorded');
assert(server.includes('X-WW-Config-Request-Id') && server.includes('X-WW-Config-Attempt'), 'config response correlation headers missing');
assert(server.includes('clientRequestId } }));'), 'HTTP request.end breadcrumb must retain client request ID');
assert(server.includes('hasAuthoritativeIamEvidence'), 'IAM classification must require authoritative evidence');
assert(server.includes('classifyDiagnosticCause({ source:event.source'), 'diagnostic classifier must receive event source for IAM trust decisions');
assert(server.includes('String(source || "").toLowerCase() === "server"'), 'IAM permission extraction must be server-only');

// /api/config network failure must recover once before reporting.
assert(reporter.includes('var isConfigGet = cleanEndpoint === "/api/config"'), 'config request classifier missing');
assert(reporter.includes('request.retry.start'), 'config retry breadcrumb missing');
assert(reporter.includes('configResourceTiming'), 'config Resource Timing collection missing');
assert(reporter.includes('X-Cache') && reporter.includes('Server-Timing'), 'CDN response header diagnostics missing');
assert(reporter.includes('classifyFetchFailure'), 'network failure classifier missing');
assert(reporter.includes('NETWORK_TIMEOUT'), 'generic fetch timeout classification missing');
assert(configClient.includes('CONFIG_TIMEOUT'), 'shared config timeout classification missing');
assert(reporter.includes('if (isConfigGet && !configRetryManaged && !isAbort'), 'reporter must not retry shared-config managed requests a second time');
assert(reporter.includes('window.__WW_DIAG_REPORT_CONFIG_FAILURE__'), 'shared config terminal reporting bridge missing');
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
    const expectedReporterVersion = 'error-reporter.js?v=8';
    assert(html.includes(expectedReporterVersion), `${file} must load ${expectedReporterVersion}`);
}

console.log('✅ config/diagnostics regression checks passed');
