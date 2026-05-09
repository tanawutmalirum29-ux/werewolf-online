const socket = io();

let currentRoom = "";
let currentName = "";

const decks = {

  "6normal": [
    "Werewolf",
    "Werewolf",
    "Seer",
    "Doctor",
    "Villager",
    "Villager"
  ],

  "6chaos": [
    "Werewolf",
    "Tanner",
    "Hunter",
    "Seer",
    "Doctor",
    "Fool"
  ],

  "8normal": [
    "Werewolf",
    "Werewolf",
    "Seer",
    "Doctor",
    "Hunter",
    "Villager",
    "Villager",
    "Villager"
  ]

};

function loadDeck() {

  const deck =
    document.getElementById("deckSelect").value;

  const roleDiv =
    document.getElementById("roleConfig");

  roleDiv.innerHTML = "";

  if (deck === "custom") {

    const roles = [
      "Werewolf",
      "Villager",
      "Doctor",
      "Seer",
      "Hunter",
      "Tanner",
      "Fool"
    ];

    roles.forEach(role => {

      roleDiv.innerHTML += `

        <div>

          <label>${role}</label>

          <input
            type="number"
            id="role_${role}"
            value="0"
            min="0"
          >

        </div>

      `;
    });

  } else {

    const selectedDeck = decks[deck];

    const counts = {};

    selectedDeck.forEach(role => {

      counts[role] =
        (counts[role] || 0) + 1;
    });

    for (let role in counts) {

      roleDiv.innerHTML += `
        <p>
          ${role} x${counts[role]}
        </p>
      `;
    }
  }
}

loadDeck();

function createRoom() {

  const room =
    document.getElementById("roomCode").value;

  const maxPlayers =
    document.getElementById("maxPlayers").value;

  const deckType =
    document.getElementById("deckSelect").value;

  let roles = [];

  if (deckType === "custom") {

    const allRoles = [
      "Werewolf",
      "Villager",
      "Doctor",
      "Seer",
      "Hunter",
      "Tanner",
      "Fool"
    ];

    allRoles.forEach(role => {

      const amount =
        parseInt(
          document.getElementById(
            `role_${role}`
          ).value
        );

      for (let i = 0; i < amount; i++) {
        roles.push(role);
      }

    });

  } else {

    roles = decks[deckType];
  }

  currentRoom = room;

  socket.emit("createRoom", {
    roomCode: room,
    maxPlayers,
    roles
  });

}

function startGame() {

  socket.emit(
    "startGame",
    currentRoom
  );
}

function joinRoom() {

  const room =
    document.getElementById("room").value;

  const name =
    document.getElementById("name").value;

  currentRoom = room;
  currentName = name;

  socket.emit("joinRoom", {
    roomCode: room,
    name
  });
}

function sendMessage() {

  const message =
    document.getElementById("message").value;

  socket.emit("sendMessage", {
    roomCode: currentRoom,
    name: currentName,
    message
  });
}

socket.on("playerList", (players) => {

  const html = players.map(p =>
    `<p>${p.name}</p>`
  ).join("");

  const playerDiv =
    document.getElementById("players");

  const hostDiv =
    document.getElementById("hostPlayers");

  if (playerDiv) {
    playerDiv.innerHTML = html;
  }

  if (hostDiv) {
    hostDiv.innerHTML = html;
  }

});

socket.on("yourRole", (role) => {

  document.getElementById("role")
    .innerText = "Role: " + role;
});

socket.on("newMessage", (data) => {

  const chat =
    document.getElementById("chat");

  if (chat) {

    chat.innerHTML += `
      <p>
        <b>${data.name}:</b>
        ${data.message}
      </p>
    `;
  }
});

socket.on("roomCreated", (room) => {

  alert("สร้างห้องแล้ว: " + room);
});

socket.on("gameStarted", () => {

  alert("เกมเริ่มแล้ว!");
});

socket.on("errorMessage", (msg) => {

  alert(msg);
});