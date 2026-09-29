const fs = require('fs');
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
const github = fs.readFileSync(path.join(root,'utils','github-bug-reports.js'),'utf8');

assert.ok(server.includes('const diagnosticGithubIncidentReports = new Map();'), 'GitHub incident cache missing');
assert.ok(server.includes('const diagnosticGithubIncidentInFlight = new Map();'), 'GitHub incident in-flight lock missing');
assert.ok(server.includes('const diagnosticGithubEventInFlight = new Map();'), 'GitHub event-level in-flight lock missing');
assert.ok(server.includes('function diagnosticIncidentKeyHash'), 'incident hash helper missing');
assert.ok(server.includes('function diagnosticGithubIncidentIdentity'), 'GitHub-specific incident identity helper missing');
assert.ok(server.includes('function normalizeGithubBugReplayFingerprintText'), 'stable Bug Replay fingerprint normalizer missing');
assert.ok(server.includes('await findExistingGithubIncidentIssue(incidentKey, config, { event:primary })'), 'GitHub submission must check for an existing event-aware incident before creating another Issue');
assert.ok(server.includes('diagnosticGithubIncidentInFlight.get(incidentKey)'), 'same-incident submissions must join an in-flight creation');
assert.ok(server.includes('diagnosticGithubEventInFlight.get(eventId)'), 'same-event submissions must join an in-flight creation even if incident keys differ');
assert.ok(server.includes('diagnosticGithubEventInFlight.set(eventId, eventPromise)'), 'event-level in-flight promise must be registered');
assert.ok(server.includes('diagnosticGithubEventInFlight.delete(eventId)'), 'event-level in-flight promise must be cleaned up');
assert.ok(server.includes('incidentKeyHash:incidentHash'), 'created report must carry the incident hash');
assert.ok(server.includes('githubBugKeyHash:incidentHash'), 'created report must carry the stable GitHub bug key');
assert.ok(server.includes('relatedFailureCount:scopedRelated.filter(diagnosticIsFailureEvent).length'), 'GitHub report must describe only the scoped affected failures');
assert.ok(server.includes('const uniqueIssues = new Set'), 'batch response must expose unique Issue count');
assert.ok(server.includes('diagnosticGithubIncidentReports.clear()'), 'clearing GitHub Issues must clear incident cache');

// A Bug Replay run may emit many failures with the same operationId. They must not all collapse into one GitHub key.
const start = server.indexOf('function diagnosticIncidentIdentity');
const end = server.indexOf('function diagnosticIncidentIndexKey', start);
assert.ok(start >= 0 && end > start);
const block = server.slice(start, end);
const vm = require('vm');
const sandbox = {
    crypto: require('crypto'),
    publicDiagnosticText: (x) => String(x ?? ''),
    diagnosticFingerprint: (parts) => require('crypto').createHash('sha256').update(parts.map((x) => String(x ?? '')).join('|')).digest('hex').slice(0, 16),
};
vm.runInNewContext(`${block}\nthis.api={diagnosticIncidentIdentity,diagnosticGithubIncidentIdentity};`, sandbox);
const sameRunA = { kind:'bug_replay_failure', operationId:'replay-1', id:'a', context:{testPath:'tests/a.js'}, data:{testPath:'tests/a.js',exitCode:1,stderr:'AssertionError: A'} };
const sameRunB = { kind:'bug_replay_failure', operationId:'replay-1', id:'b', context:{testPath:'tests/b.js'}, data:{testPath:'tests/b.js',exitCode:1,stderr:'AssertionError: B'} };
const sameBugAgain = { kind:'bug_replay_failure', operationId:'replay-2', id:'c', context:{testPath:'tests/a.js'}, data:{testPath:'tests/a.js',exitCode:1,stderr:'AssertionError: A'} };
assert.notStrictEqual(sandbox.api.diagnosticGithubIncidentIdentity(sameRunA), sandbox.api.diagnosticGithubIncidentIdentity(sameRunB), 'different Bug Replay failures in one run must keep different GitHub identities');
assert.strictEqual(sandbox.api.diagnosticGithubIncidentIdentity(sameRunA), sandbox.api.diagnosticGithubIncidentIdentity(sameBugAgain), 'same Bug Replay failure across runs must reuse one stable GitHub identity');

