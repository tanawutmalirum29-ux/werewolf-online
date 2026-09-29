const fs = require('fs');
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'utils', 'bug-replay-runner.js'), 'utf8');

function extractFunction(name, nextMarker) {
    const start = serverSource.indexOf(`function ${name}`);
    assert(start >= 0, `missing ${name}`);
    const end = serverSource.indexOf(nextMarker, start);
    assert(end > start, `unable to isolate ${name}`);
    return serverSource.slice(start, end);
}

const builderSource = extractFunction('buildBugReplayFirstFailureBundle', 'function bugReplayFirstFailureShareText');
const textSource = extractFunction('bugReplayFirstFailureShareText', 'function bugReplayFirstFailureShareHtml');
const htmlSourceRaw = extractFunction('bugReplayFirstFailureShareHtml', 'async function createBugReplayFirstFailureShare');
const htmlSource = htmlSourceRaw.replace("function bugReplayFirstFailureShareHtml(bundle, token) {", "function bugReplayFirstFailureShareHtml(bundle, token) {\n    const replay = bundle?.replay || {};");
const sandbox = {
    DIAGNOSTIC_SHARE_VERSION: 'test-v',
    DIAGNOSTIC_SHARE_TTL_MS: 3600000,
    diagnosticEvents: [{
        id: 'evt-first', time: '2026-09-26T01:00:00.000Z', source: 'server', kind: 'bug_replay_failure', page: 'admin',
        message: 'FIRST_FAILURE_SENTINEL', stack: 'STACK_FIRST', data: { failure: 'FIRST_ONLY' }, context: { code: 'BUG_REPLAY_FAILED' },
        analysis: { rootCause: 'Root cause first', causeCode: 'FIRST_ROOT', failureStage: 'bug_replay.scenario', confidence: 'high' },
    }],
    diagnosticShareUrls: (base, token) => ({ html: `${base}/diagnostics/share/${token}`, json: `${base}/diagnostics/share/${token}.json`, ai: `${base}/diagnostics/share/${token}.json` }),
    bugReplayFailureSummary: (_job, failure, event, token) => ({
        eventId: String(failure?.eventId || event?.id || ''), scenarioIndex: Number(failure?.scenarioIndex) || 0,
        scenarioId: String(failure?.scenarioId || ''), scenarioTitle: String(failure?.scenarioTitle || ''), action: String(failure?.action || ''),
        testPath: String(failure?.testPath || ''), stepIndex: Number(failure?.stepIndex) || 0, durationMs: Number(failure?.durationMs) || 0,
        timedOut: !!failure?.timedOut, exitCode: failure?.exitCode ?? null, signal: failure?.signal || null,
        message: String(event?.message || failure?.stderr || failure?.stdout || ''), kind: String(event?.kind || 'bug_replay_failure'), source: String(event?.source || 'server'),
        time: String(event?.time || ''), fingerprint: String(event?.fingerprint || ''),
        reportUrl: token && event?.id ? `BASE/event/${event.id}` : '', jsonReportUrl: token && event?.id ? `BASE/event/${event.id}.json` : '', aiReportUrl: token && event?.id ? `BASE/event/${event.id}.json` : ''
    }),
    publicDiagnosticEventForShare: (event) => ({ ...event, id: String(event.id), analysis: event.analysis || {} }),
    bugReplayReportScenarioSummary: (job) => job.scenarioResults,
    escapeDiagnosticHtml: (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
};
const context = vm.createContext(sandbox);
const compiled = new vm.Script(`${builderSource}\n${textSource}\n${htmlSource}\nthis.api={buildBugReplayFirstFailureBundle,bugReplayFirstFailureShareText,bugReplayFirstFailureShareHtml};`);
compiled.runInContext(context);

const job = {
    runId: 'replay-test', mode: 'first', status: 'failed', startedAt: '2026-09-26T00:59:00.000Z', finishedAt: '2026-09-26T01:00:01.000Z',
    publicBaseUrl: 'https://example.test', totalScenarios: 4, completedScenarios: 1, totalSteps: 8, completedSteps: 2,
    passedSteps: 1, failedSteps: 1, stopReason: 'first_failure',
    failure: { eventId: 'evt-first', scenarioIndex: 0, scenarioId: 's1', scenarioTitle: 'Scenario One', action: 'first action', testPath: 'tests/first.js', stepIndex: 1, exitCode: 7, timedOut: false, durationMs: 12, message: 'FIRST_FAILURE_SENTINEL' },
    failures: [
        { eventId: 'evt-first', scenarioIndex: 0, scenarioId: 's1', scenarioTitle: 'Scenario One', action: 'first action', testPath: 'tests/first.js', stepIndex: 1 },
        { eventId: 'evt-second', scenarioIndex: 1, scenarioId: 's2', scenarioTitle: 'Scenario Two', action: 'second action', testPath: 'tests/second.js', stepIndex: 0 },
    ],
    scenarioResults: [
        { index:0, id:'s1', title:'Scenario One', action:'first action', ok:false, stopped:true, stepCount:2, passedSteps:1, failedSteps:1, skippedSteps:0, steps:[{index:0,testPath:'tests/pass.js',ok:true,skipped:false,durationMs:5},{index:1,testPath:'tests/first.js',ok:false,skipped:false,durationMs:12}] },
        { index:1, id:'s2', title:'Scenario Two', action:'second action', ok:false, stopped:false, stepCount:1, passedSteps:0, failedSteps:1, skippedSteps:0, steps:[{index:0,testPath:'tests/second.js',ok:false,skipped:false,durationMs:3}] },
    ],
    audit: { snapshot: () => ({ timeline:[{label:'first'}], findings:[{code:'BUG_REPLAY_FAILURE'}] }) },
};
const bundle = context.api.buildBugReplayFirstFailureBundle(job, { token:'tok', includeShareUrls:true });
assert.strictEqual(bundle.reportKind, 'BUG_REPLAY_FIRST_FAILURE');
assert.strictEqual(bundle.reportId, 'replay-test:first-failure');
assert.strictEqual(bundle.failures.length, 1, 'first bundle must contain exactly one failure');
assert.strictEqual(bundle.firstFailure.eventId, 'evt-first');
assert.strictEqual(bundle.scenarioResults.length, 1, 'first bundle must contain only the failed scenario');
assert.strictEqual(bundle.scenarioResults[0].id, 's1');
assert.strictEqual(bundle.replay.totalFailureCount, 1);
assert.strictEqual(bundle.replay.firstFailureEventId, 'evt-first');
assert(!JSON.stringify(bundle).includes('evt-second'), 'first bundle must not contain the second failure event');
assert(!JSON.stringify(bundle).includes('tests/second.js'), 'first bundle must not contain later failure test data');

const text = context.api.bugReplayFirstFailureShareText(bundle, 'tok');
assert(text.includes('WEREWOLF BUG REPLAY FIRST FAILURE REPORT v1'));
assert(text.includes('FIRST_FAILURE_SENTINEL'));
assert(!text.includes('tests/second.js'));
assert(!text.includes('FAILURE INDEX'));
assert(!text.includes('SCENARIO RESULTS'));

const html = context.api.bugReplayFirstFailureShareHtml(bundle, 'tok');
assert(html.includes('บั๊กแรกที่พบ'));
assert(html.includes('FIRST_FAILURE_SENTINEL'));
assert(!html.includes('tests/second.js'));
assert(!html.includes('รายงานรวมทั้งรอบ'));

assert(serverSource.includes("requestedScope === 'first_failure'"), 'server must recognize first-failure scope');
assert(serverSource.includes('buildBugReplayFirstFailureBundle(job'), 'server must use first-failure bundle for first scope');
assert(admin.includes("const firstReportUrl=job.report?.url || '';"), 'admin popup must open the dedicated first report');
assert(admin.includes("const popupCopyUrl=firstMode ? (job.report?.textDownloadUrl || '')"), 'admin popup copy must use first report text');
assert(runner.includes('if (!continueOnFailure) return { ok:false, stopped:false'), 'runner must fail-fast');

console.log('bug replay first-failure export regression: PASS');
