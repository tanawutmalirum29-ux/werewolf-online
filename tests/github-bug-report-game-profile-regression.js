const assert = require('assert');
const { buildGithubBugReportIssue } = require('../utils/github-bug-reports');

const report = buildGithubBugReportIssue({
  event:{ id:'err-profile', time:'2026-09-28T00:00:00.000Z', source:'client', kind:'error', page:'player', message:'Role action failed', featureKeys:['roles','night_actions'], featureLabels:['Role Registry','คำสั่งกลางคืน'], gameProfileSnapshot:{
    profileVersion:1, appVersion:'v3-999', sourceHash:'source-1234', featureSetHash:'feature-5678', roleCount:30, rolesByTeam:{wolf:['หมาป่า','หมาป่านักเวท'], villager:['ชาวบ้าน','หมอ']}, winConditions:['wolf','villager'], implementedFeatureKeys:['roles','night_actions','reveal_dead_role'], implementedFeatureLabels:['Role Registry','คำสั่งกลางคืน','Reveal Dead Role'], replay:{scenarioCount:44}, taxonomy:{version:5}
  }},
  analysis:{causeCode:'TEST', failureStage:'runtime', rootCauseSource:'client', confidence:'high', rootCause:'test', nextStep:'test'},
  serverInfo:{appVersion:'v3-999',node:'v24'},
});
assert.ok(report.body.includes('## Game / Feature snapshot'));
assert.ok(report.body.includes('v3-999'));
assert.ok(report.body.includes('feature-5678'));
assert.ok(report.body.includes('Role count:** 30'));
assert.ok(report.body.includes('Reveal Dead Role'));
assert.ok(report.body.includes('Replay scenario count:** 44'));
assert.ok(report.body.includes('Roles by team'));
console.log('github-bug-report-game-profile-regression: PASS');
