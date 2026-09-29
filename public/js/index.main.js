// ===== Game Account =====
// เก็บใน localStorage 2 คีย์ให้ตรงกับที่ host.main.js / player.main.js อ่านอยู่แล้ว (ww_host_display_name,
// ww_playerName) เพื่อไม่ต้องแก้ logic การอ่านชื่อฝั่งนั้นเลยตอนเป็นโหมดปกติ (คนละแท็บ แต่ origin
// เดียวกัน ใช้ localStorage ก้อนเดียวกันอยู่แล้ว) ส่วนโหมดผู้ทดสอบ (tester) ทั้งสองหน้าจะสลับไปใช้
// sessionStorage ของแท็บนั้นๆ แทน (แยกอิสระต่อแท็บ) เลยต้องพ่วงชื่อไปกับ URL ตอนพาไปหน้าเป้าหมายด้วย
// ให้แต่ละหน้าไปเซ็ตใส่ sessionStorage ของตัวเองอีกที (ปุ่มเข้าโหมดผู้ทดสอบย้ายไปอยู่ที่ admin.html
// แท็บ ⚙️ จัดการระบบ แล้ว — หน้านี้ไม่มีปุ่มนั้นอีก)
//
// ครั้งแรก server จะสร้าง Temporary Account และชื่อสุ่มให้ทันที; ผู้เล่นเปลี่ยนชื่อเองได้จาก Profile
// โดย Account ID จะคงเดิมตลอดอายุบัญชี
const PLAYER_NAME_KEY = "ww_playerName";
const HOST_DISPLAY_NAME_KEY = "ww_host_display_name";
const NAME_MAX_LENGTH = 24;
const RESERVED_TESTER_NAME_RE = /^(?:player|ผู้เล่น)(?:[0-9]+)?$/iu;

function normalizeNameInput(value) {
    return String(value ?? "").replace(/\s+/gu, "").slice(0, NAME_MAX_LENGTH);
}

function isReservedTesterNameInput(value) {
    return RESERVED_TESTER_NAME_RE.test(normalizeNameInput(value));
}

function bindNameInputRestrictions(input) {
    if (!input || input.dataset.namePolicyBound === "1") return input;
    input.dataset.namePolicyBound = "1";
    // กด Space บนคีย์บอร์ดจริง = ไม่มีผลทันที; input handler ด้านล่างรองรับ paste/IME/การกรอกที่ไม่ผ่าน keydown ด้วย
    input.addEventListener("keydown", (event) => {
        if (event.key === " " || event.code === "Space") event.preventDefault();
    });
    input.addEventListener("input", () => {
        const normalized = normalizeNameInput(input.value);
        if (input.value !== normalized) input.value = normalized;
    });
    return input;
}

const indexSocket = io();
if (!window.__wwAccountSessionRevokedListener) {
    indexSocket.on("account_session_revoked", async function (info) {
        let result = null;
        try { result = window.wwAccount?.handleSessionRevoked(info?.reason || "session_replaced", info || {}); } catch (_) {}
        const sameDevice = !!result?.sameDeviceReplacement;
        window.dispatchEvent(new CustomEvent("wwAccountSessionRevoked", { detail: { reason: String(info?.reason || "session_replaced"), page: "index", sameDeviceReplacement: sameDevice, deviceId: String(info?.deviceId || ""), previousAccountToken: String(result?.previousAccountToken || "") } }));
        if (!sameDevice || !window.wwAccount) return;
        const replacement = await window.wwAccount.waitForSessionReplacement(result.previousAccountToken, { timeoutMs: 8000, pollMs: 120 });
        if (!replacement.ok) {
            window.dispatchEvent(new CustomEvent("wwAccountSessionReplacementFailed", { detail: { page: "index", code: replacement.code || "ACCOUNT_SESSION_REPLACEMENT_TIMEOUT" } }));
            return;
        }
        try {
            if (!indexSocket.connected) indexSocket.connect();
            else await bootstrapIndexAccount();
        } catch (e) {
            window.dispatchEvent(new CustomEvent("wwAccountSessionReplacementFailed", { detail: { page: "index", code: e?.code || "ACCOUNT_SESSION_REPLACEMENT_BOOTSTRAP_FAILED" } }));
        }
    });
    window.__wwAccountSessionRevokedListener = true;
}

const indexRuntime = window.WWGameRuntime?.attach(indexSocket, { page: "index" });

indexSocket.on("serverInfo", function (info) {
    if (window.wwSetServerVersion) window.wwSetServerVersion(info && info.version);
});
let indexPresenceTimer = null;
let indexAccountReady = Promise.resolve(null);
let indexAuthConfigPromise = null;
let indexBootstrapPromise = null;
function getIndexAuthConfig(){
    if (!indexAuthConfigPromise) {
        indexAuthConfigPromise = fetch("/api/auth/config", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ googleConfigured:false }));
    }
    return indexAuthConfigPromise;
}
function wwIndexConfirm(message, options = {}){
    const statsModal = document.getElementById("statsModal");
    const anchor = options.anchor instanceof Element ? options.anchor : null;
    if (!statsModal || statsModal.classList.contains("hidden") || !anchor) {
        return wwConfirm(message, options);
    }

    return new Promise((resolve) => {
        const slot = anchor.parentElement;
        if (!slot) return resolve(false);
        slot.querySelector(".account-inline-confirm")?.remove();
        anchor.classList.add("confirm-source-hidden");

        const panel = document.createElement("div");
        panel.className = `account-inline-confirm${options.danger ? " danger" : ""}`;
        panel.innerHTML = `
            <div class="account-inline-confirm-message"></div>
            <div class="account-inline-confirm-actions">
                <button type="button" class="account-inline-confirm-cancel"></button>
                <button type="button" class="account-inline-confirm-ok"></button>
            </div>`;
        panel.querySelector(".account-inline-confirm-message").textContent = message;
        panel.querySelector(".account-inline-confirm-cancel").textContent = options.cancelText || "ยกเลิก";
        panel.querySelector(".account-inline-confirm-ok").textContent = options.okText || "ยืนยัน";

        const finish = (value) => {
            panel.remove();
            anchor.classList.remove("confirm-source-hidden");
            resolve(value);
        };
        panel.querySelector(".account-inline-confirm-ok").onclick = () => finish(true);
        panel.querySelector(".account-inline-confirm-cancel").onclick = () => finish(false);
        slot.appendChild(panel);
        panel.querySelector(".account-inline-confirm-ok").focus();
    });
}

