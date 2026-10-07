/* Isolate tester credentials between same-origin Admin screens, before game scripts load. */
(() => {
    'use strict';
    const frame = window.frameElement;
    const params = new URLSearchParams(location.search);
    const id = frame?.dataset.screen || params.get('ww_test_screen');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || '') || window.parent === window) return;
    if (frame?.dataset.testerPass) {
        params.set('tester', '1'); params.set('tp', frame.dataset.testerPass);
        params.set('ww_test_screen', id); params.set('ww_admin_embed', '1');
        history.replaceState(null, '', location.pathname + '?' + params + location.hash);
    }
    const storage = window.sessionStorage, prefix = `ww_admin_screen:${id}:`;
    const keys = () => Object.keys(storage).filter(key => key.startsWith(prefix));
    const scoped = {
        getItem(key) { return storage.getItem(prefix + key); },
        setItem(key, value) { storage.setItem(prefix + key, String(value)); },
        removeItem(key) { storage.removeItem(prefix + key); },
        clear() { keys().forEach(key => storage.removeItem(key)); },
        key(index) { return keys()[index]?.slice(prefix.length) ?? null; },
        get length() { return keys().length; },
    };
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: scoped });
})();
