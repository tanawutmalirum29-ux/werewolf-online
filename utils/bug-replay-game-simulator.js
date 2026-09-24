'use strict';

// Deterministic, dependency-free state machine used by Bug Replay.
// It does not replace the real game engine; it exercises the documented game rules
// and provides a stable baseline for end-to-end regression checks.

const ROLE_TEAM = Object.freeze({
  'หมาป่า':'wolf','ลูกหมาป่า':'wolf','หมาป่าผู้พิทักษ์':'wolf','หมาป่าดื้อรั้น':'wolf','หมาป่านักเวท':'wolf','หมาป่าหยั่งรู้':'wolf',
  'ชาวบ้าน':'villager','ผู้ถูกสาป':'villager','หมอ':'villager','บอดี้การ์ด':'villager','อันธพาล':'villager','หนูน้อยผู้ใสซื่อ':'villager','ผู้มีลาง':'villager','ผู้หยั่งรู้':'villager','นักสืบ':'villager','ยายขี้โมโห':'villager','แม่มด':'villager','ศาลเตี้ย':'villager','นักบวช':'villager','นายก':'villager','เด็กขี้โวยวาย':'villager','กามเทพ':'villager',
  'คนบ้า':'solo','นักล่าหัว':'solo','ฆาตกรต่อเนื่อง':'solo','นักเล่นกล':'solo','ผู้ยุยง':'solo',
  'ผู้นำลัทธิ':'cult',
  'โจร':'bandit','ผู้สมรู้ร่วมคิด':'bandit',
});

const OUTCOMES = Object.freeze(['fool','headhunter','wolf','murderer','illusionist','villager','lovers','instigators']);

function player(id, role, extra = {}) {
  return { id, role, alive:true, ...extra };
}

function effectiveTeam(p) {
  if (!p) return null;
  if (p.cultLeaderId || p.role === 'ผู้นำลัทธิ') return 'cult';
  if (p.role === 'โจร' || p.role === 'ผู้สมรู้ร่วมคิด') return 'bandit';
  return ROLE_TEAM[p.role] || null;
}

function countAlive(players, team) {
  return players.filter((p) => p.alive && effectiveTeam(p) === team).length;
}

function simulateGeneralEnd(players) {
  const alive = players.filter((p) => p.alive);
  const wolves = alive.filter((p) => effectiveTeam(p) === 'wolf');
  const villagers = alive.filter((p) => effectiveTeam(p) === 'villager');
  const cults = alive.filter((p) => effectiveTeam(p) === 'cult');
  const bandits = alive.filter((p) => effectiveTeam(p) === 'bandit');
  const soloKillers = alive.filter((p) => p.role === 'ฆาตกรต่อเนื่อง' || p.role === 'นักเล่นกล');
  const activatedHeadhunters = alive.filter((p) => p.role === 'นักล่าหัว' && p.huntTargetDead === true);

  if (soloKillers.length > 0 && alive.every((p) => soloKillers.includes(p) || activatedHeadhunters.includes(p))) {
    return soloKillers.some((p) => p.role === 'ฆาตกรต่อเนื่อง') ? 'murderer' : 'illusionist';
  }
  if (wolves.length > 0) {
    const nonWolves = villagers.length + alive.filter((p) => effectiveTeam(p) === 'solo').length + cults.length + bandits.length;
    if (wolves.length >= nonWolves && soloKillers.length === 0) return 'wolf';
  }
  if (wolves.length === 0 && soloKillers.length === 0) return 'villager';
  return null;
}

function simulateLovers(players) {
  const linked = players.filter((p) => p.alive && p.loverId);
  if (!linked.length) return null;
  const a = linked[0];
  const b = players.find((p) => p.id === a.loverId);
  if (!b || !b.alive) return null;
  const alive = players.filter((p) => p.alive);
  return alive.every((p) => p.id === a.id || p.id === b.id || p.role === 'กามเทพ') ? 'lovers' : null;
}

function simulateInstigators(players) {
  const linked = players.filter((p) => p.alive && p.instigatorLinkId);
  if (!linked.length) return null;
  const a = linked[0];
  const b = players.find((p) => p.id === a.instigatorLinkId);
  if (!b || !b.alive) return null;
  const alive = players.filter((p) => p.alive);
  return alive.every((p) => p.id === a.id || p.id === b.id || p.role === 'ผู้ยุยง') ? 'instigators' : null;
}