function showAccountInlineNotice(message, { danger = false } = {}) {
    const body = document.getElementById("statsModalBody");
    if (!body || document.getElementById("statsModal")?.classList.contains("hidden")) {
        return wwAlert(message);
    }
    body.querySelector(".account-inline-notice")?.remove();
    const panel = document.createElement("div");
    panel.className = `account-inline-notice${danger ? " danger" : ""}`;
    panel.innerHTML = `<div class="account-inline-notice-title">${danger ? "⚠️ ดำเนินการไม่สำเร็จ" : "ℹ️ แจ้งเตือน"}</div><div class="account-inline-notice-message"></div><button type="button" class="account-inline-notice-close">ปิด</button>`;
    panel.querySelector(".account-inline-notice-message").textContent = message;
    panel.querySelector(".account-inline-notice-close").onclick = () => panel.remove();
    body.prepend(panel);
    panel.scrollIntoView({ block:"nearest", behavior:"smooth" });
    return Promise.resolve(true);
}

async function ensureIndexAccountReady() {
    if (!window.wwAccount || window.wwAccount.isTester()) return null;
    if (!indexSocket.connected) {
        try { indexSocket.connect(); } catch (_) {}
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error("account socket timeout"), { code:"ACCOUNT_SOCKET_TIMEOUT" })); }, 7000);
            const cleanup = () => { clearTimeout(timer); indexSocket.off("connect", ok); indexSocket.off("connect_error", fail); };
            const ok = () => { cleanup(); resolve(); };
            const fail = (e) => { cleanup(); reject(e); };
            indexSocket.once("connect", ok);
            indexSocket.once("connect_error", fail);
        });
    }
    const data = await bootstrapIndexAccount();
    const identity = window.wwAccount.getIdentity();
    if (!data?.accountId || !identity.accountId || !identity.accountToken) {
        throw Object.assign(new Error("บัญชียังไม่ได้รับ Account ID จากเซิร์ฟเวอร์"), { code:"ACCOUNT_ID_MISSING" });
    }
    return data;
}

async function getIndexAccountContext() {
    const identity = window.wwAccount?.getIdentity?.();
    if (!identity?.accountId || !identity?.accountToken) return null;
    const headers = {
        "X-WW-Account-Id": identity.accountId,
        "X-WW-Account-Token": identity.accountToken,
        "X-WW-Device-Id": identity.deviceId || "",
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            const r = await fetch(`/api/account/context?accountId=${encodeURIComponent(identity.accountId)}`, { cache:"no-store", credentials:"same-origin", headers });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.ok) return d;
            const transient = ["ROOM_FAILOVER_WAIT", "ROOM_LEASE_UNAVAILABLE"].includes(String(d?.code || "")) || r.status === 502 || r.status === 503 || r.status === 504;
            if (!transient) return null;
            const retryMs = Math.max(500, Math.min(3000, Number(d?.retryAfterMs) || (700 + attempt * 300)));
            await new Promise((resolve) => setTimeout(resolve, retryMs));
        } catch (_) {
            if (attempt >= 7) return null;
            await new Promise((resolve) => setTimeout(resolve, Math.min(2500, 700 + attempt * 250)));
        }
    }
    return null;
}
function shouldRouteIndexToActivity() {
    try {
        if (new URLSearchParams(location.search).get("stay") === "1") return false;
        if (window.top !== window.self) return false;
        if (location.pathname.startsWith("/__ww_admin_embed__/") || location.pathname.startsWith("/admin")) return false;
        return true;
    } catch (_) { return true; }
}
async function routeIndexToActiveActivity() {
    if (!shouldRouteIndexToActivity() || !window.wwAccount || window.wwAccount.isTester?.()) return false;
    const context = await getIndexAccountContext();
    const activity = context?.activeActivity;
    const room = context?.room;
    if (!activity?.roomId || !room) return false;
    const roomId = String(activity.roomId).trim().toUpperCase();
    if (!roomId) return false;
    if (String(activity.type) === "HOST_ROOM") {
        location.replace(`/host.html?room=${encodeURIComponent(roomId)}&activity=1`);
        return true;
    }
    if (String(activity.type) === "PLAYER_ROOM") {
        location.replace(`/player.html?room=${encodeURIComponent(roomId)}&activity=1`);
        return true;
    }
    return false;
}

