const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'public', 'js', 'host.main.js'), 'utf8');
const player = fs.readFileSync(path.join(root, 'public', 'js', 'player.main.js'), 'utf8');

assert(/event\.preventDefault\(\);\s*\n\s*event\.returnValue\s*=\s*["']{0,2};/.test(host), 'host beforeunload must use native confirmation contract');
assert(/event\.preventDefault\(\);\s*\n\s*event\.returnValue\s*=\s*["']{0,2};/.test(player), 'player beforeunload must use native confirmation contract');
assert(/if \(!hostBrowserExitGuardActive[^\n]*\|\|[^\n]*hostBrowserExitRequested\) return;/.test(host), 'host guard must not reprompt for intentional exits');
assert(/if \(!playerBrowserExitGuardActive[^\n]*\|\|[^\n]*playerBrowserExitRequested\) return;/.test(player), 'player guard must not reprompt for intentional exits');
assert(/event\.persisted/.test(host) && /event\.persisted/.test(player), 'BFCache pagehide must be ignored');
assert(/source:"pagehide"/.test(host) && /source:"pagehide"/.test(player), 'pagehide signals must identify their lifecycle source');

// Verify the explicit causal-link fields and reconnect safety exist as a coherent server contract.
const start = server.indexOf('function diagnosticAckCode(');
const end = server.indexOf('\nfunction currentDiagnosticContext()', start);
assert(start >= 0 && end > start, 'diagnostic causal analysis block missing');
const block = `${server.slice(start, end)}\nthis.__api={diagnosticExplicitCausalDirection,diagnosticCausalPair,buildDiagnosticCausalGraph};`;
const sandbox = {
    safeDiagnosticValue(value) { return value; },
    publicDiagnosticText(value) { return String(value ?? ''); },
    DIAGNOSTIC_CAUSAL_MAX_NODES: 36,
    DIAGNOSTIC_CAUSAL_MAX_EDGES: 72,
    DIAGNOSTIC_CAUSAL_WINDOW_MS: 3 * 60 * 1000,
    DIAGNOSTIC_CAUSAL_STRONG_WINDOW_MS: 15 * 60 * 1000,
};
vm.runInNewContext(block, sandbox, { filename: 'browser-exit-causal-block.js' });
const api = sandbox.__api;
const upstream = { id:'exit-arm-1', time:'2026-09-24T06:00:00.000Z', source:'server', kind:'browser_exit_apply_error', causalHint:{ downstreamEventIds:['exit-cancel-1'] } };
const downstream = { id:'exit-cancel-1', time:'2026-09-24T06:00:00.100Z', source:'server', kind:'room_recovery_error', causalHint:{ upstreamEventIds:['exit-arm-1'] } };
const explicit = api.diagnosticExplicitCausalDirection(upstream, downstream);
assert(explicit.matched && explicit.score >= 180, 'explicit causal links must be treated as authoritative');
const pair = api.diagnosticCausalPair(upstream, downstream);
assert(pair && pair.relation === 'probable_cause' && pair.confidence === 'high', 'explicit browser-exit relation must become a high-confidence causal edge even without shared trace IDs');
const graph = api.buildDiagnosticCausalGraph(downstream, [upstream, downstream]);
assert(graph.upstreamCauseIds.includes('exit-arm-1'), 'causal graph must expose browser-exit upstream event');

const idx = server.indexOf("app.post('/api/room/browser-exit-player'");
const endpoint = server.slice(idx, server.indexOf('// ============================================================\n// SOCKET EVENTS', idx));
assert(endpoint.indexOf('isPlayerCurrentlyConnected(livePlayer)') >= 0, 'player reconnect must win over exit apply');
assert(endpoint.indexOf('await applyVoluntaryPlayerExit') >= 0, 'final browser exit must apply the established leave/death behavior');

console.log('browser-exit guard behavior: PASS');
