'use strict';

// Per-viewer redaction of the public room view.
// Host screens keep receiving the full view. Player screens get everything the UI needs, but other
// players' credentials (token), roles and private ability state are removed unless this viewer is
// entitled to know them (own data, wolf teammates, cult/bandit groups, scout results, public reveals,
// game over). Pure functions only, so they can be unit-tested without Socket.IO.
const crypto = require('crypto');

// Fields no player UI reads. Only the host/server need them.
const SERVER_ONLY_PLAYER_FIELDS = [
    'killed', 'killedBy', 'killedByPlayerId', 'protected', 'witchPoisonPending', 'witchPoisonCasterId',
    'wizardCursed', 'musclemanPendingDeath', 'musclemanExposed', 'stubbornInjured', 'bodyguardInjured',
    'transformed', 'oracleTransformed', 'illusionDisguised', 'leaveReason', 'leaveRecordedAt',
];

// Private to the player who owns them (the client only reads these on its own player object).
const SELF_ONLY_PLAYER_FIELDS = [
    'membershipId', 'huntTarget', 'huntTargetId', 'cupidPairTargetIds', 'instigatorPairTargetIds',
    'illusionTargetIds', 'loverId', 'instigatorLinkId', 'instigatorGroupId', 'cupidPaired', 'instigatorPaired',
    'lastCupidPairText', 'lastInstigatorPairText', 'lastScoutTargetName', 'lastScoutTargetId',
    'lastDetectiveScoutText', 'scoutAnnouncedTargetIds', 'scoutedThisNight', 'detectiveScoutedThisNight',
    'witchProtectPotions', 'witchPoisonPotions', 'priestHolyWaterPotions', 'guardianShieldAvailable',
    'sheriffBullets', 'sheriffPeeks', 'sheriffUsedToday', 'mayorAvailable',
];

// Room-level fields only the host/server use (the player client never reads them).
const HOST_ONLY_ROOM_FIELDS = [
    'banditChatHistory', 'cultChatHistory', 'privateChatLog', 'hostPrivateChatLog', 'hostMembershipId',
    'pendingInstigatorPair', 'testerSessionId', 'roomLeaseEpoch', 'testerConditions',
];

function publicPlayerKey(room, player) {
    // Stable pseudonym for a player (same across socket ids) that does not reveal the real token.
    return crypto.createHash('sha256')
        .update(`${String(room?.id || '')}|${String(player?.token || player?.id || '')}`)
        .digest('hex').slice(0, 16);
}

function includesId(list, id) {
    return Array.isArray(list) && id != null && list.includes(id);
}

function onlyKey(map, key) {
    if (!map || typeof map !== 'object' || key == null || !(key in map)) return {};
    return { [key]: map[key] };
}

function banditGroupIds(rawPlayers, viewer) {
    const ids = new Set();
    if (!viewer) return ids;
    const leaderId = viewer.banditLeaderId || viewer.id;
    ids.add(viewer.id);
    if (viewer.banditLeaderId) ids.add(viewer.banditLeaderId);
    rawPlayers.forEach((p) => { if (p && p.banditLeaderId && p.banditLeaderId === leaderId) ids.add(p.id); });
    return ids;
}

