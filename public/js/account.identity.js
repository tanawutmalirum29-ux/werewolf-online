/*
 * Werewolf Account Identity — client-side storage adapter (Phase 1/2)
 *
 * Game Account identity is deliberately separate from room reconnect tokens:
 *   accountId    -> stable Game Account ID
 *   accountToken -> private credential for this temporary Login Identity
 *   ww_token     -> player-room reconnect token (managed by player.main.js)
 *   ww_host_token-> host-room reconnect token (managed by host.main.js)
 *
 * Normal mode uses localStorage so index / host / player share one account.
 * Tester mode uses sessionStorage so each tester tab remains isolated.
 */
(function () {
    const params = new URLSearchParams(location.search);
    const tester = params.get("tester") === "1";
    const storage = tester ? sessionStorage : localStorage;
    const ACCOUNT_ID_KEY = "ww_account_id";
    const ACCOUNT_TOKEN_KEY = "ww_account_token";
    const ACCOUNT_NAME_KEY = "ww_account_name";
    const ACCOUNT_TYPE_KEY = "ww_account_type";
    const ACCOUNT_EXPIRES_KEY = "ww_account_expires";
    // เมื่อบัญชีจริงถูกลบแล้ว ห้าม bootstrap อัตโนมัติสร้างบัญชีใหม่เงียบ ๆ
    // ผู้ใช้ต้องกด “สร้างบัญชีใหม่” และตั้งชื่อใหม่ก่อน จึงจะเริ่ม Temporary Account ใหม่ได้
    const ACCOUNT_RECREATE_REQUIRED_KEY = "ww_account_recreate_required";

    function randomToken() {
        if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID() + crypto.randomUUID();
        const a = new Uint8Array(24);
        if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
        return Array.from(a, x => x.toString(16).padStart(2, "0")).join("") + "-" + Date.now().toString(36);
    }
    function isRecreationRequired() {
        return storage.getItem(ACCOUNT_RECREATE_REQUIRED_KEY) === "1";
    }
    function getIdentity() {
        const accountType = storage.getItem(ACCOUNT_TYPE_KEY) || "temporary";
        const recreationRequired = isRecreationRequired();
        let accountToken = storage.getItem(ACCOUNT_TOKEN_KEY) || "";
        // Google Game Account ที่ session หมดอายุแล้วต้องคง accountId ไว้เพื่อ re-auth บัญชีเดิม
        // ห้ามสร้าง random temporary credential ทับโดยเงียบๆ เหมือนกรณี Temporary Account ครั้งแรก
        if (!accountToken && accountType !== "google" && !recreationRequired) {
            accountToken = randomToken();
            storage.setItem(ACCOUNT_TOKEN_KEY, accountToken);
        }
        return {
            accountId: storage.getItem(ACCOUNT_ID_KEY) || "",
            accountToken,
            name: storage.getItem(ACCOUNT_NAME_KEY) || "",
            accountType,
            temporaryExpiresAt: storage.getItem(ACCOUNT_EXPIRES_KEY) || "",
            recreationRequired,
        };
    }
    function applyAccount(account) {
        if (!account) return;
        if (account.accountId) storage.setItem(ACCOUNT_ID_KEY, account.accountId);
        // ได้บัญชีใหม่จาก server สำเร็จแล้ว ล้างธงบังคับสร้างใหม่
        storage.removeItem(ACCOUNT_RECREATE_REQUIRED_KEY);
        if (account.displayName) storage.setItem(ACCOUNT_NAME_KEY, account.displayName);
        if (account.accountType) storage.setItem(ACCOUNT_TYPE_KEY, account.accountType);
        if (account.temporaryExpiresAt) storage.setItem(ACCOUNT_EXPIRES_KEY, account.temporaryExpiresAt);
        else storage.removeItem(ACCOUNT_EXPIRES_KEY);
    }
    function getName() { return storage.getItem(ACCOUNT_NAME_KEY) || ""; }
    function setName(name) { storage.setItem(ACCOUNT_NAME_KEY, String(name || "").trim().slice(0, 24)); }
    function setAuthenticatedIdentity({ accountId = "", accountToken = "", name = "", accountType = "google", temporaryExpiresAt = "" } = {}) {
        // OAuth handoff สำเร็จ = ได้ตัวตนที่ยืนยันแล้ว จึงยกเลิกสถานะบังคับสร้างใหม่
        storage.removeItem(ACCOUNT_RECREATE_REQUIRED_KEY);
        if (accountId) storage.setItem(ACCOUNT_ID_KEY, String(accountId));
        if (accountToken) storage.setItem(ACCOUNT_TOKEN_KEY, String(accountToken));
        if (name) storage.setItem(ACCOUNT_NAME_KEY, String(name).trim().slice(0, 24));
        if (accountType) storage.setItem(ACCOUNT_TYPE_KEY, String(accountType));
        if (temporaryExpiresAt) storage.setItem(ACCOUNT_EXPIRES_KEY, String(temporaryExpiresAt));
        else storage.removeItem(ACCOUNT_EXPIRES_KEY);
    }
    async function logout() {
        const identity = getIdentity();
        if (identity.accountId && identity.accountToken) {
            try {
                await fetch("/api/account/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: identity.accountId, accountToken: identity.accountToken }) });
            } catch (_) {}
        }
        clearAccount();
    }
    function clearAccount() {
        storage.removeItem(ACCOUNT_ID_KEY);
        storage.removeItem(ACCOUNT_TOKEN_KEY);
        storage.removeItem(ACCOUNT_NAME_KEY);
        storage.removeItem(ACCOUNT_TYPE_KEY);
        storage.removeItem(ACCOUNT_EXPIRES_KEY);
    }
    function markAccountDeleted(reason = "deleted") {
        clearAccount();
        storage.setItem(ACCOUNT_RECREATE_REQUIRED_KEY, "1");
        window.dispatchEvent(new CustomEvent("wwAccountRecreationRequired", { detail: { reason: String(reason || "deleted") } }));
    }
    function beginNewTemporaryAccount(name = "") {
        clearAccount();
        storage.removeItem(ACCOUNT_RECREATE_REQUIRED_KEY);
        const safeName = String(name || "").trim().slice(0, 24);
        if (safeName) storage.setItem(ACCOUNT_NAME_KEY, safeName);
        // getIdentity() จะออก credential ใหม่ให้เฉพาะหลังจากปลด block แล้ว
        return getIdentity();
    }
    if (!tester) {
        window.addEventListener("storage", (event) => {
            if (event.storageArea !== localStorage) return;
            if ([ACCOUNT_ID_KEY, ACCOUNT_TOKEN_KEY, ACCOUNT_NAME_KEY, ACCOUNT_TYPE_KEY, ACCOUNT_EXPIRES_KEY].includes(event.key)) {
                window.dispatchEvent(new CustomEvent("wwAccountChanged", { detail: getIdentity() }));
            }
        });
    }
    function bootstrap(socket, { name = "", page = "unknown", _attempt = 0 } = {}) {
        return new Promise((resolve, reject) => {
            if (tester) return resolve(null);
            if (!socket || typeof socket.emit !== "function") {
                reject(Object.assign(new Error("account socket unavailable"), { code: "ACCOUNT_SOCKET_UNAVAILABLE" }));
                return;
            }
            if (isRecreationRequired()) {
                reject(Object.assign(new Error("account recreation required"), { code: "ACCOUNT_RECREATE_REQUIRED" }));
                return;
            }
            const identity = getIdentity();
            if (!identity.accountToken) {
                reject(Object.assign(new Error("account credential missing"), { code: "ACCOUNT_TOKEN_REQUIRED" }));
                return;
            }
            socket.emit("account_bootstrap", {
                accountId: identity.accountId,
                accountToken: identity.accountToken,
                name: String(name || getName() || "").trim().slice(0, 24),
                page,
            }, (res) => {
                if (res && res.ok && res.account) {
                    const returnedId = String(res.account.accountId || res.accountId || "").trim();
                    if (!returnedId) {
                        const err = Object.assign(new Error("server created account without Account ID"), { code: "ACCOUNT_ID_MISSING" });
                        if (_attempt < 2) {
                            setTimeout(() => bootstrap(socket, { name, page, _attempt: _attempt + 1 }).then(resolve).catch(reject), 250 * (_attempt + 1));
                        } else reject(err);
                        return;
                    }
                    applyAccount({ ...res.account, accountId: returnedId });
                    resolve({ ...getIdentity(), account: { ...res.account, accountId: returnedId } });
                    return;
                }
                // transient server/persistence failures: retry with the SAME credential.
                // This is important on Elastic Beanstalk/DynamoDB startup where the first
                // socket can arrive before the persistence layer is ready.
                if (_attempt < 2 && (res?.code === "ACCOUNT_PERSISTENCE_UNAVAILABLE" || res?.code === "ACCOUNT_BOOTSTRAP_FAILED" || res?.code === "ACCOUNT_DB_UNAVAILABLE")) {
                    setTimeout(() => bootstrap(socket, { name, page, _attempt: _attempt + 1 }).then(resolve).catch(reject), 400 * (_attempt + 1));
                    return;
                }
                // Google session หมดอายุ: คง accountId ไว้เพื่อ re-auth บัญชีเดิม
                if (res?.code === "ACCOUNT_SESSION_EXPIRED" && identity.accountType === "google") {
                    storage.removeItem(ACCOUNT_TOKEN_KEY);
                    window.dispatchEvent(new CustomEvent("wwGoogleReauthRequired", { detail: { accountId: identity.accountId, name: identity.name } }));
                    reject(Object.assign(new Error("Google session expired"), { code: "GOOGLE_REAUTH_REQUIRED" }));
                    return;
                }
                // บัญชีถูกลบ/หา accountId เดิมไม่พบ: ห้ามสร้างบัญชีใหม่อัตโนมัติ
                // เพราะจะทำให้การลบบัญชีไม่มีผลจริงและผู้ใช้กลับเข้าเกมโดยไม่รู้ว่า ID เปลี่ยนแล้ว
                if (res?.code === "ACCOUNT_DELETED" || res?.code === "ACCOUNT_NOT_FOUND") {
                    markAccountDeleted(res.code);
                    reject(Object.assign(new Error("account recreation required"), {
                        code: res.code === "ACCOUNT_DELETED" ? "ACCOUNT_DELETED_REQUIRES_RECREATE" : "ACCOUNT_NOT_FOUND_REQUIRES_RECREATE",
                        sourceCode: res.code,
                    }));
                    return;
                }
                // ACCOUNT_EXPIRED ต่างจากการลบบัญชีโดย Admin: Temporary Account หมดอายุสามารถ
                // ถูก cleanup แล้วออก credential ใหม่อัตโนมัติตามนโยบายเดิม
                if (_attempt < 1 && res?.code === "ACCOUNT_EXPIRED") {
                    clearAccount();
                    bootstrap(socket, { name: "", page, _attempt: _attempt + 1 }).then(resolve).catch(reject);
                    return;
                }
                reject(Object.assign(new Error((res && res.error) || "account bootstrap failed"), { code: res && res.code }));
            });
        });
    }
    function payload(extra) {
        const i = getIdentity();
        return Object.assign({ accountId: i.accountId, accountToken: i.accountToken }, extra || {});
    }
    function isTester() { return tester; }

    window.wwAccount = {
        storage, getIdentity, applyAccount, setAuthenticatedIdentity, getName, setName,
        clearAccount, markAccountDeleted, beginNewTemporaryAccount, isRecreationRequired,
        logout, bootstrap, payload, isTester,
    };
})();
