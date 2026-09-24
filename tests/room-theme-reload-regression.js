const fs = require("fs");
const assert = require("assert");

const hostHtml = fs.readFileSync("public/host.html", "utf8");
const playerHtml = fs.readFileSync("public/player.html", "utf8");
const hostJs = fs.readFileSync("public/js/host.main.js", "utf8");
const playerJs = fs.readFileSync("public/js/player.main.js", "utf8");

// Initial paint must never expose the default night palette while a room is still loading.
assert(hostHtml.includes('<body data-page="host" class="is-day">'), "host HTML must boot in daytime palette");
assert(playerHtml.includes('<body data-page="player" class="lobby-beach is-day">'), "player HTML must boot in daytime beach palette");

// Host: restore the last server-confirmed room phase immediately after reload, then replace it
// from the authoritative room_update state.
assert(hostJs.includes('const initialHostRoomId = hostStorage.getItem("ww_host_room")'), "host must identify the remembered room at boot");
assert(hostJs.includes('applySavedHostRoomTheme(initialHostRoomId);'), "host must restore the saved phase at boot");
assert(hostJs.includes('writeSavedHostRoomTheme(res.roomId, "day");'), "new host room must be remembered as day before first room_update");
assert(hostJs.includes('persistHostRoomTheme(room);'), "host room_update must persist the authoritative theme");
assert(hostJs.includes('room?.started && room?.isNight ? "night" : "day"'), "host must only persist night for a started non-game-over night");
assert(hostJs.includes('function syncHostTimeTheme(roomData)'), "host must centralize room theme resolution");
assert(hostJs.includes('document.body.classList.toggle("is-day", !activeNight);'), "host must never fall back to dark palette when no active night is confirmed");

// Player: restore remembered phase, keep lobby bright, and prevent stale room data from a previous room.
assert(playerJs.includes('const initialPlayerRoomId = ww_store.getItem("ww_joinedRoom") || "";'), "player must identify the remembered room at boot");
assert(playerJs.includes('applySavedPlayerRoomTheme(initialPlayerRoomId);'), "player must restore the saved phase at boot");
assert(playerJs.includes('if (lastRoomData) syncPlayerTimeTheme(lastRoomData);\n    else applySavedPlayerRoomThemeAfterJoin(roomCode);'), "player must not use a dark default while waiting for room_update");
assert(playerJs.includes('const leavingRoomId = currentRoomId;'), "player must capture the old room before clearing the id");
assert(playerJs.includes('lastRoomData = null;'), "player must discard stale room state when returning to the lobby");
assert(playerJs.includes('if (leavingRoomId) writeSavedPlayerRoomTheme(leavingRoomId, "");'), "player must clear the old room theme on reset");
assert(playerJs.includes('document.body.classList.add("is-day");'), "player reset must return to daytime beach theme");
assert(playerJs.includes(`body.classList.remove("is-night");
        body.classList.add("is-day");`), "player lobby must stay daytime while room state is unavailable");
assert(playerJs.includes('body.classList.toggle("is-day", !activeNight);'), "player must never fall back to dark palette when no active night is confirmed");

console.log("room-theme-reload-regression: PASS");
