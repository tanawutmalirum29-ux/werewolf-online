<!DOCTYPE html>
<html>

<head>

  <title>Werewolf GM</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <style>
    *{box-sizing:border-box;}

    body{
      background:#111;
      color:white;
      font-family:Arial;
      padding:20px;
      margin:0;
    }

    h1,h2{margin-top:0;}

    input,select,button{
      width:100%;
      padding:14px;
      border:none;
      border-radius:12px;
      margin-bottom:12px;
      font-size:16px;
    }

    input,select{
      background:#1e1e1e;
      color:white;
    }

    button{
      background:#5865f2;
      color:white;
      cursor:pointer;
      font-weight:bold;
    }

    button:hover{opacity:0.9;}
  </style>

</head>

<body>

<h1>🎮 GM PANEL</h1>

<div>
  <input id="roomCode" placeholder="รหัสห้อง">
  <div id="roomError" style="color:red"></div>

  <select id="deckSelect" onchange="loadDeck()">
    <option value="custom">Custom</option>
    <option value="6normal">6 คนธรรมดา</option>
    <option value="6chaos">6 คนปั่น</option>
  </select>
</div>

<h2>อาชีพ</h2>

<div style="display:flex;gap:10px;">
  <select id="roleSelect"></select>
  <button onclick="addRole()">+</button>
</div>

<div id="roleContainer"></div>

<h3>จำนวนผู้เล่น: <span id="totalPlayers">0</span></h3>

<button onclick="createRoom()">สร้างห้อง</button>

<script src="/socket.io/socket.io.js"></script>

<script>

const socket = io();

/* =========================
   DATA
========================= */
const allRoles = [
  "หมาป่า","ชาวบ้าน","หมอ","ผู้หยั่งรู้",
  "นายพราน","นักล่าหัว","คนบ้า","กามเทพ",
  "บอดี้การ์ด","แม่มด"
];

const decks = {
  "6normal":{
    หมาป่า:2,
    ชาวบ้าน:2,
    หมอ:1,
    ผู้หยั่งรู้:1
  },
  "6chaos":{
    หมาป่า:1,
    นักล่าหัว:1,
    คนบ้า:1,
    นายพราน:1,
    หมอ:1,
    ผู้หยั่งรู้:1
  }
};

let roleCounts = {};
let currentRoom = null;

/* =========================
   ROLE UI
========================= */
function setupRoleSelect(){
  const select = document.getElementById("roleSelect");
  select.innerHTML = allRoles.map(r => `<option value="${r}">${r}</option>`).join("");
}

function addRole(){
  const role = document.getElementById("roleSelect").value;
  roleCounts[role] = (roleCounts[role] || 0) + 1;
  renderRoles();
}

function changeRole(role, value){
  roleCounts[role] = (roleCounts[role] || 0) + value;
  if(roleCounts[role] <= 0) delete roleCounts[role];
  renderRoles();
}

function renderRoles(){
  const el = document.getElementById("roleContainer");
  el.innerHTML = "";

  Object.keys(roleCounts).forEach(role=>{
    el.innerHTML += `
      <div style="display:flex;justify-content:space-between;background:#1e1e1e;padding:10px;border-radius:10px;margin-bottom:8px;">
        <div>${role}</div>
        <div>
          <button onclick="changeRole('${role}',-1)">-</button>
          ${roleCounts[role]}
          <button onclick="changeRole('${role}',1)">+</button>
        </div>
      </div>
    `;
  });

  updateTotal();
}

function updateTotal(){
  let total = 0;
  Object.values(roleCounts).forEach(v=>total+=v);
  document.getElementById("totalPlayers").innerText = total;
}

/* =========================
   DECK
========================= */
function loadDeck(){
  const selected = document.getElementById("deckSelect").value;

  roleCounts = {};

  if(selected !== "custom"){
    Object.assign(roleCounts, decks[selected]);
  }

  renderRoles();
}

/* =========================
   SOCKET CONNECT
========================= */
socket.on("connect", ()=>{
  console.log("connected", socket.id);
});

/* =========================
   CREATE ROOM
========================= */
function createRoom(){

  const roomCode = document.getElementById("roomCode").value.trim();
  const err = document.getElementById("roomError");
  err.innerText = "";

  if(!roomCode){
    err.innerText = "กรอกรหัสห้อง";
    return;
  }

  let roles = [];
  Object.keys(roleCounts).forEach(r=>{
    for(let i=0;i<roleCounts[r];i++){
      roles.push(r);
    }
  });

  if(roles.length === 0){
    alert("ต้องมีอย่างน้อย 1 อาชีพ");
    return;
  }

  currentRoom = roomCode;

  socket.emit("createRoom", {
    roomCode,
    roles
  });
}

/* =========================
   ROOM CREATED
========================= */
socket.on("roomCreated", (data)=>{

  if(!data?.roomCode){
    alert("สร้างห้องไม่สำเร็จ");
    return;
  }

  currentRoom = data.roomCode;

  // 🔥 IMPORTANT: GM JOIN ROOM
  socket.emit("joinRoom", {
    roomCode: data.roomCode,
    name: "GM"
  });

  sessionStorage.setItem("roomCode", data.roomCode);

  location.href = "host-lobby.html";
});

/* =========================
   REALTIME SYNC
========================= */
socket.on("roomData", (room)=>{
  if(!room) return;

  console.log("SYNC ROOM:", room);
});

/* =========================
   ERROR
========================= */
socket.on("errorMessage", (msg)=>{
  alert(msg);
});

/* =========================
   INIT
========================= */
setupRoleSelect();
loadDeck();

</script>

</body>
</html>