'use strict';

const { createRuntimeAudit, fingerprint } = require('./runtime-audit-engine');

const FAULT_TYPES = Object.freeze([
    'socket.disconnect',
    'socket.delay',
    'socket.duplicate',
    'socket.reorder',
    'state.stale',
    'network.503',
    'network.timeout',
    'lifecycle.reload',
    'lifecycle.background',
    'concurrency.phase-change',
]);

function hashSeed(seed) {
    let h = 2166136261;
    const text = String(seed ?? '');
    for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed) {
    let a = hashSeed(seed) || 0x6d2b79f5;
    return function random() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(list, random) {
    return list[Math.floor(random() * list.length)] || list[0];
}

function createFaultInjector(options = {}) {
    const seed = String(options.seed || `phase2-${Date.now()}`);
    const random = mulberry32(seed);
    const audit = options.audit || createRuntimeAudit({
        source: 'phase2-chaos',
        runId: String(options.runId || ''),
        scenarioId: String(options.scenarioId || 'chaos'),
        mode: 'phase2-chaos',
    });
    const maxFaults = Math.max(1, Math.min(80, Number(options.maxFaults) || 8));
    let sequence = 0;
    const applied = [];

    function plan(count = maxFaults, allowedTypes = FAULT_TYPES) {
        const types = allowedTypes.filter((type) => FAULT_TYPES.includes(type));
        const selected = types.length ? types : FAULT_TYPES;
        const faults = [];
        for (let i = 0; i < Math.min(maxFaults, Math.max(0, Number(count) || 0)); i += 1) {
            const type = pick(selected, random);
            const fault = {
                index: i,
                type,
                atStep: Math.floor(random() * 16),
                delayMs: type === 'socket.delay' ? 100 + Math.floor(random() * 1900) : 0,
                count: type === 'socket.duplicate' ? 2 + Math.floor(random() * 2) : 1,
                id: fingerprint([seed, i, type]),
            };
            faults.push(fault);
        }
        return faults;
    }

    function applyFault(fault, context = {}) {
        const item = {
            ...fault,
            sequence: ++sequence,
            context: {
                step: Number(context.step) || 0,
                eventName: String(context.eventName || ''),
                operationId: String(context.operationId || ''),
            },
        };
        applied.push(item);
        audit.record('chaos', 'fault.inject', item, { source: 'phase2-chaos', severity: 'info' });
        return item;
    }

    function transformEvents(events, faults) {
        let out = Array.isArray(events) ? events.map((event, index) => ({ ...event, __index: index })) : [];
        const schedule = Array.isArray(faults) ? faults : [];
        for (const fault of schedule) {
            const targets = out.filter((event) => Number(event.step) >= Number(fault.atStep || 0));
            if (!targets.length) continue;
            const target = targets[0];
            applyFault(fault, { step: target.step, eventName: target.name, operationId: target.operationId });
            if (fault.type === 'socket.disconnect') {
                target.__faults = [...(target.__faults || []), 'disconnect'];
                target.__dropUntilRecovery = true;
            } else if (fault.type === 'socket.delay') {
                target.__delayMs = Math.max(Number(target.__delayMs) || 0, Number(fault.delayMs) || 0);
            } else if (fault.type === 'socket.duplicate') {
                const duplicates = [];
                for (let i = 0; i < fault.count; i += 1) duplicates.push({ ...target, __duplicate: true, __duplicateOf: target.__index });
                out.splice(out.indexOf(target) + 1, 0, ...duplicates);
            } else if (fault.type === 'socket.reorder') {
                const idx = out.indexOf(target);
                if (idx >= 0 && idx + 1 < out.length) {
                    const next = out[idx + 1];
                    out[idx] = next;
                    out[idx + 1] = target;
                }
            } else if (fault.type === 'state.stale') {
                target.__staleState = true;
            } else if (fault.type.startsWith('network.')) {
                target.__networkFault = fault.type;
            } else if (fault.type === 'lifecycle.reload' || fault.type === 'lifecycle.background' || fault.type === 'concurrency.phase-change') {
                target.__lifecycleFault = fault.type;
            }
        }
        return out.map((event) => {
            const clone = { ...event };
            delete clone.__index;
            return clone;
        });
    }

    return {
        seed,
        audit,
        random,
        plan,
        applyFault,
        transformEvents,
        applied,
        supportedFaults: FAULT_TYPES.slice(),
    };
}

module.exports = { FAULT_TYPES, createFaultInjector, hashSeed, mulberry32 };
