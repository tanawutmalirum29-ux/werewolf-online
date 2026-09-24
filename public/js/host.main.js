// auth: แนบตัวตนห้องผู้ทดสอบเดิม (ถ้ามี) ให้ server เช็คตอน handshake — ดู wwServerControl.roomIdentityAuth
// ใน shared.server-control.js (แก้บั๊ก: จอโฮสต์ที่ไม่ได้ถือบัตร tp คุมห้องผู้ทดสอบอยู่ ถ้า socket หลุดตอนเซิร์ฟเวอร์
// หลักปิดอยู่ ต่อกลับไม่ได้เลย ทั้งที่ห้องผู้ทดสอบควรเล่นต่อได้ปกติ)
const hostSocketAuth = Object.assign(
    {},
    (window.wwServerControl && window.wwServerControl.roomIdentityAuth()) || {},
    (() => {
        // Tester Host tabs can also lose the ww_tp cookie across a cached/navigated
        // window.open() boundary. Pass the signed launch credential in the handshake
        // so the server can authenticate tester mode deterministically.
        try {
            const tp = new URLSearchParams(window.location.search).get("tp");
            return tp ? { testerPass: tp } : {};
        } catch (_) {
            return {};
        }
    })()
);
const socket = io({ auth: hostSocketAuth });

socket.on("serverInfo", function (info) {
    if (window.wwSetServerVersion) window.wwSetServerVersion(info && info.version);
    if (window.wwCheckClientVersion) window.wwCheckClientVersion(info && info.clientHash);
});
// แอดมินกดล้างข้อมูลเกมทั้งหมด (ดู shared.reset-guard.js) — ล้างตัวตนในเครื่องนี้แล้วกลับหน้าแรกทันที
socket.on("force_reset", function (d) {
    if (window.wwApplyResetEpoch) window.wwApplyResetEpoch(d && d.epoch);
});
// แอดมินกดปุ่มในแท็บ "จัดการระบบ" (ดู shared.server-control.js): บังคับรีโหลด / ปิดเซิร์ฟเวอร์ (จอเต็ม "เซิร์ฟเวอร์กำลังปิด")
socket.on("force_reload", function (d) {
    hostBrowserExitServerClosed = true;
    hostBrowserExitGuardState(false, "force_reload");
    if (window.wwServerControl) window.wwServerControl.onForceReload(d);
});
socket.on("server_closed", function (d) {
    hostBrowserExitServerClosed = true;
    hostBrowserExitGuardState(false, "server_closed");
    if (window.wwServerControl) window.wwServerControl.onServerClosed(d);
});
// แอดมินตั้ง "ปิดแบบนับถอยหลัง" (แถบเตือนด้านบน) / ยกเลิกการปิด
socket.on("server_closing", function (d) {
    if (window.wwServerControl && window.wwServerControl.onServerClosing) window.wwServerControl.onServerClosing(d);
});
socket.on("server_closing_cancelled", function () {
    if (window.wwServerControl && window.wwServerControl.onServerClosingCancelled) window.wwServerControl.onServerClosingCancelled();
});
socket.on("connect_error", function (err) {
    if (window.wwServerControl) window.wwServerControl.onConnectError(err);
});

// บัญชีจริงถูกจัดการจากหน้า Admin ทั้งหมด: เมื่อถูกเตะ/พัก/ลบ ให้ปิด session นี้ทันที
// Tester จะไม่ถูก event ชุดนี้เพราะ server ไม่ผูก tester เข้ากับ accountId ถาวร
function handleManagedAccountSession(reason) {
    hostAllowIntentionalExit("managed_account_session");
    hostBrowserExitServerClosed = true;
    hostBrowserExitGuardState(false, "managed_account_session");
    if (reason === "account_deleted") {
        try { window.wwAccount?.markAccountDeleted("account_deleted"); } catch (_) {}
        try {
            localStorage.removeItem("ww_playerName");
            localStorage.removeItem("ww_host_display_name");
        } catch (_) {}
    }
    try {
        hostStorage.removeItem("ww_host_room");
        hostStorage.removeItem("ww_host_token");
        hostStorage.removeItem("ww_bot_tokens");
    } catch (_) {}
    roomId = "";
    try { socket.disconnect(); } catch (_) {}
    const text = reason === "account_deleted"
        ? "บัญชีนี้ถูกลบโดยผู้ดูแลระบบ"
        : (reason === "account_suspended" ? "บัญชีนี้ถูกระงับโดยผู้ดูแลระบบ" : "บัญชีนี้ถูกนำออกจากระบบโดยผู้ดูแลระบบ");
    const toast = document.createElement("div");
    toast.textContent = text;
    Object.assign(toast.style, { position:"fixed", inset:"0", zIndex:"99999", display:"grid", placeItems:"center", padding:"24px", background:"rgba(5,7,12,.94)", color:"#fff", textAlign:"center", fontSize:"18px", fontWeight:"700" });
    document.body.appendChild(toast);
    setTimeout(() => { location.replace("index.html"); }, 700);
}
socket.on("account_deleted", () => handleManagedAccountSession("account_deleted"));
socket.on("account_suspended", () => handleManagedAccountSession("account_suspended"));
socket.on("account_kicked", () => handleManagedAccountSession("account_kicked"));
// กันหน้า HTML เก่าที่แคชค้าง (ยังไม่มี <script shared.server-control.js>) จับคู่กับ JS ใหม่ตัวนี้ — ถ้าไม่มี wwImg ให้ใช้แบบเดิมไปก่อน
if (typeof window.wwImg !== "function") {
    // Compatibility for stale HTML must still be S3/CDN-only; never fall back to /images on the game origin.
    window.wwImg = function (p) {
        var base = typeof window.WW_IMG_BASE === "string" ? window.WW_IMG_BASE : "";
        return base ? base + p : "";
    };
}

let roomId = "";
let currentRoom = null;

// เฟส 1 Runtime Audit: ให้ตัวตรวจกลางอ่าน room state จริงของหน้า Host
if (window.WWRuntimeAudit?.setStateProvider) {
    window.WWRuntimeAudit.setStateProvider(() => currentRoom || null);
}

// ===== กันเลื่อนจอฉากหลังระหว่างเปิดป๊อปอัป (roomPicker/modePopup/tester/gameOver) =====
// เดิมพึ่ง html.modal-open{overflow:hidden} อย่างเดียว ซึ่งกัน scroll ของฉากหลังไม่ได้จริงบน
// มือถือ/iOS Safari (overflow:hidden ที่ html/body ไม่ครอบคลุม touch scroll ที่เกิดจาก touchmove
// โดยตรงบนตัวหน้าเว็บ) ทำให้กริดผู้เล่น/การ์ดด้านหลังยังเลื่อนตามนิ้วได้ทะลุป๊อปอัปที่เปิดอยู่ —
// เพิ่ม touchmove listener ระดับ document ที่ preventDefault เสมอเมื่อ modal-open เปิดอยู่ ยกเว้น
// จุดสัมผัสอยู่ในส่วนที่ตั้งใจให้เลื่อนได้ของป๊อปอัปเอง (.vote-modal-scroll ถ้ามี ไม่งั้น fallback
// เป็น .vote-modal ทั้งกล่อง) เพื่อให้ยังเลื่อนดูเนื้อหายาวๆ ในป๊อปอัปได้ตามปกติ
document.addEventListener("touchmove", (e) => {
    if (!document.documentElement.classList.contains("modal-open")) return;
    const scrollable = e.target.closest(".vote-modal-scroll, .vote-modal");
    if (!scrollable) e.preventDefault();
}, { passive: false });

// ===== จำตัวตนโฮสต์ไว้ในเครื่อง =====
// ปกติ: ใช้ localStorage — token เดียวกันทุกแท็บบนเครื่อง ทำให้กลับเข้าห้องเดิมได้ตอนเน็ตหลุด
// tester mode (?tester=1): ใช้ sessionStorage — token แยกต่อแท็บ แต่ละแท็บเป็นคนละโฮสต์
// และใช้ห้องที่แยกต่างหากด้วย (ww_host_room ก็เก็บใน sessionStorage เช่นกัน)
const testerQuery = new URLSearchParams(location.search);
const isTesterMode = testerQuery.get("tester") === "1";
const TESTER_RETURN_URL = "admin.html";
const hostStorage = isTesterMode ? sessionStorage : localStorage;

// ===== จำธีมห้องล่าสุดข้ามการรีโหลด =====
// ห้องที่ยังไม่เริ่มเกมต้องเปิดมาด้วยชายหาดตอนเช้าเสมอ แต่ห้องที่กำลังเล่นตอนกลางคืน
// ต้องไม่ย้อนกลับไปเป็นกลางวันตอนรีโหลดก่อน room_update รอบแรกจะมาถึง — เก็บเฟสล่าสุด
// แยกตาม roomId และแยก storage ตามโหมด tester แบบเดียวกับตัวตนโฮสต์
const HOST_ROOM_THEME_KEY_PREFIX = "ww_host_room_theme_";
function hostRoomThemeKey(id) {
    return HOST_ROOM_THEME_KEY_PREFIX + String(id || "").trim().toUpperCase();
}
function readSavedHostRoomTheme(id) {
    if (!id) return "";
    try {
        const value = hostStorage.getItem(hostRoomThemeKey(id));
        return value === "night" || value === "day" ? value : "";
    } catch (_) {
        return "";
    }
}
function writeSavedHostRoomTheme(id, theme) {
    if (!id) return;
    try {
        if (theme === "night" || theme === "day") hostStorage.setItem(hostRoomThemeKey(id), theme);
        else hostStorage.removeItem(hostRoomThemeKey(id));
    } catch (_) {}
}
function applySavedHostRoomTheme(id) {
    const theme = readSavedHostRoomTheme(id);
    // ค่าเริ่มต้นของจอโฮสต์ตอนเข้า/สร้างห้อง = กลางวัน; ถ้าเรารู้ว่าห้องนี้เป็นคืนล่าสุดจริง
    // ค่อยคืนกลางคืนทันที เพื่อลด flash ผิดธีมตอน browser reload
    const night = theme === "night";
    document.body.classList.toggle("is-night", night);
    document.body.classList.toggle("is-day", !night);
}
function syncHostTimeTheme(roomData) {
    const room = roomData || {};
    // ธีมกลางคืนต้องได้รับการยืนยันจาก server เท่านั้น: เกมต้องเริ่มแล้ว, ยังไม่ game over,
    // และ isNight=true; ทุกสถานะอื่นให้เป็นกลางวัน เพื่อกัน dark default ทุก race ตอนโหลด/รีเฟรช.
    const activeNight = !!room.started && !room.gameOver && !!room.isNight;
    document.body.classList.toggle("is-night", activeNight);
    document.body.classList.toggle("is-day", !activeNight);
    return activeNight;
}
function persistHostRoomTheme(room) {
    const id = String(room?.roomId || room?.id || roomId || "").trim().toUpperCase();
    if (!id) return;
    if (room?.gameOver) {
        writeSavedHostRoomTheme(id, "");
        return;
    }
    // ก่อนเริ่มเกมและช่วงกลางวัน = day; กลางคืนจะถูกบันทึกเฉพาะเมื่อ server ยืนยัน isNight=true
    writeSavedHostRoomTheme(id, room?.started && room?.isNight ? "night" : "day");
}
const initialHostRoomId = hostStorage.getItem("ww_host_room")
    || (isTesterMode ? new URLSearchParams(location.search).get("r") : "");
applySavedHostRoomTheme(initialHostRoomId);
// ตัวระบุ "แท็บ Host ผู้คุมบอท" แยกจาก ts ของ Admin launch — บอทแต่ละแท็บจะส่งกลับหาผู้คุม
// โดยตรงได้ แม้ opener chain ของ iPad/Chrome จะหายหรือชี้ผิดแท็บ
const TESTER_HOST_CONTROLLER_KEY = "ww_tester_host_controller_id";
function makeTesterControllerId() {
    try {
        if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (e) {}
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}
let testerHostControllerId = "";
if (isTesterMode) {
    try {
        testerHostControllerId = sessionStorage.getItem(TESTER_HOST_CONTROLLER_KEY) || "";
        if (!testerHostControllerId) {
            testerHostControllerId = makeTesterControllerId();
            sessionStorage.setItem(TESTER_HOST_CONTROLLER_KEY, testerHostControllerId);
        }
    } catch (e) {
        testerHostControllerId = "host-" + makeTesterControllerId();
    }
}
let hostAccountReady = Promise.resolve(null);
let hostBootstrapPromise = null;
function bootstrapHostAccount(){
    if (isTesterMode || !window.wwAccount || !socket.connected) return Promise.resolve(null);
    if (hostBootstrapPromise) return hostBootstrapPromise;
    hostBootstrapPromise = window.wwAccount.bootstrap(socket, { name: window.wwAccount.getName() || hostStorage.getItem("ww_host_display_name") || "", page:"host" })
        .then((data) => {
            const identity = window.wwAccount.getIdentity();
            if (!data?.accountId || !identity.accountId || !identity.accountToken) {
                throw Object.assign(new Error("บัญชีโฮสต์ยังไม่ได้รับ Account ID"), { code:"ACCOUNT_ID_MISSING" });
            }
            if (data?.name) {
                hostStorage.setItem("ww_host_display_name", data.name);
                localStorage.setItem("ww_playerName", data.name);
            }
            hostName = getPersistedHostName();
            sendHostPresence();
            return data;
        })
        .catch((e) => {
            console.error("[account] host bootstrap failed", e);
            if (e?.code === "ACCOUNT_RECREATE_REQUIRED" || e?.code === "ACCOUNT_DELETED_REQUIRES_RECREATE" || e?.code === "ACCOUNT_NOT_FOUND_REQUIRES_RECREATE") {
                location.replace("index.html");
            }
            throw e;
        })
        .finally(() => { hostBootstrapPromise = null; });
    hostAccountReady = hostBootstrapPromise;
    return hostAccountReady;
}

function returnFromHostScreen() {
    hostBrowserExitServerClosed = true;
    hostBrowserExitGuardState(false, "return_from_host_screen");
    // tester host ต้องกลับแท็บ admin เดิมแล้วปิดแท็บนี้ ไม่สร้าง admin.html ซ้ำในแท็บทดสอบ
    if (isTesterMode) {
        if (window.wwServerControl && typeof window.wwServerControl.returnTesterToAdmin === "function") {
            window.wwServerControl.returnTesterToAdmin();
        } else {
            window.location.replace(TESTER_RETURN_URL);
        }
        return;
    }
    window.location.replace("index.html");
}


// ===== ชื่อที่ตั้งมาจากหน้าแรก (index.html) =====
// index.html เป็นจุดเดียวที่ให้ตั้ง/แก้ "ชื่อของคุณ" แล้วส่งมาทาง ?name=... ตอนกดเข้าโหมดโฮสต์
// โหมดปกติ: hostStorage คือ localStorage เดียวกับที่ index.html เขียนไว้อยู่แล้ว (ww_host_display_name)
// เลยไม่จำเป็นต้องอ่านจาก URL ซ้ำ — แต่โหมดผู้ทดสอบ (tester) hostStorage สลับเป็น sessionStorage
// ของแท็บนี้ล้วนๆ (ว่างเปล่าทุกครั้งที่เปิดแท็บใหม่) จึงต้องรับชื่อผ่าน ?name= มาเซ็ตใส่ sessionStorage
// ของแท็บนี้เองตรงนี้ก่อน ให้ getPersistedHostName() ด้านล่างอ่านเจอ
{
    const urlDisplayName = new URLSearchParams(location.search).get("name");
    if (isTesterMode && urlDisplayName && urlDisplayName.trim()) {
        hostStorage.setItem("ww_host_display_name", urlDisplayName.trim().slice(0, 24));
    }
}

// ปุ่ม "ปรับเงื่อนไขจบเกม" (โหมดผู้ทดสอบ) ให้โชว์เฉพาะตอนเข้ามาผ่านโหมดผู้ทดสอบจริง ๆ
// (?tester=1) เท่านั้น ห้องปกติของโฮสต์ทั่วไปไม่ควรเห็นปุ่มนี้เลย
if (isTesterMode) {
    document.getElementById("testerModeBtn")?.classList.remove("hidden");
    document.getElementById("botManagerBtn")?.classList.remove("hidden");
}

function getHostToken() {
    let t = hostStorage.getItem("ww_host_token");
    if (!t && isTesterMode) t = new URLSearchParams(location.search).get("ht");
    if (!t) {
        t = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));
    }
    hostStorage.setItem("ww_host_token", t);
    if (isTesterMode) {
        const u = new URL(window.location.href);
        u.searchParams.set("tester", "1");
        u.searchParams.set("ht", t);
        history.replaceState(null, "", u.toString());
    }
    return t;
}
const hostToken = getHostToken();

// ===== BROWSER TAB CLOSE GUARD =====
// ครอบคลุมการปิดแท็บ/รีเฟรช/navigation ตอนกำลังคุมห้อง. browser จะแสดง dialog ของตัวเอง
// หลังมี user interaction; pagehide ที่ตามหลังการกดยืนยันจะส่ง beacon ให้ server ปิดห้อง
// โดยมี grace สั้น ๆ กัน reload/reconnect และรองรับหลายจอโฮสต์พร้อมกัน.
let hostBrowserExitGuardActive = false;
let hostBrowserExitRequested = false;
let hostBrowserExitSignalSent = false;
let hostBrowserExitServerClosed = false;

function hostBrowserExitGuardState(active, reason) {
    hostBrowserExitGuardActive = !!active;
    if (!active) {
        hostBrowserExitSignalSent = false;
        hostBrowserExitRequested = false;
    }
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.guard", { page:"host", active:!!active, reason:String(reason || "") });
    }
}

function hostAllowIntentionalExit(reason) {
    hostBrowserExitRequested = true;
    hostBrowserExitServerClosed = false;
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.intentional", { page:"host", reason:String(reason || "") });
    }
}

function handleHostBeforeUnload(event) {
    if (!hostBrowserExitGuardActive || hostBrowserExitServerClosed || !roomId || hostBrowserExitRequested) return;
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.beforeunload", { page:"host", roomId:String(roomId), userActivation:!!navigator.userActivation?.hasBeenActive });
    }
    event.preventDefault();
    event.returnValue = "";
}

window.addEventListener("beforeunload", handleHostBeforeUnload);
window.addEventListener("pagehide", (event) => {
    if (!hostBrowserExitGuardActive || hostBrowserExitServerClosed || !roomId || event.persisted || hostBrowserExitSignalSent) return;
    // If Socket.IO already closed, the disconnect path has already taken ownership of this lifecycle event.
    if (!socket || !socket.connected) return;
    hostBrowserExitSignalSent = true;
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.pagehide", { page:"host", roomId:String(roomId), persisted:!!event.persisted, socketId:socket.id || "" });
    }
    const diagState = window.WWDiagnostic?.getState?.() || {};
    wwSendBrowserExitBeacon("/api/room/browser-exit-host", {
        roomId:String(roomId), token:String(hostToken || ""), socketId:String(socket.id || ""), source:"pagehide",
        clientTraceId:String(diagState.activeTrace?.id || ""), clientSessionId:String(window.WWDiagnostic?.sessionId || ""),
        pendingOperations:Array.isArray(diagState.pendingOperations) ? diagState.pendingOperations.slice(0, 12) : [],
        viewport:{ width:Number(window.innerWidth || 0), height:Number(window.innerHeight || 0), dpr:Number(window.devicePixelRatio || 1) }
    });
});

function sendHostPresence(){
    if (isTesterMode || !socket.connected) return;
    const name = getPersistedHostName();
    if (!name) return;
    if (!window.wwAccount) return;
    socket.emit("presence_hello", window.wwAccount.payload({ token:"", name, page:"host", visible:document.visibilityState === "visible", roomId:roomId || "", isHost:true }));
}
document.addEventListener("visibilitychange", sendHostPresence);
setInterval(sendHostPresence, 20000);

// ===== บอท (โหมดผู้ทดสอบ) =====
// เก็บ token ของบอทแต่ละตัวไว้ในเครื่องโฮสต์เอง (แยกตามห้อง) — server ไม่ broadcast token
// เป็นการทั่วไป (เห็นได้จาก ack ตอนเพิ่มบอทเท่านั้น) จึงต้องจำไว้ฝั่งนี้เพื่อใช้ "เข้าสิง" ซ้ำได้
// แม้โหลดหน้าโฮสต์ใหม่ ตราบใดที่ยังเป็นแท็บ/เครื่องเดิม (ใช้ storage เดียวกับ hostToken)
function loadBotTokens() {
    try {
        return JSON.parse(hostStorage.getItem("ww_bot_tokens") || "{}");
    } catch (e) {
        return {};
    }
}
function saveBotTokens() {
    hostStorage.setItem("ww_bot_tokens", JSON.stringify(botTokens));
}
const botTokens = loadBotTokens(); // { [roomId]: { [botId]: token } }

function addBot() {
    if (!roomId) return;
    socket.emit("host_add_bot", roomId, (res) => {
        if (!res || res.error) {
            wwAlert(res && res.error === "started"
                ? "เกมเริ่มไปแล้ว เพิ่มบอทระหว่างเกมไม่ได้ (บอทจะไม่ได้รับบทบาท) — เพิ่มได้เฉพาะก่อนกดเริ่มเกมเท่านั้น"
                : "เพิ่มบอทไม่สำเร็จ");
            return;
        }
        botTokens[roomId] = botTokens[roomId] || {};
        botTokens[roomId][res.id] = res.token;
        saveBotTokens();
    });
}

// เพิ่มบอทให้ครบเท่าจำนวน "อาชีพทั้งหมดที่มีอยู่ในเกม" — นับจากทุกอาชีพที่ระบบรองรับจริง (ที่ได้จาก
// roles_data ซึ่งเซิร์ฟเวอร์ส่งมาให้ครบทุกอาชีพในระบบเสมอ ไม่ใช่แค่อาชีพที่โฮสต์เลือกไว้สำหรับตานี้)
// นับจำนวนผู้เล่นที่ไม่ใช่โฮสต์ตอนนี้ (คนจริง + บอทที่มีอยู่แล้ว) แล้วเพิ่มบอททีละตัวจนครบผลต่าง
// เพิ่มทีละตัวแบบรอ ack ก่อนค่อยเพิ่มตัวถัดไป กันแข่งกันเขียน room.players พร้อมกันหลายคำขอ
//
// พร้อมติ๊กอาชีพในเกมให้ครบทุกอาชีพ อย่างละ 1 ใบไปด้วยในตัว (เขียนทับ roleConfig เดิมทั้งหมดที่เคย
// ตั้งไว้) ให้ตรงกับจำนวนบอทที่จะเพิ่มพอดี — กันไม่ให้โฮสต์ต้องมาติ๊กอาชีพทีละอันเองซ้ำหลังกดปุ่มนี้
// (เดิมปุ่มนี้เพิ่มแค่จำนวนบอทอย่างเดียว ไม่แตะรายการอาชีพที่เลือกไว้เลย)
function addBotsToFillAllRoles() {
    if (!roomId) return;
    const roleNames = Object.keys(roles || {}).filter((k) => !k.startsWith("__") && !(roles.__nonSelectableRoles || []).includes(k));
    const totalRoles = roleNames.length;
    if (!totalRoles) {
        wwAlert("ยังโหลดข้อมูลอาชีพไม่เสร็จ ลองใหม่อีกครั้ง");
        return;
    }

    // ติ๊กอาชีพทั้งหมดในเกม อย่างละ 1 ใบ — ล้าง roleConfig เดิมก่อน (เคลียร์อาชีพที่เคยติ๊ก/จำนวนที่เคย
    // ปรับด้วยปุ่ม +/- ไว้ทั้งหมด) แล้วตั้งใหม่ทุกอาชีพ = 1 ให้ครบเท่ากับ totalRoles พอดี
    Object.keys(roleConfig).forEach((role) => { delete roleConfig[role]; });
    roleNames.forEach((role) => { roleConfig[role] = 1; });
    renderRoles();
    updateConfig();

    const currentCount = (currentRoom?.players || []).filter((p) => !p.isHost).length;
    let remaining = totalRoles - currentCount;
    if (remaining <= 0) {
        wwAlert(`มีผู้เล่น/บอทครบ ${totalRoles} คนแล้ว (เท่าจำนวนอาชีพทั้งหมดในเกม)`);
        return;
    }
    function addOne() {
        if (remaining <= 0) return;
        remaining -= 1;
        socket.emit("host_add_bot", roomId, (res) => {
            if (!res || res.error) {
                wwAlert(res && res.error === "started"
                    ? "เกมเริ่มไปแล้ว เพิ่มบอทระหว่างเกมไม่ได้ (บอทจะไม่ได้รับบทบาท) — เพิ่มได้เฉพาะก่อนกดเริ่มเกมเท่านั้น"
                    : "เพิ่มบอทไม่สำเร็จ");
                remaining = 0; // หยุดเพิ่มต่อถ้าเจอ error กลางทาง
                return;
            }
            botTokens[roomId] = botTokens[roomId] || {};
            botTokens[roomId][res.id] = res.token;
            saveBotTokens();
            addOne();
        });
    }
    addOne();
}

// เปิดหน้าจอผู้เล่นของบอทตัวนี้เป็น "ป๊อปอัปหน้าต่างจริง" (ไม่ใช่ iframe) เพื่อให้แต่ละบอท
// มี session storage แยกกันจริง ๆ (เข้าสิงหลายตัวพร้อมกันได้โดยไม่ทับ token กัน) —
// พอเปิดแล้ว player.html จะจำ token นี้เป็นตัวเอง แล้ว auto-join เข้าห้องให้ทันทีเหมือนผู้เล่นจริง
//
// แก้บั๊ก: เดิมดึง token จาก botTokens (แคชใน localStorage คีย์ด้วย "id ตอนเพิ่มบอท") แต่พอเข้าสิง
// ครั้งแรกสำเร็จ บอทจะกลายเป็นผู้เล่นจริงที่ reconnect ผ่าน join_room → เซิร์ฟเวอร์เปลี่ยน player.id
// เป็น socket.id ของแท็บที่เพิ่งเข้าสิง (เหมือนผู้เล่นคนอื่นทุกคนตอน reconnect) ทำให้ id ที่ปุ่ม
// "เข้าสิง" อ้างอิงอยู่ (ของรอบถัดไป) ไม่ตรงกับคีย์เดิมใน botTokens อีกต่อไป → หา token ไม่เจอ
// ("ไม่พบ token... อาจเพิ่มจากจอ/เครื่องอื่น") ทั้งที่จริงๆ เป็นบอทตัวเดิม แค่ id เปลี่ยนไปแล้ว
//
// วิธีแก้: currentRoom.players (จาก room_update ล่าสุด) มี field .token ของทุกคนอยู่แล้วจริงๆ
// (ดูตัวอย่างการใช้ p.token ตอนเช็คผู้ชนะด้านล่าง) จึงดึง token สดจากตรงนั้นแทนเสมอ ไม่ต้องพึ่ง
// แคชที่อาจไม่ตรงกันอีกต่อไป — เข้าสิงซ้ำได้ตลอดไม่ว่า id จะเปลี่ยนไปกี่รอบก็ตาม
// เก็บ reference ของป๊อปอัปที่เปิดไว้แล้วต่อ token — ใช้เช็คว่า "ยังเปิดค้างอยู่จริง" ก่อนตัดสินใจ
// ว่าจะแค่โฟกัสไปแท็บเดิม หรือต้องเปิดใหม่ (ดูเหตุผลละเอียดในคอมเมนต์ใน possessBot ด้านล่าง)
const openBotWindows = {}; // { [token]: WindowProxy }

