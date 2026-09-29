const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const detector = fs.readFileSync(path.join(root, 'public', 'js', 'shared.update-check.js'), 'utf8');
const indexUpdate = fs.readFileSync(path.join(root, 'public', 'js', 'index.auto-update.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert(admin.includes('/js/shared.config-client.js?v=1'), 'Admin must load the shared config client');
assert(admin.includes('/js/shared.update-check.js?v=1') || admin.includes('shared.update-check.js?v=1'), 'Admin must load the shared update detector');
assert(admin.includes('window.WWUpdateDetector?.check'), 'Admin must use the shared update detector');
assert(admin.includes('function checkAdminUpdate()'), 'Admin update check function is missing');
assert(admin.includes('const ADMIN_UPDATE_CHECK_MS = 20000'), 'Admin update interval must match Index');
assert(admin.includes('ww_update_known_version') || detector.includes('ww_update_known_version'), 'shared known-version key must exist');
assert(admin.includes('/api/config') || detector.includes('/api/config'), 'Admin update flow must ultimately use /api/config');
assert(!admin.includes('function checkAdminRelease()'), 'legacy adminHash release checker must be removed');
assert(!admin.includes('/api/admin/release-check/'), 'Admin UI must not use the legacy release probe for update decisions');
assert(!admin.includes('adminReleaseMismatch'), 'legacy Admin release mismatch state must be removed');
assert(!admin.includes('adminReleaseUpdateShown'), 'legacy Admin release latch must be removed');
assert(!admin.includes('adminReleaseUpdateNotice'), 'legacy Admin release notice must be removed');
assert(admin.includes('notice.id = "adminUpdateNotice"'), 'new Admin update notice is missing');
assert(admin.includes('bottom:calc('), 'Admin update notice must stay as a bottom non-blocking notice');
assert(!admin.includes('ww-update-lock'), 'Admin update notice must not lock the whole page');
assert(admin.includes('id="adminUpdateReloadBtn"'), 'new Admin update reload action is missing');
assert(admin.includes('WWUpdateDetector?.setKnownVersion(version)'), 'Admin reload must advance the shared baseline');
assert(admin.includes('/admin-refresh/'), 'Admin reload must keep its cache-safe refresh route');
assert(index.includes('js/shared.config-client.js?v=1'), 'Index must load shared config client');
assert(index.includes('js/shared.update-check.js?v=1'), 'Index must load the same shared update detector');
assert(indexUpdate.includes('window.WWUpdateDetector.check()'), 'Index must use the same detector as Admin');
assert(admin.includes('window.WWUpdateDetector.check()'), 'Admin must call the detector with the same invocation as Index');
assert(detector.includes('window.wwGetConfig(options.config || {})'), 'shared detector must source versions through wwGetConfig');
assert(detector.includes('cleanVersion(data && data.version)'), 'shared detector must read server version from /api/config');
assert(server.includes('version: computeServerVersion()'), '/api/config must continue exposing the canonical server version');

console.log('admin-update regression: PASS');
