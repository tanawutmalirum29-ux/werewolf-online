'use strict';
const assert = require('assert');
const fs = require('fs');
const s=fs.readFileSync('server.js','utf8');
const checks=[
 ['join_room','roomId'],
 ['request_sync','roomId'],
 ['update_config','roomId'],
 ['start_game','roomId'],
 ['cast_vote','roomId'],
 ['resolve_night','roomId'],
 ['restart_room','roomId'],
 ['close_room','roomId'],
];
for(const [event] of checks){
 const at=s.indexOf(`\n    socket.on(\"${event}\"`); assert(at>=0,`${event} missing`);
 const nextNames={join_room:'list_open_rooms',request_sync:'update_room_settings'};
 const nextEventAt=nextNames[event] ? s.indexOf(`\n    socket.on("${nextNames[event]}"`,at+1) : s.indexOf('\n    socket.on(',at+1);
 const b=s.slice(at,nextEventAt>0?nextEventAt:at+20000);
 const hasRoomLookup=b.includes('rooms[roomId]') || b.includes('rooms[roomId]);') || b.includes('rooms[roomId] ||');
 assert(b.includes('const room = rooms[roomId]') || b.includes('let room = rooms[roomId]') || b.includes('room = rooms[roomId]') || b.includes('roomId = String(roomId)') || hasRoomLookup,`${event}: no room binding`);
}
assert(s.includes('if (!isHostSocket(room, socket.id)) return;'),'host-only actions need socket ownership checks');
assert(s.includes('function getRoomPlayerForSocket(room, socket, { includeHost = false } = {})'),'central room-player/socket identity helper must exist');
assert(s.includes('const socketRoomId = String(socket.data?.roomId || "").trim().toUpperCase();'),'socket identity must carry room binding');
assert(s.includes('const socketMembershipId = String(socket.data?.membershipId || "").trim();'),'socket identity must carry membership binding');
assert(s.includes('if (accountId && socketRoomId === String(room.id || "").trim().toUpperCase() && socketMembershipId)'),'account identity must be scoped to the socket room and membership');
assert(s.includes('return (room.players || []).find((p) => p && p.id === socket.id'),'legacy resolution must remain socket-bound');
assert(s.includes('if (!player || !player.alive || player.isHost) return;'),'sensitive actions must reject dead/host actor');
console.log('cross-room authorization regression: PASS (room-bound socket identity and host/player guards audited)');
