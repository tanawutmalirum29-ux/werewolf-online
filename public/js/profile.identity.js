/*
 * Werewolf local profile.
 * Stores only the display name. Room reconnect is handled by the room token in each game page.
 */
(function () {
    "use strict";

    const NAME_KEY = "ww_profile_name";
    const LEGACY_KEYS = ["ww_playerName", "ww_host_display_name"];
    const MAX = 24;
    const TESTER = new URLSearchParams(location.search).get("tester") === "1";

    function getStorage() {
        try {
            return TESTER ? sessionStorage : localStorage;
        } catch (_) {
            return null;
        }
    }

    function clean(value) {
        return String(value ?? "").replace(/\s+/gu, "").slice(0, MAX);
    }

    function getName() {
        const storage = getStorage();
        if (!storage) return "";
        const current = clean(storage.getItem(NAME_KEY) || "");
        if (current) return current;
        for (const key of LEGACY_KEYS) {
            const legacy = clean(storage.getItem(key) || "");
            if (legacy) {
                try { storage.setItem(NAME_KEY, legacy); } catch (_) {}
                return legacy;
            }
        }
        return "";
    }

    function setName(value) {
        const name = clean(value);
        if (!name) return false;
        const storage = getStorage();
        if (!storage) return false;
        try { storage.setItem(NAME_KEY, name); } catch (_) { return false; }
        return true;
    }

    function clear() {
        const storage = getStorage();
        if (!storage) return;
        try { storage.removeItem(NAME_KEY); } catch (_) {}
    }

    function payload(extra = {}) {
        return { ...extra, name: getName() };
    }

    window.wwProfile = { getName, setName, clear, payload, isTester: () => TESTER };
    window.dispatchEvent(new CustomEvent("wwProfileReady", { detail: { name: getName() } }));
})();
