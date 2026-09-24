(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.WWRuntimeAuditEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SEVERITIES = { info: 0, warning: 1, error: 2, critical: 3 };
    const DEFAULT_LIMITS = {
        timeline: 600,
        findings: 160,
        slowEventMs: 2500,
        slowStepMs: 20000,
        domMutationBurst: 160,
        requestSlowMs: 5000,
    };

    function nowMs(clock) {
        try {
            const value = typeof clock === 'function' ? Number(clock()) : Date.now();
            return Number.isFinite(value) ? value : Date.now();
        } catch (_) { return Date.now(); }
    }

    function safeString(value, max = 1200) {
        if (value === null || value === undefined) return '';
        let out;
        try { out = typeof value === 'string' ? value : JSON.stringify(value); }
        catch (_) { out = String(value); }
        return String(out).slice(0, max);
    }

    function redactKey(key) {
        return /token|secret|password|authorization|cookie|accountToken|testerPass|googleSub|email|ipAddress|remoteAddress|hostname/i.test(String(key || ''));
    }

    function sanitizeString(value) {
        return String(value ?? '')
            .slice(0, 1200)
            .replace(/([?&](?:token|accountToken|testerPass|tp|ts|jr|ac|authorization|cookie|secret|password)=)[^&\s)]+/gi, '$1[REDACTED]')
            .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, '[REDACTED_CREDENTIAL]')
            .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
    }

    function safeStateSnapshot(state) {
        if (!state || typeof state !== 'object') return null;
        const out = {};
        ['roomId','id','started','gameOver','isNight','dayCount','nightCount','voteMode','voteDeadline','phaseDeadline','countdownDeadline','maxPlayers'].forEach((key) => {
            if (state[key] !== undefined) out[key] = state[key];
        });
        if (Array.isArray(state.players)) {
            out.players = state.players.slice(0, 160).map((player) => ({
                id: String(player?.id || '').slice(0, 120),
                alive: typeof player?.alive === 'boolean' ? player.alive : player?.alive,
                isHost: player?.isHost === true,
                hidden: player?.hidden === true,
            }));
        }
        return out;
    }

    function sanitize(value, depth = 0) {
        if (depth > 4) return '[MAX_DEPTH]';
        if (value === null || value === undefined) return value == null ? '' : value;
        if (typeof value === 'string') return sanitizeString(value);
        if (typeof value === 'number' || typeof value === 'boolean') return value;
        if (Array.isArray(value)) return value.slice(0, 40).map((item) => sanitize(item, depth + 1));
        if (typeof value === 'object') {
            const out = {};
            for (const key of Object.keys(value).slice(0, 60)) {
                if (redactKey(key)) continue;
                out[String(key).slice(0, 100)] = sanitize(value[key], depth + 1);
            }
            return out;
        }
        return String(value).slice(0, 1200);
    }

    function fingerprint(parts) {
        const raw = (Array.isArray(parts) ? parts : [parts]).map((value) => safeString(value, 300)).join('|');
        let hash = 2166136261;
        for (let i = 0; i < raw.length; i += 1) {
            hash ^= raw.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function finiteNonNegative(value) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    }

    function normalizePlayers(players) {
        return Array.isArray(players) ? players.filter(Boolean) : [];
    }

    function visiblePlayerCount(state) {
        const players = normalizePlayers(state && state.players);
        return players.filter((player) => player && player.isHost !== true && player.hidden !== true).length;
    }

    function phaseKey(state) {
        if (!state) return 'unknown';
        if (state.gameOver) return 'gameover';
        if (!state.started) return 'lobby';
        return state.isNight ? 'night' : 'day';
    }

    function createRuntimeAudit(options = {}) {
        const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
        const clock = options.clock;
        const startedAt = nowMs(clock);
        const meta = sanitize({
            source: options.source || 'runtime',
            runId: options.runId || '',
            scenarioId: options.scenarioId || '',
            page: options.page || '',
            mode: options.mode || '',
        });
        const timeline = [];
        const findings = [];
        const findingByFingerprint = new Map();
        const seenEventKeys = new Set();
        const stateHistory = [];
        let latestState = null;
        let latestDom = null;
        let lastPhase = null;
        let mutationBurstStartedAt = 0;
        let mutationBurstCount = 0;

        const counters = {
            events: 0,
            findings: 0,
            info: 0,
            warnings: 0,
            errors: 0,
            critical: 0,
            networkFailures: 0,
            networkSlow: 0,
            socketEvents: 0,
            socketProblems: 0,
            domAnomalies: 0,
            stateAnomalies: 0,
            performanceAnomalies: 0,
            slowSteps: 0,
        };

        function pushTimeline(type, label, detail = {}, severity = 'info', source = 'runtime', at = null) {
            const time = at == null ? nowMs(clock) : Number(at);
            const item = {
                seq: counters.events + 1,
                elapsedMs: Math.max(0, time - startedAt),
                at: new Date(Date.now() + (time - nowMs(clock))).toISOString(),
                type: String(type || 'event').slice(0, 40),
                label: String(label || '').slice(0, 180),
                severity: String(severity || 'info').slice(0, 16),
                source: String(source || 'runtime').slice(0, 24),
                detail: sanitize(detail),
            };
            counters.events += 1;
            timeline.push(item);
            if (timeline.length > limits.timeline) timeline.splice(0, timeline.length - limits.timeline);
            return item;
        }

        function addFinding(category, code, message, detail = {}, severity = 'error', source = 'runtime') {
            const safeSeverity = Object.prototype.hasOwnProperty.call(SEVERITIES, severity) ? severity : 'error';
            const fp = fingerprint([category, code, message, detail && (detail.selector || detail.eventName || detail.testPath || detail.phase || '')]);
            const existing = findingByFingerprint.get(fp);
            if (existing) {
                existing.count += 1;
                existing.lastSeenElapsedMs = Math.max(0, nowMs(clock) - startedAt);
                return existing;
            }
            const item = {
                id: `audit-${Date.now().toString(36)}-${(findings.length + 1).toString(36)}`,
                fingerprint: fp,
                category: String(category || 'runtime').slice(0, 40),
                code: String(code || 'RUNTIME_ANOMALY').slice(0, 80),
                severity: safeSeverity,
                message: safeString(message, 1200),
                detail: sanitize(detail),
                firstSeenElapsedMs: Math.max(0, nowMs(clock) - startedAt),
                lastSeenElapsedMs: Math.max(0, nowMs(clock) - startedAt),
                count: 1,
                source: String(source || 'runtime').slice(0, 24),
            };
            findings.push(item);
            findingByFingerprint.set(fp, item);
            if (findings.length > limits.findings) findings.splice(0, findings.length - limits.findings);
            counters.findings += 1;
            if (safeSeverity === 'critical') counters.critical += 1;
            else if (safeSeverity === 'error') counters.errors += 1;
            else if (safeSeverity === 'warning') counters.warnings += 1;
            else counters.info += 1;
            if (category === 'network') counters.networkFailures += 1;
            if (category === 'socket') counters.socketProblems += 1;
            if (category === 'dom') counters.domAnomalies += 1;
            if (category === 'state') counters.stateAnomalies += 1;
            if (category === 'performance') counters.performanceAnomalies += 1;
            pushTimeline('finding', code, { severity: safeSeverity, message: safeString(message, 500), detail }, safeSeverity, source);
            return item;
        }

        function record(type, label, detail = {}, opts = {}) {
            const severity = opts.severity || 'info';
            const source = opts.source || 'runtime';
            const item = pushTimeline(type, label, detail, severity, source, opts.at);
            if (opts.findingCode) addFinding(opts.category || type, opts.findingCode, opts.message || label, detail, severity, source);
            return item;
        }

        function checkStateInvariants(state, expected = {}) {
            if (!state || typeof state !== 'object') return [];
            latestState = safeStateSnapshot(state);
            const players = normalizePlayers(state.players);
            const findingsBefore = findings.length;
            const ids = players.map((player) => String(player.id || '')).filter(Boolean);
            const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
            if (duplicates.length) addFinding('state', 'DUPLICATE_PLAYER_ID', 'พบ player id ซ้ำใน state', { duplicates: [...new Set(duplicates)].slice(0, 12) }, 'error', 'state');
            if (state.players != null && !Array.isArray(state.players)) addFinding('state', 'PLAYERS_NOT_ARRAY', 'state.players ไม่ใช่ array', { type: typeof state.players }, 'error', 'state');
            const aliveCount = players.filter((player) => player.alive === true).length;
            const deadCount = players.filter((player) => player.alive === false).length;
            if (aliveCount + deadCount !== players.length) addFinding('state', 'PLAYER_ALIVE_FLAG_INVALID', 'ผู้เล่นบางคนไม่มี alive เป็น boolean ที่คาดไว้', { total: players.length, aliveCount, deadCount }, 'warning', 'state');
            if (expected.maxPlayers != null && players.length > Number(expected.maxPlayers)) addFinding('state', 'PLAYER_COUNT_OVER_MAX', 'จำนวนผู้เล่นเกิน maxPlayers', { total: players.length, maxPlayers: Number(expected.maxPlayers) }, 'critical', 'state');
            if (state.roomId && expected.roomId && String(state.roomId).toUpperCase() !== String(expected.roomId).toUpperCase()) addFinding('state', 'ROOM_ID_DESYNC', 'room id ของ state ไม่ตรงกับ room ที่กำลังตรวจ', { stateRoomId: state.roomId, expectedRoomId: expected.roomId }, 'critical', 'state');
            const phase = phaseKey(state);
            if (state.started && !state.gameOver && !['day', 'night'].includes(phase)) addFinding('state', 'UNKNOWN_PHASE', 'game state อยู่ใน phase ที่ตรวจไม่รู้จัก', { phase, started: !!state.started, isNight: !!state.isNight }, 'error', 'state');
            if (lastPhase && phase !== lastPhase) {
                pushTimeline('state', 'phase.change', { from: lastPhase, to: phase, dayCount: state.dayCount, nightCount: state.nightCount }, 'info', 'state');
            }
            lastPhase = phase;
            const deadlines = ['voteDeadline', 'phaseDeadline', 'countdownDeadline'].filter((key) => state[key] != null);
            deadlines.forEach((key) => {
                const deadline = Number(state[key]);
                if (!Number.isFinite(deadline)) addFinding('state', 'INVALID_TIMER', `timer ${key} ไม่ใช่ตัวเลข`, { key, value: state[key] }, 'error', 'state');
                else if (state.voteMode === true && key === 'voteDeadline' && deadline < Date.now() - 5000 && !state.gameOver) addFinding('state', 'STALE_TIMER', 'vote timer หมดเวลาแต่ state ยังอยู่ใน vote mode', { key, deadline, ageMs: Date.now() - deadline }, 'warning', 'state');
            });
            ['votes', 'wolfKillVotes', 'shieldTargets', 'curseTargets', 'cultActions', 'banditActions', 'banditKillVotes'].forEach((key) => {
                const value = state[key];
                if (!value || typeof value !== 'object') return;
                Object.entries(value).slice(0, 300).forEach(([actor, target]) => {
                    const candidate = Array.isArray(target) ? target : [target];
                    candidate.forEach((targetId) => {
                        if (targetId == null || targetId === '') return;
                        const targetPlayer = players.find((player) => String(player.id) === String(targetId));
                        if (!targetPlayer) addFinding('state', 'VOTE_TARGET_MISSING', `${key} ชี้ไปยัง player ที่ไม่มีใน state`, { key, actor, targetId }, 'error', 'state');
                    });
                });
            });
            stateHistory.push({ at: Date.now(), phase, roomId: String(state.roomId || ''), playerCount: players.length, started: !!state.started, gameOver: !!state.gameOver, dayCount: finiteNonNegative(state.dayCount), nightCount: finiteNonNegative(state.nightCount) });
            if (stateHistory.length > 120) stateHistory.splice(0, stateHistory.length - 120);
            return findings.slice(findingsBefore);
        }

        function checkDomSnapshot(dom = {}, expected = {}) {
            if (!dom || typeof dom !== 'object') return [];
            latestDom = sanitize(dom);
            const findingsBefore = findings.length;
            const selector = String(dom.selector || '');
            if (expected.expectedCount != null && Number.isFinite(Number(dom.cardCount)) && Number(dom.cardCount) !== Number(expected.expectedCount)) {
                addFinding('dom', 'DOM_COUNT_DESYNC', 'จำนวนการ์ดใน DOM ไม่ตรงกับ state', { selector, expected: Number(expected.expectedCount), actual: Number(dom.cardCount) }, 'error', 'dom');
            }
            if (Number(dom.zeroSizeCount) > 0) addFinding('dom', 'DOM_ZERO_SIZE', 'พบ element การ์ดที่มีขนาด 0', { selector, zeroSizeCount: Number(dom.zeroSizeCount) }, 'warning', 'dom');
            if (Number(dom.overflowPx) > 1.25 || Number(dom.scrollOverflowPx) > 1.25) addFinding('dom', 'DOM_OVERFLOW', 'พบการ์ดหรือ container ล้นพื้นที่ที่ควรแสดง', { selector, overflowPx: Number(dom.overflowPx) || 0, scrollOverflowPx: Number(dom.scrollOverflowPx) || 0 }, 'error', 'dom');
            if (Number(dom.duplicateIdCount) > 0) addFinding('dom', 'DOM_DUPLICATE_PLAYER_ID', 'พบ player id ซ้ำใน DOM', { selector, duplicateIdCount: Number(dom.duplicateIdCount) }, 'error', 'dom');
            if (Number(dom.missingLabelCount) > 0) addFinding('dom', 'DOM_MISSING_PLAYER_LABEL', 'พบการ์ดผู้เล่นที่ไม่มีชื่อ/ป้ายที่แสดงผลได้', { selector, missingLabelCount: Number(dom.missingLabelCount) }, 'warning', 'dom');
            if (Number(dom.outsideViewportCount) > 0) addFinding('dom', 'DOM_OUTSIDE_VIEWPORT', 'พบการ์ดผู้เล่นอยู่นอกพื้นที่แสดงผล', { selector, outsideViewportCount: Number(dom.outsideViewportCount) }, 'error', 'dom');
            return findings.slice(findingsBefore);
        }

        function checkPerformance(metric = {}, thresholds = {}) {
            const duration = Number(metric.durationMs);
            if (!Number.isFinite(duration)) return [];
            const findingsBefore = findings.length;
            const slow = Number(thresholds.slowEventMs || limits.slowEventMs);
            if (String(metric.category || metric.type || '').toLowerCase() === 'network' && duration >= slow) counters.networkSlow += 1;
            if (duration >= slow) addFinding('performance', 'SLOW_EVENT', `${metric.label || metric.name || 'event'} ใช้เวลานาน`, { ...metric, thresholdMs: slow }, duration >= slow * 3 ? 'error' : 'warning', 'performance');
            return findings.slice(findingsBefore);
        }

        function checkSocketBreadcrumb(crumb = {}) {
            const label = String(crumb.label || '');
            const detail = crumb.detail || {};
            counters.socketEvents += 1;
            const key = `${label}|${detail.operationId || ''}|${crumb.time || ''}`;
            if (seenEventKeys.has(key)) addFinding('socket', 'SOCKET_BREADCRUMB_DUPLICATE', 'พบ socket breadcrumb ซ้ำ', { label, operationId: detail.operationId || '' }, 'warning', 'socket');
            else seenEventKeys.add(key);
            if (label.indexOf('ack.duplicate:') === 0) addFinding('socket', 'SOCKET_DUPLICATE_ACK', 'Socket callback ถูกเรียก ACK ซ้ำ', { label, operationId: detail.operationId || '', elapsedMs: detail.elapsedMs }, 'error', 'socket');
            if (label === 'ack.timeout') addFinding('socket', 'SOCKET_ACK_TIMEOUT', 'Socket event ไม่ได้รับ ACK ภายในเวลาที่กำหนด', detail, 'error', 'socket');
            if (label.indexOf('connect_error') === 0) addFinding('socket', 'SOCKET_CONNECT_ERROR', 'Socket เชื่อมต่อไม่ได้', detail, 'error', 'socket');
            if (label.indexOf('disconnect') === 0) addFinding('socket', 'SOCKET_DISCONNECTED', 'Socket หลุดจากเซิร์ฟเวอร์', detail, 'warning', 'socket');
            if (label.indexOf('ack:') === 0 && detail.ok === false) addFinding('socket', 'SOCKET_ACK_REJECTED', 'Socket ACK ตอบกลับเป็น rejection', detail, 'error', 'socket');
            return findings.slice(-5);
        }

        function observeMutation(count, detail = {}) {
            const now = nowMs(clock);
            if (!mutationBurstStartedAt || now - mutationBurstStartedAt > 1000) {
                mutationBurstStartedAt = now;
                mutationBurstCount = 0;
            }
            mutationBurstCount += Math.max(1, Number(count) || 1);
            if (mutationBurstCount >= limits.domMutationBurst) addFinding('dom', 'DOM_MUTATION_BURST', 'DOM มีการเปลี่ยนแปลงถี่ผิดปกติภายในช่วงสั้น', { count: mutationBurstCount, windowMs: now - mutationBurstStartedAt, ...detail }, 'warning', 'dom');
        }

        function slowStep(label, durationMs, detail = {}) {
            const duration = Number(durationMs);
            if (!Number.isFinite(duration)) return null;
            if (duration >= limits.slowStepMs) {
                counters.slowSteps += 1;
                return addFinding('performance', 'SLOW_TEST_STEP', `${label || 'test step'} ใช้เวลานานเกินกำหนด`, { durationMs: duration, thresholdMs: limits.slowStepMs, ...detail }, 'warning', 'bug-replay');
            }
            return null;
        }

        function summary() {
            const severity = counters.critical ? 'critical' : counters.errors ? 'error' : counters.warnings ? 'warning' : 'ok';
            return {
                status: severity,
                durationMs: Math.max(0, nowMs(clock) - startedAt),
                ...counters,
                timelineCount: timeline.length,
                findingCount: findings.length,
                uniqueFindings: findingByFingerprint.size,
                topCodes: [...findings].sort((a, b) => (SEVERITIES[b.severity] - SEVERITIES[a.severity]) || (b.count - a.count)).slice(0, 12).map((f) => ({ code: f.code, severity: f.severity, count: f.count })),
                phase: lastPhase || (latestState ? phaseKey(latestState) : ''),
                playerCount: latestState ? visiblePlayerCount(latestState) : null,
            };
        }

        function snapshot(options = {}) {
            const timelineLimit = Math.max(1, Number(options.timelineLimit) || 160);
            const findingLimit = Math.max(1, Number(options.findingLimit) || 80);
            return {
                meta,
                summary: summary(),
                latestState: sanitize(latestState),
                latestDom: sanitize(latestDom),
                timeline: timeline.slice(-timelineLimit),
                findings: findings.slice(-findingLimit),
                stateHistory: stateHistory.slice(-80),
            };
        }

        return {
            meta,
            record,
            addFinding,
            checkStateInvariants,
            checkDomSnapshot,
            checkPerformance,
            checkSocketBreadcrumb,
            observeMutation,
            slowStep,
            summary,
            snapshot,
            sanitize,
            fingerprint,
            limits,
        };
    }

    return { createRuntimeAudit, sanitize, fingerprint, SEVERITIES };
});
