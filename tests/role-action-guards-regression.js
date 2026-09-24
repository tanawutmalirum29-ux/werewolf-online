'use strict';
const assert = require('assert');
const fs = require('fs');
const server = fs.readFileSync('server.js','utf8');
function bodyOfFunction(name) {
  const needle = `function ${name}`;
  const at = server.indexOf(needle);
  assert(at >= 0, `function missing: ${name}`);
  const next = server.indexOf('\n    function ', at + needle.length);
  const socketNext = server.indexOf('\n    socket.on(', at + needle.length);
  const ends = [next, socketNext].filter(x => x > 0);
  const end = ends.length ? Math.min(...ends) : at + 12000;
  return server.slice(at,end);
}
const expected = [
  ['performSelectTarget',['if (!selector)','if (!selector.alive)','const isWolfCub','findTargetablePlayer']],
  ['performWitchPoison',['if (!room.isNight) return;','if (!witch.alive)','witch.role !== "แม่มด"','target.witchPoisonPending']],
  ['performScoutTarget',['if (!room.isNight) return;','if (!selector || !selector.alive','SCOUT_ROLES.has','findTargetablePlayer']],
  ['performDetectiveScout',['if (!room.isNight) return;','selector.role !== "นักสืบ"','findTargetablePlayer']],
  ['performCupidPair',['if (!room.isNight) return;','selector.role !== "กามเทพ"','findTargetablePlayer']],
  ['performInstigatorPair',['if (!room.isNight) return;','selector.role !== "ผู้ยุยง"','ผู้ถูกสาป']],
  ['performSelectShield',['if (room.isNight) return;','!selector.alive','GUARDIAN_ROLES.has']],
  ['performCultAction',['if (!room.isNight) return;','leader.role !== "ผู้นำลัทธิ"','member.cultLeaderId !== playerId']],
  ['performBanditAction',['if (!room.isNight) return;','leader.role !== "โจร"','aliveBanditAccomplicesOf']],
  ['performSelectCurseTarget',['if (room.isNight) return;','selector.role !== "หมาป่านักเวท"','target.isHost']],
  ['performPriestHolyWater',['if (room.isNight) return;','caster.role !== "นักบวช"','caster.priestHolyWaterPotions']],
  ['performIllusionKillDisguised',['if (room.isNight) return;','caster.role !== "นักเล่นกล"','room.voteMode']],
];
for (const [fn, guards] of expected) {
  const b=bodyOfFunction(fn);
  for (const g of guards) assert(b.includes(g), `${fn}: expected guard missing: ${g}`);
}
console.log(`role action guards regression: PASS (${expected.length} sensitive implementations)`);
