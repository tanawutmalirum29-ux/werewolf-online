const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/player.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public/js/player.main.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public/css/player.css"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");

function assert(cond, msg){ if(!cond) throw new Error(msg); }

assert(html.includes('<body data-page="player" class="lobby-beach is-day">'), "player starts in beach lobby theme");
assert(html.includes('id="playerLobbyStatus"'), "lobby status strip missing");
assert(html.includes('id="playerLobbyFeatureRoom"'), "feature room card missing");
assert(html.includes('id="roomField"') && html.includes('id="codeField"'), "room/code field wrappers missing");
assert(html.includes('id="playerRoomPickerTrigger"'), "room picker trigger missing");
assert(html.includes('id="playerRoomPickerRefresh"') === false, "legacy refresh id must not exist");
assert(html.includes('id="playerRoomRefreshBtn"'), "room refresh button missing");
assert(html.includes('id="playerRoomSearchClear"'), "room search clear button missing");
assert(html.includes('aria-labelledby="playerRoomPickerTitle"'), "room picker dialog accessibility missing");

assert(js.includes('function updateLobbyRoomVisual()'), "lobby visual state helper missing");
assert(js.includes('function refreshPlayerRoomPicker()'), "room picker refresh helper missing");
assert(js.includes('function clearPlayerRoomSearch()'), "room picker clear helper missing");
assert(js.includes('function getPlayerRoomState(r)'), "room state classifier missing");
assert(js.includes('playerRoomPickerTrigger') && js.includes('classList.remove("hidden")'), "room picker should stay discoverable");
assert(js.includes('document.body.classList.remove("lobby-beach")'), "join must remove lobby theme");
assert(js.includes('document.body.classList.add("lobby-beach")'), "reset must restore lobby theme");
assert(js.includes('suggestedRoomData = Object.assign({}, suggestedRoomData || {}, r'), "selected room should merge into suggested room state");
assert(js.includes('totalRooms: Math.max(Number((suggestedRoomData && suggestedRoomData.totalRooms) || 0), 2)'), "selected room must preserve multi-room mode");
assert(!js.includes('const card = document.createElement("div");\n        card.className = "roomPickCard"'), "legacy div room cards remain");

assert(server.includes('playerCount: room.players.filter((p) => !p.isHost).length'), "suggested room playerCount missing");
assert(server.includes('maxPlayers: room.maxPlayers || 0'), "suggested room maxPlayers missing");

assert(css.includes('body.lobby-beach{'), "beach lobby theme missing");
assert(css.includes('body.lobby-beach .scene-layer::before'), "palm silhouette / scene decoration missing");
assert(css.includes('body.lobby-beach .lobby-room-panel'), "lobby room panel styles missing");
assert(css.includes('body.lobby-beach .roomPickCard'), "room card redesign styles missing");
assert(css.includes('@media (max-width:680px)'), "mobile layout breakpoint missing");
assert(css.includes('@media (max-width:360px)'), "small-phone layout breakpoint missing");

console.log("player-lobby-ui-regression: PASS");
