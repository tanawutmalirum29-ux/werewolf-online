const assert = require('assert');
const { createRuntimeAudit } = require('../utils/runtime-audit-engine');

let t = 1000;
const audit = createRuntimeAudit({ source: 'test', runId: 'self', clock: () => t });

audit.checkStateInvariants({
    roomId: 'ABC',
    started: true,
    isNight: true,
    players: [{ id: 'p1', alive: true }, { id: 'p1', alive: false }, { id: 'p2' }],
    maxPlayers: 2,
    voteMode: true,
    voteDeadline: 0,
    votes: { p2: 'missing-player' },
}, { roomId: 'ABC', maxPlayers: 2 });
const stateCodes = audit.snapshot().findings.map((f) => f.code);
for (const code of ['DUPLICATE_PLAYER_ID','PLAYER_COUNT_OVER_MAX','PLAYER_ALIVE_FLAG_INVALID','STALE_TIMER','VOTE_TARGET_MISSING']) {
    assert(stateCodes.includes(code), `missing state invariant: ${code}`);
}

const beforeDom = audit.summary().findingCount;
audit.checkDomSnapshot({ selector:'#players', cardCount:4, zeroSizeCount:1, duplicateIdCount:1, missingLabelCount:1, outsideViewportCount:1, overflowPx:3, scrollOverflowPx:2 }, { expectedCount:3 });
assert(audit.summary().findingCount > beforeDom, 'DOM findings were not recorded');
for (const code of ['DOM_COUNT_DESYNC','DOM_ZERO_SIZE','DOM_DUPLICATE_PLAYER_ID','DOM_MISSING_PLAYER_LABEL','DOM_OUTSIDE_VIEWPORT','DOM_OVERFLOW']) {
    assert(audit.snapshot().findings.some((f) => f.code === code), `missing DOM finding: ${code}`);
}

audit.checkSocketBreadcrumb({ type:'socket', label:'ack.duplicate:vote', time:'t1', detail:{ operationId:'op1' } });
audit.checkSocketBreadcrumb({ type:'socket', label:'ack.timeout', time:'t2', detail:{ eventName:'vote' } });
audit.checkSocketBreadcrumb({ type:'socket', label:'ack:vote', time:'t3', detail:{ ok:false, ackCode:'NOPE' } });
for (const code of ['SOCKET_DUPLICATE_ACK','SOCKET_ACK_TIMEOUT','SOCKET_ACK_REJECTED']) {
    assert(audit.snapshot().findings.some((f) => f.code === code), `missing socket finding: ${code}`);
}

t += 6000;
audit.checkPerformance({ label:'API /api/config', durationMs:6000 }, { slowEventMs:5000 });
audit.slowStep('tests/slow.js', 25000, { stepIndex:2 });
assert(audit.snapshot().findings.some((f) => f.code === 'SLOW_EVENT'), 'slow event not detected');
assert(audit.snapshot().findings.some((f) => f.code === 'SLOW_TEST_STEP'), 'slow test step not detected');

const snap = audit.snapshot({ timelineLimit:10, findingLimit:20 });
assert(snap.summary.events >= 1, 'timeline was not recorded');
assert(snap.summary.findingCount >= 1, 'findings missing');
assert(!JSON.stringify(snap).includes('missing-player') || JSON.stringify(snap).includes('missing-player'), 'snapshot sanity');
assert(!JSON.stringify(snap.latestState || {}).includes('role'), 'state snapshot must not capture secret role fields');

const dedupe = createRuntimeAudit({ source:'dedupe', clock:() => 0 });
const a = dedupe.addFinding('runtime', 'TEST', 'same', { selector:'#x' }, 'error');
const b = dedupe.addFinding('runtime', 'TEST', 'same', { selector:'#x' }, 'error');
assert.strictEqual(a.id, b.id, 'identical findings must deduplicate');
assert.strictEqual(dedupe.summary().findingCount, 1, 'dedupe should keep one unique finding');
assert.strictEqual(b.count, 2, 'dedupe count should increment');

console.log('runtime-audit-engine-regression: PASS');
console.log(`findings=${audit.summary().findingCount} events=${audit.summary().events}`);
