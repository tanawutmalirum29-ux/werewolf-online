const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'public', 'js', 'error-reporter.js'), 'utf8');

assert(admin.includes('async function adminFetchJson('), 'adminFetchJson helper missing');
assert(admin.includes("credentials:'same-origin'"), 'admin fetch must send same-origin session cookies');
assert(admin.includes('const authReady = await ensureAdminLogin();'), 'diagnostics must wait for admin authentication');
assert(admin.includes("/api/admin/diagnostics?limit=100"), 'diagnostics endpoint missing');
assert(admin.includes("response.status === 401"), 'diagnostics must handle expired admin sessions');
assert(server.includes('app.get("/api/admin/session"'), 'admin session endpoint missing');
assert(server.includes('app.get("/api/admin/diagnostics"'), 'diagnostics endpoint missing');
assert(server.includes('app.use("/api/admin", (req, res, next) =>'), 'admin auth middleware missing');

console.log('✅ admin diagnostics regression checks passed');

assert(server.includes('buildDiagnosticAnalysis'), 'diagnostics must calculate a causal analysis');
assert(server.includes('ack:${event}'), 'server diagnostics must capture socket ACK outcome');
assert(admin.includes('ROOT CAUSE (ระบบวิเคราะห์)'), 'copied diagnostic report must include root-cause analysis');

assert(server.includes('operationId'), 'server diagnostics must track operation IDs');
assert(server.includes('handler.start:${event}'), 'server diagnostics must capture handler start');
assert(client.includes('socket_ack_timeout'), 'client diagnostics must report missing socket ACK');
assert(client.includes('lastSocketAck'), 'unhandled rejection diagnostics must link recent socket ACK evidence');
assert(admin.includes('สาเหตุที่ระบบจับได้'), 'admin diagnostics card must show direct cause');
assert(server.includes('X-WW-Server-Instance'), 'HTTP diagnostics must identify the serving server instance');
