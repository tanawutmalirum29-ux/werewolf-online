const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const reporter = fs.readFileSync(path.join(root, 'public', 'js', 'error-reporter.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');

for (const field of [
    'rootCauseSource', 'firstFailureAt', 'rootCauseAt', 'lastSeenAt',
    'correlation', 'blockingEvent', 'causalChain', 'downstreamEffects',
    'timeline', 'competingSignals', 'nextStep'
]) {
    assert(server.includes(field), `detailed diagnostic field missing: ${field}`);
}
assert(server.includes('relatedDiagnosticEventsFor'), 'diagnostics must correlate by trace/session/operation/request');
assert(server.includes('clientRequestId'), 'diagnostics must correlate client/server request IDs');
assert(server.includes('args:safeDiagnosticValue'), 'server handler timeline must capture sanitized incoming arguments');
assert(server.includes('auth.handshake'), 'server socket diagnostics must record tester-pass handshake evidence');
assert(reporter.includes('testerPassPresented'), 'client socket diagnostics must record tester-pass presence');
assert(reporter.includes('lastSocketAck'), 'unhandled rejection must retain immediate socket evidence');
assert(admin.includes('ต้นสาย → ปลายเหตุ'), 'admin must show causal chain, not only one-line error');
assert(admin.includes('downstreamEffects'), 'admin must surface downstream effects');
assert(admin.includes('competingSignals'), 'admin report must retain competing signals for ambiguous incidents');

console.log('diagnostic causal-analysis regression: PASS');
