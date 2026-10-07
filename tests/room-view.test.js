'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactRoomViewForPlayer, publicPlayerKey } = require('../utils/room-view');

const WOLVES = new Set(['หมาป่า', 'ลูกหมาป่า']);
function makeRoom(extra = {}) {
    const players = [
        { id: 'h', isHost: true, token: 'HT', name: 'host' },
        { id: 'a', token: 'TA', name: 'A', role: 'หมาป่า', originalRole: 'หมาป่า', alive: true, killed: true, loverId: 'c' },
        { id: 'b', token: 'TB', name: 'B', role: 'หมาป่า', originalRole: 'หมาป่า', alive: true },
        { id: 'c', token: 'TC', name: 'C', role: 'หมอ', originalRole: 'หมอ', alive: true, witchPoisonPending: true },
        { id: 'd', token: 'TD', name: 'D', role: 'ชาวบ้าน', originalRole: 'ชาวบ้าน', alive: false, roleRevealPublic: true },
        { id: 'e', token: 'TE', name: 'E', role: 'ชาวบ้าน', originalRole: 'ชาวบ้าน', alive: true,
            trueSeerRevealedTo: ['c'], trueSeerRevealedRoleBy: { c: 'ชาวบ้าน', z: 'x' } },
    ];
    const room = { id: 'R1', players, started: true, isNight: false, gameOver: false, selectedTargets: { a: 'c', c: 'a' },
        wolfKillVotes: { a: 'c' }, privateChatLog: { TA: [1] }, curseTargets: { a: 'b' }, ...extra };
    const view = { ...room, players: players.map((p) => { const { ...c } = p; if (p.isHost) delete c.token; return c; }) };
    return { room, view };
}
const get = (v, id) => v.players.find((p) => p.id === id);

test('player cannot see other players tokens or hidden roles', () => {
    const { room, view } = makeRoom();
    const out = redactRoomViewForPlayer(room, view, room.players[3], { wolfRoles: WOLVES }); // viewer c (doctor)
    assert.equal(get(out, 'a').token, undefined);
    assert.equal(get(out, 'a').role, undefined);
    assert.equal(get(out, 'c').token, 'TC');
    assert.equal(get(out, 'c').role, 'หมอ');
    assert.equal(get(out, 'c').witchPoisonPending, undefined);
    assert.equal(get(out, 'a').killed, undefined);
    assert.equal(get(out, 'a').loverId, undefined);
    assert.equal(get(out, 'd').role, 'ชาวบ้าน'); // publicly revealed
    assert.equal(out.privateChatLog, undefined);
});

test('wolves see teammates, villagers do not', () => {
    const { room, view } = makeRoom();
    const asWolf = redactRoomViewForPlayer(room, view, room.players[1], { wolfRoles: WOLVES });
    assert.equal(get(asWolf, 'b').role, 'หมาป่า');
    assert.equal(get(asWolf, 'c').role, undefined);
    assert.deepEqual(asWolf.wolfKillVotes, { a: 'c' });
    const asDoc = redactRoomViewForPlayer(room, view, room.players[3], { wolfRoles: WOLVES });
    assert.deepEqual(asDoc.wolfKillVotes, {});
    assert.deepEqual(asDoc.selectedTargets, { c: 'a' });
    assert.deepEqual(asDoc.curseTargets, {});
});

test('scout results are visible only to the viewer they were revealed to', () => {
    const { room, view } = makeRoom();
    const asC = redactRoomViewForPlayer(room, view, room.players[3], { wolfRoles: WOLVES });
    assert.deepEqual(get(asC, 'e').trueSeerRevealedTo, ['c']);
    assert.deepEqual(get(asC, 'e').trueSeerRevealedRoleBy, { c: 'ชาวบ้าน' });
    assert.equal(get(asC, 'e').role, undefined); // snapshot exists, real role stays hidden
    const asB = redactRoomViewForPlayer(room, view, room.players[2], { wolfRoles: WOLVES });
    assert.deepEqual(get(asB, 'e').trueSeerRevealedTo, []);
    assert.deepEqual(get(asB, 'e').trueSeerRevealedRoleBy, {});
});

test('role counts stay public but do not say who holds what', () => {
    const { room, view } = makeRoom();
    const out = redactRoomViewForPlayer(room, view, room.players[3], { wolfRoles: WOLVES });
    assert.deepEqual(out.roleCounts, { 'หมาป่า': 2, 'หมอ': 1, 'ชาวบ้าน': 2 });
});

test('game over reveals roles, winners are pseudonymous', () => {
    const { room, view } = makeRoom({ gameOver: true, gameResult: { winners: [{ id: 'a', token: 'TA' }] } });
    const out = redactRoomViewForPlayer(room, view, room.players[3], { wolfRoles: WOLVES });
    assert.equal(get(out, 'a').role, 'หมาป่า');
    assert.equal(get(out, 'a').token, undefined);
    assert.deepEqual(out.gameResult.winners, [{ id: 'a', pubKey: publicPlayerKey(room, room.players[1]) }]);
    assert.equal(get(out, 'a').pubKey, out.gameResult.winners[0].pubKey);
});

test('illusionist victim is shown as the illusionist, not the real role', () => {
    const { room, view } = makeRoom();
    room.players[4].illusionDeathReveal = true; view.players[4].illusionDeathReveal = true;
    const out = redactRoomViewForPlayer(room, view, room.players[3], { wolfRoles: WOLVES });
    assert.equal(get(out, 'd').role, 'นักเล่นกล');
});

test('bandit group members see each other, outsiders do not', () => {
    const { room, view } = makeRoom();
    room.players[1].role = view.players[1].role = 'โจร';
    room.players[2].role = view.players[2].role = 'ผู้สมรู้ร่วมคิด';
    room.players[2].banditLeaderId = view.players[2].banditLeaderId = 'a';
    const asLeader = redactRoomViewForPlayer(room, view, room.players[1], { wolfRoles: WOLVES });
    assert.equal(get(asLeader, 'b').role, 'ผู้สมรู้ร่วมคิด');
    assert.equal(get(asLeader, 'b').banditLeaderId, 'a');
    const asAccomplice = redactRoomViewForPlayer(room, view, room.players[2], { wolfRoles: WOLVES });
    assert.equal(get(asAccomplice, 'a').role, 'โจร');
    const asOutsider = redactRoomViewForPlayer(room, view, room.players[3], { wolfRoles: WOLVES });
    assert.equal(get(asOutsider, 'b').role, undefined);
    assert.equal(get(asOutsider, 'b').banditLeaderId, undefined);
});
