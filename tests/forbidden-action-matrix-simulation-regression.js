'use strict';
const assert = require('assert');
const { simulateForbiddenActionMatrix } = require('../utils/bug-replay-game-simulator');
const cases = simulateForbiddenActionMatrix();
assert(cases.length >= 10, `expected >=10 forbidden-action cases, got ${cases.length}`);
for (const item of cases) assert.strictEqual(item.allowed, false, `forbidden action escaped simulation: ${item.id}`);
console.log(`forbidden action matrix simulation regression: PASS (${cases.length} blocked cases)`);
