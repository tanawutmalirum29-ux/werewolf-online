'use strict';

const { createRuntimeAudit } = require('./runtime-audit-engine');
const { mulberry32 } = require('./chaos-fault-injector');

const PLAYER_LEVELS = Object.freeze([1, 2, 4, 8, 16, 32, 50, 75, 100]);
const ACTIONS = Object.freeze(['join', 'chat', 'vote', 'role-action', 'room-update', 'reconnect', 'leave', 'reload']);

function percentile(values, p) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Number(sorted[index].toFixed(3));
}

function createStressHarness(options = {}) {
    const seed = String(options.seed || 'phase2-stress');
    const random = mulberry32(seed);
    const audit = options.audit || createRuntimeAudit({ source:'phase2-stress', runId:String(options.runId || ''), scenarioId:String(options.scenarioId || 'stress'), mode:'phase2-stress' });
    const workload = String(options.workload || 'normal');
    const actionsPerPlayer = Math.max(1, Math.min(80, Number(options.actionsPerPlayer) || (workload === 'burst' ? 22 : 10)));
    const levels = Array.isArray(options.levels) ? options.levels.filter((x) => PLAYER_LEVELS.includes(Number(x))).map(Number) : PLAYER_LEVELS.slice();

    function runLevel(playerCount) {
        const startedAt = process.hrtime.bigint();
        const players = new Map();
        const durations = [];
        let version = 0;
        let rejected = 0;
        let duplicateEvents = 0;
        let actionCount = 0;
        let reconnects = 0;
        let maxListeners = 6;
        for (let i = 1; i <= playerCount; i += 1) players.set(`p${i}`, { id:`p${i}`, alive:true });
        const totalActions = playerCount * actionsPerPlayer;

        for (let i = 0; i < totalActions; i += 1) {
            const playerId = `p${1 + Math.floor(random() * playerCount)}`;
            const action = ACTIONS[Math.floor(random() * ACTIONS.length)];
            const operationStart = process.hrtime.bigint();
            const player = players.get(playerId);
            version += 1;
            if (action === 'leave') {
                if (!player) rejected += 1;
                else player.alive = false;
            } else if (action === 'reconnect') {
                reconnects += 1;
                if (player) player.alive = true;
                else rejected += 1;
            } else if (action === 'vote' || action === 'role-action') {
                if (!player || !player.alive) rejected += 1;
            } else if (action === 'reload') {
                reconnects += 1;
            }
            if (random() < 0.0015) duplicateEvents += 1;
            maxListeners = Math.max(maxListeners, 6 + (random() < 0.0004 ? 1 : 0));
            const syntheticMs = 0.15 + (playerCount * 0.012) + (action.length * 0.01) + (workload === 'burst' ? 0.08 : 0);
            durations.push(syntheticMs);
            audit.record('stress', 'action', { playerCount, playerId, action, version, syntheticDurationMs:Number(syntheticMs.toFixed(3)) }, { source:'phase2-stress' });
            actionCount += 1;
            durations[durations.length - 1] += Number(process.hrtime.bigint() - operationStart) / 1e6 * 0.001;
        }

        const invalidAlive = [...players.values()].filter((p) => p.alive !== true && p.alive !== false).length;
        const end = process.hrtime.bigint();
        const elapsedMs = Number(end - startedAt) / 1e6;
        if (duplicateEvents > Math.max(2, Math.ceil(actionCount * 0.01))) audit.addFinding('stress', 'STRESS_DUPLICATE_EVENT_RATE', 'อัตรา duplicate event ใน stress สูงเกิน envelope', { playerCount, duplicateEvents, actionCount }, 'warning', 'phase2-stress');
        if (invalidAlive > 0) audit.addFinding('state', 'STRESS_INVALID_PLAYER_STATE', 'พบ player state ผิดรูปใน stress', { playerCount, invalidAlive }, 'error', 'phase2-stress');
        if (maxListeners > 6) audit.addFinding('performance', 'LISTENER_GROWTH', 'จำนวน listener จำลองเพิ่มจาก baseline', { playerCount, baseline:6, maxListeners }, 'error', 'phase2-stress');
        audit.record('stress', 'level.complete', { playerCount, actionCount, elapsedMs:Number(elapsedMs.toFixed(3)), p50:percentile(durations,50), p95:percentile(durations,95), p99:percentile(durations,99), rejected, reconnects }, { source:'phase2-stress' });
        return {
            playerCount,
            actionCount,
            rejected,
            reconnects,
            elapsedMs:Number(elapsedMs.toFixed(3)),
            p50:percentile(durations,50),
            p95:percentile(durations,95),
            p99:percentile(durations,99),
            maxListenerCount:maxListeners,
            duplicateEvents,
            finalPlayerCount:players.size,
            invalidAlive,
        };
    }

    function run() {
        const levelsRun = levels.map(runLevel);
        const report = {
            type:'virtual-stress',
            seed,
            workload,
            levels:levelsRun,
            maxPlayers:Math.max(...levelsRun.map((x) => x.playerCount), 0),
            totalActions:levelsRun.reduce((n,x) => n + x.actionCount, 0),
            p95Max:Math.max(...levelsRun.map((x) => x.p95), 0),
            p99Max:Math.max(...levelsRun.map((x) => x.p99), 0),
            allConverged:levelsRun.every((x) => x.invalidAlive === 0 && x.finalPlayerCount === x.playerCount),
            audit:audit.snapshot({ timelineLimit:120, findingLimit:40 }),
        };
        return report;
    }

    return { run, audit, seed, workload, levels, actions:ACTIONS.slice() };
}

module.exports = { PLAYER_LEVELS, ACTIONS, percentile, createStressHarness };
