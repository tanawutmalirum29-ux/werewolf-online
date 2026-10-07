# Werewolf Basic

เกมแจกการ์ดและคุมห้องแบบพื้นฐาน เหลือหน้า **index / host / player** โฮสต์เป็นผู้ตัดสินเกมเอง ผู้เล่นเห็นการ์ดของตัวเอง

[เปิดหน้าติดตั้ง Render ฟรี](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Ftanawutmalirum29-ux%2Fwerewolf-online%2Ftree%2Fmain)

## ทำอะไรได้บ้าง

- โฮสต์สร้างห้อง แล้วส่งรหัส 5 ตัวหรือลิงก์ให้เพื่อน
- ผู้เล่นตั้งชื่อและเข้าห้อง ไม่ต้องสมัครบัญชี
- โฮสต์เลือกจำนวนบทบาทด้วย + / − การ์ดที่ขาดเติมชาวบ้านให้อัตโนมัติ
- สุ่มแจกการ์ด ผู้เล่นเห็นเฉพาะการ์ดของตัวเองจนจบเกม
- โฮสต์เห็นทุกบทบาท มีสวิตช์ซ่อนบทบาทบนจอ
- โฮสต์กำหนดมีชีวิต/เสียชีวิต ป้องกัน และถูกเล็งเอง เปลี่ยนการ์ดให้ผู้เล่นได้ระหว่างเกม
- โฮสต์เปลี่ยนกลางวัน/กลางคืน ประกาศผลจบเกม เปิดเผยการ์ด และกลับห้องรอเพื่อเล่นรอบใหม่
- นำผู้เล่นออกหรือปิดห้องได้ โฮสต์ไม่นับเป็นผู้เล่นและไม่ได้รับการ์ด
- มีคำอธิบายการ์ดเดิม 30 บทบาทและรูปเดิม โดยใช้กติกาที่โฮสต์ประกาศ

**ความสามารถและการโหวตเป็นการเล่นกันเอง** พูดคุยหรือโทรกันนอกเว็บแล้วแจ้งโฮสต์ เว็บไม่มีการใช้พลัง ฆ่า โหวต หาผู้ชนะ หรือส่งแชตอัตโนมัติ เครื่องหมาย “ป้องกัน” / “ถูกเล็ง” ช่วยโฮสต์จำ ไม่เปลี่ยนสถานะมีชีวิตเอง

## ตัดออกแล้ว

ไม่มี Admin, DB/DynamoDB, AWS SDK, S3, Elastic Beanstalk, GitHub bug reporting, บัญชีผู้เล่น, ประวัติ, ห้องทดลอง/bot, ระบบสำรอง, snapshot, lease หรือกู้ห้องหลังเซิร์ฟเวอร์พัง

ข้อมูลห้องอยู่ใน RAM เท่านั้น เซิร์ฟเวอร์พัก/รีสตาร์ต/อัปเดต = ห้องหาย ต้องสร้างใหม่ ไม่มีการเขียนข้อมูลเกมลงดิสก์ โทเคนใน sessionStorage มีไว้ระบุเจ้าของห้องหรือผู้เล่นระหว่างรีเฟรช/เน็ตหลุดขณะที่เซิร์ฟเวอร์เดิมยังทำงาน ไม่ใช่ระบบกู้ข้อมูลเซิร์ฟเวอร์

## Deploy ฟรีจาก GitHub

**ใช้ GitHub เก็บโค้ด แล้วให้ Render Free รันเกม** GitHub Pages รัน Node.js/Socket.IO server นี้ไม่ได้ เพราะเป็น static hosting

### วิธีที่ 1: ใช้ปุ่มติดตั้ง

1. เปิดลิงก์ **เปิดหน้าติดตั้ง Render ฟรี** ด้านบน
2. ล็อกอินหรือสมัคร Render และอนุญาตเข้าถึง GitHub repo นี้หากระบบถาม
3. ตรวจว่า Blueprint มี **Web Service เพียงหนึ่งตัว** ชื่อ `werewolf-basic` และ Plan เป็น **Free** ไม่มี database, disk หรือบริการเสริม
4. เลือกสร้าง Blueprint / Deploy รอ build เสร็จ
5. เปิด URL `https://…onrender.com` ที่ Render แสดง โฮสต์และผู้เล่นใช้ URL เดียวกัน

