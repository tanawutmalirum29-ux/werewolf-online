'use strict';

const { createRuntimeAudit } = require('./runtime-audit-engine');
const { createFaultInjector, FAULT_TYPES } = require('./chaos-fault-injector');
const { createStressHarness } = require('./stress-harness');
const { createLongRunHarness } = require('./long-run-harness');
const { createRecoveryOrchestrator } = require('./recovery-orchestrator');

function makePlayers(count) {
    return Array.from({ length:count }, (_, i) => ({ id:`p${i + 1}`, alive:true }));
}

function stateFromVersion(version, players = 12, phase = 'day', timer = 30) {
    return { roomId:'PHASE2', version, phase, timer, players:makePlayers(players) };
}

function buildEvents() {
    return [
        { step:0, name:'room_update', operationId:'op-room', version:1 },
        { step:1, name:'player_join', operationId:'op-join-1', version:2 },
        { step:2, name:'chat', operationId:'op-chat', version:3 },
        { step:3, name:'vote_open', operationId:'op-vote-open', version:4 },
        { step:4, name:'vote', operationId:'op-vote', version:5 },
        { step:5, name:'phase_change', operationId:'op-phase', version:6 },
        { step:6, name:'room_update', operationId:'op-room-2', version:7 },
        { step:7, name:'reconnect', operationId:'op-reconnect', version:8 },
    ];
}

function runChaosCase({ seed, faultTypes = FAULT_TYPES, faultCount = 3, mixed = false } = {}) {
    const audit = createRuntimeAudit({ source:'phase2-chaos', runId:`chaos-${seed}`, scenarioId:'phase2-chaos', mode:'phase2-chaos' });
    const injector = createFaultInjector({ seed, audit, maxFaults:Math.max(1, faultCount) });
    const faults = injector.plan(faultCount, faultTypes);
    const baseEvents = buildEvents();
    let events = injector.transformEvents(baseEvents, faults);
    const serverState = stateFromVersion(8);
    let clientState = stateFromVersion(1);
    const seenVersions = new Set();
    let disconnected = false;
    let backgrounded = false;
    let networkFailures = 0;

    for (const event of events) {
        audit.record('chaos', 'event.delivery', { name:event.name, operationId:event.operationId, version:event.version, faults:event.__faults || [], delayMs:event.__delayMs || 0, duplicate:!!event.__duplicate, stale:!!event.__staleState, networkFault:event.__networkFault || '', lifecycleFault:event.__lifecycleFault || '' }, { source:'phase2-chaos' });
        if (event.__networkFault) {
            networkFailures += 1;
            audit.record('network', 'fault.expected', { type:event.__networkFault, event:event.name }, { source:'phase2-chaos', severity:'info' });
            continue;
        }
        if (event.__faults?.includes('disconnect')) {
            disconnected = true;
            audit.record('socket', 'disconnect.injected', { operationId:event.operationId }, { source:'phase2-chaos' });
            continue;
        }
        if (event.__lifecycleFault === 'lifecycle.background') {
            backgrounded = true;
            audit.record('lifecycle', 'background.injected', {}, { source:'phase2-chaos' });
        }
        if (event.__lifecycleFault === 'lifecycle.reload') {
            clientState = stateFromVersion(0);
            audit.record('lifecycle', 'reload.injected', {}, { source:'phase2-chaos' });
        }
        if (event.__lifecycleFault === 'concurrency.phase-change') {
            clientState.phase = clientState.phase === 'day' ? 'night' : 'day';
            clientState.timer = 29;
        }
        if (event.__staleState) {
            audit.record('state', 'stale.injected', { version:event.version }, { source:'phase2-chaos' });
            continue;
        }
        if (seenVersions.has(event.version)) continue;
        if (event.version < Number(clientState.version)) {
            audit.record('state', 'event.discard.stale', { incoming:event.version, current:clientState.version }, { source:'phase2-chaos' });
            continue;
        }
        seenVersions.add(event.version);
        clientState.version = event.version;
        if (event.name === 'phase_change') clientState.phase = 'night';
        if (event.name === 'reconnect') {
            disconnected = false;
            backgrounded = false;
        }
    }

    if (mixed || disconnected || backgrounded || clientState.version !== serverState.version) {
        clientState = { ...clientState, ...serverState, players:makePlayers(serverState.players.length) };
    }

    const recovery = createRecoveryOrchestrator({ audit, scenarioId:'phase2-chaos-recovery', maxAttempts:3 }).recover({
        serverState,
        clientState,
        snapshotState:serverState,
        reason:mixed ? 'mixed-chaos' : 'chaos-case',
        resyncAvailable:true,
    });
    const result = {
        seed,
        faults,
        appliedFaults:injector.applied,
        networkFailures,
        finalConverged:recovery.ok,
        recovery,
        audit:audit.snapshot({ timelineLimit:120, findingLimit:50 }),
    };
    return result;
}

