# Werewolf Online — Bug Replay Phase 2 Verification

วันที่ตรวจ: 25 กันยายน 2026
ฐานงาน: `werewolf-online-runtime-audit-phase1-fixed-20260925.zip`

## ขอบเขตที่เพิ่ม

เฟส 2 ประกอบด้วย 4 ชั้นตามลำดับบังคับ:

1. **Chaos** — deterministic fault injection
2. **Stress** — virtual players 1 → 100
3. **Long-Run** — endurance cycles + leak trend checkpoints
4. **Recovery** — state resynchronization + final convergence

ทั้ง 4 ชั้นใช้ Runtime Audit จากเฟส 1 และ deterministic seed เพื่อให้เหตุการณ์ที่จำลองสามารถ replay ได้

## ผลการตรวจ

| ชุดตรวจ | ผล |
|---|---|
| Chaos | **24/24 cases ผ่าน** |
| Stress | **สูงสุด 100 virtual players** / 2,880 normal actions |
| Long-Run | **12,000 cycles** / 12 checkpoints / listener-timer-DOM trend เป็นศูนย์ |
| Recovery | **6/6 cases ผ่าน** |
| Phase 2 Full Suite | **PASS** |
| Bug Replay Phase 2 catalog | **5 scenarios / 6 test steps** |
| Runner-driven Phase 2 | **5/5 scenarios ผ่าน / 0 findings** |
| Existing browser Runtime Audit | **PASS** |
| Player Grid browser regression | **39 states ผ่าน** |
| Project `npm test` | **exit 0 / PASS** |

## Chaos fault catalog

- `socket.disconnect`
- `socket.delay`
- `socket.duplicate`
- `socket.reorder`
- `state.stale`
- `network.503`
- `network.timeout`
- `lifecycle.reload`
- `lifecycle.background`
- `concurrency.phase-change`

แต่ละ fault มี seed/index/id และถูกบันทึกใน Runtime Audit timeline

## Stress coverage

ระดับผู้เล่นที่ทดสอบ: `1, 2, 4, 8, 16, 32, 50, 75, 100`

ตรวจ player-state shape, action scheduling, reconnect/leave/reload transitions, duplicate-event envelope, listener count และ p50/p95/p99 ของ synthetic operation cost

> หมายเหตุ: Stress ในเฟสนี้เป็น **virtual/deterministic harness** จึงไม่ยิง connection จริงจำนวน 100 client เข้า production โดยอัตโนมัติ

## Long-Run coverage

ตรวจ checkpoint ทุก 1,000 cycles รวม 12,000 cycles และคำนวณ trend ของ resource counters

- baseline listeners: 6
- baseline timers: 4
- baseline DOM nodes: 120
- listener slope: 0
- timer slope: 0
- DOM node slope: 0

## Recovery coverage

ทดสอบ socket reconnect, HTTP 503/timeout retry, reload, background, interrupted action และ room rejoin โดยมี final server/client convergence gate

## Existing-suite compatibility

`npm test` ผ่านทั้งหมดในรอบตรวจสุดท้าย มี deployment fixture test ที่ประกาศ **SKIP** ตาม behavior เดิมของโปรเจกต์ เนื่องจากไฟล์ `.ebextensions/01-high-availability.config` และ `CLOUDFRONT-FAILOVER-SETUP.md` ไม่ได้อยู่ใน ZIP ฐาน; การ skip นี้ไม่ถือเป็น failure

## จุดเชื่อมต่อเฟส 2

Admin มี mode `phase2` แยกจาก `all`/`deep` เพื่อไม่ทำให้การรันปกติปนกับชุด Chaos/Stress/Long-Run/Recovery และ runner เก็บ `PHASE2_RESULT` แบบ structured เข้า Runtime Audit เพื่อแสดง stage result ในรายงาน