ใช้ branch `main` เพียงอันเดียวสำหรับแก้โค้ดและ deploy ชุดเกมพื้นฐานอยู่ใน `main` แล้ว หากเคยสร้างบริการ Render จาก branch เก่า ให้เปลี่ยน Settings → Branch เป็น `main` แล้ว deploy อีกครั้ง

### วิธีที่ 2: เลือกค่าผ่านหน้าเว็บ Render

เปิด https://dashboard.render.com/ → **New → Web Service → Git Provider → GitHub** แล้วเลือก repo `tanawutmalirum29-ux/werewolf-online`

| ช่อง | ค่า |
| --- | --- |
| Name | `werewolf-basic` |
| Branch | `main` |
| Region | Singapore |
| Language / Runtime | Node |
| Root Directory | เว้นว่าง |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Environment | `NODE_ENV=production` |
| Health Check Path (ถ้ามีช่อง) | `/health` |
| Auto-Deploy | On Commit |

แล้วเลือก **Deploy Web Service** ไม่ต้องใส่ secret, database URL, AWS key หรือรหัส Admin เซิร์ฟเวอร์รับ `PORT` ที่ Render กำหนดให้อัตโนมัติ

### ข้อจำกัดของฟรี

ตรวจเอกสาร Render วันที่ 7 ต.ค. 2026:

- ไม่มี HTTP request หรือ WebSocket message เข้า 15 นาที → service พัก เปิดใหม่อาจรอประมาณหนึ่งนาที
- server อาจ restart ได้ และการ push/auto-deploy ทำให้ห้องใน RAM หาย อัปเดตตอนห้องว่าง
- workspace ได้ 750 free instance hours ต่อเดือน แชร์กับ web services ฟรีอื่นใน workspace
- bandwidth และ build minutes มีโควตา ตรวจ Monthly Included Usage ใน dashboard
- หากไม่เพิ่มวิธีชำระเงิน เมื่อเกินบางโควตาระบบจะพักบริการ/หยุด build; หากผูกวิธีชำระเงินอาจมีค่าการใช้งานเกินโควตา จึงตรวจ billing ก่อนใช้
- เหมาะกับกลุ่มเล่นเล็ก/งานทดลอง ไม่รับรองรองรับผู้เล่นจำนวนมากโดยไม่ทดสอบโหลด จำกัดในโค้ดไว้สูงสุด 40 คนต่อห้อง และ 100 ห้องต่อ process ไม่ใช่การรับประกัน capacity ของ Free

ไม่มีการเพิ่ม ping service ภายนอกหรือระบบกันพักฟรี

## Deploy หน้าเว็บบน AWS Amplify จาก GitHub

รองรับ **Amplify Hosting สำหรับหน้า index / host / player** แล้ว โดยมีเซิร์ฟเวอร์เกม Node.js หนึ่งตัวรันแยกอยู่ที่ Render หรือบริการที่รองรับ Socket.IO อยู่ก่อน หน้าเว็บและรูปอยู่บน Amplify ส่วนข้อมูลห้องอยู่ใน RAM ของเซิร์ฟเวอร์เกมเดิม ไม่มี DB, Cognito, AppSync, Lambda หรือระบบสำรองเพิ่ม

**Amplify อย่างเดียวไม่ใช่ตัวเลือกสำหรับเกมรุ่นนี้** แม้ Amplify Compute รัน Express ได้ แต่ execution instance มีเวลาทำงานสูงสุด 15 นาทีและแยกกัน โค้ดที่เก็บห้องใน Map ของ process เดียวจึงไม่เหมาะกับการนำไปรันตรง ๆ หากต้องการบริการเดียวและตั้งค่าน้อยที่สุด ให้ใช้ Render ตามขั้นตอนด้านบน