function makeBotTesterLaunchId() {
    try {
        if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (e) {}
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}

function possessBot(botId) {
    const bot = (currentRoom?.players || []).find((p) => p.id === botId);
    let token = bot?.token;

    // fallback: เผื่อกรณีหายากที่ currentRoom ยังไม่ทันอัปเดต (เช่นเพิ่งกดเพิ่มบอทแล้วรีบกดสิงทันที)
    if (!token) token = (botTokens[roomId] || {})[botId];

    if (!token) {
        wwAlert("ไม่พบ token ของบอทตัวนี้ ลองรอสักครู่แล้วลองใหม่ หรือเพิ่มบอทใหม่อีกตัวแทน");
        return;
    }

    // แก้บั๊ก (รอบนี้): เดิมกด "เข้าสิง" ที่บอทตัวเดิมซ้ำ ๆ จะเรียก window.open(url, "ww_bot_"+token)
    // ซ้ำทุกครั้ง — ชื่อหน้าต่างซ้ำกันจริง เลยไม่เปิดแท็บ/ป๊อปอัปใหม่ซ้อนขึ้นมาก็จริง แต่ window.open
    // ที่มี URL แนบมาด้วย ตาม spec แล้ว "นำทาง" (navigate) หน้าต่างเป้าหมายไปที่ URL นั้นเสมอ ต่อให้
    // เป็น URL เดิมเป๊ะก็ตาม ผลคือแท็บของบอทที่เปิดค้างอยู่ (กำลังต่อ socket เล่นอยู่) โดน reload
    // ทั้งหน้าทุกครั้งที่กดซ้ำ ไม่ใช่แค่ "ไม่โฟกัสให้" อย่างที่คอมเมนต์เดิมเข้าใจ — ระหว่างหน้ากำลัง
    // reload นั้น .focus() ที่ตามมาไปเรียกกับ reference ที่กำลังเปลี่ยน context อยู่พอดี บางเบราว์เซอร์
    // (โดยเฉพาะ Chrome) เลยไม่ยอมสลับแท็บให้เลย รู้สึกเหมือนกดแล้ว "แค่รีแท็บ" ตามที่สังเกตเจอจริง ๆ
    //
    // แก้โดยเช็คก่อนว่ามี reference ของหน้าต่างบอทตัวนี้เปิดค้างอยู่ไหม (openBotWindows) ถ้ายังเปิด
    // อยู่จริง (!win.closed) จะ "ไม่" เรียก window.open() ซ้ำเลย — เลี่ยงการ navigate/reload ทิ้งไป
    // แค่เรียก .focus() ตรง ๆ บน reference เดิมเท่านั้น ไม่ไปรบกวนคอนเนกชัน socket ที่ต่ออยู่แล้ว
    const existing = openBotWindows[token];
    if (existing && !existing.closed) {
        existing.focus();
        // หมายเหตุ (ข้อจำกัดจริงของเบราว์เซอร์ ไม่ใช่บั๊กที่แก้จากโค้ดได้ 100%): เบราว์เซอร์สมัยใหม่
        // (โดยเฉพาะ Chrome) มีนโยบายกัน "แย่งโฟกัสข้ามแท็บ" เพื่อกันเว็บดึงความสนใจผู้ใช้มั่ว ๆ — ถ้า
        // ป๊อปอัปถูกเปิดเป็น "แท็บ" แทนที่จะเป็นหน้าต่างแยกจริง (ขึ้นกับตั้งค่าเบราว์เซอร์/OS) การเรียก
        // .focus() จากสคริปต์อาจถูกเบราว์เซอร์เมินเฉยได้ แม้โค้ดจะถูกต้องแล้วก็ตาม กรณีนี้ผู้ใช้ต้อง
        // สลับแท็บเอง — ไม่มีทาง force จาก JS ได้ 100% ในทุกเบราว์เซอร์/ทุกการตั้งค่า
        return;
    }

    const url = new URL(location.origin + "/player.html");
    url.searchParams.set("tester", "1");
    url.searchParams.set("t", token);
    url.searchParams.set("jr", roomId);
    // สำคัญ: ส่งบัตรผ่าน tester ของ Host ต่อไปด้วย เพราะแท็บบอทคือ tester คนละ launch
    // และ middleware ฝั่ง server ใช้ cookie ww_tp เป็นหลักฐานสิทธิ์ก่อนรับ socket/event ตอนเซิร์ฟเวอร์ปิด
    // ไม่ควรพึ่ง cookie ที่ clone/ค้างจากแท็บต้นทางเพียงอย่างเดียว
    const testerPass = testerQuery.get("tp");
    if (testerPass) url.searchParams.set("tp", testerPass);
    // ทุกจอบอทต้องมี launch id ใหม่ของตัวเอง — ห้ามใช้ ts ของ Host เดิม ไม่อย่างนั้น
    // shared.server-control.js จะไม่ล้าง sessionStorage ที่ browser clone มาจากแท็บ Host
    // และ ww_host_room/ww_host_token ที่ติดมาจะทำให้ session ของสองหน้าปะปนกัน
    url.searchParams.set("ts", makeBotTesterLaunchId());
    // ส่งต่อ Admin controller ID จากแท็บ Host เผื่อ opener chain ของ WebView หายไป
    try {
        const adminControllerId = testerQuery.get("ac");
        if (adminControllerId) url.searchParams.set("ac", adminControllerId);
    } catch (e) {}
    // ส่ง controller ของ Host โดยตรง เพื่อให้บอทกลับมาที่ "Host เดิม" ได้โดยไม่ต้องเปิด Host ใหม่
    // แม้ window.opener จะหายระหว่าง blank -> navigate บน iPad/Chrome
    if (testerHostControllerId) url.searchParams.set("hc", testerHostControllerId);

    // ใช้ "token" ของบอท (คงที่ตลอดอายุบอทตัวนี้ ไม่เปลี่ยนทั้งตอน id เปลี่ยนจาก reconnect และตอน
    // ชื่อถูกเรียงเลขใหม่จาก renumberBots เวลามีบอทตัวอื่นถูกเตะ) เป็นชื่อหน้าต่างป๊อปอัป —
    // กันไม่ให้กดเข้าสิงซ้ำแล้วเปิดป๊อปอัปซ้อนหลายบานของบอทตัวเดิม (เดิมเคยลองใช้ botId/ชื่อบอท
    // มาก่อน แต่ทั้งคู่เปลี่ยนได้ระหว่างเล่น มีแต่ token เท่านั้นที่นิ่งจริง)
    //
    // แก้บั๊ก: เดิมมี "noopener" อยู่ใน feature string นี้ ซึ่งทำให้ป๊อปอัปที่เปิดขึ้น "ไม่มี
    // window.opener" อ้างอิงกลับมาที่จอโฮสต์เลย (ตัดการเชื่อมโดย spec ของ noopener โดยตรง) —
    // ขัดกับ releaseBotAndReturn() ใน player.main.js ที่ตั้งใจเช็ค window.opener เพื่อโฟกัส
    // กลับไปจอโฮสต์เดิมแล้วปิดป๊อปอัปตัวเองตอนกด "กลับหน้าโฮสต์" เมื่อไม่มี opener มันจะ fallback
    // ไปที่ window.location.href = "host.html" เฉยๆ (URL เปล่า ไม่มี ?tester=1&ht=... ของโฮสต์เดิม)
    // กลายเป็นเปิดหน้าโฮสต์ใหม่แบบไม่ใช่โหมดทดสอบและคนละห้อง/คนละ session กับจอโฮสต์ตัวจริงไปเลย
    // เอา noopener ออกเพื่อให้ window.opener ใช้งานได้ตามที่ releaseBotAndReturn() คาดไว้
    //
    // เปิดแท็บเปล่าก่อน แล้วค่อย navigate ไป player.html — โครงเดียวกับการเปิดแท็บ tester
    // จาก admin.html เพื่อรักษา window.opener กลับมาที่ host.html เดิมอย่างสม่ำเสมอ
    // โดยเฉพาะเมื่อเบราว์เซอร์/เว็บวิวใช้ heuristic จัด opener ให้กับ window.open(url, ...)
    // ต่างกันระหว่าง direct URL กับ blank-then-navigate
    const win = window.open("", "ww_bot_" + token, "width=430,height=860");
    if (win) {
        openBotWindows[token] = win;
        try {
            win.location.href = url.toString();
        } catch (e) {
            delete openBotWindows[token];
            try { win.close(); } catch (_) {}
            return;
        }
        try { win.focus(); } catch (e) {}
    }
}

// รายชื่อบอทในป๊อปอัปโหมดทดสอบ — เฟส 4 (bot-autonomous-ai-phases.md): เพิ่ม toggle "🧠 เล่นเองอัตโนมัติ"
// ต่อแถวบอท ให้โฮสต์เปิด/ปิด AI รายตัวได้จากหน้าจอ (แทนที่จะต้องเชื่อใจ backend เฉยๆ) — ปุ่มเข้าสิง/เตะ
// ยังอยู่ที่การ์ดผู้เล่นในกริดหลักเหมือนเดิม ที่นี่โฟกัสแค่สถานะ/คุม AI เท่านั้น
function renderBotList(room) {
    const wrap = document.getElementById("botList");
    if (!wrap) return;
    const bots = (room.players || []).filter((p) => p.isBot);
    if (bots.length === 0) {
        wrap.innerHTML = `<div class="empty-note" style="padding:6px 0;">ยังไม่มีบอทในห้องนี้</div>`;
        return;
    }
    const botAI = room.botAI || { enabled: true, perBot: {}, llmBots: {} };
    wrap.innerHTML = bots.map((b) => {
        const perBotOn = (botAI.perBot || {})[b.id] !== false;
        const llmOn = !!(botAI.llmBots || {})[b.id];
        const controlledByHuman = !!b.connected;
        return `
            <div class="botGroup" style="margin-bottom:8px;">
                <div class="testerConditionRow botRow">
                    <div class="botRow-info">
                        <span class="botAvatar">🤖</span>
                        <div>
                            <div class="tcLabel">${escapeHtml(b.name)}</div>
                            <div class="tcSub">🧠 เล่นเองอัตโนมัติ${controlledByHuman ? " (ตอนนี้มีคนเข้าสิงอยู่ — AI จะไม่แย่ง action)" : ""}</div>
                        </div>
                    </div>
                    <div class="tcToggle ${perBotOn ? "on" : ""}" onclick="toggleBotAI('${b.id}', ${!perBotOn})"></div>
                </div>
                <div class="testerConditionRow botRow">
                    <div class="botRow-info">
                        <span class="botAvatar">✨</span>
                        <div>
                            <div class="tcLabel">ใช้ Claude ตัดสินใจ</div>
                            <div class="tcSub">${llmOn ? "กัด/โหวตด้วย AI จริง แทนสุ่ม (ต้องเปิด \"เล่นเองอัตโนมัติ\" ด้านบนด้วย)" : "ปิดอยู่ — ใช้การสุ่มตามปกติ"}</div>
                        </div>
                    </div>
                    <div class="tcToggle ${llmOn ? "on" : ""}" onclick="toggleBotLLM('${b.id}', ${!llmOn})"></div>
                </div>
            </div>
        `;
    }).join("");
}

// สวิตช์ระดับห้อง — ปิดแล้วบอททุกตัวหยุดเล่นเองทันทีตั้งแต่ action ถัดไป (ไม่กระทบ toggle รายตัว
// ที่จำค่าไว้อยู่แล้วใน room.botAI.perBot ถ้าเปิดกลับมาทีหลัง ตัวที่เคยปิดรายตัวไว้ก็ยังปิดอยู่)
function renderBotAIMasterRow(room) {
    const row = document.getElementById("botAIMasterRow");
    const toggle = document.getElementById("botAIMasterToggle");
    const sub = document.getElementById("botAIMasterSub");
    if (!row || !toggle) return;
    const on = !room.botAI || room.botAI.enabled !== false;
    toggle.classList.toggle("on", on);
    if (sub) {
        sub.textContent = on
            ? "บอทที่ไม่มีคนเข้าสิงจะเล่นเอง (กัด/โหวต/ใช้สกิล)"
            : "⏸️ ปิดอยู่ — บอททุกตัวหยุดเล่นเองชั่วคราว ไม่ว่าจะเปิด toggle รายตัวไว้หรือไม่";
    }
}

function toggleBotAI(botId, enabled) {
    if (!roomId) return;
    socket.emit("toggle_bot_ai", { roomId, botId, enabled });
}

// เฟส 5 / "แนวทาง B": เปิด/ปิดให้บอทตัวนี้ใช้ Claude ตัดสินใจแทนสุ่ม (แยกจาก toggle_bot_ai
// ซึ่งคุมว่า "จะเล่นเองไหม" — อันนี้คุมแค่ "จะเลือกยังไง" ถ้าเล่นเอง)
function toggleBotLLM(botId, enabled) {
    if (!roomId) return;
    socket.emit("toggle_bot_llm_mode", { roomId, botId, enabled });
}

function toggleRoomBotAI() {
    if (!roomId) return;
    const on = !currentRoom || !currentRoom.botAI || currentRoom.botAI.enabled !== false;
    socket.emit("toggle_bot_ai", { roomId, enabled: !on });
}


// เฟส 4 (bot-autonomous-ai-phases.md): badge สถานะต่อบอทบนการ์ดผู้เล่นกริดหลัก — ให้โฮสต์เห็นทันที
// ว่าตอนนี้บอทตัวนี้ "ใครคุมอยู่" โดยไม่ต้องเปิดป๊อปอัปบอทมาเช็ค
//   🎮 คนคุมอยู่   → มีคนเข้าสิงอยู่จริง (p.connected === true) — AI จะไม่แย่ง action ให้
//   🧠 AI คุมอยู่   → ไม่มีคนเข้าสิง และ AI (ทั้งห้อง + รายตัว) เปิดอยู่
//   ⏸️ หยุดไว้     → ไม่มีคนเข้าสิง แต่ปิด toggle ไว้ (ทั้งห้องหรือรายตัวก็ตาม) — บอทจะค้างเฉยๆ ไม่ทำ action
function getBotControlBadgeHTML(p, room) {
    const botAI = (room && room.botAI) || { enabled: true, perBot: {} };
    if (p.connected) {
        return `<div class="pctrl-badge pctrl-human">🎮 คนคุมอยู่</div>`;
    }
    const roomAIOn = botAI.enabled !== false;
    const perBotOn = (botAI.perBot || {})[p.id] !== false;
    if (roomAIOn && perBotOn) {
        return `<div class="pctrl-badge pctrl-ai">🧠 AI คุมอยู่</div>`;
    }
    return `<div class="pctrl-badge pctrl-paused">⏸️ หยุดไว้</div>`;
}

const roleConfig = {};

// ===== ชื่อผู้คุม (ถาวรต่อเครื่อง) =====
// เก็บชื่อผู้คุมไว้ใน hostStorage แยกตามเครื่อง — ตั้ง/แก้ได้จากหน้าแรกของเว็บ (index.html) เท่านั้น
// index.html เขียนชื่อลง key เดียวกันนี้ (ww_host_display_name) ก่อนพามาที่หน้านี้เสมอ ให้จำชื่อนั้น
// ไว้เป็นชื่อถาวรของเครื่องนี้ และใช้ชื่อนี้ทุกครั้งที่สร้างห้องใหม่จากเครื่องนี้
// (เดิมแก้ชื่อได้จากป๊อปอัป "⚙️ ตั้งค่าห้อง" ในหน้านี้ด้วย แต่เป็นช่องโหว่: โฮสต์คนอื่นที่ล็อกอินเข้า
// ห้องคนอื่น (ไม่ใช่เจ้าของ) จะเห็นชื่อของห้องนั้นดึงมาโชว์ กด "บันทึก" เฉยๆ ก็ทับชื่อถาวรของเครื่อง
// ตัวเองด้วยชื่อคนอื่นโดยไม่ตั้งใจ — เอาช่องแก้ชื่อออกจากป๊อปอัปนั้นแล้ว ย้ายมาไว้ที่นี่จุดเดียว)
const HOST_NAME_KEY = "ww_host_display_name";
function getPersistedHostName() {
    return window.wwAccount?.getName() || hostStorage.getItem(HOST_NAME_KEY) || hostStorage.getItem("ww_host_display_name") || "";
}
function setPersistedHostName(name) {
    if (name && name.trim()) hostStorage.setItem(HOST_NAME_KEY, name.trim());
}
let hostName = getPersistedHostName();

let roles = {}; // cache ฝั่ง client

// ผู้ยุยง: เช็คฝั่ง client (สำหรับจอโฮสต์) ว่าผู้ศรัทธาทั้งสองตายครบแล้วหรือยัง (ปลดล็อกสิทธิ์ฆ่าเอง)
function instigatorBothBelieversDead(room, p) {
    if (!p || !Array.isArray(p.instigatorPairTargetIds) || p.instigatorPairTargetIds.length !== 2) return false;
    return p.instigatorPairTargetIds.every((id) => {
        const believer = room.players.find((x) => x.id === id);
        return believer && !believer.alive;
    });
}

// ดึง icon ของอาชีพจาก roles ที่เซิร์ฟเวอร์ส่งมา (roles_data) ถ้าไม่มีใช้รูป default
function getRoleIcon(role) {
    return (roles[role] && roles[role].icon) || (wwImg("/images/default-role.jpg"));
}

// รักษา <img> อาชีพเดิมเมื่อการ์ดผู้เล่นต้องอัปเดตข้อมูลอย่างอื่น เช่น สถานะชีวิต/ปกป้อง/เล็งฆ่า
// การเปลี่ยน state เหล่านี้เกิดผ่าน room_update บ่อยมาก แต่ไม่ควรทำให้เบราว์เซอร์ถอดและสร้างรูปใหม่
// ทุกครั้ง เพราะทำให้ไอคอนกระพริบและดูเหมือนรูปถูกโหลดใหม่ทั้งห้อง
function preserveExistingRoleImage(container, selector, previousImage, desiredImage) {
    if (!container || !previousImage || !desiredImage) return;
    const nextImage = container.querySelector(selector);
    if (!nextImage) return;

    const oldSrc = previousImage.getAttribute("src") || "";
    const nextSrc = desiredImage.getAttribute("src") || "";
    if (oldSrc === nextSrc) {
        nextImage.replaceWith(previousImage);
        return;
    }

    // เปลี่ยน src บน node เดิมเมื่อ URL รูปเปลี่ยนจริง (เช่น imageEpoch ใหม่)
    previousImage.setAttribute("src", nextSrc);
    previousImage.alt = desiredImage.alt || previousImage.alt || "";
    nextImage.replaceWith(previousImage);
}

// รวบรวม id ผู้เล่นที่ "กำลังถูกเล็งฆ่า" อยู่ตอนนี้ (จากหมาป่า room.wolfKillVotes และฆาตกรต่อเนื่อง room.murdererKillVote)
// ใช้เฉพาะตอนกลางคืน (ค่านี้จะถูกล้างตอนเริ่มคืนใหม่/สรุปผลกลางคืนอยู่แล้วฝั่ง server)
// เอาไว้ให้การ์ดของ "คนที่โดนเล็ง" (เหยื่อ) ติ๊กช่อง "เล็งฆ่า" โชว์ให้โฮสต์เห็นแบบเรียลไทม์ทันที
// ไม่ต้องรอกด "สรุปผลกลางคืน" ก่อน — แยกจาก p.killed ซึ่งเป็นผลสรุปจริงหลัง resolve_night
// ป้ายชื่อ/สีของแต่ละ "แหล่งที่มา" การเล็งฆ่า — ใช้ทั้งใน title (tooltip) และเลือกคลาส CSS
// (ดู .toggle-aimed-* ใน host.css คู่กัน คีย์ต้องตรงกับ ROLE_KEY ที่ใช้ใน getAimedTargetIds)
const AIM_SOURCE_LABELS = {
    wolf: "หมาป่า",
    murderer: "ฆาตกรต่อเนื่อง",
    instigator: "ผู้ยุยง",
    cult: "หัวหน้าลัทธิ (สังเวย)",
    bandit: "หัวโจร/ผู้สมรู้ร่วมคิด",
};

// รวบรวม id ผู้เล่นที่ "กำลังถูกเล็งฆ่า" อยู่ตอนนี้ พร้อม "แหล่งที่มา" ของการเล็ง (อาชีพไหนเล็ง)
// จากหมาป่า room.wolfKillVotes, ฆาตกรต่อเนื่อง room.murdererKillVote, ผู้ยุยง room.instigatorKillVote,
// หัวหน้าลัทธิ room.cultActions (mode: sacrifice), และหัวโจร/ผู้สมรู้ร่วมคิด room.banditKillVotes/banditActions
// ใช้เฉพาะตอนกลางคืน (ค่านี้จะถูกล้างตอนเริ่มคืนใหม่/สรุปผลกลางคืนอยู่แล้วฝั่ง server)
// คืนค่าเป็น Map<targetId, roleKey> แทน Set ธรรมดา เพื่อให้ฝั่ง render เลือกสีตามอาชีพที่เล็งได้
// (รองรับ .has(id) แบบเดิมได้เหมือน Set — โค้ดเดิมที่เรียก aimedTargetIds.has(p.id) ยังใช้ได้ไม่ต้องแก้)
// ถ้าผู้เล่นคนเดียวกันโดนเล็งจากหลายอาชีพพร้อมกัน จะเก็บอาชีพแรกที่เจอไว้ (ลำดับความสำคัญ ต่ำสุด→สูงสุด:
// หมาป่า → ฆาตกรต่อเนื่อง → ผู้ยุยง → โจร/ผู้สมรู้ร่วมคิด → หัวหน้าลัทธิ (สังเวย) — ตรงกับลำดับ override
// ที่ resolve_night ฝั่ง server ใช้จริง (ดูคอมเมนต์ "ฆาตกรต่อเนื่อง/ผู้ยุยง ก็ทับหมาป่าได้เหมือนกัน" และ
// ลัทธิ resolve หลังสุดจึงทับได้ทุกกรณี) เพราะ setIfAbsent เป็นแบบ "เจอก่อนชนะ" (first-registered-wins)
// เลยต้องเรียงลำดับการเช็คจาก "สูงสุดไปต่ำสุด" (ลัทธิก่อน ... หมาป่าท้ายสุด) ไม่ใช่เรียงตามลำดับที่เขียนโค้ด
function getAimedTargetIds(room) {
    const map = new Map();
    if (!room || !room.isNight) return map;
    const setIfAbsent = (targetId, roleKey) => {
        if (targetId && !map.has(targetId)) map.set(targetId, roleKey);
    };
    // 🔯 หัวหน้าลัทธิตอน "กำลังเลือกสังเวย" (mode: "sacrifice") — targetId คือคนที่จะถูกฆ่าจริง
    // (สมาชิกที่ถูกเลือกมาสังเวยคือ sacrificeId ไม่ใช่คนที่ตาย) — ลำดับความสำคัญสูงสุด เช็คก่อนใคร
    Object.values(room.cultActions || {}).forEach((action) => {
        if (action && action.mode === "sacrifice" && action.targetId) setIfAbsent(action.targetId, "cult");
    });
    // 🗡️ หัวโจร/ผู้สมรู้ร่วมคิดตอน "กำลังเลือกฆ่าร่วม" — ทั้งสองฝ่ายอาจเลือกเป้าไม่ตรงกันได้ (สุ่มตอน resolve)
    // เลยต้องรวมเป้าของทั้งคู่เข้า map นี้ ให้โฮสต์เห็นว่าใครกำลังโดนทีมโจรเล็งอยู่แบบเรียลไทม์
    Object.values(room.banditKillVotes || {}).forEach((targetId) => setIfAbsent(targetId, "bandit"));
    // 🎭 หัวโจรตอน "กำลังเลือกเปลี่ยนบทบาท" (room.banditActions — คืนที่ยังไม่มีผู้สมรู้ร่วมคิด) ก็ให้นับเป็น
    // "เล็งฆ่า" ในมุมมองโฮสต์ด้วยเหมือนกัน (ฝั่งผู้เล่นมี badge หน้ากาก bandit_mask.jpg ของตัวเองอยู่แล้ว
    // แต่โฮสต์ยังไม่เห็นไฮไลต์เรียลไทม์แบบเดียวกับสังเวย/ฆ่าร่วม — จุดนี้แก้เฉพาะฝั่งโฮสต์เท่านั้น)
    Object.values(room.banditActions || {}).forEach((action) => {
        if (action && action.targetId) setIfAbsent(action.targetId, "bandit");
    });
    if (room.instigatorKillVote && room.instigatorKillVote.targetId) {
        setIfAbsent(room.instigatorKillVote.targetId, "instigator");
    }
    if (room.murdererKillVote && room.murdererKillVote.targetId) {
        setIfAbsent(room.murdererKillVote.targetId, "murderer");
    }
    // 🐺 หมาป่า — ลำดับความสำคัญต่ำสุด เช็คทีหลังสุด ชนะได้เฉพาะเป้าที่ไม่มีใครอื่นเล็งอยู่เท่านั้น
    Object.values(room.wolfKillVotes || {}).forEach((targetId) => setIfAbsent(targetId, "wolf"));
    return map;
}

// รวบรวม id ผู้เล่นที่ "กำลังถูกยายขี้โมโหเลือกใบ้" อยู่ตอนนี้ (จาก room.selectedTargets ที่ผู้เลือกมีบทเป็นยายขี้โมโห)
// เอาไว้ให้การ์ดของ "คนที่โดนเลือก" ติ๊กช่อง "ใบ้" โชว์ให้โฮสต์เห็นแบบเรียลไทม์ทันที — แค่เป็นตัวชี้เป้าที่กำลังเลือกอยู่
// (ยังไม่ใบ้จริง) ผลจริงจะเกิดตอนสรุปผลกลางคืน (เช้า) เท่านั้น ดูคอมเมนต์ที่ resolve_night ฝั่ง server
function getSilenceAimIds(room) {
    const ids = new Set();
    if (!room || !room.isNight) return ids;
    const selectedTargets = room.selectedTargets || {};
    Object.entries(selectedTargets).forEach(([fromId, targetId]) => {
        if (!targetId) return;
        const actor = room.players.find((p) => p.id === fromId);
        if (actor && actor.role === "ยายขี้โมโห") ids.add(targetId);
    });
    return ids;
}

// รวบรวม id ผู้เล่นที่ "กำลังถูกเลือกปกป้อง" อยู่ตอนนี้ (จาก room.selectedTargets ที่ผู้เลือกมีบทเป็น
// หมอ/บอดี้การ์ด/แม่มด/อันธพาล — บทที่ป้องกันได้ผ่าน select_target ปกติ) ใช้ให้การ์ดของ "คนที่ถูกเลือก" ติ๊กช่อง
// "ปกป้อง" โชว์ไฮไลต์สีเขียวแบบเรียลไทม์เหมือนกับ "เล็งฆ่า"/"ใบ้"
// แก้บั๊ก: เดิมไม่มี "อันธพาล" ในเซตนี้ ทำให้ตอนนักกล้าม/อันธพาลเลือกเป้าปกป้อง (นอกจากตัวเอง)
// ฝั่งโฮสต์ไม่เห็นไฮไลต์แบบเรียลไทม์เลย ทั้งที่จริงๆ ข้อมูลถูกเก็บใน room.selectedTargets แล้ว
const PROTECT_ROLES = new Set(["หมอ", "บอดี้การ์ด", "แม่มด", "อันธพาล"]);
function getProtectAimIds(room) {
    const ids = new Set();
    if (!room || !room.isNight) return ids;
    const selectedTargets = room.selectedTargets || {};
    Object.entries(selectedTargets).forEach(([fromId, targetId]) => {
        if (!targetId) return;
        const actor = room.players.find((p) => p.id === fromId);
        if (actor && PROTECT_ROLES.has(actor.role)) ids.add(targetId);
    });
    return ids;
}

// บทบาททีมหมาป่าที่ "ล่าฆ่า" ได้จริง (ตรงกับ WOLF_ROLES ฝั่ง server ลบ "หมาป่าหยั่งรู้" ที่ไม่ร่วมล่า
// ดู performWolfKill ใน server.js) ใช้เช็คว่าห้องนี้มีทีมหมาป่าที่โหวตฆ่าได้อยู่ไหม
const WOLF_KILL_ROLES = new Set([
    "หมาป่า",
    "ลูกหมาป่า",
    "หมาป่าผู้พิทักษ์",
    "หมาป่าดื้อรั้น",
    "หมาป่านักเวท",
]);

// พรีโหลดรูปไอคอนอาชีพทั้งหมดล่วงหน้า กันรูปกระตุก/เด้งช้าตอนเพิ่มอาชีพจริงๆ
const preloadedIcons = new Set();
let rolesDataSignature = "";
function preloadRoleImages(rolesData) {
    Object.values(rolesData || {}).forEach((info) => {
        const src = info && info.icon;
        if (!src || preloadedIcons.has(src)) return;
        preloadedIcons.add(src);
        const img = new Image();
        img.src = src;
    });
}

socket.on("roles_data", (data) => {

    // roles_data ปกติส่งครั้งเดียวตอน connect; ถ้า reconnect แล้วข้อมูลเหมือนเดิม ไม่ควรล้าง quick-add
    // และสร้าง <img> ทุกบทบาทใหม่ เพราะทำให้หน้า Host กระพริบทั้งชุดโดยไม่จำเป็น
    const nextRoles = data || {};
    let nextSignature = "";
    try { nextSignature = JSON.stringify(nextRoles); } catch (_) {}
    if (rolesDataSignature && nextSignature && rolesDataSignature === nextSignature) {
        return;
    }
    rolesDataSignature = nextSignature || rolesDataSignature;

    // เก็บข้อมูล roles ทั้งหมดไว้ใช้ทั้งระบบ
    roles = nextRoles;
    window.wwRolesData = roles; // เปิดให้ shared.server-control.js อ่านไปโชว์ตอนจอ "กำลังปิด" ได้
    preloadRoleImages(roles);

    const quickAdd = document.getElementById("quickAddRoles");

    if (!quickAdd) return; // กัน DOM ไม่พร้อม

    quickAdd.innerHTML = "";

    Object.keys(roles).forEach((role) => {

        // กรอง key พิเศษที่ server ส่งมา (เช่น __wolfRoles) ออกจากกริดเลือกบทบาท
        if (role.startsWith("__")) return;
        // กรองอาชีพที่ "ได้มาจากการเปลี่ยนบทบาทกลางเกมเท่านั้น" ออกด้วย (เช่น ผู้สมรู้ร่วมคิด — เกิดจาก
        // โจรเปลี่ยนบทบาทผู้เล่นคนอื่นให้เท่านั้น โฮสต์ติ๊กเลือกไว้ล่วงหน้าไม่ได้) — ดู __nonSelectableRoles
        if ((roles.__nonSelectableRoles || []).includes(role)) return;

        const chip = document.createElement("div");
        chip.className = "quick-add-chip";
        chip.dataset.role = role;
        chip.onclick = () => toggleRole(role);
        chip.innerHTML = `
            <img src="${getRoleIcon(role)}" alt="${role}" onerror="this.style.display='none'">
            <span>${role}</span>
        `;
        quickAdd.appendChild(chip);

    });

    renderQuickAddBadges();

    // re-render การ์ดบทบาทที่เลือกไว้ เพราะ roles พร้อมแล้ว (icon จะโหลดได้ถูกต้อง)
    // กรณีโหลดหน้าใหม่: room_update อาจมาก่อน roles_data ทำให้ renderRoles() ครั้งแรกไม่มี icon
    renderRoles();

});


// ===== รหัสห้อง (ตั้งค่า "⚙️ ตั้งค่าห้อง" — กันแอดมิน/จอคนอื่นแย่งคุมห้อง) =====
// จำรหัสที่เคยใส่ถูก/เคยตั้งเองไว้ในเครื่อง แยกเป็นรายห้อง (ใช้ storage เดียวกับ hostToken —
// tester mode แยก session ต่อแท็บเหมือนกัน) เพื่อไม่ต้องพิมพ์รหัสซ้ำทุกครั้งที่จอนี้ reconnect
function roomPassKey(id) { return `ww_room_pass_${id}`; }
function getSavedRoomPassword(id) { return hostStorage.getItem(roomPassKey(id)) || ""; }
function saveRoomPassword(id, pass) {
    if (pass) hostStorage.setItem(roomPassKey(id), pass);
    else hostStorage.removeItem(roomPassKey(id));
}

// ===== รหัสห้องฝั่งผู้เล่น (ตั้งค่า "⚙️ ตั้งค่าห้อง" — คนละอย่างกับรหัสผ่านห้องด้านบน) =====
// เก็บแบบเดียวกับ roomPassKey ทุกประการ (server ไม่ส่งค่าจริงกลับมาผ่าน room_update
// เหมือน hostPassword — ดู publicRoomView) จำไว้ในเครื่องนี้เพื่อโชว์ในช่องกรอกตอนเปิดป๊อปอัปซ้ำ
function roomJoinCodeKey(id) { return `ww_room_joincode_${id}`; }
function getSavedRoomJoinCode(id) { return hostStorage.getItem(roomJoinCodeKey(id)) || ""; }
function saveRoomJoinCode(id, code) {
    if (code) hostStorage.setItem(roomJoinCodeKey(id), code);
    else hostStorage.removeItem(roomJoinCodeKey(id));
}

// แสดงรหัสห้องบนหน้าจอ + ผูกปุ่มคัดลอก (ใช้ทั้งตอนสร้างห้องใหม่และตอนกลับเข้าห้องเดิม)
function applyRoomId(id) {
    roomId = id;
    document.getElementById("room").innerText = id;
    document.getElementById("room").onclick = () => {
        navigator.clipboard.writeText(roomId);
    };
    hostStorage.setItem("ww_host_room", id);
    // sync ปุ่มเต็มจอทันทีหลังได้ห้อง ไม่ต้องรอ room_update รอบถัดไป
    // ป้องกัน race ที่ room_update มาก่อน host_login callback.
    updateHostControlChrome(currentRoom || { id, started:false, gameOver:false, config: roleConfig, players:[] });
    hostBrowserExitServerClosed = false;
    hostBrowserExitRequested = false;
    hostBrowserExitSignalSent = false;
    hostBrowserExitGuardState(true, "room_active");
    if (isTesterMode) {
        const u = new URL(window.location.href);
        u.searchParams.set("r", id);
        history.replaceState(null, "", u.toString());
    }
    armBackGuard(); // ตอนนี้กำลังคุมห้องอยู่ → กดย้อนกลับ = ต้องยืนยันปิดห้องก่อน
}

// ===== กันกด "ย้อนกลับ" พลาดตอนกำลังคุมห้องอยู่ =====
// หน้าโฮสต์ = การคุมห้อง — ออกจากหน้านี้ด้วยปุ่มย้อนกลับ (ปุ่มย้อนกลับของเบราว์เซอร์/ปุ่มนำทางของมือถือ/ปัดขอบจอ)
// ถือเท่ากับ "ปิดห้อง" (ผู้เล่นทุกคนหลุดจากห้องที่ไม่มีคนคุม) จึงต้องถามยืนยันแบบเดียวกับปุ่ม "✕ ปิดห้อง"
// วิธี: ตอนเริ่มคุมห้อง ดัน history entry กันไว้ 1 อัน (sentinel) → กดย้อนกลับแล้วเบราว์เซอร์แค่ถอยมาที่ entry เดิมของ
// หน้านี้ (ยังอยู่หน้าเดิม) แล้วยิง popstate → เราดัน sentinel กลับเข้าไปใหม่ทันที (ยังอยู่ต่อได้) แล้วเด้งป๊อปอัปถาม
//   - "อยู่ต่อ"        → ไม่เกิดอะไรขึ้น กดย้อนกลับครั้งหน้าก็ถามใหม่
//   - "ปิดห้องและออก" → close_room จริง (room_closed ด้านล่างพากลับหน้าแรกเอง)
// ไม่กระทบ: การรีเฟรชหน้าเอง (ไม่ใช่การย้อนกลับ ไม่มี popstate) — โฮสต์กลับเข้าห้องเดิมได้ตามปกติ
// ข้อจำกัด: ปิดแท็บ/ปิดแอป/พิมพ์ URL ใหม่ เบราว์เซอร์ไม่ให้ดักด้วยป๊อปอัปของเราได้ (และไม่ได้ปิดห้อง — ห้องยังเปิดค้างอยู่
// เข้าคุมต่อได้จากกริด "ห้องที่ยังเปิดอยู่") · Chrome จะข้าม entry ที่หน้าเพจดันเองถ้ายังไม่เคยมีการแตะหน้าจอเลย
// จึงรอให้มีการแตะ/กดครั้งแรกก่อนค่อยดัน sentinel (ดู armBackGuard)
let backGuardArmed = false;
let backGuardConfirmOpen = false;
let closeRequestedFromBack = false;

function armBackGuard() {
    if (backGuardArmed) return;
    const doArm = () => {
        if (backGuardArmed || !roomId) return;
        backGuardArmed = true;
        history.pushState({ wwHostGuard: 1 }, "", window.location.href);
    };
    const ua = navigator.userActivation;
    if (!ua || ua.hasBeenActive) {
        doArm();
        return;
    }
    // ยังไม่เคยมีการแตะหน้าจอในหน้านี้เลย (เช่นรีโหลดแล้วกลับเข้าห้องเดิมอัตโนมัติ) — รอแตะครั้งแรกก่อน
    const evs = ["pointerdown", "touchstart", "keydown"];
    const once = () => {
        evs.forEach((e) => window.removeEventListener(e, once, true));
        doArm();
    };
    evs.forEach((e) => window.addEventListener(e, once, true));
}

// โหมดโฮสต์ทดลองไม่ควรย้อนกลับเข้าเกมหลักปกติ — จุดหมายของมันคือหน้าแอดมินเท่านั้น
if (isTesterMode) {
    history.pushState({ wwTesterHostRootGuard: true }, "", window.location.href);
    window.addEventListener("popstate", () => {
        if (!backGuardArmed && !roomId) returnFromHostScreen();
    });
}

window.addEventListener("popstate", async () => {
    if (!backGuardArmed) return;
    if (!roomId) { backGuardArmed = false; return; } // ไม่ได้คุมห้องแล้ว (เช่นห้องปิดไปแล้ว) — ปล่อยให้ย้อนกลับตามปกติ
    // ดัน sentinel กลับทันที (ก่อนถามอะไรทั้งนั้น) เพื่อให้ยังอยู่หน้านี้ ไม่ว่าจะตอบว่าอะไร
    history.pushState({ wwHostGuard: 1 }, "", window.location.href);
    if (backGuardConfirmOpen) return; // กดย้อนรัวๆ ตอนป๊อปอัปเปิดอยู่แล้ว
    backGuardConfirmOpen = true;
    const ok = await wwConfirm(
        "การออกจากหน้านี้ = ปิดห้องนี้ด้วย ผู้เล่นทุกคนในห้องจะถูกเตะออกทันที และย้อนกลับไม่ได้ — ต้องการปิดห้องแล้วออกเลยหรือไม่?",
        { okText: "ปิดห้องและออก", cancelText: "อยู่ต่อ", danger: true }
    );
    backGuardConfirmOpen = false;
    if (!ok || !roomId) return;
    hostAllowIntentionalExit("browser_back_confirmed");
    closeRequestedFromBack = true;
    socket.emit("close_room", roomId);
    // room_closed จะพากลับหน้าแรกให้เอง — ถ้าไม่มีอะไรตอบกลับใน 4 วิ (ขาดการเชื่อมต่อ) ต้องบอก ไม่ปล่อยเงียบ
    setTimeout(() => {
        if (closeRequestedFromBack) {
            closeRequestedFromBack = false;
            wwAlert("ปิดห้องไม่สำเร็จ (ขาดการเชื่อมต่อกับเซิร์ฟเวอร์) ห้องยังเปิดอยู่ ลองใหม่อีกครั้งเมื่อเชื่อมต่อได้");
        }
    }, 4000);
});

// ===== ตั้งค่าห้อง "ก่อนสร้าง" (ยังไม่สร้างห้องจริงบน server) =====
// เดิมกด "สร้างห้อง" แล้ว server สร้างห้อง + ออกรหัสห้องทันที ผู้เล่นเข้าได้เลยก่อนที่โฮสต์จะทันตั้งรหัส/บทบาท
// ตอนนี้ทุกทางที่นำไปสู่ "ห้องใหม่" (เปิดหน้านี้ตอนไม่มีห้องเปิดอยู่ / กด "สร้างห้องใหม่" ในกริด /
// กด "🆕 สร้างห้องใหม่" ในห้อง) มาจบที่ enterSetupMode() ก่อนเสมอ โชว์หน้าตั้งค่า (รหัสผ่านห้อง รหัสห้องฝั่งผู้เล่น
// จำนวนสูงสุด บทบาท + ตัวเลือกโหมดทดสอบ) ห้องจะถูกสร้างจริงตอนกด "✅ สร้างห้อง" (confirmCreateRoom) ครั้งเดียว
// พร้อมค่าทั้งหมดที่ตั้งไว้ (create_room รับ settings — ดู sanitizeRoomSettings ใน server.js)
// ระหว่างอยู่หน้านี้ roomId เป็นค่าว่างเสมอ (ไม่มีห้อง) — updateConfig() ฯลฯ จึงไม่ยิงอะไรไปหา server
let setupMode = false;
let setupState = null;
let setupRevealDeadRole = true;

// ตัวเลือก "แสดงบทบาทเมื่อผู้เล่นตาย" ใช้สถานะจาก room เป็น source of truth หลังสร้างห้อง
// ส่วนตอน setup ยังไม่มี room จึงเก็บไว้ใน setupRevealDeadRole แยกต่างหาก
function renderRevealDeadRoleToggle(elementId, subId, enabled, locked) {
    const toggle = document.getElementById(elementId);
    const sub = subId ? document.getElementById(subId) : null;
    if (!toggle) return;
    toggle.classList.toggle("on", !!enabled);
    toggle.classList.toggle("disabled", !!locked);
    toggle.setAttribute("aria-checked", String(!!enabled));
    toggle.setAttribute("aria-disabled", String(!!locked));
    if (sub) {
        sub.textContent = locked
            ? "🔒 ล็อกแล้วหลังเริ่มเกม — กด “🔄 เริ่มต้นใหม่” ก่อนจึงจะเปลี่ยนได้"
            : (enabled
                ? "เปิดอยู่ — เมื่อผู้เล่นตาย คนอื่นจะเห็นอาชีพที่มุมขวาล่างของการ์ดผู้เล่น (เปลี่ยนได้จนกว่าจะเริ่มเกม)"
                : "ปิดอยู่ — เมื่อผู้เล่นตาย คนอื่นจะไม่เห็นอาชีพที่มุมขวาล่าง (เปลี่ยนได้จนกว่าจะเริ่มเกม)");
    }
}

function renderSetupRevealDeadRole() {
    renderRevealDeadRoleToggle("setupRevealDeadRoleToggle", "setupRevealDeadRoleSub", setupRevealDeadRole, false);
}

function toggleSetupRevealDeadRole() {
    const toggle = document.getElementById("setupRevealDeadRoleToggle");
    if (toggle?.classList.contains("disabled")) return;
    setupRevealDeadRole = !setupRevealDeadRole;
    renderSetupRevealDeadRole();
}

function renderRoomRevealDeadRole() {
    if (!currentRoom) return;
    const enabled = currentRoom.revealDeadRole !== false;
    const locked = !!currentRoom.started;
    renderRevealDeadRoleToggle("roomSettingsRevealDeadRoleToggle", "roomSettingsRevealDeadRoleSub", enabled, locked);
}

function toggleRoomRevealDeadRole() {
    if (!currentRoom || currentRoom.started) return;
    currentRoom.revealDeadRole = currentRoom.revealDeadRole === false;
    renderRoomRevealDeadRole();
}

// คีย์บอร์ด/แอคเซสซิบิลิตี้สำหรับ toggle แบบเดียวกับปุ่มทดสอบที่มีอยู่
document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target?.id === "setupRevealDeadRoleToggle") {
        e.preventDefault();
        toggleSetupRevealDeadRole();
    } else if (e.target?.id === "roomSettingsRevealDeadRoleToggle") {
        e.preventDefault();
        toggleRoomRevealDeadRole();
    }
});