function redactPlayerForViewer(room, p, viewer, ctx) {
    const out = { ...p, pubKey: publicPlayerKey(room, p) };
    SERVER_ONLY_PLAYER_FIELDS.forEach((k) => { delete out[k]; });
    if (p.isHost) { delete out.token; return out; }
    if (viewer && p.id === viewer.id) return out; // own data stays intact

    delete out.token;
    SELF_ONLY_PLAYER_FIELDS.forEach((k) => { delete out[k]; });
    const vid = viewer ? viewer.id : null;

    // Which parts of the role may this viewer see?
    let revealRole = !!room.gameOver
        || !!p.roleRevealPublic
        || includesId(p.roleRevealMutualWith, vid)
        || (ctx.viewerIsWolf && ctx.wolfRoles.has(p.role))
        || (viewer && viewer.cultLeaderId && p.id === viewer.cultLeaderId)
        || (ctx.banditGroup.has(p.id) && p.id !== vid);
    const seerSnapshot = ctx.viewerIsWolf && p.wolfSeerRevealed;
    if (seerSnapshot && !p.wolfSeerRevealedRole) revealRole = true;
    const trueSeerToMe = includesId(p.trueSeerRevealedTo, vid);
    if (trueSeerToMe && !(p.trueSeerRevealedRoleBy && p.trueSeerRevealedRoleBy[vid])) revealRole = true;
    const sheriffToMe = includesId(p.sheriffRevealedTo, vid);
    if (sheriffToMe && !(p.sheriffRevealedRoleBy && p.sheriffRevealedRoleBy[vid])) revealRole = true;
    if (!revealRole) {
        delete out.role; delete out.originalRole; delete out.displayRole;
    } else if (p.illusionDeathReveal && !room.gameOver) {
        // Victim of the illusionist is publicly shown as the illusionist, never as the real role.
        out.role = 'นักเล่นกล'; out.displayRole = 'นักเล่นกล'; out.originalRole = 'นักเล่นกล';
    }

    // Per-viewer reveal maps: keep only what was revealed to this viewer.
    if (!ctx.viewerIsWolf) { delete out.wolfSeerRevealed; delete out.wolfSeerRevealedRole; }
    out.trueSeerRevealedTo = trueSeerToMe ? [vid] : [];
    out.sheriffRevealedTo = sheriffToMe ? [vid] : [];
    out.trueSeerRevealedRoleBy = onlyKey(p.trueSeerRevealedRoleBy, vid);
    out.sheriffRevealedRoleBy = onlyKey(p.sheriffRevealedRoleBy, vid);
    out.auraRevealedTo = onlyKey(p.auraRevealedTo, vid);
    out.detectiveRevealedTo = onlyKey(p.detectiveRevealedTo, vid);
    out.roleRevealMutualWith = includesId(p.roleRevealMutualWith, vid) ? [vid] : [];

    // Group membership is only visible inside the group.
    if (!(viewer && (p.cultLeaderId === vid || (viewer.cultLeaderId && p.cultLeaderId === viewer.cultLeaderId)))) delete out.cultLeaderId;
    if (!ctx.banditGroup.has(p.id)) delete out.banditLeaderId;

    // The day-time silence marker is only shown by the client during the day; do not leak night picks.
    if (room.isNight) out.silenced = false;
    return out;
}

function redactRoomViewForPlayer(room, view, viewer, { wolfRoles = new Set() } = {}) {
    if (!view) return view;
    const rawPlayers = room.players || [];
    const ctx = {
        wolfRoles,
        viewerIsWolf: !!viewer && wolfRoles.has(viewer.role),
        banditGroup: banditGroupIds(rawPlayers, viewer),
    };
    const out = { ...view };
    HOST_ONLY_ROOM_FIELDS.forEach((k) => { delete out[k]; });
    out.players = (view.players || []).map((p) => redactPlayerForViewer(room, p, viewer, ctx));

    // Role counts are public by design (the roster shows how many of each role exist) but not who holds them.
    const counts = {};
    rawPlayers.forEach((p) => {
        const r = p && !p.isHost ? (p.originalRole || p.role) : null;
        if (r) counts[r] = (counts[r] || 0) + 1;
    });
    if (Object.keys(counts).length) out.roleCounts = counts;

    const vid = viewer ? viewer.id : null;
    out.selectedTargets = onlyKey(view.selectedTargets, vid);
    out.curseTargets = onlyKey(view.curseTargets, vid);
    out.cultActions = onlyKey(view.cultActions, vid);
    out.banditActions = onlyKey(view.banditActions, vid);
    out.banditKillVotes = {};
    if (view.banditKillVotes) {
        Object.keys(view.banditKillVotes).forEach((k) => { if (ctx.banditGroup.has(k)) out.banditKillVotes[k] = view.banditKillVotes[k]; });
    }
    out.wolfKillVotes = ctx.viewerIsWolf ? (view.wolfKillVotes || {}) : {};
    out.murdererKillVote = view.murdererKillVote && view.murdererKillVote.voterId === vid ? view.murdererKillVote : null;
    out.instigatorKillVote = view.instigatorKillVote && view.instigatorKillVote.voterId === vid ? view.instigatorKillVote : null;
    out.pendingLoverPair = view.pendingLoverPair && view.pendingLoverPair.selectorId === vid ? view.pendingLoverPair : null;

    if (view.gameResult && Array.isArray(view.gameResult.winners)) {
        const byId = new Map(rawPlayers.map((p) => [p && p.id, p]));
        out.gameResult = {
            ...view.gameResult,
            winners: view.gameResult.winners.map((w) => {
                const raw = byId.get(w && w.id) || rawPlayers.find((p) => p && p.token === (w && w.token));
                return { id: w && w.id, pubKey: raw ? publicPlayerKey(room, raw) : '' };
            }),
        };
    }
    return out;
}

module.exports = { redactRoomViewForPlayer, publicPlayerKey, SERVER_ONLY_PLAYER_FIELDS, SELF_ONLY_PLAYER_FIELDS, HOST_ONLY_ROOM_FIELDS };
