/* =========================
   GAME STATE (NO SOCKET)
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

const state = {
  roleCounts: {}
};

/* =========================
   INIT UI
========================= */
function init(){
  const roleSelect = document.getElementById("roleSelect");
  const deckSelect = document.getElementById("deckSelect");

  roleSelect.innerHTML = allRoles.map(r=>`<option>${r}</option>`).join("");

  deckSelect.innerHTML = `
    <option value="custom">Custom</option>
    <option value="6normal">6 normal</option>
    <option value="6chaos">6 chaos</option>
  `;

  deckSelect.onchange = loadDeck;
}

/* =========================
   ROLE LOGIC
========================= */
function addRole(){
  const role = document.getElementById("roleSelect").value;

  state.roleCounts[role] = (state.roleCounts[role] || 0) + 1;

  render();
}

function changeRole(role, value){
  state.roleCounts[role] += value;

  if(state.roleCounts[role] <= 0){
    delete state.roleCounts[role];
  }

  render();
}

/* =========================
   DECK LOGIC
========================= */
function loadDeck(){
  const selected = document.getElementById("deckSelect").value;

  state.roleCounts = {};

  if(selected !== "custom"){
    Object.assign(state.roleCounts, decks[selected]);
  }

  render();
}

/* =========================
   BUILD FINAL DATA
========================= */
function buildRoles(){
  const result = [];

  for(const r in state.roleCounts){
    for(let i=0;i<state.roleCounts[r];i++){
      result.push(r);
    }
  }

  return result;
}

/* =========================
   RENDER UI ONLY
========================= */
function render(){

  const container = document.getElementById("roleContainer");
  container.innerHTML = "";

  let total = 0;

  for(const r in state.roleCounts){

    total += state.roleCounts[r];

    container.innerHTML += `
      <div class="box">
        ${r}
        <button onclick="changeRole('${r}',-1)">-</button>
        ${state.roleCounts[r]}
        <button onclick="changeRole('${r}',1)">+</button>
      </div>
    `;
  }

  document.getElementById("totalPlayers").innerText = total;
}

/* =========================
   EXPORT TO NET LAYER
========================= */
function getRoomData(){
  return {
    roomCode: document.getElementById("roomCode").value.trim(),
    roles: buildRoles()
  };
}

/* =========================
   INIT
========================= */
init();
loadDeck();