// ค่าเริ่มต้นของตัวเลือกโหมดผู้ทดสอบ = เท่ากับห้องที่สร้างแบบเดิมทุกประการ (บอทเล่นเองปิด / นับเวลาโหวตเปิด / เงื่อนไขจบเกมเปิดหมด)
// (winConditionDefs ประกาศไว้ด้านล่างของไฟล์ — ฟังก์ชันนี้ถูกเรียกหลังโหลดสคริปต์เสร็จแล้วเสมอ จึงอ่านได้)
function freshSetupState() {
    const win = {};
    winConditionDefs.forEach((d) => { win[d.key] = true; });
    return { botAI: false, voteTimer: true, win };
}

function showSetupError(msg) {
    const el = document.getElementById("setupError");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
}

function renderSetupTesterOptions() {
    const wrap = document.getElementById("setupTesterOptions");
    if (!wrap || !setupState) return;
    const row = (label, sub, on, onclick) => `
        <div class="testerConditionRow">
            <div>
                <div class="tcLabel">${label}</div>
                <div class="tcSub">${sub}</div>
            </div>
            <div class="tcToggle ${on ? "on" : ""}" onclick="${onclick}"></div>
        </div>`;
    const winRows = winConditionDefs.map((d) =>
        row(d.label, d.sub, setupState.win[d.key] !== false, `toggleSetupOption('win','${d.key}')`)
    ).join("");
    wrap.innerHTML =
        row("🧠 บอทเล่นเองอัตโนมัติ (ทั้งห้อง)", "บอทที่ไม่มีคนเข้าสิงจะเล่นเอง (กัด/โหวต/ใช้สกิล) — เพิ่มบอทได้หลังสร้างห้อง", setupState.botAI, "toggleSetupOption('botAI')") +
        row("🗳️ นับเวลาโหวตถอยหลังอัตโนมัติ", setupState.voteTimer ? "เปิดอยู่ — โหวตจะปิดเองเมื่อหมดเวลา" : "ปิดอยู่ — ต้องกดปิดโหวตเอง", setupState.voteTimer, "toggleSetupOption('voteTimer')") +
        `<div class="tcSub" style="margin:10px 2px 2px;">เงื่อนไขจบเกม (ปิดข้อไหนไว้ เกมจะไม่จบจากข้อนั้น)</div>` + winRows;
}

function toggleSetupOption(key, sub) {
    if (!setupState) return;
    if (key === "win") setupState.win[sub] = !(setupState.win[sub] !== false);
    else setupState[key] = !setupState[key];
    renderSetupTesterOptions();
}

