const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static("public"));

/* =========================
   MEMORY STORE
========================= */
const rooms = {};

const ADMIN_PASSWORD = "123456";

/* =========================
   HELPERS
========================= */
function emitRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("roomData", room);
}

function deleteRoom(roomCode, reason = "unknown") {
  if (!rooms[roomCode]) return;

  io.to(roomCode).emit("roomClosed");

  delete rooms[roomCode];

  console.log(`🧨 Room deleted (${reason}):`, roomCode);
}

function cleanupRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.players.length === 0) {
    deleteRoom(roomCode, "empty");
  }
}

/* =========================
   SOCKET
========================= */
io.on("connection", (socket) => {

  console.log("User connected:", socket.id);

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

    socket.emit("roomCreated", rooms[data.roomCode]);

    console.log("Room created:", data.roomCode);
  });

  /* =========================
     JOIN ROOM
  ========================= */
  socket.on("joinRoom", ({ roomCode, name }) => {

    const room = rooms[roomCode];
    if (!room) return socket.emit("errorMessage", "ไม่พบห้อง");

    let player = room.players.find(p => p.name === name);

    if (player) {
      player.id = socket.id;
      socket.join(roomCode);
      emitRoom(roomCode);
      return;
    }

    room.players.push({
      id: socket.id,
      name,
      role: null,
      alive: true,
      action: "-",
      target: null,
      memory: {
        killed: false,
        protected: false,
        muted: false,
        poisoned: false,
        cursed: false,
        notes: ""
      }
    });

    socket.join(roomCode);
    emitRoom(roomCode);
  });

  /* =========================
     GET ROOM
  ========================= */
  socket.on("getRoom", (roomCode) => {

    const room = rooms[roomCode];
    if (!room) return;

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

    room.players.forEach((player, i) => {

      player.role = shuffled[i] || "ชาวบ้าน";

      if (player.role === "นักล่าหัว") {

        const targets = room.players.filter(
          p => p.name !== player.name && p.role !== "หมาป่า"
        );

        if (targets.length) {
          player.target =
            targets[Math.floor(Math.random() * targets.length)].name;
        }
      }

    });

    room.started = true;
    emitRoom(roomCode);
  });

  /* =========================
     GAME ACTIONS
  ========================= */
  socket.on("setAction", ({ roomCode, name, action }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const p = room.players.find(x => x.name === name);
    if (p) p.action = action;

    emitRoom(roomCode);
  });

  socket.on("killPlayer", ({ roomCode, name }) => {

    const room = rooms[roomCode];
    if (!room) return;

    const p = room.players.find(x => x.name === name);
    if (!p) return;

    p.alive = false;

    room.logs.unshift({
      text: `${name} ถูกฆ่า`,
      time: new Date().toLocaleTimeString()
    });

    emitRoom(roomCode);
  });

  socket.on("revivePlayer", ({ roomCode, name }) => {

    const room = rooms[roomCode];
    if (!room) return;

    const p = room.players.find(x => x.name === name);
    if (p) p.alive = true;

    emitRoom(roomCode);
  });

  socket.on("toggleMemory", ({ roomCode, name, type }) => {

    const room = rooms[roomCode];
    if (!room) return;

    const p = room.players.find(x => x.name === name);
    if (!p) return;

    p.memory[type] = !p.memory[type];

    emitRoom(roomCode);
  });

  socket.on("updateNotes", ({ roomCode, name, value }) => {

    const room = rooms[roomCode];
    if (!room) return;

    const p = room.players.find(x => x.name === name);
    if (p) p.memory.notes = value;

    emitRoom(roomCode);
  });

  socket.on("setPhase", ({ roomCode, phase }) => {

    const room = rooms[roomCode];
    if (!room) return;

    room.phase = phase;

    room.logs.unshift({
      text: `เปลี่ยนเป็น ${phase}`,
      time: new Date().toLocaleTimeString()
    });

    emitRoom(roomCode);
  });

  /* =========================
     KICK
  ========================= */
  socket.on("kickPlayer", ({ roomCode, name }) => {

    const room = rooms[roomCode];
    if (!room) return;

    const target = room.players.find(p => p.name === name);

    if (target) {
      io.to(target.id).emit("kicked");
    }

    room.players = room.players.filter(p => p.name !== name);

    emitRoom(roomCode);
    cleanupRoom(roomCode);
  });

  /* =========================
     END GAME (IMPORTANT)
  ========================= */
  socket.on("endGame", (roomCode) => {
    deleteRoom(roomCode, "endGame");
  });

  /* =========================
     ADMIN LOGIN
  ========================= */
  socket.on("adminLogin", (pass) => {

    if (pass === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      socket.emit("adminLoginSuccess");
      socket.emit("adminRooms", rooms);
    } else {
      socket.emit("errorMessage", "รหัสไม่ถูกต้อง");
    }

  });

  socket.on("getAllRooms", () => {
    if (!socket.isAdmin) return;
    socket.emit("adminRooms", rooms);
  });

  socket.on("adminDeleteRoom", (roomCode) => {
    if (!socket.isAdmin) return;
    deleteRoom(roomCode, "admin");
  });

  /* =========================
     DISCONNECT
  ========================= */
  socket.on("disconnect", () => {

    for (const roomCode in rooms) {

      const room = rooms[roomCode];

      room.players = room.players.filter(
        p => p.id !== socket.id
      );

      emitRoom(roomCode);
      cleanupRoom(roomCode);
    }

    console.log("User disconnected:", socket.id);
  });

});

/* =========================
   START SERVER
========================= */
server.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port 3000");
});