// Event-level lock must serialize the same diagnostic event even when its incident key changes
// (the exact race that previously allowed Issue #43 and #46 to be created from one event).
{
    const submitStart = server.indexOf('async function submitDiagnosticEventToGithub');
    const submitEnd = server.indexOf("app.post('/api/admin/diagnostics/github'", submitStart);
    assert.ok(submitStart >= 0 && submitEnd > submitStart, 'diagnostic GitHub submit function must exist');
    const submitBlock = server.slice(submitStart, submitEnd);
    let created = 0;
    const submitSandbox = {
        Date,
        process:{version:'v24.20.0', uptime:()=>1},
        Map,
        String, Number, Boolean, Promise, Math,
        diagnosticGithubReports:new Map(),
        diagnosticGithubIncidentReports:new Map(),
        diagnosticGithubIncidentInFlight:new Map(),
        diagnosticGithubEventInFlight:new Map(),
        cleanupDiagnosticGithubReports(){},
        relatedDiagnosticEventsFor(){ return []; },
        diagnosticGithubIncidentIdentity(event){ return String(event.incidentKey || ''); },
        diagnosticIncidentKeyHash(key){ return String(key || ''); },
        diagnosticIsFailureEvent(){ return false; },
        diagnosticTimeMs(){ return 0; },
        findExistingGithubIncidentIssue:async()=>null,
        relatedServerBreadcrumbs(){ return []; },
        buildDiagnosticAnalysis(){ return {}; },
        selectDiagnosticIncidentPrimary(event){ return event; },
        publicDiagnosticEvent(event){ return event; },
        publicDiagnosticValue(value){ return value; },
        getCurrentGameDiagnosticProfile:undefined,
        diagnosticGameProfileSnapshot:undefined,
        getCachedAppVersion(){ return 'test'; },
        serverClosed:false,
        buildGithubBugReportIssue(){ return {title:'[BUG] test',body:'test'}; },
        createGithubBugReportIssue:async()=>{ created++; await new Promise(r=>setTimeout(r,50)); return {number:77,issueUrl:'https://github.com/o/r/issues/77',title:'[BUG] test',repository:'o/r'}; },
        addDiagnosticBreadcrumb(){},
    };
    vm.runInNewContext(`${submitBlock}\nthis.api={submitDiagnosticEventToGithub};`, submitSandbox, {filename:'diagnostic-github-submit-race.js'});
    (async()=>{
        const a={id:'evt-race-1',kind:'resource_error',source:'client',page:'index',message:'resource'};
        const b={...a,incidentKey:'incident-two'};
        // Same event id, different incident identity, started concurrently.
        const original='ignored';
        void original;
        const p1=submitSandbox.api.submitDiagnosticEventToGithub({...a,incidentKey:'incident-one'},{configured:true});
        const p2=submitSandbox.api.submitDiagnosticEventToGithub({...b,incidentKey:'incident-two'},{configured:true});
        const [r1,r2]=await Promise.all([p1,p2]);
        assert.strictEqual(created,1,'same diagnostic event must create at most one GitHub Issue during an in-flight race');
        assert.strictEqual(r1.number,77);
        assert.strictEqual(r2.number,77);
    })().then(()=>console.log('diagnostic GitHub event-level race behavior: PASS')).catch((err)=>{console.error(err);process.exit(1);});
}

assert.ok(github.includes('async function searchGithubIssuesByText'), 'GitHub body-text search helper missing');
assert.ok(github.includes('WEREWOLF-INCIDENT-KEY-HASH'), 'GitHub issue body must persist the redacted incident marker');
assert.ok(github.includes('WEREWOLF-GITHUB-BUG-KEY-HASH'), 'GitHub issue body must persist the stable bug key marker');
assert.ok(github.includes('nodes{... on Issue{id number title url state body}}'), 'GitHub historical dedupe search must retrieve issue bodies');
assert.ok(github.includes('incidentKeyHash ? `incident:'), 'GitHub title must carry an incident marker when available');

const screenshotBlock = server.slice(server.indexOf("app.post('/api/admin/diagnostics/github/screenshots/clear'"), server.indexOf("app.get('/api/admin/diagnostics/github-status'"));
assert.ok(screenshotBlock.includes('if (result.failed.length)'), 'screenshot cleanup diagnostic must only be emitted for partial failure');
assert.ok(screenshotBlock.includes("kind:'github_screenshot_clear_partial_failure'"), 'partial screenshot cleanup must have a failure kind');
assert.ok(!screenshotBlock.includes("kind:'github_screenshot_clear'"), 'successful screenshot cleanup must not create a bug diagnostic');

console.log('diagnostic GitHub incident grouping regression: PASS');
