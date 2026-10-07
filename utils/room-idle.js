'use strict';

// Only real, authenticated room connections keep a room alive. Game timers,
// bots, persistence scans and visitors to the room list never count as activity.
const ROOM_IDLE_TIMEOUT_MS = 10 * 60_000;
const ROOM_PRESENCE_REFRESH_MS = 30_000;
function initializeRoomActivity(room, fallback = Date.now()) {
    if (!(Number(room.lastRoomActivityAt) > 0)) room.lastRoomActivityAt = fallback;
    room.roomIdleExpiresAt = Number(room.lastRoomActivityAt) + ROOM_IDLE_TIMEOUT_MS;
}
function touchRoomActivity(room, now = Date.now()) {
    if (!room || room.isClosing) return false;
    initializeRoomActivity(room, now);
    room.lastRoomActivityAt = now;
    room.roomIdleExpiresAt = now + ROOM_IDLE_TIMEOUT_MS;
    return true;
}
function hasLiveRoomMember(room, sockets) {
    if (!room || room.isClosing) return false;
    const live = (id) => {
        const socket = sockets.get(id);
        return !!socket && socket.connected === true && socket.rooms?.has(String(room.id));
    };
    if ((room.hostIds || []).some(live)) return true;
    return (room.players || []).some((p) => p && !p.isHost && !p.isBot && live(p.id));
}
function roomIdleExpired(room, sockets, now = Date.now()) {
    if (!room || room.isClosing) return false;
    initializeRoomActivity(room, now);
    return now >= room.roomIdleExpiresAt && !hasLiveRoomMember(room, sockets);
}
module.exports = { ROOM_IDLE_TIMEOUT_MS, ROOM_PRESENCE_REFRESH_MS, initializeRoomActivity,
    touchRoomActivity, hasLiveRoomMember, roomIdleExpired };
