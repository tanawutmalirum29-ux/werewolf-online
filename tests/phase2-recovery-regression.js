'use strict';
const assert = require('assert');
const { runRecoverySuite } = require('../utils/phase2-orchestrator');
const { compareState } = require('../utils/recovery-orchestrator');

const equal = compareState(
    { roomId:'A', version:2, phase:'day', timer:10, players:[{id:'p2',alive:true},{id:'p1',alive:false}] },
    { roomId:'A', version:9, phase:'day', timer:10, players:[{id:'p1',alive:false},{id:'p2',alive:true}] },
);
assert.strictEqual(equal.ok, true, 'state comparison should be canonical across player order/version');

const suite = runRecoverySuite();
assert.strictEqual(suite.total, 6, 'recovery suite must include all six recovery classes');
assert.strictEqual(suite.failed, 0, `recovery failure count: ${suite.failed}`);
assert.strictEqual(suite.passed, suite.total, 'every recovery scenario must converge');
assert(suite.cases.every((x) => x.result.ok && x.result.recoveredState.roomId === 'PHASE2'), 'recovery must restore the canonical room');
assert(suite.audit.summary.events >= suite.total, 'recovery timeline missing attempts');
assert(!suite.audit.findings.some((f) => f.code === 'RECOVERY_CONVERGENCE_FAILED'), 'recovery must not report convergence failures');

console.log(`phase2-recovery-regression: PASS (${suite.passed}/${suite.total} cases)`);
console.log('PHASE2_RESULT:' + JSON.stringify({stage:'recovery', passed:suite.passed, total:suite.total, failed:suite.failed}));
