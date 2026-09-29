const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'public', 'js', 'shared.server-control.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert(index.includes('window.__WW_INDEX_EARLY_SERVER_OPEN__=true;'), 'Index must record an early authoritative open state');
assert(index.includes('window.__WW_INDEX_EARLY_SERVER_OPEN__=false;'), 'Index must record an early authoritative closed state');
assert(index.includes("document.addEventListener('visibilitychange',function(){"), 'Index must neutralize the old closed screen on the earliest mobile visibility lifecycle event');
assert(index.includes("window.addEventListener('freeze',prepareForNavigation,true);"), 'Index must neutralize the old document before a mobile page is frozen');
assert(index.includes("window.addEventListener('pagehide',prepareForNavigation,true);"), 'Index must neutralize the old document snapshot on navigation/reload');
assert(index.includes("window.addEventListener('beforeunload',prepareForNavigation,true);"), 'Index must neutralize the old document during unload when supported');
assert(index.includes("root.classList.remove('ww-index-server-closed');"), 'Navigation handoff must remove the old closed state');
assert(index.includes("root.classList.add('ww-index-server-pending');"), 'Navigation handoff must restore the neutral pending gate');
assert(index.includes("var oldOverlay=document.getElementById('wwClosedOverlay');"), 'Navigation handoff must remove an old shared closed overlay');
assert(index.includes("root.classList.remove('ww-index-server-pending');"), 'Index lifecycle restore must be able to leave the neutral pending state cleanly');

assert(server.includes('const SERVER_STATE_AUTHORITY_CACHE_MS = 1500;'), 'Server must have a bounded shared-state authority cache');
assert(server.includes('async function readAuthoritativeServerState'), 'Server must read the persisted SERVER_STATE row for cross-instance reconciliation');
assert(server.includes('async function syncServerStateFromAuthority'), 'Server must reconcile process-local server state with persisted state');
assert(server.includes('const shouldSyncPersistedState = p === "/" || p === "/index.html" || p === "/api/config" || p === "/api/server-state";'), 'Server gate must reconcile Index/config navigation before the closed-server document is selected');
assert(server.includes('const forceAuthorityRead = p === "/" || p === "/index.html" || (p === "/api/server-state" && (req.query.boot === "1" || req.query.verify === "1"));'), 'Root navigation and first-paint/verify probes must force a fresh persisted state read');
assert(server.includes('const persisted = await syncServerStateFromAuthority({ force: forceAuthorityRead });'), 'The lightweight server-state endpoint must expose the reconciled authoritative state');
assert(server.includes('res.setHeader("X-WW-Server-State-Source", persisted ? "dynamodb" : "local-fallback");'), 'Server-state diagnostics must identify whether persisted authority was available');
assert(server.includes('res.setHeader("Surrogate-Control", "no-store");'), 'Maintenance HTML must explicitly opt out of CDN surrogate caching');

assert(shared.includes("fetch('/api/server-state?verify=1'"), 'Index reopen race must verify the lightweight authoritative server state');
assert(shared.includes('window.__WW_INDEX_EARLY_SERVER_OPEN__ === true'), 'Shared config must recognize the authoritative early-open state');
assert(shared.includes('Do not flash the closed screen from that stale secondary'), 'Regression guard must document the stale config race');

console.log('index-server-reopen-no-flash-regression: PASS');
