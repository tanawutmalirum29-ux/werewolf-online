# werewolf-online

## Production runtime
- Lobby / Room / Host / Player / Role cards
- Socket.IO realtime game state and chat
- Manual test bots + Host possession
- Admin: bug reports, server control, room control, versions, internal tabs, force reload
- Optional local image assets under `public/images/`
- DynamoDB room persistence when configured
- Elastic Beanstalk version listing/download/rollback from Admin

## Production package rules
This ZIP is the runtime package. Tests, replay/chaos/stress harnesses, runtime-audit tooling and developer diagnostics are intentionally excluded.

## Images are optional
`public/images/README.md` lists the asset filenames. The game must remain playable when those files are absent; missing images use graceful fallback behavior.

## Deployment
Run with `npm start`. Configure the same environment variables used by the deployment environment for Admin authentication, DynamoDB, Elastic Beanstalk, and optional GitHub bug reporting.


## Guest-first profile mode

ผู้เล่นไม่ต้องล็อกอินและไม่มี Game Account

- ไม่มี Google Login สำหรับผู้เล่น
- ไม่มี Account ID / Account Token
- ไม่มีประวัติผู้เล่น
- ไม่มีสถิติชนะ/แพ้
- ไม่มี player statistics endpoint
- โปรไฟล์เก็บเฉพาะชื่อที่ผู้เล่นตั้งเองในเครื่อง
- การกลับเข้าห้องใช้ room reconnect token ตามเดิม
- Host ยังคงสร้างและควบคุมห้องได้ตามเดิม
- Admin ยังคงใช้สำหรับรายงานบั๊ก, เซิร์ฟเวอร์, ห้อง, เวอร์ชัน และแท็บภายใน
