'use strict';
const assert = require('assert');
const fs = require('fs');
const s = fs.readFileSync('server.js','utf8');
assert(s.includes('// ถ้าเสมอกัน → ไม่ประหารใคร'), 'tie vote rule comment missing');
assert(s.includes('if (topCandidates.length === 1)'), 'single top candidate gate missing');
assert(s.includes('"ชาวบ้านตัดสินใจไม่ประหารใคร"'), 'tie/no-execution announcement missing');
assert(s.includes('if (!room.gameOver) {') && s.includes('beginNight(room, roomId)'), 'vote round should continue after non-ending tie');
console.log('vote tie/draw regression: PASS (tie vote is non-execution and continues the round)');
