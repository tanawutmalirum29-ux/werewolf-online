const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const phase2 = fs.readFileSync(path.join(root, 'public/js/admin-phase2.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/admin-phase2.css'), 'utf8');
const shellCss = fs.readFileSync(path.join(root, 'public/css/admin-shell.css'), 'utf8');

assert(html.includes('id="tab-overview"') && html.includes('class="overview-dashboard"'), 'Overview dashboard root missing');
assert((html.match(/<article class="overview-metric(?: overview-metric-server)?"/g) || []).length === 4, 'Overview must have exactly 4 primary metric cards');
for (const id of ['overviewServerState','overviewServerMeta','sumOnline','sumRooms','sumAccounts','overviewRooms','overviewActivity']) assert(html.includes(`id="${id}"`), `missing Overview mount: ${id}`);
for (const token of ['sumGoogleAccounts','sumTemporaryAccounts','sumRoomSessions','sumTesters','dashboard-focus','overviewRecent','phase2OverviewExtra','System Health','Quick Actions']) {
  assert(!html.includes(token), `legacy Overview token remains in HTML: ${token}`);
  assert(!phase2.includes(token), `legacy Overview token remains in Phase 2 JS: ${token}`);
}
assert(!phase2.includes('installOverview') && !phase2.includes('syncOverviewHealth'), 'Phase 2 must not dynamically rebuild Overview');
assert(css.includes('#tab-overview .overview-main-grid') && css.includes('@media(max-width:720px)'), 'Overview responsive layout rules missing');
assert(!shellCss.includes('.admin-page-stack .dashboard-focus'), 'legacy dashboard-focus shell rule remains');
assert(html.includes('data-overview-room-id') && html.includes('data-overview-player-index'), 'Overview interactive rows missing');
assert(html.includes('function renderOverviewRooms') && html.includes('function renderOverviewActivity'), 'Overview renderers missing');
assert(html.includes('normalRooms = rooms.filter((x) => !x.isTester)'), 'Overview must keep tester rooms out of normal room summary');
assert(html.includes('const onlineCount = realPlayers.filter((x) => x.online).length'), 'Overview online KPI must use the account presence state');
assert(html.includes('filter((p) => p.status !== "deleted")'), 'Overview activity should not surface deleted accounts');
assert(html.includes('overviewServerLabel') && html.includes('Running version'), 'Overview server/version summary missing');
console.log('admin-overview-ui: PASS');
