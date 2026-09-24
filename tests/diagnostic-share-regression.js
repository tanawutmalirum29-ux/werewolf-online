const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const reporter = fs.readFileSync(path.join(root, 'public', 'js', 'error-reporter.js'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

assert(server.includes('app.post("/api/admin/diagnostics/share"'), 'admin diagnostic share endpoint missing');
assert(server.includes('app.get("/diagnostics/share/:token.json"'), 'machine-readable diagnostic share endpoint missing');
assert(server.includes('app.get("/diagnostics/share/:token"'), 'human-readable diagnostic share endpoint missing');
assert(server.includes('crypto.randomBytes(DIAGNOSTIC_SHARE_TOKEN_BYTES).toString("base64url")'), 'share token must be cryptographically random');
assert(server.includes('ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)"'), 'diagnostic share must avoid accidental token collision overwrite');
assert(server.includes('DIAGNOSTIC_SHARE_PARTITION_KEY'), 'share records must have an isolated storage partition');
assert(server.includes('expiresAtEpoch'), 'share records must have server-enforced expiry');
assert(server.includes('AUTH EVIDENCE (client → server)'), 'share text must include auth evidence for root-cause tracing');
assert(server.includes('X-Robots-Tag'), 'public share must be protected from indexing');
assert(server.includes('Referrer-Policy'), 'public share must suppress referrer leakage');
assert(server.includes('startsWith("/diagnostics/share/")'), 'diagnostic shares must remain readable while server is closed');
assert(server.includes('DIAGNOSTIC_SHARE_MAX_BYTES'), 'share payload must be bounded before DynamoDB write');

assert(admin.includes('copyDiagnosticShareLink'), 'admin must expose copy-link action');
assert(admin.includes('/api/admin/diagnostics/share'), 'admin must call the share endpoint');
assert(admin.includes('🔗 คัดลอกลิงก์ AI'), 'admin UI must expose an AI-readable share button');
assert(admin.includes('หมดอายุ'), 'admin UI must communicate share expiry');
assert(reporter.includes('causalHint'), 'client diagnostic causal hint must be sent to server');

assert(readme.includes('Diagnostics Share v3 + Cross-Log Causal Graph'), 'README must document v3 causal share behavior');
assert(server.includes('/diagnostics/share/:token/event/:eventId'), 'nested diagnostic event route missing');
assert(server.includes('REPORT URL:'), 'shared report must contain recursive event links');
assert(server.includes('UPSTREAM CAUSES'), 'shared report must include upstream causal links');
assert(server.includes('DOWNSTREAM EFFECTS'), 'shared report must include downstream causal links');

console.log('diagnostic-share regression: PASS');
