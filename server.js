const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

const rooms = {};
const ADMIN_PASSWORD = "123456";

/* =========================
   EMIT ROOM
========================= */
function emitRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("roomData", room);
}

/* =========================
   DELETE ROOM (SAFE)
========================= */
function deleteRoom(roomCode, reason = "unknown") {
  if (!rooms[roomCode]) return;

  io.to(roomCode).emit("roomClosed");
  delete rooms[roomCode];

  console.log("Room deleted:", roomCode, reason);
}

/* =========================
   CLEANUP = DELETE IF EMPTY
========================= */
function cleanupRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // 🔥 FIX: ลบห้องทันทีถ้า player = 0
  if (room.players.length === 0) {
    deleteRoom(roomCode, "empty");
  }
}

/* =========================
   SOCKET
========================= */
io.on("connection", (socket) => {

  console.log("connected:", socket.id);

  /* =========================
     CREATE ROOM
  ========================= */
  socket.on("createRoom", (data) => {

    if (!data?.roomCode) return;

    if (rooms[data.roomCode]) {
      socket.emit("errorMessage", "มีห้องนี้อยู่แล้ว");
      return;
    }

    rooms[data.roomCode] = {
      roomCode: data.roomCode,
      started: false,
      phase: "กลางคืน",
      logs: [],
      roles: data.roles || [],
      players: []
    };

    socket.join(data.roomCode);

    socket.emit("roomCreated", {
      roomCode: data.roomCode
    });

    console.log("Room created:", data.roomCode);
  });

  /* =========================
     JOIN ROOM
  ========================= */
  socket.on("joinRoom", ({ roomCode, name }) => {

  const room = rooms[roomCode];
  if (!room) {
    socket.emit("errorMessage", "ไม่พบห้อง");
    return;
  }

  const existing = room.players.find(p => p.name === name);

  if (existing) {
    existing.id = socket.id;
  } else {
    room.players.push({
      id: socket.id,
      name,
      role: null,
      alive: true
    });
  }

  socket.join(roomCode);

  // ✅ สำคัญ: confirm join
  socket.emit("joinSuccess", { roomCode, name });

  emitRoom(roomCode);
});

  /* =========================
     GET ROOM
  ========================= */
  socket.on("getRoom", (roomCode) => {

    const room = rooms[roomCode];

    if (!room) {
      socket.emit("roomData", null);
      return;
    }

    socket.join(roomCode);
    socket.emit("roomData", room);
  });

  /* =========================
     START GAME
  ========================= */
  socket.on("startGame", (roomCode) => {

    const room = rooms[roomCode];
    if (!room) return;

    const shuffled = [...room.roles].sort(() => Math.random() - 0.5);

    room.players.forEach((p, i) => {
      p.role = shuffled[i] || "ชาวบ้าน";
    });

    room.started = true;
    emitRoom(roomCode);
  });

  /* =========================
     KICK PLAYER
  ========================= */
  socket.on("kickPlayer", ({ roomCode, name }) => {

    const room = rooms[roomCode];
    if (!room) return;

    room.players = room.players.filter(p => p.name !== name);

    emitRoom(roomCode);

    // 🔥 สำคัญ: ลบถ้า player = 0
    cleanupRoom(roomCode);
  });

  /* =========================
     END GAME
  ========================= */
  socket.on("endGame", (roomCode) => {
    deleteRoom(roomCode, "endGame");
  });

  /* =========================
     DISCONNECT
  ========================= */
  socket.on("disconnect", () => {

    for (const roomCode in rooms) {

      const room = rooms[roomCode];
      if (!room) continue;

      room.players = room.players.filter(p => p.id !== socket.id);

      emitRoom(roomCode);

      // 🔥 FIX CORE: ถ้าไม่มี player = ลบห้องทันที
      cleanupRoom(roomCode);
    }
  });

});

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});