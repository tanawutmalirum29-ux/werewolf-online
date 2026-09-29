const fs = require('fs');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const admin = read('public/admin.html');
const browser = read('public/js/admin-browser.js');
const shell = read('public/css/admin-shell.css');
const browserCss = read('public/css/admin-browser.css');
const server = read('server.js');

// The production screenshot/report captured the unreplaced release token in the iframe URL.
assert(admin.includes('__WW_ADMIN_RELEASE__'), 'Admin HTML must retain the server-side release stamp placeholder');
assert(server.includes('__WW_ADMIN_RELEASE__'), 'Server must know the Admin release placeholder');
assert(server.includes('computeAdminHash()'), 'Server must compute a concrete Admin release');
assert(server.includes('getIconStampedHtml("admin.html")'), 'Admin route must use the stamped HTML path');
assert(browser.includes('if (metaValue && !metaValue.includes("__WW_ADMIN_RELEASE__"))'), 'Admin Browser must guard against unreplaced release placeholders');
assert(browser.includes('new URL(script.src, location.href).searchParams.get("v")'), 'Admin Browser must derive a safe release fallback from its own cache-buster');

// The report showed a Tester Pass HTTP auth failure; the browser-side request now
// waits for the tab session and retries once after re-authentication.
assert(browser === browser, 'noop');
assert(admin.includes('async function requestTesterPass(retryOnAuth = true)'), 'Tester Pass request must have explicit auth-retry control');
assert(admin.includes('await window.WWAdminTabAuth?.ready'), 'Tester Pass request must wait for tab auth initialization');
assert(admin.includes('const ok = await ensureAdminLogin();'), 'Tester Pass request must re-ensure Admin authentication when the server returns 401');
assert(admin.includes('if (response.status === 401 && retryOnAuth)'), 'Tester Pass request must recover once from HTTP 401');
assert(admin.includes('return requestTesterPass(false);'), 'Tester Pass auth retry must be bounded');

// The persistent context rail has been removed from the normal Admin shell; Browser focus still
// keeps its own full-width canvas contract.
assert(shell.includes('body.admin-browser-open .admin-layout-grid{'), 'Browser focus layout rule missing');
assert(shell.includes('grid-template-columns:minmax(0,1fr);'), 'Browser focus layout must collapse to a full-width workspace');
assert(!admin.includes('id="adminShellContext"'), 'obsolete context rail must not be part of Admin HTML');
assert(browserCss.includes('body.admin-browser-open .admin-browser-viewport-help{'), 'Browser focus mode must compact viewport help');
assert(browserCss.includes('body.admin-browser-open .admin-browser-viewport-bar[data-mode="auto"] .admin-browser-viewport-dimensions'), 'Auto mode must hide disabled custom dimensions');
assert(browserCss.includes('body.admin-browser-open .admin-browser-viewport-bar[data-mode="preset"] .admin-browser-viewport-dimensions'), 'Preset mode must hide disabled custom dimensions');

console.log('admin-browser-report-fixes-regression: PASS');
