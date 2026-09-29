const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

assert(!html.includes('id="adminQuickDock"'), 'obsolete quick dock still present');
assert(!html.includes('function quickRefreshAdmin()'), 'obsolete quick refresh handler still present');
assert(!html.includes('function updateQuickDock()'), 'obsolete quick dock state handler still present');

assert(!html.includes('id="adminBottomDock"'), 'legacy bottom dock should be removed');
assert(!html.includes('id="adminPanelSheet"'), 'legacy floating panel sheet should be removed');
assert(html.includes('class="admin-sidebar-nav"'), 'persistent sidebar navigation missing');
assert(html.includes('id="adminApp"'), 'Admin Control Center root missing');
assert(html.includes('id="adminWorkspace"'), 'Admin workspace missing');
assert(!html.includes('id="adminShellContext"'), 'obsolete context rail must stay removed');
assert(html.includes('function closeAdminPanel()'), 'missing compatibility navigation handler');
assert(html.includes('const ADMIN_PANEL_META'), 'missing admin page metadata');
assert(!html.includes('class="tabs admin-tabs"'), 'old top admin tab bar still present');

assert(html.includes('class="overview-dashboard"'), 'missing redesigned Overview dashboard');
assert(html.includes('class="player-account-groups"'), 'missing split player account groups');
assert(html.includes('group("google"'), 'missing Google account area');
assert(html.includes('group("temporary"'), 'missing temporary account area');
assert(html.includes('p.accountType === "google"'), 'Google grouping does not use accountType');
assert(html.includes('a.accountType === "google" ? "🔵 บัญชี Google"'), 'account detail does not distinguish Google');
assert(html.includes('a.accountType === "temporary" ? "🟡 บัญชีชั่วคราว"'), 'account detail does not distinguish temporary');

assert(html.includes('id="adminViewportChip"'), 'developer viewport control was lost');
assert(html.includes('id="copyAdminCommandBtn"'), 'developer copy-command control was lost');
assert(!html.includes('id="adminReleaseInline"'), 'obsolete inline admin release display must be removed with Operations System card');
assert(html.includes('id="runningVersionChip"'), 'global running version chip must remain');

const panelIds = ['live', 'all', 'rooms', 'tools', 'diagnostics'];
for (const id of panelIds) {
    assert(new RegExp('id=\"tab-' + id + '\"[^>]*data-admin-panel=\"' + id + '\"|data-admin-panel=\"' + id + '\"[^>]*id=\"tab-' + id + '\"').test(html), 'panel marker missing for ' + id);
}
console.log('admin workspace shell + Google/temporary separation regression: PASS');
