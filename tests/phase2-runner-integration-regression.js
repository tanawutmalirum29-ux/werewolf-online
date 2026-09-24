'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { listBugReplayScenarios, getBugReplayScenario } = require('../utils/bug-replay-runner');

const root = path.resolve(__dirname, '..');
const runner = fs.readFileSync(path.join(root, 'utils/bug-replay-runner.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'public/admin.html'), 'utf8');

const phase2 = listBugReplayScenarios('phase2');
assert.deepStrictEqual(phase2.map((x) => x.id), ['phase2-chaos','phase2-stress','phase2-long-run','phase2-recovery','phase2-full-suite']);
assert(phase2.slice(0,4).every((x) => x.testCount === 1), 'each Chaos/Stress/Long-Run/Recovery stage must have one bounded allow-listed entry point');
assert.strictEqual(phase2[4].testCount, 2, 'aggregate Phase 2 suite must include its own report and runner integration check');
assert(getBugReplayScenario('phase2-full-suite'), 'Phase 2 aggregate scenario must be allow-listed');
assert(runner.includes('phase2Match = text.match(/^PHASE2_RESULT:(\\{.*\\})$/m)'), 'runner must consume structured Phase 2 result lines');
assert(server.includes('requestedMode === "phase2"'), 'server must explicitly allow Phase 2 mode');
assert(server.includes('listBugReplayScenarios(safeMode)'), 'server must select Phase 2 catalog by mode');
assert(server.includes('phase2Reports'), 'server must retain bounded Phase 2 stage reports');
assert(server.includes('safeMode === "phase2" ? 60_000 : 25_000'), 'Phase 2 runner must have a longer bounded child-test timeout');
assert(admin.includes('id="bugReplayPhase2Btn"') && admin.includes("startBugReplay('phase2')"), 'Admin must expose Phase 2 start control');

console.log('phase2-runner-integration-regression: PASS');