async function startGoogleAuthentication(mode, anchor){
    if (!window.wwAccount) return;
    let identity = window.wwAccount.getIdentity();
    if (mode === "link" && (!identity.accountId || !identity.accountToken)) {
        try {
            await ensureIndexAccountReady();
            identity = window.wwAccount.getIdentity();
        } catch (e) {
            return showAccountInlineNotice(e?.code === "ACCOUNT_ID_MISSING"
                ? "บัญชีชั่วคราวยังไม่ได้รับ Account ID จากเซิร์ฟเวอร์ จึงยังเชื่อม Google ไม่ได้ กรุณารอให้บัญชีซิงก์กับเซิร์ฟเวอร์ก่อน"
                : "ยังยืนยันบัญชีชั่วคราวนี้ไม่ได้ กรุณารีเฟรชหน้าแล้วลองใหม่", { danger:true });
        }
    }
    if (mode === "link" && (!identity.accountId || !identity.accountToken)) return showAccountInlineNotice("บัญชีชั่วคราวยังไม่พร้อมสำหรับการเชื่อม Google", { danger:true });
    const cfg = await getIndexAuthConfig();
    if (!cfg.googleConfigured) {
        const missing = Array.isArray(cfg.missing) && cfg.missing.length ? `\nยังขาดการตั้งค่า: ${cfg.missing.join(", ")}` : "";
        return showAccountInlineNotice(`เซิร์ฟเวอร์ Google Login ยังไม่ได้ตั้งค่าครบ${missing}`, { danger:true });
    }
    const reauth = mode === "login" && identity.accountType === "google" && !!identity.accountId;
    if (mode === "login") {
        const ok = await wwIndexConfirm(
            reauth
                ? "เซสชัน Google ของเครื่องนี้หมดอายุแล้ว — เชื่อมต่ออีกครั้งเพื่อกลับไปยัง Game Account เดิม"
                : "เปลี่ยนไปใช้บัญชี Google — ระบบจะเปิด Game Account ที่ผูกกับ Google นี้ ถ้ายังไม่มีบัญชี ระบบจะสร้าง Game Account ใหม่ให้",
            { okText:"ไปต่อ", cancelText:"ยกเลิก", anchor }
        );
        if (!ok) return;
    }
    try {
        // Login/re-auth does not carry a secret, so use a same-origin browser navigation instead
        // of POST /api/auth/google/start. This avoids CloudFront POST behavior/origin mismatches
        // while preserving the same signed state + PKCE + HttpOnly-cookie flow on the server.
        if (mode === "login") {
            const params = new URLSearchParams();
            if (identity.accountId) params.set("accountId", identity.accountId);
            if (reauth) params.set("reauth", "1");
            if (identity.deviceId) params.set("deviceId", identity.deviceId);
            params.set("returnTo", "/");
            window.location.assign(`/auth/google/start?${params.toString()}`);
            return;
        }

        // Link still uses POST because it must send the existing Game Account credential to the
        // server for authentication; the credential is never put into the Google URL.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let r;
        try {
            r = await fetch("/api/auth/google/start", {
                method:"POST", headers:{"Content-Type":"application/json"}, cache:"no-store", credentials:"same-origin",
                signal:controller.signal,
                body:JSON.stringify({ mode:"link", accountId:identity.accountId, accountToken:identity.accountToken, reauth:false, deviceId:identity.deviceId, returnTo:"/" })
            });
        } finally {
            clearTimeout(timer);
        }
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok || !d.url) throw Object.assign(new Error(d.error || d.code || "google_start_failed"), { code:d.code });
        window.location.assign(d.url);
    } catch (e) {
        const messages = {
            GOOGLE_ALREADY_LINKED:"Google บัญชีนี้เชื่อมกับ Game Account อื่นแล้ว",
            ACCOUNT_SUSPENDED:"บัญชีถูกพักอยู่",
            ACCOUNT_EXPIRED:"บัญชีชั่วคราวหมดอายุแล้ว",
            ACCOUNT_AUTH_REQUIRED:"ยืนยันบัญชีไม่สำเร็จ",
            ACCOUNT_AUTH_TIMEOUT:"เซิร์ฟเวอร์ยืนยันบัญชีใช้เวลานานเกินไป กรุณาลองเชื่อม Google อีกครั้ง",
            ACCOUNT_NOT_FOUND:"ไม่พบบัญชีเกมนี้",
        };
        const message = e?.name === "AbortError"
            ? "เซิร์ฟเวอร์ใช้เวลาตอบกลับนานเกินไป กรุณาลองเชื่อม Google ใหม่อีกครั้ง"
            : (messages[e.code] || "เริ่ม Google Login ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        showAccountInlineNotice(message, { danger:true });
    }
}
async function logoutGoogleAccount(anchor){
    if (!window.wwAccount) return;
    const identity = window.wwAccount.getIdentity();
    const ok = await wwIndexConfirm("ออกจากบัญชี Google ในเครื่องนี้ — Game Account จะยังอยู่บนเซิร์ฟเวอร์ แต่เซสชัน Google ของเครื่องนี้จะถูกยกเลิก", { okText:"ออกจากระบบ", cancelText:"ยกเลิก", anchor, danger:true });
    if (!ok) return;
    try { await window.wwAccount.logout(); } catch (_) { window.wwAccount.clearAccount(); }
    try { localStorage.removeItem(PLAYER_NAME_KEY); localStorage.removeItem(HOST_DISPLAY_NAME_KEY); } catch (_) {}
    location.replace("/");
}
window.addEventListener("wwAccountChanged", () => { refreshNameUI(); sendIndexPresence(); });
window.addEventListener("wwAccountSessionRevoked", (event) => {
    if (event?.detail?.sameDeviceReplacement) return;
    if (typeof wwToast === "function") wwToast("เซสชันบัญชีนี้ถูกแทนที่ด้วยการเข้าสู่ระบบจากอุปกรณ์อื่น", { type:"warning", duration:2600 });
});
function getSavedDisplayName(){
    return window.wwAccount?.getName() || localStorage.getItem(PLAYER_NAME_KEY) || localStorage.getItem(HOST_DISPLAY_NAME_KEY) || "";
}

