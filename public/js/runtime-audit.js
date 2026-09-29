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
        pageIntegrityTimer: null,
        stateTimer: null,
        socketTimer: null,
        summaryTimer: null,
        flushInProgress: false,
        lastSummarySentAt: 0,
        requestSeq: 0,
        originals: {},
        auditCaptureSeq: 0,
        viewportGraceMs: 2500,
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
        const scrollingElement = document.scrollingElement || document.documentElement || document.body;
        const documentScrollTop = Math.max(0, Number(scrollingElement?.scrollTop) || 0);
        const rootFullyVisible = viewportW > 0 && viewportH > 0
            && rootRect.left >= -1 && rootRect.top >= -1
            && rootRect.right <= viewportW + 1 && rootRect.bottom <= viewportH + 1;
        const rootIntersectsViewport = viewportW > 0 && viewportH > 0
            && rootRect.right > 0 && rootRect.left < viewportW
            && rootRect.bottom > 0 && rootRect.top < viewportH;
        const rootVisibleHeightPx = Math.max(0, Math.min(rootRect.bottom, viewportH) - Math.max(rootRect.top, 0));
        const rootVisibleWidthPx = Math.max(0, Math.min(rootRect.right, viewportW) - Math.max(rootRect.left, 0));
        const rootVisibleHeightRatio = rootRect.height > 0 ? rootVisibleHeightPx / rootRect.height : 0;
        const rootNearBottomSliver = PAGE === 'host' && viewportH > 0
            && rootRect.top >= viewportH - Math.min(48, viewportH * 0.08)
            && rootVisibleHeightRatio < 0.20;
        const rootOffscreenBelowAtTop = viewportW > 0 && viewportH > 0 && PAGE === 'host'
            && documentScrollTop <= 2
            && (rootRect.top > viewportH + 1 || rootNearBottomSliver);
        const rootOffscreenAboveAtBottom = viewportW > 0 && viewportH > 0 && PAGE === 'host'
            && rootRect.bottom < -1 && scrollingElement
            && documentScrollTop + viewportH >= Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0) - 2;
        const seen = new Set();
        let duplicateIdCount = 0;
        let zeroSizeCount = 0;
        let missingLabelCount = 0;
        let outsideViewportCount = 0;
        let overflowPx = 0;
        const viewportAvailable = viewportW > 0 && viewportH > 0;
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
            // Blame individual player cards only when the grid root intersects the viewport.
            // When the entire #list is below the first viewport, page scrolling/layout is the actual signal;
            // counting all cards as "outside" creates a noisy false-positive flood.
            if (viewportAvailable && rootIntersectsViewport && (rect.right < 0 || rect.left > viewportW || rect.bottom < 0 || rect.top > viewportH)) outsideViewportCount += 1;
            if (viewportAvailable && rootRect.width > 0 && rootRect.height > 0) {
                overflowPx = Math.max(overflowPx,
                    Math.max(0, rootRect.left - rect.left),
                    Math.max(0, rect.right - rootRect.right),
                    Math.max(0, rootRect.top - rect.top),
                    Math.max(0, rect.bottom - rootRect.bottom)
                );
            }
        });
        return {
            selector, present: true, cardCount: cards.length, zeroSizeCount, duplicateIdCount,
            missingLabelCount, outsideViewportCount, overflowPx,
            viewportAvailable, viewportW, viewportH,
            scrollOverflowPx: Math.max(0, root.scrollHeight - root.clientHeight),
            width: rootRect.width, height: rootRect.height,
            rootX: rootRect.x, rootY: rootRect.y, rootRight: rootRect.right, rootBottom: rootRect.bottom,
            rootFullyVisible, rootIntersectsViewport,
            rootVisibleHeightPx, rootVisibleWidthPx, rootVisibleHeightRatio, rootNearBottomSliver,
            rootOffscreenBelowAtTop, rootOffscreenAboveAtBottom,
            documentScrollTop,
            visibleCardCount: rects.filter((r) => r.width > 0 && r.height > 0).length,
            gridColumns: Number(root.dataset.gridColumns || 0) || 0,
            gridRows: Number(root.dataset.gridRows || 0) || 0,
            gridLayoutReady: root.dataset.gridLayoutReady === 'true',
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
        const captureId = `audit-${++state.auditCaptureSeq}-${Date.now().toString(36)}`;
        const provider = window.__WW_RUNTIME_STATE_PROVIDER__;
        let expectedCount = null;
        let stateCaptured = false;
        if (typeof provider === 'function') {
            try {
                const value = provider();
                const players = Array.isArray(value?.players) ? value.players : [];
                expectedCount = players.filter((p) => p && p.isHost !== true && p.hidden !== true).length;
                engine.checkStateInvariants(value, {
                    roomId: value?.roomId || value?.id || '',
                    maxPlayers: value?.maxPlayers || value?.config?.maxPlayers || undefined,
                    captureId,
                });
                stateCaptured = true;
            } catch (err) {
                addFinding('state', 'STATE_PROVIDER_ERROR', 'ตัวอ่าน game state ของหน้าเกมทำงานไม่ได้', { message: err?.message || String(err), captureId }, 'error');
            }
        }
        const snap = domSnapshot(target.selector, target.cardSelector);
        if (!snap.present) return;
        snap.captureId = captureId;
        snap.stateCaptureId = stateCaptured ? captureId : '';
        snap.capturedAt = new Date().toISOString();
        if (!snap.viewportAvailable) {
            const elapsed = Date.now() - state.startedAt;
            if (elapsed < state.viewportGraceMs) {
                engine.record('lifecycle', 'layout.waiting_for_viewport', {
                    captureId, viewportW: snap.viewportW, viewportH: snap.viewportH, elapsedMs: elapsed,
                }, { severity: 'info', source: 'browser-runtime' });
                return;
            }
        }
        engine.checkDomSnapshot(snap, expectedCount == null ? { stateCaptureId: stateCaptured ? captureId : '' } : { expectedCount, stateCaptureId: stateCaptured ? captureId : '' });
    }

    function pageIntegritySnapshot() {
        const viewportW = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
        const viewportH = Number(window.innerHeight || document.documentElement?.clientHeight || 0);
        const root = document.documentElement;
        const body = document.body;
        const controls = Array.from(document.querySelectorAll('button,a,[role="button"],input,select,textarea'));
        const duplicateIds = new Map();
        let zeroSizeInteractive = 0;
        let offscreenInteractive = 0;
        let unnamedInteractive = 0;
        let visibleDisabledInteractive = 0;
        controls.forEach((el) => {
            const id = String(el.id || '').trim();
            if (id) duplicateIds.set(id, (duplicateIds.get(id) || 0) + 1);
            const style = window.getComputedStyle?.(el);
            const rect = el.getBoundingClientRect();
            const isHidden = !!el.hidden || style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity) === 0;
            if (isHidden) return;
            if (rect.width <= 0 || rect.height <= 0) zeroSizeInteractive += 1;
            if (viewportW > 0 && viewportH > 0 && (rect.right < -2 || rect.left > viewportW + 2 || rect.bottom < -2 || rect.top > viewportH + 2)) offscreenInteractive += 1;
            if (('disabled' in el && el.disabled) || el.getAttribute?.('aria-disabled') === 'true') visibleDisabledInteractive += 1;
            const name = String(el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
            if (!name) unnamedInteractive += 1;
        });
        let duplicateIdCount = 0;
        duplicateIds.forEach((count) => { if (count > 1) duplicateIdCount += count - 1; });
        const docWidth = Math.max(Number(root?.scrollWidth || 0), Number(body?.scrollWidth || 0));
        const horizontalOverflowPx = viewportW > 0 ? Math.max(0, docWidth - viewportW) : 0;
        const hasActiveUpdateOverlay = !!document.querySelector('#wwUpdateOverlay:not(.hidden)');
        return {
            page: PAGE,
            path: location.pathname,
            readyState: document.readyState,
            viewportW, viewportH,
            documentWidth: docWidth,
            horizontalOverflowPx,
            controlCount: controls.length,
            zeroSizeInteractive,
            offscreenInteractive,
            unnamedInteractive,
            visibleDisabledInteractive,
            duplicateIdCount,
            hasActiveUpdateOverlay,
        };
    }

    function runPageIntegrityAudit() {
        const snap = pageIntegritySnapshot();
        record('dom', 'page.integrity.snapshot', snap, {source:'browser-runtime'});
        if (snap.duplicateIdCount > 0) addFinding('dom', 'PAGE_DUPLICATE_ID', 'หน้าเว็บมี id ซ้ำใน DOM', snap, 'error');
        if (snap.unnamedInteractive > 0) addFinding('dom', 'PAGE_UNNAMED_INTERACTIVE', 'พบ control ที่มองเห็นได้แต่ไม่มี accessible name', snap, 'warning');
        if (snap.zeroSizeInteractive > 0) addFinding('dom', 'PAGE_ZERO_SIZE_INTERACTIVE', 'พบ control ที่มองเห็นใน DOM แต่มีขนาด 0', snap, 'warning');
        if (snap.viewportW > 0 && snap.horizontalOverflowPx > 2 && !document.body?.dataset?.page?.includes('maintenance')) {
            addFinding('dom', 'PAGE_HORIZONTAL_OVERFLOW', 'หน้าเว็บมี horizontal overflow มากกว่าพื้นที่ viewport', snap, 'warning');
        }
        if (snap.viewportW > 0 && snap.viewportH > 0 && snap.offscreenInteractive > 0 && PAGE !== 'admin') {
            addFinding('dom', 'PAGE_INTERACTIVE_OFFSCREEN', 'มี control ที่อยู่นอก viewport และไม่ควรถูกซ่อนไว้', snap, 'warning');
        }
        if (window.WWRuntimeAuditActions?.coverage) {
            try {
                const c = window.WWRuntimeAuditActions.coverage();
                record('action', 'actions.coverage', {registeredOnPage:c.registeredOnPage, safeOnPage:c.safeOnPage, attempted:c.attempted, passed:c.passed, failed:c.failed, skipped:c.skipped, blocked:c.blocked, timedOut:c.timedOut}, {source:'action-suite'});
            } catch (_) {}
        }
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
        version: '2.0',
        enabled: true,
        engine,
        record,
        addFinding,
        check: function () { pollStateAndDom(); pollSocketBreadcrumbs(); return engine.snapshot(); },
        snapshot: function () { return engine.snapshot(); },
        flush: function () { flush(true); },
        setStateProvider: function (provider) { window.__WW_RUNTIME_STATE_PROVIDER__ = provider; pollStateAndDom(); },
        pageIntegrity: pageIntegritySnapshot,
    };
    window.__WW_RUNTIME_AUDIT__ = true;

    installRuntimeEvents();
    installFetchAudit();
    installXhrAudit();
    installPerformanceObserver();
    installDomObserver();

    state.stateTimer = setInterval(pollStateAndDom, 900);
    state.domTimer = setInterval(runDomAudit, 1400);
    state.pageIntegrityTimer = setInterval(runPageIntegrityAudit, 2200);
    state.socketTimer = setInterval(pollSocketBreadcrumbs, 300);
    state.summaryTimer = setInterval(() => flush(false), 15000);
    setTimeout(() => {
        record('lifecycle', 'runtime_audit.started', { page: PAGE });
        pollStateAndDom();
        runPageIntegrityAudit();
        pollSocketBreadcrumbs();
    }, 0);
})();
