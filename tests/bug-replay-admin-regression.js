const fs = require('fs');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'utils', 'bug-replay-runner.js'), 'utf8');

assert(server.includes('app.get("/api/admin/bug-replay/scenarios"'), 'scenario endpoint missing');
assert(server.includes('app.post("/api/admin/bug-replay/start"'), 'start endpoint missing');
assert(server.includes('app.get("/api/admin/bug-replay/status"'), 'status endpoint missing');
assert(server.includes('app.post("/api/admin/bug-replay/stop"'), 'stop endpoint missing');
assert(server.includes('const requestedMode = String(req.body?.mode || "all");'), 'start endpoint must accept a validated replay mode');
assert(server.includes('const mode = requestedMode === "deep" ? "deep" : "all";'), 'replay mode must be server-side allow-listed');
assert(server.includes('startBugReplayJob(mode)'), 'start endpoint must pass the validated replay mode');
assert(server.includes('recordDiagnostic({'), 'failed replay must enter Diagnostics');
assert(server.includes('kind: "bug_replay_failure"'), 'failed replay diagnostic kind missing');
assert(server.includes('code: "BUG_REPLAY_FAILED"'), 'failed replay diagnostic code missing');
assert(server.includes('const BUG_REPLAY_MAX_JOBS = 8;'), 'replay job cleanup limit missing');
assert(server.includes('const BUG_REPLAY_MAX_FAILURES = 12;'), 'deep replay failure retention limit missing');
assert(server.includes('continueOnFailure: safeMode === "deep"'), 'deep replay must continue after failure');
assert(server.includes('job.totalFailureCount += 1;'), 'deep replay must count every failure, not just retained report rows');

assert(admin.includes('id="bugReplayStartBtn"'), 'replay start button missing');
assert(admin.includes('id="bugReplayStopBtn"'), 'replay stop button missing');
assert(admin.includes('id="bugReplayDeepBtn"'), 'deep replay button missing');
assert(admin.includes('id="bugReplaySteps"'), 'replay scenario list missing');
assert(admin.includes('async function openBugReplayFailure(job)'), 'failure popup missing');
assert(admin.includes('พบบั๊กตัวแรกแล้ว'), 'first-bug popup text missing');
assert(admin.includes('/api/admin/diagnostics/share'), 'failure popup must create diagnostics share link');
assert(admin.includes('คัดลอกรายงานเต็ม'), 'full report copy control missing');
assert(admin.includes('คัดลอกลิงก์'), 'share link copy control missing');
assert(admin.includes('loadBugReplayScenarios();'), 'replay scenario catalog must load after admin connects');

assert(runner.includes('const BUG_REPLAY_SCENARIOS = ['), 'allow-listed scenario catalog missing');
assert(runner.includes('spawn(process.execPath, [absolute]'), 'runner must execute tests through node');
assert(!runner.includes('exec(`'), 'runner must not execute arbitrary shell strings');
assert(!runner.includes('execSync(`'), 'runner must not execute arbitrary shell strings synchronously');

console.log('bug-replay admin regression: PASS');