### ตั้งค่า

1. Deploy เซิร์ฟเวอร์เกมบน Render จาก `main` ตามขั้นตอนด้านบนก่อน จด URL HTTPS เช่น `https://your-game.onrender.com` เปิด `/health` แล้วต้องได้ `{"ok":true}`
2. เปิด AWS Amplify Console ใน region ที่ต้องการ เช่น Sydney (`ap-southeast-2`) → สร้างแอปใหม่ → เลือก GitHub → repo `tanawutmalirum29-ux/werewolf-online` → branch **main**
3. ใช้ build settings จาก `amplify.yml` ใน repo ไม่ใช้ SSR หรือสร้าง Amplify backend; Root directory เว้นว่าง ชุด build เป็น static frontend
4. ตั้ง environment variable **GAME_SERVER_URL** เป็น URL HTTPS ของเซิร์ฟเวอร์เกม เช่น `https://your-game.onrender.com` โดยไม่ใส่ `/api`, `/socket.io`, path อื่น, query หรือ credentials ค่านี้เปิดเผยใน frontend ได้ ไม่ใช่ secret
5. หากต้องกรอก build เอง: `npm ci --omit=dev && npm run build:amplify` และ output directory **dist** (Node.js 24) แล้ว deploy
6. จดโดเมนหน้าเว็บที่ Amplify ให้ เช่น `https://main.APPID.amplifyapp.com` จากนั้นเพิ่ม environment variable **ALLOWED_ORIGINS** ที่บริการ Render เป็น origin นี้ ต้องไม่มี path หรือ slash ท้าย ตัวอย่างนี้เป็น placeholder ให้ใช้ URL จริงจาก console
7. Render จะ restart เมื่อเปลี่ยน environment ห้องเก่าจะหาย แล้วเปิดหน้า Amplify สร้างห้องและให้ผู้เล่นเข้าจากลิงก์ของหน้า Amplify เดียวกัน

ถ้าใช้ custom domain ให้เพิ่ม origin ใหม่ใน `ALLOWED_ORIGINS` ด้วย แยกหลาย origin ด้วย comma เช่น `https://main.APPID.amplifyapp.com,https://game.example.com` ไม่ใช้ `*` และไม่จำเป็นต้องเปิด CORS ให้ทุกเว็บ URL frontend และเซิร์ฟเวอร์ต้องเป็น HTTPS

Push `main` แล้วแต่ละบริการจะ deploy ตามการตั้งค่า auto-deploy ของตน; อย่า deploy ระหว่างเล่น เพราะเมื่อเซิร์ฟเวอร์เกม restart ห้องจะหาย การแก้ `GAME_SERVER_URL` ต้อง rebuild หน้า Amplify อีกครั้ง ไม่มีการเขียนข้อมูลห้องไว้ที่ Amplify

### ค่าใช้จ่ายและการตรวจสอบ

Amplify **ไม่ใช่ฟรีถาวร** ค่า build, storage และ bandwidth ขึ้นกับโควตา/เครดิต AWS Free Tier และแผนบัญชีของคุณ ตรวจหน้า Billing และ Amplify Pricing ก่อน deploy โดยเฉพาะบัญชีเก่าหรือ paid plan; โค้ดนี้ไม่ได้สร้างทรัพยากร AWS ให้เอง

- Build ล้มเหลวเพราะ `GAME_SERVER_URL` → ตั้ง URL ของเซิร์ฟเวอร์เกมจริงก่อน แล้ว rebuild
- หน้าเปิดได้แต่บทบาทไม่โหลด/เชื่อมต่อไม่ได้ → ตรวจ `/health` ของเซิร์ฟเวอร์, รอ Render ตื่น และตรวจ `ALLOWED_ORIGINS` ให้ตรงกับ origin ของหน้าเว็บ
- อย่าเพิ่ม rewrite ทุก path ไป `index.html`; `host.html`, `player.html`, รูปและ JavaScript ต้องถูกเสิร์ฟเป็นไฟล์ของตัวเอง Socket.IO เชื่อมไปเซิร์ฟเวอร์เกมโดยตรง ไม่ผ่าน Amplify proxy
- ทดสอบสองอุปกรณ์: โฮสต์สร้างห้อง → ผู้เล่นเข้าห้อง → แจกการ์ด → ผู้เล่นเห็นเฉพาะของตัวเอง → โฮสต์เปลี่ยนสถานะและจบเกม