// Profile presentation follows available viewport space rather than a device label.
// >= 1120px wide + >= 560px high gets the always-visible right-side Profile dock.
// Smaller layouts keep the exact same Profile data in the modal presentation so the
// lobby never has to squeeze the Start Game surface into an unusably narrow column.
let indexProfileDocked = false;
function shouldDockIndexProfile(){
    return window.matchMedia?.("(min-width: 1120px) and (min-height: 560px)").matches || false;
}
function syncIndexProfileLayout(){
    const body = document.body;
    const name = getSavedDisplayName();
    const shouldDock = !!name && shouldDockIndexProfile();
    const wasDocked = indexProfileDocked;
    indexProfileDocked = shouldDock;
    body.classList.toggle("profile-docked", shouldDock);
    const statsModal = document.getElementById("statsModal");
    if (statsModal) statsModal.setAttribute("aria-modal", shouldDock ? "false" : "true");
    const nameBadge = document.getElementById("nameBadge");
    if (nameBadge && getSavedDisplayName()) {
        nameBadge.setAttribute("aria-hidden", shouldDock ? "true" : "false");
    }

    if (shouldDock && !statsModal?.classList.contains("hidden")) return;
    if (shouldDock && document.getElementById("statsModal")?.classList.contains("hidden")) {
        openStatsModal();
        return;
    }
    if (!shouldDock && wasDocked) closeStatsModal();
}
function syncLegacyNameStores(name){
    const safe = normalizeNameInput(name);
    if (!safe) return;
    localStorage.setItem(PLAYER_NAME_KEY, safe);
    localStorage.setItem(HOST_DISPLAY_NAME_KEY, safe);
    if (window.wwAccount) window.wwAccount.setName(safe);
}
function showAccountRecreateGate(reason = "deleted") {
    const overlay = document.getElementById("accountRecreateOverlay");
    const input = document.getElementById("accountRecreateName");
    const error = document.getElementById("accountRecreateError");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    if (error) error.textContent = "";
    if (input) {
        // ไม่ดึงชื่อเก่ากลับมา: การสร้างใหม่ต้องตั้งชื่อใหม่จริง ๆ
        if (reason !== "create_failed") input.value = "";
        input.dataset.reason = String(reason || "deleted");
        setTimeout(() => input.focus(), 30);
    }
}
function hideAccountRecreateGate() {
    const overlay = document.getElementById("accountRecreateOverlay");
    if (overlay) overlay.classList.add("hidden");
}
async function startNewAccountAfterDeletion() {
    const input = document.getElementById("accountRecreateName");
    const error = document.getElementById("accountRecreateError");
    const button = document.getElementById("accountRecreateButton");
    const name = normalizeNameInput(input?.value || "");
    if (input) input.value = name;
    if (!name) {
        if (error) error.textContent = "กรอกชื่อบัญชีใหม่ก่อน";
        input?.focus();
        return;
    }
    if (isReservedTesterNameInput(name)) {
        if (error) error.textContent = "ชื่อนี้สงวนไว้สำหรับ Player Tester";
        input?.focus();
        return;
    }
    if (error) error.textContent = "";
    if (button) button.disabled = true;
    try {
        window.wwAccount.beginNewTemporaryAccount(name);
        hideAccountRecreateGate();
        if (!indexSocket.connected) {
            indexSocket.connect();
            // connect handler จะเริ่ม bootstrapIndexAccount() ให้อยู่แล้ว; รอ promise นั้น
            // เพื่อไม่ยิง account_bootstrap ซ้ำสองครั้งพร้อมกัน
            await new Promise((resolve, reject) => {
                let settled = false;
                const done = () => { if (!settled) { settled = true; resolve(); } };
                const fail = (err) => { if (!settled) { settled = true; reject(err); } };
                indexSocket.once("connect", done);
                indexSocket.once("connect_error", fail);
            });
        } else {
            // ถ้า socket ยังต่ออยู่หลัง redirect/overlay เราต้องเริ่ม bootstrap รอบสร้างบัญชีใหม่เอง
            // เพราะ indexAccountReady จากรอบที่ล้มเหลวเดิมอาจ resolve เป็น null ไปแล้ว
            bootstrapIndexAccount();
        }
        const data = await indexAccountReady;
        if (!data?.accountId) throw Object.assign(new Error("new account bootstrap failed"), { code: "NEW_ACCOUNT_BOOTSTRAP_FAILED" });
        syncLegacyNameStores(name);
        refreshNameUI();
        sendIndexPresence();
    } catch (e) {
        console.error("[account] new account creation failed", e);
        showAccountRecreateGate("create_failed");
        if (error) error.textContent = "สร้างบัญชีใหม่ไม่สำเร็จ กรุณาลองอีกครั้ง";
    } finally {
        if (button) button.disabled = false;
    }
}
function handleAccountBootstrapFailure(e) {
    if (e?.code === "ACCOUNT_RECREATE_REQUIRED" || e?.code === "ACCOUNT_DELETED_REQUIRES_RECREATE" || e?.code === "ACCOUNT_NOT_FOUND_REQUIRES_RECREATE") {
        showAccountRecreateGate(e.sourceCode || e.code);
        return true;
    }
    return false;
}
function bootstrapIndexAccount(){
    if (!window.wwAccount || !indexSocket.connected) return Promise.resolve(null);
    if (indexBootstrapPromise) return indexBootstrapPromise;
    indexBootstrapPromise = window.wwAccount.bootstrap(indexSocket, { name: getSavedDisplayName(), page: "index" })
        .then((data) => {
            if (data?.name) syncLegacyNameStores(data.name);
            hideAccountRecreateGate();
            refreshNameUI();
            sendIndexPresence();
            return data;
        })
        .catch((e) => {
            console.error("[account] bootstrap failed", e);
            // When index is leaving the page (for example OAuth navigation), a late socket ACK
            // rejection is expected lifecycle noise. Do not surface it as an unhandled rejection
            // after pagehide; the next page owns the login flow.
            if (window.__WW_DIAG_PAGEHIDE__) return null;
            if (!handleAccountBootstrapFailure(e)) showAccountInlineNotice(e?.code === "ACCOUNT_PERSISTENCE_UNAVAILABLE" ? "เชื่อมฐานข้อมูลบัญชีไม่สำเร็จชั่วคราว กรุณาลองใหม่" : "เตรียมบัญชีไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", { danger:true });
            throw e;
        })
        .finally(() => { indexBootstrapPromise = null; });
    indexAccountReady = indexBootstrapPromise;
    return indexAccountReady;
}
let indexAccountTouchInFlight = null;

