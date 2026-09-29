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
        domMutationGraceMs: 1500,
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
        let latestStateCapture = null;
        let latestDomCapture = null;
        let lastPhase = null;
        let mutationBurstStartedAt = 0;
        let mutationBurstCount = 0;
        const actionHistory = [];
        const actionRuns = new Map();
        let actionSeq = 0;

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
            actionsRegistered: 0,
            actionsStarted: 0,
            actionsPassed: 0,
            actionsFailed: 0,
            actionsSkipped: 0,
            actionsBlocked: 0,
            actionsTimedOut: 0,
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

        function registerActions(actions = []) {
            const list = Array.isArray(actions) ? actions : [];
            counters.actionsRegistered = Math.max(counters.actionsRegistered, list.length);
            pushTimeline('action', 'actions.registered', { count:list.length }, 'info', 'action-engine');
            return list.length;
        }

        function beginAction(action, detail = {}) {
            const def = typeof action === 'string' ? { id:action } : (action || {});
            const id = String(def.id || def.actionId || `action-${actionSeq + 1}`);
            const runId = `action-run-${Date.now().toString(36)}-${(++actionSeq).toString(36)}`;
            const startedAtMs = nowMs(clock);
            const run = { runId, actionId:id, page:String(def.page || meta.page || ''), actor:String(def.actor || ''), group:String(def.group || ''), kind:String(def.kind || ''), mode:String(def.mode || ''), startedAtMs, detail:sanitize(detail), status:'running' };
            actionRuns.set(runId, run);
            counters.actionsStarted += 1;
            pushTimeline('action', 'action.start', run, 'info', 'action-engine');
            return run;
        }

        function finishAction(handle, outcome = {}) {
            const run = typeof handle === 'string' ? actionRuns.get(handle) : handle;
            if (!run || run.status !== 'running') return run || null;
            const status = ['passed','failed','skipped','blocked','timeout'].includes(String(outcome.status)) ? String(outcome.status) : (outcome.ok ? 'passed' : 'failed');
            run.status = status;
            run.completedAtMs = nowMs(clock);
            run.durationMs = Math.max(0, run.completedAtMs - run.startedAtMs);
            run.detail = sanitize({ ...(run.detail || {}), ...(outcome.detail || {}) });
            run.expected = sanitize(outcome.expected || {});
            run.actual = sanitize(outcome.actual || {});
            run.message = safeString(outcome.message || '', 700);
            run.findingCode = safeString(outcome.findingCode || '', 100);
            actionRuns.delete(run.runId);
            actionHistory.push(sanitize(run));
            if (actionHistory.length > 180) actionHistory.splice(0, actionHistory.length - 180);
            if (status === 'passed') counters.actionsPassed += 1;
            else if (status === 'failed') counters.actionsFailed += 1;
            else if (status === 'skipped') counters.actionsSkipped += 1;
            else if (status === 'blocked') counters.actionsBlocked += 1;
            else if (status === 'timeout') { counters.actionsTimedOut += 1; counters.actionsFailed += 1; }
            pushTimeline('action', `action.${status}`, run, status === 'passed' ? 'info' : (status === 'skipped' || status === 'blocked' ? 'warning' : 'error'), 'action-engine');
            if (['failed','timeout'].includes(status)) {
                addFinding('action', outcome.findingCode || 'ACTION_OUTCOME_FAILED', outcome.message || `Action ${run.actionId} ไม่ได้ผลตามที่คาด`, { action:run, expected:outcome.expected || {}, actual:outcome.actual || {} }, status === 'timeout' ? 'error' : (outcome.severity || 'error'), 'action-engine');
            }
            return run;
        }

        function recordActionObservation(action, outcome = {}) {
            const run = beginAction(action, outcome.detail || {});
            return finishAction(run, outcome);
        }

        function actionCoverage() {
            const registered = counters.actionsRegistered;
            const attempted = counters.actionsStarted;
            return {
                registered, attempted, passed:counters.actionsPassed, failed:counters.actionsFailed, skipped:counters.actionsSkipped, blocked:counters.actionsBlocked, timedOut:counters.actionsTimedOut,
                passRate: attempted ? Number((counters.actionsPassed / attempted * 100).toFixed(1)) : null,
                recent: actionHistory.slice(-80),
            };
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
            latestStateCapture = { id: String(expected.captureId || ''), at: nowMs(clock) };
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
            stateHistory.push({ at: Date.now(), captureId: String(expected.captureId || ''), phase, roomId: String(state.roomId || ''), playerCount: players.length, started: !!state.started, gameOver: !!state.gameOver, dayCount: finiteNonNegative(state.dayCount), nightCount: finiteNonNegative(state.nightCount) });
            if (stateHistory.length > 120) stateHistory.splice(0, stateHistory.length - 120);
            return findings.slice(findingsBefore);
        }

        function checkDomSnapshot(dom = {}, expected = {}) {
            if (!dom || typeof dom !== 'object') return [];
            if (expected.stateCaptureId && dom.captureId && String(expected.stateCaptureId) !== String(dom.captureId)) {
                addFinding('dom', 'STATE_DOM_CAPTURE_MISMATCH', 'state และ DOM ถูกเก็บคนละ capture cycle ทำให้ snapshot อาจไม่สอดคล้องกัน', { stateCaptureId: String(expected.stateCaptureId), domCaptureId: String(dom.captureId), selector: String(dom.selector || '') }, 'warning', 'dom');
            }
            latestDom = sanitize(dom);
            latestDomCapture = { id: String(dom.captureId || ''), at: Date.now(), stateCaptureId: String(expected.stateCaptureId || dom.stateCaptureId || '') };
            const findingsBefore = findings.length;
            const selector = String(dom.selector || '');
            if (expected.expectedCount != null && Number.isFinite(Number(dom.cardCount)) && Number(dom.cardCount) !== Number(expected.expectedCount)) {
                addFinding('dom', 'DOM_COUNT_DESYNC', 'จำนวนการ์ดใน DOM ไม่ตรงกับ state', { selector, expected: Number(expected.expectedCount), actual: Number(dom.cardCount) }, 'error', 'dom');
            }
            const hasViewportFields = Object.prototype.hasOwnProperty.call(dom, 'viewportAvailable') || Object.prototype.hasOwnProperty.call(dom, 'viewportW') || Object.prototype.hasOwnProperty.call(dom, 'viewportH');
            const viewportAvailable = hasViewportFields ? (dom.viewportAvailable === true || (Number(dom.viewportW) > 0 && Number(dom.viewportH) > 0)) : true;
            if (!viewportAvailable) {
                addFinding('dom', 'DOM_VIEWPORT_UNAVAILABLE', 'ไม่สามารถประเมินพื้นที่แสดงผลได้ เพราะ viewport ของหน้าปัจจุบันเป็น 0×0', { selector, viewportW: Number(dom.viewportW) || 0, viewportH: Number(dom.viewportH) || 0, rootWidth: Number(dom.width) || 0, rootHeight: Number(dom.height) || 0 }, 'error', 'dom');
            }
            if (Number(dom.zeroSizeCount) > 0) addFinding('dom', 'DOM_ZERO_SIZE', 'พบ element การ์ดที่มีขนาด 0', { selector, zeroSizeCount: Number(dom.zeroSizeCount) }, 'warning', 'dom');
            if (viewportAvailable && (Number(dom.overflowPx) > 1.25 || Number(dom.scrollOverflowPx) > 1.25)) addFinding('dom', 'DOM_OVERFLOW', 'พบการ์ดหรือ container ล้นพื้นที่ที่ควรแสดง', { selector, overflowPx: Number(dom.overflowPx) || 0, scrollOverflowPx: Number(dom.scrollOverflowPx) || 0 }, 'error', 'dom');
            if (Number(dom.duplicateIdCount) > 0) addFinding('dom', 'DOM_DUPLICATE_PLAYER_ID', 'พบ player id ซ้ำใน DOM', { selector, duplicateIdCount: Number(dom.duplicateIdCount) }, 'error', 'dom');
            if (Number(dom.missingLabelCount) > 0) addFinding('dom', 'DOM_MISSING_PLAYER_LABEL', 'พบการ์ดผู้เล่นที่ไม่มีชื่อ/ป้ายที่แสดงผลได้', { selector, missingLabelCount: Number(dom.missingLabelCount) }, 'warning', 'dom');
            if (viewportAvailable && (dom.rootOffscreenBelowAtTop === true || dom.rootOffscreenAboveAtBottom === true)) {
                addFinding('dom', 'DOM_GRID_OFFSCREEN', 'พื้นที่กริดผู้เล่นทั้งก้อนอยู่นอก viewport จึงประเมินการ์ดรายใบไม่ได้', {
                    selector,
                    rootX: Number(dom.rootX) || 0,
                    rootY: Number(dom.rootY) || 0,
                    rootRight: Number(dom.rootRight) || 0,
                    rootBottom: Number(dom.rootBottom) || 0,
                    viewportW: Number(dom.viewportW) || 0,
                    viewportH: Number(dom.viewportH) || 0,
                    documentScrollTop: Number(dom.documentScrollTop) || 0,
                    direction: dom.rootOffscreenBelowAtTop === true ? 'below-viewport-at-top' : 'above-viewport-at-bottom'
                }, 'error', 'dom');
            }
            const gridRootEffectivelyOffscreen = dom.rootOffscreenBelowAtTop === true || dom.rootOffscreenAboveAtBottom === true;
            if (viewportAvailable && dom.rootIntersectsViewport !== false && !gridRootEffectivelyOffscreen && Number(dom.outsideViewportCount) > 0) addFinding('dom', 'DOM_OUTSIDE_VIEWPORT', 'พบการ์ดผู้เล่นอยู่นอกพื้นที่แสดงผลในขณะที่กริดรากอยู่ใน viewport', { selector, outsideViewportCount: Number(dom.outsideViewportCount), rootFullyVisible: dom.rootFullyVisible === true }, 'error', 'dom');
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
            const startupGraceMs = Math.max(0, Number(limits.domMutationGraceMs) || 0);
            if (now - startedAt < startupGraceMs) {
                mutationBurstStartedAt = 0;
                mutationBurstCount = 0;
                return;
            }
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
                actionCoverage: actionCoverage(),
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
                captureConsistency: {
                    stateCaptureId: String(latestStateCapture?.id || ''),
                    domCaptureId: String(latestDomCapture?.id || ''),
                    sameCapture: !!(latestStateCapture?.id && latestDomCapture?.id && String(latestStateCapture.id) === String(latestDomCapture.id)),
                    stateCapturedAt: latestStateCapture?.at || null,
                    domCapturedAt: latestDomCapture?.at || null,
                },
                timeline: timeline.slice(-timelineLimit),
                findings: findings.slice(-findingLimit),
                stateHistory: stateHistory.slice(-80),
                actionCoverage: actionCoverage(),
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
            registerActions,
            beginAction,
            finishAction,
            recordActionObservation,
            actionCoverage,
            summary,
            snapshot,
            sanitize,
            fingerprint,
            limits,
        };
    }

    return { createRuntimeAudit, sanitize, fingerprint, SEVERITIES };
});
