const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { listBugReplayScenarios, getBugReplayScenario, runBugReplayScenario } = require('../utils/bug-replay-runner');

(async () => {
  const scenarios = listBugReplayScenarios();
  assert(scenarios.length >= 40, `expected expanded replay catalog, got ${scenarios.length}`);
  assert(scenarios.every((s, i) => s.index === i && s.testCount >= 1), 'scenario catalog indexes/test counts must be valid');
  assert(getBugReplayScenario('room-create'), 'room-create scenario must exist');
  assert(getBugReplayScenario('phase2-chaos'), 'phase2 chaos scenario must exist');
  assert.strictEqual(listBugReplayScenarios('phase2').length, 5, 'phase2 mode must expose exactly five staged scenarios');
  assert.strictEqual(getBugReplayScenario('does-not-exist'), null, 'unknown scenario must not resolve');

  for (const s of scenarios) {
    for (const testPath of getBugReplayScenario(s.id).tests) {
      assert(fs.existsSync(path.join(__dirname, '..', testPath)), `missing allow-listed replay test: ${testPath}`);
    }
  }

  const result = await runBugReplayScenario(getBugReplayScenario('room-create'), { timeoutMs: 10000 });
  assert.strictEqual(result.ok, true, 'runner must execute an allow-listed scenario test successfully');
  assert.strictEqual(result.steps.length, 1, 'room-create scenario should have one step');
  assert.strictEqual(result.steps[0].ok, true, 'room-create replay step should pass');

  const totalSteps = scenarios.reduce((n,s)=>n+s.testCount,0);
  assert(totalSteps >= 115, `expected expanded test depth, got ${totalSteps} steps`);
  assert(require('fs').readFileSync(path.join(__dirname, '..', 'utils', 'bug-replay-runner.js'), 'utf8').includes(`const isPython = absolute.endsWith('.py');`), 'runner must support Python browser harnesses');
  assert(require('fs').readFileSync(path.join(__dirname, '..', 'utils', 'bug-replay-runner.js'), 'utf8').includes(`const command = isPython ? 'python3' : process.execPath;`), 'runner must declare fixed Python/Node interpreters');
  assert(require('fs').readFileSync(path.join(__dirname, '..', 'utils', 'bug-replay-runner.js'), 'utf8').includes('const skipped = code === 77 || /^SKIP:/m.test(combined);'), 'runner must distinguish explicit fixture skips from failures');
  assert(require('fs').readFileSync(path.join(__dirname, '..', 'utils', 'bug-replay-runner.js'), 'utf8').includes('python3 unavailable'), 'runner must expose missing Python as an explicit skip');
  console.log(`bug-replay runner regression: PASS (${scenarios.length} scenarios, ${totalSteps} steps catalogued)`);
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