async function touchIndexAccount(reason = "touch") {
    if (!window.wwAccount || window.wwAccount.isTester()) return { ok:false, code:"IGNORED" };
    if (indexAccountTouchInFlight) return indexAccountTouchInFlight;

    indexAccountTouchInFlight = (async () => {
        try {
            // Never emit account_touch onto a disconnected Socket.IO transport.
            // The old direct emit could wait for the global diagnostic ACK timeout (15s)
            // while the socket was already offline, producing Issue #5 on the index page.
            if (!indexSocket.connected) {
                try { indexSocket.connect(); } catch (_) {}
                try {
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error("account socket timeout"), { code:"ACCOUNT_SOCKET_TIMEOUT" })); }, 7000);
                        const cleanup = () => { clearTimeout(timer); indexSocket.off("connect", onConnect); indexSocket.off("connect_error", onConnectError); };
                        const onConnect = () => { cleanup(); resolve(); };
                        const onConnectError = (error) => { cleanup(); reject(error); };
                        indexSocket.once("connect", onConnect);
                        indexSocket.once("connect_error", onConnectError);
                    });
                } catch (e) {
                    return { ok:false, code:String(e?.code || "ACCOUNT_SOCKET_UNAVAILABLE"), error:String(e?.message || e || "") };
                }
            }

            let identity = window.wwAccount.getIdentity();
            // Profile access normally already has a stable Account ID/token. Bootstrap only
            // when the identity is genuinely incomplete, avoiding an extra persistence write
            // every time the profile panel opens.
            if (!identity.accountId || !identity.accountToken) {
                try {
                    const data = await bootstrapIndexAccount();
                    identity = window.wwAccount.getIdentity();
                    if (!data?.accountId || !identity.accountId || !identity.accountToken) return { ok:false, code:"ACCOUNT_ID_MISSING" };
                } catch (e) {
                    return { ok:false, code:String(e?.code || "ACCOUNT_SOCKET_UNAVAILABLE"), error:String(e?.message || e || "") };
                }
            }
            if (!indexSocket.connected) return { ok:false, code:"ACCOUNT_SOCKET_UNAVAILABLE" };

            return await new Promise((resolve) => {
                let settled = false;
                let timer = null;
                const cleanup = () => {
                    if (timer) clearTimeout(timer);
                    timer = null;
                    indexSocket.off("disconnect", onDisconnect);
                };
                const finish = (result) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(result || { ok:false, code:"ACCOUNT_TOUCH_EMPTY_ACK" });
                };
                const onDisconnect = (socketReason) => finish({
                    ok:false, code:"ACCOUNT_TOUCH_SOCKET_DISCONNECTED", reason:String(socketReason || "")
                });

                indexSocket.once("disconnect", onDisconnect);
                timer = setTimeout(() => finish({ ok:false, code:"ACCOUNT_TOUCH_ACK_TIMEOUT" }), 9000);
                try {
                    indexSocket.emit("account_touch", window.wwAccount.payload({ reason }), finish);
                } catch (e) {
                    finish({ ok:false, code:"ACCOUNT_TOUCH_EMIT_FAILED", error:String(e?.message || e || "") });
                }
            });
        } finally {
            indexAccountTouchInFlight = null;
        }
    })();
    return indexAccountTouchInFlight;
}

function sendIndexPresence(){
    if (!indexSocket.connected || !window.wwAccount || window.wwAccount.isTester()) return;
    const identity = window.wwAccount.getIdentity();
    const name = getSavedDisplayName();
    if (!identity.accountId || !identity.accountToken) return;
    indexSocket.emit("presence_hello", window.wwAccount.payload({
        token: "",
        name,
        page:"index",
        visible:document.visibilityState === "visible"
    }), (res)=>{
        if (res?.ok && res.name) {
            syncLegacyNameStores(res.name);
            refreshNameUI();
            return;
        }
        if (res?.code === "ACCOUNT_DELETED" || res?.code === "ACCOUNT_NOT_FOUND") {
            try { window.wwAccount?.markAccountDeleted(res.code); } catch (_) {}
            try { localStorage.removeItem(PLAYER_NAME_KEY); localStorage.removeItem(HOST_DISPLAY_NAME_KEY); } catch (_) {}
            showAccountRecreateGate(res.code);
            return;
        }
        if (res?.code === "ACCOUNT_EXPIRED" || res?.code === "ACCOUNT_SESSION_EXPIRED") {
            try { window.wwAccount?.clearAccount(); } catch (_) {}
            try { localStorage.removeItem(PLAYER_NAME_KEY); localStorage.removeItem(HOST_DISPLAY_NAME_KEY); } catch (_) {}
            location.reload();
        }
    });
}
indexSocket.on("connect", bootstrapIndexAccount);
(async function(){
    try { await ensureIndexAccountReady(); } catch (_) {}
    try { await routeIndexToActiveActivity(); } catch (_) {}
})();

document.addEventListener("visibilitychange", sendIndexPresence);
window.addEventListener("beforeunload", ()=>{ try { indexSocket.disconnect(); } catch (_) {} });
if (!indexPresenceTimer) indexPresenceTimer = setInterval(sendIndexPresence, 20000);

function saveDisplayName(name){
    const safe = normalizeNameInput(name);
    if (!safe || isReservedTesterNameInput(safe)) return false;
    syncLegacyNameStores(safe);
    setTimeout(sendIndexPresence, 0);
    return true;
}

// สลับ UI ของชื่อหน้าแรกตามสถานะบัญชี: ก่อนตั้งชื่อใช้ช่องกรอก; หลังตั้งแล้วใช้ชื่อบัญชี/โปรไฟล์ตามขนาดพื้นที่
// เรียกทั้งตอนเปิดหน้าครั้งแรก และทันทีหลังบันทึกชื่อสำเร็จครั้งแรก (ในensureDisplayName ด้านล่าง)
function refreshNameUI(){
    const name = getSavedDisplayName();
    const nameField = document.getElementById("nameField");
    const nameBadge = document.getElementById("nameBadge");
    if (name) {
        nameField.classList.add("hidden");
        document.getElementById("nameBadgeText").textContent = name;
        nameBadge.classList.remove("hidden");
        nameBadge.setAttribute("aria-label", `เปิดโปรไฟล์ของ ${name}`);
        nameBadge.setAttribute("aria-hidden", document.body.classList.contains("profile-docked") ? "true" : "false");
    } else {
        nameField.classList.remove("hidden");
        nameBadge.classList.add("hidden");
        nameBadge.removeAttribute("aria-label");
        nameBadge.removeAttribute("aria-hidden");
    }
    syncIndexProfileLayout();
}

// เติมชื่อล่าสุดที่เคยตั้งไว้ให้อัตโนมัติทันทีที่เปิดหน้า (ถ้าเคยตั้งมาก่อน) แล้วสลับ UI ให้ตรงสถานะ
const displayNameInput = document.getElementById("displayNameInput");
const accountRecreateNameInput = document.getElementById("accountRecreateName");
bindNameInputRestrictions(displayNameInput);
bindNameInputRestrictions(accountRecreateNameInput);
if (displayNameInput) displayNameInput.value = normalizeNameInput(getSavedDisplayName());
refreshNameUI();
if (indexSocket.connected) bootstrapIndexAccount();

