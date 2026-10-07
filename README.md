# Werewolf Basic — GitHub → AWS Amplify + AppSync

เกมพื้นฐาน 3 หน้า **index / host / player**: โฮสต์เลือกจำนวนบทบาท สุ่มแจกการ์ด คุมกลางวัน/กลางคืน กำหนดคนตายและประกาศจบเกม ผู้เล่นเห็นเฉพาะการ์ดของตัวเองก่อนจบเกม พูดคุย โหวต และใช้พลังโดยแจ้งโฮสต์กันเอง ไม่มี Admin หรือบัญชีผู้เล่น

**ไม่ต้องใช้ Render หรือเซิร์ฟเวอร์ Node แยกสำหรับ AWS รุ่นนี้** Amplify Hosting เสิร์ฟหน้าเว็บและรูป ส่วน **AWS AppSync Event API หนึ่งตัว** ส่งข้อความสดระหว่างอุปกรณ์ ห้องและการ์ดอยู่ใน RAM ของหน้าโฮสต์ ไม่มี DB, DynamoDB, Cognito, Lambda, Elastic Beanstalk, snapshot, ประวัติหรือระบบกู้ห้อง

ใช้ GitHub branch **main** เพียงอันเดียว ไม่ต้องสร้าง branch ใหม่

## สิ่งที่แก้จากรุ่นที่ build ล้มเหลว

- ไม่บังคับ `GAME_SERVER_URL` อีกแล้ว และไม่ใช้ URL Render
- `amplify.yml` ใช้ Node.js 24 และ `npm run build:amplify` → output **dist**
- build หน้าเว็บไม่ต้องติดตั้ง dependencies ไม่พยายามรัน `server.js` บน Amplify
- ถ้ายังไม่ตั้ง AppSync: build ผ่านเป็นหน้าแจ้ง “ยังไม่พร้อมเล่น” ปุ่มสร้าง/เข้าห้องยังใช้ไม่ได้ เพื่อให้ตั้งค่าตามขั้นตอนด้านล่างก่อน
- ถ้าตั้งตัวแปร AppSync เพียงบางตัวหรือใส่ endpoint ผิด: build แจ้งข้อผิดพลาดเพื่อไม่ deploy เว็บที่ตั้งค่าเสีย

**Build ผ่านไม่เท่ากับเกมพร้อมเล่น** ต้องสร้าง AppSync ตั้งค่าครบ และทดสอบโฮสต์กับผู้เล่นด้วย

## ขั้นตอนที่ต้องทำใน AWS

### 1. สร้าง AppSync Event API ครั้งเดียว

1. ล็อกอิน AWS Console เลือก region **Asia Pacific (Sydney) / ap-southeast-2** ให้เหมือน Amplify ที่ใช้อยู่
2. เปิดบริการ **AWS AppSync** → **Create API** → เลือก **Event API** (ไม่ใช่ GraphQL API)
3. ตั้งชื่อ เช่น `werewolf-basic-events` แล้ว Create
4. ตรวจ Authentication ว่า **API_KEY** ใช้กับทั้ง **Connect / Publish / Subscribe** ตามค่าเริ่มต้นของ Event API
5. ตรวจว่ามี Channel namespace ชื่อ **default** ซึ่ง AWS สร้างให้ตามค่าเริ่มต้น หากไม่มี ให้สร้าง namespace ชื่อนี้ ใช้สิทธิ์ API key ตาม API ไม่เพิ่ม data source หรือ integration
6. ไปหน้า Settings ของ API จด **HTTP endpoint** และ **Realtime/WebSocket endpoint** และไป Authentication/API keys คัดลอก API key ที่ยังไม่หมดอายุ

ใช้ **AppSync API key** ที่ขึ้นต้น `da2-` เท่านั้น ไม่ใช่ IAM access key, secret access key หรือรหัสผ่าน AWS ค่า AppSync key ในเกมนี้ต้องอยู่ใน frontend เพื่อให้เล่นได้โดยไม่สมัครบัญชี จึงมองเห็นได้จากเว็บ; ไม่ใช่รหัสลับของโฮสต์หรือผู้เล่น อย่าใช้ key ร่วมกับ API ของงานอื่น