function enterSetupMode() {
    hideRoomPicker();
    roomId = "";
    currentRoom = null;
    setupMode = true;
    setupState = freshSetupState();

    // แก้บั๊ก: ถ้ากด "🆕 สร้างห้องใหม่" ตอนห้องเดิมกำลังเล่นอยู่ (room.started && !room.gameOver)
    // room_update ล่าสุดจะติดคลาส "role-hidden" ไว้ที่ .layout (ดู applyRoomData()) เพื่อยุบ #leftCol
    // ทิ้งตอนการ์ด "ตั้งค่าบทบาท" ถูกซ่อนกลางเกม — พอ room_closed พามาที่นี่ต่อทันทีโดยไม่มี room_update
    // ของห้องใหม่มาล้างคลาสให้ #leftCol (ที่ครอบ #setupCard อยู่) เลยค้าง display:none ต่อ ทำให้
    // การ์ดตั้งค่าห้องใหม่ไม่โผล่เลยทั้งที่ eyebrow/ปุ่มด้านล่างเปลี่ยนไปแล้ว ต้องล้างทั้งสองคลาสนี้เอง
    // ทุกครั้งที่เข้า setup mode เพื่อการันตีว่า #leftCol และการ์ดตั้งค่าบทบาทกลับมาโชว์แน่ ๆ
    document.querySelector(".layout")?.classList.remove("role-hidden");
    document.getElementById("roleSettingsCard")?.classList.remove("hidden");

    // ห้องใหม่เริ่มจากไม่มีบทบาทเสมอ (เหมือนเดิมที่ห้องใหม่มี config ว่าง)
    Object.keys(roleConfig).forEach((k) => { delete roleConfig[k]; });
    renderRoles();

    ["setupPassInput", "setupJoinCodeInput", "setupMaxPlayersInput"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    setupRevealDeadRole = true;
    renderSetupRevealDeadRole();
    showSetupError("");
    document.getElementById("setupTesterBlock").classList.toggle("hidden", !isTesterMode);
    if (isTesterMode) renderSetupTesterOptions();
    document.getElementById("eyebrowText").textContent = "ตั้งค่าห้องใหม่ — ยังไม่ได้สร้างห้อง";
    document.getElementById("createRoomBtn").disabled = false;
    document.body.classList.add("setup-mode");
    document.body.classList.remove("is-night");
    document.body.classList.add("is-day");
    updateHostControlChrome({ started:false, gameOver:false, config: roleConfig, players:[], hasJoinCode:false, maxPlayers:0 });
    window.scrollTo(0, 0);
}

function leaveSetupMode() {
    setupMode = false;
    setupState = null;
    document.body.classList.remove("setup-mode");
    document.getElementById("eyebrowText").textContent = "ห้องควบคุมผู้เล่าเรื่อง";
    updateHostControlChrome(currentRoom || { started:false, gameOver:false, config: roleConfig, players:[] });
    if (currentRoom && roomId) {
        updateNightFlowButtons(currentRoom);
    } else {
        document.body.classList.remove("is-day", "is-night");
    }
    showSetupError("");
}

// ยกเลิกการสร้างห้อง — ไม่มีอะไรถูกสร้างบน server เลย: มีห้องอื่นเปิดอยู่ → กลับไปกริดเลือกห้อง ไม่มี → กลับหน้าแรก
function cancelSetup() {
    leaveSetupMode();
    Object.keys(roleConfig).forEach((k) => { delete roleConfig[k]; });
    renderRoles();
    socket.emit("list_open_rooms", (list) => {
        list = list || [];
        if (list.length > 0) renderRoomPicker(list);
        else returnFromHostScreen();
    });
}

// กด "✅ สร้างห้อง" — อ่านค่าจากหน้าตั้งค่า ตรวจ แล้วสร้างห้องจริงพร้อมค่าทั้งหมดในครั้งเดียว
function confirmCreateRoom() {
    if (!setupMode) return;
    const pass = document.getElementById("setupPassInput").value.trim();
    const joinCode = document.getElementById("setupJoinCodeInput").value.trim();
    const maxRaw = document.getElementById("setupMaxPlayersInput").value.trim();

    let maxPlayers = 0;
    if (maxRaw !== "") {
        maxPlayers = Number(maxRaw);
        if (!Number.isInteger(maxPlayers) || maxPlayers < 0 || maxPlayers > 999) {
            showSetupError("จำนวนผู้เล่นสูงสุดต้องเป็นเลขจำนวนเต็ม 0–999 (ปล่อยว่างหรือ 0 = ไม่จำกัด)");
            document.getElementById("setupMaxPlayersInput").focus();
            return;
        }
    }
    showSetupError("");

    const settings = {
        hostPassword: pass,
        joinCode,
        maxPlayers,
        revealDeadRole: setupRevealDeadRole,
        config: { ...roleConfig },
    };
    if (isTesterMode && setupState) {
        settings.botAIEnabled = !!setupState.botAI;
        settings.voteTimerEnabled = !!setupState.voteTimer;
        settings.testerConditions = { ...setupState.win };
    }
    createNewRoom(settings);
}

// CREATE ROOM (สร้างห้องจริง — เรียกจาก confirmCreateRoom() เท่านั้น ห้ามเรียกตรงจากที่อื่น)
async function createNewRoom(settings) {
    if (!isTesterMode) {
        try { await bootstrapHostAccount(); }
        catch (e) {
            showSetupError(e?.code === "ACCOUNT_PERSISTENCE_UNAVAILABLE" ? "เชื่อมฐานข้อมูลบัญชีไม่สำเร็จ กรุณาลองใหม่" : "บัญชียังไม่ได้รับ Account ID จากเซิร์ฟเวอร์ กรุณาลองใหม่");
            return;
        }
    }
    hostName = getPersistedHostName();
    if (!isTesterMode && (!window.wwAccount?.getIdentity().accountId || !window.wwAccount?.getIdentity().accountToken)) {
        showSetupError("บัญชียังไม่ได้รับ Account ID จากเซิร์ฟเวอร์ กรุณาลองใหม่");
        return;
    }
    const btn = document.getElementById("createRoomBtn");
    if (btn) btn.disabled = true;
    socket.emit(
        "create_room",
        { name: hostName, token: hostToken, ...(isTesterMode ? {} : window.wwAccount.payload()), isTester: isTesterMode, testerSessionId: isTesterMode ? (new URLSearchParams(location.search).get("ts") || "") : "", settings },
        (res) => {
            if (!res || res.error || !res.roomId) {
                if (btn) btn.disabled = false;
                showSetupError("สร้างห้องไม่สำเร็จ ลองใหม่อีกครั้ง");
                return;
            }
            // จำรหัสที่ตั้งไว้ในเครื่องนี้ (เหมือนตอนตั้งผ่าน "⚙️ ตั้งค่าห้อง" — server ไม่ส่งค่าจริงกลับมาทาง room_update)
            saveRoomPassword(res.roomId, res.hostPassword || "");
            saveRoomJoinCode(res.roomId, res.joinCode || "");
            leaveSetupMode();
            // ยังไม่รับ room_update รอบแรก: คงธีมเช้าไว้ก่อน เพื่อไม่ให้จอมืดแว่บระหว่าง
            // เปลี่ยนจาก "ตั้งค่าห้อง" ไปเป็น "รอผู้เล่น" (ห้องใหม่ยังไม่เริ่มเกม)
            document.body.classList.remove("is-night");
            document.body.classList.add("is-day");
            writeSavedHostRoomTheme(res.roomId, "day");
            applyRoomId(res.roomId);
            hideRoomPicker();
        }
    );
}

// เข้าคุมห้องที่เลือกจากกริด (หรือกลับเข้าห้องเดิมอัตโนมัติ) — ใช้ "host_login"
// เสมอแทน join_room เพราะห้องไม่ถูกลบอัตโนมัติแล้ว ข้อมูลห้องเดิมทั้งหมด
// (บทบาท/ผู้เล่น/แชท) จะยังอยู่ครบ ไม่ว่าจะล็อกอินจากอุปกรณ์เดิมหรืออุปกรณ์ใหม่
let hostLoginInFlight = "";

async function loginToRoom(id, passwordOverride) {
    id = String(id || "").trim().toUpperCase();
    if (!id) return;
    const password = passwordOverride !== undefined ? String(passwordOverride) : getSavedRoomPassword(id);
    const loginKey = id + "|" + password;
    if (hostLoginInFlight === loginKey) return;
    hostLoginInFlight = loginKey;

    try {
        if (!isTesterMode) {
            try { await bootstrapHostAccount(); }
            catch (_) {
                hostLoginInFlight = "";
                return showSetupError("บัญชียังไม่ได้รับ Account ID จากเซิร์ฟเวอร์ กรุณาลองใหม่");
            }
        }
        const auth = isTesterMode ? {} : (window.wwAccount ? window.wwAccount.payload() : {});
        socket.emit(
            "host_login",
            { roomId: id, token: hostToken, password, ...auth },
            async (res) => {
                hostLoginInFlight = "";
                if (res && res.ok) {
                    saveRoomPassword(id, password);
                    applyRoomId(id);
                    hideRoomPicker();
                    return;
                }
                if (res && res.error === "wrong_password") {
                    const entered = await wwPrompt("ห้องนี้ตั้งรหัสผ่านไว้ กรอกรหัสผ่านห้องเพื่อเข้าคุม:");
                    if (entered !== null) loginToRoom(id, entered);
                    return;
                }
                if (res && res.error === "too_many_attempts") {
                    wwAlert("ลองรหัสผ่านผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง");
                    refreshRoomPicker();
                    return;
                }
                if (res && res.code === "SERVER_ERROR") {
                    wwAlert("เซิร์ฟเวอร์กำลังซิงก์ข้อมูลห้องอยู่ ระบบจะลองเข้าคุมให้อีกครั้ง");
                    setTimeout(() => { if (socket.connected) loginToRoom(id, password); }, 1500);
                    return;
                }
                if (res && res.code === "ROOM_NOT_FOUND") {
                    // ตรวจรายการจาก socket ปัจจุบันอีกครั้งก่อนบอกว่าห้องหาย
                    // เพื่อแยก "รายการในจอค้าง" ออกจาก "instance นี้ยังไม่มีห้องแต่ snapshot ยังอยู่"
                    socket.emit("list_open_rooms", (list) => {
                        const fresh = (list || []).some((r) => String(r.roomId || "").trim().toUpperCase() === id);
                        if (fresh) {
                            wwAlert("ห้องนี้ยังเปิดอยู่ แต่ข้อมูลห้องของจอนี้ยังไม่ตรงกัน กำลังซิงก์ใหม่");
                            setTimeout(() => { if (socket.connected) loginToRoom(id, password); }, 500);
                        } else {
                            wwAlert("ไม่พบห้องนี้ในเซิร์ฟเวอร์แล้ว ห้องอาจถูกปิดไปแล้ว");
                            refreshRoomPicker();
                        }
                    });
                    return;
                }
                const code = String(res?.code || res?.error || "unknown");
                const messages = {
                    ACCOUNT_TOKEN_REQUIRED: "บัญชีโฮสต์ยังไม่มี credential สำหรับเข้าห้อง กรุณากลับหน้าแรกแล้วเข้าสู่บัญชีใหม่",
                    ACCOUNT_AUTH_FAILED: "ยืนยันตัวตนบัญชีโฮสต์ไม่ผ่าน กรุณากลับหน้าแรกแล้วเข้าสู่บัญชีใหม่",
                    ACCOUNT_SUSPENDED: "บัญชีโฮสต์นี้ถูกพักการใช้งาน",
                    ACCOUNT_DELETED: "บัญชีโฮสต์นี้ถูกลบแล้ว กรุณาสร้าง/เข้าสู่บัญชีใหม่",
                    RESET_IN_PROGRESS: "ระบบกำลังล้างข้อมูลอยู่ กรุณาลองใหม่อีกครั้ง",
                };
                wwAlert(messages[code] || ("เข้าคุมห้องไม่สำเร็จ (" + code + ")"));
            }
        );
    } catch (e) {
        hostLoginInFlight = "";
        console.error("[host] loginToRoom failed", e);
        wwAlert("เกิดข้อผิดพลาดขณะเข้าคุมห้อง กรุณาลองใหม่อีกครั้ง");
    }
}


// ดึงรายชื่อห้องที่ยังเปิดอยู่ทั้งหมดมาแสดงในกริดใหม่
function refreshRoomPicker() {
    socket.emit("list_open_rooms", (list) => {
        renderRoomPicker(list || []);
    });
}

// รายการดิบล่าสุดที่ได้จาก server (ไม่ผ่านการกรอง) — เก็บไว้ให้ filterRoomPicker() กรองต่อ
// จากในเครื่องได้เลยโดยไม่ต้องยิง socket ใหม่ทุกครั้งที่พิมพ์ค้นหา
let roomPickerRawList = [];

// กรองกริดตามคำค้นหาปัจจุบัน (โค้ดห้อง หรือชื่อแอดมิน) — เรียกทุกครั้งที่พิมพ์ในช่องค้นหา
// ใช้เฉพาะตอนมีหลายห้อง เพื่อหาห้องที่ต้องการได้เร็วขึ้นแทนไล่สายตาทีละการ์ด
function filterRoomPicker() {
    const input = document.getElementById("roomPickerSearchInput");
    const q = (input && input.value || "").trim().toUpperCase();
    const filtered = !q ? roomPickerRawList : roomPickerRawList.filter((r) =>
        r.roomId.toUpperCase().includes(q) || (r.hostName || "").toUpperCase().includes(q)
    );
    drawRoomPickerGrid(filtered);
    const empty = document.getElementById("roomPickerEmpty");
    if (empty) empty.classList.toggle("hidden", filtered.length > 0 || !q);
}

// วาดกริดห้องที่ยังเปิดอยู่ ให้เลือกเข้าคุม หรือสร้างห้องใหม่ (แยกออกมาจาก renderRoomPicker
// เพื่อให้ filterRoomPicker() เรียกวาดใหม่ได้โดยไม่ต้องเปิด overlay/เคลียร์ช่องค้นหาซ้ำ)
function drawRoomPickerGrid(list) {

    const grid = document.getElementById("roomPickerGrid");
    grid.innerHTML = "";

    list.forEach((r) => {

        const card = document.createElement("div");
        card.className = "roomPickCard";

        // 🔑 ห้องที่ตั้งรหัสผ่านไว้ (กันแอดมินคนอื่นแย่งคุม) — โชว์ไอคอนกุญแจต่อท้ายรหัสห้อง
        const lockIcon = r.hasPassword ? ` <span class="roomPickLock" title="ห้องนี้ล็อกรหัสผ่านไว้">🔑</span>` : "";
        // ถ้ามีผู้คุมอยู่ (hostConnected) และรู้ชื่อผู้คุม ให้โชว์ชื่อผู้คุมแทนข้อความทั่วไป
        const statusText = r.hostConnected
            ? `🟢 ${r.hostName ? escapeHtml(r.hostName) + " กำลังคุมอยู่" : "มีผู้คุมอยู่"}`
            : "🟡 ไม่มีผู้คุมอยู่";

        card.innerHTML = `
            <div class="roomPickCode">${r.roomId}${lockIcon}</div>
            <div class="roomPickMeta">${r.playerCount} ผู้เล่น • ${r.started ? "กำลังเล่น" : "รอเริ่ม"}</div>
            <div class="roomPickStatus">${statusText}</div>
            <button class="btn btn-block">เข้าคุมห้องนี้</button>
        `;

        card.querySelector("button").onclick = () => loginToRoom(r.roomId);

        grid.appendChild(card);
    });

    const newCard = document.createElement("div");
    newCard.className = "roomPickCard roomPickNew";
    newCard.innerHTML = `
        <div class="roomPickCode">+ ห้องใหม่</div>
        <div class="roomPickMeta">เริ่มเกมใหม่ทั้งหมด</div>
        <button class="btn btn-block">สร้างห้องใหม่</button>
    `;
    newCard.querySelector("button").onclick = () => enterSetupMode();
    grid.appendChild(newCard);
}

// เปิด overlay กริดห้อง + เคลียร์ช่องค้นหาเดิม แล้วเก็บ list ดิบไว้ให้ filterRoomPicker() กรองต่อ
function renderRoomPicker(list) {
    roomPickerRawList = list || [];
    const searchInput = document.getElementById("roomPickerSearchInput");
    if (searchInput) searchInput.value = "";
    const empty = document.getElementById("roomPickerEmpty");
    if (empty) empty.classList.add("hidden");
    drawRoomPickerGrid(roomPickerRawList);

    document.getElementById("roomPickerOverlay").classList.remove("hidden");
    document.documentElement.classList.add("modal-open");
}

function hideRoomPicker() {
    document.getElementById("roomPickerOverlay").classList.add("hidden");
    document.documentElement.classList.remove("modal-open");
}

// ตอนเปิดหน้านี้: ขอรายชื่อห้องที่ยังเปิดอยู่ทั้งหมดก่อนเสมอ (ห้องไม่ถูกลบอัตโนมัติแล้ว
// จึงอาจมีหลายห้องค้างอยู่พร้อมกัน) ถ้ามีห้องเดิมที่เคยคุม (จาก localStorage) อยู่ในนั้น
// ให้กลับเข้าคุมอัตโนมัติทันทีโดยไม่ต้องเลือกใหม่ ถ้าไม่มี/ห้องเดิมปิดไปแล้ว แต่ยังมี
// ห้องอื่นเปิดอยู่ (เช่น เปลี่ยนอุปกรณ์ / ล้างเบราว์เซอร์) ให้เลือกจากกริดเอง
// ถ้าไม่มีห้องเปิดอยู่เลยค่อยสร้างห้องใหม่ให้อัตโนมัติ
if (!isTesterMode) bootstrapHostAccount();
const savedHostRoom = initialHostRoomId;

hostAccountReady.then(() => socket.emit("list_open_rooms", (list) => {

    list = list || [];

    if (savedHostRoom && list.some(r => r.roomId === savedHostRoom)) {
        loginToRoom(savedHostRoom);
    } else if (list.length > 0) {
        renderRoomPicker(list);
    } else {
        enterSetupMode(); // ไม่มีห้องเปิดอยู่เลย → ไปหน้าตั้งค่าห้องใหม่ (ยังไม่สร้างห้องจริงจนกว่าจะกด "สร้างห้อง")
    }

}));

// CONNECT — เรียกทั้งตอนเชื่อมต่อครั้งแรก และทุกครั้งที่ socket.io เชื่อมต่อใหม่สำเร็จ
// (เน็ตสะดุด/มือถือล็อกสกรีน/สลับแอปกลับมา) ถ้าเรามีห้องที่คุมอยู่แล้ว ให้ host_login
// ซ้ำด้วย token เดิมทันที เพื่อยืนยันว่าเรายังเป็นผู้คุมห้องนี้อยู่
socket.on("connect", async () => {
    updateHostControlChrome(currentRoom || { started:false, gameOver:false, config: roleConfig, players:[] });
    const livePill = document.getElementById("hostLivePill");
    if (livePill) livePill.classList.add("is-connected");
    const liveText = document.getElementById("hostLiveText");
    if (liveText) liveText.textContent = roomId ? "เชื่อมต่อแล้ว" : "พร้อมตั้งห้อง";
    await bootstrapHostAccount();
    sendHostPresence();
    document.getElementById("connBanner").classList.add("hidden");
    if (roomId) wwHostRelogin(0);
});

// เหตุผลที่ host_login กลับเข้าห้องเดิมไม่ได้ — แยกตาม res.code ที่ server ตอบ ห้ามรวบทุกสาเหตุเป็นข้อความเดียว (โดยเฉพาะห้ามอ้างว่าเป็นเรื่อง "อัปเดต")
// (การอัปเดตเกม/การ deploy ไม่ได้ทำให้ login ไม่ผ่านในตัวมันเอง — ระบบแจ้งอัปเดตอยู่ที่หน้า index เท่านั้น):
//   ROOM_NOT_FOUND  : ไม่มีห้องนี้บน server แล้ว (ปิดห้อง / แอดมินปิดเซิร์ฟเวอร์ / server ยังไม่กู้คืนห้องจาก persistence สำเร็จ)
//   AUTH_FAILED     : รหัสผ่านห้องไม่ตรง (เช่นถูกเปลี่ยนระหว่างที่จอนี้หลุด)   TOO_MANY_ATTEMPTS : ลองผิดหลายครั้ง
//   SERVER_ERROR/ไม่มีคำตอบ : ปัญหาชั่วคราว → "ไม่" ถือว่าห้องหาย ไม่พากลับหน้าเมนู ลองใหม่เงียบๆ
function wwHostLoginFailText(res) {
    switch (res && res.code) {
        case "ROOM_NOT_FOUND": return "🔎 ไม่พบห้องนี้แล้ว (ห้องอาจถูกปิด หรือ server ยังไม่กู้คืนข้อมูลห้องสำเร็จ) ระบบจะพากลับไปหน้าเมนู";
        case "AUTH_FAILED": return "🔒 รหัสผ่านห้องมีการเปลี่ยนแปลง ระบบจะพากลับไปหน้าเมนู";
        case "TOO_MANY_ATTEMPTS": return "⏳ ใส่รหัสผ่านห้องผิดหลายครั้งเกินไป ระบบจะพากลับไปหน้าเมนู";
        default: return "⚠️ เข้าคุมห้องเดิมไม่ได้" + (res && res.error ? " (" + res.error + ")" : "") + " ระบบจะพากลับไปหน้าเมนู";
    }
}

function wwHostRelogin(attempt) {
    const tryRoomId = String(roomId || "").trim().toUpperCase();
    if (!tryRoomId) return;
    socket.emit(
        "host_login",
        { roomId: tryRoomId, token: hostToken, password: getSavedRoomPassword(tryRoomId), ...(isTesterMode ? {} : (window.wwAccount ? window.wwAccount.payload() : {})) },
        (res) => {
            if (res && res.ok) return;

            const transient = !res || res.code === "SERVER_ERROR" || res.code === "ACCOUNT_PERSISTENCE_UNAVAILABLE";
            if (transient && attempt < 5) {
                setTimeout(() => { if (socket.connected && roomId === tryRoomId) wwHostRelogin(attempt + 1); }, 1500 + attempt * 500);
                return;
            }

            if (res && res.code === "ROOM_NOT_FOUND") {
                // ก่อนล้าง room ที่จำไว้ ให้ถาม instance ปัจจุบันอีกครั้ง
                // เพื่อแยกห้องตายจริงออกจาก state/RAM ของ instance นี้ที่ยังไม่ตรงกับ snapshot
                socket.emit("list_open_rooms", (list) => {
                    const fresh = (list || []).some((r) => String(r.roomId || "").trim().toUpperCase() === tryRoomId);
                    if (fresh) {
                        setTimeout(() => { if (socket.connected && roomId === tryRoomId) wwHostRelogin(attempt + 1); }, 500);
                        return;
                    }
                    roomId = "";
                    hostStorage.removeItem("ww_host_room");
                    const toast = document.createElement("div");
                    toast.textContent = wwHostLoginFailText(res);
                    Object.assign(toast.style, {
                        position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)",
                        zIndex: "9999", padding: "12px 24px", borderRadius: "10px",
                        background: "#1f2937", color: "#fff", fontWeight: "600", fontSize: "15px",
                        boxShadow: "0 4px 20px rgba(0,0,0,.4)", pointerEvents: "none"
                    });
                    document.body.appendChild(toast);
                    setTimeout(() => { returnFromHostScreen(); }, 2000);
                });
                return;
            }

            // Auth/account/configuration errors ไม่ใช่หลักฐานว่าห้องถูกลบ — เก็บ ww_host_room ไว้
            // เพื่อให้แก้บัญชีแล้วกลับเข้าห้องเดิมได้ ไม่ทำลาย room identity โดยไม่จำเป็น
            const code = String(res?.code || res?.error || "unknown");
            const authToast = document.createElement("div");
            authToast.textContent = "เข้าคุมห้องไม่สำเร็จ (" + code + ") — ห้องที่จำไว้ยังไม่ถูกลบ";
            Object.assign(authToast.style, {
                position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)",
                zIndex: "9999", padding: "12px 24px", borderRadius: "10px",
                background: "#1f2937", color: "#fff", fontWeight: "600", fontSize: "15px",
                boxShadow: "0 4px 20px rgba(0,0,0,.4)", pointerEvents: "none"
            });
            document.body.appendChild(authToast);
            setTimeout(() => authToast.remove(), 3500);
        }
    );
}


// DISCONNECT — ไม่แสดงแบนเนอร์แจ้งเตือนอีกต่อไป (ดูเหตุผลเดียวกับฝั่ง player.html)
// socket.io จะพยายามเชื่อมต่อใหม่และ auto-rejoin ห้องเดิมด้วย token ให้เองเงียบๆ อยู่แล้ว
socket.on("disconnect", () => {
    const livePill = document.getElementById("hostLivePill");
    if (livePill) livePill.classList.remove("is-connected");
    const liveText = document.getElementById("hostLiveText");
    if (liveText) liveText.textContent = "กำลังเชื่อมต่อใหม่";
    // ไม่แสดงแบนเนอร์ทับพื้นที่เกม — สถานะเล็กบน header ยังบอกได้ว่ากำลังเชื่อมใหม่
});

// VISIBILITY CHANGE — เมื่อสลับกลับมาที่แท็บ/หน้าจอนี้ (สลับแอป/ปลดล็อกสกรีน)
// บังคับเช็ค-ต่อ socket ใหม่ทันที ไม่รอ backoff ของ socket.io เพียงอย่างเดียว
// (สำคัญมากสำหรับโฮสต์ที่ใช้มือถือเครื่องเดียวสลับจอไปมาบ่อย ๆ)
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !socket.connected) {
        socket.connect();
    }
    // แก้บั๊ก "สลับกลับมาแล้วข้อมูลเกม/อาชีพผู้เล่นไม่ครบ": เคสที่ socket ไม่เคยหลุดการเชื่อมต่อเลย
    // (แค่แท็บถูกซ่อน/พับจอไว้) event "connect" ด้านบนจะไม่ทำงาน เพราะไม่ได้ reconnect จริง จึงไม่มี
    // การ host_login ซ้ำ — ขอสถานะล่าสุดทั้งหมดตรงจากเซิร์ฟเวอร์ทุกครั้งที่กลับมาเห็นจอแทน เพื่อให้
    // ข้อมูล (ตำแหน่ง/อาชีพ/สถานะผู้เล่นทุกคน/แชท) ตรงกับความจริงของเซิร์ฟเวอร์เสมอ
    if (document.visibilityState === "visible" && roomId) {
        socket.emit("request_sync", { roomId, token: hostToken });
    }
});

// ROOM CLOSED (โฮสต์กดปิดห้องเอง — ห้องไม่ถูกปิดอัตโนมัติจากการหลุดเน็ตอีกต่อไป)
socket.on("room_closed", (data) => {
    hostBrowserExitServerClosed = true;
    hostBrowserExitGuardState(false, "room_closed");
    closeRequestedFromBack = false;
    if (!creatingFreshRoom) backGuardArmed = false; // ห้องปิดแล้ว กำลังจะกลับหน้าแรก — ไม่ต้องถามซ้ำถ้ากดย้อนกลับช่วงนี้
    hostStorage.removeItem("ww_host_room");
    // รหัสผ่านห้องเดิมที่เคยจำไว้ (ww_room_pass_<roomId>) ใช้ไม่ได้อีกแล้วเพราะห้องถูกลบทิ้งจริง
    // (ไม่ใช่แค่ reconnect ไม่ผ่าน) เคลียร์ทิ้งกันเครื่องนี้แบกรหัสห้องที่ตายไปแล้วไว้เปล่าๆ
    saveRoomPassword(roomId, "");

    // ===== ปุ่ม "🆕 สร้างห้องใหม่": ปิดห้องเดิมแล้วสร้างห้องใหม่ต่อทันทีในหน้านี้เลย =====
    // ไม่ต้องเด้งกลับ index.html เหมือนปุ่ม "✕ ปิดห้อง" ปกติ (createFreshRoom() เซ็ต flag นี้ไว้
    // ก่อนสั่ง close_room เสมอ — ดูฟังก์ชันด้านล่าง)
    if (creatingFreshRoom) {
        creatingFreshRoom = false;
        roomId = "";
        enterSetupMode(); // ปิดห้องเดิมแล้ว → ไปหน้าตั้งค่าห้องใหม่ก่อนสร้างจริง
        return;
    }

    // แสดง toast แทน alert เพื่อไม่ block browser ก่อนเด้งกลับหน้าเลือกโหมด
    const toast = document.createElement("div");
    toast.textContent = (data && data.reason === "host_closed") ? "✓ ปิดห้องเรียบร้อยแล้ว" : "ห้องถูกปิดไปแล้ว";
    Object.assign(toast.style, {
        position: "fixed", top: "20px", left: "50%", transform: "translateX(-50%)",
        zIndex: "9999", padding: "12px 24px", borderRadius: "10px",
        background: "#22c55e", color: "#fff", fontWeight: "600", fontSize: "15px",
        boxShadow: "0 4px 20px rgba(0,0,0,.4)", pointerEvents: "none"
    });
    document.body.appendChild(toast);

    // เด้งกลับไปหน้าเลือกโหมด (index.html) แทนที่จะรีโหลดหน้าโฮสต์เดิม
    // (เดิม reload หน้านี้ตรง ๆ จะไปเจอ logic สร้างห้องใหม่อัตโนมัติทันที เพราะไม่มีห้องเปิดอยู่แล้ว)
    // กลับไปกด "สร้างห้อง" อีกทีจะเข้าห้องใหม่ได้ทันที (ไม่มีรหัสผ่านให้ใส่แล้ว)
    setTimeout(() => { returnFromHostScreen(); }, 800);
});

// ปุ่ม "สรุปผลรอบนี้" — ประมวลผลกลางคืนฝั่งเซิร์ฟเวอร์
function resolveNight() {
    if (!roomId) return;
    socket.emit("resolve_night", roomId);
}

// ปุ่ม "เริ่มช่วงกลางคืน" — ล้าง silenced, แจ้งเริ่มคืน, ปิดแชทรวม
function startNight() {
    if (!roomId) return;
    socket.emit("start_night", roomId);
}

// ปุ่ม "ปิดห้อง" — ให้โฮสต์ปิดห้องเองได้ตรงๆ แทนที่จะต้องพึ่งการตรวจจับการหลุดของเน็ต
async function closeRoomManually() {
    if (!roomId) return;

    const ok = await wwConfirm("ต้องการปิดห้องนี้เลยหรือไม่? ผู้เล่นทุกคนในห้องจะถูกเตะออกทันที และย้อนกลับไม่ได้");
    if (!ok) return;

    hostAllowIntentionalExit("close_room_button");
    socket.emit("close_room", roomId);
}

// ปุ่ม "🆕 สร้างห้องใหม่" — ปิดห้องเดิมทิ้ง แล้วสร้างห้องใหม่ต่อทันทีในหน้าเดียวกัน ไม่ต้องรีโหลด/
// เด้งกลับหน้า index.html เหมือนปุ่ม "✕ ปิดห้อง" ปกติ (ดู room_closed ด้านบน — เซ็ต flag ไว้ก่อนเสมอ
// เพื่อให้ room_closed รู้ว่าต้องสร้างห้องใหม่ต่อทันที ไม่ใช่แค่ปิดห้องเฉยๆ)
let creatingFreshRoom = false;
async function createFreshRoom() {
    if (!roomId) return;

    const ok = await wwConfirm("ปิดห้องนี้แล้วสร้างห้องใหม่เลยหรือไม่? ผู้เล่นทุกคนในห้องเดิมจะถูกเตะออกทันที และย้อนกลับไม่ได้");
    if (!ok) return;

    hostAllowIntentionalExit("create_fresh_room");
    creatingFreshRoom = true;
    socket.emit("close_room", roomId);
}

// ROOM UPDATE (SOURCE OF TRUTH)
// แอดมิน (หน้า admin.html) แก้ชื่อ "โฮสต์" ของเรา — จำชื่อใหม่นี้ไว้เป็นชื่อถาวรของเครื่องนี้ต่อ
// (ครั้งหน้าที่สร้าง/เข้าคุมห้อง จะใช้ชื่อนี้ ไม่ใช่ชื่อเดิมที่เคยตั้งเอง)
socket.on("name_updated_by_host", (data) => {
    if (!data || !data.name) return;
    hostStorage.setItem("ww_host_display_name", data.name);
    sendHostPresence();
});