// ตรวจ + บันทึกชื่อก่อนจะพาไปหน้าอื่นเสมอ — ถ้ายังไม่กรอกชื่อ โชว์ข้อความเตือน + เขย่าช่องชื่อ
// แล้ว "ไม่พาไปต่อ" คืนค่า false ให้ฟังก์ชันที่เรียกใช้หยุดทำงานต่อ
function ensureDisplayName(){
    const input = document.getElementById("displayNameInput");
    const name = normalizeNameInput(input.value) || normalizeNameInput(getSavedDisplayName());
    input.value = name;
    if (!name) {
        document.getElementById("displayNameError").textContent = "กรอกชื่อของคุณก่อนนะ";
        input.classList.remove("shake");
        void input.offsetWidth;
        input.classList.add("shake");
        input.focus();
        return false;
    }
    if (isReservedTesterNameInput(name)) {
        document.getElementById("displayNameError").textContent = "ชื่อนี้สงวนไว้สำหรับ Player Tester";
        input.classList.remove("shake");
        void input.offsetWidth;
        input.classList.add("shake");
        input.focus();
        return false;
    }
    document.getElementById("displayNameError").textContent = "";
    if (!saveDisplayName(name)) return false;
    refreshNameUI(); // ตั้งชื่อสำเร็จครั้งแรก — ซ่อนช่องกรอกทันที เปลี่ยนไปโชว์ป้ายมุมขวาบนแทน
    return true;
}

document.getElementById("displayNameInput").addEventListener("input", () => {
    document.getElementById("displayNameError").textContent = "";
});

// ===== Profile panel: modal on compact screens / docked panel on large screens =====
// ดึงจาก /api/player-stats?name=... (endpoint ฝั่ง server อ่านจากไฟล์สถิติถาวร บันทึกไว้ทุกครั้งที่
// จบเกม ดู recordGameStats ใน server.js) แสดงอัตราชนะรวม + กางดูแยกตาม "ทีม" (หมาป่า/ชาวบ้าน/ฯลฯ)
// ได้อีกที ใต้แต่ละทีมกางย่อยลงไปเป็นรายอาชีพอีกชั้นผ่าน <details> ของ HTML เอง ไม่ต้องเขียน
// toggle logic เอง
function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function openStatsModal(){
    const name = getSavedDisplayName();
    if (!name || !window.wwAccount) return;

    document.getElementById("statsModalName").textContent = "กำลังโหลดข้อมูลบัญชี…";
    closeRenameAccountEditor();
    document.getElementById("statsModalBody").innerHTML = '<div class="stats-loading">กำลังโหลด…</div>';
    document.getElementById("statsModal").classList.remove("hidden");

    const identityForStats = window.wwAccount?.getIdentity?.() || {};
    const statsUrl = "/api/player-stats?name=" + encodeURIComponent(name) + (identityForStats.accountId ? "&accountId=" + encodeURIComponent(identityForStats.accountId) : "");
    touchIndexAccount("open_profile").then((res) => {
        if (res?.ok) return;
        if (res?.code === "ACCOUNT_EXPIRED" || res?.code === "ACCOUNT_DELETED" || res?.code === "ACCOUNT_NOT_FOUND") {
            try { window.wwAccount.markAccountDeleted(res.code); } catch (_) {}
            try { localStorage.removeItem(PLAYER_NAME_KEY); localStorage.removeItem(HOST_DISPLAY_NAME_KEY); } catch (_) {}
            showAccountRecreateGate(res.code);
        }
        if (res?.code === "ACCOUNT_SUSPENDED") {
            wwAlert("บัญชีนี้ถูกพักอยู่");
        }
        // Socket lifecycle failures are intentionally non-blocking for the profile UI.
        // The stats request can still render independently, while the next connection/presence
        // cycle will synchronize the account activity again.
    }).catch(() => {});
    fetch(statsUrl, { headers: identityForStats.accountToken ? { "X-WW-Account-Token": identityForStats.accountToken } : {} })
        .then((r) => r.json())
        .then(renderStatsModal)
        .catch(() => {
            document.getElementById("statsModalBody").innerHTML =
                '<div class="stats-empty">โหลดสถิติไม่สำเร็จ ลองใหม่อีกครั้ง</div>';
        });
}

function formatAccountExpiry(iso){
    try {
        const d = new Date(iso);
        return d.toLocaleString("th-TH", { dateStyle:"medium", timeStyle:"short" });
    } catch (_) { return String(iso || ""); }
}
async function copyAccountId(){
    const id = window.wwAccount?.getIdentity?.().accountId || "";
    if (!id) return;
    try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(id);
        else {
            const area = document.createElement("textarea");
            area.value = id;
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            document.execCommand("copy");
            area.remove();
        }
        wwToast("คัดลอก Account ID แล้ว", {type:"success"});
    } catch (_) {
        wwAlert("คัดลอก Account ID ไม่สำเร็จ");
    }
}
function openRenameAccountPrompt(){
    if (!window.wwAccount) return;
    const nameEl = document.getElementById("statsModalName");
    const editBtn = document.getElementById("profileEditNameBtn");
    if (!nameEl || !editBtn || nameEl.dataset.editing === "1") return;

    const current = getSavedDisplayName();
    const input = document.createElement("input");
    input.type = "text";
    input.id = "accountRenameInput";
    input.className = "stats-modal-name-edit";
    input.maxLength = 24;
    input.autocomplete = "off";
    input.value = normalizeNameInput(current && current !== "ผู้เล่น" ? current : "");
    input.setAttribute("aria-label", "ชื่อบัญชีใหม่");
    bindNameInputRestrictions(input);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); submitRenameAccount(); }
        if (event.key === "Escape") { event.preventDefault(); closeRenameAccountEditor(); }
    });

    nameEl.dataset.editing = "1";
    nameEl.replaceWith(input);
    editBtn.textContent = "✓";
    editBtn.title = "บันทึกชื่อ";
    editBtn.setAttribute("aria-label", "บันทึกชื่อบัญชี");
    editBtn.onclick = submitRenameAccount;
    setTimeout(() => { input.focus(); input.select(); }, 30);
}

function closeRenameAccountEditor(){
    const input = document.getElementById("accountRenameInput");
    const editBtn = document.getElementById("profileEditNameBtn");
    if (!input || !editBtn) return;
    const nameEl = document.createElement("div");
    nameEl.className = "stats-modal-name";
    nameEl.id = "statsModalName";
    nameEl.textContent = getSavedDisplayName() || "ผู้เล่น";
    input.replaceWith(nameEl);
    editBtn.textContent = "✏️";
    editBtn.title = "เปลี่ยนชื่อ";
    editBtn.setAttribute("aria-label", "เปลี่ยนชื่อบัญชี");
    editBtn.onclick = openRenameAccountPrompt;
}

