'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');

assert(admin.includes('id="diagGithubStatus"'), 'Diagnostics must expose the GitHub repository link');
assert(admin.includes('class="admin-diagnostics-github-line"'), 'GitHub link must have its own header row');
assert(admin.includes('id="diagGithubSubmitAllBtn"'), 'Diagnostics must expose the all-report GitHub button');
assert(admin.includes('sendAllDiagnosticsToGitHub(this)'), 'all-report GitHub button must use batch submit handler');
assert(admin.includes('/api/admin/diagnostics/github/all'), 'Admin UI must call the batch GitHub endpoint');
assert(admin.includes('eventIds:events.map((e)=>e.id)'), 'batch submit must send the currently displayed event IDs');
assert(admin.includes('id="diagJsonOptionsBtn"'), 'JSON button must open options');
assert(admin.includes('openDiagnosticJsonOptions()'), 'JSON button must open the JSON options popup');
assert(admin.includes('id="diagJsonOpenBtn"'), 'JSON popup must provide open action');
assert(admin.includes('id="diagJsonDownloadBtn"'), 'JSON popup must provide download action');
assert(admin.includes('id="diagJsonCopyBtn"'), 'JSON popup must provide copy action');
assert(admin.includes('admin-diagnostics-header-actions{display:flex;align-items:center;justify-content:flex-start;gap:6px;flex-wrap:nowrap;'), 'header actions must stay on one horizontal row');
assert(admin.includes('overflow-x:auto;overflow-y:hidden;scrollbar-width:none'), 'action row must remain usable on narrow screens without wrapping');
assert(!admin.includes('<span class="diag-safe-badge">ไม่กระทบเกม</span>'), 'Diagnostics header must not show the removed safety phrase');
assert(!admin.includes('onclick="downloadAllDiagnosticJson()" type="button">⬇️ JSON</button>'), 'old direct-download JSON button must be removed from header');

console.log('admin-diagnostics-toolbar-ui-regression: PASS');