socket.on("room_update", (room) => {

    currentRoom = room;
    if (document.getElementById("roomSettingsOverlay") && !document.getElementById("roomSettingsOverlay").classList.contains("hidden")) {
        renderRoomRevealDeadRole();
    }

    // เกมเพิ่งเริ่มใหม่ (justStarted) หรือโฮสต์กด "🔄 เริ่มต้นใหม่" (justReset) → เคลียร์กล่องแชทเก่าทิ้ง
    // เซิร์ฟเวอร์ติดธงนี้ไว้แค่ room_update รอบเดียวตอนเหตุการณ์เกิดขึ้นจริง (ดู start_game/restart_room
    // ฝั่ง server.js) — ทำที่นี่แทนที่จะพึ่งแค่การเคลียร์เฉพาะจอที่กดปุ่มเอง (เช่นใน startGame()/
    // restartRoom() ด้านล่าง) เพราะห้องนี้รองรับ "จอโฮสต์หลายจอพร้อมกัน" ได้ (ดู addHostSocket) จออื่นที่
    // ไม่ได้กดปุ่มแต่เปิดค้างอยู่ก็ต้องเห็นกล่องแชทว่างทันทีเหมือนกัน ไม่ใช่แค่จอที่กดเอง — แก้บั๊ก: เดิมจอ
    // โฮสต์อื่น (ที่ไม่ได้กดปุ่ม) และกรณี "เริ่มต้นใหม่" (restart_room ไม่มีการเคลียร์กล่องแชทฝั่ง client เลย)
    // จะยังเห็นข้อความของเกมที่แล้วค้างอยู่ในกล่องแชท แม้ข้อมูลฝั่งเซิร์ฟเวอร์จะถูกล้างไปแล้วก็ตาม
    if (room.justStarted || room.justReset) {
        document.getElementById("chatBoxGlobal").innerHTML = "";
        document.getElementById("chatBoxWolf").innerHTML = "";
        hostBadgeCounts = { global: 0, wolf: 0 };
        document.getElementById("badgeGlobal").textContent = "0";
        document.getElementById("badgeWolf").textContent = "0";
    }

    // ===== RESTORE roleConfig จาก room.config (กรณีโฮสต์กลับเข้ามาใหม่/เน็ตหลุด) =====
    // room.config คือ source of truth บนเซิร์ฟเวอร์ — sync กลับมาที่ client ทุกครั้งที่รับ room_update
    // เพื่อให้หน้าการ์ด "ตั้งค่าบทบาท" แสดงผลตรงกับที่ตั้งไว้จริง แม้โหลดหน้าใหม่หรือกลับมาจากการหลุด
    if (room.config && typeof room.config === "object") {
        // ตรวจว่า config เปลี่ยนจริงๆ ก่อน re-render (ใช้ key count + ค่าแต่ละ key แทน JSON.stringify)
        const configKeys = Object.keys(room.config);
        const localKeys = Object.keys(roleConfig);
        const configChanged = configKeys.length !== localKeys.length ||
            configKeys.some(k => roleConfig[k] !== room.config[k]);
        if (configChanged) {
            Object.keys(roleConfig).forEach(k => delete roleConfig[k]);
            Object.assign(roleConfig, room.config);
            renderRoles();
        }
    }

    updateNightFlowButtons(room);

    if (isTesterMode) {
        renderBotList(room);
        renderBotAIMasterRow(room);
    }

    // อัปเดตจำนวนผู้เล่นข้างจำนวนการ์ด แม้ config จะไม่เปลี่ยนก็ตาม (เช่น มีคนเข้า/ออกห้อง)
    const rolePlayerCountEl = document.getElementById("rolePlayerCount");
    if (rolePlayerCountEl) {
        rolePlayerCountEl.innerText = (room.players || []).filter(p => !p.isHost).length;
    }

    const list = document.getElementById("list");

    const nonHostPlayers = room.players.filter(p => !p.isHost);

    if (nonHostPlayers.length === 0) {
        list.innerHTML = `<div class="empty-note">ยังไม่มีผู้เล่นเข้าร่วมห้องนี้</div>`;
    } else {

        // เคลียร์ empty-note ค้าง (ถ้ามี) ก่อน sync ของจริง
        if (list.querySelector(".empty-note")) {
            list.innerHTML = "";
        }

        // เก็บการ์ดผู้เล่นเดิมไว้ใช้ซ้ำ แทนรื้อสร้างใหม่ทั้งลิสต์ทุกครั้งที่ติ๊กสถานะ
        // (เดิมพอติ๊กคนใดคนหนึ่ง การ์ดของผู้เล่น "ทุกคน" จะถูกรื้อสร้างใหม่หมด ทำให้กระตุก)
        const existingCards = {};
        list.querySelectorAll(".player[data-id]").forEach((node) => {
            existingCards[node.dataset.id] = node;
        });
        const seenIds = new Set();

        const aimedTargetIds = getAimedTargetIds(room);
        const silenceAimIds = getSilenceAimIds(room);
        const protectAimIds = getProtectAimIds(room);

        nonHostPlayers.forEach((p, idx) => {
            seenIds.add(p.id);

            let div = existingCards[p.id];
            if (!div) {
                div = document.createElement("div");
                div.setAttribute("data-id", p.id);
            }

            // ตัดการแสดงสถานะ disconnected/offline ออกจาก UI ฝั่งโฮสต์เช่นกัน — ดูข้อมูลจริงยังอยู่
            // ฝั่ง server เหมือนเดิม แค่ไม่เอามาโชว์/ไม่เอามาบล็อกอะไรในหน้าจอแล้ว
            div.className = "player " + (!p.alive ? "dead" : "");
            div.dataset.name = (p.name || "").toLowerCase();
            div.dataset.alive = p.alive ? "1" : "0";

            const newHTML = `
                <div class="player-inner">
                <div class="ptop">
                    <div>
                        <div class="pname">${escapeHtml(p.name)}</div>
                        ${p.isBot ? getBotControlBadgeHTML(p, room) : ""}
                    </div>
                    <div class="pactions">
                        <span class="prole${p.isBot ? " prole-bot-clickable" : ""}" title="${p.isBot ? "🤖 บอท — แตะไอคอนอาชีพเพื่อเข้าสิง" : (p.role || "ยังไม่ได้รับบท")}" ${p.isBot ? `onclick="possessBot('${p.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();possessBot('${p.id}');}"` : ""}>
                            ${
                                p.role
                                ? `<img class="prole-icon" src="${getRoleIcon(p.role)}" alt="${p.role}" onerror="this.style.display='none'">`
                                : "?"
                            }
                        </span>
                        <button class="kick-btn" onclick="kickPlayer('${p.id}')">⛔</button>
                    </div>
                </div>

                ${
                    p.displayRole && p.displayRole !== p.role
                    ? `
                        <div class="randomRole">สุ่มจาก: ${p.displayRole}</div>
                        <div class="realRole">บทจริง: ${p.role}</div>
                    `
                    : ""
                }

                ${
                    p.huntTarget
                    ? `<div class="huntInfo">🎯 เป้าหมาย: ${p.huntTarget}</div>`
                    : ""
                }

                ${
                    (p.role === "หมาป่าผู้พิทักษ์" || p.role === "หนูน้อยผู้ใสซื่อ")
                    ? `<div class="huntInfo">${p.role === "หนูน้อยผู้ใสซื่อ" ? "🌼" : "🛡️"} โล่เหลือ: ${p.guardianShieldAvailable ?? 0}</div>`
                    : ""
                }

                ${
                    p.role === "ศาลเตี้ย"
                    ? `<div class="huntInfo">🔫 กระสุนเหลือ: ${p.sheriffBullets ?? 0} · 📣 ดูบทเหลือ: ${p.sheriffPeeks ?? 0}${p.sheriffUsedToday ? " (ใช้ความสามารถวันนี้ไปแล้ว)" : ""}</div>`
                    : ""
                }

                ${
                    p.role === "แม่มด"
                    ? `<div class="huntInfo">🧪 ยาป้องกันเหลือ: ${p.witchProtectPotions ?? 0} · ☠️ ยาพิษเหลือ: ${p.witchPoisonPotions ?? 0}${p.witchPoisonPending ? " (เลือกเป้าโยนยาพิษไว้แล้ว รอสรุปผลกลางคืน)" : ""}</div>`
                    : ""
                }

                ${
                    p.role === "นักบวช"
                    ? `<div class="huntInfo">🫙 น้ำมนต์เหลือ: ${p.priestHolyWaterPotions ?? 0}</div>`
                    : ""
                }

                ${
                    p.role === "นักเล่นกล"
                    ? (() => {
                        const disguised = (p.illusionTargetIds || [])
                            .map((tid) => room.players.find((x) => x.id === tid))
                            .filter((x) => x && x.alive)
                            .map((x) => x.name);
                        return `<div class="huntInfo">🎭 ปลอมบทไว้: ${disguised.length > 0 ? disguised.join(", ") : "ยังไม่มี"}</div>`;
                    })()
                    : ""
                }

                ${
                    (p.role === "หมาป่าหยั่งรู้" || p.role === "ผู้มีลาง" || p.role === "ผู้หยั่งรู้")
                    ? `<div class="huntInfo">🔮 ส่องล่าสุด: ${p.lastScoutTargetName || "-"}${p.scoutedThisNight ? " (คืนนี้ส่องแล้ว)" : ""}</div>`
                    : ""
                }

                ${
                    p.role === "นักสืบ"
                    ? `<div class="huntInfo">🕵️ เทียบล่าสุด: ${p.lastDetectiveScoutText || "-"}${p.detectiveScoutedThisNight ? " (คืนนี้ส่องแล้ว)" : ""}</div>`
                    : ""
                }

                ${
                    p.role === "กามเทพ"
                    ? `<div class="huntInfo">💖 จับคู่: ${p.lastCupidPairText || "-"}${p.cupidPaired ? " (ใช้สิทธิ์จับคู่ไปแล้ว)" : " (ยังไม่จับคู่)"}</div>`
                    : ""
                }

                ${
                    p.loverId
                    ? `<div class="huntInfo">💘 คู่รักกับ: ${room.players.find((x) => x.id === p.loverId)?.name || "-"}</div>`
                    : ""
                }

                ${
                    p.role === "ผู้ยุยง"
                    ? `<div class="huntInfo">🎭 จับคู่ผู้ศรัทธา: ${p.lastInstigatorPairText || "-"}${p.instigatorPaired ? " (จับคู่แล้ว)" : " (ยังไม่จับคู่)"}${instigatorBothBelieversDead(room, p) ? ` <span style="color:#f472b6;">— ผู้ศรัทธาตายครบแล้ว ปลดล็อกสิทธิ์ฆ่าเอง 1 คน/คืน</span>` : ""}</div>`
                    : ""
                }

                ${
                    p.instigatorLinkId
                    ? `<div class="huntInfo">🎭 ถูกผู้ยุยงจับคู่กับ: ${room.players.find((x) => x.id === p.instigatorLinkId)?.name || "-"}</div>`
                    : ""
                }

                ${
                    p.role === "ผู้นำลัทธิ"
                    ? (() => {
                        const members = room.players.filter((x) => x.alive && !x.isHost && x.cultLeaderId === p.id);
                        const pending = (room.cultActions || {})[p.id];
                        const pendingText = pending
                            ? pending.mode === "recruit"
                                ? `กำลังเลือกชักชวน: ${room.players.find((x) => x.id === pending.targetId)?.name || "-"}`
                                : `กำลังเลือกสังเวย: ${room.players.find((x) => x.id === pending.sacrificeId)?.name || "-"} → ฆ่า ${room.players.find((x) => x.id === pending.targetId)?.name || "-"}`
                            : "ยังไม่ได้เลือกคืนนี้";
                        return `<div class="huntInfo">🔯 สมาชิกลัทธิ (${members.length}/5): ${members.map((m) => m.name).join(", ") || "-"}${room.isNight ? ` · ${pendingText}` : ""}</div>`;
                    })()
                    : ""
                }

                ${
                    p.cultLeaderId
                    ? `<div class="huntInfo">🔯 อยู่ในลัทธิของ: ${room.players.find((x) => x.id === p.cultLeaderId)?.name || "-"}</div>`
                    : ""
                }

                ${
                    p.role === "โจร"
                    ? (() => {
                        const accomplice = room.players.find((x) => x.alive && !x.isHost && x.role === "ผู้สมรู้ร่วมคิด" && x.banditLeaderId === p.id);
                        let pendingText;
                        if (accomplice) {
                            const killTarget = (room.banditKillVotes || {})[p.id];
                            pendingText = killTarget
                                ? `กำลังเลือกฆ่าร่วม: ${room.players.find((x) => x.id === killTarget)?.name || "-"}`
                                : "ยังไม่ได้เลือกฆ่าคืนนี้";
                        } else {
                            const recruit = (room.banditActions || {})[p.id];
                            pendingText = recruit
                                ? `กำลังเลือกเปลี่ยนบทบาท: ${room.players.find((x) => x.id === recruit.targetId)?.name || "-"}`
                                : "ยังไม่ได้เลือกคืนนี้";
                        }
                        return `<div class="huntInfo">🗡️ ผู้สมรู้ร่วมคิด: ${accomplice ? accomplice.name : "ยังไม่มี"}${room.isNight ? ` · ${pendingText}` : ""}</div>`;
                    })()
                    : ""
                }

                ${
                    p.role === "ผู้สมรู้ร่วมคิด" && p.banditLeaderId
                    ? (() => {
                        const killTarget = (room.banditKillVotes || {})[p.id];
                        const pendingText = room.isNight
                            ? (killTarget ? ` · กำลังเลือกฆ่าร่วม: ${room.players.find((x) => x.id === killTarget)?.name || "-"}` : " · ยังไม่ได้เลือกฆ่าคืนนี้")
                            : "";
                        return `<div class="huntInfo">🗡️ หัวโจร: ${room.players.find((x) => x.id === p.banditLeaderId)?.name || "-"}${pendingText}</div>`;
                    })()
                    : ""
                }

                <div class="selectionInfo" id="sel-${p.id}">
                    ยังไม่เลือก
                </div>

                <div class="toggles">

                    <label class="toggle" title="มีชีวิต">
                        <input type="checkbox"
                            onchange="toggle('${p.id}','alive', this.checked)"
                            ${p.alive ? "checked" : ""}
                        >
                        <span class="toggle-icon" aria-hidden="true">❤️</span>
                        <span class="toggle-label">มีชีวิต</span>
                    </label>

                    <label class="toggle${(p.protected || protectAimIds.has(p.id)) ? " toggle-aimed-protect" : ""}" title="${protectAimIds.has(p.id) ? "กำลังถูกหมอ/บอดี้การ์ด/แม่มด/อันธพาลเลือกปกป้องอยู่ตอนนี้ (ยังไม่สรุปผล)" : "ปกป้อง"}">
                        <input type="checkbox"
                            onchange="toggle('${p.id}','protected', this.checked)"
                            ${p.protected ? "checked" : ""}
                        >
                        <span class="toggle-icon" aria-hidden="true">🛡️</span>
                        <span class="toggle-label">ปกป้อง</span>
                    </label>

                    ${(() => {
                        // สีของช่อง "เล็งฆ่า" เปลี่ยนตาม "อาชีพ" ที่กำลังเล็งอยู่ ให้โฮสต์แยกออกได้ทันทีว่าใครเล็ง
                        // (ไม่มีข้อมูลแหล่งที่มา เช่นกรณี p.killed ที่สรุปผลแล้ว ใช้สีแดงเดิม toggle-aimed เป็นค่าเริ่มต้น)
                        const aimRoleKey = aimedTargetIds.get(p.id); // undefined ถ้าไม่ได้ถูกเล็งแบบเรียลไทม์
                        const isAimed = p.killed || aimedTargetIds.has(p.id);
                        const aimClass = aimRoleKey ? ` toggle-aimed toggle-aimed-${aimRoleKey}` : (isAimed ? " toggle-aimed" : "");
                        const aimTitle = aimRoleKey
                            ? `กำลังถูก${AIM_SOURCE_LABELS[aimRoleKey] || "?"}เล็งฆ่าอยู่ตอนนี้ (ยังไม่สรุปผล)`
                            : "เล็งฆ่า";
                        return `
                    <label class="toggle${aimClass}" title="${aimTitle}">
                        <input type="checkbox"
                            onchange="handleKillToggle('${p.id}', this.checked, this)"
                            ${isAimed ? "checked" : ""}
                        >
                        <span class="toggle-icon" aria-hidden="true">🎯</span>
                        <span class="toggle-label">เล็งฆ่า</span>
                    </label>`;
                    })()}

                    <label class="toggle${(p.silenced || silenceAimIds.has(p.id)) ? " toggle-aimed-hint" : ""}" title="${silenceAimIds.has(p.id) ? "กำลังถูกยายขี้โมโหเลือกใบ้อยู่ตอนนี้ (ยังไม่ใบ้จริง รอสรุปผลตอนเช้า)" : "ใบ้"}">
                        <input type="checkbox"
                            onchange="toggle('${p.id}','silenced', this.checked)"
                            ${(p.silenced || silenceAimIds.has(p.id)) ? "checked" : ""}
                        >
                        <span class="toggle-icon" aria-hidden="true">🤐</span>
                        <span class="toggle-label">ใบ้</span>
                    </label>

                </div>

                </div>

            `;

            // อัปเดต DOM เฉพาะการ์ดที่ข้อมูลเปลี่ยนจริงๆ การ์ดคนอื่นที่ไม่เปลี่ยนจะไม่ถูกแตะเลย
            // ถ้าต้องอัปเดตการ์ด ให้รักษา <img class="prole-icon"> node เดิมไว้ด้วย เพื่อไม่ให้รูปอาชีพ
            // ถูกถอด/สร้างใหม่ทุก room_update
            if (div.innerHTML !== newHTML) {
                const oldRoleImage = div.querySelector(".prole-icon");
                const holder = document.createElement("div");
                holder.innerHTML = newHTML;
                const nextRoleImage = holder.querySelector(".prole-icon");
                div.innerHTML = newHTML;
                preserveExistingRoleImage(div, ".prole-icon", oldRoleImage, nextRoleImage);
            }

            if (list.children[idx] !== div) {
                list.insertBefore(div, list.children[idx] || null);
            }
        });

        // ลบการ์ดของผู้เล่นที่ไม่อยู่ในห้องแล้ว (หลุดห้อง/ตัดการเชื่อมต่อ)
        Object.keys(existingCards).forEach((id) => {
            if (!seenIds.has(id)) {
                existingCards[id].remove();
            }
        });
    }

    // className ของการ์ดผู้เล่นถูกเขียนทับใหม่ทุกครั้งด้านบน (รวมถึง search-hidden
    // ที่ใส่ไว้ก่อนหน้า) จึงต้องเรียกซ้ำตรงนี้เพื่อให้ผลค้นหา/ตัวกรองที่โฮสต์ตั้งไว้ยังคงอยู่
    renderSimplePlayerList(room, nonHostPlayers);
    filterPlayerList();

    // แก้บั๊ก: เดิม repeat(N, 1fr) บังคับ N คอลัมน์เสมอไม่ว่าห้องจะมีผู้เล่นกี่คน — พอมีแค่ 1-2 คน
    // (เช่น ห้องเทส/บอทตัวเดียว) การ์ดถูกบีบให้กว้างแค่ 1/N ของพื้นที่ทั้งหมด ที่เหลือว่างเปล่า
    // และตัวหนังสือในการ์ดก็เล็กจนอ่านไม่ออกไปด้วย (font-size ผูกกับความกว้างการ์ดจริงผ่าน cqi)
    // ตอนนี้ reapply คอลัมน์ทุกครั้งที่รายชื่อผู้เล่นอัปเดต โดยไม่ให้เกินจำนวนผู้เล่นจริง
    if (typeof applyGridCols === "function" && typeof currentGridBreakpoint !== "undefined") {
        applyGridCols(currentGridBreakpoint ? gridColsByBreakpoint[currentGridBreakpoint] : null);
    }


    // reset UI
    document.querySelectorAll(".selectionInfo").forEach(el => {
        el.innerText = "ยังไม่เลือก";
    });

    // แก้ตามคำขอ: เอาการแสดง "📍 เลือก: ..." บนการ์ดผู้เล่นออกทั้งหมด ไม่ว่าอาชีพไหนก็ตาม
    // (หมอ/บอดี้การ์ด/ยายขี้โมโห/ลูกหมาป่า/แม่มด(ยาป้องกัน) ฯลฯ — ทุกอาชีพที่ใช้กลไก select_target ปกติ)
    // — ยังคงเก็บ room.selectedTargets ไว้ทำงานตามปกติเบื้องหลังทุกอย่าง (โฮสต์ resolve_night/สรุปผลใช้
    // ค่าจริงจาก room.selectedTargets เหมือนเดิมทุกประการ) แค่ "ไม่อัปเดตข้อความบนการ์ด" ให้เห็นอีกต่อไป
    // เท่านั้น กล่อง .selectionInfo จะค้างที่ "ยังไม่เลือก" (ค่าเริ่มต้นจาก reset ด้านบน) เสมอ — ไม่กระทบ
    // การแสดง "🎯 เล็งฆ่า: ..." ของหมาป่า/ฆาตกรต่อเนื่องด้านล่าง ซึ่งเป็นคนละกลไก ไม่ได้อยู่ในคำขอนี้
    // (เดิมมี const selectedTargets = room.selectedTargets || {}; Object.entries(selectedTargets)
    //  .forEach(...) เขียน box.innerText = "📍 เลือก: ..." ตรงนี้ — ตัดออกทั้งบล็อกแล้ว)

    // ===== เล็งฆ่าของหมาป่า/ฆาตกรต่อเนื่อง — โชว์ตรงการ์ดผู้เล่นในกริดหลักด้วย (ไม่ใช่แค่ในป๊อปอัป) =====
    // หมาป่า/ฆาตกรต่อเนื่องเก็บเป้าไว้คนละที่ (room.wolfKillVotes / room.murdererKillVote) ไม่ได้อยู่ใน selectedTargets
    // เลยต้อง merge เข้ากับ selectionInfo ของการ์ดตัวเองด้วย ให้โฮสต์เห็นเป้าเล็งฆ่าแบบเรียลไทม์ทันทีที่มองกริดหลัก
    const wolfKillVotesForCard = room.wolfKillVotes || {};
    Object.entries(wolfKillVotesForCard).forEach(([fromId, targetId]) => {
        const targetPlayer = room.players.find(p => p.id === targetId);
        const box = document.getElementById(`sel-${fromId}`);
        if (box) {
            box.innerText = `🎯 เล็งฆ่า: ${targetPlayer ? targetPlayer.name : "?"}`;
        }
    });
    if (room.murdererKillVote && room.murdererKillVote.voterId) {
        const mTarget = room.players.find(p => p.id === room.murdererKillVote.targetId);
        const mBox = document.getElementById(`sel-${room.murdererKillVote.voterId}`);
        if (mBox) {
            mBox.innerText = `🎯 เล็งฆ่า: ${mTarget ? mTarget.name : "?"}`;
        }
    }
    if (room.instigatorKillVote && room.instigatorKillVote.voterId) {
        const iTarget = room.players.find(p => p.id === room.instigatorKillVote.targetId);
        const iBox = document.getElementById(`sel-${room.instigatorKillVote.voterId}`);
        if (iBox) {
            iBox.innerText = `🎯 เล็งฆ่า: ${iTarget ? iTarget.name : "?"}`;
        }
    }

    // ===== VOTE MODE POPUP =====
    // แสดงผลแยกเป็นป๊อปอัปต่างหาก ไม่ปนกับกริดผู้เล่นหลัก เพื่อให้กริดดูสะอาดเห็นภาพรวมง่าย
    // ป๊อปอัป "ใครเล็งฆ่าใคร" ของหมาป่า/ฆาตกรต่อเนื่องถูกลบออกไปแล้ว — ตอนนี้ดูเป้าเล็งฆ่าได้จากช่องติ๊ก "เล็งฆ่า"
    // ที่ไฮไลต์อัตโนมัติตรงการ์ดผู้เล่นในกริดหลักแทน (ดู getAimedTargetIds ด้านบน)
    const wasVoteMode = voteMode;
    voteMode = !!room.voteMode;

    const voteBtn = document.getElementById("voteBtn");
    if (voteMode) {
        voteBtn.textContent = "🛑 ปิดโหมดโหวต";
        voteBtn.classList.add("active");
    } else {
        voteBtn.textContent = "🗳️ เปิดโหมดโหวต";
        voteBtn.classList.remove("active");
    }

    // โหมดเพิ่งถูกเปิด (จากปิด -> เปิด) ให้เด้งป๊อปอัปขึ้นอัตโนมัติ และล้างสถานะ "ปิดเองไว้ก่อนหน้า"
    const modeJustTurnedOn = (voteMode && !wasVoteMode);
    if (modeJustTurnedOn) {
        modePopupManuallyClosed = false;
    }

    if (voteMode) {
        renderVotePopup(room, nonHostPlayers);
    } else {
        // ไม่มีโหมดไหนเปิดอยู่ -> ปิดป๊อปอัปและซ่อนปุ่มเปิดซ้ำ
        hideModePopup();
    }

    const reopenBtn = document.getElementById("reopenPopupBtn");
    if (reopenBtn) {
        const overlay = document.getElementById("modePopupOverlay");
        const popupOpen = overlay && !overlay.classList.contains("hidden");
        const anyModeActive = voteMode;
        reopenBtn.classList.toggle("hidden", !anyModeActive || popupOpen);
    }

    // ===== TESTER MODE BUTTON =====
    const testerBtn = document.getElementById("testerModeBtn");
    if (testerBtn) {
        const tc = room.testerConditions || {};
        const anyOff = Object.values(tc).some(v => v === false);
        testerBtn.classList.toggle("active", anyOff);
        testerBtn.textContent = anyOff ? "⚙️ ปรับเงื่อนไขจบเกม: ปิดอยู่บางข้อ" : "⚙️ ปรับเงื่อนไขจบเกม";
    }
    renderTesterConditions(room);
    renderTesterVoteTimerRow(room);

    // ===== GAME OVER SUMMARY =====
    renderGameOver(room, nonHostPlayers);

});

const winConditionDefs = [
    { key: "fool", label: "คนบ้าชนะ", sub: "เงื่อนไข 1 — ทุกคนโหวตประหารคนบ้า" },
    { key: "headhunter", label: "นักล่าหัวชนะ", sub: "เงื่อนไข 2 — โหวตประหารเป้าของนักล่าหัว" },
    { key: "wolf", label: "หมาป่าชนะ", sub: "เงื่อนไข 3 — หมาป่าครบจำนวนเทียบชาวบ้าน" },
    { key: "murderer", label: "ฆาตกรต่อเนื่องชนะ", sub: "เงื่อนไข 4 — เหลือฆาตกรต่อเนื่องคนเดียวรอด" },
    { key: "illusionist", label: "นักเล่นกลชนะ", sub: "เงื่อนไข 4 — เหลือนักเล่นกลคนเดียวรอด" },
    { key: "villager", label: "ชาวบ้านชนะ", sub: "เงื่อนไขเสริม — หมาป่าตายหมด/ไม่มีฆาตกรต่อเนื่อง/นักเล่นกลคุกคามแล้ว" },
    { key: "lovers", label: "คู่รักชนะ", sub: "เงื่อนไขพิเศษ — เหลือรอดแค่คู่รัก 2 คน (หรือ + กามเทพ)" },
    { key: "instigators", label: "ผู้ยุยงชนะ", sub: "เงื่อนไขพิเศษ — เหลือรอดแค่คู่ที่ถูกจับ 2 คน (หรือ + ผู้ยุยง)" }
];

function renderTesterConditions(room) {
    const list = document.getElementById("testerConditionList");
    if (!list) return;

    const tc = room.testerConditions || {};

    list.innerHTML = winConditionDefs.map(def => {
        const on = tc[def.key] !== false;
        return `
            <div class="testerConditionRow">
                <div>
                    <div class="tcLabel">${def.label}</div>
                    <div class="tcSub">${def.sub}</div>
                </div>
                <div class="tcToggle ${on ? "on" : ""}" onclick="toggleWinCondition('${def.key}')"></div>
            </div>
        `;
    }).join("");
}

// เปิด/ปิดการนับเวลาถอยหลังของโหมดโหวต (โหมดผู้ทดสอบ) — เปลี่ยนได้ทั้งก่อนเปิดโหวตและระหว่างเปิดโหวตอยู่
// server เป็นคนตัดสิน/กันบั๊กให้ทั้งหมด ฝั่งนี้แค่วาด toggle ตามค่า room.voteTimerEnabled
function renderTesterVoteTimerRow(room) {
    const wrap = document.getElementById("testerVoteTimerRow");
    if (!wrap) return;

    const on = room.voteTimerEnabled !== false;
    wrap.innerHTML = `
        <div class="testerConditionRow">
            <div>
                <div class="tcLabel">นับเวลาถอยหลังอัตโนมัติ</div>
                <div class="tcSub">${on ? "เปิดอยู่ — โหวตจะปิดเองเมื่อหมดเวลา" : "ปิดอยู่ — โหวตจะไม่หมดเวลาเอง ต้องกดปิดโหวตเอง"}</div>
            </div>
            <div class="tcToggle ${on ? "on" : ""}" onclick="toggleVoteTimer()"></div>
        </div>
    `;
}

function toggleVoteTimer() {
    if (!roomId) return;
    socket.emit("toggle_vote_timer", { roomId });
}

// ปุ่ม "ปิดเงื่อนไขการชนะทั้งหมด" — ปิดเงื่อนไขจบเกมทั้ง 5 ข้อทีเดียวในคลิกเดียว แทนไล่กดทีละข้อ
function setAllWinConditions(enabled) {
    if (!roomId) return;
    socket.emit("set_all_win_conditions", { roomId, enabled });
}

// ป๊อปอัปจัดการบอท — แยกออกมาจากป๊อปอัป "ปรับเงื่อนไขจบเกม" (testerOverlay) เป็นป๊อปอัปของตัวเองต่างหาก
// ทำงานแบบเดียวกับ openTesterPopup/closeTesterPopup เป๊ะๆ แค่คุมคนละ overlay id
function openBotManagerPopup() {
    document.getElementById("botManagerOverlay").classList.remove("hidden");
    document.documentElement.classList.add("modal-open");
    if (currentRoom) {
        renderBotList(currentRoom);
        renderBotAIMasterRow(currentRoom);
    }
}
function closeBotManagerPopup() {
    document.getElementById("botManagerOverlay").classList.add("hidden");
    document.documentElement.classList.remove("modal-open");
}

