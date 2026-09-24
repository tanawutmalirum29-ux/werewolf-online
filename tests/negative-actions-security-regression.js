'use strict';
const assert = require('assert');
const fs = require('fs');
const s = fs.readFileSync('server.js','utf8');
function bodyOfFunction(name) {
  const at=s.indexOf(`function ${name}`); assert(at>=0,`missing ${name}`);
  const nexts=[s.indexOf('\n    function ',at+10),s.indexOf('\n    socket.on(',at+10)].filter(x=>x>0);
  return s.slice(at,nexts.length?Math.min(...nexts):at+12000);
}
const checks=[
 ['performWolfKill',['!room.isNight','!voter || !voter.alive','WOLF_ROLES.has','target.isHost']],
 ['performCastVote',['!room.voteMode','!voter || !voter.alive','target.isHost']],
 ['performBanditKill',['!room.isNight','BANDIT_ROLES.has','target.isHost']],
 ['performPriestHolyWater',['if (room.isNight) return;','caster.role !== "นักบวช"','target.isHost']],
 ['performSheriffPeek',['if (room.isNight) return;','selector.role !== "ศาลเตี้ย"','target.isHost']],
 ['performIllusionKillDisguised',['if (room.isNight) return;','room.voteMode','caster.role !== "นักเล่นกล"']],
];
for(const [fn,patterns] of checks){ const b=bodyOfFunction(fn); for(const p of patterns) assert(b.includes(p),`${fn}: missing ${p}`); }
const chat=s.slice(s.indexOf('socket.on("send_chat"'),s.indexOf('socket.on("host_chat"'));
for(const p of ['!player || !player.alive','msg.length === 0 || msg.length > 200','if (type === "wolf")','if (type === "bandit")','if (player.role !== "โจร") return;','if (room.isNight) return;']) assert(chat.includes(p),`send_chat: missing ${p}`);
assert(s.includes('socket.on("force_vote_all"') && s.includes('if (!isHostSocket(room, socket.id)) return;'),'force-vote must be host only');
console.log(`negative actions security regression: PASS (${checks.length} action implementations + chat abuse paths)`);
