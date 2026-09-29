const fs=require('fs');
const assert=require('assert');
const html=fs.readFileSync('public/admin.html','utf8');
const css=fs.readFileSync('public/css/admin-phase2.css','utf8');

assert(html.includes('data-admin-panel="tools" id="tab-tools"'),'Operations tab missing');
assert(html.includes('class="ops-grid"'),'Operations must use compact grid layout');
assert(html.includes('id="adminOperationsHeaderTools"'),'Operations header navigation missing');
assert(html.includes('ops-header-section-jump'),'Operations header section navigation missing');
assert(html.includes('id="phase2ServerCard"'),'Server card missing');
assert(html.includes('id="phase2UpdateCard"'),'Update card missing');
assert(html.includes('id="phase2TesterCard"'),'Tester update card missing');
assert(!html.includes('id="phase2DevCard"'),'obsolete System card must be removed');
assert(html.includes('id="phase2DangerCard"'),'Danger card missing');
const opsHtml = html.slice(html.indexOf('data-admin-panel="tools"'), html.indexOf('data-admin-panel="versions"'));
for(const phrase of [
  'ข้อมูลรุ่นของ Admin และ Shell',
  'Admin release',
  'UI shell',
  'Control Center v2',
  'รายละเอียด',
  'งานประจำวันอยู่ด้านบน งานสำหรับนักพัฒนาอยู่ท้าย',
  'สั่งให้ทุกเครื่องที่เปิดเกมอยู่โหลดใหม่แล้วกลับ <b>หน้าแรก</b>',
  'สิทธิ์นี้ตัดสินจากบัตรผ่านที่ server ออกให้เท่านั้น',
  'ข้อมูลสำหรับตรวจรุ่นหน้า Admin และเครื่องมือช่วยส่งคำสั่งแก้ไข'
]) assert(!opsHtml.includes(phrase),`legacy verbose Operations copy remains: ${phrase}`);
assert(css.includes('#tab-tools .ops-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));'),'Operations grid contract missing');
assert(css.includes('#tab-tools .ops-card{min-width:0;'),'Operations cards must remain shrinkable');
assert(css.includes('#tab-tools .ops-card-body{display:flex;flex-direction:column;gap:9px;min-width:0;}'),'Operations card bodies must stay compact and shrinkable');
assert(!css.includes('#tab-tools .ops-more'),'Operations expandable detail styling must be removed');
console.log('admin-operations-ui: PASS');