async function submitRenameAccount(){
    if (!window.wwAccount) return;
    const input = document.getElementById("accountRenameInput");
    const newName = normalizeNameInput(input?.value || "");
    if (input) input.value = newName;
    if (!newName || newName === "ผู้เล่น") {
        wwToast("กรุณาใช้ชื่อที่ถูกต้อง", {type:"error"});
        input?.focus();
        return;
    }
    if (isReservedTesterNameInput(newName)) {
        wwToast("ชื่อนี้สงวนไว้สำหรับ Player Tester", {type:"error"});
        input?.focus();
        return;
    }

    const editBtn = document.getElementById("profileEditNameBtn");
    if (editBtn) editBtn.disabled = true;
    indexSocket.emit("rename_my_account", window.wwAccount.payload({ newName }), (res) => {
        if (!res?.ok) {
            const messages = {
                NAME_IN_USE: "ชื่อนี้มีคนใช้แล้ว",
                NAME_RESERVED: "ชื่อนี้สงวนไว้สำหรับ Player Tester",
                BAD_NAME: "กรุณาใช้ชื่อที่ถูกต้อง",
                NAME_COOLDOWN: res?.error || "ยังเปลี่ยนชื่อไม่ได้ตอนนี้",
                ACCOUNT_SUSPENDED: "บัญชีถูกพักอยู่",
                ACCOUNT_DELETED: "บัญชีนี้ถูกลบแล้ว",
                ACCOUNT_EXPIRED: "บัญชีชั่วคราวหมดอายุแล้ว"
            };
            wwToast(messages[res?.code] || res?.error || "เปลี่ยนชื่อไม่สำเร็จ", {type:"error"});
            if (editBtn) editBtn.disabled = false;
            input?.focus();
            return;
        }
        syncLegacyNameStores(res.name);
        refreshNameUI();
        closeRenameAccountEditor();
        openStatsModal();
        wwToast("เปลี่ยนชื่อเรียบร้อย", {type:"success"});
    });
}

function closeStatsModal(){
    closeRenameAccountEditor();
    // Desktop dock is intentionally persistent; only the small-screen modal can be closed.
    if (document.body.classList.contains("profile-docked")) return;
    document.getElementById("statsModal").classList.add("hidden");
}

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const renameInput = document.getElementById("accountRenameInput");
    if (renameInput) {
        closeRenameAccountEditor();
        return;
    }
    if (!document.getElementById("statsModal")?.classList.contains("hidden")) {
        if (!document.body.classList.contains("profile-docked")) closeStatsModal();
    }
});

window.addEventListener("resize", syncIndexProfileLayout, { passive:true });

indexSocket.on("account_deleted", () => {
    try { window.wwAccount?.markAccountDeleted("account_deleted"); } catch (_) {}
    try { localStorage.removeItem(PLAYER_NAME_KEY); localStorage.removeItem(HOST_DISPLAY_NAME_KEY); } catch (_) {}
    hideAccountRecreateGate();
    indexSocket.disconnect();
    setTimeout(() => location.replace("index.html"), 50);
});

indexSocket.on("name_updated_by_host", (data) => {
    if (!data?.name) return;
    syncLegacyNameStores(data.name);
    refreshNameUI();
    sendIndexPresence();
});