function openTesterPopup() {
    document.getElementById("testerOverlay").classList.remove("hidden");
    document.documentElement.classList.add("modal-open");
}

function closeTesterPopup() {
    document.getElementById("testerOverlay").classList.add("hidden");
    document.documentElement.classList.remove("modal-open");
}

// ป๊อปอัป "⚙️ ตั้งค่าห้อง" — ตั้ง/เปลี่ยนรหัสผ่านห้อง (กันแอดมินคนอื่นแย่งคุม) + รหัสห้องฝั่งผู้เล่น
// + จำนวนผู้เล่นสูงสุด (ไม่มีช่องแก้ "ชื่อแอดมิน" แล้ว — ย้ายไปตั้งที่หน้าแรก index.html แทน)
// เปิดได้เฉพาะตอนคุมห้องอยู่แล้วเท่านั้น (ปุ่มนี้อยู่ในหน้าห้องอยู่แล้ว จึงมี roomId เสมอ)
function openRoomSettings() {
    if (!roomId) return;
    document.getElementById("roomSettingsStatus").textContent = "";
    // server ไม่ส่งรหัสผ่านจริงกลับมาให้ (ดู publicRoomView) แต่ถ้าเครื่องนี้เคยตั้ง/เคยใส่รหัสถูก
    // มาก่อนแล้ว เราจำไว้ในเครื่องนี้อยู่แล้ว (roomPassKey) — เอามาโชว์ในช่องกรอกเลย จะได้เห็นรหัส
    // ที่ตั้งไว้จริงๆ แทนที่จะเจอช่องว่างทุกครั้งที่เข้าห้องใหม่/เปิดป๊อปอัปนี้ซ้ำ
    // ถ้าเครื่องนี้ไม่รู้รหัส (ห้องล็อกไว้แต่เครื่องนี้ไม่เคยตั้ง/ไม่เคยใส่ถูก) ก็ยังเว้นว่างเหมือนเดิม
    const savedPass = getSavedRoomPassword(roomId);
    const passInput = document.getElementById("roomSettingsPassInput");
    passInput.value = savedPass;
    // จำค่าตอน "เปิด" ป๊อปอัปไว้ เพื่อใช้เทียบตอนกด "บันทึก" — ถ้าเครื่องนี้ไม่รู้รหัส (savedPass ว่าง)
    // แล้วผู้ใช้ไม่ได้แตะช่องนี้เลย ต้อง "ไม่ส่งรหัสไปแก้" ไม่งั้นจะกลายเป็นลบรหัสห้องทิ้งโดยไม่ตั้งใจ
    // (เผลอกด "บันทึก" แค่จะแก้ชื่อ แต่ดันไปลบรหัสห้องที่เครื่องอื่นตั้งไว้ ทำให้ข้อมูลแต่ละเครื่องไม่ตรงกัน)
    passInput.dataset.initial = savedPass;
    passInput.placeholder = currentRoom && currentRoom.hasHostPassword
        ? (savedPass
            ? "ห้องนี้ล็อกรหัสผ่านไว้อยู่ — ลบข้อความนี้ทิ้ง = ปลดล็อก"
            : "ห้องนี้ล็อกรหัสผ่านไว้อยู่ (เครื่องนี้ไม่รู้รหัส) — เว้นว่างไว้ = ไม่แก้รหัส")
        : "ตั้งรหัสผ่านห้อง (ปล่อยว่าง = ไม่ล็อก)";
    // เหมือนรหัสผ่านห้องด้านบนทุกประการ: server ไม่ส่งค่าจริงกลับมา เอาค่าที่เครื่องนี้จำไว้มาโชว์
    const savedJoinCode = getSavedRoomJoinCode(roomId);
    const joinCodeInput = document.getElementById("roomSettingsJoinCodeInput");
    joinCodeInput.value = savedJoinCode;
    joinCodeInput.dataset.initial = savedJoinCode;
    joinCodeInput.placeholder = currentRoom && currentRoom.hasJoinCode
        ? (savedJoinCode
            ? "ห้องนี้ตั้งรหัสผู้เล่นไว้อยู่ — ลบข้อความนี้ทิ้ง = ไม่ต้องใช้รหัสอีก"
            : "ห้องนี้ตั้งรหัสผู้เล่นไว้อยู่ (เครื่องนี้ไม่รู้รหัส) — เว้นว่างไว้ = ไม่แก้รหัส")
        : "ตั้งรหัสห้องฝั่งผู้เล่น (ปล่อยว่าง = ไม่ต้องใช้รหัส)";

    document.getElementById("roomSettingsMaxPlayersInput").value =
        (currentRoom && currentRoom.maxPlayers) ? currentRoom.maxPlayers : "";
    const revealDeadRoleToggle = document.getElementById("roomSettingsRevealDeadRoleToggle");
    if (revealDeadRoleToggle) revealDeadRoleToggle.dataset.initial = currentRoom?.revealDeadRole === false ? "false" : "true";
    renderRoomRevealDeadRole();

    document.getElementById("roomSettingsOverlay").classList.remove("hidden");
    document.documentElement.classList.add("modal-open");
}

function closeRoomSettings() {
    document.getElementById("roomSettingsOverlay").classList.add("hidden");
    document.documentElement.classList.remove("modal-open");
}

function saveRoomSettings() {
    if (!roomId) return;
    const passInput = document.getElementById("roomSettingsPassInput");
    const newPassword = passInput.value.trim();
    const joinCodeInput = document.getElementById("roomSettingsJoinCodeInput");
    const newJoinCode = joinCodeInput.value.trim();
    const maxPlayersInput = document.getElementById("roomSettingsMaxPlayersInput");
    const newMaxPlayers = maxPlayersInput.value.trim();

    const revealDeadRoleToggle = document.getElementById("roomSettingsRevealDeadRoleToggle");
    const revealDeadRoleInitial = revealDeadRoleToggle?.dataset?.initial === "false" ? false : true;
    const revealDeadRoleTouched = !!currentRoom && !currentRoom.started && currentRoom.revealDeadRole !== revealDeadRoleInitial;

    // ส่ง hostPassword ไปแก้เฉพาะตอนที่ "แตะ/แก้" ช่องนี้จริงๆ (ค่าต่างจากตอนเปิดป๊อปอัป) เท่านั้น —
    // ถ้าเครื่องนี้ไม่รู้รหัสห้อง (ช่องว่างตั้งแต่เปิดมา) แล้วไม่ได้พิมพ์อะไรเพิ่ม จะไม่ส่ง key นี้ไปเลย
    // (server: "ไม่ส่งมา = ไม่แก้") กันไม่ให้เผลอกด "บันทึก" (แค่จะแก้อย่างอื่น) แล้วรหัสห้องที่เครื่องอื่น
    // ตั้งไว้หายไปโดยไม่ตั้งใจ — ถ้าตั้งใจแก้จริง (พิมพ์รหัสใหม่ หรือ ลบรหัสที่เห็นอยู่ทิ้ง) ค่าจะต่างจาก
    // initial แน่นอน จึงส่งไปแก้ตามปกติ
    // (ไม่มี hostDisplayName ในนี้อีกแล้ว — server ไม่รับแก้ชื่อแอดมินผ่านทางนี้แล้ว ดูคอมเมนต์ที่
    // update_room_settings ฝั่ง server.js ชื่อแอดมินตั้งได้จากหน้าแรก index.html เท่านั้น)
    const passwordTouched = newPassword !== (passInput.dataset.initial || "");
    const joinCodeTouched = newJoinCode !== (joinCodeInput.dataset.initial || "");
    const payload = { roomId, maxPlayers: newMaxPlayers };
    if (passwordTouched) payload.hostPassword = newPassword;
    if (joinCodeTouched) payload.joinCode = newJoinCode;
    if (revealDeadRoleTouched) payload.revealDeadRole = currentRoom.revealDeadRole !== false;

    socket.emit(
        "update_room_settings",
        payload,
        (res) => {
            const statusEl = document.getElementById("roomSettingsStatus");
            if (!res || res.error) {
                statusEl.textContent = res && res.error === "room_started"
                    ? "🔒 เกมเริ่มแล้ว — ตั้งค่านี้เปลี่ยนไม่ได้จนกว่าจะกด “🔄 เริ่มต้นใหม่”"
                    : "❌ บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง";
                if (res && res.error === "room_started") renderRoomRevealDeadRole();
                return;
            }
            // จำรหัสผ่านปัจจุบันไว้ในเครื่องนี้เสมอ (server ส่งค่าจริงกลับมาให้จอที่เป็นโฮสต์อยู่แล้ว
            // ไม่ว่าจะเพิ่งแก้หรือไม่ก็ตาม) เพื่อให้เครื่องนี้ "ตามทัน" รหัสล่าสุดของห้อง ไม่ว่าจะเครื่องนี้
            // เป็นคนตั้งเองหรือเครื่องอื่นตั้งไว้ก่อนหน้า — แก้ปัญหาข้อมูลรหัสไม่ตรงกันระหว่างเครื่อง
            saveRoomPassword(roomId, res.hostPassword || "");
            saveRoomJoinCode(roomId, res.joinCode || "");
            if (currentRoom) currentRoom.revealDeadRole = res.revealDeadRole !== false;
            // หลังบันทึกสำเร็จ ให้ค่าที่เพิ่งบันทึกกลายเป็น baseline ใหม่ในป๊อปอัปนี้ด้วย
            // เพื่อให้การกด "บันทึก" ซ้ำโดยไม่เปลี่ยนอะไร ไม่ถือว่าตัวเลือกนี้ถูกแก้อีกครั้ง
            if (revealDeadRoleToggle) {
                revealDeadRoleToggle.dataset.initial = currentRoom?.revealDeadRole === false ? "false" : "true";
            }
            renderRoomRevealDeadRole();
            statusEl.textContent = "✓ บันทึกการตั้งค่าเรียบร้อย";
            setTimeout(() => { closeRoomSettings(); }, 700);
        }
    );
}

// เปิด/ปิดเงื่อนไขจบเกมเป็นรายข้อ — ปิดไว้แล้วเกมจะไม่จบจากเงื่อนไขนั้น ใช้ตอนทดสอบกับคนน้อย
function toggleWinCondition(condition) {
    if (!roomId) return;
    socket.emit("toggle_win_condition", { roomId, condition });
}

// แสดง/ซ่อนสรุปผลเกม + รายชื่อผู้เล่นว่าใครแพ้ใครชนะ + ความคืบหน้าการกด "ดำเนินการต่อ"
// ป๊อปอัปนี้ปิดเองได้ — ปุ่ม "เริ่มเกม" จริงๆอยู่ที่การ์ดตั้งค่าบทบาทเดิม (ไม่ทำปุ่มใหม่ซ้ำในนี้)
// เพื่อให้โฮสต์ปิดป๊อปอัปแล้วกลับไปแก้จำนวนบทบาทก่อนเริ่มรอบใหม่ได้ ถ้ามีการเปลี่ยนแปลง
let gameOverManuallyClosed = false;
let wasGameOver = false;

function renderGameOver(room, nonHostPlayers) {
    const overlay = document.getElementById("gameOverOverlay");
    if (!overlay) return;

    const reopenBtn = document.getElementById("reopenGameOverBtn");

    if (!room.gameOver || !room.gameResult) {
        overlay.classList.add("hidden");
        document.documentElement.classList.remove("modal-open");
        if (reopenBtn) reopenBtn.classList.add("hidden");
        wasGameOver = false;
        gameOverManuallyClosed = false;
        return;
    }

    // เกมเพิ่งจบรอบใหม่ (จากไม่จบ -> จบ) ให้เด้งป๊อปอัปขึ้นอัตโนมัติ ล้างสถานะ "ปิดเองไว้ก่อนหน้า"
    if (!wasGameOver) {
        gameOverManuallyClosed = false;
    }
    wasGameOver = true;

    document.getElementById("gameOverTitle").textContent = `🏁 ${room.gameResult.title}`;

    // server ส่ง winners เป็น array ของ {id, token} — ตรวจด้วย token
    // (id เปลี่ยนทุกครั้งที่ reconnect แต่ token คงที่ตลอด ป้องกันโฮสต์โหลดใหม่แล้วเห็นทุกคนแพ้)
    const winnerTokens = new Set((room.gameResult.winners || []).map(w => w.token ?? w));
    const list = document.getElementById("gameOverList");
    list.innerHTML = nonHostPlayers.map((p) => {
        const win = winnerTokens.has(p.token);
        return `
            <div class="gameOverRow ${win ? "win" : "lose"}">
                <div>
                    <div class="goName">${escapeHtml(p.name)}</div>
                    <div class="goRole">${p.role || "?"}${!p.alive ? " · 💀" : ""}</div>
                </div>
                <div class="goTag">${win ? "ชนะ" : "แพ้"}</div>
            </div>
        `;
    }).join("");

    const ready = room.continueReady || {};
    const readyCount = nonHostPlayers.filter(p => ready[p.id]).length;
    const total = nonHostPlayers.length;
    const allReady = total > 0 && readyCount === total;

    document.getElementById("gameOverProgress").textContent =
        allReady
            ? "ผู้เล่นกดดำเนินการต่อครบทุกคนแล้ว — เริ่มเกมใหม่ได้เลย"
            : `รอผู้เล่นกด "ดำเนินการต่อ"... (${readyCount}/${total})`;

    if (gameOverManuallyClosed) {
        overlay.classList.add("hidden");
        document.documentElement.classList.remove("modal-open");
        if (reopenBtn) reopenBtn.classList.remove("hidden");
    } else {
        overlay.classList.remove("hidden");
        document.documentElement.classList.add("modal-open");
        if (reopenBtn) reopenBtn.classList.add("hidden");
    }
}

// ปิดป๊อปอัปสรุปผลเกมเอง (ไม่ใช่เกมจบแล้ว แค่ปิดดูไว้ก่อน) — ปุ่ม "เปิดสรุปผลอีกครั้ง" จะโผล่แทน
function closeGameOverByUser() {
    gameOverManuallyClosed = true;
    document.getElementById("gameOverOverlay").classList.add("hidden");
    document.documentElement.classList.remove("modal-open");
    const reopenBtn = document.getElementById("reopenGameOverBtn");
    if (reopenBtn) reopenBtn.classList.remove("hidden");
}

// เปิดป๊อปอัปสรุปผลเกมกลับมาดูอีกครั้ง (เผื่ออยากเช็คผล/ความคืบหน้าซ้ำ)
function reopenGameOverPopup() {
    gameOverManuallyClosed = false;
    if (currentRoom) {
        renderGameOver(currentRoom, currentRoom.players.filter(p => !p.isHost));
    }
}

// ปุ่ม "🔄 เริ่มต้นใหม่" ข้างปุ่มปิดห้อง — ยกเลิกเกมปัจจุบันทั้งหมด (เรียกบทคืนจากผู้เล่นทุกคน)
// แล้วเด้งไปการ์ด "ตั้งค่าบทบาท" ให้กดปุ่ม "เริ่มเกม" รอบใหม่ต่อได้เลย ใช้ได้ทุกเมื่อแม้เกมกำลังเล่นอยู่
async function restartRoom() {
    if (!roomId) return;

    const ok = await wwConfirm(
        "ต้องการเริ่มห้องนี้ใหม่ทั้งหมดใช่ไหม? บทบาทและความคืบหน้าของรอบปัจจุบันจะถูกล้างทิ้ง แล้วรอกด \"เริ่มเกม\" รอบใหม่"
    );
    if (!ok) return;


    socket.emit("restart_room", roomId);
    // room_update จะตามมาทาง event ปกติ แล้วค่อยเด้งไปการ์ดตั้งค่าบทบาทให้เลย
    goToRestartSetup();
}

// ปิดป๊อปอัปแล้วเด้งกลับไปที่การ์ด "ตั้งค่าบทบาท" — เผื่อโฮสต์อยากแก้จำนวนบทบาทก่อนเริ่มรอบใหม่
// ปุ่ม "เริ่มเกม" จริงที่จะกดต่อ คือปุ่มเดิมในการ์ดนี้ ไม่ใช่ปุ่มในป๊อปอัป
function goEditRolesAfterGameOver() {
    closeGameOverByUser();
    goToRestartSetup();
}