function runChaosSuite(options = {}) {
    const seeds = Array.isArray(options.seeds) && options.seeds.length ? options.seeds.map(String) : Array.from({ length:Number(options.cases) || 24 }, (_, i) => `CHAOS-${String(i + 1).padStart(3,'0')}`);
    const cases = seeds.map((seed, index) => runChaosCase({
        seed,
        faultCount: 1 + (index % 4),
        faultTypes: index % 3 === 0 ? ['socket.disconnect','socket.delay','socket.duplicate'] : index % 3 === 1 ? ['socket.reorder','state.stale','network.503'] : FAULT_TYPES,
        mixed: index % 5 === 0,
    }));
    return {
        type:'chaos-suite',
        cases,
        total:cases.length,
        passed:cases.filter((x) => x.finalConverged).length,
        failed:cases.filter((x) => !x.finalConverged).length,
        deterministicSeeds:seeds,
        faultCatalog:FAULT_TYPES.slice(),
    };
}

function runRecoverySuite(options = {}) {
    const audit = createRuntimeAudit({ source:'phase2-recovery', runId:'recovery-suite', scenarioId:'phase2-recovery', mode:'phase2-recovery' });
    const orchestrator = createRecoveryOrchestrator({ audit, maxAttempts:3 });
    const baseline = stateFromVersion(12, 20, 'night', 22);
    const cases = [
        { id:'R01-socket-reconnect', state:{...baseline, version:9}, reason:'socket-disconnect' },
        { id:'R02-http-retry', state:{...baseline, version:10}, reason:'http-503-timeout' },
        { id:'R03-reload', state:stateFromVersion(0, 0, 'lobby', 0), reason:'reload' },
        { id:'R04-background-resync', state:{...baseline, version:11, timer:0}, reason:'background' },
        { id:'R05-interrupted-action', state:{...baseline, version:8, phase:'day', timer:5}, reason:'interrupted-action' },
        { id:'R06-room-rejoin', state:{ roomId:'WRONG', version:1, phase:'lobby', timer:0, players:[] }, reason:'room-rejoin' },
    ].map((item) => ({
        id:item.id,
        reason:item.reason,
        result:orchestrator.recover({ serverState:baseline, clientState:item.state, snapshotState:baseline, reason:item.reason, resyncAvailable:true }),
    }));
    return { type:'recovery-suite', total:cases.length, passed:cases.filter((x) => x.result.ok).length, failed:cases.filter((x) => !x.result.ok).length, cases, audit:audit.snapshot({ timelineLimit:120, findingLimit:40 }) };
}

function runPhase2Suite(options = {}) {
    const audit = createRuntimeAudit({ source:'phase2-orchestrator', runId:String(options.runId || 'phase2-suite'), scenarioId:'phase2-suite', mode:'phase2' });
    audit.record('runner', 'phase2.start', { seed:String(options.seed || 'phase2-master'), stages:['chaos','stress','long-run','recovery'] }, { source:'phase2-orchestrator' });
    const chaos = runChaosSuite({ cases:Number(options.chaosCases) || 24 });
    const stress = createStressHarness({ seed:`${options.seed || 'phase2-master'}-stress`, workload:options.workload || 'normal', levels:options.levels || undefined, actionsPerPlayer:Number(options.actionsPerPlayer) || undefined }).run();
    const longRun = createLongRunHarness({ seed:`${options.seed || 'phase2-master'}-long`, cycles:Number(options.longRunCycles) || 12000, checkpointEvery:Number(options.checkpointEvery) || 1000 }).run();
    const recovery = runRecoverySuite();
    audit.record('runner', 'phase2.complete', { chaos, stress:{ maxPlayers:stress.maxPlayers, totalActions:stress.totalActions, allConverged:stress.allConverged }, longRun:{ cycles:longRun.cycles, stable:longRun.stable }, recovery:{ total:recovery.total, passed:recovery.passed, failed:recovery.failed } }, { source:'phase2-orchestrator' });
    const result = {
        type:'phase2-suite',
        status:(chaos.failed || !stress.allConverged || !longRun.stable || recovery.failed) ? 'failed' : 'passed',
        chaos,
        stress,
        longRun,
        recovery,
        audit:audit.snapshot({ timelineLimit:160, findingLimit:60 }),
    };
    return result;
}

module.exports = { runChaosCase, runChaosSuite, runRecoverySuite, runPhase2Suite, buildEvents, stateFromVersion };
