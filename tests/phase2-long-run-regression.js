'use strict';
const assert = require('assert');
const { createLongRunHarness, linearSlope } = require('../utils/long-run-harness');

assert.strictEqual(linearSlope([5,5,5,5]), 0, 'stable series slope must be zero');
assert(linearSlope([1,2,3,4]) > 0, 'increasing series must have positive slope');

const report = createLongRunHarness({ seed:'LONG-RUN-001', cycles:12000, checkpointEvery:1000 }).run();
assert.strictEqual(report.cycles, 12000, 'long-run must execute configured cycles');
assert.strictEqual(report.checkpoints.length, 12, `expected 12 checkpoints, got ${report.checkpoints.length}`);
assert.strictEqual(report.stable, true, `long-run leak trend detected: ${JSON.stringify(report.slopes)}`);
assert.strictEqual(report.baselines.listeners, 6, 'listener baseline changed unexpectedly');
assert.strictEqual(report.baselines.timers, 4, 'timer baseline changed unexpectedly');
assert(report.checkpoints.every((x) => x.listeners === 6 && x.timers === 4 && x.domNodes === 120), 'steady-state resources must remain bounded at checkpoints');
assert(report.audit.summary.events >= 12, 'long-run must record checkpoint timeline');

console.log(`phase2-long-run-regression: PASS (${report.cycles} cycles, ${report.checkpoints.length} checkpoints)`);
console.log('PHASE2_RESULT:' + JSON.stringify({stage:'long-run', cycles:report.cycles, checkpoints:report.checkpoints.length, stable:report.stable, slopes:report.slopes}));
