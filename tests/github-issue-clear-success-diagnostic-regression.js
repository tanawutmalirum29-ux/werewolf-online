
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const successBlockStart = serverJs.indexOf("// Full success is an operational breadcrumb, not a diagnostic error.");
const responseStart = serverJs.indexOf("const status = result.failed.length ? 502 : 200;", successBlockStart);
assert.ok(successBlockStart >= 0 && responseStart > successBlockStart, 'issue clear success block must exist');
const successBlock = serverJs.slice(successBlockStart, responseStart);
assert.ok(successBlock.includes("if (result.failed.length)"), 'only partial failures should create diagnostic error events');
assert.ok(successBlock.includes("kind:'github_issue_clear_failed'"), 'partial clear must remain diagnosable');
assert.ok(!successBlock.includes("kind:'github_issue_clear'"), 'full successful clear must not be stored as a diagnostic error');
assert.ok(!successBlock.includes("recordDiagnostic({") || successBlock.includes('if (result.failed.length)'), 'success path must not unconditionally call recordDiagnostic');
assert.ok(serverJs.includes("label:'admin.github.issues.cleared'"), 'successful clear must still leave an operational breadcrumb');

console.log('github-issue-clear-success-diagnostic-regression: PASS');
