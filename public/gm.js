const socket = io();

let currentRoom = null;

function createRoom() {
  const roomId = document.getElementById("roomId").value;
  currentRoom = roomId;

  socket.emit("createRoom", roomId);

  document.getElementById("roomInfo").innerText =
    "รหัสห้อง: " + roomId;
}

function startGame() {
  if (!currentRoom) return;
  socket.emit("startGame", currentRoom);
}

socket.on("roomCreated", (roomId) => {
  currentRoom = roomId;
});

socket.on("updatePlayers", (players) => {
  const list = document.getElementById("players");
  list.innerHTML = "";

  players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = p.name;
    list.appendChild(li);
  });
});