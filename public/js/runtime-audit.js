(function () {
    'use strict';
    if (window.__WW_RUNTIME_AUDIT__) return;
    if (!window.WWRuntimeAuditEngine || !window.WWRuntimeAuditEngine.createRuntimeAudit) return;

    function enabled() {
        try {
            if (window.__WW_RUNTIME_AUDIT_FORCE__ === true) return true;
            const params = new URLSearchParams(location.search || '');
            if (params.get('wwAudit') === '1') return true;
            if (params.get('tester') === '1') return true;
            return localStorage.getItem('ww_runtime_audit') === '1';
        } catch (_) { return false; }
    }
    if (!enabled()) return;

    const PAGE = (document.body?.dataset?.page) || (location.pathname.split('/').pop() || 'unknown').replace(/\.html$/, '') || 'unknown';
    const engine = window.WWRuntimeAuditEngine.createRuntimeAudit({
        source: 'browser',
        page: PAGE,
        mode: 'browser-runtime',
        limits: { timeline: 700, findings: 180, slowEventMs: 2500, requestSlowMs: 5000 }
    });
    const state = {
        startedAt: Date.now(),
        lastBreadcrumbKey: '',
        seenBreadcrumbs: new Set(),
        domTimer: null,
        stateTimer: null,
        socketTimer: null,
        summaryTimer: null,
        flushInProgress: false,
        lastSummarySentAt: 0,
        requestSeq: 0,
        originals: {},
    };

    function pathOf(url) {
        try { return new URL(String(url || ''), location.href).pathname.slice(0, 300); }
        catch (_) { return String(url || '').split(/[?#]/)[0].slice(0, 300); }
    }

    function auditReport(kind, finding, immediate) {
        if (!window.WWReportError || !finding) return;
        const now = Date.now();
        if (!immediate && now - state.lastSummarySentAt < 10000) return;
        if (immediate) state.lastSummarySentAt = now;
        try {
            window.WWReportError(kind, {
                message: finding.message || finding.code || 'Runtime audit finding',
                roomId: '',
                causeCode: finding.code || 'RUNTIME_AUDIT',
                causeConfidence: finding.severity === 'critical' ? 'high' : 'medium',
                failureStage: `runtime_audit.${finding.category || 'runtime'}`,
                context: {
                    audit: engine.snapshot({ timelineLimit: immediate ? 120 : 50, findingLimit: immediate ? 30 : 12 }),
                    finding: finding,
                },
                breadcrumbs: true,
            });
        } catch (_) {}
    }

    function addFinding(category, code, message, detail, severity) {
        const f = engine.addFinding(category, code, message, detail || {}, severity || 'error', 'browser-runtime');
        const immediate = severity === 'critical' || severity === 'error';
        auditReport('runtime_audit_finding', f, immediate);
        return f;
    }

    function record(type, label, detail, opts) {
        return engine.record(type, label, detail || {}, { ...(opts || {}), source: (opts && opts.source) || 'browser-runtime' });
    }

    function domSnapshot(selector, cardSelector) {
        const root = document.querySelector(selector);
        if (!root) return { selector, present: false, cardCount: 0 };
        const cards = Array.from(root.querySelectorAll(cardSelector));
        const rootRect = root.getBoundingClientRect();
        const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
        const seen = new Set();
        let duplicateIdCount = 0;
        let zeroSizeCount = 0;
        let missingLabelCount = 0;
        let outsideViewportCount = 0;
        let overflowPx = 0;
        const rects = [];
        cards.forEach((card) => {
            const rect = card.getBoundingClientRect();
            rects.push(rect);
            if (rect.width <= 0 || rect.height <= 0) zeroSizeCount += 1;
            const id = String(card.dataset.pid || card.dataset.playerId || card.id || '');
            if (id) {
                if (seen.has(id)) duplicateIdCount += 1;
                seen.add(id);
            }
            const label = card.querySelector('.pname, .player-name, .name, [data-player-name]') || card;
            if (!String(label.textContent || '').trim()) missingLabelCount += 1;
            if (rect.right < 0 || rect.left > viewportW || rect.bottom < 0 || rect.top > viewportH) outsideViewportCount += 1;
            overflowPx = Math.max(overflowPx,
                Math.max(0, rootRect.left - rect.left),
                Math.max(0, rect.right - rootRect.right),
                Math.max(0, rootRect.top - rect.top),
                Math.max(0, rect.bottom - rootRect.bottom)
            );
        });
        return {
            selector, present: true, cardCount: cards.length, zeroSizeCount, duplicateIdCount,
            missingLabelCount, outsideViewportCount, overflowPx,
            scrollOverflowPx: Math.max(0, root.scrollHeight - root.clientHeight),
            width: rootRect.width, height: rootRect.height,
            visibleCardCount: rects.filter((r) => r.width > 0 && r.height > 0).length,
            gridColumns: Number(root.dataset.gridColumns || 0) || 0,
            gridRows: Number(root.dataset.gridRows || 0) || 0,
        };
    }

    function expectedForPage() {
        if (PAGE === 'player') return { selector: '#players', cardSelector: '.player:not(.search-hidden)' };
        if (PAGE === 'host') return { selector: '#list', cardSelector: '.player:not(.search-hidden)' };
        return null;
    }

    function runDomAudit() {
        const target = expectedForPage();
        if (!target) return;
        const snap = domSnapshot(target.selector, target.cardSelector);
        if (!snap.present) return;
        const provider = window.__WW_RUNTIME_STATE_PROVIDER__;
        let expectedCount = null;
        if (typeof provider === 'function') {
            try {
                const value = provider();
                const players = Array.isArray(value?.players) ? value.players : [];
                expectedCount = players.filter((p) => p && p.isHost !== true && p.hidden !== true).length;
                engine.checkStateInvariants(value, {
                    roomId: value?.roomId || value?.id || '',
                    maxPlayers: value?.maxPlayers || value?.config?.maxPlayers || undefined,
                });
            } catch (err) {
                addFinding('state', 'STATE_PROVIDER_ERROR', 'ตัวอ่าน game state ของหน้าเกมทำงานไม่ได้', { message: err?.message || String(err) }, 'error');
            }
        }
        engine.checkDomSnapshot(snap, expectedCount == null ? {} : { expectedCount });
    }

    function pollStateAndDom() {
        runDomAudit();
        const provider = window.__WW_RUNTIME_STATE_PROVIDER__;
        if (typeof provider === 'function') {
            try {
                const value = provider();
                if (value && typeof value === 'object') {
                    record('state', 'state.snapshot', {
                        roomId: String(value.roomId || value.id || ''),
                        started: !!value.started,
                        gameOver: !!value.gameOver,
                        isNight: !!value.isNight,
                        dayCount: Number(value.dayCount || 0),
                        nightCount: Number(value.nightCount || 0),
                        playerCount: Array.isArray(value.players) ? value.players.length : 0,
                    });
                }
            } catch (_) {}
        }
    }

    function installConsoleAudit() {
        if (!window.console) return;
        ['warn', 'error'].forEach((level) => {
            const raw = window.console[level];
            if (typeof raw !== 'function' || raw.__wwRuntimeAuditV1) return;
            const wrapped = function () {
                try {
                    const parts = Array.from(arguments).slice(0, 6).map((value) => String(value ?? '').slice(0, 500));
                    const message = parts.join(' ');
                    record('console', `console.${level}`, { message });
                    if (level === 'error') addFinding('runtime', 'CONSOLE_ERROR', message || 'console.error', { level }, 'error');
                    else if (/error|failed|exception|timeout|rejected|cannot|unable/i.test(message)) addFinding('runtime', 'CONSOLE_WARN_ANOMALY', message || 'console.warn', { level }, 'warning');
                } catch (_) {}
                try { return raw.apply(window.console, arguments); } catch (_) { return undefined; }
            };
            wrapped.__wwRuntimeAuditV1 = true;
            try { window.console[level] = wrapped; } catch (_) {}
        });
    }

    function installRuntimeEvents() {
        installConsoleAudit();
        window.addEventListener('error', (event) => {
            if (event?.target && event.target !== window && (event.target.src || event.target.href)) {
                addFinding('runtime', 'RESOURCE_ERROR', 'ทรัพยากรของหน้าเกมโหลดไม่สำเร็จ', { url: pathOf(event.target.src || event.target.href), tag: event.target.tagName }, 'error');
            } else {
                addFinding('runtime', 'JAVASCRIPT_ERROR', event?.message || 'JavaScript runtime error', { file: pathOf(event?.filename || ''), line: event?.lineno || 0, column: event?.colno || 0, stack: event?.error?.stack || '' }, 'critical');
            }
        }, true);
        window.addEventListener('unhandledrejection', (event) => {
            const reason = event?.reason;
            addFinding('runtime', 'UNHANDLED_REJECTION', 'เกิด unhandled Promise rejection', { message: reason?.message || String(reason || ''), stack: reason?.stack || '' }, 'critical');
        }, true);
        window.addEventListener('online', () => record('lifecycle', 'network.online', {}, { source: 'browser-runtime' }));
        window.addEventListener('offline', () => addFinding('network', 'BROWSER_OFFLINE', 'เบราว์เซอร์รายงานว่า offline', {}, 'warning'));
        document.addEventListener('visibilitychange', () => record('lifecycle', `visibility.${document.visibilityState}`, {}), true);
        window.addEventListener('pagehide', () => {
            record('lifecycle', 'pagehide', { persisted: false });
            flush(true);
        }, true);
        document.addEventListener('click', (event) => {
            const el = event.target?.closest?.('button,a,[role="button"]');
            if (!el) return;
            record('ui', 'click', { tag: el.tagName, id: el.id || '', text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
        }, true);
        document.addEventListener('submit', (event) => record('ui', 'submit', { id: event.target?.id || '', name: event.target?.name || '' }), true);
    }

    function installFetchAudit() {
        if (typeof window.fetch !== 'function' || window.fetch.__wwRuntimeAuditV1) return;
        const rawFetch = window.fetch.bind(window);
        state.originals.fetch = rawFetch;
        const wrapped = function () {
            const args = Array.from(arguments);
            const request = args[0];
            const init = args[1] || {};
            const method = String(init.method || request?.method || 'GET').toUpperCase();
            const endpoint = pathOf(typeof request === 'string' ? request : request?.url || '');
            if (endpoint.indexOf('/api/diagnostics/') === 0) return rawFetch.apply(window, args);
            const id = `http-${++state.requestSeq}`;
            const started = performance.now();
            record('http', 'request.start', { id, method, endpoint });
            return rawFetch.apply(window, args).then((res) => {
                const durationMs = Math.max(0, performance.now() - started);
                record('http', 'request.response', { id, method, endpoint, status: res.status, durationMs });
                if (!res.ok) addFinding('network', 'HTTP_ERROR', `HTTP ${res.status} จาก ${method} ${endpoint}`, { id, method, endpoint, status: res.status, durationMs }, res.status >= 500 ? 'error' : 'warning');
                else if (durationMs >= 5000) engine.checkPerformance({ name: endpoint, label: `${method} ${endpoint}`, durationMs, category: 'network' }, { slowEventMs: 5000 });
                return res;
            }).catch((err) => {
                const durationMs = Math.max(0, performance.now() - started);
                addFinding('network', 'HTTP_NETWORK_ERROR', `${method} ${endpoint} ล้มเหลว`, { id, method, endpoint, durationMs, name: err?.name || '', message: err?.message || String(err || '') }, 'error');
                throw err;
            });
        };
        wrapped.__wwRuntimeAuditV1 = true;
        window.fetch = wrapped;
    }

    function installXhrAudit() {
        if (!window.XMLHttpRequest || XMLHttpRequest.prototype.__wwRuntimeAuditV1) return;
        const proto = XMLHttpRequest.prototype;
        const open = proto.open;
        const send = proto.send;
        const auditState = new WeakMap();
        proto.open = function (method, url) {
            auditState.set(this, { method: String(method || 'GET').toUpperCase(), endpoint: pathOf(url) });
            return open.apply(this, arguments);
        };
        proto.send = function () {
            const xhr = this;
            const meta = auditState.get(xhr) || { method: 'GET', endpoint: '' };
            const started = performance.now();
            record('xhr', 'request.start', meta);
            const onDone = () => {
                const durationMs = Math.max(0, performance.now() - started);
                record('xhr', 'request.response', { ...meta, status: Number(xhr.status) || 0, durationMs });
                if (xhr.status >= 400) addFinding('network', 'XHR_ERROR', `XHR ${xhr.status} จาก ${meta.method} ${meta.endpoint}`, { ...meta, status: xhr.status, durationMs }, xhr.status >= 500 ? 'error' : 'warning');
                xhr.removeEventListener('loadend', onDone);
            };
            xhr.addEventListener('loadend', onDone);
            return send.apply(this, arguments);
        };
        proto.__wwRuntimeAuditV1 = true;
    }

    function installPerformanceObserver() {
        if (typeof PerformanceObserver !== 'function') return;
        try {
            const observer = new PerformanceObserver((list) => {
                list.getEntries().forEach((entry) => {
                    if (entry.entryType === 'longtask' && entry.duration >= 200) {
                        addFinding('performance', 'LONG_TASK', 'main thread มี long task', { durationMs: Number(entry.duration.toFixed(1)), name: entry.name || 'longtask' }, entry.duration >= 1000 ? 'error' : 'warning');
                    }
                    if (entry.entryType === 'resource' && entry.duration >= 5000) {
                        engine.checkPerformance({ label: `resource ${pathOf(entry.name)}`, durationMs: entry.duration, transferSize: entry.transferSize || 0, category: 'network' }, { slowEventMs: 5000 });
                    }
                });
            });
            try { observer.observe({ entryTypes: ['longtask', 'resource'] }); }
            catch (_) {
                try { observer.observe({ entryTypes: ['resource'] }); } catch (_) {}
            }
        } catch (_) {}
    }

    function installDomObserver() {
        if (typeof MutationObserver !== 'function' || !document.body) return;
        try {
            const observer = new MutationObserver((mutations) => {
                const count = mutations.length;
                engine.observeMutation(count, { records: count });
            });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        } catch (_) {}
    }

    function pollSocketBreadcrumbs() {
        const getter = window.WWDiagnostic?.getBreadcrumbs;
        if (typeof getter !== 'function') return;
        let crumbs = [];
        try { crumbs = getter() || []; } catch (_) { return; }
        crumbs.slice(-80).forEach((crumb) => {
            const key = [crumb.time, crumb.type, crumb.label, crumb.traceId, crumb.detail?.operationId || ''].join('|');
            if (state.seenBreadcrumbs.has(key)) return;
            state.seenBreadcrumbs.add(key);
            if (state.seenBreadcrumbs.size > 500) state.seenBreadcrumbs = new Set(Array.from(state.seenBreadcrumbs).slice(-300));
            if (crumb.type === 'socket') engine.checkSocketBreadcrumb(crumb);
        });
    }

    function flush(force) {
        if (state.flushInProgress || !window.WWReportError) return;
        const now = Date.now();
        if (!force && now - state.lastSummarySentAt < 10000) return;
        state.flushInProgress = true;
        const snapshot = engine.snapshot({ timelineLimit: force ? 180 : 60, findingLimit: force ? 50 : 15 });
        const summaryFinding = {
            category: 'runtime',
            code: 'RUNTIME_AUDIT_SUMMARY',
            severity: snapshot.summary.status === 'ok' ? 'info' : snapshot.summary.status,
            message: `Runtime Audit ${snapshot.summary.status}: ${snapshot.summary.findingCount} findings`,
            detail: snapshot,
        };
        try {
            window.WWReportError('runtime_audit_summary', {
                message: summaryFinding.message,
                context: summaryFinding.detail,
                causeCode: 'RUNTIME_AUDIT_SUMMARY',
                causeConfidence: 'medium',
                failureStage: 'runtime_audit.summary',
                breadcrumbs: true,
            });
            state.lastSummarySentAt = now;
        } catch (_) {}
        state.flushInProgress = false;
    }

    window.WWRuntimeAudit = {
        version: '1.0',
        enabled: true,
        engine,
        record,
        addFinding,
        check: function () { pollStateAndDom(); pollSocketBreadcrumbs(); return engine.snapshot(); },
        snapshot: function () { return engine.snapshot(); },
        flush: function () { flush(true); },
        setStateProvider: function (provider) { window.__WW_RUNTIME_STATE_PROVIDER__ = provider; pollStateAndDom(); },
    };
    window.__WW_RUNTIME_AUDIT__ = true;

    installRuntimeEvents();
    installFetchAudit();
    installXhrAudit();
    installPerformanceObserver();
    installDomObserver();

    state.stateTimer = setInterval(pollStateAndDom, 900);
    state.domTimer = setInterval(runDomAudit, 1400);
    state.socketTimer = setInterval(pollSocketBreadcrumbs, 300);
    state.summaryTimer = setInterval(() => flush(false), 15000);
    setTimeout(() => {
        record('lifecycle', 'runtime_audit.started', { page: PAGE });
        pollStateAndDom();
        pollSocketBreadcrumbs();
    }, 0);
})();
