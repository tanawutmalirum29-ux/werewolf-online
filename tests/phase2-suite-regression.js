'use strict';
const assert = require('assert');
const { runPhase2Suite } = require('../utils/phase2-orchestrator');

const report = runPhase2Suite({ seed:'PHASE2-RELEASE-GATE', chaosCases:24, actionsPerPlayer:10, longRunCycles:12000, checkpointEvery:1000 });
assert.strictEqual(report.status, 'passed', `phase2 full suite failed: ${report.status}`);
assert.strictEqual(report.chaos.failed, 0, 'Chaos stage must pass');
assert.strictEqual(report.stress.allConverged, true, 'Stress stage must converge');
assert.strictEqual(report.longRun.stable, true, 'Long-Run must remain stable');
assert.strictEqual(report.recovery.failed, 0, 'Recovery stage must pass');
assert(report.audit.summary.events >= 2, 'phase2 orchestrator must emit lifecycle timeline');
console.log(`phase2-suite-regression: PASS (Chaos ${report.chaos.passed}/${report.chaos.total}, Stress ${report.stress.maxPlayers} players, Long-Run ${report.longRun.cycles} cycles, Recovery ${report.recovery.passed}/${report.recovery.total})`);
console.log('PHASE2_RESULT:' + JSON.stringify({stage:'full-suite', status:report.status, chaos:`${report.chaos.passed}/${report.chaos.total}`, maxPlayers:report.stress.maxPlayers, longRunCycles:report.longRun.cycles, recovery:`${report.recovery.passed}/${report.recovery.total}`}));
