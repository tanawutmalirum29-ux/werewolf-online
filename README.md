# 🎣 เกมตกปลา

## โครงสร้างโปรเจกต์

```
fishing-game/
├── server.js              ← Express server (entry point)
├── package.json
├── .gitignore
├── server/
│   ├── fishData.js        ← ข้อมูลปลาทั้งหมด (อยู่ฝั่ง server)
│   └── locationData.js    ← รายชื่อสถานที่
└── public/                ← static files (browser)
    ├── index.html
    ├── museum.html
    ├── storage.html
    ├── css/               ← ใส่ไฟล์ CSS ที่มีอยู่แล้วตรงนี้
    └── js/
        ├── game.js
        ├── museum.js
        └── storage.js
```

## วิธีรันในเครื่อง

```bash
npm install
npm start
# เปิด http://localhost:3000
```

## Deploy บน Render (ฟรี)

1. Push โค้ดขึ้น GitHub
2. ไปที่ [render.com](https://render.com) → New Web Service
3. เชื่อม GitHub repo
4. ตั้งค่า:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Deploy!

## Deploy บน Railway

```bash
# ติดตั้ง Railway CLI
npm install -g @railway/cli
railway login
railway init
railway up
```

## API Endpoints

| Endpoint | คำอธิบาย |
|----------|----------|
| `GET /api/locations` | รายชื่อสถานที่ทั้งหมด |
| `GET /api/fish?location=river` | ข้อมูลปลาใน location นั้น |

## ⚠️ CSS ที่ต้องเพิ่มเอง

คัดลอกไฟล์ CSS เดิมของคุณเข้าโฟลเดอร์ `public/css/`:
- `public/css/style.css` (จากไฟล์ styleตกปลา.css เดิม)
- `public/css/museum.css`
- `public/css/storage.css`
