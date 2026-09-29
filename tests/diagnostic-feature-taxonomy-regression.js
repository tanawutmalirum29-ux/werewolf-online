const assert = require('assert');
const fs = require('fs');
const path = require('path');
const taxonomy = require('../utils/diagnostic-feature-taxonomy');
const { listBugReplayScenarios } = require('../utils/bug-replay-runner');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const roleMatches = serverSource.match(/"[^"]+"\s*:\s*\{\s*team:\s*"[^"]+"\s*,\s*score:\s*-?\d+/g) || [];
assert.strictEqual(taxonomy.DIAGNOSTIC_FEATURE_TAXONOMY_VERSION, 5);
assert.ok(roleMatches.length >= 30, `expected current role registry, found ${roleMatches.length}`);

const scenarios = listBugReplayScenarios('all');
assert.ok(scenarios.length >= 44, 'scenario catalog should include current scenarios');
for (const scenario of scenarios) {
  assert.ok(Array.isArray(scenario.featureKeys) && scenario.featureKeys.length > 0, `missing features for ${scenario.id}`);
  assert.ok(scenario.featureKeys.every((key) => !key.includes('-')), `non-canonical feature key in ${scenario.id}`);
  assert.strictEqual(scenario.featureLabels.length, scenario.featureKeys.slice(0,14).length);
}
assert.deepStrictEqual(taxonomy.normalizeDiagnosticFeatureKeys(['runtime-actions','room-recovery','external_assets']), ['assets','room_recovery','runtime']);
assert.deepStrictEqual(taxonomy.normalizeDiagnosticFeatureKeys(['screenshotNoPreview','resetStateFanout']), ['reset_state_fanout','screenshot_no_preview']);
console.log('diagnostic-feature-taxonomy-regression: PASS');
