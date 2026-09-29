(function () {
    'use strict';
    if (window.__WW_RUNTIME_AUDIT_ACTIONS__) return;
    const audit = window.WWRuntimeAudit;
    const registry = window.WWRuntimeAuditActionRegistry;
    if (!audit || !audit.engine || !registry) return;

    const PAGE = (document.body?.dataset?.page) || (location.pathname.split('/').pop() || 'unknown').replace(/\.html$/, '') || 'unknown';
    const actions = registry.forPage(PAGE);
    const state = {
        startedAt: Date.now(),
        actionRuns: new Map(),
        pendingSocketActions: new Map(),
        seenBreadcrumbs: new Set(),
        running: false,
        runnerSeq: 0,
        runHistory: [],
        maxHistory: 180,
    };

    audit.engine.registerActions(actions);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
    const qs = (selector, root = document) => {
        try { return selector ? root.querySelector(selector) : null; } catch (_) { return null; }
    };
    const visible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle?.(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };
    const actionable = (el) => {
        if (!el || !(el instanceof Element)) return false;
        if (!visible(el)) return false;
        if ('disabled' in el && el.disabled) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        return true;
    };
    const shortText = (el) => String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const elementSignature = (el) => {
        if (!el) return '';
        return [el.className || '', el.getAttribute?.('aria-expanded') || '', el.getAttribute?.('aria-pressed') || '', el.getAttribute?.('aria-selected') || '', el.hidden ? 'hidden' : 'shown'].join('|');
    };
    const pagePath = () => `${location.pathname}${location.search}${location.hash}`;

    function findActionElement(action) {
        if (!action?.selector) return null;
        const el = qs(action.selector);
        return el && actionable(el) ? el : (el || null);
    }

    function shouldSkip(action, el) {
        const cond = action?.skipIf;
        if (!cond) return false;
        const target = qs(cond.selector);
        if (!target) return false;
        if (Object.prototype.hasOwnProperty.call(cond, 'visible')) return visible(target) === !!cond.visible;
        if (Object.prototype.hasOwnProperty.call(cond, 'exists')) return (!!target) === !!cond.exists;
        return false;
    }

    function verifyExpected(action, before, result = {}) {
        const expected = action?.expected || {};
        const type = String(expected.type || 'actionable');
        const element = findActionElement(action);
        const afterSig = elementSignature(element);
        if (type === 'exists') return { ok: !!element, expected:{type}, actual:{exists:!!element} };
        if (type === 'actionable') return { ok: actionable(element), expected:{type}, actual:{exists:!!element, visible:visible(element), disabled:!!element?.disabled, text:shortText(element)} };
        if (type === 'visible') {
            const target = qs(expected.selector || action.selector);
            return { ok:visible(target), expected:{type, selector:expected.selector || action.selector}, actual:{exists:!!target, visible:visible(target)} };
        }
        if (type === 'class') {
            const ok = !!element?.classList?.contains(expected.className);
            return { ok, expected:{type, className:expected.className}, actual:{className:String(element?.className || '')} };
        }
        if (type === 'class-or-aria') {
            const ok = !!element && (element.classList.contains(expected.className || '') || (expected.ariaSelected && element.getAttribute('aria-selected') === expected.ariaSelected) || (expected.ariaPressed && element.getAttribute('aria-pressed') === expected.ariaPressed));
            return { ok, expected:{type, className:expected.className, ariaSelected:expected.ariaSelected, ariaPressed:expected.ariaPressed}, actual:{className:String(element?.className || ''), ariaSelected:element?.getAttribute?.('aria-selected') || '', ariaPressed:element?.getAttribute?.('aria-pressed') || ''} };
        }
        if (type === 'toggle') {
            const ok = before.signature !== afterSig;
            return { ok, expected:{type:'toggle-change'}, actual:{before:before.signature, after:afterSig, changed:ok} };
        }
        if (type === 'admin-panel') {
            const active = document.body?.dataset?.adminTab || window.__wwAdminCurrentTab || '';
            const panel = qs(`[data-admin-panel="${expected.tab}"]`);
            const panelVisible = visible(panel) && !panel?.classList.contains('hidden');
            const ok = active === expected.tab || panelVisible;
            return { ok, expected:{type, tab:expected.tab}, actual:{activeTab:active, panelVisible} };
        }
        if (type === 'toggle-panel') {
            const panel = qs('#bugReplayAudit');
            const open = !!panel?.classList.contains('is-open');
            return { ok:open, expected:{type, open:true}, actual:{open} };
        }
        if (type === 'embedded-admin') {
            const embedded = document.body?.dataset?.adminEmbedded === '1';
            const depth = Number(window.WWAdminBrowser?.adminEmbedDepth || document.body?.dataset?.adminEmbedDepth || 0);
            return { ok:embedded && depth >= 1, expected:{type, embedded:true}, actual:{embedded, depth} };
        }
        if (type === 'not-navigation') {
            const current = pagePath();
            const ok = before.path === current;
            return { ok, expected:{type, path:before.path}, actual:{path:current} };
        }
        if (type === 'action-family') {
            return { ok:true, expected:{type, eventName:expected.eventName}, actual:{eventObserved:!!result.eventObserved, eventName:result.eventName || ''} };
        }
        return { ok:!!element, expected:{type}, actual:{exists:!!element} };
    }

    async function cleanupAction(action) {
        const cleanup = action?.cleanup;
        if (!cleanup) return;
        let el = qs(cleanup.selector);
        if (cleanup.text && el) {
            const candidates = [...document.querySelectorAll(cleanup.selector)].filter(visible);
            el = candidates.find((node) => shortText(node).includes(String(cleanup.text))) || el;
        }
        if (el && actionable(el)) {
            try { el.click(); } catch (_) {}
            await sleep(120);
        }
    }

    function findingCodeFor(action) {
        return `ACTION_FAILED_${String(action?.id || 'unknown').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase().slice(0, 70)}`;
    }

    function findSocketAction(eventName) {
        return actions.find((item) => item.kind === 'socket' && item.expected?.eventName === eventName) || null;
    }

    function bindPendingSocket(action, run) {
        const eventName = String(action?.expected?.eventName || '');
        if (!eventName) return;
        state.pendingSocketActions.set(eventName, run);
    }

    async function executeAction(action, options = {}) {
        const started = audit.engine.beginAction(action, { runner:options.runnerId || '', page:PAGE, source:'action-suite' });
        if (shouldSkip(action)) {
            return audit.engine.finishAction(started, { status:'skipped', message:'เงื่อนไขของ action ระบุให้ข้ามใน state ปัจจุบัน', detail:{ skipIf:action.skipIf }, expected:action.expected });
        }
        const element = findActionElement(action);
        if (!element) {
            return audit.engine.finishAction(started, { status:'skipped', message:'ไม่พบ element ของ action ในหน้าปัจจุบัน', detail:{selector:action.selector}, expected:action.expected });
        }
        if (action.mode !== 'safe') {
            return audit.engine.finishAction(started, { status:'blocked', message:`Action mode=${action.mode} ไม่อนุญาตให้ auto-run จาก Runtime Audit`, detail:{mode:action.mode, selector:action.selector}, expected:action.expected });
        }
        if (!actionable(element) && action.expected?.type !== 'exists') {
            return audit.engine.finishAction(started, { status:'blocked', message:'พบ element แต่ยังไม่ actionable', detail:{selector:action.selector, visible:visible(element), disabled:!!element.disabled}, expected:action.expected });
        }
        const before = { signature:elementSignature(element), path:pagePath(), text:shortText(element) };
        let eventObserved = false;
        let eventName = '';
        try {
            if (action.kind === 'network' && action.mode === 'safe') {
                const result = verifyExpected(action, before);
                return audit.engine.finishAction(started, { status:result.ok ? 'passed' : 'failed', message:result.ok ? 'contract ผ่าน' : 'contract ไม่ผ่าน', expected:result.expected, actual:result.actual, findingCode:result.ok ? '' : findingCodeFor(action) });
            }
            try { element.focus?.({preventScroll:true}); } catch (_) {}
            if (action.kind === 'socket' && action.expected?.eventName) bindPendingSocket(action, started);
            element.click();
            if (action.kind === 'socket' && action.expected?.eventName) {
                const deadline = Date.now() + Math.max(500, Number(action.timeoutMs) || 4500);
                while (Date.now() < deadline) {
                    if (started.status !== 'running') break;
                    const current = audit.engine.snapshot({timelineLimit:20, findingLimit:5}).actionCoverage?.recent || [];
                    const hit = current.find((item) => item.runId === started.runId && item.status !== 'running');
                    if (hit) return hit;
                    await sleep(120);
                }
                if (started.status === 'running') {
                    state.pendingSocketActions.delete(String(action.expected.eventName));
                    return audit.engine.finishAction(started, { status:'timeout', message:'Socket action ไม่ได้รับผลลัพธ์ภายในเวลาที่กำหนด', expected:{eventName:action.expected.eventName, ack:'received'}, actual:{eventObserved:false}, findingCode:'ACTION_SOCKET_OUTCOME_TIMEOUT', detail:{timeoutMs:Number(action.timeoutMs)||4500} });
                }
                return started;
            }
            await sleep(Number(action.settleMs) || 280);
            const result = verifyExpected(action, before, {eventObserved,eventName});
            if (result.ok) {
                await cleanupAction(action);
                // Toggle actions restore their original state by clicking once more when it changed.
                if (action.expected?.type === 'toggle' && element.isConnected && elementSignature(element) !== before.signature && actionable(element)) {
                    try { element.click(); await sleep(100); } catch (_) {}
                }
                state.pendingSocketActions.delete(String(action.expected?.eventName || ''));
                return audit.engine.finishAction(started, { status:'passed', message:'Action สำเร็จตาม expected outcome', expected:result.expected, actual:result.actual, detail:{before} });
            }
            await cleanupAction(action);
            state.pendingSocketActions.delete(String(action.expected?.eventName || ''));
            return audit.engine.finishAction(started, { status:'failed', message:'Action ทำงานแต่ผลลัพธ์ไม่ตรง expected outcome', expected:result.expected, actual:result.actual, detail:{before}, findingCode:findingCodeFor(action) });
        } catch (error) {
            return audit.engine.finishAction(started, { status:'failed', message:`Action รันไม่สำเร็จ: ${error?.message || String(error)}`, expected:action.expected, actual:{error:String(error)}, findingCode:findingCodeFor(action) });
        }
    }

    function clickActionId(actionId, target) {
        const action = registry.find(actionId);
        if (!action || action.page !== PAGE) return null;
        const run = audit.engine.beginAction(action, { observed:'click', text:shortText(target), page:PAGE, before:{signature:elementSignature(target), path:pagePath()} });
        state.actionRuns.set(actionId, run);
        return run;
    }

    function observeClick(event) {
        // Ignore clicks generated by the Safe Action runner itself; those are already tracked by executeAction.
        if (state.running) return;
        const el = event.target?.closest?.('button,a,[role="button"],input,select,[data-runtime-action]');
        if (!el) return;
        const candidates = actions.filter((action) => action.kind === 'ui' && action.selector && action.mode !== 'simulation' && action.mode !== 'recovery' && action.mode !== 'destructive' && action.mode !== 'mutating' && action.mode !== 'negative');
        // Match exact selector only for unambiguous user-action observation. Generic player-card selectors
        // are intentionally excluded because one click can mean different role actions by phase/role.
        const action = candidates.find((candidate) => {
            try { return el.matches(candidate.selector) && !candidate.selector.includes('.player[data-id]') && !candidate.selector.includes('body'); } catch (_) { return false; }
        });
        if (!action) return;
        const existing = state.actionRuns.get(action.id);
        if (existing?.status === 'running') return;
        const run = clickActionId(action.id, el);
        if (!run) return;
        if (action.kind === 'socket' && action.expected?.eventName) {
            bindPendingSocket(action, run);
            setTimeout(() => {
                if (run.status !== 'running') return;
                state.pendingSocketActions.delete(String(action.expected.eventName));
                state.actionRuns.delete(action.id);
                audit.engine.finishAction(run, { status:'timeout', message:'ผู้ใช้กด socket action แต่ไม่ได้รับผลลัพธ์ภายในเวลาที่กำหนด', expected:{eventName:action.expected.eventName, ack:'received'}, actual:{eventObserved:false}, findingCode:'ACTION_USER_SOCKET_OUTCOME_TIMEOUT', detail:{timeoutMs:Number(action.observeTimeoutMs)||4500} });
            }, Number(action.observeTimeoutMs) || 4500);
            return;
        }
        setTimeout(() => {
            const current = state.actionRuns.get(action.id);
            if (!current || current !== run) return;
            const before = current.detail?.before || {signature: current.detail?.signature || '', path: current.detail?.path || ''};
            const result = verifyExpected(action, before, {eventObserved:false});
            audit.engine.finishAction(run, { status:result.ok ? 'passed' : 'failed', message:result.ok ? 'ผู้ใช้/ระบบกด action และผลตรวจผ่าน' : 'ผู้ใช้กด action แต่ผลตรวจไม่ผ่าน', expected:result.expected, actual:result.actual, findingCode:result.ok ? '' : findingCodeFor(action) });
            state.actionRuns.delete(action.id);
        }, Number(action.observeTimeoutMs) || 1400);
    }

    function observeSocketBreadcrumbs() {
        const getter = window.WWDiagnostic?.getBreadcrumbs;
        if (typeof getter !== 'function') return;
        let crumbs = [];
        try { crumbs = getter() || []; } catch (_) { return; }
        crumbs.slice(-100).forEach((crumb) => {
            const label = String(crumb?.label || '');
            const detail = crumb?.detail || {};
            const key = [crumb?.time, label, detail.operationId || '', detail.eventName || ''].join('|');
            if (state.seenBreadcrumbs.has(key)) return;
            state.seenBreadcrumbs.add(key);
            if (state.seenBreadcrumbs.size > 800) state.seenBreadcrumbs = new Set([...state.seenBreadcrumbs].slice(-500));

            if (label.indexOf('emit:') === 0) {
                const eventName = label.slice(5);
                const action = findSocketAction(eventName);
                if (!action) return;
                const pending = state.pendingSocketActions.get(eventName);
                if (pending && pending.status === 'running') {
                    pending.detail = {...pending.detail, operationId:String(detail.operationId || ''), eventName, observed:'socket.emit', args:detail.args || null};
                    if (detail.operationId) state.actionRuns.set(String(detail.operationId), pending);
                    state.pendingSocketActions.delete(eventName);
                    return;
                }
                const run = audit.engine.beginAction(action, { operationId:String(detail.operationId || ''), eventName, observed:'socket.emit', args:detail.args || null });
                if (detail.operationId) state.actionRuns.set(String(detail.operationId), run);
                else state.actionRuns.set(`${action.id}:${eventName}`, run);
                return;
            }
            if (label.indexOf('ack:') === 0) {
                const eventName = label.slice(4);
                const action = actions.find((item) => item.kind === 'socket' && item.expected?.eventName === eventName);
                if (!action) return;
                const operationId = String(detail.operationId || '');
                let run = operationId ? state.actionRuns.get(operationId) : null;
                if (!run) {
                    // A socket ACK can race before the operationId is copied into the map.
                    run = [...state.actionRuns.values()].find((candidate) => candidate?.status === 'running' && candidate?.expected?.eventName === eventName) || null;
                }
                if (!run) return;
                const ok = detail.ok === true;
                const isNegative = action.mode === 'negative';
                const isPassive = action.mode === 'observe' || action.mode === 'simulation' || action.mode === 'recovery';
                const passed = ok || isNegative || isPassive;
                const status = passed ? 'passed' : 'failed';
                audit.engine.finishAction(run, {
                    status,
                    message:ok ? 'Socket action ได้ ACK สำเร็จ' : (isNegative ? 'Socket action ถูกปฏิเสธตาม negative contract' : (isPassive ? 'Socket action ถูกบันทึกผลลัพธ์แล้วโดยไม่บังคับ acceptance contract' : 'Socket action ได้ ACK แต่ server ตอบ rejection')),
                    expected:{eventName, ack:'received', accepted:isNegative ? 'not-required' : (isPassive ? 'observed' : true)},
                    actual:{eventName, ackReceived:true, ackOk:ok, ackCode:detail.ackCode || ''},
                    detail:{operationId, eventName},
                    findingCode:status === 'failed' ? 'ACTION_SOCKET_ACK_REJECTED' : '',
                });
                state.actionRuns.delete(operationId);
                return;
            }
            if (label === 'ack.timeout') {
                const operationId = String(detail.operationId || '');
                const run = state.actionRuns.get(operationId);
                if (!run) return;
                audit.engine.finishAction(run, { status:'timeout', message:'Socket action ไม่ได้รับ ACK', expected:{ack:'received'}, actual:{ackReceived:false, elapsedMs:Number(detail.elapsedMs) || 0}, findingCode:'ACTION_ACK_TIMEOUT', detail:{operationId, eventName:detail.eventName || ''} });
                state.actionRuns.delete(operationId);
            }
        });
    }

    function buildCoverage() {
        const registryCoverage = registry.coverage();
        const safe = actions.filter((a) => a.mode === 'safe').length;
        const executionAllowed = actions.filter((a) => ['safe'].includes(a.mode)).length;
        const current = audit.engine.actionCoverage();
        return { page:PAGE, label:registryCoverage.pageMeta?.[PAGE]?.label || PAGE, registeredOnPage:actions.length, safeOnPage:safe, executionAllowed, ...current, registry:registryCoverage };
    }

    async function runSafe(options = {}) {
        if (state.running) return { ok:false, blocked:true, reason:'ACTION_AUDIT_ALREADY_RUNNING', coverage:buildCoverage() };
        state.running = true;
        const runnerId = `manual-${PAGE}-${Date.now().toString(36)}-${(++state.runnerSeq).toString(36)}`;
        const list = actions.filter((action) => action.mode === 'safe');
        const results = [];
        audit.record('action', 'action-suite.start', {page:PAGE, runnerId, total:list.length}, {source:'action-suite'});
        try {
            for (const action of list) {
                if (options.shouldStop?.()) break;
                const result = await executeAction(action, {runnerId});
                results.push(result);
                await sleep(Number(options.gapMs) || 90);
            }
        } finally {
            state.running = false;
            state.runHistory.push({runnerId, at:new Date().toISOString(), results:results.map((r) => ({actionId:r?.actionId || r?.action?.actionId || '', status:r?.status || ''}))});
            if (state.runHistory.length > state.maxHistory) state.runHistory.splice(0, state.runHistory.length - state.maxHistory);
            audit.record('action', 'action-suite.complete', {page:PAGE, runnerId, completed:results.length}, {source:'action-suite'});
        }
        const coverage = buildCoverage();
        if (coverage.failed > 0 || coverage.timedOut > 0) {
            audit.addFinding('action', 'ACTION_SUITE_FAILED', `Action suite ของหน้า ${PAGE} มี action ที่ไม่ผ่าน`, {runnerId, page:PAGE, coverage}, 'error');
        }
        return {ok:coverage.failed === 0 && coverage.timedOut === 0, runnerId, results, coverage};
    }

    function annotateActionTargets() {
        actions.forEach((action) => {
            if (!action.selector || action.selector.includes('.player[data-id]') || action.selector.includes('body')) return;
            try {
                document.querySelectorAll(action.selector).forEach((el) => {
                    if (!el.dataset.runtimeActionId) el.dataset.runtimeActionId = action.id;
                });
            } catch (_) {}
        });
    }

    function expose() {
        window.WWRuntimeAuditActions = {
            version:'2.0',
            page:PAGE,
            actor:registry.pageMeta?.[PAGE]?.actors?.[0] || '',
            list:() => actions.map((action) => ({...action})),
            coverage:buildCoverage,
            runSafe,
            observeSocket:observeSocketBreadcrumbs,
            annotate:annotateActionTargets,
            isRunning:() => state.running,
            runHistory:() => state.runHistory.slice(-20).map((x) => ({...x})),
            engineSnapshot:() => audit.engine.snapshot({timelineLimit:120, findingLimit:60}),
            pendingSocketCount:() => state.pendingSocketActions.size,
        };
        try { window.WWRuntimeAudit.record('action', 'actions.ready', {page:PAGE, registered:actions.length, safe:actions.filter((a) => a.mode === 'safe').length}, {source:'action-suite'}); } catch (_) {}
        annotateActionTargets();
        document.addEventListener('click', observeClick, true);
        setInterval(observeSocketBreadcrumbs, 300);
    }

    expose();
    window.__WW_RUNTIME_AUDIT_ACTIONS__ = true;
})();
