const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runner = fs.readFileSync(path.join(root, 'utils/bug-replay-runner.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');

assert(runner.includes("require('./runtime-audit-engine')"), 'Bug Replay runner must use the shared audit engine');
assert(runner.includes('options.audit?.record'), 'runner must record per-test runtime lifecycle');
assert(runner.includes("CHILD_RUNTIME_ERROR"), 'runner must detect child runtime error patterns');
assert(runner.includes("CHILD_TIMEOUT"), 'runner must record child timeout findings');
assert(runner.includes('createRuntimeAudit'), 'runner must expose the audit factory for the server job');

assert(server.includes('createRuntimeAudit({ source:"bug-replay"'), 'Bug Replay jobs must own a runtime audit instance');
assert(server.includes('auditSummary: job.audit ? job.audit.summary() : null'), 'Bug Replay status must publish audit summary');
assert(server.includes('/api/admin/bug-replay/audit'), 'Bug Replay audit detail endpoint missing');
assert(server.includes('job.audit.addFinding'), 'Bug Replay server must attach failures to the runtime audit');

assert(admin.includes('bugReplayAudit'), 'Admin Bug Replay audit panel missing');
assert(admin.includes('/api/admin/bug-replay/audit?runId='), 'Admin must load runtime audit details from the server');
assert(admin.includes('Runtime Audit'), 'Admin must show runtime audit status');
assert(admin.includes('bugReplayAuditOpen'), 'Admin must keep audit detail collapsible');

console.log('runtime-audit-integration-regression: PASS');