// ปุ่ม "🔄 เริ่มต้นใหม่" ข้างปุ่มปิดห้อง — เด้งไปการ์ด "ตั้งค่าบทบาท" ให้กดปุ่ม "เริ่มเกม" ต่อได้เลย
// ใช้ร่วมกับ goEditRolesAfterGameOver() ด้วย (แค่ไม่ต้องปิดป๊อปอัปสรุปผลก่อน)
function goToRestartSetup() {
    const body = document.getElementById("roleCardBody");
    if (body && body.classList.contains("is-collapsed")) {
        toggleRoleCard();
    }

    // โชว์การ์ดกลับมาทันที ไม่ต้องรอ room_update รอบถัดไปจากเซิร์ฟเวอร์
    document.getElementById("roleSettingsCard")?.classList.remove("hidden");
    document.getElementById("roleSettingsCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ===== MODE POPUP HELPERS =====
let modePopupManuallyClosed = false;

function showModePopup() {
    document.getElementById("modePopupOverlay").classList.remove("hidden");
    document.documentElement.classList.add("modal-open");
    modePopupManuallyClosed = false;
    const reopenBtn = document.getElementById("reopenPopupBtn");
    if (reopenBtn) reopenBtn.classList.add("hidden");
}

function hideModePopup() {
    document.getElementById("modePopupOverlay").classList.add("hidden");
    document.documentElement.classList.remove("modal-open");
    stopHostVoteCountdown();
}

function closeModePopupByUser() {
    modePopupManuallyClosed = true;
    hideModePopup();
    const reopenBtn = document.getElementById("reopenPopupBtn");
    const anyModeActive = voteMode;
    if (reopenBtn) reopenBtn.classList.toggle("hidden", !anyModeActive);
}

function renderVotePopup(room, nonHostPlayers) {
    const overlay = document.getElementById("modePopupOverlay");
    const panel = document.getElementById("modePopupPanel");
    const title = document.getElementById("modePopupTitle");
    const info = document.getElementById("modePopupInfo");
    const list = document.getElementById("modePopupList");

    panel.classList.remove("kill-active");
    title.textContent = "🗳️ โหมดโหวต — กำลังเปิดอยู่";
    startHostVoteCountdown(room.voteDeadline);

    const votes = room.votes || {};

    // จำนวนโหวตที่ต้องใช้เพื่อประหาร = ผู้เล่นที่มีชีวิต/2 ปัดขึ้น
    const aliveVoters = nonHostPlayers.filter(p => p.alive).length;
    const voteThreshold = Math.ceil(aliveVoters / 2);
    const thresholdText = aliveVoters > 0
        ? `ต้องการ ${voteThreshold} โหวต (จากผู้มีชีวิต ${aliveVoters} คน) เพื่อประหาร`
        : "ยังไม่มีผู้เล่นที่มีชีวิต";
    // โหมดผู้ทดสอบเท่านั้น: บอกแอดมินว่าแตะปุ่ม "บังคับโหวต" ที่แต่ละแถวเพื่อบังคับให้ทุกคนโหวตคนนั้นได้เลย
    info.innerHTML = isTesterMode
        ? `🧪 โหมดผู้ทดสอบ: กดปุ่ม "บังคับโหวต" ที่รายชื่อเพื่อบังคับให้ทุกคนโหวตคนนั้นทันที<br>${escapeHtml(thresholdText)}`
        : escapeHtml(thresholdText);

    const tally = {};
    // นายกที่เปิดเผยตัวแล้ว (mayorRevealed) โหวตนับเป็น 2 เสียง — ต้องคำนวณให้ตรงกับฝั่ง server
    // (ดู getVoteWeight/closeVoteRound ใน server.js) ไม่งั้นตัวเลขที่โฮสต์เห็นจะไม่ตรงกับผลจริง
    Object.entries(votes).forEach(([voterId, tid]) => {
        const voter = room.players.find(p => p.id === voterId);
        const weight = voter && voter.mayorRevealed ? 2 : 1;
        tally[tid] = (tally[tid] || 0) + weight;
    });

    // แสดงว่าใครกำลังถูกหมาป่าผู้พิทักษ์วางโล่ป้องกันไว้ ให้โฮสต์เห็นด้วย
    const shieldTargets = room.shieldTargets || {};
    const shieldedIds = new Set(Object.values(shieldTargets));

    if (nonHostPlayers.length === 0) {
        list.innerHTML = `<div class="modePopupEmpty">ยังไม่มีผู้เล่นในห้องนี้</div>`;
    } else {
        list.innerHTML = nonHostPlayers.map(p => {
            const targetId = votes[p.id];
            const target = targetId ? room.players.find(x => x.id === targetId) : null;
            const receivedCount = tally[p.id] || 0;
            const reached = voteThreshold > 0 && receivedCount >= voteThreshold;
            const isShielded = shieldedIds.has(p.id);

            const mayorTag = p.mayorRevealed ? ` <span class="modeBadge" style="margin-left:4px;">🤠 x2</span>` : "";
            const choiceHtml = p.alive
                ? `🗳️ โหวต: <b>${target ? escapeHtml(target.name) : "ยังไม่โหวต"}</b>${mayorTag}`
                : `💀 ตายแล้ว`;

            const badgeHtml = receivedCount > 0
                ? `<span class="modeBadge${reached ? " reached" : ""}" style="margin-left:8px;">${receivedCount} โหวต${reached ? " ☠️" : ""}</span>`
                : "";

            // โหมดผู้ทดสอบเท่านั้น: โชว์บทจริงต่อท้ายชื่อ (เห็นเฉพาะโฮสต์อยู่แล้ว ไม่ใช่ข้อมูลใหม่ที่รั่ว
            // แค่โชว์เพิ่มในป๊อปอัปนี้ให้เลือกเป้าบังคับโหวตได้สะดวกโดยไม่ต้องสลับไปดูกริดหลัก)
            const roleTagHtml = isTesterMode
                ? ` <span class="modePopupRoleTag">(${escapeHtml(p.role || "?")})</span>`
                : "";

            // โหมดผู้ทดสอบเท่านั้น: ปุ่ม "บังคับโหวต" ต่อแถว — กดแล้วบังคับให้ผู้เล่นที่ยังมีชีวิตทุกคน
            // (ยกเว้นเป้าหมายเอง) โหวตคนนี้ทันที ผ่าน force_vote_all ดูคอมเมนต์ที่ตัว handler ฝั่ง server.js
            const forceVoteBtnHtml = (isTesterMode && p.alive)
                ? `<button class="modePopupForceBtn" onclick="forceVoteAll('${p.id}')" title="บังคับให้ทุกคนโหวตคนนี้ทันที">🎯 บังคับโหวต</button>`
                : "";

            return `
                <div class="modePopupRow${!p.alive ? " dead" : ""}${isShielded ? " shielded" : ""}">
                    <div class="modePopupName">
                        ${isShielded ? `<span class="shield-ic">🛡️</span>` : ""}
                        ${escapeHtml(p.name)}${roleTagHtml}
                    </div>
                    <div class="modePopupChoice">${choiceHtml}${badgeHtml}${forceVoteBtnHtml}</div>
                </div>
            `;
        }).join("");
    }

    if (!modePopupManuallyClosed) {
        overlay.classList.remove("hidden");
        document.documentElement.classList.add("modal-open");
    }
}

// HOST ERROR
socket.on(
    "host_error",
    (msg) => {

        wwAlert(msg);

    }
);

// ล็อกลำดับปุ่ม "สรุปผลรอบนี้" / "เริ่มช่วงกลางคืน" ตามสถานะจริงของห้อง
// กันไม่ให้กด "สรุปผลรอบนี้" ก่อนที่จะเคยกด "เริ่มช่วงกลางคืน" เลย
// (ซึ่งจะข้ามคืนที่ 1 ไปประกาศ "เริ่มการประชุมวันที่ 1" เลยทันที)

function updateHostControlChrome(room) {
    const r = room || currentRoom || {};
    const inSetup = document.body.classList.contains("setup-mode");
    const gameInProgress = !!r.started && !r.gameOver;
    document.body.classList.toggle("host-game-mode", gameInProgress && !inSetup);
    document.body.classList.toggle("host-lobby-mode", !inSetup && !gameInProgress);
    const players = (r.players || []).filter((p) => !p.isHost);
    const alive = players.filter((p) => p.alive).length;
    const cfg = r.config || roleConfig || {};
    const blockedRoles = new Set(Array.isArray(cfg.__nonSelectableRoles) ? cfg.__nonSelectableRoles : []);
    const roleTotal = Object.entries(cfg).reduce((sum, [key, n]) => {
        if (key.startsWith("__") || blockedRoles.has(key)) return sum;
        return sum + (Number(n) || 0);
    }, 0);
    const phaseStarted = !!r.started && !r.gameOver;
    const phase = !r.started ? "ก่อนเริ่ม" : r.gameOver ? "จบเกม" : r.isNight ? `คืนที่ ${r.nightCount || 1}` : `วันที่ ${r.dayCount || 1}`;
    const phaseTitle = !r.started ? "เตรียมห้อง" : r.gameOver ? "สรุปผล" : r.isNight ? "ช่วงกลางคืน" : "ช่วงกลางวัน";
    const phaseHint = !r.started
        ? "ตรวจผู้เล่นและบทบาทให้พร้อม แล้วกดเริ่มเกม"
        : r.gameOver
            ? "ดูผลรอบนี้ หรือแก้บทบาทเพื่อเริ่มเกมใหม่"
            : r.isNight
                ? "ตรวจการเลือกของแต่ละบทบาท แล้วสรุปผลเมื่อพร้อม"
                : "เปิดโหวตเมื่อพร้อม และใช้การ์ดผู้เล่นติดตามสถานะ";
    const access = r.hasJoinCode ? "มีรหัส" : "เปิด";
    const liveText = !roomId ? "ตั้งค่าห้อง" : !r.started ? "รอเริ่มเกม" : r.gameOver ? "เกมจบแล้ว" : (r.isNight ? "กำลังดำเนินคืน" : "กำลังดำเนินวัน");

    const focusBtn = document.getElementById("playerFocusBtn");
    if (focusBtn) {
        // room_update อาจมาก่อน callback ของ host_login ทำให้ roomId ยังว่างชั่วคราว
        // แต่ r คือข้อมูลห้องจริงแล้ว. ใช้ roomId หรือ r.id เป็น source สำรองเพื่อไม่ให้ปุ่มถูกซ่อนค้าง.
        const effectiveRoomId = String(roomId || r.id || "").trim();
        const canFocus = !!effectiveRoomId && !inSetup;
        focusBtn.classList.toggle("hidden", !canFocus);
        focusBtn.disabled = !canFocus;
        if (!canFocus && playerFocusMode) setPlayerFocusMode(false);
    }

    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set("hostFactPlayers", `${players.length}${r.maxPlayers ? `/${r.maxPlayers}` : ""}`);
    set("hostFactRoles", roleTotal);
    set("hostFactAccess", access);
    set("hostFactPhase", phase);
    set("hostLiveText", liveText);
    set("floatingPhaseTitle", phaseTitle);
    set("floatingPhaseHint", phaseHint);

    const pill = document.getElementById("hostLivePill");
    if (pill) {
        pill.dataset.phase = r.isNight ? "night" : (r.started ? "day" : "lobby");
        pill.classList.toggle("is-live", phaseStarted);
    }

    const steps = document.querySelectorAll("#setupSteps .setup-step");
    if (steps.length) {
        const setupIndex = inSetup ? (roleTotal > 0 ? 1 : 0) : 2;
        steps.forEach((step, i) => {
            step.classList.toggle("is-current", i === setupIndex);
            step.classList.toggle("is-done", inSetup ? i < setupIndex : true);
        });
    }
}

function updateNightFlowButtons(room) {
    updateHostControlChrome(room);
    const resolveBtn = document.getElementById("resolveBtn");
    const startNightBtn = document.getElementById("startNightBtn");
    const voteBtn = document.getElementById("voteBtn");

    // ฉากพื้นหลัง + ป้ายบอกกลางวัน/กลางคืน
    // ก่อนเริ่มเกม/ห้องที่เพิ่งสร้างต้องเป็น "กลางวัน" เช่นเดียวกับหน้าล็อบบี้
    // และทันทีที่เริ่มเกมวันแรกก็ยังเป็นกลางวัน จนกว่า server จะเปลี่ยน isNight=true จริง
    // ป้าย "วันที่/คืนที่" ยังแสดงเฉพาะเมื่อผ่านรอบกลางคืน/กลางวันจริงแล้ว เพื่อไม่เปลี่ยนข้อมูลบน UI เดิม
    const dnBadge = document.getElementById("dayNightBadge");
    const dnIcon = document.getElementById("dnIcon");
    const dnText = document.getElementById("dnText");
    const dayNightCycleStarted = (room.nightCount || 0) > 0 || (room.dayCount || 0) > 0;
    const showDayNight = !!room.started && !room.gameOver && dayNightCycleStarted;
    // ใช้กฎธีมกลางจุดเดียว: ทุกสถานะที่ไม่ใช่คืนจริงจาก server = กลางวัน.
    const activeNight = syncHostTimeTheme(room);
    persistHostRoomTheme(room);
    if (dnBadge) {
        dnBadge.classList.toggle("hidden", !showDayNight);
        if (showDayNight && dnIcon && dnText) {
            dnIcon.textContent = room.isNight ? "🌙" : "☀️";
            dnText.textContent = room.isNight
                ? `คืนที่ ${room.nightCount || 1}`
                : `วันที่ ${room.dayCount || 1}`;
        }
    }

    // ปุ่ม "เริ่มเกม" (บาร์ลอย) / "เริ่มต้นใหม่" (ข้างปุ่มปิดห้อง): โชว์แค่ทีละปุ่ม สลับกันไปมาตามสถานะห้อง —
    // ยังไม่เริ่ม/เกมจบแล้ว (gameOver) → โชว์ "เริ่มเกม" ให้กด
    // กำลังเล่นอยู่ (started && ยังไม่จบ) → โชว์ "เริ่มต้นใหม่" แทน (จะกด "เริ่มเกม" ซ้ำระหว่างเล่นไม่ได้)
    const startGameBtn = document.getElementById("startGameBtn");
    const restartRoomBtn = document.getElementById("restartRoomBtn");
    const gameInProgress = !!room.started && !room.gameOver;
    if (startGameBtn) {
        startGameBtn.classList.toggle("hidden", gameInProgress);
        startGameBtn.disabled = gameInProgress;
    }
    if (restartRoomBtn) {
        restartRoomBtn.classList.toggle("hidden", !gameInProgress);
    }
    const focusRestartBtn = document.getElementById("focusRestartBtn");
    if (focusRestartBtn) {
        focusRestartBtn.classList.toggle("hidden", !gameInProgress);
        focusRestartBtn.disabled = !gameInProgress;
    }

    // ปุ่ม "เริ่มกลางคืน / สรุปผลรอบนี้ / เปิดโหมดโหวต" (บาร์ลอย): ซ่อนไว้ทั้งหมดตอนเกมยังไม่เริ่ม
    // หรือเกมจบไปแล้ว (ตรงกับตอนที่ปุ่ม "เริ่มเกม" กำลังโชว์อยู่พอดี) โผล่มาแทนที่ปุ่ม "เริ่มเกม"
    // ทันทีที่กดเริ่มเกม แล้วซ่อนกลับตอนกดเริ่มต้นใหม่/เกมจบแล้วยังไม่กดเริ่มรอบใหม่ (gameInProgress
    // เดียวกับที่คุม startGameBtn/restartRoomBtn ด้านบน ให้สลับพร้อมกันเป๊ะๆ ไม่หลุดจังหวะกัน)
    if (resolveBtn) resolveBtn.classList.toggle("hidden", !gameInProgress);
    if (startNightBtn) startNightBtn.classList.toggle("hidden", !gameInProgress);
    if (voteBtn) voteBtn.classList.toggle("hidden", !gameInProgress);


    // ปุ่ม "เพิ่มบอท" (โหมดผู้ทดสอบ): ปิดหลังเกมเริ่มไปแล้ว — เดิมไม่มีการเช็คนี้เลยทั้งฝั่ง client
    // และ server ทำให้เพิ่มบอทกลางเกมได้ บอทตัวใหม่จะไม่ได้รับบทบาทเลยเพราะ start_game แจกบท
    // ให้ทุกคนแค่ครั้งเดียวตอนกดเริ่ม (ดูคอมเมนต์คู่กันที่ server.js: host_add_bot)
    // แก้บั๊ก: เดิมใช้ querySelector(".btn-add-bot") ตัวเดียว ซึ่ง class นี้ถูกใช้ซ้ำกับปุ่มอื่นที่ไม่ใช่
    // ปุ่มเพิ่มบอทด้วย (เช่น "⛔ ปิดเงื่อนไขการชนะทั้งหมด" ในป๊อปอัปคนละอัน) ทำให้ querySelector ตัวแรกที่
    // เจอในหน้าเอกสารอาจไม่ใช่ปุ่มเพิ่มบอทเลย — เปลี่ยนมาใช้ class เฉพาะ ".btn-add-bot-action" ที่ผูกไว้
    // กับปุ่มเพิ่มบอททั้งสองปุ่มเท่านั้น (เพิ่มบอทปกติ + เพิ่มบอทให้ครบเท่าจำนวนอาชีพทั้งหมดในเกม)
    // แล้ว disable ทุกปุ่มที่ match พร้อมกัน
    document.querySelectorAll(".btn-add-bot-action").forEach((btn) => {
        btn.disabled = !!room.started && !room.gameOver;
    });

    // การ์ด "ตั้งค่าบทบาท": ซ่อนทันทีที่กดเริ่มเกม (room.started && ยังไม่จบ)
    // แล้วโชว์กลับมาอัตโนมัติตอนเกมจบ (room.gameOver) หรือยังไม่เริ่มเกม/กดเริ่มต้นใหม่
    const roleSettingsCard = document.getElementById("roleSettingsCard");
    if (roleSettingsCard) {
        const shouldHide = !!room.started && !room.gameOver;
        roleSettingsCard.classList.toggle("hidden", shouldHide);
        // การ์ดบทบาทหาย → คอลัมน์ซ้ายว่างเปล่า (เหลือแค่การ์ดนี้อยู่ในคอลัมน์ซ้ายบนจอที่เป้าหมายนี้
        // เพราะการ์ดแชทจะย้ายไปคอลัมน์ซ้ายเฉพาะ portrait+min-width:981px เท่านั้น ไม่ตรงกับ iPad ของเรา)
        // เลยติดคลาส role-hidden ที่ .layout ไว้ ให้คอลัมน์ขวา (กริดผู้เล่น) ขยายเต็มความกว้างแทน
        // ที่จะโดนผลจริง ๆ คือช่วง >980px เท่านั้น (ต่ำกว่านั้น .layout ยุบเป็น 1fr อยู่แล้วโดย media query เดิม)
        document.querySelector(".layout")?.classList.toggle("role-hidden", shouldHide);
        // role-hidden เพิ่ง toggle → เบรกพอยต์ของกริดผู้เล่นอาจเปลี่ยน (ไอแพดแนวนอนสลับ 5↔8
        // คอลัมน์) ทั้งที่ขนาดจอจริงไม่ได้เปลี่ยนเลย ต้องเรียกรีเฟรชเองตรงนี้ เพราะ resize/
        // orientationchange จะไม่ยิงในเคสนี้ (ดูฟังก์ชัน refreshGridColsForBreakpoint ท้ายไฟล์)
        refreshGridColsForBreakpoint();
    }

    if (!resolveBtn || !startNightBtn) return;

    if (!room.started) {
        // เกมยังไม่เริ่ม: ปิดทั้งหมด (รวมปุ่มโหวต/หมาป่าฆ่า — ยังไม่มีคืน 1 หรือประชุม 1 ให้กด)
        resolveBtn.disabled = true;
        startNightBtn.disabled = true;
        if (voteBtn) voteBtn.disabled = true;
        return;
    }

    if (room.isNight) {
        // กำลังอยู่ในคืน: ให้กด "สรุปผลรอบนี้" ได้ แต่กด "เริ่มช่วงกลางคืน" ซ้ำไม่ได้
        resolveBtn.disabled = false;
        startNightBtn.disabled = true;
    } else {
        // อยู่ช่วงประชุม/ยังไม่เคยเริ่มคืน: ต้องกด "เริ่มช่วงกลางคืน" ก่อน ถึงจะสรุปผลได้
        resolveBtn.disabled = true;
        startNightBtn.disabled = false;
    }

    // ปุ่มโหวตประหาร: กดได้เฉพาะตอนกลางวัน (หรือกดปิดโหมดที่เปิดค้างไว้ได้เสมอไม่ว่าช่วงไหน)
    if (voteBtn) {
        voteBtn.disabled = room.isNight && !room.voteMode;
    }
}

// ROLE UI
function renderRoles() {

    const rolesDiv = document.getElementById("roles");

    // ลบอาชีพที่เหลือ 0 หรือต่ำกว่าออกจาก config ก่อน
    Object.keys(roleConfig).forEach((role) => {
        if (roleConfig[role] <= 0) {
            delete roleConfig[role];
        }
    });

    const roleNames = Object.keys(roleConfig);
    let total = 0;
    roleNames.forEach((role) => { total += roleConfig[role]; });

    document.getElementById("roleTotal").innerText = total;

    // แสดงจำนวนผู้เล่นจริงในห้องคู่กับจำนวนการ์ด เทียบง่ายว่าครบหรือยัง
    const playerCount = (currentRoom?.players || []).filter(p => !p.isHost).length;
    document.getElementById("rolePlayerCount").innerText = playerCount;

    if (roleNames.length === 0) {
        rolesDiv.innerHTML = `<div class="empty-note">ยังไม่ได้เลือกบทบาท — เริ่มจากเลือกจากเมนูด้านบน</div>`;
        renderQuickAddBadges();
        updateHostControlChrome(currentRoom || { started:false, gameOver:false, config: roleConfig, players:[] });
        return;
    }

    // ถ้ามี empty-note ค้างอยู่ ให้เคลียร์ก่อน sync ของจริง
    if (rolesDiv.querySelector(".empty-note")) {
        rolesDiv.innerHTML = "";
    }

    // เก็บกล่องอาชีพที่มีอยู่แล้วไว้ใช้ซ้ำ (ตาม role) แทนการรื้อสร้างใหม่ทุกครั้ง
    // กันไม่ให้รูป/อนิเมชันของกล่องที่ "ไม่ได้เปลี่ยน" กระตุกซ้ำตอนกดเพิ่ม/ลดอาชีพอื่น
    const existingNodes = {};
    rolesDiv.querySelectorAll(".roleBox[data-role]").forEach((node) => {
        existingNodes[node.dataset.role] = node;
    });

    roleNames.forEach((role, idx) => {

        let div = existingNodes[role];

        if (!div) {
            // อาชีพใหม่ที่ยังไม่มีกล่อง → สร้างใหม่ (จะเล่นอนิเมชัน rise ตอนเข้ามาจริงๆ)
            div = document.createElement("div");
            div.className = "roleBox";
            div.dataset.role = role;

            div.innerHTML = `
                <div class="name">
                    <img class="role-icon" src="${getRoleIcon(role)}" alt="${role}" onerror="this.style.display='none'">
                    <span>${role}</span>
                    <span class="count"></span>
                </div>
                <div class="btns">
                    <button class="roleBtn" onclick="changeRole('${role}', 1)" aria-label="เพิ่ม ${role}">+</button>
                    <button class="roleBtn" onclick="changeRole('${role}', -1)" aria-label="ลด ${role}">−</button>
                </div>
            `;
        }

        // อัปเดตแค่ตัวเลขจำนวน ไม่แตะรูป/ปุ่มของกล่องเดิม เพื่อไม่ให้รีโหลด/เล่นอนิเมชันซ้ำ
        const countSpan = div.querySelector(".count");
        const countText = `x${roleConfig[role]}`;
        if (countSpan.textContent !== countText) {
            countSpan.textContent = countText;
        }

        // จัดลำดับกล่องให้ตรงกับลำดับที่เลือก/เพิ่มไว้
        if (rolesDiv.children[idx] !== div) {
            rolesDiv.insertBefore(div, rolesDiv.children[idx] || null);
        }
    });

    // ลบกล่องอาชีพที่ถูกลดจนหมดออกจากหน้าจริง
    Object.keys(existingNodes).forEach((role) => {
        if (!roleConfig[role]) {
            existingNodes[role].remove();
        }
    });

    renderQuickAddBadges();
    updateHostControlChrome(currentRoom || { started:false, gameOver:false, config: roleConfig, players:[] });

}

// ADD ROLE
// TOGGLE ROLE — แตะไอคอนครั้งแรกเพื่อเพิ่มบทบาท (จำนวน 1), แตะซ้ำเพื่อเอาออกทั้งหมด
// ไม่ว่าตอนนั้นจะเพิ่ม/ลดจำนวนไพ่ไว้กี่ใบแล้วก็ตาม (ใช้ปุ่ม +/- ในรายการเพื่อปรับจำนวน)
function toggleRole(role) {

    if (roleConfig[role]) {

        delete roleConfig[role];

    }

    else {

        roleConfig[role] = 1;

    }

    renderRoles();

    updateConfig();

}

// อัปเดตตัวเลขจำนวนมุมขวาบนของไอคอน quick-add ให้ตรงกับ roleConfig ปัจจุบัน
function renderQuickAddBadges() {
    document.querySelectorAll("#quickAddRoles .quick-add-chip").forEach((chip) => {
        const role = chip.dataset.role;
        const count = roleConfig[role] || 0;

        let badge = chip.querySelector(".qa-count");
        if (count > 0) {
            if (!badge) {
                badge = document.createElement("span");
                badge.className = "qa-count";
                chip.appendChild(badge);
            }
            badge.textContent = count;
        } else if (badge) {
            badge.remove();
        }
    });
}

// CHANGE ROLE
function changeRole(
    role,
    amount
) {

    if (
        !roleConfig[role]
    ) return;

    roleConfig[role] += amount;

    if (
        roleConfig[role] <= 0
    ) {

        delete roleConfig[
            role
        ];

    }

    renderRoles();

    updateConfig();

}

// UPDATE CONFIG
function updateConfig() {

    // ยังไม่มีห้อง (หน้า "ตั้งค่าห้องก่อนสร้าง") — roleConfig เก็บไว้ฝั่งนี้ แล้วส่งไปพร้อม create_room ตอนกดสร้างห้อง
    if (!roomId) return;

    socket.emit(
        "update_config",
        {
            roomId,
            config: roleConfig
        }
    );

}

// START GAME
function startGame() {


    // ล้างแชทรอบก่อน
    document.getElementById("chatBoxGlobal").innerHTML = "";
    document.getElementById("chatBoxWolf").innerHTML = "";
    hostBadgeCounts = { global: 0, wolf: 0 };
    document.getElementById("badgeGlobal").textContent = "0";
    document.getElementById("badgeWolf").textContent = "0";

    socket.emit(
        "start_game",
        roomId
    );

}

// TOGGLE
// บั๊กความปลอดภัย: เดิมฟังก์ชันนี้รับ playerName มาจาก onclick="kickPlayer('id','${p.name}')" ที่ฝัง
// ชื่อผู้เล่น (ซึ่งเป็นข้อความที่ผู้เล่นตั้งเองได้อิสระ) ตรงเข้าไปในตัว attribute ของ HTML เลย
// ถ้าชื่อมีเครื่องหมาย ' หรือ " อยู่ในนั้น จะ "หลุด" ออกจาก string literal ของ onclick แล้วรันเป็น
// JavaScript ได้ตามใจ (แม้จะ escape เป็น HTML entity ก็ยังหลุดได้ เพราะเบราว์เซอร์ decode entity
// ก่อนเอาไป parse เป็นโค้ด JS ใน inline event handler) วิธีแก้ที่ปลอดภัยคือไม่ฝังชื่อไว้ใน attribute
// เลย ส่งแค่ playerId (ซึ่งเป็น socket.id ที่ server สร้างเอง ปลอดภัย) แล้วไปหาชื่อปัจจุบันจาก
// currentRoom เอาเองแทน
async function kickPlayer(playerId) {
    const p = currentRoom?.players?.find((pl) => pl.id === playerId);
    const playerName = p ? p.name : "ผู้เล่นนี้";
    // หมายเหตุ: wwConfirm ใช้ .textContent ใส่ข้อความ (ดูด้านบน) จึงปลอดภัยจาก HTML injection
    // อยู่แล้วโดยไม่ต้อง escapeHtml ตรงนี้ซ้ำ (escape ซ้ำจะทำให้เห็น "&#39;" เป็นตัวอักษรจริงแทน)
    const ok = await wwConfirm(`เตะ "${playerName}" ออกจากห้องใช่ไหม?`);
    if (!ok) return;
    socket.emit("kick_player", { roomId, playerId });
}

// หมายเหตุ: การแก้ชื่อผู้เล่น/โฮสต์ย้ายไปทำที่หน้า admin.html แทนแล้วทั้งหมด
// (ไม่มีลิงก์เชื่อมจากหน้านี้ — ต้องพิมพ์ URL /admin.html เอง) หน้านี้จึงไม่มีปุ่มแก้ชื่ออีกต่อไป

function toggle(playerId, key, value) {

    socket.emit(
        "toggle_state",
        {
            roomId,
            playerId,
            key,
            value
        }
    );

}

// โฮสต์ติ๊กช่อง "เล็งฆ่า" เอง — แทนที่จะบังคับ p.killed=true ตรงๆ (ซึ่งข้ามระบบโหวตฆ่าไปเลย
// ทำให้ไม่โชว์ไฮไลต์เรียลไทม์และไม่ตรงกับข้อความสรุปผลกลางคืนปกติ) เปลี่ยนมาให้ "ทีมที่ฆ่าได้จริง"
// (หมาป่า/ฆาตกรต่อเนื่อง) โหวตเล็งเป้าคนนี้แทน เพื่อให้ resolve_night ประมวลผลเหมือนกับหมาป่า/ฆาตกรต่อเนื่องเลือกเป้าเอง
// ทุกประการ — ถ้าห้องมีทั้งสองทีมพร้อมกัน ให้โฮสต์เลือกว่าใครเป็นคนลงมือ ถ้ามีแค่ทีมเดียวก็ใช้ทีมนั้นเลย
// ถ้าไม่มีทีมไหนเลย (ไม่มีหมาป่า/ฆาตกรต่อเนื่องที่ยังมีชีวิตในเกมนี้) fallback กลับไปบังคับ killed ตรงๆ เหมือนเดิม
async function handleKillToggle(playerId, checked, checkboxEl) {

    if (!checked) {
        socket.emit("host_clear_kill_target", { roomId, targetId: playerId });
        return;
    }

    const players = (currentRoom && currentRoom.players) || [];
    const aliveWolfVoters = players.filter((p) => p.alive && WOLF_KILL_ROLES.has(p.role));
    const aliveMurderer = players.find((p) => p.alive && p.role === "ฆาตกรต่อเนื่อง");

    const hasWolves = aliveWolfVoters.length > 0;
    const hasMurderer = !!aliveMurderer;

    let team = null;

    if (hasWolves && hasMurderer) {
        team = await wwChoice("ห้องนี้มีทั้งหมาป่าและฆาตกรต่อเนื่อง ใครเป็นคนเล็งฆ่าคนนี้?", [
            { label: "🐺 หมาป่าทั้งทีม", value: "wolf" },
            { label: "🔪 ฆาตกรต่อเนื่อง", value: "murderer" },
        ]);
        if (!team) {
            // กดยกเลิก — ไม่ติ๊กช่องนี้ ต้องคืนสถานะ checkbox กลับไปไม่ติ๊กเอง
            // (ไม่ยิง socket event ใดๆ ให้ server เลย ค่าจริงในห้องไม่เปลี่ยน)
            if (checkboxEl) checkboxEl.checked = false;
            return;
        }
    } else if (hasWolves) {
        team = "wolf";
    } else if (hasMurderer) {
        team = "murderer";
    }

    socket.emit("host_aim_kill", { roomId, targetId: playerId, team });
}

// ===== กรองผู้เล่นในลิสต์ (มีชีวิต/ตายแล้ว/ทั้งหมด) =====
// เดิมมีช่องพิมพ์ค้นหาชื่อคู่กับตัวกรองนี้ ตอนนี้ตัดออกแล้วตามคำขอ (แทนที่ด้วยตัวปรับจำนวน
// คอลัมน์กริดผู้เล่น — ดูฟังก์ชัน setGridColsPreset/onGridColsInputChange ด้านล่าง) เหลือแค่ตัวกรอง
// สถานะอย่างเดียว คลาส "search-hidden" ยังใช้ชื่อเดิมไว้เพื่อไม่ต้องแก้ CSS ที่อ้างอิงอยู่
let playerListFilter = "all"; // "all" | "alive" | "dead"

function setPlayerFilter(filter) {
    playerListFilter = filter;
    document.querySelectorAll(".filterChip").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.filter === filter);
    });
    filterPlayerList();
}

function filterPlayerList() {
    const cards = document.querySelectorAll("#list .player[data-id], #listSimple .simple-row[data-id]");
    let visibleCount = 0;

    cards.forEach((card) => {
        const show =
            playerListFilter === "all" ||
            (playerListFilter === "alive" && card.dataset.alive === "1") ||
            (playerListFilter === "dead" && card.dataset.alive === "0");

        card.classList.toggle("search-hidden", !show);
        if (show) visibleCount++;
    });

    const emptyNote = document.getElementById("playerSearchEmpty");
    if (emptyNote) emptyNote.classList.toggle("hidden", visibleCount !== 0 || cards.length === 0);
    scheduleCardFit();
}

// ===== สลับมุมมองลิสต์ผู้เล่น: กริดปกติ / ลิสต์อย่างง่าย (ชื่อ + ติ๊กสถานะ) =====
// สองมุมมองทำงานเหมือนกันทุกอย่าง (ยิง toggle_state เดียวกัน) ต่างกันแค่วิธีแสดงผล
let playerViewMode = "grid"; // "grid" | "simple"

function setPlayerViewMode(mode) {
    playerViewMode = mode;
    document.getElementById("viewModeGridBtn")?.classList.toggle("active", mode === "grid");
    document.getElementById("viewModeSimpleBtn")?.classList.toggle("active", mode === "simple");
    document.getElementById("list")?.classList.toggle("hidden", mode !== "grid");
    document.getElementById("listSimple")?.classList.toggle("hidden", mode !== "simple");
    if (mode === "simple" && currentRoom) {
        renderSimplePlayerList(currentRoom, (currentRoom.players || []).filter((p) => !p.isHost));
    }
}

// ลิสต์อย่างง่าย: เรียงลำดับเดียวกับกริด (ตามลำดับผู้เล่นที่ server ส่งมา) มีแค่ชื่อ + ติ๊กสถานะ "มีชีวิต"
// สร้างใหม่ทั้งลิสต์ทุกครั้งได้เพราะ markup เบามาก ไม่ต้อง diff เหมือนกริด
function renderSimplePlayerList(room, nonHostPlayers) {
    const container = document.getElementById("listSimple");
    if (!container) return;

    // view นี้ถูกซ่อนอยู่เมื่อใช้กริดหลัก — อย่าสร้าง DOM/รูปอาชีพของรายการที่มองไม่เห็นทุก room_update
    if (playerViewMode !== "simple") return;

    if (!nonHostPlayers || nonHostPlayers.length === 0) {
        container.innerHTML = `<div class="empty-note">ยังไม่มีผู้เล่นเข้าร่วมห้องนี้</div>`;
        return;
    }

    const aimedTargetIds = getAimedTargetIds(room);
    const silenceAimIds = getSilenceAimIds(room);
    const protectAimIds = getProtectAimIds(room);

    // บั๊กความปลอดภัย (XSS) ที่แก้แล้ว: เดิม data-name ใส่ p.name (ชื่อที่ผู้เล่นตั้งเองได้อิสระ) ลงใน
    // attribute ของ HTML ตรงๆ โดยไม่ escape — ถ้าชื่อมี " อยู่ในนั้น จะหลุดออกจาก attribute แล้วแทรก
    // attribute/แท็กใหม่ที่มี event handler (เช่น onmouseover) รันเป็น JS ได้ในเบราว์เซอร์ของโฮสต์
    // (ต่างจาก dataset.name ด้านบนที่เซ็ตผ่าน property ของ JS ตรงๆ ซึ่งปลอดภัยอยู่แล้ว ไม่ต้อง escape)
    const oldRoleImages = {};
    container.querySelectorAll(".simple-row[data-id]").forEach((row) => {
        const img = row.querySelector(".srow-role-icon");
        if (img) oldRoleImages[row.dataset.id] = img;
    });

    container.innerHTML = nonHostPlayers.map((p, idx) => `
        <div class="simple-row ${!p.alive ? "dead" : ""}" data-id="${p.id}" data-name="${escapeHtml((p.name || "").toLowerCase())}" data-alive="${p.alive ? "1" : "0"}">
            <div class="simple-row-inner">
            <div class="srow-left">
                <span class="srow-name">${escapeHtml(p.name)}</span>
                <span class="srow-role" title="${p.role || "ยังไม่ได้รับบท"}">
                    ${
                        p.role
                        ? `<img class="srow-role-icon" src="${getRoleIcon(p.role)}" alt="${p.role}" onerror="this.style.display='none'">`
                        : "?"
                    }
                </span>
            </div>
            <div class="srow-status">
                <label class="toggle" title="มีชีวิต">
                    <input type="checkbox"
                        onchange="toggle('${p.id}','alive', this.checked)"
                        ${p.alive ? "checked" : ""}
                    >
                    <span class="toggle-icon" aria-hidden="true">❤️</span>
                    <span class="toggle-label">มีชีวิต</span>
                </label>
                <label class="toggle${(p.protected || protectAimIds.has(p.id)) ? " toggle-aimed-protect" : ""}" title="${protectAimIds.has(p.id) ? "กำลังถูกหมอ/บอดี้การ์ด/แม่มด/อันธพาลเลือกปกป้องอยู่ตอนนี้ (ยังไม่สรุปผล)" : "ปกป้อง"}">
                    <input type="checkbox"
                        onchange="toggle('${p.id}','protected', this.checked)"
                        ${p.protected ? "checked" : ""}
                    >
                    <span class="toggle-icon" aria-hidden="true">🛡️</span>
                    <span class="toggle-label">ปกป้อง</span>
                </label>
                ${(() => {
                    // เหมือนกริดหลัก: สีของ "เล็งฆ่า" เปลี่ยนตามอาชีพที่กำลังเล็ง
                    const aimRoleKey = aimedTargetIds.get(p.id);
                    const isAimed = p.killed || aimedTargetIds.has(p.id);
                    const aimClass = aimRoleKey ? ` toggle-aimed toggle-aimed-${aimRoleKey}` : (isAimed ? " toggle-aimed" : "");
                    const aimTitle = aimRoleKey
                        ? `กำลังถูก${AIM_SOURCE_LABELS[aimRoleKey] || "?"}เล็งฆ่าอยู่ตอนนี้ (ยังไม่สรุปผล)`
                        : "เล็งฆ่า";
                    return `
                <label class="toggle${aimClass}" title="${aimTitle}">
                    <input type="checkbox"
                        onchange="handleKillToggle('${p.id}', this.checked, this)"
                        ${isAimed ? "checked" : ""}
                    >
                    <span class="toggle-icon" aria-hidden="true">🎯</span>
                    <span class="toggle-label">เล็งฆ่า</span>
                </label>`;
                })()}
                <label class="toggle${(p.silenced || silenceAimIds.has(p.id)) ? " toggle-aimed-hint" : ""}" title="${silenceAimIds.has(p.id) ? "กำลังถูกยายขี้โมโหเลือกใบ้อยู่ตอนนี้ (ยังไม่ใบ้จริง รอสรุปผลตอนเช้า)" : "ใบ้"}">
                    <input type="checkbox"
                        onchange="toggle('${p.id}','silenced', this.checked)"
                        ${(p.silenced || silenceAimIds.has(p.id)) ? "checked" : ""}
                    >
                    <span class="toggle-icon" aria-hidden="true">🤐</span>
                    <span class="toggle-label">ใบ้</span>
                </label>
            </div>
            </div>
        </div>
    `).join("");

    // คืน node รูปอาชีพเดิมให้แต่ละแถวเมื่อ src ยังเหมือนเดิม
    container.querySelectorAll(".simple-row[data-id]").forEach((row) => {
        const oldImage = oldRoleImages[row.dataset.id];
        const newImage = row.querySelector(".srow-role-icon");
        if (oldImage && newImage) preserveExistingRoleImage(row, ".srow-role-icon", oldImage, newImage);
    });
}


