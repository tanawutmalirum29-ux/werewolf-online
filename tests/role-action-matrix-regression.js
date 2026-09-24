'use strict';
const assert = require('assert');
const fs = require('fs');
const server = fs.readFileSync('server.js','utf8');
const actions = {
  'ลูกหมาป่า':'select_target',
  'หมาป่าผู้พิทักษ์':'select_shield',
  'หมาป่านักเวท':'select_curse_target',
  'หมาป่าหยั่งรู้':'scout_target',
  'หมอ':'select_target',
  'บอดี้การ์ด':'select_target',
  'อันธพาล':'select_target',
  'หนูน้อยผู้ใสซื่อ':'select_shield',
  'ผู้มีลาง':'scout_target',
  'ผู้หยั่งรู้':'scout_target',
  'นักสืบ':'detective_scout',
  'แม่มด':'select_target/cast_witch_poison',
  'ศาลเตี้ย':'fire_sheriff_gun',
  'นักบวช':'cast_priest_holy_water',
  'นายก':'reveal_mayor',
  'เด็กขี้โวยวาย':'select_target',
  'นักเล่นกล':'select_target/illusion_kill_disguised',
  'กามเทพ':'cupid_pair',
  'ผู้นำลัทธิ':'cult_action',
  'ผู้ยุยง':'instigator_pair/cast_instigator_kill',
  'โจร':'bandit_action/cast_bandit_kill',
};
for (const [role, handlerNames] of Object.entries(actions)) {
  for (const name of handlerNames.split('/')) assert(server.includes(`socket.on("${name}"`), `${role}: missing ${name}`);
}
for (const marker of ['performWitchPoison','performDetectiveScout','performCupidPair','performInstigatorPair','performCultAction','performBanditAction','performPriestHolyWater','performIllusionKillDisguised']) {
  assert(server.includes(`function ${marker}`), `missing implementation ${marker}`);
}
console.log(`role action matrix regression: PASS (${Object.keys(actions).length} active role families)`);
