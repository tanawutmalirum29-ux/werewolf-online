'use strict';
const assert = require('assert');
const fs = require('fs');
const { listBugReplayScenarios } = require('../utils/bug-replay-runner');
const { ROLE_TEAM, OUTCOMES, scenarioOutcomes, simulateRoomSecurityMatrix, simulateForbiddenActionMatrix } = require('../utils/bug-replay-game-simulator');
const server=fs.readFileSync('server.js','utf8');
const scenarios=listBugReplayScenarios();
assert(scenarios.length >= 30, `expected >=30 replay scenarios, got ${scenarios.length}`);
const steps=scenarios.reduce((n,s)=>n+s.testCount,0);
assert(steps >= 80, `expected >=80 replay test steps, got ${steps}`);
assert.strictEqual(Object.keys(ROLE_TEAM).length,30,'role model must cover 30 roles');
assert.strictEqual(OUTCOMES.length,8,'outcome model must cover 8 result teams');
const outcomes = scenarioOutcomes();
for (const key of ['wolf','villager','murderer','illusionist','lovers','instigators','fool','headhunter']) assert(outcomes[key]?.result || outcomes[key] === key || outcomes[key] === 'wolf' || outcomes[key] === 'villager' || outcomes[key] === 'murderer' || outcomes[key] === 'illusionist' || outcomes[key] === 'lovers' || outcomes[key] === 'instigators', `missing simulated outcome fixture: ${key}`);
assert.strictEqual(outcomes.tie.draw, true, 'vote tie must be simulated as draw/no-execution');
const roomMatrix = simulateRoomSecurityMatrix();
assert(Object.values(roomMatrix).every(Boolean), 'room security simulation matrix must fully pass');
assert(simulateForbiddenActionMatrix().every((x) => x.allowed === false), 'forbidden action simulation must block every listed invalid action');
for(const id of ['room-security','role-catalog','role-wolf','role-villager','role-solo','role-pairs','role-cult-bandit','vote-draw','game-outcomes','forbidden-actions','private-secrets','security-cross-room']){
  assert(scenarios.some(x=>x.id===id),`missing coverage scenario: ${id}`);
}
assert(scenarios.find((x) => x.id === 'room-security')?.testCount >= 4, 'room-security scenario must include room state-machine simulation');
assert(scenarios.find((x) => x.id === 'forbidden-actions')?.testCount >= 4, 'forbidden-actions scenario must include matrix simulation');
for(const evt of ['create_room','join_room','start_game','start_night','resolve_night','cast_vote','send_chat','restart_room','close_room']){
  assert(server.includes(`socket.on("${evt}"`),`core event missing from source: ${evt}`);
}
console.log(`bug-replay comprehensive regression: PASS (${scenarios.length} scenarios, ${steps} steps, 30 roles, 8 outcomes)`);
