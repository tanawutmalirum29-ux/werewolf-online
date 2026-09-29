const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const detector = fs.readFileSync(path.join(root, 'public/js/shared.update-check.js'), 'utf8');
const indexUpdate = fs.readFileSync(path.join(root, 'public/js/index.auto-update.js'), 'utf8');

// Server-side Admin fingerprint/cache support may remain for HTML delivery/cache invalidation,
// but it must no longer be the client-side definition of "game update".
assert(server.includes('function computeAdminHash()'), 'admin HTML cache fingerprint helper should remain available');
assert(server.includes('adminHash: computeAdminHash()'), 'server adminHash metadata should remain available for compatibility/diagnostics');
assert(server.includes('app.get("/api/admin/release-check/:bucket"'), 'legacy release-probe endpoint may remain for compatibility');
assert(server.includes('app.get("/admin-refresh/:nonce"'), 'Admin refresh route must remain available');

// Admin and Index must share exactly one version detector/source of truth.
assert(admin.includes('/js/shared.config-client.js?v=1'), 'Admin must load shared config client');
assert(admin.includes('/js/shared.update-check.js?v=1'), 'Admin must load shared update detector');
assert(index.includes('js/shared.config-client.js?v=1'), 'Index must load shared config client');
assert(index.includes('js/shared.update-check.js?v=1'), 'Index must load the same shared update detector');
assert(indexUpdate.includes('window.WWUpdateDetector.check()'), 'Index must use the shared detector');
assert(admin.includes('window.WWUpdateDetector.check()') || admin.includes('window.WWUpdateDetector?.check'), 'Admin must use the shared detector');
assert(admin.includes('const ADMIN_UPDATE_CHECK_MS = 20000'), 'Admin update interval must match Index');
assert(detector.includes('window.wwGetConfig(options.config || {})'), 'shared detector must source versions through wwGetConfig');
assert(detector.includes('cleanVersion(data && data.version)'), 'shared detector must read data.version');
assert(server.includes('version: computeServerVersion()'), '/api/config must expose canonical server version');
assert(server.includes('const adminRelease = computeAdminHash();'), 'canonical version must include Admin release fingerprint');
assert(server.includes('|admin:${adminRelease}`'), 'canonical version must incorporate Admin release fingerprint');

// The Admin UI must not contain any of the old release-probe decision logic.
assert(!admin.includes('function checkAdminRelease()'), 'legacy Admin release checker must be removed');
assert(!admin.includes('/api/admin/release-check/'), 'Admin UI must not use the legacy release probe for update decisions');
assert(!admin.includes('adminReleaseMismatch'), 'legacy mismatch counter must be removed from Admin UI');
assert(!admin.includes('adminReleaseUpdateShown'), 'legacy release notice latch must be removed from Admin UI');
assert(!admin.includes('adminReleaseUpdateNotice'), 'legacy release notice element must be removed from Admin UI');
assert(!admin.includes('ADMIN_RELEASE_CHECK_MS'), 'legacy release polling interval must be removed from Admin UI');

// The replacement UI is a non-blocking bottom notice, not the Index full-screen lock.
assert(admin.includes('function checkAdminUpdate()'), 'Admin shared-update check function is missing');
assert(admin.includes('notice.id = "adminUpdateNotice"'), 'new Admin update notice is missing');
assert(admin.includes('bottom:calc('), 'Admin update notice must be a bottom notice');
assert(!admin.includes('ww-update-lock'), 'Admin update notice must not lock the whole page');
assert(admin.includes('id="adminUpdateReloadBtn"'), 'Admin update reload action is missing');
assert(admin.includes('WWUpdateDetector?.setKnownVersion(version)'), 'Admin reload must advance the shared baseline');
assert(admin.includes('/admin-refresh/'), 'Admin reload must keep cache-safe refresh route');


// Behavioral check: an Admin-only source change must also move the canonical /api/config version.
const vm = require('vm');
const os = require('os');
const {
    mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, statSync,
} = require('fs');
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'ww-canonical-version-'));
try {
    mkdirSync(path.join(fixtureRoot, 'public'), { recursive: true });
    writeFileSync(path.join(fixtureRoot, 'server.js'), 'server:v1');
    writeFileSync(path.join(fixtureRoot, 'botEngine.js'), 'bot:v1');
    writeFileSync(path.join(fixtureRoot, 'llmBotEngine.js'), 'llm:v1');
    writeFileSync(path.join(fixtureRoot, 'public', 'index.html'), 'index:v1');
    writeFileSync(path.join(fixtureRoot, 'public', 'admin.html'), 'admin:v1');

    const marker = server.indexOf('// เลขรุ่นรูปที่ต่อท้าย URL รูปทุกใบ');
    const source = server.slice(server.indexOf('const PUBLIC_DIR ='), marker) +
        '\nlet imageEpoch = "";' +
        '\nglobalThis.__test={computeServerVersion,reset:()=>{_versionCache.scannedAt=0;}};';
    const sandbox = {
        require,
        console,
        __dirname: fixtureRoot,
        fs,
        path,
        crypto: require('crypto'),
        Buffer,
        Date,
    };
    vm.runInNewContext(source, sandbox);
    const first = sandbox.__test.computeServerVersion();
    const adminPath = path.join(fixtureRoot, 'public', 'admin.html');
    writeFileSync(adminPath, 'admin:v2-only');
    const st = statSync(adminPath);
    utimesSync(adminPath, st.atime, new Date(st.mtimeMs + 1500));
    sandbox.__test.reset();
    const second = sandbox.__test.computeServerVersion();
    assert.notStrictEqual(second, first, 'canonical application version must change when only admin.html changes');
} finally {
    rmSync(fixtureRoot, { recursive:true, force:true });
}

console.log('admin-release regression: PASS');
