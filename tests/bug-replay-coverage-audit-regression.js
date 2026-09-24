'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { listBugReplayScenarios, getBugReplayScenario } = require('../utils/bug-replay-runner');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const scenarioGroups = [
    { mode:'all', items:listBugReplayScenarios('all') },
    { mode:'phase2', items:listBugReplayScenarios('phase2') },
];
const scenarios = scenarioGroups[0].items;
const referenced = new Set();
for (const group of scenarioGroups) {
  for (const summary of group.items) {
    const scenario = getBugReplayScenario(summary.id);
    assert(scenario, `scenario not resolvable: ${summary.id}`);
    assert.strictEqual(summary.testCount, scenario.tests.length, `test count drift in ${summary.id}`);
    for (const testPath of scenario.tests) {
        assert(/^tests\/[A-Za-z0-9._-]+\.(?:js|py)$/.test(testPath), `non-allowlisted replay path: ${testPath}`);
        assert(fs.existsSync(path.join(root, testPath)), `missing allow-listed replay test: ${testPath}`);
        referenced.add(testPath);
    }
  }
}
const runnable = fs.readdirSync(testsDir)
    .filter((name) => /\.(?:js|py)$/.test(name))
    .map((name) => `tests/${name}`)
    .sort();
const uncovered = runnable.filter((p) => !referenced.has(p));
assert.deepStrictEqual(uncovered, [], `uncovered runnable tests: ${uncovered.join(', ')}`);
const referencedOutside = [...referenced].filter((p) => !fs.existsSync(path.join(root,p)));
assert.deepStrictEqual(referencedOutside, [], `stale replay references: ${referencedOutside.join(', ')}`);
assert(scenarios.length >= 40, `expected >=40 coverage scenarios, got ${scenarios.length}`);
assert(scenarioGroups[1].items.length === 5, `expected five Phase 2 scenarios, got ${scenarioGroups[1].items.length}`);
const totalSteps = scenarios.reduce((n,s) => n + s.testCount, 0) + scenarioGroups[1].items.reduce((n,s) => n + s.testCount, 0);
assert(totalSteps >= 120, `expected >=120 replay steps including Phase 2, got ${totalSteps}`);
assert(referenced.has('tests/player-html-grid-responsive-browser.py'), 'browser Player grid harness must be part of replay coverage');
console.log(`bug-replay coverage audit: PASS (${runnable.length} runnable test files covered by ${scenarios.length + scenarioGroups[1].items.length} scenarios / ${totalSteps} steps)`);
