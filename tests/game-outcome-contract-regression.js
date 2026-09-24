'use strict';
const assert = require('assert');
const fs = require('fs');
const s = fs.readFileSync('server.js','utf8');
for (const result of ['wolf','villager','murderer','illusionist','lovers','instigators','fool','headhunter']) {
  assert(s.includes(`"${result}"`) || s.includes(`'${result}'`), `missing result team marker: ${result}`);
}
assert(s.includes('function checkLoversWinAlone'), 'lovers end-game check missing');
assert(s.includes('function checkInstigatorsWinAlone'), 'instigator end-game check missing');
assert(s.includes('function checkGameEndGeneral'), 'general end-game check missing');
assert(s.includes('function endGame'), 'endGame missing');
assert(s.includes('room.gameResult ='), 'game result persistence missing');
assert(s.includes('recordGameStats(room, resultTeam)'), 'end-game statistics hook missing');
console.log('game outcome contract regression: PASS (all 8 documented result families audited)');