function simulateVote(votes, threshold) {
  const entries = Object.values(votes || {});
  if (!entries.length || !(threshold > 0)) return { winner:null, executed:false, draw:false };
  const tally = {};
  for (const target of entries) tally[target] = (tally[target] || 0) + 1;
  const max = Math.max(...Object.values(tally));
  if (max < threshold) return { winner:null, executed:false, draw:false };
  const top = Object.entries(tally).filter(([, n]) => n === max).map(([id]) => id);
  if (top.length !== 1) return { winner:null, executed:false, draw:true };
  return { winner:top[0], executed:true, draw:false };
}

function simulateForbiddenAction({ role, phase, alive = true, selfTarget = false }) {
  const allowed = alive && !selfTarget;
  if (!allowed) return false;
  if (role === 'แม่มด' && phase === 'night') return true;
  if (role === 'นักบวช' && phase === 'day') return true;
  if (role === 'ศาลเตี้ย' && phase === 'day') return true;
  if (role === 'นักเล่นกล' && phase === 'day') return true;
  return false;
}


function simulateVoteOutcome({ targetId, targetRole, headhunterTargetMatches = false, headhunterAlive = true, threshold = 1, votes = { voter: targetId } } = {}) {
  const vote = simulateVote(votes, threshold);
  if (!vote.executed || vote.winner !== targetId) return { ...vote, result:null };
  if (targetRole === 'คนบ้า') return { ...vote, result:'fool' };
  if (headhunterAlive && headhunterTargetMatches) return { ...vote, result:'headhunter' };
  return { ...vote, result:null };
}

function simulateForbiddenActionMatrix() {
  const cases = [
    ['wolfKill', { role:'ชาวบ้าน', phase:'day', alive:true, selfTarget:false }],
    ['wolfKillDead', { role:'หมาป่า', phase:'night', alive:false, selfTarget:false }],
    ['wolfKillSelf', { role:'หมาป่า', phase:'night', alive:true, selfTarget:true }],
    ['witchPoisonWrongPhase', { role:'แม่มด', phase:'day', alive:true, selfTarget:false }],
    ['priestWrongPhase', { role:'นักบวช', phase:'night', alive:true, selfTarget:false }],
    ['cultWrongPhase', { role:'ผู้นำลัทธิ', phase:'day', alive:true, selfTarget:false }],
    ['banditWrongPhase', { role:'โจร', phase:'day', alive:true, selfTarget:false }],
    ['sheriffWrongPhase', { role:'ศาลเตี้ย', phase:'night', alive:true, selfTarget:false }],
    ['illusionWrongPhase', { role:'นักเล่นกล', phase:'night', alive:true, selfTarget:false }],
    ['mayorDead', { role:'นายก', phase:'day', alive:false, selfTarget:false }],
  ];
  return cases.map(([id, input]) => ({ id, allowed: simulateForbiddenAction(input) }));
}

function createRoomRegistry() {
  return { rooms:Object.create(null), nextId:1, tokenRooms:Object.create(null) };
}

function createSimulatedRoom(registry, requestedId, { hostPassword = '', joinCode = '', maxPlayers = 0 } = {}) {
  let base = String(requestedId || `ROOM${registry.nextId}`).trim().toUpperCase();
  if (!base) base = `ROOM${registry.nextId}`;
  let id = base;
  let suffix = 2;
  while (registry.rooms[id]) id = `${base}-${suffix++}`;
  registry.rooms[id] = { id, hostPassword:String(hostPassword || ''), joinCode:String(joinCode || ''), maxPlayers:Number(maxPlayers)||0, started:false, players:[], hostToken:`host-${registry.nextId}` };
  registry.nextId += 1;
  registry.tokenRooms[registry.rooms[id].hostToken] = id;
  return registry.rooms[id];
}

