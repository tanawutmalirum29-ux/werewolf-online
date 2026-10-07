# สรุปการแก้บั๊ก (รอบตรวจโค้ด)

## แก้แล้ว
1. `server.js` เคลียร์ timer `pendingIndicators` ผิดวิธี (`.timer`) 4 จุด → `clearTimeout(pendingIndicators[token])`
2. รายชื่อห้อง (`getOpenRoomsList*`) ไม่แสดงห้องที่กำลังปิด/หมดอายุแล้ว (`isRoomListable`)
3. `host.main.js` โฮสต์ลองกลับห้องวนไม่จบ → จำกัด 8 ครั้ง, ล้างสถานะ busy ตอน connect/disconnect (`hostRecoverySeq`)
4. heartbeat ห้องว่างเพิ่ม `stateVersion` ทุก 30 วินาที ทำให้ action ที่ส่งมาพอดีโดน `STALE_STATE` → ยอมรับเวอร์ชันที่ต่างเพราะ heartbeat อย่างเดียว
5. **ข้อมูลลับรั่วใน `room_update`** (บท, token, สถานะความสามารถของผู้เล่นคนอื่น, แชทลับระดับห้อง, token ผู้ชนะ)
   - ใหม่: `utils/room-view.js` ซ่อนข้อมูลแยกตามผู้ดู ใช้ผ่าน `roomViewForSocket` / `emitRoomUpdateToRoom` ใน `server.js`
   - โฮสต์เห็นครบเหมือนเดิม ผู้เล่นเห็นเฉพาะของตัวเอง ทีมหมาป่า กลุ่มโจร/ลัทธิ ผลส่อง บทที่เปิดเผยสาธารณะ และทุกบทเมื่อจบเกม
   - `player.main.js` ใช้ `roleCounts` (จำนวนบทที่มีในเกม) และ `pubKey` (ตรวจผู้ชนะ) แทน `role`/`token` ของคนอื่น
   - ย้อนกลับฉุกเฉิน: ตั้ง env `WW_REDACT_ROOM_VIEW=0`
6. `package.json` เพิ่ม `npm test`

## ทดสอบ
`npm test` (25 กรณี) ยังไม่ได้ทดสอบในเบราว์เซอร์/มือถือ/DynamoDB จริง ควรไล่เล่นหนึ่งรอบก่อน deploy
