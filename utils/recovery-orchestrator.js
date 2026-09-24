'use strict';

const { createRuntimeAudit, fingerprint } = require('./runtime-audit-engine');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeState(state) {
    const players = Array.isArray(state?.players)
        ? state.players.map((p) => ({ id: String(p.id || ''), alive: p.alive !== false })).sort((a, b) => a.id.localeCompare(b.id))
        : [];
    return {
        roomId: String(state?.roomId || ''),
        version: Number(state?.version) || 0,
        phase: String(state?.phase || ''),
        timer: Math.max(0, Number(state?.timer) || 0),
        players,
    };
}

function compareState(a, b) {
    const left = normalizeState(a);
    const right = normalizeState(b);
    const differences = [];
    for (const key of ['roomId', 'phase', 'timer']) {
        if (left[key] !== right[key]) differences.push({ field: key, expected: left[key], actual: right[key] });
    }
    if (left.players.length !== right.players.length) differences.push({ field: 'players.length', expected: left.players.length, actual: right.players.length });
    const byIdA = new Map(left.players.map((p) => [p.id, p]));
    const byIdB = new Map(right.players.map((p) => [p.id, p]));
    for (const id of new Set([...byIdA.keys(), ...byIdB.keys()])) {
        const pa = byIdA.get(id);
        const pb = byIdB.get(id);
        if (!pa || !pb) differences.push({ field: `players.${id}`, expected: pa || null, actual: pb || null });
        else if (pa.alive !== pb.alive) differences.push({ field: `players.${id}.alive`, expected: pa.alive, actual: pb.alive });
    }
    return { ok: differences.length === 0, differences, fingerprint: fingerprint([left.roomId, left.phase, left.timer, left.players]) };
}

function createRecoveryOrchestrator(options = {}) {
    const audit = options.audit || createRuntimeAudit({
        source: 'phase2-recovery',
        runId: String(options.runId || ''),
        scenarioId: String(options.scenarioId || 'recovery'),
        mode: 'phase2-recovery',
    });
    const attempts = [];
    const maxAttempts = Math.max(1, Math.min(8, Number(options.maxAttempts) || 3));

    function recover({ serverState, clientState, snapshotState, reason = 'fault', resyncAvailable = true } = {}) {
        const baseline = clone(serverState || {});
        let current = clone(clientState || {});
        let snapshot = snapshotState ? clone(snapshotState) : null;
        const attemptLog = [];
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const before = compareState(baseline, current);
            audit.record('recovery', 'recovery.attempt', { attempt, reason, beforeOk: before.ok }, { source: 'phase2-recovery' });
            attemptLog.push({ attempt, before });
            if (before.ok) break;
            if (!resyncAvailable) continue;
            if (!snapshot || Number(snapshot.version) < Number(baseline.version)) snapshot = clone(baseline);
            current = clone(snapshot);
            current.version = Number(baseline.version);
        }
        const final = compareState(baseline, current);
        const result = { ok: final.ok, attempts: attemptLog, final, recoveredState: normalizeState(current) };
        attempts.push(result);
        if (!result.ok) {
            audit.addFinding('recovery', 'RECOVERY_CONVERGENCE_FAILED', 'หลัง recovery แล้ว client/server state ยังไม่ converge', { reason, differences: final.differences, attempts: attemptLog.map((x) => ({ attempt:x.attempt, differences:x.before.differences })) }, 'critical', 'phase2-recovery');
        } else {
            audit.record('recovery', 'recovery.converged', { reason, attempts:attemptLog.length, stateFingerprint:final.fingerprint }, { source: 'phase2-recovery' });
        }
        return result;
    }

    return { audit, recover, attempts, compareState };
}

module.exports = { createRecoveryOrchestrator, compareState, normalizeState };