function renderStatsModal(data){
    const body = document.getElementById("statsModalBody");
    if (!data) {
        body.innerHTML = '<div class="stats-empty">โหลดข้อมูลบัญชีไม่สำเร็จ</div>';
        return;
    }
    const identity = window.wwAccount?.getIdentity?.() || {};
    const account = data.account || {
        accountId: data.accountId || identity.accountId || "",
        displayName: data.name || identity.name || "ผู้เล่น",
        accountType: identity.accountType || "temporary",
        temporaryExpiresAt: identity.temporaryExpiresAt || "",
        googleLinked: identity.accountType === "google",
    };
    const expiresText = account?.temporaryExpiresAt ? formatAccountExpiry(account.temporaryExpiresAt) : "";
    const statusText = account?.status === "suspended" ? "พักบัญชี" : (account?.status === "deleted" ? "ลบบัญชี" : "ใช้งานอยู่");
    const accountTypeLabel = account?.accountType === "temporary" ? "บัญชีชั่วคราว" : (account?.accountType === "google" ? "บัญชี Google" : escapeHtml(account?.accountType || "-"));
    const displayName = account?.displayName || data.name || identity.name || "ผู้เล่น";
    const statusClass = account?.status === "suspended" ? "is-warning" : (account?.status === "deleted" ? "is-danger" : "is-active");

    document.getElementById("statsModalName").textContent = displayName;

    const googleSectionHtml = account?.googleLinked
        ? (identity.accountToken
            ? `
                <section class="account-google-section is-linked">
                    <div class="account-section-head">
                        <div>
                            <div class="account-section-title">Google</div>
                            <div class="account-section-sub">เชื่อมกับบัญชีเกมนี้แล้ว</div>
                        </div>
                        <span class="account-status-pill google"><span class="account-status-dot"></span>เชื่อมแล้ว</span>
                    </div>
                    <div class="account-action-slot"><button class="account-action account-action-secondary" type="button" onclick="logoutGoogleAccount(this)">🚪 ออกจากเซสชัน Google</button></div>
                    <div class="account-action-hint">Account ของเกมยังคงอยู่บนเซิร์ฟเวอร์ หลังออกจากเซสชัน</div>
                </section>`
            : `
                <section class="account-google-section">
                    <div class="account-section-head">
                        <div>
                            <div class="account-section-title">Google</div>
                            <div class="account-section-sub">บัญชีนี้เคยเชื่อม Google ไว้ แต่เซสชันหมดอายุ</div>
                        </div>
                        <span class="account-status-pill warning">ต้องเชื่อมต่อ</span>
                    </div>
                    <div class="account-action-slot"><button class="account-action account-action-primary" type="button" onclick="startGoogleAuthentication('login', this)">🔄 เชื่อมต่อ Google อีกครั้ง</button></div>
                    <div class="account-action-hint">จะกลับเข้าสู่ Game Account เดิม ไม่สร้าง Account ID ใหม่</div>
                </section>`)
        : `
            <section class="account-google-section">
                <div class="account-section-head">
                    <div>
                        <div class="account-section-title">Google</div>
                        <div class="account-section-sub">ยังไม่ได้เชื่อมกับบัญชีนี้</div>
                    </div>
                    <span class="account-status-pill neutral">ยังไม่เชื่อม</span>
                </div>
                <div class="account-action-slot"><button class="account-action account-action-primary" type="button" onclick="startGoogleAuthentication('link', this)">🔗 เชื่อม Google กับบัญชีนี้</button></div>
                <div class="account-action-hint"><b>เชื่อม:</b> รักษา Account ID ชื่อ และสถิติของบัญชีนี้ไว้</div>
                <div class="account-action-slot account-switch-slot"><button class="account-switch-link" type="button" onclick="startGoogleAuthentication('login', this)">ใช้บัญชี Google เพื่อเปลี่ยนบัญชีเกม</button></div>
                <div class="account-switch-hint">การเปลี่ยนบัญชีจะเปิด Game Account ที่ผูกกับ Google นี้ หรือสร้างใหม่ถ้ายังไม่เคยมี</div>
            </section>`;

    const accountCardHtml = `
        <div class="account-profile-card">
            <div class="account-profile-summary">
                <span class="account-status-pill ${statusClass}">${escapeHtml(accountTypeLabel)}</span>
                <span class="account-status-pill ${statusClass}">${escapeHtml(statusText)}</span>
            </div>
            <div class="account-profile-row account-profile-row-id">
                <span>Account ID</span>
                <div class="account-id-value">
                    <code title="${escapeHtml(account?.accountId || "-")}">${escapeHtml(account?.accountId || "-")}</code>
                    <button class="account-copy-btn" type="button" onclick="copyAccountId()">คัดลอก</button>
                </div>
            </div>
            ${expiresText ? `<div class="account-profile-row"><span>บัญชีชั่วคราวหมดอายุ</span><b>${escapeHtml(expiresText)}</b></div>` : ""}
        </div>
        ${googleSectionHtml}`;
    if (!data.games) {
        body.innerHTML = accountCardHtml + '<div class="stats-empty">ยังไม่มีประวัติการเล่น — เล่นจบเกมแรกก่อนนะ</div>';
        return;
    }

    // จัดกลุ่มรายอาชีพ (data.roles) ตามทีม (data.roles[i].team / teamLabel ที่ server คำนวณมาให้แล้ว)
    const teamGroups = {}; // team key -> { label, games, wins, losses, leaves, roles: [] }
    for (const r of data.roles) {
        const key = r.team || "อื่นๆ";
        if (!teamGroups[key]) teamGroups[key] = { label: r.teamLabel || "อื่นๆ", games: 0, wins: 0, losses: 0, leaves: 0, roles: [] };
        teamGroups[key].games += r.games;
        teamGroups[key].wins += r.wins;
        teamGroups[key].losses += r.losses;
        teamGroups[key].leaves += r.leaves;
        teamGroups[key].roles.push(r);
    }
    const teams = Object.values(teamGroups).sort((a, b) => b.games - a.games);

    const teamsHtml = teams.map((t) => {
        const rate = t.games ? Math.round((t.wins / t.games) * 1000) / 10 : 0;
        const rolesHtml = t.roles.map((r) => `
            <div class="stats-role-row">
                <span class="stats-role-name">${escapeHtml(r.role)}</span>
                <span class="stats-role-detail">${r.wins}ชนะ/${r.losses}แพ้/${r.leaves}ออก · ${r.winRate}%</span>
            </div>
        `).join("");
        return `
            <details class="stats-team">
                <summary>
                    <span>${escapeHtml(t.label)}</span>
                    <span class="stats-team-rate">${rate}%</span>
                </summary>
                <div class="stats-roles">${rolesHtml}</div>
            </details>
        `;
    }).join("");

    body.innerHTML = `
        ${accountCardHtml}
        <div class="stats-games-count">เล่นทั้งหมด <b>${data.games}</b> เกม</div>
        <div class="stats-overall">
            <div class="stats-overall-cell win">
                <span class="num">${data.winRate}%</span>
                <span class="lbl">ชนะ (${data.wins})</span>
            </div>
            <div class="stats-overall-cell lose">
                <span class="num">${data.lossRate}%</span>
                <span class="lbl">แพ้ (${data.losses})</span>
            </div>
            <div class="stats-overall-cell leave">
                <span class="num">${data.leaveRate}%</span>
                <span class="lbl">ออก (${data.leaves})</span>
            </div>
        </div>
        <div class="stats-section-label">แยกตามทีม (กดเพื่อดูรายอาชีพ)</div>
        <div class="stats-teams">${teamsHtml}</div>
    `;
}

function player(){
    if (!ensureDisplayName()) return;
    const name = encodeURIComponent(getSavedDisplayName());
    const go = () => { window.location.href = "player.html?name=" + name; };
    // เช็ครุ่นสดๆ อีกทีตรงจังหวะกดปุ่มก่อนพาไปหน้าเกมจริง — ดู wwGateBeforeNav ใน index.auto-update.js
    if (window.wwGateBeforeNav) wwGateBeforeNav(go); else go();
}

// ===== เข้าโหมดโฮสต์ =====
// เดิมมีรหัสผ่านกันคนเปิดมาเจอเฉยๆกดสร้างห้องมั่ว ตอนนี้ตัดออกแล้ว กดแล้วเข้าห้องได้เลย
function openHostModal(){
    if (!ensureDisplayName()) return;
    const go = () => { window.location.href = "host.html?name=" + encodeURIComponent(getSavedDisplayName()); };
    // เช็ครุ่นสดๆ อีกทีตรงจังหวะกดปุ่มก่อนพาไปหน้าเกมจริง — ดู wwGateBeforeNav ใน index.auto-update.js
    if (window.wwGateBeforeNav) wwGateBeforeNav(go); else go();
}

document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