ไม่มีขั้นตอนสร้างฐานข้อมูลหรือ deploy backend ผ่าน Amplify Gen 2 ไม่ต้องเพิ่ม backend deployment role ให้ Amplify สำหรับโค้ดชุดนี้ AppSync เป็นบริการ realtime ที่ตั้งค่าครั้งเดียวผ่าน console

### 2. ตั้งตัวแปรในแอป Amplify ที่มีอยู่

เปิด **Amplify → werewolf-online → Hosting → Environment variables → Manage variables** แล้วใส่ให้ครบสามตัว:

| Variable | Value |
| --- | --- |
| `APPSYNC_HTTP_URL` | HTTP endpoint จาก AppSync รูปแบบ `https://APIID.appsync-api.ap-southeast-2.amazonaws.com/event` |
| `APPSYNC_REALTIME_URL` | WebSocket endpoint รูปแบบ `wss://APIID.appsync-realtime-api.ap-southeast-2.amazonaws.com/event/realtime` |
| `APPSYNC_API_KEY` | AppSync API key ตัวจริงที่ยังไม่หมดอายุ เช่น `da2-...` |

**ตัวอย่างในตารางเป็น placeholder ห้ามคัดลอกมาใช้ตรง ๆ** คัดลอก endpoint และ key ของ API ที่คุณเพิ่งสร้าง ตรวจ `/event` และ `/event/realtime` ให้ครบ ไม่ใส่ path ซ้ำ, query string หรือช่องว่าง

เลือกใช้ค่ากับ branch **main** หากมี branch override ตรวจว่าไม่มีค่าต่างจากที่ตั้งไว้ แล้ว Save ลบ `GAME_SERVER_URL` และ `ALLOWED_ORIGINS` เก่าที่เคยใส่ใน Amplify ได้ รุ่น AWS ไม่ใช้ทั้งสองตัวนี้

### 3. Deploy main อีกครั้ง

1. เปิด branch **main** ของแอป `werewolf-online` ใน Amplify
2. ตรวจ repository เป็น `tanawutmalirum29-ux/werewolf-online` และใช้ `amplify.yml` จาก `main` เวอร์ชันล่าสุด Root directory เว้นว่าง
3. หากจำเป็นต้องกรอก build settings เอง ให้ใช้:

```yaml
version: 1
frontend:
  phases:
    preBuild:
      commands:
        - nvm install 24
        - nvm use 24
    build:
      commands:
        - npm run build:amplify
  artifacts:
    baseDirectory: dist
    files:
      - '**/*'
```

4. เลือก **Redeploy this version** ของ deployment ที่ใช้ commit ใหม่ล่าสุด หรือรอ auto-deploy จากการ push main อย่าเลือก commit เก่าที่ใช้ `GAME_SERVER_URL`
5. รอ BUILD และ DEPLOY ผ่าน แล้วเปิด URL ที่ Amplify แสดง

ไม่ใช้ `npm start`, `.next`, SSR, rewrite ทุก path ไป `index.html` หรือ reverse proxy Socket.IO; `host.html`, `player.html` และไฟล์รูป/JavaScript เป็นไฟล์ static ส่วน realtime เชื่อม AppSync โดยตรง

### 4. ทดสอบเกมสองอุปกรณ์

1. โฮสต์เปิดเว็บ Amplify → สร้างห้อง → คัดลอก **ลิงก์ชวนเพื่อน**
2. ผู้เล่นเปิดลิงก์นี้ในอีกอุปกรณ์ ตั้งชื่อ และเข้าห้อง ให้ชื่อปรากฏในหน้าโฮสต์
3. เลือกบทบาทและแจกการ์ด ผู้เล่นเห็นเฉพาะการ์ดตัวเอง รายชื่อคนอื่นยังไม่แสดงบทบาท
4. โฮสต์กำหนดคนตาย เปลี่ยนกลางวัน/กลางคืน แล้วจบเกม ตรวจว่าผู้เล่นเห็นผลและทุกบทบาทเมื่อจบ
5. ทดสอบผู้เล่นรีเฟรช: กลับเข้าห้องได้เมื่อหน้าโฮสต์เดิมยังเปิดและเชื่อมต่ออยู่
6. ปิดห้องจากหน้าโฮสต์ ผู้เล่นต้องกลับหน้าเข้าห้อง

