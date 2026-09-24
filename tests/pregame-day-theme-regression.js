const fs = require("fs");
const assert = require("assert");

const hostJs = fs.readFileSync("public/js/host.main.js", "utf8");
const playerJs = fs.readFileSync("public/js/player.main.js", "utf8");
const hostCss = fs.readFileSync("public/css/host.css", "utf8");
const playerCss = fs.readFileSync("public/css/player.css", "utf8");

assert(hostJs.includes('document.body.classList.add("is-day");'), "host setup must explicitly enter daytime theme immediately");
assert(hostJs.includes('function syncHostTimeTheme(roomData)'), "host theme synchronizer missing");
assert(hostJs.includes('document.body.classList.toggle("is-day", !activeNight);'), "host must keep every non-night state in the daytime palette");
assert(hostJs.includes('const activeNight = !!room.started && !room.gameOver && !!room.isNight;'), "host must switch to night only when the room is actually night");
assert(hostJs.includes('updateNightFlowButtons(currentRoom);'), "host setup exit must resync the actual room theme");
assert(hostJs.includes('document.body.classList.add("is-day");\n            writeSavedHostRoomTheme(res.roomId, "day");\n            applyRoomId(res.roomId);'), "host create-room transition must keep daytime theme until the first room_update");

assert(playerJs.includes('function syncPlayerTimeTheme(roomData)'), "player theme synchronizer missing");
assert(playerJs.includes('body.classList.add("is-day");'), "player must treat waiting/lobby state as daytime");
assert(playerJs.includes('const activeNight = !!room.started && !room.gameOver && !!room.isNight;'), "player must switch to night only when the room is actually night");
assert(playerJs.includes('if (lastRoomData) syncPlayerTimeTheme(lastRoomData);\n    else applySavedPlayerRoomThemeAfterJoin(roomCode);'), "player join must avoid a dark theme flash before room state arrives");
assert(playerJs.includes('syncPlayerTimeTheme(roomData);'), "player room_update must resync theme from server state");
assert(playerJs.includes('document.body.classList.remove("is-night");\n    document.body.classList.add("is-day");'), "player lobby reset must return to daytime beach theme");

assert(hostCss.includes('body.is-day .host-title'), "host daytime header palette missing");
assert(hostCss.includes('body.is-day .host-fact'), "host daytime control palette missing");
assert(playerCss.includes('body.is-day .app .card'), "player daytime game palette missing");

console.log("pregame-day-theme-regression: PASS");
