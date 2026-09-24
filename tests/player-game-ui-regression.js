const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/player.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/player.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/player.main.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(`player-game-ui regression failed: ${msg}`);
}

// Current player build must retain the uploaded player.html/player.css structure and beach lobby.
assert(html.includes('<body data-page="player" class="lobby-beach">'), 'player starts in beach lobby theme');
assert(html.includes('id="joinCard"'), 'join card missing');
assert(html.includes('id="playersCard"'), 'players card missing');
assert(html.includes('id="chatCard"'), 'chat card missing');
assert(html.includes('id="bottomBar"'), 'bottom bar missing');
assert(html.includes('id="playerRoomPickerOverlay"'), 'player room picker overlay missing');
assert(html.includes('id="playerResumeOverlay"'), 'previous-room decision overlay missing');
assert(html.includes('id="playerResumeNewBtn"'), 'new-room decision button missing');
assert(html.includes('id="playerResumeContinueBtn"'), 'resume decision button missing');

// Uploaded CSS must protect the viewport and use container-query sizing for player cards.
assert(css.includes('height:100svh;') && css.includes('overflow:hidden;'), 'viewport shell is not locked');
assert(css.includes('container-type:inline-size;'), 'player cards do not scale from their own width');
assert(css.includes('min-width:0;'), 'player cards lack min-width containment');
assert(css.includes('body.lobby-beach'), 'beach styling missing');
assert(css.includes('.playerRoomPickerBox'), 'room picker styling missing');
assert(css.includes('.playerResumeBox'), 'previous-room dialog styling missing');

// Core game interactions referenced by the page remain available.
for (const id of [
    'shieldBtn','pawBtn','mouthBtn','curseBtn','cultRecruitBtn','cultSacrificeBtn','gunBtn',
    'peekBtn','holyWaterBtn','illusionKillBtn','protectBtn','poisonBtn','oracleBtn','mayorBtn'
]) {
    assert(html.includes(`id="${id}"`), `ability button ${id} missing`);
}
assert(js.includes('function renderPlayerGrid'), 'player grid renderer missing');
assert(js.includes('function sendChat'), 'chat send helper missing');
assert(js.includes('function closePlayerChat'), 'chat close helper missing');
assert(js.includes('function checkPreviousRoomResume'), 'previous-room check missing');

console.log('player-game-ui regression: PASS');
