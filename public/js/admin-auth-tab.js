/* Tab-scoped Admin authentication. Google identity is verified server-side; the browser only keeps a short-lived bearer in sessionStorage. */
(function () {
    "use strict";
    const TAB_KEY = "ww_admin_tab_id";
    const TOKEN_KEY = "ww_admin_tab_token";
    const META_KEY = "ww_admin_tab_meta";
    const makeId = () => {
        try { if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, ""); } catch (_) {}
        return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    };
    const validId = (v) => /^[A-Za-z0-9_-]{16,128}$/.test(String(v || ""));
    const getTabId = () => {
        try {
            let id = sessionStorage.getItem(TAB_KEY);
            if (!validId(id)) { id = makeId(); sessionStorage.setItem(TAB_KEY, id); }
            return id;
        } catch (_) { return makeId(); }
    };
    const INSTANCE_KEY = makeId();
    const TAB_GUARD_CHANNEL = "ww_admin_tab_guard_v2";
    let tabGuardChannel = null;
    let tabGuardClosing = false;
    const tabGuardTimers = new Set();
    function rotateTabId() {
        try { sessionStorage.setItem(TAB_KEY, makeId()); sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(META_KEY); } catch (_) {}
    }
    function sendTabGuard(message) {
        try { tabGuardChannel?.postMessage(message); } catch (_) {}
    }
    function scheduleTabGuard(fn, delay = 70) {
        const timer = setTimeout(() => {
            tabGuardTimers.delete(timer);
            try { fn(); } catch (_) {}
        }, delay);
        tabGuardTimers.add(timer);
    }
    async function protectTabIdentity() {
        const current = getTabId();
        if (typeof BroadcastChannel === "undefined") return current;
        let channel = null;
        try { channel = new BroadcastChannel(TAB_GUARD_CHANNEL); } catch (_) { return current; }
        tabGuardChannel = channel;
        channel.onmessage = (event) => {
            const data = event?.data || {};
            const sameTab = data.tabId === getTabId();
            if (!sameTab || data.instance === INSTANCE_KEY || tabGuardClosing) return;
            if (data.type === "claim") {
                const other = String(data.instance || "");
                if (!other) return;
                // Wait a moment so a real pagehide/reload can announce closing before we arbitrate.
                scheduleTabGuard(() => {
                    if (tabGuardClosing || getTabId() !== current && getTabId() !== data.tabId) return;
                    if (other < String(INSTANCE_KEY)) {
                        rotateTabId();
                        sendTabGuard({ type:"claim", tabId:getTabId(), instance:INSTANCE_KEY });
                    } else {
                        sendTabGuard({ type:"claim_ack", tabId:getTabId(), instance:INSTANCE_KEY, forInstance:other });
                    }
                });
                return;
            }
            if (data.type === "claim_ack" && String(data.forInstance || "") === String(INSTANCE_KEY)) {
                const other = String(data.instance || "");
                if (other && other < String(INSTANCE_KEY)) {
                    rotateTabId();
                    sendTabGuard({ type:"claim", tabId:getTabId(), instance:INSTANCE_KEY });
                }
            }
        };
        try {
            window.addEventListener("pagehide", () => {
                tabGuardClosing = true;
                for (const timer of tabGuardTimers) clearTimeout(timer);
                tabGuardTimers.clear();
                sendTabGuard({ type:"closing", tabId:getTabId(), instance:INSTANCE_KEY });
                try { channel.close(); } catch (_) {}
            }, { once:true });
        } catch (_) {}
        sendTabGuard({ type:"claim", tabId:current, instance:INSTANCE_KEY });
        await new Promise(resolve => setTimeout(resolve, 160));
        return getTabId();
    }
    const tabReady = protectTabIdentity();
    const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch (_) { return ""; } };
    const getMeta = () => { try { return JSON.parse(sessionStorage.getItem(META_KEY) || "null") || null; } catch (_) { return null; } };
    const clear = () => { try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(META_KEY); } catch (_) {} };
    const setSession = (data) => {
        if (!data?.token || !validId(data.tabId) || data.tabId !== getTabId()) throw new Error("ADMIN_TAB_SESSION_INVALID");
        sessionStorage.setItem(TOKEN_KEY, data.token);
        sessionStorage.setItem(META_KEY, JSON.stringify({ email:data.email || "", provider:data.provider || "google", expiresAt:Number(data.expiresAt || 0) }));
    };
    async function exchangeTicket(ticket) {
        await tabReady;
        const r = await fetch("/api/admin/session/exchange", { method:"POST", headers:{"Content-Type":"application/json"}, credentials:"same-origin", cache:"no-store", body:JSON.stringify({ ticket, tabId:getTabId() }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { const e = new Error(d.code || "ADMIN_TAB_SESSION_EXCHANGE_FAILED"); e.code=e.message; throw e; }
        setSession(d);
        try { history.replaceState({}, "", "/admin.html"); } catch (_) {}
        return true;
    }
    async function consumeTicketFromUrl() {
        await tabReady;
        let ticket = "";
        try { const raw=String(location.hash || ""); const m=raw.match(/(?:^#|&)admin_ticket=([^&]+)/); if (m) ticket=decodeURIComponent(m[1]); } catch (_) {}
        if (!ticket) return false;
        try { await exchangeTicket(ticket); return true; } catch (e) {
            clear();
            try { history.replaceState({}, "", "/admin.html?admin_error=" + encodeURIComponent(e.code || "ADMIN_TAB_TICKET_INVALID")); } catch (_) {}
            return false;
        }
    }
    async function beginGoogleLogin() { await tabReady; window.location.assign("/auth/google/admin-start?tabId=" + encodeURIComponent(getTabId())); }
    function getSocketAuth() { return { admin:true, adminToken:getToken(), adminTabId:getTabId() }; }
    function patchAdminFetch() {
        if (window.__wwAdminFetchPatched) return;
        const native = window.fetch.bind(window);
        window.fetch = function (input, init) {
            let url="";
            try { url=typeof input === "string" ? input : String(input?.url || ""); } catch (_) {}
            if (!/^(?:https?:)?\/\//i.test(url) && /^\/api\/admin(?:\/|$)/.test(url)) {
                const headers = new Headers(init?.headers || (input && input.headers) || {});
                const token=getToken();
                if (token) headers.set("Authorization", "Bearer " + token);
                headers.set("X-WW-Admin-Tab-Id", getTabId());
                init={...(init || {}), headers, credentials:"same-origin"};
            }
            return native(input, init);
        };
        window.__wwAdminFetchPatched=true;
    }
    getTabId();
    patchAdminFetch();
    window.WWAdminTabAuth={TAB_KEY,TOKEN_KEY,getTabId,getToken,getMeta,setSession,clear,consumeTicketFromUrl,beginGoogleLogin,getSocketAuth,ready:tabReady};
})();
