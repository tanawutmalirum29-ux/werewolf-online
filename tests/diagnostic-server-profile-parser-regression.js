const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const taxonomy = require('../utils/diagnostic-feature-taxonomy');
const { listBugReplayScenarios } = require('../utils/bug-replay-runner');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function extractFunction(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `missing ${name}`);
  return source.slice(start, end);
}
const sandbox = {};
vm.runInNewContext(`this.parseRoles=${extractFunction('parseStaticRoleRegistryForDiagnostics','parseStaticMapForDiagnostics')}\nthis.parseMap=${extractFunction('parseStaticMapForDiagnostics','parseStaticWinConditionsForDiagnostics')}\nthis.parseWins=${extractFunction('parseStaticWinConditionsForDiagnostics','getDiagnosticSourceSnapshot')}`, sandbox);

const roles = sandbox.parseRoles(source);
const teams = sandbox.parseMap(source, 'teamLabels');
const wins = sandbox.parseWins(source);
assert.strictEqual(Object.keys(roles).length, 30, `current role registry should contain 30 roles, found ${Object.keys(roles).length}`);
assert.strictEqual(Object.keys(teams).length, 8, `current team labels should contain 8 teams, found ${Object.keys(teams).length}`);
assert.deepStrictEqual(Array.from(wins), ['fool','headhunter','wolf','murderer','illusionist','villager','lovers','instigators']);

const all = listBugReplayScenarios('all');
const phase2 = listBugReplayScenarios('phase2');
const profile = taxonomy.buildGameDiagnosticProfile({
  source,
  appVersion:'v-profile-test',
  roles,
  teamLabels:teams,
  winConditions:wins,
  roomSettings:['hostPassword','joinCode','maxPlayers','revealDeadRole','stateVersion'],
  capabilities:{ resetStateFanout:true, screenshotNoPreview:true, screenshotMultiSize:true, screenshotCurrentViewport:true, githubDedupe:true },
  replayScenarios:[...all,...phase2],
});
for (const key of ['roles','role_catalog','reveal_dead_role','screenshot_no_preview','screenshot_multisize','github_dedupe','reset_state']) {
  assert.ok(profile.currentMechanics.implementedKeys.includes(key), `profile missing implemented feature ${key}`);
}
assert.strictEqual(profile.roleCount,30);
assert.strictEqual(profile.replay.scenarioCount, all.length + phase2.length);
assert.ok(profile.featureSetHash && profile.featureSetHash.length >= 16);
console.log('diagnostic-server-profile-parser-regression: PASS');
