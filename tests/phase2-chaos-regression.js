'use strict';
const assert = require('assert');
const { runChaosCase, runChaosSuite } = require('../utils/phase2-orchestrator');
const { createFaultInjector } = require('../utils/chaos-fault-injector');

const a = createFaultInjector({ seed:'CHAOS-DETERMINISM', maxFaults:6 }).plan(6);
const b = createFaultInjector({ seed:'CHAOS-DETERMINISM', maxFaults:6 }).plan(6);
assert.deepStrictEqual(a, b, 'same chaos seed must produce the same fault plan');

const mixed = runChaosCase({
    seed:'CHAOS-MIXED-001',
    faultCount:6,
    mixed:true,
});
assert.strictEqual(mixed.finalConverged, true, `mixed chaos must recover: ${JSON.stringify(mixed.recovery.final)}`);
assert(mixed.appliedFaults.length >= 1, 'chaos must actually inject at least one fault');
assert(mixed.recovery.attempts.length >= 1, 'recovery attempt timeline missing');
assert(mixed.faults.every((f) => f.id && f.type && Number.isInteger(f.atStep)), 'faults must be replayable records');

const suite = runChaosSuite({ cases:24 });
assert.strictEqual(suite.total, 24, 'chaos suite case count');
assert.strictEqual(suite.failed, 0, `chaos suite has failures: ${suite.failed}`);
assert.strictEqual(suite.passed, 24, 'all chaos cases must converge after recovery');
assert(suite.deterministicSeeds.length === 24, 'all chaos cases need deterministic seeds');

console.log(`phase2-chaos-regression: PASS (${suite.passed}/${suite.total} cases)`);
console.log('PHASE2_RESULT:' + JSON.stringify({stage:'chaos', passed:suite.passed, total:suite.total, failed:suite.failed}));