// HOST CHAT TAB
let currentHostTab = "global";
let hostBadgeCounts = { global: 0, wolf: 0 };

function switchHostTab(tab) {
    currentHostTab = tab;

    // update tab active state
    document.getElementById("tabGlobal").className =
        "chat-tab" + (tab === "global" ? " active-global" : "");
    document.getElementById("tabWolf").className =
        "chat-tab" + (tab === "wolf" ? " active-wolf" : "");

    // show/hide boxes
    document.getElementById("chatBoxGlobal").classList.toggle("visible", tab === "global");
    document.getElementById("chatBoxWolf").classList.toggle("visible", tab === "wolf");

    // reset badge for active tab
    hostBadgeCounts[tab] = 0;
    document.getElementById(tab === "global" ? "badgeGlobal" : "badgeWolf").textContent = "0";

    // scroll to bottom of active box
    const box = document.getElementById(tab === "global" ? "chatBoxGlobal" : "chatBoxWolf");
    box.scrollTop = box.scrollHeight;
}

function sendHostMsg() {

    const text =
        document.getElementById(
            "hostMsg"
        ).value
        .trim();

    const type = currentHostTab;

    if (!text) return;

    socket.emit(
        "host_chat",
        {
            roomId,
            text,
            type
        }
    );

    document.getElementById(
        "hostMsg"
    ).value = "";

}

// ENTER SEND
document.getElementById("hostMsg").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        sendHostMsg();
    }
});

function appendChatMsg(data, silent) {

    const isWolf = data.type === "wolf";
    const boxId = isWolf ? "chatBoxWolf" : "chatBoxGlobal";
    const log = document.getElementById(boxId);

    const div = document.createElement("div");

    let cls = "msg ";
    if (data.type === "private") cls += "private";
    else if (data.isHost) cls += "host";
    else if (data.type === "wolf") cls += "wolf";
    else cls += "global";

    div.className = cls;

    const typeLabel =
        data.type === "private" ? "🟢 PRIVATE" :
        data.type === "wolf" ? "🔴 หมาป่า" :
        data.isHost ? "🟣 ผู้เล่าเรื่อง" :
        "🔵 แชทรวม";

    div.innerHTML = `
        <div class="mline">
            <span class="mname">${escapeHtml(data.name)}:</span>
            <span class="mtext">${escapeHtml(data.text)}</span>
        </div>
        <div class="mtype">${typeLabel}</div>
    `;

    log.appendChild(div);
    log.scrollTop = log.scrollHeight;

    // อัปเดต badge เฉพาะข้อความใหม่จริงๆ (ไม่นับตอน replay ประวัติ)
    if (!silent) {
        const tabKey = isWolf ? "wolf" : "global";
        if (currentHostTab !== tabKey) {
            hostBadgeCounts[tabKey] = (hostBadgeCounts[tabKey] || 0) + 1;
            const badgeEl = document.getElementById(tabKey === "wolf" ? "badgeWolf" : "badgeGlobal");
            badgeEl.textContent = hostBadgeCounts[tabKey];
        }
    }
}

socket.on("chat_message", (data) => { appendChatMsg(data, false); });

// รับประวัติแชทหมาป่าเมื่อโฮสต์ล็อกอินใหม่
// เซิร์ฟเวอร์ส่ง "ประวัติทั้งหมด" กลับมาซ้ำทุกครั้งที่ sync (host_login/request_sync/reconnect
// ซึ่งเกิดบ่อยมากบนมือถือ เช่น สลับแอป/ล็อกจอ) — ต้องเคลียร์กล่องเดิมก่อนเสมอ ไม่งั้นข้อความจะซ้ำ
// ซ้อนกันเพิ่มขึ้นเรื่อยๆ ทุกครั้งที่ sync (บั๊กเดิม: ไม่เคลียร์ ทำให้ "เริ่มคืนที่ 1" และข้อความอื่นๆ
// ขึ้นซ้ำหลายรอบ) — แก้ให้ตรงกับฝั่งผู้เล่น (player.main.js) ที่เคลียร์ก่อน render อยู่แล้ว
socket.on("wolf_chat_history", (history) => {
    document.getElementById("chatBoxWolf").innerHTML = "";
    (history || []).forEach(msg => appendChatMsg(msg, true));
});

// รับประวัติแชทรวมเมื่อโฮสต์ล็อกอินใหม่ (เหตุผลเดียวกับข้างบน)
socket.on("global_chat_history", (history) => {
    document.getElementById("chatBoxGlobal").innerHTML = "";
    (history || []).forEach(msg => appendChatMsg(msg, true));
});

// รับข้อความ [โฮสต์เท่านั้น] — เดิมใช้ตอน sync/reconnect แต่ตอนนี้เซิร์ฟเวอร์รวมเข้ากับ
// global_chat_history เป็นไทม์ไลน์เดียวเรียงตาม seq จริงแล้ว (แก้บั๊กลำดับแชทสลับตอนล็อกอินใหม่ —
// ดู mergedGlobalAndPrivateHistory ฝั่ง server.js) จึงไม่ถูกยิงจากเซิร์ฟเวอร์อีกต่อไป คงไว้เผื่ออนาคต
socket.on("private_chat_history", (history) => {
    (history || []).forEach(msg => appendChatMsg(msg, true));
});

// TOGGLE VOTE MODE
let voteMode = false;
function toggleVoteMode() {
    socket.emit("toggle_vote_mode", { roomId });
}

// FORCE VOTE ALL (โหมดผู้ทดสอบเท่านั้น — ปุ่มถูกซ่อนไว้นอกโหมดผู้ทดสอบ ดู renderVotePopup)
// แอดมินกดปุ่ม "บังคับโหวต" ที่แถวของผู้เล่นคนใดคนหนึ่งในป๊อปอัปโหวต แล้วบังคับให้ทุกคนที่ยังมีชีวิต
// โหวตคนนั้นทันที — ดูตรรกะจริงที่ handler ฝั่ง server.js (force_vote_all)
function forceVoteAll(targetId) {
    socket.emit("force_vote_all", { roomId, targetId });
}

// ===== เวลานับถอยหลังของรอบโหวต (แสดงในป๊อปอัปโหมดโหวตฝั่งโฮสต์) =====
// อิงจาก room.voteDeadline (timestamp ที่ server กำหนดไว้) — server เป็นคนตัดสินจริง
// ฝั่งนี้แค่นับโชว์ UI ให้เห็นวิ่งลงทุกวินาที ไม่ใช่ตัวตัดสินว่าหมดเวลาเมื่อไหร่
let hostVoteCountdownInterval = null;
let hostVoteCountdownDeadline = null;

function stopHostVoteCountdown() {
    if (hostVoteCountdownInterval) {
        clearInterval(hostVoteCountdownInterval);
        hostVoteCountdownInterval = null;
    }
    hostVoteCountdownDeadline = null;
    const el = document.getElementById("modePopupCountdown");
    if (el) el.classList.add("hidden");
}

function renderHostVoteCountdown() {
    const el = document.getElementById("modePopupCountdown");
    if (!el || !hostVoteCountdownDeadline) return;
    const remainSec = Math.max(0, Math.ceil((hostVoteCountdownDeadline - Date.now()) / 1000));
    el.textContent = `⏱️ เหลือเวลา ${remainSec} วิ`;
    el.classList.toggle("urgent", remainSec <= 5);
    if (remainSec <= 0) stopHostVoteCountdown();
}

function startHostVoteCountdown(deadline) {
    const el = document.getElementById("modePopupCountdown");
    if (!deadline) { stopHostVoteCountdown(); return; }
    if (el) el.classList.remove("hidden");
    if (hostVoteCountdownDeadline === deadline && hostVoteCountdownInterval) return; // deadline เดิม ไม่ต้องรีสตาร์ท
    stopHostVoteCountdown();
    if (el) el.classList.remove("hidden");
    hostVoteCountdownDeadline = deadline;
    renderHostVoteCountdown();
    hostVoteCountdownInterval = setInterval(renderHostVoteCountdown, 250);
}

// TOGGLE ROLE CARD (เปิด/ปิดการ์ดตั้งค่าบทบาท)
function toggleRoleCard() {

    const body = document.getElementById("roleCardBody");
    const btn = document.getElementById("roleCollapseBtn");
    const isCollapsed = body.classList.contains("is-collapsed");

    if (isCollapsed) {
        // เปิด: ขยายกลับไปตามความสูงจริงของเนื้อหา
        body.classList.remove("is-collapsed");
        body.style.maxHeight = body.scrollHeight + "px";
        btn.classList.remove("is-collapsed");
        btn.setAttribute("aria-expanded", "true");

        body.addEventListener("transitionend", function clearMaxHeight(e) {
            if (e.propertyName === "max-height") {
                body.style.maxHeight = "none";
                body.removeEventListener("transitionend", clearMaxHeight);
            }
        });
    } else {
        // ปิด: ล็อกความสูงปัจจุบันก่อน แล้วค่อยยุบลงเป็น 0 เพื่อให้มีอนิเมชัน
        body.style.maxHeight = body.scrollHeight + "px";

        requestAnimationFrame(() => {
            body.classList.add("is-collapsed");
            body.style.maxHeight = "0px";
        });

        btn.classList.add("is-collapsed");
        btn.setAttribute("aria-expanded", "false");
    }

}

// ===== PLAYER BOARD FOCUS MODE =====
// ขยายเฉพาะแผงจัดการผู้เล่นให้กินพื้นที่ viewport โดยไม่ใช้ Fullscreen API ของเบราว์เซอร์
// จึงไม่ขึ้น permission/เต็มจอระบบ และเหมาะกับ Safari/iPad Split View มากกว่า
let playerFocusMode = false;

function syncPlayerFocusButton() {
    const btn = document.getElementById("playerFocusBtn");
    if (!btn) return;
    const active = !!playerFocusMode;
    btn.textContent = active ? "✕ ออกจากเต็มจอ" : "⛶ เต็มจอ";
    btn.setAttribute("aria-pressed", active ? "true" : "false");
    btn.setAttribute("aria-expanded", active ? "true" : "false");
    btn.setAttribute(
        "aria-label",
        active ? "ออกจากโหมดเต็มพื้นที่จัดการผู้เล่น" : "ขยายพื้นที่จัดการผู้เล่นเต็มจอ"
    );
    btn.title = active ? "ออกจากโหมดเต็มพื้นที่จัดการผู้เล่น" : "ขยายพื้นที่จัดการผู้เล่นเต็มจอ";
}

function setPlayerFocusMode(active) {
    playerFocusMode = !!active;
    document.documentElement.classList.toggle("host-player-focus", playerFocusMode);
    document.body.classList.toggle("host-player-focus", playerFocusMode);
    syncPlayerFocusButton();

    if (!playerFocusMode) {
        // ให้กริดกลับไปวัดขนาดหลังยุบ layout เพื่อไม่ทิ้ง scale จากโหมดเต็มจอ
        if (typeof scheduleCardFit === "function") scheduleCardFit();
        return;
    }

    // focus mode ไม่ควรค้างอยู่ใน setup ซึ่งไม่มี player board จริงให้บริหาร
    if (document.body.classList.contains("setup-mode")) {
        playerFocusMode = false;
        document.documentElement.classList.remove("host-player-focus");
        document.body.classList.remove("host-player-focus");
        syncPlayerFocusButton();
        return;
    }

    requestAnimationFrame(() => {
        if (typeof refreshGridColsForBreakpoint === "function") refreshGridColsForBreakpoint();
        if (typeof scheduleCardFit === "function") scheduleCardFit();
    });
}

function togglePlayerFocusMode() {
    setPlayerFocusMode(!playerFocusMode);
}

// ESC ออกจากโหมดขยายได้ทันที โดยไม่แตะ modal ของเกม
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && playerFocusMode) {
        const activeModal = document.querySelector(".vote-modal-overlay:not(.hidden)");
        if (!activeModal) {
            event.preventDefault();
            setPlayerFocusMode(false);
        }
    }
});

syncPlayerFocusButton();

// ===== ปรับจำนวนคอลัมน์กริดผู้เล่น (แทนที่ช่องพิมพ์ค้นหาชื่อเดิม) =====
// ค่าเริ่มต้นทุกขนาดจอเป็น "อัตโนมัติ": CSS auto-fit จะเพิ่ม/ลดคอลัมน์ทันทีตามพื้นที่จริง
// ไม่ผูกกับจำนวนผู้เล่นหรือ breakpoint. ปุ่ม preset/ช่องตัวเลขยังใช้บังคับคอลัมน์แบบ manual ได้.

const GRID_COLS_DEFAULTS = { mobile: null, tablet: null, "tablet-landscape-full": null, desktop: null };
let gridColsByBreakpoint = { ...GRID_COLS_DEFAULTS };
let currentGridBreakpoint = null;

function getGridBreakpoint() {
    const w = window.innerWidth;
    if (w <= 480) return "mobile";
    if (w <= 1279) {
        const landscape = window.matchMedia("(orientation: landscape)").matches;
        const roleHidden = !!document.querySelector(".layout.role-hidden");
        return (landscape && roleHidden) ? "tablet-landscape-full" : "tablet";
    }
    return "desktop";
}

// ขนาดมาตรฐานภายในของการ์ดผู้เล่น (canvas อ้างอิง 220×220px; กรอบภายนอกยังเป็นสี่เหลี่ยมตามพื้นที่จริง) กำหนดไว้ที่ max-width ของ .player/.simple-row
// ใน host.css โดยตรง (CSS ล้วน ไม่ต้องพึ่ง JS คำนวณความกว้างอีกต่อไป) ถ้าจะแก้ขนาดมาตรฐาน แก้ที่ CSS ที่เดียว
// ย่อเนื้อหาข้างในการ์ดผู้เล่นทุกใบ (ชั้น .player-inner/.simple-row-inner) ให้พอดี "ทั้งกว้างและสูง"
// ของกรอบสี่เหลี่ยมจัตุรัสของตัวเอง (.player/.simple-row ที่บังคับ aspect-ratio:1/1 ไว้แล้วด้วย CSS
// ล้วนๆ ไม่ต้องใช้ JS คำนวณความกว้าง — ดูคอมเมนต์เต็มที่ .player ใน host.css)
//
// ทำไมต้องคำนวณทีละใบแยกกัน (ไม่ใช้ค่าเดียวทั้งกริดแบบเดิม): เนื้อหาแต่ละการ์ดยาวไม่เท่ากัน (การ์ดที่มี
// ความสามารถพิเศษหลายบรรทัด เช่น 🔯 ผู้นำลัทธิ/🗡️ โจร ยาวกว่าการ์ดบอทเปล่าๆ มาก) ถ้าย่อเท่ากันหมดตาม
// คอลัมน์อย่างเดียว การ์ดที่เนื้อหายาวจะยังล้นกรอบอยู่ดี ต้องวัดความสูงจริงที่ต้องใช้ของแต่ละใบแล้วย่อ
// เฉพาะใบนั้นให้พอดีกรอบตัวเอง
//
// วิธีวัด: รีเซ็ต zoom เป็น 1 ก่อน (อ่านความสูงธรรมชาติที่ความกว้าง = กรอบซึ่ง CSS จัดให้ถูกอยู่แล้ว)
// แล้ว zoom = min(1, ขนาดกรอบ ÷ ความสูงที่วัดได้) — ไม่มีขั้นต่ำ ย่อได้เรื่อยๆ ตามจริง (เหลือ Math.max
// กับ epsilon เล็กๆ กันค่า CSS ใช้งานไม่ได้ทางเทคนิคเท่านั้น ไม่ใช่ขนาดต่ำสุดที่ตั้งใจออกแบบ) เพดานที่ 1
// กันไม่ให้ขยายเกินขนาดมาตรฐานเวลาเนื้อหาสั้นกว่ากรอบเยอะ (เช่นบอทเปล่าๆ ในกรอบใหญ่)
//
// แบ่ง 3 รอบแยกจาก reset/อ่าน/เขียน (ไม่ทำสลับกันทีละใบ) เพื่อกัน forced synchronous layout ซ้ำๆ
// หลายรอบตอนมีการ์ดเยอะ (เช่น 20 คอลัมน์ x หลายแถว) — อ่าน layout ทีเดียวหลัง reset ครบทุกใบ
const CARD_BASE_SIZE = 220;
let cardFitFrame = 0;
let cardFitObserver = null;

/*
 * Uniform card scale v3
 * ---------------------
 * สำคัญ: ห้ามคำนวณ scale จากความยาวข้อความของผู้เล่นแต่ละคนอีกแล้ว
 * เพราะจะทำให้การ์ดที่มีข้อความมาก/น้อยมีขนาดภายในไม่เท่ากัน ทั้งที่กรอบเท่ากัน
 *
 * ทุกการ์ดใช้ canvas อ้างอิง 220x220 เท่ากัน แล้ว scale ทั้ง canvas ด้วยตัวคูณเดียว
 * ตามความกว้างของกรอบจริง:
 *   220px -> 1.000
 *   160px -> 0.727
 *   120px -> 0.545
 *    80px -> 0.364
 *    60px -> 0.273
 *    40px -> 0.182
 *
 * ไม่มี minimum และไม่มีการซ่อน/เปลี่ยนรูปแบบตาม breakpoint
 * ทุกองค์ประกอบใต้ .player-inner จึงหด/ขยายด้วย transform เดียวกันจริง ๆ
 */
function updateAllCardFit() {
    // Uniform scale applies only to the normal square player cards.
    // The "ดูอย่างง่าย" view is intentionally a compact rectangular list and
    // must never inherit the square-card scale/height rules.
    const cards = Array.from(document.querySelectorAll('#list .player[data-id]'));
    if (!cards.length) return;

    const widths = cards
        .map((card) => card.getBoundingClientRect().width)
        .filter((w) => w > 0);
    if (!widths.length) return;

    const cardWidth = Math.min(...widths);
    const scale = Math.min(1, cardWidth / CARD_BASE_SIZE);

    cards.forEach((card) => {
        card.style.setProperty('--card-scale', scale.toFixed(6));
    });

    // Never leave a previous grid scale on simple-list rows.
    document.querySelectorAll('#listSimple .simple-row[data-id]').forEach((row) => {
        row.style.removeProperty('--card-scale');
    });
}

function scheduleCardFit() {
    cancelAnimationFrame(cardFitFrame);
    cardFitFrame = requestAnimationFrame(() => {
        cardFitFrame = 0;
        updateAllCardFit();
    });
}

// ขนาดกรอบเปลี่ยนได้จากการหมุนจอ, resize, เปิด/ปิดคอลัมน์ซ้าย หรือการเปลี่ยนจำนวนคอลัมน์
// รวมถึงการเพิ่ม/ลบการ์ดแบบ live — observe การ์ดใหม่ทุกครั้งเพื่อไม่ต้องรีเว็บให้ scale ถูกต้อง.
if (typeof ResizeObserver !== 'undefined') {
    cardFitObserver = new ResizeObserver(() => scheduleCardFit());
}

function observeHostPlayerCards() {
    if (!cardFitObserver) return;
    document.querySelectorAll('#list .player, #listSimple .simple-row').forEach((card) => {
        try { cardFitObserver.observe(card, { box: 'border-box' }); } catch (e) { cardFitObserver.observe(card); }
    });
}

window.addEventListener('load', () => {
    observeHostPlayerCards();
    scheduleCardFit();
}, { once: true });

if (typeof MutationObserver !== 'undefined') {
    const listEl = document.getElementById('list');
    if (listEl) {
        try {
            const mo = new MutationObserver(() => {
                observeHostPlayerCards();
                scheduleCardFit();
            });
            mo.observe(listEl, { childList: true });
        } catch (e) {}
    }
}

function applyGridCols(n) {
    const list = document.getElementById("list");
    const listSimple = document.getElementById("listSimple");
    // แก้บั๊ก: N คอลัมน์ตายตัว (เช่น preset "5" บนไอแพด) ทำให้ตอนมีผู้เล่น/บอทน้อยกว่า N คน
    // การ์ดที่มีอยู่ถูกอัดให้แคบเท่ากับ 1/N ของพื้นที่ทั้งหมด ทั้งที่เหลือพื้นที่ว่างเยอะ — ครอบเพดาน
    // คอลัมน์ไว้ที่ "จำนวนผู้เล่นจริงในกริดตอนนี้" ด้วย ไม่เกิน N ที่โฮสต์ตั้งไว้ ผู้เล่น/บอทน้อยก็ได้
    // การ์ดใหญ่เต็มพื้นที่ พอจำนวนเพิ่มขึ้นอีกค่อยขยับกลับไปคอลัมน์ตาม preset ตามปกติ
    // (เรียกซ้ำทุกครั้งที่รายชื่อผู้เล่นอัปเดต ดูจุดเรียกใน room_update)
    const count = Math.max(
        list ? list.querySelectorAll(".player[data-id]").length : 0,
        listSimple ? listSimple.querySelectorAll(".simple-row[data-id]").length : 0
    );
    const effective = (n && count > 0) ? Math.min(n, count) : n;
    const cols = effective ? `repeat(${effective}, minmax(0, 1fr))` : "";
    if (list) {
        if (effective) list.style.gridTemplateColumns = cols;
        else list.style.removeProperty("grid-template-columns");
    }
    if (listSimple) {
        if (effective) listSimple.style.gridTemplateColumns = cols;
        else listSimple.style.removeProperty("grid-template-columns");
    }
    // ย่อเนื้อหาแต่ละการ์ดให้พอดีกรอบจัตุรัสของตัวเอง (ทั้งกว้างและสูง) — ดูคอมเมนต์เต็มที่ updateAllCardFit
    scheduleCardFit();
}


function syncGridColsUI(n) {
    const input = document.getElementById("gridColsInput");
    if (input) input.value = n || "";
    document.querySelectorAll(".gridColsBtn").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.cols) === n);
    });
}

function refreshGridColsForBreakpoint() {
    const bp = getGridBreakpoint();
    if (bp === currentGridBreakpoint) return; // จอ/แนวจอเดิม ไม่ต้องรีเซ็ตค่าที่ผู้ใช้ปรับไว้
    currentGridBreakpoint = bp;
    const n = gridColsByBreakpoint[bp];
    syncGridColsUI(n);
    applyGridCols(n);
}

function setGridColsPreset(n) {
    if (!currentGridBreakpoint) currentGridBreakpoint = getGridBreakpoint();
    gridColsByBreakpoint[currentGridBreakpoint] = n;
    syncGridColsUI(n);
    applyGridCols(n);
}

function onGridColsInputChange(value) {
    if (!currentGridBreakpoint) currentGridBreakpoint = getGridBreakpoint();
    const n = parseInt(value, 10);
    const valid = value !== "" && !isNaN(n) && n >= 1;
    // แก้บั๊ก: ช่อง #gridColsInput มี min="1" max="20" ใน HTML แต่ attribute max ไม่บล็อกค่าที่พิมพ์เข้ามาตรงๆ
    // (บล็อกแค่ปุ่มลูกศร increment/decrement เท่านั้น) พิมพ์เลขเกิน 20 ได้อิสระ (เช่น 50, 999) แล้วโดน
    // ส่งตรงเข้า repeat(n, 1fr) ผ่าน applyGridCols() ทำให้การ์ดผู้เล่นทุกใบถูกบีบแคบจนแทบมองไม่เห็น/ดูไม่ได้
    // เลยต้อง clamp ค่าให้อยู่ในช่วง 1-20 เดียวกับที่ประกาศไว้ใน HTML ก่อนเสมอ แล้วดึงเลขในช่องกลับมาให้ตรงค่า
    // ที่ใช้จริงด้วย ไม่งั้นผู้ใช้จะเห็นเลขในช่องไม่ตรงกับคอลัมน์ที่แสดงจริง
    const clamped = valid ? Math.min(Math.max(n, 1), 20) : null;
    const input = document.getElementById("gridColsInput");
    if (input && clamped !== null && clamped !== n) input.value = clamped;
    gridColsByBreakpoint[currentGridBreakpoint] = clamped;
    document.querySelectorAll(".gridColsBtn").forEach((btn) => {
        btn.classList.toggle("active", clamped !== null && Number(btn.dataset.cols) === clamped);
    });
    applyGridCols(clamped);
}

refreshGridColsForBreakpoint();
window.addEventListener("resize", refreshGridColsForBreakpoint);
window.addEventListener("orientationchange", refreshGridColsForBreakpoint);
window.addEventListener("resize", scheduleCardFit, { passive: true });
window.addEventListener("orientationchange", scheduleCardFit, { passive: true });
window.addEventListener("pageshow", scheduleCardFit, { passive: true });
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleCardFit(); });

// initial empty-state render
renderRoles();
updateHostControlChrome({ started:false, gameOver:false, config: roleConfig, players:[] });
updateNightFlowButtons({ started: false, isNight: false });

// ===== CHAT PLACEMENT =====
// ตั้งแต่รอบ UI นี้เป็นต้นไป #rightCol เป็นเจ้าของทั้ง Player Board และ Live Chat โดยตรง
// ไม่ย้ายการ์ดแชทไป #leftCol ตาม orientation อีกแล้ว เพราะทำให้ hierarchy เปลี่ยนกลางหน้า
// และทำให้แท็บเล็ตบางขนาดดูไม่สม่ำเสมอ/แชทไปอยู่คอลัมน์ที่กำลังซ่อนอยู่ได้
(function () {
    function keepChatInRightCol() {
        var chatCard = document.getElementById("chatCard");
        var rightCol = document.getElementById("rightCol");
        if (!chatCard || !rightCol) return;
        if (chatCard.parentElement !== rightCol) rightCol.appendChild(chatCard);
    }

    keepChatInRightCol();
    window.addEventListener("resize", keepChatInRightCol, { passive: true });
    window.addEventListener("orientationchange", keepChatInRightCol, { passive: true });
})();

