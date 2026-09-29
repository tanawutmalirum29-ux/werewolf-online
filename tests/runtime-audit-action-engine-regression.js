const assert = require('assert');
const { createRuntimeAudit } = require('../utils/runtime-audit-engine');

let now = 0;
const audit = createRuntimeAudit({ clock: () => now, page:'player', runId:'action-test' });
const actions = [
    {id:'test.pass', page:'player', actor:'player', group:'test', kind:'ui', mode:'safe'},
    {id:'test.fail', page:'player', actor:'player', group:'test', kind:'ui', mode:'safe'},
    {id:'test.skip', page:'player', actor:'player', group:'test', kind:'ui', mode:'safe'},
];
audit.registerActions(actions);

let run = audit.beginAction(actions[0], {before:{value:0}});
now += 25;
audit.finishAction(run, {status:'passed', expected:{value:1}, actual:{value:1}});
run = audit.beginAction(actions[1]);
now += 35;
audit.finishAction(run, {status:'failed', findingCode:'ACTION_TEST_FAILURE', message:'expected mismatch', expected:{value:1}, actual:{value:0}});
run = audit.beginAction(actions[2]);
now += 5;
audit.finishAction(run, {status:'skipped', message:'not available'});
run = audit.beginAction('test.blocked');
now += 2;
audit.finishAction(run, {status:'blocked', message:'blocked'});
run = audit.beginAction('test.timeout');
now += 5000;
audit.finishAction(run, {status:'timeout', message:'timeout'});

const summary = audit.summary();
assert.strictEqual(summary.actionsRegistered, actions.length);
assert.strictEqual(summary.actionsStarted, 5);
assert.strictEqual(summary.actionsPassed, 1);
assert.strictEqual(summary.actionsFailed, 2, 'timeout should also count as failed');
assert.strictEqual(summary.actionsSkipped, 1);
assert.strictEqual(summary.actionsBlocked, 1);
assert.strictEqual(summary.actionsTimedOut, 1);
assert.strictEqual(summary.actionCoverage.attempted, 5);
assert(summary.findingCount >= 2, 'failed actions should produce findings');
const snapshot = audit.snapshot({timelineLimit:40,findingLimit:20});
assert(Array.isArray(snapshot.actionCoverage.recent), 'action history missing');
assert(snapshot.actionCoverage.recent.some(x => x.actionId === 'test.fail' && x.status === 'failed'));

console.log('runtime-audit-action-engine-regression: PASS');
