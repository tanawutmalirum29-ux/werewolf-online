const express = require("express");
const path = require("path");
const { fishData } = require("./server/fishData");
const { locationList } = require("./server/locationData");

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public/
app.use(express.static(path.join(__dirname, "public")));

// API: ดึงข้อมูลปลาทั้งหมดหรือแยกตาม location
app.get("/api/fish", (req, res) => {
  const loc = req.query.location;
  if (loc) {
    const data = fishData[loc];
    if (!data) return res.status(404).json({ error: "ไม่พบ location นี้" });
    return res.json(data);
  }
  // ส่งแค่ชื่อ location ที่มี (ไม่ส่งข้อมูลปลาทั้งหมดรวมกัน เพื่อประหยัด bandwidth)
  res.json({ locations: Object.keys(fishData) });
});

// API: ดึงรายชื่อ location
app.get("/api/locations", (req, res) => {
  res.json(locationList);
});

// ส่ง index.html สำหรับทุก route ที่ไม่ใช่ API
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🎣 เกมตกปลา รันที่ http://localhost:${PORT}`);
});
