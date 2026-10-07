/* Confirm delivery; retain a small pending queue through temporary network errors. */
(function () {
    'use strict';
    const key = 'ww_bug_report_pending_v2';
    let queue = [], busy = false, timer = null, retryMs = 3000;
    try { queue = JSON.parse(sessionStorage.getItem(key) || '[]'); if (!Array.isArray(queue)) queue = []; } catch (_) {}
    queue = queue.filter(item => item && typeof item.id === 'string').slice(-20);
    function persist() { try { sessionStorage.setItem(key, JSON.stringify(queue)); } catch (_) {} }
    function read(keys) { try { for (const key of keys) { const value = sessionStorage.getItem(key) || localStorage.getItem(key); if (value) return String(value); } } catch (_) {} return ''; }
    function schedule(delay = 100) { clearTimeout(timer); timer = setTimeout(flush, delay); }
    async function flush() {
        if (busy || !queue.length || navigator.onLine === false) return;
        busy = true;
        let delivered = false;
        const item = queue[0], controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch('/api/bug-reports', { method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify(item), credentials:'same-origin', keepalive:true, signal:controller.signal });
            const result = await response.json().catch(() => ({}));
            if ((response.ok && result.ok) || [400,413,422].includes(response.status)) {
                queue = queue.filter(report => report.id !== item.id); persist(); retryMs = 3000; delivered = true;
            } else {
                retryMs = Math.min(60000, Math.max(retryMs * 2, Number(response.headers.get('Retry-After') || 0) * 1000));
            }
        } catch (_) { retryMs = Math.min(60000, retryMs * 2); }
        finally { clearTimeout(timeout); busy = false; if (queue.length) schedule(delivered ? 100 : retryMs); }
    }
    function send(message, stack, source) {
        const msg = String(message || '').slice(0,2400), trace = String(stack || '').slice(0,5000);
        if (!msg && !trace) return;
        const now = Date.now();
        if (queue.some(item => item.message === msg && item.stack === trace && now-Date.parse(item.createdAt)<8000)) return;
        const random = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
        queue.push({ id:`bug-${now.toString(36)}-${random}`, createdAt:new Date(now).toISOString(),
            source:source || 'client', page:location.pathname,
            version:read(['ww_update_known_version','ww_app_version']).slice(0,100),
            message:msg, stack:trace, roomId:read(['ww_host_room','ww_joinedRoom','ww_lastRoom']).slice(0,20),
            userAgent:navigator.userAgent.slice(0,600) });
        queue = queue.slice(-20); persist(); schedule();
    }
    window.WWBugReport = { send };
    window.addEventListener('error', event => {
        if (!event.message && !event.error) return;
        send(event.message || 'Unhandled client error', event.error?.stack || `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`, 'window.error');
    });
    window.addEventListener('unhandledrejection', event => send(event.reason?.message || String(event.reason || 'Unhandled promise rejection'), event.reason?.stack || '', 'unhandledrejection'));
    window.addEventListener('online', () => schedule());
    window.addEventListener('pageshow', () => schedule());
    window.addEventListener('pagehide', () => {
        persist();
        // Beacon is best effort: retain until a later confirmed, idempotent POST.
        for (const item of queue.slice(0,3)) try { navigator.sendBeacon?.('/api/bug-reports', new Blob([JSON.stringify(item)], {type:'application/json'})); } catch (_) {}
    });
    schedule();
})();