เอกสาร AWS: https://docs.aws.amazon.com/amplify/latest/userguide/ssr-deployment-specification.html และ https://aws.amazon.com/amplify/pricing/

## เริ่มเล่น

1. คนคุมเกมเปิดหน้าโฮสต์และสร้างห้อง
2. คัดลอกลิงก์หรือรหัสให้ผู้เล่นเข้า อย่าส่งลิงก์แท็บโฮสต์หรือโทเคนส่วนตัว
3. ตรวจว่าผู้เล่นออนไลน์ครบ นำรายชื่อคนที่เลิกเล่นออกก่อนแจก
4. ตั้งจำนวนบทบาทแล้วสุ่มแจก ถ้าจำนวนการ์ดมากกว่าคนระบบจะไม่แจก
5. ผู้เล่นกดเปิดดูการ์ด กดซ่อนก่อนให้คนอื่นดูจอ และเมื่อสลับแอปหน้าเว็บจะซ่อนการ์ดให้
6. เล่น/โหวต/แจ้งใช้ความสามารถกับโฮสต์ โฮสต์ทำเครื่องหมายและกำหนดคนที่ตายเอง
7. โฮสต์กดจบเกมเพื่อเปิดเผยทุกบทบาท หรือกลับห้องรอเพื่อล้างการ์ดแล้วเริ่มใหม่

ก่อนจบเกม ผู้เล่นจะเห็นเฉพาะชื่อและสถานะมีชีวิตของคนอื่น โฮสต์เปลี่ยนการ์ดให้ผู้เล่นได้ เช่น ผู้ถูกสาปกลายเป็นหมาป่า แต่โฮสต์ต้องติดตามเงื่อนไขการใช้พลังและฝ่ายที่ชนะเองทั้งหมด

## รันในเครื่อง

ใช้ Node.js 24:

```bash
npm ci
npm start
```

เปิด http://localhost:3000 ใช้เพียง Express และ Socket.IO ใน production ไม่ต้องตั้ง environment เพิ่ม

## ตรวจสอบ

```bash
npm test
```

ทดสอบจำนวนการ์ดและการเติมชาวบ้าน, ข้อมูลการ์ดส่วนตัว, สิทธิ์โฮสต์แยกห้อง, การกลับเข้าห้องเมื่อเน็ตหลุด, การเปลี่ยนสถานะ/จบรอบ, การนำออก/ปิดห้อง, WebSocket และ HTTP polling และยืนยันว่า Admin endpoints เดิมไม่อยู่แล้ว

## โครงสร้าง

```text
server.js          HTTP + Socket.IO ห้องใน RAM
lib/game.js        จำนวนบทบาท แจกการ์ด และข้อมูลที่แต่ละคนเห็น
roles.json         การ์ด 30 บทบาท
public/index.html  เลือกโฮสต์หรือผู้เล่น
public/host.html   โฮสต์คุมห้อง
public/player.html การ์ดของผู้เล่น
public/js/app.js   UI ของโฮสต์และผู้เล่น
public/style.css   หน้าตาและมือถือ
public/images/     รูปการ์ดเดิม
render.yaml        Web Service ฟรีหนึ่งตัว
amplify.yml        Build หน้าเว็บ static สำหรับ Amplify
scripts/build-amplify.js  สร้าง dist และตั้ง URL เซิร์ฟเวอร์เกม
public/js/config.js       ค่า same-origin สำหรับรันแบบบริการเดียว
```

อ้างอิง:
- https://render.com/docs/free
- https://render.com/docs/websocket
- https://render.com/docs/web-services
- https://render.com/docs/blueprint-spec
- https://render.com/docs/deploy-to-render
- https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
