const assert = require('assert');
const registry = require('../public/js/runtime-audit-action-registry.js');
const runner = require('../utils/bug-replay-runner');

const actions = registry.all();
const has = (id) => !!registry.find(id);
const families = [
    ['index.join-room','player.join-room','host.create-room'],
    ['player.reconnect-sync','host.request-sync'],
    ['player.cast-vote','host.force-vote-all'],
    ['host.close-room','admin.close-room'],
    ['admin.list-accounts','admin.list-rooms-socket','admin.get-room-detail'],
    ['admin.embedded-admin'],
];
for (const family of families) {
    assert(family.some(has), `missing cross-page family: ${family.join(', ')}`);
}
assert(has('player.abandon-game') && has('player.release-bot'), 'player recovery/tester actions missing');
assert(has('host.restart-room') && has('host.bot-llm-mode'), 'host lifecycle/bot coverage missing');
assert(has('admin.rename-account') && has('admin.set-account-status') && has('admin.reset-account-stats'), 'admin account action coverage missing');
assert(runner.getBugReplayScenario('runtime-action-audit'), 'runtime-action-audit scenario missing');
const deep = runner.getBugReplayScenario('runtime-action-deep');
assert(deep, 'runtime-action-deep scenario missing');
assert(deep.tests.length >= 8, 'deep action audit must aggregate broad existing action/security suites');
assert(actions.filter(a => a.page === 'player' && a.kind === 'socket').length >= 25, 'player socket action coverage too small');
assert(actions.filter(a => a.page === 'host' && a.kind === 'socket').length >= 20, 'host socket action coverage too small');
assert(actions.filter(a => a.page === 'admin' && a.kind === 'socket').length >= 10, 'admin socket action coverage too small');

console.log('runtime-audit-cross-page-regression: PASS');
