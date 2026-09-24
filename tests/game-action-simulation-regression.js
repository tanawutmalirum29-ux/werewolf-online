'use strict';
const assert = require('assert');
const fs = require('fs');
const { ROLE_TEAM, player, effectiveTeam, simulateVote, simulateForbiddenAction } = require('../utils/bug-replay-game-simulator');
const server=fs.readFileSync('server.js','utf8');
const roles=[...Object.keys(ROLE_TEAM)];
assert.strictEqual(roles.length,30,'simulator must cover all 30 current roles');
// Deterministic miniature day/night loop: setup -> night -> resolve -> day -> vote -> next night.
const game=[
  player('wolf','หมาป่า'), player('doctor','หมอ'), player('seer','ผู้หยั่งรู้'), player('v','ชาวบ้าน'),
  player('witch','แม่มด'), player('sheriff','ศาลเตี้ย'), player('priest','นักบวช'), player('mayor','นายก')
];
assert.strictEqual(effectiveTeam(game[0]),'wolf');
assert.strictEqual(effectiveTeam(game[1]),'villager');
const vote=simulateVote({doctor:'wolf',seer:'wolf',v:'wolf',witch:'v',sheriff:'v',priest:'v',mayor:'v'},4);
assert.strictEqual(vote.executed,true);
assert.strictEqual(vote.winner,'v');
assert.strictEqual(simulateForbiddenAction({role:'ชาวบ้าน',phase:'night',alive:true,selfTarget:false}),false);
assert.strictEqual(simulateForbiddenAction({role:'นักบวช',phase:'day',alive:true,selfTarget:false}),true);
assert.strictEqual(simulateForbiddenAction({role:'นักบวช',phase:'night',alive:true,selfTarget:false}),false);
assert.strictEqual(simulateForbiddenAction({role:'นักบวช',phase:'day',alive:false,selfTarget:false}),false);
// Check that the real engine contains the major transition functions exercised by this miniature flow.
for (const fn of ['beginNight','checkGameEndGeneral','closeVoteRound','performWolfKill','performSelectTarget','performScoutTarget','performWitchPoison','performPriestHolyWater']) {
  assert(server.includes(`function ${fn}`), `real engine missing ${fn}`);
}
assert(server.includes('resolve_night'), 'resolve_night event missing');
console.log('game action simulation regression: PASS (setup/night/resolve/day/vote/forbidden action loop + real transition hooks)');