**โฮสต์ต้องเปิดแท็บไว้และไม่พักเครื่องตลอดเกม** ถ้าปิด รีเฟรช เบราว์เซอร์หยุดทำงาน หรือมือถือพักหน้าโฮสต์ ห้องอาจหาย/หยุดตอบ ต้องสร้างใหม่ ไม่มีการกู้ห้อง ลองใช้คอมพิวเตอร์เป็นโฮสต์เพื่อให้หน้าเว็บทำงานต่อเนื่อง หากเน็ตหลุดชั่วคราวแต่หน้าโฮสต์ยังอยู่ จะลองเชื่อมต่อ AppSync ใหม่

ใช้ลิงก์ชวนเพื่อนที่เว็บสร้าง เพราะมี fingerprint ของโฮสต์สำหรับตรวจตัวตนระหว่างเชื่อมต่อ รหัสห้อง 5 ตัวอย่างเดียวใช้เข้าห้องได้แต่ไม่มี fingerprint ล่วงหน้า จึงควรส่งลิงก์ให้กลุ่มที่รู้จัก ไม่ส่งลิงก์แท็บโฮสต์หรือโทเคนส่วนตัว

## ขอบเขตเกมและข้อมูล

- การ์ดเดิม 30 บทบาท รูปและคำอธิบายเดิม สุ่มด้วย Web Crypto
- โฮสต์เป็นผู้ตัดสิน ไม่นับเป็นผู้เล่น มีสวิตช์ซ่อนบทบาทบนจอโฮสต์
- เปลี่ยนมีชีวิต/เสียชีวิต ป้องกัน ถูกเล็ง และบทบาทเองได้ เครื่องหมายไม่ฆ่าหรือใช้พลังอัตโนมัติ
- การ์ดที่เลือกไม่ครบจะเติมชาวบ้าน จำกัด 40 ผู้เล่นต่อห้อง เป็นขีดจำกัดโค้ด ไม่ใช่การรับรอง capacity ที่ทดสอบโหลดแล้ว
- ส่งข้อมูลแต่ละผู้เล่นแยกกันและเข้ารหัส ECDH P-256 / AES-GCM การส่งซ้ำ/ข้อความถูกแก้ไขถูกปฏิเสธ ก่อนจบไม่ส่งบทบาทคนอื่นหรือโทเคนสมาชิกอื่นให้ผู้เล่น
- ผู้เล่นเก็บโทเคนใน sessionStorage เพื่อรีเฟรชแท็บตนเองขณะที่โฮสต์ยังเปิดอยู่ ไม่มีการเก็บห้องหรือการ์ดโฮสต์ลง DB/ดิสก์/localStorage
- สถานะออนไลน์ใช้ heartbeat ประมาณ 30 วินาที คนที่ไม่ตอบเกินประมาณ 90 วินาทีแสดงออฟไลน์ เวลานี้อาจยาวขึ้นถ้าเบราว์เซอร์พัก timer

## ค่าใช้จ่าย

Amplify และ AppSync **ไม่ใช่ฟรีถาวร** และการเชื่อม GitHub ไม่ได้ทำให้บริการ AWS ทุกตัวฟรี ตรวจ Free Tier/เครดิตและ Billing ของบัญชีตัวเองก่อนสร้าง API

เอกสาร AppSync ระบุ Free Tier ตามคุณสมบัติบัญชี: 250,000 realtime updates และ 600,000 connection-minutes ต่อเดือนในช่วง 12 เดือน; เกินโควตาหรือหมดช่วงฟรีคิดตามการใช้งาน ส่วน Amplify คิด build/storage/bandwidth ตามแผนและโควตา หน้านี้ไม่ได้ยืนยันว่าบัญชีของคุณยังมีสิทธิ์ฟรี

