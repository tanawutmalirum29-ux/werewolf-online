'use strict';
const assert = require('assert');
const fs = require('fs');
const s = fs.readFileSync('server.js','utf8');
const checks=[
 ['performPriestHolyWater','if (room.isNight) return;'],
 ['performSheriffPeek','if (room.isNight) return;'],
 ['performIllusionKillDisguised','if (room.isNight) return;'],
 ['performCultAction','if (!room.isNight) return;'],
 ['performBanditAction','if (!room.isNight) return;'],
 ['performSelectCurseTarget','if (room.isNight) return;'],
];
for(const [fn,guard] of checks){ const at=s.indexOf(`function ${fn}`); assert(at>=0,`${fn} missing`); const end=s.indexOf('\n    function ',at+10); const b=s.slice(at,end>0?end:at+6000); assert(b.includes(guard),`${fn}: phase guard missing`); }
console.log(`forbidden phase regression: PASS (${checks.length} phase restrictions audited)`);
