const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const serverText = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const start = serverText.indexOf('function diagnosticAckCode(');
const end = serverText.indexOf('\nfunction currentDiagnosticContext()', start);
assert(start >= 0 && end > start, 'diagnostic analysis block not found');

const sandbox = {
    safeDiagnosticValue(value) { return value; },
    publicDiagnosticText(value) { return String(value ?? ''); },
    DIAGNOSTIC_CAUSAL_MAX_NODES: 36,
    DIAGNOSTIC_CAUSAL_MAX_EDGES: 72,
    DIAGNOSTIC_CAUSAL_WINDOW_MS: 3 * 60 * 1000,
    DIAGNOSTIC_CAUSAL_STRONG_WINDOW_MS: 15 * 60 * 1000,
};
vm.runInNewContext(`${serverText.slice(start, end)}\nthis.__api={diagnosticIsFailureEvent,diagnosticCausalPair,buildDiagnosticAnalysis,extractRuntimeAuditFindingEvents};`, sandbox, { filename: 'diagnostic-incident-replay-block.js' });
const api = sandbox.__api;

const traceId = 'tr-mugv0dsl-hn8dov83';
const sessionId = 'ses-mugi449a-tpujidgd';
const roomId = 'JRDCR';
const summaryTime = '2026-09-25T11:10:31.998Z';
const summary = {
    id: 'summary-1',
    time: summaryTime,
    source: 'client',
    kind: 'runtime_audit_summary',
    page: 'host',
    traceId,
    sessionId,
    roomId,
    context: {
        summary: { durationMs: 21875 },
        findings: [
            {
                code: 'DOM_VIEWPORT_UNAVAILABLE',
                category: 'dom', severity: 'error',
                message: 'ไม่สามารถประเมินพื้นที่แสดงผลได้ เพราะ viewport ของหน้าปัจจุบันเป็น 0×0',
                firstSeenElapsedMs: 10, lastSeenElapsedMs: 21677, count: 41,
                detail: { selector:'#list', viewportW:0, viewportH:0, rootWidth:0, rootHeight:226 },
            },
            {
                code: 'DOM_MUTATION_BURST',
                category: 'dom', severity: 'warning',
                message: 'DOM มีการเปลี่ยนแปลงถี่ผิดปกติภายในช่วงสั้น',
                firstSeenElapsedMs: 1, lastSeenElapsedMs: 443, count: 20,
                detail: { count:726, windowMs:1, records:716 },
            },
        ],
    },
};
const duplicate = {
    id: 'duplicate-1', time: '2026-09-25T11:10:31.995Z', source: 'server',
    kind: 'browser_exit_duplicate_ignored', page:'host', traceId, sessionId, roomId,
    context: { code:'BROWSER_EXIT_DUPLICATE_IGNORED' },
    message: 'Late host pagehide signal ignored because the same socket already disconnected',
};
const signal = {
    id: 'signal-1', time: '2026-09-25T11:10:31.994Z', source: 'client',
    kind: 'browser_exit_signal', page:'host', traceId, sessionId, roomId,
    context: { code:'BROWSER_EXIT_SIGNAL' },
    message: 'Host pagehide exit signal reached the server',
};

assert.strictEqual(api.diagnosticIsFailureEvent(summary), false, 'runtime audit summary is a report container, not a root failure');
assert.strictEqual(api.diagnosticIsFailureEvent(duplicate), false, 'duplicate lifecycle guard must not be a failure');
assert.strictEqual(api.diagnosticIsFailureEvent(signal), false, 'browser exit signal must remain informational');

const synthetic = api.extractRuntimeAuditFindingEvents(summary);
assert(synthetic.some(x => x.context.runtimeAuditSynthetic === true && x.kind === 'runtime_audit_finding'), 'runtime audit finding extraction must produce synthetic finding events');
const viewport = synthetic.find(x => x.label === 'DOM_VIEWPORT_UNAVAILABLE');
const mutation = synthetic.find(x => x.label === 'DOM_MUTATION_BURST');
assert(viewport, 'viewport finding must be extracted from summary');
assert(mutation, 'mutation finding must be extracted from summary');
assert(viewport.time < summary.time, 'finding timestamp must be reconstructed before summary emission');
assert.strictEqual(api.diagnosticIsFailureEvent(mutation), false, 'startup DOM mutation burst must not become a root failure');
assert.strictEqual(api.diagnosticIsFailureEvent(viewport), true, 'persistent viewport failure must remain a failure');

const analysis = api.buildDiagnosticAnalysis(summary, [signal, duplicate]);
assert.strictEqual(analysis.causeCode, 'DOM_VIEWPORT_UNAVAILABLE', `expected viewport root, got ${analysis.causeCode}`);
assert.strictEqual(analysis.failureStage, 'browser.layout', `expected browser.layout, got ${analysis.failureStage}`);
assert.strictEqual(analysis.rootCauseSource, 'client', `expected client root, got ${analysis.rootCauseSource}`);
assert.strictEqual(analysis.confidence, 'high', `expected high confidence, got ${analysis.confidence}`);
assert(analysis.rootCause.includes('viewport') || analysis.rootCause.includes('0×0'), 'root cause explanation must describe the viewport failure');
assert(analysis.rootCauseCandidates.some(x => x.code === 'DOM_VIEWPORT_UNAVAILABLE'), 'viewport finding must appear as root candidate');
assert(!analysis.rootCauseCandidates.some(x => x.code === 'BROWSER_EXIT_DUPLICATE_IGNORED'), 'duplicate lifecycle event must not appear as root candidate');
assert(!analysis.rootCauseCandidates.some(x => x.code === 'RUNTIME_AUDIT_SUMMARY'), 'summary container must not appear as root candidate');
assert(analysis.causalRootPath.some(x => x.code === 'DOM_VIEWPORT_UNAVAILABLE'), 'causal root path must point back to viewport finding');
assert(analysis.timeline.some(x => x.code === 'DOM_VIEWPORT_UNAVAILABLE'), 'timeline must expose nested runtime finding');
assert(analysis.nextStep.includes('Internal Browser'), 'viewport root next step must direct investigation to Internal Browser layout');

const pair = api.diagnosticCausalPair(viewport, summary);
assert(pair && pair.relation === 'downstream_effect', 'viewport finding should causally precede the runtime summary');
assert(pair.score >= 120, 'viewport-to-summary causal confidence should be strong');
assert.strictEqual(api.diagnosticCausalPair(signal, duplicate), null, 'benign browser-exit lifecycle events must not create causal edges');
assert.strictEqual(api.diagnosticCausalPair(duplicate, summary), null, 'duplicate lifecycle guard must not become a causal edge into summary');

console.log('PASS diagnostic-incident-replay-regression');
