const fs = require('fs');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const admin = read('public/admin.html');
const browser = read('public/js/admin-browser.js');
const host = read('public/js/host.main.js');
const player = read('public/js/player.main.js');
const account = read('public/js/account.identity.js');
const shared = read('public/js/shared.server-control.js');
const commands = read('public/js/admin-command-registry.js');

assert(admin.includes('/js/admin-browser.js?v=20260926-24'), 'admin must load Internal Browser');
assert(admin.includes('id="adminBrowserTabs"'), 'admin must expose internal tab strip');
assert(admin.includes('id="adminBrowserStage"'), 'admin must expose internal browser stage');
assert(admin.includes('data-admin-nav="browser"'), 'Internal Browser must be a left-side management menu item');
assert(admin.includes('id="adminBrowserToggleBtn"'), 'Internal Browser must expose an explicit back-to-Admin control');
assert(admin.includes('id="adminWorkspace"'), 'Internal Browser must render inside the right Admin workspace');
assert(admin.indexOf('id="adminBrowserView"') > admin.indexOf('id="adminWorkspace"'), 'Internal Browser view must be inside the Admin workspace');
assert(/function enterTesterMode\(\)[\s\S]*?WWAdminBrowser\?\.openTester/.test(admin), 'Tester launcher must delegate to Internal Browser');
assert(!/function enterTesterMode\(\)[\s\S]*?window\.open\(/.test(admin), 'Admin Tester launcher must not window.open a Chrome tab');
assert(browser.includes('MAX_TABS = 24'), 'Internal Browser tab cap missing');
assert(browser.includes('/admin.html'), 'Internal Browser must allow an Admin iframe page');
assert(browser.includes('function openAdmin()'), 'Internal Browser must expose an Admin iframe tab launcher');
assert(browser.includes('ADMIN_EMBED_MAX_DEPTH = 1'), 'Admin iframe nesting must have a depth guard');
assert(browser.includes('canonicalizeAdminUrl'), 'Admin iframe URLs must always be canonicalized to embedded mode');
assert(browser.includes('embeddedAdmin: ADMIN_EMBED_MODE'), 'Embedded Admin state must be observable for diagnostics');
assert(browser.includes('params.set("am", "1")'), 'Tester embedded mode marker missing');
assert(browser.includes('params.set("at", String(meta.tabId || ""))'), 'Per-tab identity marker missing');
assert(browser.includes('activateRelativeTab'), 'Internal tab keyboard navigation missing');
assert(browser.includes('openBot'), 'Embedded bot launcher missing');
assert(browser.includes('if (!frame || !event.source || frame.contentWindow !== event.source) return;'), 'Internal Browser messages must be bound to their source iframe');
assert(browser.includes('get() { return !state.tabs.some((tab) => tab.id === tabId); }'), 'Child window proxy must expose live closed state');
assert(host.includes('window.parent.WWAdminBrowser.openBot'), 'Host must delegate possessed bot to Internal Browser');
assert(/const ww_store = TESTER_MODE \? \(\(window\.wwEmbeddedStorage/.test(player), 'Player must use scoped Tester storage');
assert(/const storage = tester \? \(\(window\.wwEmbeddedStorage/.test(account), 'Account identity must use scoped Tester storage');
assert(shared.includes('createScopedStorage'), 'Shared server control must provide scoped storage');
assert(shared.includes('ww-admin-browser-return-admin'), 'Tester must return through Internal Browser');
assert(shared.includes('ww-admin-browser-return-host'), 'Bot must return to internal Host tab');
assert(commands.includes('id:"browser.admin"'), 'Command missing: browser.admin');
for (const id of ['browser.open','browser.game','browser.tester.host','browser.tester.player','browser.next']) {
  assert(commands.includes(`id:"${id}"`), `Command missing: ${id}`);
}
console.log('admin-internal-browser-contract: PASS');
