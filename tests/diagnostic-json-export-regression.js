const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');

assert(server.includes('app.get("/api/admin/diagnostics/export"'), 'missing diagnostics JSON export endpoint');
assert(server.includes('scope === "event"'), 'missing single-report export scope');
assert(server.includes('reportKind:"BUG_REPORT"'), 'single export must identify BUG_REPORT');
assert(server.includes('reportKind:"ALL_BUG_REPORTS"'), 'aggregate export must identify ALL_BUG_REPORTS');
assert(server.includes('Content-Disposition'), 'JSON exports must download as attachment');
assert(server.includes('diagnosticEvents.map((event) => {'), 'aggregate export must iterate every in-memory diagnostic event');
assert(admin.includes('downloadDiagnosticJson(this,${i})'), 'each diagnostic event must expose JSON download');
assert(admin.includes('downloadAllDiagnosticJson('), 'diagnostics JSON popup must retain all-report download helper');
assert(admin.includes('openDiagnosticJsonOptions()'), 'diagnostics toolbar must expose JSON options popup');
assert(admin.includes('diagJsonOptionsBtn'), 'diagnostics header must expose the JSON options button');
assert(admin.includes('/api/admin/diagnostics/export?scope=event&eventId='), 'single JSON download must call export endpoint');
assert(admin.includes('/api/admin/diagnostics/export?scope=all'), 'all JSON download must call export endpoint');
assert(admin.includes('werewolf-bug-reports-all.json'), 'aggregate download must have a deterministic fallback filename');
console.log('diagnostic-json-export-regression: PASS');
