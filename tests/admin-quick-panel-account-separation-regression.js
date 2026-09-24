const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

assert(!html.includes('id="adminQuickDock"'), 'obsolete quick dock still present');
assert(!html.includes('function quickRefreshAdmin()'), 'obsolete quick refresh handler still present');
assert(!html.includes('function updateQuickDock()'), 'obsolete quick dock state handler still present');

assert(html.includes('id="adminBottomDock"'), 'missing admin bottom dock');
assert(html.includes('data-admin-nav="overview"'), 'missing overview dock button');
assert(html.includes('data-admin-nav="all"'), 'missing player dock button');
assert(html.includes('data-admin-nav="live"'), 'missing live dock button');
assert(html.includes('data-admin-nav="rooms"'), 'missing rooms dock button');
assert(html.includes('data-admin-nav="tools"'), 'missing system dock button');
assert(html.includes('data-admin-nav="diagnostics"'), 'missing diagnostics dock button');
assert(html.includes('id="adminPanelSheet"'), 'missing floating admin panel sheet');
assert(html.includes('function closeAdminPanel()'), 'missing admin panel close handler');
assert(html.includes('const ADMIN_PANEL_META'), 'missing admin panel metadata');
assert(html.includes('data-admin-sheet-close'), 'missing admin panel backdrop close target');
assert(!html.includes('<div class="tabs admin-tabs">'), 'old top admin tab bar still present');

assert(html.includes('class="dashboard-focus"'), 'missing simplified dashboard guidance');
assert(html.includes('class="player-account-groups"'), 'missing split player account groups');
assert(html.includes('group("google"'), 'missing Google account area');
assert(html.includes('group("temporary"'), 'missing temporary account area');
assert(html.includes('p.accountType === "google"'), 'Google grouping does not use accountType');
assert(html.includes('a.accountType === "google" ? "🔵 บัญชี Google"'), 'account detail does not distinguish Google');
assert(html.includes('a.accountType === "temporary" ? "🟡 บัญชีชั่วคราว"'), 'account detail does not distinguish temporary');

assert(html.includes('id="adminViewportChip"'), 'developer viewport control was lost');
assert(html.includes('id="copyAdminCommandBtn"'), 'developer copy-command control was lost');
assert(html.includes('id="adminReleaseInline"'), 'inline admin release display is missing');

const panelIds = ['live', 'all', 'rooms', 'tools', 'diagnostics'];
for (const id of panelIds) {
    assert(html.includes('id="tab-' + id + '" data-admin-panel="' + id + '"'), 'panel marker missing for ' + id);
}
console.log('admin bottom dock + floating panel + Google/temporary separation regression: PASS');
