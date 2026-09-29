const fs = require('fs');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const browser = read('public/js/admin-browser.js');
const admin = read('public/admin.html');

assert(!browser.includes('const EMBED_ROUTE_PREFIX'), 'Admin Browser must not depend on the custom embed pathname');
assert(browser.includes('/admin.html'), 'Admin page must be a valid internal iframe route');
assert(browser.includes('function buildAdminUrl'), 'Admin iframe URL builder missing');
assert(browser.includes('function canonicalizeAdminUrl'), 'Admin iframe canonical URL guard missing');
assert(browser.includes('function openAdmin'), 'Admin iframe tab launcher missing');
assert(browser.includes('ADMIN_EMBED_MAX_DEPTH = 1'), 'Admin iframe nesting guard missing');
assert(browser.includes('STORE_KEY = `ww_admin_internal_browser_v2${ADMIN_EMBED_MODE'), 'Embedded Admin internal-browser state must be isolated');
assert(browser.includes('meta.type === "admin"'), 'Admin iframe tabs must be restorable');
assert(browser.includes('function buildEmbeddedFrameUrl(raw)'), 'Admin Browser must have a canonical frame URL builder');
assert(browser.includes('url.searchParams.set("ww_admin_release", ADMIN_RELEASE);'), 'Canonical frame URL must carry an Admin release marker without changing pathname routing');
assert(browser.includes('return `${url.pathname === "/" ? "/index.html" : url.pathname}${url.search}${url.hash}`;'), 'Embedded frame URL must preserve the real game pathname');
assert(browser.includes('const health = getFrameHealth(iframe, tab);'), 'Iframe load must perform a real same-origin page health check');
assert(browser.includes('missing_root:'), 'Iframe health check must reject blank/shell-less documents');
assert(browser.includes('unexpected_page:'), 'Iframe health check must verify the expected game page type');
assert(browser.includes('iframe.dataset.directFallbackTried'), 'A deterministic canonical fallback marker is required');
assert(browser.includes('canonicalFrame: true'), 'Iframe diagnostics must identify the canonical frame path');
assert(browser.includes('className = "admin-browser-frame-notice"'), 'Black screen failures must have a visible diagnostic surface');
assert(admin.includes('/js/admin-browser.js?v=20260926-24'), 'Admin Browser JS cache-buster must be bumped');
assert(admin.includes('/css/admin-browser.css?v=20260927-22'), 'Admin Browser CSS cache-buster must be bumped');
console.log('admin-internal-browser-embed-regression: PASS');

assert(admin.includes('id="adminBrowserToggleBtn"'), 'Internal Browser must provide a visible exit control in browser focus');
