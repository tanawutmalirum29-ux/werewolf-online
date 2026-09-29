const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public/js/host.main.js'), 'utf8');
for (const key of ['quick:', 'classic:', '"classic-plus":', 'chaos:']) {
  if (!src.includes(key)) throw new Error(`missing preset ${key}`);
}
for (const role of ['หมาป่า', 'ผู้หยั่งรู้', 'หมอ', 'แม่มด', 'บอดี้การ์ด', 'นักสืบ']) {
  if (!src.includes(`"${role}"`)) throw new Error(`missing preset role ${role}`);
}
if (!src.includes('activeHostPreset = "custom"')) throw new Error('custom preset state missing');
if (!src.includes('setHostPresetCustom();')) throw new Error('manual role edit must invalidate preset state');
if (!src.includes('target - Object.values(config).reduce')) throw new Error('preset must cap role total to target player count');
console.log('PASS host-preset-regression');
