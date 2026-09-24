'use strict';
const assert = require('assert');
const { createStressHarness, PLAYER_LEVELS, percentile } = require('../utils/stress-harness');

assert.strictEqual(percentile([1,2,3,4], 50), 2, 'percentile helper must be deterministic');
assert.deepStrictEqual(PLAYER_LEVELS, [1,2,4,8,16,32,50,75,100], 'stress levels must cover 1→100 players');

const normal = createStressHarness({ seed:'STRESS-NORMAL', workload:'normal', actionsPerPlayer:10 }).run();
assert.strictEqual(normal.allConverged, true, 'normal stress final player state must remain coherent');
assert.strictEqual(normal.maxPlayers, 100, 'stress must reach 100 virtual players');
assert.strictEqual(normal.levels.length, PLAYER_LEVELS.length, 'stress must test every configured level');
assert(normal.totalActions >= 1000, `stress depth too low: ${normal.totalActions}`);
assert(normal.levels.every((x) => x.finalPlayerCount === x.playerCount && x.invalidAlive === 0), 'each stress level must preserve player state shape');

const burst = createStressHarness({ seed:'STRESS-BURST', workload:'burst', actionsPerPlayer:22, levels:[32,50,75,100] }).run();
assert.strictEqual(burst.allConverged, true, 'burst stress must converge');
assert.strictEqual(burst.maxPlayers, 100, 'burst stress must reach 100');
assert(burst.levels.every((x) => x.p95 >= x.p50 && x.p99 >= x.p95), 'percentile ordering must be p50 <= p95 <= p99 at every level');
assert(burst.levels.every((x) => Number.isFinite(x.p50) && Number.isFinite(x.p95) && Number.isFinite(x.p99)), 'p50/p95/p99 metrics missing');

console.log(`phase2-stress-regression: PASS (${normal.maxPlayers} players max, ${normal.totalActions} normal actions)`);
console.log('PHASE2_RESULT:' + JSON.stringify({stage:'stress', maxPlayers:normal.maxPlayers, totalActions:normal.totalActions, allConverged:normal.allConverged, p99Max:normal.p99Max}));
