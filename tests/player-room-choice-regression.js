const fs = require('fs');
const assert = require('assert');

const root = require('path').resolve(__dirname, '..');
const playerJs = fs.readFileSync(require('path').join(root, 'public/js/player.main.js'), 'utf8');
const playerHtml = fs.readFileSync(require('path').join(root, 'public/player.html'), 'utf8');
const playerCss = fs.readFileSync(require('path').join(root, 'public/css/player.css'), 'utf8');
const serverJs = fs.readFileSync(require('path').join(root, 'server.js'), 'utf8');

function mustContain(text, needle, label) {
  assert(text.includes(needle), `${label}: missing ${needle}`);
}

// Initial page load must ask before rejoining a saved room.
mustContain(playerJs, 'const ww_savedRoomForResume = ww_store.getItem("ww_joinedRoom");', 'saved-room gate');
mustContain(playerJs, 'socket.emit("player_resume_status"', 'resume status request');
mustContain(playerJs, 'function resumePreviousPlayerRoom()', 'resume action');
mustContain(playerJs, 'async function chooseNewPlayerRoom()', 'new-room action');
mustContain(playerJs, 'socket.emit("abandon_game"', 'immediate abandon request');
assert(!playerJs.includes('socket.emit("leave_room", { roomId, token: clientToken }, () => {});'), 'new-room flow must not rely on socket membership in previous lobby');
mustContain(playerJs, 'PLAYER_LEFT_GAME', 'old-round lock handling');
assert(!playerJs.includes('const ww_autoRejoinRoom = ww_urlRejoinRoom || ww_store.getItem("ww_joinedRoom");'), 'legacy unconditional auto-rejoin must remain removed');

// Deliberate bot possession is the only automatic path.
mustContain(playerJs, 'if (BOT_CONTROLLED_TAB && ww_urlRejoinRoom)', 'bot-only auto rejoin');

// Resume modal must expose both decisions.
mustContain(playerHtml, 'id="playerResumeOverlay"', 'resume modal');
mustContain(playerHtml, 'id="playerResumeNewBtn"', 'new-room button');
mustContain(playerHtml, 'id="playerResumeContinueBtn"', 'resume button');
mustContain(playerCss, '.playerResumeBox', 'resume modal CSS');
mustContain(playerCss, '.playerResumeActions', 'resume actions CSS');

// Server must own the decision, round identity, lock and immediate stats.
mustContain(serverJs, 'socket.on("player_resume_status"', 'server resume status');
mustContain(serverJs, 'socket.on("abandon_game"', 'server abandon handler');
mustContain(serverJs, 'gameRoundId:', 'room game round id');
mustContain(serverJs, 'leftGameRoundId', 'left-round marker');
mustContain(serverJs, 'recordImmediateGameLeaveStats', 'immediate leave stats');
mustContain(serverJs, 'eventKind: "game_leave"', 'explicit leave history event kind');
mustContain(serverJs, 'leaveReason: player.leaveReason', 'leave history reason persisted');
mustContain(serverJs, 'player.alive = false;', 'explicit leave marks player dead immediately');
mustContain(serverJs, 'const leaveMsg = {', 'explicit leave chat announcement');
mustContain(serverJs, 'text: `🚪 ${player.name || "ผู้เล่น"} ออกจากเกม`', 'explicit leave chat text');
mustContain(serverJs, 'isDeath: true,', 'explicit leave is rendered as death');
mustContain(serverJs, 'cleanupAfterVoluntaryLeaveDeath(room, player)', 'explicit leave runs voluntary-leave cleanup');
mustContain(serverJs, 'player.loverId / player.instigatorLinkId จึงจงใจไม่แตะต้อง', 'leave preserves lover and instigator links');
mustContain(serverJs, 'ผู้สมรู้ร่วมคิดยังคงเป็นผู้สมรู้ร่วมคิด', 'leave preserves accomplice role link');
mustContain(serverJs, 'if (isCultLeaderPlayer(player))', 'cult leader leave cleanup');
mustContain(serverJs, 'if (!room.isNight && room.curseTargets)', 'daytime uncommitted wizard curse cleanup');
mustContain(serverJs, 'ไม่เรียก recomputeWizardCurses() ที่นี่โดยตั้งใจ', 'nighttime attached wizard curse preservation');
assert(!serverJs.includes('const cascadeDeaths = cleanupAfterDeath(room, player);\n                announceCascadeDeaths(room, id, cascadeDeaths);'), 'voluntary leave must not trigger cascade deaths');
assert(!serverJs.includes('const cascadeDeaths = cleanupAfterDeath(room, player);\n            announceCascadeDeaths(room, id, cascadeDeaths);'), 'voluntary leave retry must not trigger cascade deaths');
mustContain(serverJs, 'ADD leaveRounds :roundSet', 'idempotent leave counter guard');
mustContain(serverJs, 'ConditionExpression: "attribute_not_exists(leaveRounds) OR NOT contains(leaveRounds, :roundId)"', 'leave counter condition guard');
mustContain(serverJs, 'code: "PLAYER_LEFT_GAME"', 'old-round join lock');
mustContain(serverJs, 'code: room.gameOver ? "ROOM_ALREADY_ENDED" : "LEFT_LOBBY"', 'pre-game abandon removal');

// End-of-game accounting must skip rounds already recorded immediately.
mustContain(serverJs, '!hasImmediateLeaveRecorded(p, room)', 'duplicate stats guard');
mustContain(serverJs, 'leaveReason: left ? "offline_threshold" : null', 'offline-threshold leave history reason');

console.log('player-room-choice regression: PASS');
