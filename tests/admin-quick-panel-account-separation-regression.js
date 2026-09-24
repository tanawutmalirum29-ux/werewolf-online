const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

assert(!html.includes('id="adminQuickDock"'), 'obsolete fixed admin quick dock still present');
assert(!html.includes('function quickRefreshAdmin()'), 'obsolete quick refresh handler still present');
assert(!html.includes('function updateQuickDock()'), 'obsolete quick dock state handler still present');
assert(html.includes('class="player-account-groups"'), 'missing split player account groups');
assert(html.includes('group("google"'), 'missing Google account area');
assert(html.includes('group("temporary"'), 'missing temporary account area');
assert(html.includes('p.accountType === "google"'), 'Google grouping does not use accountType');
assert(html.includes('a.accountType === "google" ? "🔵 บัญชี Google"'), 'account detail does not distinguish Google');
assert(html.includes('a.accountType === "temporary" ? "🟡 บัญชีชั่วคราว"'), 'account detail does not distinguish temporary');
console.log('admin main-panel deduplication + Google/temporary separation regression: PASS');