API key ของเกมเปิดเผยเพื่อให้เข้าเล่นโดยไม่สมัครบัญชี ผู้ที่เข้าถึงเว็บอาจใช้ API และเพิ่มปริมาณการใช้งานได้ จึงเหมาะกับกลุ่มเล็กที่รู้จักกัน ตรวจ usage/billing และวันหมดอายุ key หาก key หมดอายุหรือเปลี่ยน key ต้องแก้ `APPSYNC_API_KEY` แล้ว rebuild/redeploy Amplify

## ถ้ายัง deploy หรือเล่นไม่ได้

| อาการ | ตรวจอะไร |
| --- | --- |
| BUILD บอกตั้งค่าครบสามตัว | Environment variables และ branch override ของ main |
| BUILD บอก endpoint ไม่ถูก | HTTPS `/event` และ WSS `/event/realtime` ของ **Event API** เดียวกัน |
| หน้าเว็บบอกยังไม่พร้อมเล่น | ยังไม่ได้ตั้งสามตัวแปร หรือกำลังเปิด deployment เก่า ให้ตั้งแล้ว redeploy |
| เชื่อม AppSync ไม่ได้ | API key ถูกตัว/ยังไม่หมดอายุ, endpoint เป็น Event API, ทั้งสาม auth modes เป็น API_KEY |
| AppSync ปฏิเสธคำขอ | namespace **default** มีอยู่และใช้ API_KEY สำหรับ publish/subscribe |
| เข้าห้องไม่ได้/หมดเวลา | โฮสต์ต้องเปิดหน้าและออนไลน์ ลิงก์ต้องเป็นห้องปัจจุบัน หรือห้องหายเพราะรีเฟรชแล้ว |
| บทบาท/สถานะไม่อัปเดต | หน้าโฮสต์หรือเครือข่ายอาจพัก ต้องเปิดแท็บโฮสต์ไว้ ถ้าห้องหายสร้างใหม่ |

ถ้า BUILD ยังล้มเหลว ให้เปิดรายละเอียด BUILD แล้วส่งท้าย log ประมาณ 30 บรรทัด ไม่ส่ง API key, AWS credentials หรือ S3 pre-signed URL ที่มีโทเคน

## รันในเครื่องและทดสอบ

โหมด local ยังคงใช้ Express/Socket.IO ห้องอยู่ใน RAM ของ process สำหรับการพัฒนา ไม่ใช่เซิร์ฟเวอร์ที่ต้อง deploy คู่กับ Amplify:

```bash
npm ci
npm test
npm start
```

เปิด http://localhost:3000 ใช้ Node.js 24

ตรวจ build Amplify โดยไม่ตั้งค่า (หน้า setup):

```bash
npm run build:amplify
```

การทดสอบใน repo ใช้ relay และ WebSocket protocol จำลองเพื่อทดสอบ flow/การเข้ารหัส รวมทั้งโหมด Node local; ต้องทดสอบจริงกับ AppSync หลังตั้งค่าบัญชี AWS ตามขั้นตอนที่ 4 ไม่ใช่ผลยืนยัน deployment บนบัญชี AWS

## โครงสร้าง

| ไฟล์ | หน้าที่ |
| --- | --- |
| `amplify.yml` | Build หน้าเว็บ static จาก main |
| `scripts/build-amplify.js` | สร้าง dist และฝังค่า AppSync |
| `public/index.html`, `public/host.html`, `public/player.html` | 3 หน้าเกม |
| `public/js/app.js` | UI โฮสต์และผู้เล่น |
| `public/js/aws-events.js` | AppSync protocol, การเข้ารหัส, คุมห้องในหน้าโฮสต์ |
| `public/js/random.js`, `lib/game.js` | สุ่มและกติกาพื้นฐาน ใช้ร่วมกับ browser/Node |
| `roles.json`, `public/images` | บทบาทและรูปการ์ด |
| `server.js` | Node server สำหรับ local development |

อ้างอิง:
- https://docs.aws.amazon.com/appsync/latest/eventapi/create-event-api-tutorial.html
- https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html
- https://docs.aws.amazon.com/appsync/latest/eventapi/configure-event-api-auth.html
- https://docs.aws.amazon.com/amplify/latest/userguide/setting-env-vars.html
- https://aws.amazon.com/appsync/pricing/
- https://aws.amazon.com/amplify/pricing/
