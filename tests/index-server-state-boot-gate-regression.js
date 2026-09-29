const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const shared = fs.readFileSync(path.join(root, 'public', 'js', 'shared.server-control.js'), 'utf8');

assert(index.includes("typeof info.serverIconUrl==='string'"), 'Index boot gate must consume the server-provided canonical closed-server icon URL');
assert(index.includes('typeof d.imageBase===\'string\''), 'Index boot gate must accept the external image base from server-state');
assert(server.includes('imageBase: IMAGE_BASE_URL'), 'Server-state payload must expose the configured external image base for the closed-state icon');
assert(server.includes('serverIconUrl: imgUrl(SERVER_CLOSED_ICON_PATH)'), 'Server-state payload must expose the canonical S3/CDN closed-server icon URL');
assert(shared.includes('window.WW_CLOSED_SERVER_ICON_URL'), 'Shared server-control must consume the canonical server-provided closed-server icon URL');
assert(shared.includes('function hydrateClosedServerIcon(img)'), 'Shared server-control must hydrate the closed-state S3 icon even before /api/config');
assert(!shared.includes('font-size:56px;line-height:1;margin-bottom:14px">🔧</div>'), 'Closed overlay must not keep the old wrench emoji icon');
assert(!index.includes('wwIndexBootIcon" aria-hidden="true">🐺</div>'), 'Index boot gate must not keep the old wolf emoji icon');
assert(!fs.readFileSync(path.join(root, 'public', 'maintenance.html'), 'utf8').includes('<div class="icon">🔧</div>'), 'Maintenance page must not keep the old wrench emoji icon');

assert(index.includes('id="wwIndexServerBoot"'), 'Index must include first-paint server boot gate');
assert(index.includes('html.ww-index-server-pending body > *:not(#wwIndexServerBoot)'), 'Boot gate must hide the real Lobby while server state is pending');
assert(index.includes("fetch('/api/server-state?boot=1'"), 'Index must use the lightweight server-state endpoint');
assert(index.includes('state.timer=setTimeout(failOpenAfterTimeout,4200)'), 'Boot gate timeout must exceed the server-state startup gate');
assert(index.includes('serverOpen===false'), 'Boot gate must have an explicit closed-server branch');
assert(index.includes('function reveal()') && index.includes('function closed(info)'), 'Boot gate must expose open/closed resolution paths');
assert(index.includes('function syncElement()'), 'Boot gate must synchronize state after the body element exists');
assert(index.includes('window.__WW_INDEX_BOOT_GATE__'), 'Boot gate bridge must be exposed for shared.server-control');

assert(server.includes('p === "/api/server-state"'), 'Closed-server middleware must allow /api/server-state');
assert(/app\.get\(\"\/api\/server-state\", (req, res) =>|app\.get\(\"\/api\/server-state\", async \(req, res\) =>/.test(server), 'Server must expose the lightweight server-state endpoint');
assert(server.includes('serverOpen: !serverClosed || shielded'), 'Server-state endpoint must derive serverOpen from serverClosed/tester shielding');
assert(server.includes('res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private")'), 'Server-state endpoint must disable caching');
assert(server.includes('res.setHeader("Surrogate-Control", "no-store")'), 'Server-state endpoint must discourage CDN caching');
assert(server.includes('noticeMessage: shielded ? "" : (closingPlan ? closingPlan.message : closedMessage)'), 'Server-state payload must include the current maintenance notice');
assert(server.includes('reopenAt: shielded ? 0 : (closingPlan ? closingPlan.reopenAt : closedReopenAt)'), 'Server-state payload must include reopenAt');

assert(shared.includes('window.__WW_INDEX_BOOT_GATE__.closed(closedInfo)'), 'Shared server control must hand closed state into the first-paint gate');
assert(shared.includes('window.__WW_INDEX_BOOT_GATE__.handoffClosed()'), 'Shared server control must hand the visual layer to the full closed overlay');

console.log('index-server-state-boot-gate-regression: PASS');
