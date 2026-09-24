const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const needle of [
    'buildDiagnosticCausalGraph',
    'diagnosticCausalClusterForEvent',
    'diagnosticShareEventUrl',
    'diagnosticShareFocusedBundle',
    '/diagnostics/share/:token/event/:eventId.json',
    '/diagnostics/share/:token/event/:eventId',
    'upstreamCauseIds',
    'downstreamEffectIds',
    'causedAnotherLog',
    'rootPath',
]) {
    assert(server.includes(needle), `causal cross-log feature missing: ${needle}`);
}

assert(Number(server.match(/const DIAGNOSTIC_CAUSAL_MAX_NODES = (\d+);/)?.[1] || 0) >= 24, 'graph must retain enough nodes for multi-step causal tracing');
assert(Number(server.match(/const DIAGNOSTIC_CAUSAL_MAX_EDGES = (\d+);/)?.[1] || 0) >= 48, 'graph must retain enough edges for causal tracing');
assert(pkg.scripts.test.includes('diagnostic-causal-links-regression.js'), 'npm test must include causal links regression');

const start = server.indexOf('function diagnosticShareEventUrl(');
const end = server.indexOf('\nasync function persistDiagnosticShare', start);
assert(start >= 0 && end > start, 'share helper block not found');
const block = server.slice(start, end);
assert(block.includes('REPORT URL'), 'human-readable share text must expose nested report links');
assert(block.includes('UPSTREAM CAUSES'), 'share text must expose upstream causes');
assert(block.includes('DOWNSTREAM EFFECTS'), 'share text must expose downstream effects');
assert(block.includes('HOW TO TRACE FURTHER'), 'share text must explain recursive tracing direction');

console.log('diagnostic causal links regression: PASS');
