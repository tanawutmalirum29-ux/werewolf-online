const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');

assert(server.includes('ADMIN_GOOGLE_EMAILS'), 'Google admin email allowlist missing');
assert(server.includes('ADMIN_AUTH_CONFIGURED = !!ADMIN_PANEL_PASSWORD || ADMIN_GOOGLE_EMAILS.length > 0'), 'admin auth must be configured by password or Google allowlist');
assert(server.includes('admin_auth_not_configured'), 'admin auth must fail closed when no method is configured');
assert(server.includes('if (!ADMIN_AUTH_CONFIGURED) return false;'), 'admin socket must fail closed when admin auth is not configured');
assert(server.includes('payload.admin !== true'), 'admin session must carry an explicit signed admin marker and reject unsigned/non-admin payloads');
assert(server.includes('claims?.email_verified === true'), 'Google admin login must require verified email');
assert(server.includes('ADMIN_GOOGLE_EMAILS.includes(email)'), 'Google admin login must enforce email allowlist');
assert(server.includes('ADMIN_TAB_AUTH_ENFORCED'), 'Google-configured Admin mode must enforce tab-scoped sessions');
assert(server.includes('ADMIN_TAB_ID_REQUIRED'), 'password fallback must also bind newly issued sessions to a tab');
assert(server.includes('tabScoped:true'), 'password fallback must issue tab-scoped bearer sessions');
assert(server.includes('app.get("/auth/google/admin-start"'), 'Google admin start endpoint missing');
assert(server.includes('mode: "admin"'), 'admin OAuth state mode missing');
assert(server.includes('ADMIN_GOOGLE_STATE_COOKIE'), 'admin OAuth needs a separate state cookie');
assert(server.includes('provider: "google", googleSub: verified.providerSubject, email'), 'admin session must bind to verified Google subject');

const ensureStart = admin.indexOf('async function ensureAdminLogin()');
const ensureEnd = admin.indexOf('\nlet accounts = [];', ensureStart);
assert(ensureStart >= 0 && ensureEnd > ensureStart, 'could not isolate ensureAdminLogin');
const ensureBlock = admin.slice(ensureStart, ensureEnd);
assert(!ensureBlock.includes('window.prompt'), 'admin auth must use styled CSS modal, not browser prompt');
assert(ensureBlock.includes('showAdminLoginModal'), 'admin auth must show the styled modal');
assert(admin.includes('adminLoginOverlay'), 'styled admin login overlay missing');
assert(admin.includes('adminGoogleLoginBtn'), 'Google admin login button missing');
assert(admin.includes('credentials:"same-origin"'), 'admin password login must use same-origin transport');
assert(admin.includes('tabId:window.WWAdminTabAuth?.getTabId?.()'), 'password admin login must present tab id');
assert(admin.includes('window.WWAdminTabAuth?.setSession?.(d)'), 'password admin login must store the returned tab session');
assert(admin.includes('pendingAdminError'), 'Google admin callback errors must be shown by the modal');

const socketGuard = server.indexOf('if (String(event).startsWith("admin_") && !socket.data.isAdmin)');
assert(socketGuard >= 0, 'socket admin event guard missing');

console.log('✅ admin auth regression checks passed');
