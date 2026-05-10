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

function emitRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("roomData", room);
}

function deleteRoom(roomCode, reason = "unknown") {
  if (!rooms[roomCode]) return;

  io.to(roomCode).emit("roomClosed");
  delete rooms[roomCode];

  console.log("Room deleted:", roomCode, reason);
}

function cleanupRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.players.length === 0) {
    deleteRoom(roomCode, "empty");
  }
}

io.on("connection", (socket) => {

  console.log("connected:", socket.id);

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

    // ✔ IMPORTANT: host ต้อง join room ด้วย
    socket.join(data.roomCode);

    socket.emit("roomCreated", {
      roomCode: data.roomCode
    });

    console.log("Room created:", data.roomCode);
  });

  socket.on("joinRoom", ({ roomCode, name }) => {

    const room = rooms[roomCode];
    if (!room) return socket.emit("errorMessage", "ไม่พบห้อง");

    const existing = room.players.find(p => p.name === name);

    if (existing) {
      existing.id = socket.id;
    } else {
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
    }

    socket.join(roomCode);
    emitRoom(roomCode);
  });

  socket.on("getRoom", (roomCode) => {

    const room = rooms[roomCode];
    if (!room) {
      socket.emit("roomData", null);
      return;
    }

    socket.join(roomCode);
    socket.emit("roomData", room);
  });

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

  socket.on("kickPlayer", ({ roomCode, name }) => {

    const room = rooms[roomCode];
    if (!room) return;

    room.players = room.players.filter(p => p.name !== name);

    emitRoom(roomCode);
    cleanupRoom(roomCode);
  });

  socket.on("endGame", (roomCode) => {
    deleteRoom(roomCode, "endGame");
  });

  socket.on("disconnect", () => {

    for (const roomCode in rooms) {

      const room = rooms[roomCode];

      room.players = room.players.filter(p => p.id !== socket.id);

      emitRoom(roomCode);
      cleanupRoom(roomCode);
    }
  });

});

server.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});