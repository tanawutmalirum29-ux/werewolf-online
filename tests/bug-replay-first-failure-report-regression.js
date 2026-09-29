const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const runnerSource = fs.readFileSync(path.join(root, 'utils', 'bug-replay-runner.js'), 'utf8');
const { runBugReplayScenario } = require('../utils/bug-replay-runner');

(async () => {
  const failName = `tests/.tmp-first-failure-${process.pid}.js`;
  const passName = `tests/.tmp-first-failure-pass-${process.pid}.js`;
  const failPath = path.join(root, failName);
  const passPath = path.join(root, passName);
  try {
    fs.writeFileSync(failPath, 'console.error("FIRST_FAILURE_SENTINEL"); process.exit(7);\n');
    fs.writeFileSync(passPath, 'console.log("SECOND_STEP_SENTINEL"); process.exit(0);\n');
    const result = await runBugReplayScenario({ id:'tmp-first-failure', tests:[failName, passName] }, { timeoutMs:5000, continueOnFailure:false });
    assert.strictEqual(result.ok, false, 'fail-fast run must fail');
    assert.strictEqual(result.stopped, false, 'runner-level fail-fast is a failure return, not an admin cancellation');
    assert.strictEqual(result.steps.length, 1, 'fail-fast must stop before the second child test');
    assert.strictEqual(result.steps[0].testPath, failName, 'first failed step must be returned');

    assert(server.includes('continueOnFailure: safeMode !== "first"'), 'first mode must be fail-fast');
    assert(server.includes('job.stopReason = "first_failure"'), 'first-failure stop reason must be explicit');
    assert(server.includes('const requestedScope = String(req.query.reportScope || "").toLowerCase();'), 'export must accept an explicit report scope');
    assert(server.includes("requestedScope === 'first_failure'"), 'first-failure export scope must be server-side explicit');
    assert(server.includes('diagnosticShareFocusedBundle(bundle, eventId)') || server.includes('diagnosticShareFocusedBundle(bundle, eventId);'), 'aggregate focused export compatibility must remain available');
    assert(server.includes('buildBugReplayFirstFailureBundle(job'), 'first-failure export must use a dedicated bundle');
    assert(server.includes("reportKind: 'BUG_REPLAY_FIRST_FAILURE'"), 'first-failure report kind must be explicit');
    assert(server.includes('bugReplayFirstFailureShareText(bundle'), 'first-failure text renderer missing');
    assert(server.includes('bugReplayFirstFailureShareHtml(bundle'), 'first-failure HTML renderer missing');
    assert(server.includes('Content-Disposition'), 'server export must force browser download');
    assert(server.includes('application/json; charset=utf-8'), 'JSON export must be served as application/json');
    assert(server.includes('firstFailureEventId'), 'first-failure event id must be retained in report metadata');

    assert(admin.includes('id="bugReplayTerminalReport"'), 'Diagnostics must show a terminal report panel');
    assert(admin.includes('id="bugReplayTerminalCopyBtn"'), 'terminal copy button missing');
    assert(admin.includes('id="bugReplayTerminalJsonBtn"'), 'terminal JSON button missing');
    assert(admin.includes('function loadBugReplayTerminalReport(job'), 'terminal report hydration helper missing');
    assert(admin.includes('report.jsonDownloadUrl'), 'UI must use direct JSON download URL');
    assert(admin.includes("const firstReportUrl=job.report?.url || '';"), 'first-mode popup must open the dedicated first-failure HTML report');
    assert(admin.includes("const popupCopyUrl=firstMode ? (job.report?.textDownloadUrl || '')"), 'first-mode copy must use the dedicated first-failure text report');
    assert(runnerSource.includes('if (!continueOnFailure) return { ok:false, stopped:false'), 'runner must return immediately after the first failure');

    console.log('bug replay first-failure report regression: PASS');
  } finally {
    for (const p of [failPath, passPath]) { try { fs.unlinkSync(p); } catch (_) {} }
  }
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
