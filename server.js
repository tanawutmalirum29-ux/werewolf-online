const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const rooms = {};

/* =========================
   สร้างห้อง
========================= */
function createRoom(roomId, hostId) {
  rooms[roomId] = {
    host: hostId,
    players: [],
    gameStarted: false
  };
}

/* =========================
   SOCKET
========================= */
io.on("connection", (socket) => {

  console.log("User connected:", socket.id);

  /* GM สร้างห้อง */
  socket.on("createRoom", (roomId) => {
    createRoom(roomId, socket.id);
    socket.join(roomId);
    socket.emit("roomCreated", roomId);
  });

  /* Player เข้าห้อง */
  socket.on("joinRoom", ({ roomId, name }) => {
    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMsg", "ไม่พบห้อง");
      return;
    }

    room.players.push({
      id: socket.id,
      name
    });

    socket.join(roomId);

    io.to(roomId).emit("updatePlayers", room.players);
  });

  /* GM เริ่มเกม */
  socket.on("startGame", (roomId) => {
    const room = rooms[roomId];
    if (!room) return;

    room.gameStarted = true;

    io.to(roomId).emit("gameStarted");
  });

  /* disconnect */
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      rooms[roomId].players =
        rooms[roomId].players.filter(p => p.id !== socket.id);

      io.to(roomId).emit("updatePlayers", rooms[roomId].players);
    }
  });

});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});