function joinSimulatedRoom(registry, roomId, { token = '', name = 'ผู้เล่น', code = '' } = {}) {
  const room = registry.rooms[String(roomId || '').toUpperCase()];
  if (!room) return { ok:false, code:'ROOM_NOT_FOUND' };
  const existing = token ? room.players.find((p) => p.token === token) : null;
  if (existing) return { ok:true, reconnect:true, player:existing };
  if (room.started) return { ok:false, code:'ROOM_STARTED' };
  if (room.joinCode && code !== room.joinCode) return { ok:false, code:'WRONG_ROOM_CODE' };
  if (room.maxPlayers > 0 && room.players.length >= room.maxPlayers) return { ok:false, code:'ROOM_FULL' };
  const newToken = token || `player-${room.players.length + 1}`;
  const player = { token:newToken, name, alive:true };
  room.players.push(player);
  registry.tokenRooms[newToken] = room.id;
  return { ok:true, reconnect:false, player };
}

function hostLoginSimulated(registry, roomId, password) {
  const room = registry.rooms[String(roomId || '').toUpperCase()];
  if (!room) return { ok:false, code:'ROOM_NOT_FOUND' };
  if (room.hostPassword && password !== room.hostPassword) return { ok:false, code:'AUTH_FAILED' };
  return { ok:true, roomId:room.id };
}

function simulateRoomSecurityMatrix() {
  const reg = createRoomRegistry();
  const roomA = createSimulatedRoom(reg, 'ABCD', { hostPassword:'HOST-A', joinCode:'JOIN-A', maxPlayers:1 });
  const roomB = createSimulatedRoom(reg, 'ABCD', { hostPassword:'HOST-B', joinCode:'JOIN-B', maxPlayers:1 });
  const results = {
    collision: roomA.id !== roomB.id,
    joinWrongCode: joinSimulatedRoom(reg, roomA.id, { name:'A', code:'JOIN-B' }).code === 'WRONG_ROOM_CODE',
    joinRightCode: joinSimulatedRoom(reg, roomA.id, { name:'A', code:'JOIN-A' }).ok,
    roomFull: joinSimulatedRoom(reg, roomA.id, { name:'B', code:'JOIN-A' }).code === 'ROOM_FULL',
    startedLock: (() => { roomB.started=true; return joinSimulatedRoom(reg, roomB.id, { name:'B', code:'JOIN-B' }).code === 'ROOM_STARTED'; })(),
    reconnectWithoutCode: joinSimulatedRoom(reg, roomA.id, { token:'player-1', name:'A', code:'' }).reconnect,
    wrongHostPassword: hostLoginSimulated(reg, roomA.id, 'JOIN-A').code === 'AUTH_FAILED',
    rightHostPassword: hostLoginSimulated(reg, roomA.id, 'HOST-A').ok,
    crossRoomHostPassword: hostLoginSimulated(reg, roomB.id, 'HOST-A').code === 'AUTH_FAILED',
  };
  return results;
}

function scenarioOutcomes() {
  return {
    wolf: simulateGeneralEnd([player('w','หมาป่า'), player('v','ชาวบ้าน')]),
    villager: simulateGeneralEnd([player('v','ชาวบ้าน')]),
    murderer: simulateGeneralEnd([player('m','ฆาตกรต่อเนื่อง')]),
    illusionist: simulateGeneralEnd([player('i','นักเล่นกล')]),
    lovers: simulateLovers([player('a','ชาวบ้าน',{loverId:'b'}), player('b','หมาป่า',{loverId:'a'})]),
    instigators: simulateInstigators([player('a','ผู้ยุยง',{instigatorLinkId:'b'}), player('b','ชาวบ้าน',{instigatorLinkId:'a'}), player('c','ชาวบ้าน',{alive:false})]),
    tie: simulateVote({ a:'x', b:'y' }, 1),
    fool: simulateVoteOutcome({ targetId:'f', targetRole:'คนบ้า', votes:{v:'f'}, threshold:1 }),
    headhunter: simulateVoteOutcome({ targetId:'h', targetRole:'ชาวบ้าน', headhunterTargetMatches:true, votes:{v:'h'}, threshold:1 }),
  };
}

module.exports = { ROLE_TEAM, OUTCOMES, player, effectiveTeam, countAlive, simulateGeneralEnd, simulateLovers, simulateInstigators, simulateVote, simulateVoteOutcome, simulateForbiddenAction, simulateForbiddenActionMatrix, createRoomRegistry, createSimulatedRoom, joinSimulatedRoom, hostLoginSimulated, simulateRoomSecurityMatrix, scenarioOutcomes };
