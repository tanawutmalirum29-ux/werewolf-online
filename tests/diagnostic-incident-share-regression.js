const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');

assert(server.includes('DIAGNOSTIC_INCIDENT_INDEX_PREFIX'), 'incident index prefix must exist');
assert(server.includes('DIAGNOSTIC_INCIDENT_REUSE_WINDOW_MS'), 'incident reuse window must exist');
assert(server.includes('function diagnosticIncidentIdentity'), 'incident identity helper must exist');
assert(server.includes('function getOrClaimDiagnosticIncidentShare'), 'persistent incident share claim helper must exist');
assert(server.includes('entityType: "DIAGNOSTIC_INCIDENT_INDEX"'), 'incident index must be persisted separately');
assert(server.includes('reusedExistingShare'), 'share response must expose reuse status');
assert(server.includes('INCIDENT MASTER URL'), 'human report must expose incident master URL');
assert(server.includes('เหตุการณ์นี้อยู่ใน incident เดียวกับลิงก์ที่สร้างก่อนหน้า'), 'report must explain why multiple logs reuse one link');
assert(server.includes('incidentKeyHash'), 'incident key must be redacted to a hash in public output');
assert(server.includes('if (incidentKey) {'), 'share creation must attempt incident grouping');
assert(server.includes('await persistDiagnosticShare(bundle, token, reusedIncident)'), 'existing incident share must be updated instead of creating another snapshot');
assert(server.includes('operation:${operationId}') && server.includes('request:${requestId}'), 'strong operation/request correlation must group one attempt');
assert(!server.includes('room:${roomId}`\n    if (roomId)'), 'bare room-only incident grouping must not be introduced');

const shareHandlerStart = server.indexOf('app.post("/api/admin/diagnostics/share"');
const shareHandlerEnd = server.indexOf('app.get("/diagnostics/share/:token.json"', shareHandlerStart);
assert(shareHandlerStart >= 0 && shareHandlerEnd > shareHandlerStart, 'diagnostic share route block must exist');
const shareRoute = server.slice(shareHandlerStart, shareHandlerEnd);
const incidentDecl = shareRoute.indexOf('const incidentKey = diagnosticIncidentIdentity(primary);');
const bundleDecl = shareRoute.indexOf('let bundle = {');
assert(incidentDecl >= 0 && bundleDecl >= 0 && incidentDecl < bundleDecl, 'incidentKey must be initialized before it is interpolated into the share bundle (prevents TDZ ReferenceError masked as storage unavailable)');
assert(shareRoute.includes('causeMessage') && shareRoute.includes('DIAGNOSTIC_SHARE_CREATE_FAILED'), 'share failure response must expose a sanitized underlying cause instead of only storage unavailable');

console.log('diagnostic incident share regression: PASS');
