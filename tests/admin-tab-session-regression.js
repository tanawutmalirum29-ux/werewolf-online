const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'public/js/admin-auth-tab.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'public/js/admin-shell.js'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'public/js/admin-command-registry.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/admin-shell.css'), 'utf8');

assert(server.includes('sessionType: tabId ? "tab" : "cookie"'), 'admin sessions must distinguish tab-scoped and legacy cookie sessions');
assert(server.includes('payload.sessionType === "tab"'), 'server must verify tab-scoped session type');
assert(server.includes('payload.tabId !== presentedTabId'), 'tab-scoped session must bind credential to presented tab id');
assert(server.includes('headers.authorization'), 'admin HTTP API must support bearer authorization');
assert(server.includes('adminToken'), 'admin Socket.IO handshake must support tab bearer token');
assert(server.includes('X-WW-Admin-Tab-Id'), 'admin HTTP API must receive tab id binding');
assert(server.includes('ADMIN_TAB_SESSION_TTL_MS'), 'tab session needs an explicit TTL');
assert(server.includes('ADMIN_TAB_HANDOFF_TTL_MS'), 'OAuth tab handoff needs an explicit short TTL');
assert(server.includes('app.post("/api/admin/session/exchange"'), 'tab session exchange endpoint missing');
assert(server.includes('type: "admin_tab_handoff"'), 'Google callback must mint a tab handoff ticket');
assert(server.includes('return res.redirect(`/admin.html#admin_ticket='), 'Google callback must return ticket in URL fragment, not query');
assert(server.includes('adminGoogleStateCookieName(tabId)'), 'Google state cookie must be unique per tab');
assert(!server.includes('setHttpOnlyCookie(res, ADMIN_SESSION_COOKIE, createAdminSessionToken({ provider: "google"'), 'Google admin callback must not create a browser-wide admin cookie');
assert(server.includes('adminTabSessionRevoked'), 'tab admin logout must revoke the presented session id');

assert(admin.includes('autoConnect:false'), 'admin socket must not connect before tab authentication is ready');
assert(admin.includes('/js/admin-auth-tab.js?v=20260925-1'), 'tab auth client module missing');
assert(admin.includes('/js/admin-command-registry.js?v=20260925-2'), 'admin command registry missing');
assert(admin.includes('/js/admin-shell.js?v=20260926-5'), 'admin shell script must be loaded by the real Admin page');
assert(admin.includes('function updateAdminShellStatus'), 'admin page must bridge live status into the shell');
assert(admin.includes('id="adminApp"') && admin.includes('class="admin-app-shell"'), 'Admin Control Center root missing');
assert(admin.includes('class="admin-sidebar-nav"'), 'persistent Admin sidebar navigation missing');
assert(!admin.includes('id="adminShellContext"'), 'obsolete persistent context rail must stay removed');
assert(!shell.includes('/index.html?embedded=admin'), 'new admin shell must not embed the Index page');
assert(!admin.includes('id="adminGameSurface"'), 'legacy Index iframe must be removed from Admin');
assert(shell.includes('adminCommandPalette'), 'command palette missing');
assert(shell.includes('ctrlKey') && shell.includes('metaKey'), 'command palette shortcut support missing');
assert(admin.includes('window.__wwAdminSocket = socket'), 'admin shell logout must be able to access the shared socket');
assert(auth.includes('sessionStorage'), 'tab credential must use sessionStorage');
assert(!auth.includes('localStorage.setItem(TOKEN_KEY'), 'tab admin token must not be stored in localStorage');
assert(auth.includes('X-WW-Admin-Tab-Id'), 'tab auth fetch wrapper must present tab id');
assert(auth.includes('Authorization', 0), 'tab auth fetch wrapper must present bearer token');
assert(auth.includes('history.replaceState'), 'OAuth fragment must be cleared after exchange');
assert(shell.includes('data-shell-command'), 'shell quick commands missing');
assert(shell.includes('ww-admin-event'), 'Admin Event Bus integration missing');
assert(shell.includes('data-admin-nav') || admin.includes('data-admin-nav'), 'Admin navigation wiring missing');
assert(registry.includes('server.reload.both'), 'root shortcut registry missing server controls');
assert(registry.includes('bugreplay.phase2'), 'root shortcut registry missing diagnostics/phase2');
assert(css.includes('@media(max-width:720px)'), 'mobile shell layout missing');
assert(css.includes('grid-template-columns:var(--admin-sidebar)'), 'desktop Admin sidebar layout missing');
assert(css.includes('@media(max-width:720px)'), 'mobile Admin navigation layout missing');
const phase2css = fs.readFileSync(path.join(root, 'public/css/admin-phase2.css'), 'utf8');
const phase2js = fs.readFileSync(path.join(root, 'public/js/admin-phase2.js'), 'utf8');
assert(admin.includes('/css/admin-phase2.css?v=20260926-7'), 'Phase 2 CSS missing');
assert(admin.includes('/js/admin-phase2.js?v=20260925-1'), 'Phase 2 JS missing');
assert(phase2css.includes('.phase2-page-intro') && !phase2css.includes('#accountOverlay'), 'Phase 2 layout styles missing or obsolete account drawer remains');
assert(phase2js.includes('globalSearchItems') && phase2js.includes('playerFilterBar') && phase2js.includes('installContextEnhancement'), 'Phase 2 functional UX hooks missing');
assert(admin.includes('id="phase2DangerCard"'), 'Phase 2 danger zone mount missing');
assert(admin.includes('id="adminOperationsHeaderTools"'), 'Operations header tool mount missing');
assert(!admin.includes('id="phase2DevCard"'), 'obsolete Operations System card must stay removed');

// Execute the small auth module in a deterministic browser stub and verify tab isolation.
const storage = new Map();
const listeners = {};
const sandbox = {
  window: {
    fetch: async (input, init) => ({ ok: true, json: async () => ({ ok: true, token: 'ticket-token', tabId: JSON.parse(init.body).tabId, expiresAt: Date.now()+1000, email:'admin@example.com', provider:'google' }) }),
  },
  sessionStorage: {
    getItem: (k) => storage.has(k) ? storage.get(k) : null,
    setItem: (k,v) => storage.set(k,String(v)),
    removeItem: (k) => storage.delete(k),
  },
  crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789012' },
  location: { hash: '', origin: 'https://game.example', assign:()=>{} },
  history: { replaceState:()=>{} },
  URLSearchParams,
  Headers,
  setTimeout,
  clearTimeout,
  Date,
};
sandbox.window.window = sandbox.window;
vm.runInNewContext(auth, sandbox);
assert(sandbox.window.WWAdminTabAuth, 'auth module must export public tab auth API');
const id1 = sandbox.window.WWAdminTabAuth.getTabId();
assert.strictEqual(id1, '12345678123442348234123456789012', 'deterministic tab id should be sanitized into a valid session id');
sandbox.window.WWAdminTabAuth.setSession({ token:'abc', tabId:id1, expiresAt:Date.now()+10000, email:'admin@example.com' });
assert.strictEqual(sandbox.window.WWAdminTabAuth.getToken(), 'abc', 'tab session token must be retrievable from sessionStorage');
assert(storage.has('ww_admin_tab_token'), 'tab token must be stored in sessionStorage');
assert(!storage.has('ww_admin_token'), 'legacy admin token must not be stored under a broad storage key');

console.log('✅ admin tab session + admin shell regression checks passed');
