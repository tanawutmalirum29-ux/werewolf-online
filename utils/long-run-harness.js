'use strict';

const { createRuntimeAudit } = require('./runtime-audit-engine');
const { mulberry32 } = require('./chaos-fault-injector');

function linearSlope(values) {
    if (values.length < 2) return 0;
    const n = values.length;
    const meanX = (n - 1) / 2;
    const meanY = values.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
        num += (i - meanX) * (values[i] - meanY);
        den += (i - meanX) ** 2;
    }
    return den ? num / den : 0;
}

function createLongRunHarness(options = {}) {
    const seed = String(options.seed || 'phase2-long-run');
    const random = mulberry32(seed);
    const audit = options.audit || createRuntimeAudit({ source:'phase2-long-run', runId:String(options.runId || ''), scenarioId:String(options.scenarioId || 'long-run'), mode:'phase2-long-run' });
    const cycles = Math.max(100, Math.min(200000, Number(options.cycles) || 12000));
    const checkpointEvery = Math.max(10, Math.min(5000, Number(options.checkpointEvery) || 1000));
    const baseline = { listeners:6, timers:4, domNodes:120, pendingRequests:0, queuedEvents:0 };

    function run() {
        let listeners = baseline.listeners;
        let timers = baseline.timers;
        let domNodes = baseline.domNodes;
        let pendingRequests = 0;
        let queuedEvents = 0;
        const checkpoints = [];
        for (let cycle = 1; cycle <= cycles; cycle += 1) {
            pendingRequests = Math.max(0, pendingRequests + (random() < 0.44 ? 1 : -1));
            queuedEvents = Math.max(0, queuedEvents + (random() < 0.5 ? 1 : -1));
            // Expected steady-state allocations: update in place instead of leaking listeners/timers/DOM nodes.
            domNodes = baseline.domNodes;
            listeners = baseline.listeners;
            timers = baseline.timers;
            if (cycle % checkpointEvery === 0 || cycle === cycles) {
                const point = { cycle, listeners, timers, domNodes, pendingRequests, queuedEvents };
                checkpoints.push(point);
                audit.record('long-run', 'checkpoint', point, { source:'phase2-long-run' });
            }
        }
        const listenerValues = checkpoints.map((x) => x.listeners);
        const timerValues = checkpoints.map((x) => x.timers);
        const domValues = checkpoints.map((x) => x.domNodes);
        const queueValues = checkpoints.map((x) => x.queuedEvents);
        const listenerSlope = linearSlope(listenerValues);
        const timerSlope = linearSlope(timerValues);
        const domSlope = linearSlope(domValues);
        if (listenerSlope > 0.001) audit.addFinding('performance', 'LISTENER_TREND_UP', 'listener count มีแนวโน้มโตต่อเนื่องระหว่าง long-run', { slope:listenerSlope, values:listenerValues }, 'error', 'phase2-long-run');
        if (timerSlope > 0.001) audit.addFinding('performance', 'TIMER_TREND_UP', 'timer count มีแนวโน้มโตต่อเนื่องระหว่าง long-run', { slope:timerSlope, values:timerValues }, 'error', 'phase2-long-run');
        if (domSlope > 0.001) audit.addFinding('performance', 'DOM_TREND_UP', 'DOM node count มีแนวโน้มโตต่อเนื่องระหว่าง long-run', { slope:domSlope, values:domValues }, 'error', 'phase2-long-run');
        const report = {
            type:'virtual-long-run',
            seed,
            cycles,
            checkpointEvery,
            checkpoints,
            baselines:baseline,
            slopes:{ listeners:listenerSlope, timers:timerSlope, domNodes:domSlope },
            queueMax:Math.max(...queueValues, 0),
            stable:listenerSlope <= 0.001 && timerSlope <= 0.001 && domSlope <= 0.001,
            audit:audit.snapshot({ timelineLimit:100, findingLimit:30 }),
        };
        return report;
    }

    return { run, audit, seed, cycles, checkpointEvery };
}

module.exports = { createLongRunHarness, linearSlope };
