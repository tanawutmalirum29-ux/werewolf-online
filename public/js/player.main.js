// auth: แนบตัวตนห้องผู้ทดสอบเดิม (ถ้ามี) ให้ server เช็คตอน handshake — ดู wwServerControl.roomIdentityAuth
// ใน shared.server-control.js (แก้บั๊ก: ผู้เล่นในห้องผู้ทดสอบที่ไม่ได้ถือบัตร tp เอง ถ้า socket หลุด
// (พับจอมือถือ/เน็ตสะดุด/รีเฟรชหน้า) ตอนเซิร์ฟเวอร์หลักปิดอยู่ ต่อกลับไม่ได้เลย ทั้งที่ห้องผู้ทดสอบควรเล่นต่อได้ปกติ)
const playerSocketAuth = Object.assign(
    {},
    (window.wwServerControl && window.wwServerControl.roomIdentityAuth()) || {},
    (() => {
        // Tester/bot tabs may arrive without the HttpOnly ww_tp cookie (for example when
        // the tab was opened by window.open() and the CDN served the HTML from cache).
        // The tester pass is already a short-lived, server-signed launch credential; send
        // it only in the Socket.IO handshake so the server can authenticate tester mode
        // before join_room. Never put it into ordinary event payloads or diagnostics.
        try {
            const tp = new URLSearchParams(window.location.search).get("tp");
            return tp ? { testerPass: tp } : {};
        } catch (_) {
            return {};
        }
    })()
);
const socket = io({ auth: playerSocketAuth });

socket.on("serverInfo", function (info) {
    if (window.wwSetServerVersion) window.wwSetServerVersion(info && info.version);
});
// แอดมินกดล้างข้อมูลเกมทั้งหมด (ดู shared.reset-guard.js) — ล้างตัวตนในเครื่องนี้แล้วกลับหน้าแรกทันที
socket.on("force_reset", function (d) {
    if (window.wwApplyResetEpoch) window.wwApplyResetEpoch(d && d.epoch);
});
// แอดมินกดปุ่มในแท็บ "จัดการระบบ" (ดู shared.server-control.js): บังคับรีโหลด / ปิดเซิร์ฟเวอร์ (จอเต็ม "เซิร์ฟเวอร์กำลังปิด")
socket.on("force_reload", function (d) {
    playerBrowserExitServerClosed = true;
    playerBrowserExitGuardState(false, "force_reload");
    if (window.wwServerControl) window.wwServerControl.onForceReload(d);
});
socket.on("server_closed", function (d) {
    playerBrowserExitServerClosed = true;
    playerBrowserExitGuardState(false, "server_closed");
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
// กันหน้า HTML เก่าที่แคชค้าง (ยังไม่มี <script shared.server-control.js>) จับคู่กับ JS ใหม่ตัวนี้ — ถ้าไม่มี wwImg ให้ใช้แบบเดิมไปก่อน
if (typeof window.wwImg !== "function") {
    // Compatibility for stale HTML must still be S3/CDN-only; never fall back to /images on the game origin.
    window.wwImg = function (p) {
        var base = typeof window.WW_IMG_BASE === "string" ? window.WW_IMG_BASE : "";
        return base ? base + p : "";
    };
}

function selectTarget(targetId) {
    if (!currentRoomId) return;
    socket.emit("select_target", { roomId: currentRoomId, targetId });
}

let joined = false;
let myRole = "";
let mySilenced = false;
let gameOverConfirmed = false; // กดดำเนินการต่อแล้วหรือยังในรอบ gameOver นี้
let gameOverCountdownTimer = null;
let myAlive = true;
let myIsBot = false; // เฉพาะโหมดผู้ทดสอบ — sync จาก room_update ทุกครั้ง ใช้เช็คใน dblclick listener ของ #players
                      // (ดับเบิลแทปการ์ดตัวเองเพื่อคืนความเป็นบอท — ดู releaseBotAndReturn ด้านล่าง)
let isNight = false;
let currentChatTab = "global";
let myHuntTargetId = null; // ID ของเป้าหมายนักล่าหัว
let shieldModeActive = false; // กำลังอยู่โหมดเลือกวางโล่ (หมาป่าผู้พิทักษ์) อยู่หรือไม่
let protectModeActive = false; // กำลังอยู่โหมดเลือกยาป้องกัน (แม่มด) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางคืน
let silenceModeActive = false; // กำลังอยู่โหมดเลือกใบ้ (ยายขี้โมโห) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางคืน
let wolfCubModeActive = false; // กำลังอยู่โหมดเลือกเป้าลากตาย (ลูกหมาป่า) อยู่หรือไม่ — ใช้ได้ตลอดเวลา ทั้งกลางวัน/กลางคืน
let loudmouthModeActive = false; // กำลังอยู่โหมดเลือกเป้า (เด็กขี้โวยวาย) อยู่หรือไม่ — ใช้ได้ตลอดเวลา ทั้งกลางวัน/กลางคืน (คืนแรกใช้ไม่ได้)
let detectivePendingFirstId = null; // นักสืบ: เก็บ "คนที่ 1" ที่แตะเลือกไว้แล้ว รอแตะคนที่ 2 เพื่อยิงผลเทียบทีมพร้อมกัน
let detectivePendingSecondId = null; // นักสืบ: เก็บ "คนที่ 2" ระหว่างช่วงหน่วงเวลาสั้นๆ (โชว์ 🔍 ก่อนเปิดผล =/≠)
const DETECTIVE_REVEAL_DELAY_MS = 700; // ระยะเวลาที่โชว์ไอคอน 🔍 ค้างไว้ก่อนยิง detective_scout จริง
// กามเทพ/ผู้ยุยง: เก็บคนที่ 1/2 ที่แตะเลือกไว้ — ต่างจากนักสืบตรงที่ค้างอยู่ต่อเนื่อง "ไม่ยิงแล้วเคลียร์
// ทิ้งทันที" อีกต่อไป (เดิมเคยยิงแล้วรีเซ็ตเป็น null ทันทีหลังหน่วงเวลาสั้นๆ ทำให้เปลี่ยนใจไม่ได้)
// ตอนนี้ทุกครั้งที่แตะเลือก/ยกเลิกจะยิง cupid_pair/instigator_pair ไปอัปเดตฝั่งเซิร์ฟเวอร์ทันที (ยังไม่
// ล็อกอะไรจนกว่าจะถึงเช้า) แตะการ์ดที่เลือกไว้อยู่แล้วซ้ำ (คนแรกหรือคนที่สอง) เพื่อยกเลิกเฉพาะคนนั้น
// แล้วเลือกคนใหม่แทนได้ ตราบใดที่ยังเป็นกลางคืนอยู่ (ยังไม่เช้า) — ค้างอยู่จนกว่าจะสรุปผลตอนเช้าจริง
let cupidPendingFirstId = null;
let cupidPendingSecondId = null;
let instigatorPendingFirstId = null;
let instigatorPendingSecondId = null;

// ===== เวลานับถอยหลังของรอบโหวต (แสดงในแบนเนอร์โหมด) =====
// อิงจาก roomData.voteDeadline (timestamp ที่ server กำหนดไว้) — server เป็นคนตัดสินจริง
// ฝั่งนี้แค่นับโชว์ UI ให้เห็นวิ่งลงทุกวินาที ไม่ใช่ตัวตัดสินว่าหมดเวลาเมื่อไหร่
let voteCountdownInterval = null;
let voteCountdownDeadline = null;

function stopVoteCountdown() {
    if (voteCountdownInterval) {
        clearInterval(voteCountdownInterval);
        voteCountdownInterval = null;
    }
    voteCountdownDeadline = null;
    const el = document.getElementById("playersSubCountdown");
    if (el) el.textContent = "";
}

function renderVoteCountdown() {
    const el = document.getElementById("playersSubCountdown");
    if (!el || !voteCountdownDeadline) return;
    const remainSec = Math.max(0, Math.ceil((voteCountdownDeadline - Date.now()) / 1000));
    el.textContent = `⏱️ เหลือเวลา ${remainSec} วิ`;
    if (remainSec <= 0) stopVoteCountdown();
}

function startVoteCountdown(deadline) {
    if (voteCountdownDeadline === deadline && voteCountdownInterval) return; // deadline เดิม ไม่ต้องรีสตาร์ท
    stopVoteCountdown();
    voteCountdownDeadline = deadline;
    renderVoteCountdown();
    voteCountdownInterval = setInterval(renderVoteCountdown, 250);
}
let curseModeActive = false; // กำลังอยู่โหมดเลือกเป้าร่ายเวท (หมาป่านักเวท) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางวัน
let gunModeActive = false; // กำลังอยู่โหมด "เล็งปืน" (ศาลเตี้ย) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางวัน
let peekModeActive = false; // กำลังอยู่โหมด "ดูบทบาท" (ศาลเตี้ย) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางวัน
let holyWaterModeActive = false; // กำลังอยู่โหมด "ปาน้ำมนต์" (นักบวช) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางวัน
let poisonModeActive = false; // กำลังอยู่โหมด "โยนยาพิษ" (แม่มด) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางคืน
let cultRecruitModeActive = false; // กำลังอยู่โหมด "ชักชวนเข้าลัทธิ" (ผู้นำลัทธิ) อยู่หรือไม่ — ใช้ได้เฉพาะตอนกลางคืน
let cultSacrificeModeActive = false; // กำลังอยู่โหมด "สังเวยสมาชิกลัทธิเพื่อฆ่า" อยู่หรือไม่ — ต้องแตะ 2 คน (สมาชิกที่จะสังเวย แล้วค่อยแตะเป้าที่จะฆ่า)
let cultSacrificePendingMemberId = null; // คนที่ 1 ที่แตะเลือกไว้แล้วในโหมดสังเวย (ต้องเป็นสมาชิกลัทธิของตัวเอง) รอแตะคนที่ 2
// (ไม่มีตัวแปรโหมดสำหรับโจร/ผู้สมรู้ร่วมคิดแล้ว — แตะการ์ดเลือกเป้าได้ตรงๆ เลย เหมือนหมอ/บอดี้การ์ด/ยายขี้โมโห
// ไม่ต้องกดปุ่มเข้าโหมดก่อน ดู amIBanditLeader/amIBanditAccomplice ในฟังก์ชัน renderPlayerGrid)
let suggestedRoomData = null; // ห้องล่าสุดที่เปิดอยู่ (จาก server)
let currentRoomId = null; // ห้องที่ join อยู่ตอนนี้ ใช้ตอนเชื่อมต่อใหม่อัตโนมัติ
// ห้องที่ "ส่ง join_room ไปแล้วแต่ยังไม่ได้รับ ack กลับมา" — กันบั๊กที่เน็ตสะดุด/หลุด-ต่อใหม่
// ระหว่างรอ ack พอดี ทำให้ ack เดิมหลุดหายไปกับ socket เก่าตลอดกาล (ไม่มีวันเรียก callback แล้ว)
// จน UI ค้างอยู่หน้า "กำลังเข้าห้อง..." ทั้งที่ server รับ join เข้าไปในห้องเรียบร้อยแล้วจริงๆ
// (ฝั่งโฮสต์เห็นผู้เล่นแล้วเพราะ room_update broadcast ไปถึงเขาได้ปกติ ไม่ได้พึ่ง ack)
// ใช้คู่กับ room_update handler ด้านล่าง เป็นทางสำรองให้ตรวจเจอว่า "จริงๆ เข้าห้องสำเร็จแล้ว"
// จากตัวข้อมูลห้องเอง แทนที่จะพึ่ง ack เพียงทางเดียว และคู่กับ connect handler ให้ join ซ้ำ
// อัตโนมัติได้แม้ ack ของรอบแรกจะยังไม่ทันมาก่อนหลุดการเชื่อมต่อ
let pendingJoinRoomId = null;

// ===== โหมดผู้ทดสอบ =====
// ปกติ token ผูกกับ localStorage ซึ่ง "ใช้ร่วมกันทั้งเบราว์เซอร์" ทุกแท็บ
// เลยทำให้เปิดหลายแท็บบนมือถือเครื่องเดียวแล้วต่อห้องเดียวกัน กลายเป็นผู้เล่นคนเดิมซ้ำ (reconnect)
// โหมดผู้ทดสอบ (?tester=1 จากปุ่มในหน้า admin.html แท็บ ⚙️ จัดการระบบ) จะสลับไปใช้ sessionStorage แทน
// ซึ่ง "แยกอิสระต่อแท็บ/หน้าต่าง" — เปิดกี่แท็บก็ได้คนละ token กัน เปิดเป็นผู้เล่นคนละคนได้จริง
// แต่ยังรีเฟรชหน้าในแท็บเดิมได้โดยไม่หลุด เพราะ sessionStorage อยู่รอดผ่านการรีเฟรช
// (จะหลุดก็ตอนปิดแท็บ/หน้าต่างนั้นไปจริงๆ หรือโดนเตะ/ห้องยุบ เหมือนผู้เล่นปกติ)
const urlParams = new URLSearchParams(window.location.search);
// เช็คจาก URL อย่างเดียว (เหมือน host.html) — ห้ามเช็ค sessionStorage ประกอบด้วย
// เพราะ sessionStorage ค้างอยู่ตลอดอายุแท็บ ทำให้พอเข้าโหมดผู้ทดสอบครั้งเดียว
// แล้วกลับมาเปิดลิงก์ปกติ (ไม่มี ?tester=1) ในแท็บเดิมซ้ำ ก็ยังติดโหมดผู้ทดสอบอยู่ดี
// (URL เองมี tester=1 ค้างอยู่แล้วจาก history.replaceState ด้านล่าง กรณีมือถือ discard แท็บ
// จึงไม่จำเป็นต้องพึ่ง sessionStorage เป็น fallback อีกชั้น)
const TESTER_MODE = urlParams.get("tester") === "1";
// แท็บนี้คือ "จอบอทที่โฮสต์กำลังเข้าสิง" ไม่ใช่ผู้เล่นทดสอบจริง
// ถ้าห้องปิด บอทไม่มีตัวตนที่ต้องรอห้องต่อ จึงต้องปิดแท็บกลับไปยังจอโฮสต์ทันที
const BOT_CONTROLLED_TAB = TESTER_MODE && !!urlParams.get("jr") && !!urlParams.get("t");
const TESTER_RETURN_URL = "admin.html";
const ww_store = TESTER_MODE ? sessionStorage : localStorage;

// ===== PREVIOUS ROOM DECISION =====
// เมื่อเปิดหน้าใหม่หลังเคยเข้าห้อง ห้าม auto-rejoin ห้องเดิมทันที
// ต้องตรวจสถานะจาก server แล้วให้ผู้เล่นเลือก "กลับเกมเดิม" หรือ "หาห้องใหม่" ก่อน
let previousRoomDecisionPending = !!ww_store.getItem("ww_joinedRoom");
let previousRoomCheckInFlight = false;
let previousRoomCheckDone = false;
let previousRoomResumeState = null;
let abandonGameInFlight = false;

// ===== BROWSER TAB CLOSE GUARD =====
// ครอบคลุมการปิดแท็บ/รีเฟรช/navigation ตอนอยู่ในห้อง. browser จะแสดง native dialog
// หลังมี user interaction; pagehide ที่ตามหลังการกดยืนยันจะส่ง beacon ให้ server ดำเนินการออก
// โดยมี grace สั้น ๆ เพื่อไม่ให้ reload/reconnect ด้วย token เดิมกลายเป็นการออกเกม.
let playerBrowserExitGuardActive = false;
let playerBrowserExitRequested = false;
let playerBrowserExitSignalSent = false;
let playerBrowserExitServerClosed = false;

function playerBrowserExitGuardState(active, reason) {
    playerBrowserExitGuardActive = !!active;
    if (!active) {
        playerBrowserExitSignalSent = false;
        playerBrowserExitRequested = false;
    }
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.guard", { page:"player", active:!!active, reason:String(reason || "") });
    }
}

function playerAllowIntentionalExit(reason) {
    playerBrowserExitRequested = true;
    playerBrowserExitServerClosed = false;
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.intentional", { page:"player", reason:String(reason || "") });
    }
}

function handlePlayerBeforeUnload(event) {
    if (!playerBrowserExitGuardActive || playerBrowserExitServerClosed || !currentRoomId || playerBrowserExitRequested) return;
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.beforeunload", { page:"player", roomId:String(currentRoomId), started:!!(lastRoomData && lastRoomData.started), userActivation:!!navigator.userActivation?.hasBeenActive });
    }
    event.preventDefault();
    event.returnValue = "";
}

window.addEventListener("beforeunload", handlePlayerBeforeUnload);
window.addEventListener("pagehide", (event) => {
    if (!playerBrowserExitGuardActive || playerBrowserExitServerClosed || !currentRoomId || event.persisted || playerBrowserExitSignalSent) return;
    // A Socket.IO disconnect already owns the reconnect/offline lifecycle. A late pagehide
    // after transport close is a duplicate signal and must not start a second exit transaction.
    if (!socket || !socket.connected) return;
    playerBrowserExitSignalSent = true;
    if (window.WWDiagnostic?.breadcrumb) {
        window.WWDiagnostic.breadcrumb("browser-exit.pagehide", { page:"player", roomId:String(currentRoomId), persisted:!!event.persisted, socketId:socket.id || "" });
    }
    const diagState = window.WWDiagnostic?.getState?.() || {};
    wwSendBrowserExitBeacon("/api/room/browser-exit-player", {
        roomId:String(currentRoomId), token:String(clientToken || ""), socketId:String(socket.id || ""), source:"pagehide",
        clientTraceId:String(diagState.activeTrace?.id || ""), clientSessionId:String(window.WWDiagnostic?.sessionId || ""),
        pendingOperations:Array.isArray(diagState.pendingOperations) ? diagState.pendingOperations.slice(0, 12) : [],
        started:!!(lastRoomData && lastRoomData.started),
        viewport:{ width:Number(window.innerWidth || 0), height:Number(window.innerHeight || 0), dpr:Number(window.devicePixelRatio || 1) }
    });
});

function returnFromTesterPlayer() {
    playerBrowserExitServerClosed = true;
    playerBrowserExitGuardState(false, "return_from_tester_player");
    // จอบอท: ใช้ shared controller หา Host ต้นทางใน opener chain ไม่เชื่อ opener ตัวแรกอย่างเดียว
    if (BOT_CONTROLLED_TAB) {
        if (window.wwServerControl && typeof window.wwServerControl.returnTesterToHost === "function") {
            window.wwServerControl.returnTesterToHost();
            return;
        }
        if (window.opener && !window.opener.closed) {
            try { window.opener.focus(); } catch (e) {}
            try { window.close(); } catch (e) {}
            return;
        }
        window.location.replace(TESTER_RETURN_URL);
        return;
    }

    // โหมดทดลองทุกกรณีต้องกลับศูนย์ควบคุมเดิม: โฟกัสแท็บ admin ที่เปิดมาแล้วปิดแท็บนี้
    // ห้ามเปลี่ยน document ของแท็บทดสอบให้กลายเป็น admin.html เพราะจะสร้าง admin ซ้ำในแท็บเดิม
    if (TESTER_MODE) {
        if (window.wwServerControl && typeof window.wwServerControl.returnTesterToAdmin === "function") {
            window.wwServerControl.returnTesterToAdmin();
        } else {
            window.location.replace(TESTER_RETURN_URL);
        }
        return;
    }

    window.location.replace("index.html");
}


if (TESTER_MODE) {
    document.getElementById("allFilterTesterIcon")?.classList.remove("hidden");
}

// ===== ชื่อผู้เล่น: ตั้งจากหน้าแรกของเกม (index.html) เท่านั้น =====
// index.html (หรือ admin.html ตอนเข้าโหมดผู้ทดสอบ) ส่งชื่อมาทาง ?name=... — จำเป็นเฉพาะโหมดผู้ทดสอบ เพราะ ww_store
// สลับเป็น sessionStorage ของแท็บนี้ล้วนๆ (ว่างเปล่าทุกครั้งที่เปิดแท็บใหม่) โหมดปกติ ww_store คือ
// localStorage เดียวกับที่ index.html เขียนไว้อยู่แล้ว ไม่ต้องอ่านจาก URL ซ้ำ ให้ค่าจาก URL ชนะเสมอ
// เผื่อผู้เล่นย้อนกลับไปเปลี่ยนชื่อที่หน้าแรกใหม่แล้วกดเข้าร่วมซ้ำในแท็บเดิม
const ww_urlDisplayName = urlParams.get("name");
if (TESTER_MODE && ww_urlDisplayName && ww_urlDisplayName.trim()) {
    ww_store.setItem("ww_playerName", ww_urlDisplayName.trim().slice(0, 24));
}
// ผู้เล่นโหมดทดลองไม่กรอกชื่อเองแล้ว — server จะจัดเลข ผู้เล่น1/ผู้เล่น2/... ให้ตาม slot ที่ว่าง
// แต่ client ต้องมี placeholder เพื่อผ่าน UI/auto-join guard จึงใช้ชั่วคราวเฉพาะใน sessionStorage
if (TESTER_MODE && !BOT_CONTROLLED_TAB && !ww_store.getItem("ww_playerName")) {
    ww_store.setItem("ww_playerName", "ผู้เล่นทดสอบ");
}

// กันเคสเปิดหน้านี้ตรงๆ โดยไม่ผ่าน index.html เลย (ไม่เคยมีชื่อค้างในเครื่อง/แท็บนี้เลย) — ยกเว้น
// ป๊อปอัป "🎭 เข้าสิง" ที่ possessBot() เปิดมา (มี ?jr=... เจาะจงห้อง/บอทอยู่แล้ว auto-rejoin ด้วย
// token ของบอทตรงๆ ไม่ผ่านการ์ดกรอกชื่อนี้อยู่แล้ว — ดูคอมเมนต์ ww_urlRejoinRoom ด้านล่างของไฟล์)
// → เด้งกลับไปตั้งชื่อที่หน้าแรกก่อน เพราะที่นี่จุดเดียวที่ตั้งชื่อได้แล้ว
// บัญชีชั่วคราวถูกสร้างตั้งแต่เปิดเกมแล้ว จึงไม่บังคับให้มีชื่อที่ตั้งเองก่อนเข้าหน้านี้อีก


// ===== จำตัวตนผู้เล่นไว้ในเครื่อง (localStorage ปกติ / sessionStorage ถ้าเป็นโหมดผู้ทดสอบ) =====
// 1) ใช้ auto-fill ชื่อ/ห้องล่าสุดให้ตอนเปิดเว็บใหม่หรือรีเฟรช
// 2) ใช้เป็น "token" ประจำเครื่อง/เบราว์เซอร์นี้ เพื่อให้ตอนเน็ตหลุด-กลับมา
//    เซิร์ฟเวอร์รู้ว่าเป็นผู้เล่นคนเดิม ไม่ใช่คนใหม่ (กันบทบาท/สถานะหาย และกันกริดผู้เล่นไม่อัปเดต)
function getClientToken() {
    // แก้บั๊ก: window.open() (ไม่ใส่ noopener) ที่ possessBot() ใช้เปิดป๊อปอัปเข้าสิงบอท จะทำให้
    // เบราว์เซอร์ clone sessionStorage ของ "แท็บที่เปิดป๊อปอัป" (เช่น แท็บโฮสต์ที่เคยทดสอบเป็น
    // ผู้เล่นเองมาก่อนในแท็บเดียวกัน) ติดไปกับป๊อปอัปใหม่ทันที ถ้า ww_token เก่ายังค้างอยู่ใน
    // sessionStorage ที่ clone มา เดิมโค้ดจะอ่าน URL ?t=... (token จริงของบอทที่ possessBot()
    // ตั้งใจส่งมา) ก็ต่อเมื่อ storage ว่างเปล่าเท่านั้น (!t) — กลายเป็นไม่มีวันอ่าน token ของบอท
    // จาก URL เลย เข้าสิงบอทตัวไหนก็วิ่งไป reconnect เป็น "ผู้เล่นคนเดิม" ที่ค้างอยู่ใน storage
    // เสมอ ต้องให้ URL (ซึ่งเป็นค่าที่ possessBot() ตั้งใจสร้างมาเจาะจงสำหรับบอทตัวนี้) ชนะเสมอ
    // ในโหมดผู้ทดสอบ แทนที่จะใช้เป็นแค่ fallback ตอน storage ว่าง
    let t = TESTER_MODE ? urlParams.get("t") : null;
    if (!t) t = ww_store.getItem("ww_token");
    if (!t) {
        t = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));
    }
    ww_store.setItem("ww_token", t);
    if (TESTER_MODE) {
        // เก็บ token ไว้ใน URL ของแท็บด้วย — URL อยู่รอดผ่านการที่เบราว์เซอร์ discard/รีโหลดแท็บ
        // ได้น่าเชื่อถือกว่า sessionStorage มาก จึงใช้เป็น fallback ที่สอง
        const u = new URL(window.location.href);
        u.searchParams.set("tester", "1");
        u.searchParams.set("t", t);
        history.replaceState(null, "", u.toString());
    }
    return t;
}
const clientToken = getClientToken();
let playerAccountReady = Promise.resolve(null);
function bootstrapPlayerAccount(){
    if (TESTER_MODE || !window.wwAccount || !socket.connected) return Promise.resolve(null);
    playerAccountReady = window.wwAccount.bootstrap(socket, { name: ww_store.getItem("ww_playerName") || window.wwAccount.getName() || "", page:"player" })
        .then((data) => {
            if (data?.name) {
                ww_store.setItem("ww_playerName", data.name);
                nameConfirmed = true;
                const input = document.getElementById("name");
                if (input) input.value = data.name;
            }
            return data;
        })
        .catch((e) => {
            console.error("[account] player bootstrap failed", e);
            if (e?.code === "ACCOUNT_RECREATE_REQUIRED" || e?.code === "ACCOUNT_DELETED_REQUIRES_RECREATE" || e?.code === "ACCOUNT_NOT_FOUND_REQUIRES_RECREATE") {
                location.replace("index.html");
            }
            return null;
        });
    return playerAccountReady;
}
if (!TESTER_MODE) bootstrapPlayerAccount();

function sendPlayerPresence(){
    if (TESTER_MODE || !socket.connected) return;
    const name = ww_store.getItem("ww_playerName") || "";
    if (!name) return;
    if (!window.wwAccount) return;
    socket.emit("presence_hello", window.wwAccount.payload({ token:"", name, page:"player", visible:document.visibilityState === "visible", roomId:currentRoomId || "", isHost:false }));
}
document.addEventListener("visibilitychange", sendPlayerPresence);
setInterval(sendPlayerPresence, 20000);

// ===== คืนความเป็นบอท (เฉพาะจอที่กำลังเข้าสิงบอทอยู่ในโหมดผู้ทดสอบ) =====
// เดิมเป็นปุ่มลอยแถวบนสุดกินพื้นที่จอถาวร — ตัดออกแล้ว เปลี่ยนเป็นดับเบิลแทป/ดับเบิลคลิกที่การ์ด
// ของตัวเองในกริดผู้เล่นแทน
let botReleaseInProgress = false;
let lastBotTouchAt = 0;
let lastBotTouchCard = null;
const BOT_DOUBLE_TAP_WINDOW_MS = 380;

function closeBotControlTab() {
    if (window.wwServerControl && typeof window.wwServerControl.returnTesterToHost === "function") {
        window.wwServerControl.returnTesterToHost();
        return;
    }
    returnFromTesterPlayer();
}

function releaseBotAndReturn() {
    if (botReleaseInProgress || !TESTER_MODE || !myIsBot || !currentRoomId || !clientToken) return;
    botReleaseInProgress = true;

    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        // ปิด session ของแท็บนี้หลัง server รับคำสั่งแล้ว กัน auto-reconnect กลับมาแย่งบอทเดิม
        try { sessionStorage.clear(); } catch (e) { /* เบราว์เซอร์บล็อค ไม่เป็นไร */ }
        try { socket.disconnect(); } catch (e) {}
        closeBotControlTab();
    };

    // สำคัญ: release_bot ต้องถึง server ก่อนตัด socket โดยเฉพาะบนมือถือ/WebView
    // ซึ่ง emit แล้ว disconnect ทันทีมีโอกาสที่ packet ยังไม่ทันออกจากคิว
    const payload = { roomId: currentRoomId, token: clientToken };
    try {
        socket.emit("release_bot", payload, (res) => {
            // ทั้งกรณีสำเร็จและ server ตอบกลับว่า bot ไม่อยู่แล้ว ให้ปิดแท็บได้
            // เพราะปลายทางไม่ต้องการ session นี้ต่อไปแล้ว
            finish();
        });
    } catch (e) {
        // ถ้า socket API ใช้งานไม่ได้จริง ๆ ยังต้องปล่อยแท็บได้ ไม่ค้างจอ
        finish();
    }

    // กันกรณี server ไม่ตอบ ACK เพราะกำลังหลุด/ปิดห้อง/เน็ตขาด
    setTimeout(finish, 1500);
}

function getOwnedBotCard(target) {
    if (!TESTER_MODE || !myIsBot || !target) return null;
    const card = target.closest?.(".player[data-pid]");
    if (!card || card.dataset.pid !== socket.id) return null;
    return card;
}

const playersGridEl = document.getElementById("players");
if (playersGridEl) {
    // Desktop: รองรับ dblclick มาตรฐาน
    playersGridEl.addEventListener("dblclick", (e) => {
        const card = getOwnedBotCard(e.target);
        if (!card || botReleaseInProgress) return;
        e.preventDefault();
        releaseBotAndReturn();
    });

    // Mobile/tablet: บาง browser ส่ง pointer/touch click แต่ไม่ยิง dblclick ตามที่คาด
    // จึงตรวจ double-tap เองที่ pointerup โดยใช้เฉพาะ touch/pen เพื่อไม่ไปรบกวน mouse dblclick
    playersGridEl.addEventListener("pointerup", (e) => {
        if (e.pointerType === "mouse") return;
        const card = getOwnedBotCard(e.target);
        if (!card || botReleaseInProgress) {
            lastBotTouchAt = 0;
            lastBotTouchCard = null;
            return;
        }

        const now = Date.now();
        const isDoubleTap = lastBotTouchCard === card && (now - lastBotTouchAt) <= BOT_DOUBLE_TAP_WINDOW_MS;
        lastBotTouchAt = now;
        lastBotTouchCard = card;

        if (isDoubleTap) {
            e.preventDefault();
            e.stopPropagation();
            lastBotTouchAt = 0;
            lastBotTouchCard = null;
            releaseBotAndReturn();
        }
    }, { passive: false });
}

// ===== ตั้งชื่อครั้งเดียวพอ =====
// ครั้งแรกที่เปิดเว็บ: ผู้เล่นกรอกชื่อแล้วกด "เข้าร่วมห้อง" ครั้งนั้นถือเป็นการยืนยันชื่อ
// (ยืนยันได้แม้ห้องยังไม่เปิด — จะบันทึกชื่อไว้ก่อน แล้วรอห้องเปิดแล้วเข้าให้อัตโนมัติ)
// ครั้งต่อ ๆ ไปบนเครื่องเดิม: ชื่อจะถูกจำไว้ (ww_playerName) และล็อกแก้ไม่ได้อีก
// พอมีห้องเปิดอยู่ก็จะเข้าร่วมให้อัตโนมัติทันทีโดยไม่ต้องกดอะไรเลย
// คนเดียวที่แก้ชื่อได้หลังจากนี้คือแอดมิน (หน้า admin.html — ดู "name_updated_by_host" ด้านล่าง
// ชื่อ event เดิมค้างไว้เฉยๆ เพื่อไม่ต้องแก้ทั้งฝั่ง server/client แต่ตอนนี้ส่งมาจากแอดมินแทนโฮสต์แล้ว)
let nameConfirmed = !!ww_store.getItem("ww_playerName") || !!window.wwAccount?.getName();
let autoJoinInFlight = false;
// เซิร์ฟเวอร์ตอบกลับ "wrong_code" มาแล้วครั้งหนึ่ง (ห้องนี้ตั้งรหัสผู้เล่นไว้ ไม่ได้กรอก/กรอกผิด)
// → ต้องโชว์ช่องกรอกรหัสให้ผู้เล่นพิมพ์เอง ใช้คู่กับ suggestedRoomData.hasJoinCode ด้านล่าง
let manualCodeNeeded = false;

// มีห้องเปิดอยู่พร้อมกันมากกว่า 1 ห้องทั้งเซิร์ฟ → ไม่รู้ว่าผู้เล่นจะเข้าห้องไหน เลิก auto-fill/
// auto-join จากห้อง "ล่าสุด" เฉยๆ (เดิม มีห้องเดียวเสมอ เลยเดาได้ถูกทุกครั้ง) เปลี่ยนเป็นให้พิมพ์
// โค้ดห้องเองแทน เหมือนที่โฮสต์พิมพ์/เลือกรหัสห้องตอนล็อกอินเข้าคุมห้อง
function isMultiRoomMode() {
    return !!(suggestedRoomData && suggestedRoomData.totalRooms > 1);
}

function needsJoinCode() {
    return manualCodeNeeded || !!(suggestedRoomData && suggestedRoomData.hasJoinCode);
}

function updateJoinCardMode() {
    const nameInput = document.getElementById("name");
    const nameDisplay = document.getElementById("playerNameDisplay");
    const joinBtn = document.getElementById("joinBtn");
    const waiting = document.getElementById("joinWaiting");
    const roomInput = document.getElementById("room");
    const codeInput = document.getElementById("joinCode");
    if (!nameInput || !joinBtn) return;

    if (nameDisplay) {
        const currentName = nameInput.value.trim();
        if (currentName) {
            nameDisplay.innerHTML = `<span>ผู้เล่น</span><b>${escapeHtml(currentName)}</b>`;
            nameDisplay.classList.remove("hidden");
        } else {
            nameDisplay.classList.add("hidden");
        }
    }

    const multiRoom = isMultiRoomMode();
    const needsCode = needsJoinCode();
    const roomField = document.getElementById("roomField");
    const codeField = document.getElementById("codeField");

    if (roomInput) {
        roomInput.classList.toggle("hidden", !multiRoom);
        roomInput.readOnly = false;
    }
    if (roomField) roomField.classList.toggle("hidden", !multiRoom);
    if (codeInput) codeInput.classList.toggle("hidden", !(multiRoom || needsCode));
    if (codeField) codeField.classList.toggle("hidden", !(multiRoom || needsCode));

    // ห้องค้นหาเปิดได้เสมอ แม้ตอนมีห้องเดียว: ผู้เล่นจะรู้ว่ามีตัวเลือกและไม่ต้องจำโค้ด
    const pickerTrigger = document.getElementById("playerRoomPickerTrigger");
    if (pickerTrigger) pickerTrigger.classList.remove("hidden");

    if (nameConfirmed) {
        nameInput.readOnly = true;
        nameInput.classList.add("locked");
    } else {
        nameInput.readOnly = false;
        nameInput.classList.remove("locked");
    }

    if (nameConfirmed && !multiRoom && !needsCode) {
        joinBtn.classList.add("hidden");
        if (waiting) waiting.classList.remove("hidden");
    } else {
        joinBtn.classList.remove("hidden");
        if (waiting) waiting.classList.add("hidden");
    }

    updateLobbyRoomVisual();
}

// ===== ROOM PICKER ฝั่งผู้เล่น — เลือกห้องจากรายการแทนพิมพ์โค้ดห้องเดา ๆ ตอนมีหลายห้องเปิดพร้อมกัน
// (คู่กับกริด "ห้องที่ยังเปิดอยู่" ฝั่งโฮสต์ ใน host.main.js แต่ผลลัพธ์การกดคือ "เข้าร่วม" ไม่ใช่
// "เข้าคุม" และข้อมูลที่โชว์ตัดส่วนที่ไม่เกี่ยวกับผู้เล่นออก — ดู list_open_rooms_players ใน server.js) =====
let playerRoomPickerRawList = [];
let playerRoomPickerRefreshing = false;

function refreshPlayerRoomPicker() {
    if (playerRoomPickerRefreshing) return;
    playerRoomPickerRefreshing = true;
    const refreshBtn = document.getElementById("playerRoomRefreshBtn");
    const grid = document.getElementById("playerRoomPickerGrid");
    if (refreshBtn) refreshBtn.classList.add("is-loading");
    if (grid && !playerRoomPickerRawList.length) grid.innerHTML = '<div class="roomPickerLoading"><span></span><span></span><span></span><em>กำลังค้นหาห้อง...</em></div>';

    socket.emit("list_open_rooms_players", (list) => {
        playerRoomPickerRawList = Array.isArray(list) ? list : [];
        playerRoomPickerRefreshing = false;
        if (refreshBtn) refreshBtn.classList.remove("is-loading");
        filterPlayerRoomPicker();
        updateLobbyRoomVisual();
    });

    setTimeout(() => {
        playerRoomPickerRefreshing = false;
        if (refreshBtn) refreshBtn.classList.remove("is-loading");
    }, 2500);
}

function openPlayerRoomPicker() {
    const overlay = document.getElementById("playerRoomPickerOverlay");
    const searchInput = document.getElementById("playerRoomSearchInput");
    if (!overlay) return;
    overlay.classList.remove("hidden");
    document.body.classList.add("room-picker-open");
    if (searchInput) {
        searchInput.value = "";
        window.setTimeout(() => searchInput.focus(), 60);
    }
    refreshPlayerRoomPicker();
}

function closePlayerRoomPicker() {
    const overlay = document.getElementById("playerRoomPickerOverlay");
    if (overlay) overlay.classList.add("hidden");
    document.body.classList.remove("room-picker-open");
}

function clearPlayerRoomSearch() {
    const input = document.getElementById("playerRoomSearchInput");
    if (input) {
        input.value = "";
        input.focus();
    }
    filterPlayerRoomPicker();
}

function filterPlayerRoomPicker() {
    const input = document.getElementById("playerRoomSearchInput");
    const clearBtn = document.getElementById("playerRoomSearchClear");
    const countEl = document.getElementById("playerRoomPickerCount");
    const empty = document.getElementById("playerRoomPickerEmpty");
    const q = (input && input.value || "").trim().toUpperCase();
    const filtered = !q ? playerRoomPickerRawList : playerRoomPickerRawList.filter((r) =>
        String(r.roomId || "").toUpperCase().includes(q) || String(r.hostName || "").toUpperCase().includes(q)
    );
    if (clearBtn) clearBtn.classList.toggle("hidden", !q);
    if (countEl) countEl.textContent = `${filtered.length} ห้อง${q ? ` จาก ${playerRoomPickerRawList.length}` : ""}`;
    drawPlayerRoomPickerGrid(filtered);
    if (empty) {
        const hasRooms = playerRoomPickerRawList.length > 0;
        empty.classList.toggle("hidden", filtered.length > 0);
        const emptyText = document.getElementById("playerRoomPickerEmptyText");
        if (emptyText) emptyText.textContent = q
            ? "ลองเปลี่ยนคำค้นหา หรือกด × เพื่อล้างตัวกรอง"
            : (hasRooms ? "ห้องที่เปิดอยู่กำลังเริ่มเกมหรือไม่พร้อมรับผู้เล่น" : "รอให้ผู้เล่าเรื่องเปิดห้องใหม่ แล้วรายการจะปรากฏที่นี่");
    }
}

function getPlayerRoomState(r) {
    const full = Number(r.maxPlayers || 0) > 0 && Number(r.playerCount || 0) >= Number(r.maxPlayers || 0);
    if (r.started) return { key: "started", label: "กำลังเล่นอยู่", icon: "🎮", disabled: true };
    if (full) return { key: "full", label: "ห้องเต็มแล้ว", icon: "🧳", disabled: true };
    return { key: "open", label: "พร้อมรับผู้เล่น", icon: "🌊", disabled: false };
}

function drawPlayerRoomPickerGrid(list) {
    const grid = document.getElementById("playerRoomPickerGrid");
    if (!grid) return;
    grid.innerHTML = "";

    list.forEach((r) => {
        const state = getPlayerRoomState(r);
        const max = Number(r.maxPlayers || 0);
        const count = Number(r.playerCount || 0);
        const percent = max > 0 ? Math.min(100, Math.round((count / max) * 100)) : Math.min(100, Math.max(8, count * 8));
        const card = document.createElement("button");
        card.type = "button";
        card.className = `roomPickCard roomPickCard-${state.key}`;
        card.disabled = state.disabled;
        card.innerHTML = `
            <div class="roomPickCardTop">
                <span class="roomPickState roomPickState-${state.key}"><i>${state.icon}</i>${state.label}</span>
                ${r.hasJoinCode ? '<span class="roomPickPrivate" title="ต้องใช้รหัสเข้าห้อง">🔐 ส่วนตัว</span>' : '<span class="roomPickOpen">เปิด</span>'}
            </div>
            <div class="roomPickCodeRow">
                <span class="roomPickCode">${escapeHtml(r.roomId || "—")}</span>
                <span class="roomPickArrow">›</span>
            </div>
            <div class="roomPickMeta"><span>ผู้เล่าเรื่อง</span><strong>${r.hostName ? escapeHtml(r.hostName) : "ไม่ทราบชื่อ"}</strong></div>
            <div class="roomPickCapacity">
                <div class="roomPickCapacityLabel"><span>ผู้เล่น ${count}${max > 0 ? ` / ${max}` : " / ไม่จำกัด"}</span><span>${max > 0 ? `${percent}%` : ""}</span></div>
                <span class="roomPickCapacityTrack"><i style="width:${percent}%"></i></span>
            </div>
            <div class="roomPickAction">แตะเพื่อเลือกห้อง <span>→</span></div>
        `;
        card.addEventListener("click", () => selectPlayerRoom(r));
        grid.appendChild(card);
    });

    if (!list.length) {
        const empty = document.getElementById("playerRoomPickerEmpty");
        if (empty) empty.classList.remove("hidden");
    }
}

async function selectPlayerRoom(r) {
    const state = getPlayerRoomState(r);
    if (state.disabled) {
        wwAlert(state.key === "full" ? "ห้องนี้เต็มแล้ว เลือกห้องอื่นได้เลย" : "ห้องนี้เริ่มเกมไปแล้ว เข้าร่วมใหม่ไม่ได้ระหว่างเกมกำลังเล่นอยู่");
        return;
    }

    const roomInput = document.getElementById("room");
    if (roomInput) roomInput.value = r.roomId || "";
    manualCodeNeeded = !!r.hasJoinCode;
    suggestedRoomData = Object.assign({}, suggestedRoomData || {}, r, {
        totalRooms: Math.max(Number((suggestedRoomData && suggestedRoomData.totalRooms) || 0), 2)
    });
    updateJoinCardMode();
    renderRoomSuggestion();
    closePlayerRoomPicker();

    const codeInput = document.getElementById("joinCode");
    const nameInput = document.getElementById("name");
    if (r.hasJoinCode && codeInput) {
        window.setTimeout(() => codeInput.focus(), 30);
    } else if (nameInput && !nameInput.value.trim()) {
        window.setTimeout(() => nameInput.focus(), 30);
    } else {
        window.setTimeout(() => document.getElementById("joinBtn")?.focus(), 30);
    }
}

document.addEventListener("input", (e) => {
    if (e.target && e.target.id === "playerRoomSearchInput") filterPlayerRoomPicker();
});

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("playerRoomPickerOverlay")?.classList.contains("hidden")) {
        closePlayerRoomPicker();
    }
});

// เติมชื่อ/โค้ดห้องล่าสุดที่เคยกรอกไว้ ให้อัตโนมัติทันทีที่เปิดหน้า
(function restoreLastSession() {
    const savedName = ww_store.getItem("ww_playerName");
    if (savedName) document.getElementById("name").value = savedName;
    // ห้องเก่าจะถูกตรวจโดย server ก่อน ไม่เติมกลับลงช่อง #room อัตโนมัติ
    updateJoinCardMode();
})();

// เข้าร่วมห้องจริง (ใช้ทั้งตอนกดปุ่มเองครั้งแรก และตอน auto-join เงียบ ๆ ครั้งต่อไป)
async function doJoin(playerName, roomCode, opts) {
    opts = opts || {};
    const code = opts.code || undefined;

    await playerAccountReady;
    playerName = window.wwAccount?.getName() || playerName;
    ww_store.setItem("ww_playerName", playerName);
    ww_store.setItem("ww_lastRoom", roomCode);

    pendingJoinRoomId = roomCode;
    watchdogJoin(roomCode, 1, code);

    socket.emit(
        "join_room",
        {
            roomId: roomCode,
            name: playerName,
            token: clientToken,
            ...(TESTER_MODE ? {} : (window.wwAccount ? window.wwAccount.payload() : {})),
            code,
            isTester: TESTER_MODE,
            testerSessionId: TESTER_MODE ? (urlParams.get("ts") || "") : ""
        },
        (res) => {
            autoJoinInFlight = false;

            if (!res || res.error) {
                if (pendingJoinRoomId === roomCode) pendingJoinRoomId = null;

                // ห้องนี้ต้องใช้ "รหัสห้อง" (ตั้งไว้ผ่าน ⚙️ ตั้งค่าห้องฝั่งโฮสต์) แต่ยังไม่ได้กรอก/กรอกผิด
                // → โชว์ช่องกรอกรหัสแล้วให้ผู้เล่นลองใหม่เอง (ไม่ auto-retry เงียบๆ เพราะเดารหัสไม่ได้)
                if (res && res.error === "wrong_code") {
                    manualCodeNeeded = true;
                    updateJoinCardMode();
                    if (!opts.silent) wwAlert("ห้องนี้ต้องใช้รหัสห้อง กรอกรหัสห้องให้ถูกต้องแล้วลองอีกครั้ง");
                    return;
                }

                if (res && res.error === "room_full") {
                    if (!opts.silent) wwAlert("ห้องนี้มีผู้เล่นครบตามจำนวนสูงสุดแล้ว เข้าร่วมเพิ่มไม่ได้");
                    return;
                }

                if (res && res.error === "too_many_attempts") {
                    // ลองรหัสห้องผิดถี่เกินไป (กันการเดา/บรุตฟอร์ซรหัสห้อง) — ให้รอสักครู่ก่อนลองใหม่
                    if (!opts.silent) wwAlert("ลองรหัสห้องผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง");
                    return;
                }

                if (res && res.code === "PLAYER_LEFT_GAME") {
                    ww_store.removeItem("ww_joinedRoom");
                    previousRoomDecisionPending = false;
                    previousRoomCheckDone = true;
                    previousRoomResumeState = null;
                    setResumeModalVisible(false);
                    if (!opts.silent) {
                        wwAlert("คุณเลือกหาห้องใหม่แล้ว จึงไม่สามารถกลับเข้ารอบเดิมได้");
                        openPlayerRoomPicker();
                    }
                    return;
                }

                if (!opts.silent) {
                    wwAlert(res && res.error === "started"
                        ? "ห้องนี้เริ่มเกมไปแล้ว เข้าร่วมใหม่ไม่ได้ระหว่างเกมกำลังเล่นอยู่"
                        : "ไม่พบห้อง");
                }
                return;
            }

            finalizeJoin(roomCode);
        }
    );
}

// กันเคส ack ของ join_room หายไปเงียบๆ ทั้งที่ socket ยังต่ออยู่ปกติ (ไม่ได้หลุด-ต่อใหม่ให้
// connect handler ช่วย retry ได้) — ลองส่ง join_room ซ้ำเป็นระยะถ้ายังไม่สำเร็จ สูงสุดไม่กี่ครั้ง
// แล้วเลิกลองเอง ปล่อยให้กลไก reconnect ปกติ (หรือผู้เล่นกดปุ่มเข้าร่วมเองใหม่) พาไปแทน
function watchdogJoin(roomCode, attempt, code) {
    attempt = attempt || 1;
    if (attempt > 4) return;
    setTimeout(() => {
        if (pendingJoinRoomId !== roomCode || joined) return; // สำเร็จ/ถูกแทนที่ไปแล้ว เลิกลอง
        socket.emit(
            "join_room",
            { roomId: roomCode, name: ww_store.getItem("ww_playerName") || undefined, token: clientToken, ...(TESTER_MODE ? {} : (window.wwAccount ? window.wwAccount.payload() : {})), code, isTester: TESTER_MODE, testerSessionId: TESTER_MODE ? (urlParams.get("ts") || "") : "" },
            (res) => {
                if (!res || res.error) {
                    if (pendingJoinRoomId === roomCode) pendingJoinRoomId = null;
                    return;
                }
                finalizeJoin(roomCode);
            }
        );
        watchdogJoin(roomCode, attempt + 1, code);
    }, attempt * 5000);
}

// ทำให้ UI เข้าสู่สถานะ "เข้าห้องสำเร็จแล้ว" จริง ๆ — แยกออกมาจาก ack callback ของ doJoin
// เพราะต้องเรียกได้จากอีกทาง (room_update fallback ด้านล่าง) ในกรณีที่ ack หายไประหว่างทาง
// แต่ server รับเข้าห้องไปแล้วจริง ป้องกันบั๊ก UI ค้างที่หน้ากรอกห้องทั้งที่เข้าห้องสำเร็จแล้ว
function finalizeJoin(roomCode) {
    if (joined && currentRoomId === roomCode) {
        pendingJoinRoomId = null;
        return; // เข้าห้องนี้อยู่แล้ว ไม่ต้องทำซ้ำ
    }

    joined = true;
    currentRoomId = roomCode;
    playerBrowserExitServerClosed = false;
    playerBrowserExitRequested = false;
    playerBrowserExitSignalSent = false;
    playerBrowserExitGuardState(true, "room_active");
    nameConfirmed = true;
    pendingJoinRoomId = null;
    manualCodeNeeded = false; // เข้าห้องสำเร็จแล้ว ไม่ต้องจำสถานะ "รหัสห้องผิด" ค้างไว้อีก
    updateJoinCardMode();

    ww_store.setItem("ww_joinedRoom", roomCode);
    if (TESTER_MODE) {
        const u = new URL(window.location.href);
        u.searchParams.set("jr", roomCode);
        history.replaceState(null, "", u.toString());
    }

    // ===== กันผู้เล่นกดปุ่ม "ย้อนกลับ" ของเบราว์เซอร์แล้วหลุดออกจากห้องเงียบๆ =====
    // ดัน history entry เสริมไว้ 1 อัน (URL เดิม ไม่เปลี่ยนอะไรที่เห็น) ตอนเข้าห้องสำเร็จครั้งแรก
    // เพื่อให้กดย้อนกลับครั้งแรกโดนดักด้วย popstate handler ด้านล่างของไฟล์ก่อน แทนที่จะออกจากหน้า
    // ไปเลยทันที (ดู popstate handler ที่ท้ายไฟล์สำหรับ logic ถามยืนยัน + ล้างข้อมูลจริง)
    history.pushState({ ww_roomGuard: true }, "", window.location.href);

    renderRoomSuggestion();

    document.getElementById("joinCard").classList.add("hidden");
    document.body.classList.remove("lobby-beach");
    document.body.classList.remove("room-picker-open");
    document.getElementById("playersCard").classList.remove("hidden");
    document.getElementById("chatCard").classList.remove("hidden");
    document.getElementById("rolesPanelCard").classList.remove("hidden");
    document.getElementById("bottomBar").classList.remove("hidden");
    document.getElementById("bottomBar").classList.add("bar-visible");
    document.querySelector('.app').classList.add("game-visible");
    // ตอน join สำเร็จครั้งแรก parent #playersCard เพิ่งเปลี่ยนจาก lobby เป็น game layout
    // ต้องรอ flex layout settle ก่อนวัดขนาดกริดเช่นเดียวกับจังหวะเริ่มเกม
    scheduleFitPlayerGrid(true);
}

// ถ้าชื่อถูกยืนยันไว้แล้ว (ไม่ใช่ครั้งแรก) และมีห้องเปิดอยู่ → เข้าร่วมให้อัตโนมัติทันที ไม่ต้องกดอะไร
function maybeAutoJoin() {
    if (joined || autoJoinInFlight) return;
    if (previousRoomDecisionPending || previousRoomCheckInFlight) return;
    if (!nameConfirmed) return;
    if (!suggestedRoomData || !suggestedRoomData.roomId) return;
    // มีหลายห้องเปิดพร้อมกัน — ไม่รู้ว่าจะเข้าห้องไหน ต้องให้ผู้เล่นพิมพ์โค้ดห้องเองแล้วกดเข้าร่วม
    if (isMultiRoomMode()) return;
    // ห้องนี้ต้องใช้รหัสห้อง — ต้องให้ผู้เล่นกรอกรหัสเองแล้วกดเข้าร่วม เดา/auto-join เงียบๆ ไม่ได้
    if (needsJoinCode()) return;

    const savedName = ww_store.getItem("ww_playerName");
    if (!savedName) return;

    autoJoinInFlight = true;
    doJoin(savedName, suggestedRoomData.roomId, { silent: true });
}

// AUTO-REJOIN ตอนเปิดหน้าใหม่ทั้งหน้า (ไม่ใช่แค่ socket reconnect กลางอากาศ)
// เคสนี้เกิดบ่อยบนมือถือ: สลับแอป/จอ แล้วเบราว์เซอร์ discard แท็บคืน RAM ทำให้ JS
// ทั้งหมดรีสตาร์ทใหม่ (joined/currentRoomId ที่เป็นแค่ตัวแปรในหน่วยความจำหายไปด้วย)
// เดิม flow จะกลับไปอยู่หน้ากรอกห้อง ต้องกดเข้าร่วมเองใหม่ทุกครั้ง — ใช้ ww_joinedRoom
// ที่บันทึกไว้ตอน join สำเร็จ มาเข้าห้องเดิมให้อัตโนมัติแทน (token เดิมทำให้ server รู้ว่าคนเดิม)
// แก้บั๊ก: เดิมส่ง name: "" (empty string) ตอนยังไม่เคยมีชื่อจำไว้ในเครื่องนี้เลย (เช่น ป๊อปอัป
// "เข้าสิงบอท" ที่เพิ่งเปิดแท็บใหม่ sessionStorage ว่างเปล่า) — เซิร์ฟเวอร์เห็นว่า name ไม่ใช่
// undefined เลยเรียก sanitizeName("") ซึ่งคืนค่า fallback "ผู้เล่น" กลับมา แล้วเขียนทับชื่อบอท
// เดิม (เช่น "🤖 บอท 1") เป็น "ผู้เล่น" ทันทีที่เข้าสิง ทั้งที่ควรใช้ชื่อเดิมของบอทต่อไป
// ใช้ || undefined แทน เพื่อไม่ส่ง field name ไปเลยเมื่อไม่มีชื่อจำไว้ — ฝั่งเซิร์ฟเวอร์เช็ค
// name !== undefined อยู่แล้วก่อนจะสั่งเปลี่ยนชื่อผู้เล่นที่ reconnect ด้วย token เดิม
// แก้บั๊กเดียวกับ getClientToken(): ?jr=... ใน URL คือ roomId ของบอทตัวจริงที่ possessBot()
// ตั้งใจส่งมา ต้องชนะค่า ww_joinedRoom ที่อาจ clone ติดมาจาก sessionStorage ของแท็บที่เปิด
// ป๊อปอัป ไม่ใช่แค่ fallback ตอน store ว่าง
const ww_urlRejoinRoom = TESTER_MODE ? urlParams.get("jr") : null;
const ww_savedRoomForResume = ww_store.getItem("ww_joinedRoom");

function setResumeModalVisible(visible) {
    const overlay = document.getElementById("playerResumeOverlay");
    if (!overlay) return;
    overlay.classList.toggle("hidden", !visible);
    document.body.classList.toggle("previous-room-open", !!visible);
    if (visible) window.setTimeout(() => document.getElementById("playerResumeContinueBtn")?.focus(), 40);
}

function renderPreviousRoomResume(state) {
    previousRoomResumeState = state || null;
    const title = document.getElementById("playerResumeTitle");
    const sub = document.getElementById("playerResumeSub");
    const code = document.getElementById("playerResumeRoomCode");
    const host = document.getElementById("playerResumeRoomHost");
    const meta = document.getElementById("playerResumeRoomMeta");
    const notice = document.getElementById("playerResumeNotice");
    const icon = document.getElementById("playerResumeIcon");
    const continueBtn = document.getElementById("playerResumeContinueBtn");
    const newBtn = document.getElementById("playerResumeNewBtn");
    if (!title || !sub || !code || !host || !meta || !notice || !continueBtn || !newBtn) return;

    const started = !!state?.started;
    const isTester = !!state?.isTesterRoom;
    title.textContent = started ? "กลับเข้าสู่เกมเดิมไหม?" : "กลับเข้าห้องเดิมไหม?";
    sub.textContent = started
        ? "พบห้องเดิมของคุณ และเกมยังไม่จบ เลือกได้ว่าจะเล่นต่อหรือไปหาห้องใหม่"
        : "พบห้องเดิมของคุณที่ยังเปิดอยู่ เลือกได้ว่าจะกลับไปรอในห้องเดิมหรือเลือกห้องอื่น";
    code.textContent = String(state?.roomId || "—").toUpperCase();
    host.textContent = state?.hostName ? `ผู้เล่าเรื่อง: ${state.hostName}` : "ผู้เล่าเรื่อง —";
    meta.textContent = started
        ? `🎮 ${state?.isNight ? "กำลังเล่น — กลางคืน" : "กำลังเล่น — กลางวัน"}${isTester ? " · ห้องผู้ทดสอบ" : ""}`
        : `⏳ รอเริ่มเกม${isTester ? " · ห้องผู้ทดสอบ" : ""}`;
    notice.innerHTML = started
        ? "ถ้าเลือก <b>หาห้องใหม่</b> ตอนเกมเดิมยังไม่จบ ระบบจะบันทึกสถานะ <b>หนีออกเกม</b> ทันที และจะไม่ให้ token นี้ย้อนกลับเข้ารอบเดิมอีก"
        : "เลือก <b>หาห้องใหม่</b> ได้เลย — ห้องเดิมยังไม่เริ่มเกม จึงไม่นับเป็นการหนีออกเกม";
    icon.textContent = started ? "🎮" : "🏖️";
    continueBtn.textContent = started ? "กลับเข้าเกมเดิม" : "กลับเข้าห้องเดิม";
    continueBtn.disabled = false;
    newBtn.disabled = false;
    setResumeModalVisible(true);
}

function checkPreviousRoomResume() {
    if (BOT_CONTROLLED_TAB || !ww_savedRoomForResume || joined || previousRoomCheckDone || previousRoomCheckInFlight) return;
    if (!socket.connected) return;
    previousRoomCheckInFlight = true;
    socket.emit("player_resume_status", { roomId: ww_savedRoomForResume, token: clientToken }, (res) => {
        previousRoomCheckInFlight = false;

        // ห้ามล้าง ww_joinedRoom เมื่อเป็น SERVER_ERROR/ไม่มี ACK: ห้องเดิมอาจยังอยู่และ
        // server เพียงชั่วคราวกำลังกู้ snapshot หรือ DynamoDB ตอบช้า ให้ตรวจซ้ำแทน
        if (!res || res.code === "SERVER_ERROR" || res.error) {
            previousRoomCheckDone = false;
            previousRoomDecisionPending = false;
            previousRoomResumeState = null;
            if (socket.connected) window.setTimeout(() => checkPreviousRoomResume(), 300);
            return;
        }

        previousRoomCheckDone = true;
        if (!res.roomExists || !res.playerFound || res.alreadyLeft || res.gameOver) {
            previousRoomDecisionPending = false;
            ww_store.removeItem("ww_joinedRoom");
            previousRoomResumeState = null;
            maybeAutoJoin();
            return;
        }
        previousRoomDecisionPending = true;
        renderPreviousRoomResume(res);
    });
    window.setTimeout(() => {
        if (!previousRoomCheckInFlight) return;
        previousRoomCheckInFlight = false;
        // ไม่ลบ session เก่าเมื่อ timeout: server อาจกำลังกู้ห้องจาก persistence
        // แต่ต้องปลดล็อก flow ด้วยการลองตรวจซ้ำเมื่อ socket ยังต่ออยู่ ไม่ปล่อยหน้า lobby ค้าง
        // ที่ state "กำลังตรวจสอบ" ตลอดไป
        if (!previousRoomCheckDone && socket.connected) {
            window.setTimeout(() => checkPreviousRoomResume(), 250);
        }
    }, 5000);
}

function resumePreviousPlayerRoom() {
    if (joined || abandonGameInFlight) return;
    const state = previousRoomResumeState;
    const roomId = String(state?.roomId || ww_savedRoomForResume || "").trim().toUpperCase();
    if (!roomId) return;
    const savedName = ww_store.getItem("ww_playerName") || "";
    previousRoomDecisionPending = false;
    setResumeModalVisible(false);
    doJoin(savedName, roomId, { silent: false });
}

async function abandonPreviousPlayerGame() {
    const state = previousRoomResumeState;
    const roomId = String(state?.roomId || ww_savedRoomForResume || "").trim().toUpperCase();
    if (!roomId || abandonGameInFlight) return true;
    abandonGameInFlight = true;
    return await new Promise((resolve) => {
        // ใช้ event เดียวทั้ง lobby และ game เพราะหน้าใหม่อาจยังไม่ได้อยู่ใน socket room เดิม
        // และ server จะลบผู้เล่นจาก lobby ด้วย token ได้โดยตรง ส่วนเกมที่เริ่มแล้วจะบันทึก leave ทันที
        socket.emit("abandon_game", { roomId, token: clientToken, reason: "new_room" }, (res) => {
            abandonGameInFlight = false;
            if (res && (res.ok || res.code === "ROOM_NOT_FOUND" || res.code === "ROOM_ALREADY_ENDED" || res.code === "LEFT_LOBBY")) {
                resolve(true);
                return;
            }
            wwAlert(res?.code === "SERVER_ERROR"
                ? "เซิร์ฟเวอร์ยังบันทึกการออกเกมไม่สำเร็จ กรุณาลองอีกครั้ง"
                : "ยังออกจากเกมเดิมไม่สำเร็จ จึงยังไม่เปิดการเลือกห้องใหม่");
            resolve(false);
        });
        window.setTimeout(() => {
            if (!abandonGameInFlight) return;
            abandonGameInFlight = false;
            wwAlert("เซิร์ฟเวอร์ไม่ตอบกลับการออกจากห้องเดิม จึงยังไม่เปิดการเลือกห้องใหม่");
            resolve(false);
        }, 7000);
    });
}

async function chooseNewPlayerRoom() {
    if (joined || abandonGameInFlight) return;
    if (!(await abandonPreviousPlayerGame())) return;
    previousRoomDecisionPending = false;
    previousRoomCheckDone = true;
    previousRoomResumeState = null;
    ww_store.removeItem("ww_joinedRoom");
    const roomInput = document.getElementById("room");
    const codeInput = document.getElementById("joinCode");
    if (roomInput) roomInput.value = "";
    if (codeInput) codeInput.value = "";
    manualCodeNeeded = false;
    setResumeModalVisible(false);
    updateJoinCardMode();
    openPlayerRoomPicker();
}

// ผู้เล่นปกติ/ผู้เล่นทดสอบทั่วไปต้องผ่าน Previous Game decision ก่อนเสมอ
// auto-rejoin เหลือไว้เฉพาะแท็บบอทที่มี ?jr=... ซึ่งเป็น session ที่โฮสต์ตั้งใจเข้าสิง
if (BOT_CONTROLLED_TAB && ww_urlRejoinRoom) {
    // Do not emit a second join here. The socket `connect` handler below/above owns the
    // initial reconnect and will call wwRejoinRoom() once after the socket is ready.
    // The old code queued an emit and also let `connect` call wwRejoinRoom(), producing two
    // overlapping join_room operations on iPad/Chrome and making the result timing-dependent.
    pendingJoinRoomId = ww_urlRejoinRoom;
    if (socket.connected) wwRejoinRoom(ww_urlRejoinRoom, 0);
}

function updateLobbyRoomVisual() {
    if (joined) return;
    const badge = document.getElementById("playerLobbyRoomBadge");
    const state = document.getElementById("playerLobbyRoomState");
    const code = document.getElementById("playerLobbyRoomCode");
    const host = document.getElementById("playerLobbyRoomHost");
    const players = document.getElementById("playerLobbyRoomPlayers");
    const access = document.getElementById("playerLobbyRoomAccess");
    const icon = document.getElementById("playerLobbyRoomIcon");
    const status = document.getElementById("playerLobbyStatusText");
    const dot = document.getElementById("playerLobbyStatusDot");
    const capacityTrack = document.getElementById("playerLobbyCapacityTrack");
    const capacityBar = document.getElementById("playerLobbyCapacityBar");
    const room = suggestedRoomData;
    const total = Number(room && room.totalRooms || playerRoomPickerRawList.length || 0);

    if (!room || !room.roomId) {
        badge && (badge.textContent = "ยังไม่มีห้อง");
        state && (state.textContent = "รอห้องเปิด");
        code && (code.textContent = "— — —");
        host && (host.textContent = "เมื่อผู้เล่าเรื่องเปิดห้อง รายการจะอัปเดตตรงนี้");
        players && (players.textContent = "—");
        access && (access.textContent = "ไม่ระบุ");
        icon && (icon.textContent = "🏝️");
        status && (status.textContent = "กำลังรอห้องเปิด");
        dot && (dot.dataset.state = "waiting");
        capacityTrack && capacityTrack.classList.add("hidden");
        return;
    }

    const max = Number(room.maxPlayers || 0);
    const count = Number(room.playerCount || 0);
    const full = max > 0 && count >= max;
    const started = !!room.started;
    const privateRoom = !!room.hasJoinCode;
    const percent = max > 0 ? Math.min(100, Math.round((count / max) * 100)) : Math.min(100, Math.max(8, count * 8));

    badge && (badge.textContent = started ? "กำลังเล่น" : full ? "เต็มแล้ว" : total > 1 ? `${total} ห้องเปิด` : "เปิดอยู่");
    state && (state.textContent = started ? "เกมเริ่มแล้ว" : full ? "รอที่ว่าง" : "พร้อมรับผู้เล่น");
    code && (code.textContent = String(room.roomId).toUpperCase());
    host && (host.textContent = room.hostName ? `ผู้เล่าเรื่อง: ${room.hostName}` : "ผู้เล่าเรื่องยังไม่ได้ระบุชื่อ");
    players && (players.textContent = max > 0 ? `${count} / ${max}` : `${count}`);
    access && (access.textContent = privateRoom ? "ต้องใช้รหัส" : "เข้าร่วมได้เลย");
    icon && (icon.textContent = started ? "🎮" : full ? "🧳" : "🌊");
    status && (status.textContent = started ? "ห้องนี้เริ่มเกมแล้ว" : full ? "ห้องนี้เต็มแล้ว — ลองเลือกห้องอื่น" : "มีห้องพร้อมให้เข้าร่วม");
    dot && (dot.dataset.state = started || full ? "busy" : "ready");
    if (capacityTrack && capacityBar) {
        capacityTrack.classList.remove("hidden");
        capacityBar.style.width = `${percent}%`;
    }
}

// ผู้เล่นไม่ต้องกรอกโค้ดห้องเอง — เติมให้อัตโนมัติจากห้องที่เปิดอยู่ (ปกติมีห้องเดียว)
// และอัปเดตข้อความใต้หัวข้อให้รู้สถานะ (รอโฮสต์เปิดห้อง / พร้อมเข้าร่วม / กำลังเข้าร่วมอัตโนมัติ)
function renderRoomSuggestion() {
    const sub = document.getElementById("joinSub");
    const roomInput = document.getElementById("room");

    if (joined) return;

    updateLobbyRoomVisual();
    updateJoinCardMode();

    // มีหลายห้องเปิดพร้อมกันทั้งเซิฟ — ไม่รู้ว่าผู้เล่นตั้งใจเข้าห้องไหน (ต่างจากปกติที่มีห้องเดียว
    // เลย auto-fill/auto-join ห้องนั้นให้ได้ถูกต้องเสมอ) เปลี่ยนมาให้พิมพ์โค้ดห้องเอง เหมือนตอนโฮสต์
    // เลือกห้องจากกริด "ห้องที่ยังเปิดอยู่" — ไม่แตะค่าที่พิมพ์ไว้ในช่อง #room เลย
    if (isMultiRoomMode()) {
        if (sub) {
            sub.textContent = nameConfirmed
                ? `มี ${suggestedRoomData.totalRooms} ห้องเปิดอยู่ — เลือกจากรายการหรือใส่โค้ดห้องเอง`
                : `มี ${suggestedRoomData.totalRooms} ห้องเปิดอยู่ — เลือกห้องที่ต้องการแล้วเข้าร่วม`;
        }
        return;
    }

    if (!suggestedRoomData || !suggestedRoomData.roomId) {
        roomInput.value = "";
        if (sub) {
            sub.textContent = nameConfirmed
                ? "รอผู้เล่าเรื่องเปิดห้องก่อน — เมื่อพร้อมแล้วจะเข้าร่วมให้อัตโนมัติ"
                : "ยังไม่มีห้องที่เปิดอยู่ — ตั้งชื่อไว้ก่อนได้ แล้วกลับมาเลือกห้องเมื่อพร้อม";
        }
        return;
    }

    roomInput.value = suggestedRoomData.roomId;

    // ห้องเดียวทั้งเซิฟ แต่ตั้งรหัสห้องไว้ — auto-fill โค้ดห้องให้เหมือนเดิม แต่ยังเข้าอัตโนมัติ
    // ไม่ได้ ต้องรอผู้เล่นกรอกรหัสเองก่อน (ช่องกรอกรหัสถูกโชว์ไว้แล้วจาก updateJoinCardMode ด้านบน)
    if (suggestedRoomData.hasJoinCode) {
        if (sub) {
            sub.textContent = suggestedRoomData.hostName
                ? `ห้องของ ${suggestedRoomData.hostName} ต้องใช้รหัส — กรอกรหัสแล้วกดเข้าร่วม`
                : "ห้องนี้ต้องใช้รหัส — กรอกรหัสแล้วกดเข้าร่วม";
        }
        return;
    }

    if (sub) {
        if (nameConfirmed) {
            sub.textContent = suggestedRoomData.hostName
                ? `ห้องของ ${suggestedRoomData.hostName} พร้อมแล้ว — กำลังพาเข้าให้อัตโนมัติ`
                : "ห้องพร้อมแล้ว — กำลังพาเข้าให้อัตโนมัติ";
        } else {
            sub.textContent = suggestedRoomData.hostName
                ? `ห้องของ ${suggestedRoomData.hostName} เปิดอยู่ — กดเข้าร่วมได้เลย`
                : "ห้องเปิดอยู่ — กดเข้าร่วมได้เลย";
        }
    }
}

// รับห้องที่เปิดอยู่ล่าสุดจากเซิร์ฟเวอร์ (กรณีเล่นกับเพื่อนกลุ่มเดียว มีห้องเดียว → auto-fill)
// เซิร์ฟเวอร์ส่ง event นี้ทันทีตอนต่อ socket สำเร็จอยู่แล้ว จึงครอบคลุมทั้งเคส
// "มีห้องเปิดอยู่แล้วตอนเปิดเว็บ" และ "ห้องเพิ่งถูกเปิดขณะเรารออยู่"
socket.on("suggested_room", (data) => {
    suggestedRoomData = data;
    updateLobbyRoomVisual();
    renderRoomSuggestion();
    if (!previousRoomDecisionPending && !previousRoomCheckInFlight) maybeAutoJoin();
});

// โฮสต์แก้ชื่อเราจากฝั่งเขา — จำชื่อใหม่นี้ไว้เป็นชื่อปัจจุบันของเครื่องนี้ต่อ
// (ครั้งหน้าที่ auto-join จะใช้ชื่อนี้ ไม่ใช่ชื่อเดิมที่เราตั้งเอง)
socket.on("name_updated_by_host", (data) => {
    if (!data || !data.name) return;
    ww_store.setItem("ww_playerName", data.name);
    nameConfirmed = true;
    const nameInput = document.getElementById("name");
    if (nameInput) nameInput.value = data.name;
    updateJoinCardMode();
    sendPlayerPresence();
});

// บัญชีจริงถูกจัดการโดย Admin จากหน้า "ผู้เล่นทั้งหมด"
function handleManagedAccountSession(reason) {
    playerAllowIntentionalExit("managed_account_session");
    playerBrowserExitServerClosed = true;
    playerBrowserExitGuardState(false, "managed_account_session");
    if (reason === "account_deleted") {
        try { window.wwAccount?.markAccountDeleted("account_deleted"); } catch (_) {}
        try {
            localStorage.removeItem("ww_playerName");
            localStorage.removeItem("ww_host_display_name");
        } catch (_) {}
    }
    try {
        ww_store.removeItem("ww_token");
        ww_store.removeItem("ww_lastRoom");
        ww_store.removeItem("ww_joinedRoom");
    } catch (_) {}
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

// SWITCH CHAT TAB
let playerBadgeCounts = { global: 0, wolf: 0, instigator: 0, cult: 0, bandit: 0 };

// map ชื่อแท็บ -> id ต่างๆ ที่เกี่ยวข้อง ใช้กับ switchChatTab/renderChatMessage/ฯลฯ เพื่อไม่ต้องเขียน
// เงื่อนไข ternary ซ้ำๆ ทุกจุดเวลาต้องเพิ่มแท็บใหม่ (เช่นตอนเพิ่มแชททีมยุยง 🎭)
const CHAT_TAB_IDS = {
    global: { box: "chatBoxGlobal", tab: "tabGlobal", badge: "badgeGlobal" },
    wolf: { box: "chatBoxWolf", tab: "tabWolf", badge: "badgeWolf" },
    instigator: { box: "chatBoxInstigator", tab: "tabInstigator", badge: "badgeInstigator" },
    cult: { box: "chatBoxCult", tab: "tabCult", badge: "badgeCult" },
    bandit: { box: "chatBoxBandit", tab: "tabBandit", badge: "badgeBandit" },
};

function updateChatUnreadTotal() {
    const total = Object.values(playerBadgeCounts || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const el = document.getElementById("chatUnreadTotal");
    if (!el) return;
    el.textContent = total > 99 ? "99+" : String(total);
    el.classList.toggle("hidden", total <= 0);
}

function openPlayerChat() {
    const card = document.getElementById("chatCard");
    if (!card || card.classList.contains("hidden")) return;
    document.body.classList.add("player-chat-open");
    const btn = document.getElementById("chatToggleBtn");
    if (btn) btn.setAttribute("aria-expanded", "true");
    window.setTimeout(() => {
        const box = activeChatBoxForHud();
        if (box) box.scrollTop = box.scrollHeight;
    }, 0);
}

function closePlayerChat() {
    document.body.classList.remove("player-chat-open");
    const btn = document.getElementById("chatToggleBtn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    const input = document.getElementById("chatInput");
    if (input && document.activeElement === input) input.blur();
}

function togglePlayerChat() {
    if (document.body.classList.contains("player-chat-open")) closePlayerChat();
    else openPlayerChat();
}

function activeChatBoxForHud() {
    const ids = CHAT_TAB_IDS[currentChatTab] || CHAT_TAB_IDS.global;
    return document.getElementById(ids.box);
}

function switchChatTab(tab) {

    currentChatTab = tab;

    Object.entries(CHAT_TAB_IDS).forEach(([name, ids]) => {
        document.getElementById(ids.tab)?.classList.toggle("active", tab === name);
        document.getElementById(ids.box)?.classList.toggle("hidden", tab !== name);
    });

    // reset badge for active tab
    playerBadgeCounts[tab] = 0;
    const badgeEl = document.getElementById(CHAT_TAB_IDS[tab]?.badge || "badgeGlobal");
    badgeEl.textContent = "0";
    badgeEl.classList.add("zero");
    updateChatUnreadTotal();

    // scroll to bottom
    const box = document.getElementById(CHAT_TAB_IDS[tab]?.box || "chatBoxGlobal");
    box.scrollTop = box.scrollHeight;

    // อัปเดต night notice ตามแท็บที่เลือก
    const nightNotice = document.getElementById("nightNotice");
    if (nightNotice) {
        if (isNight && tab === "global") nightNotice.classList.add("visible");
        else nightNotice.classList.remove("visible");
    }
    // อัปเดต placeholder
    const chatInputEl = document.getElementById("chatInput");
    if (chatInputEl && !mySilenced) {
        chatInputEl.placeholder = (isNight && tab === "global")
            ? "พิมพ์ข้อความ... (ส่งไม่ได้ช่วงกลางคืน)"
            : "พิมพ์ข้อความ...";
    }
    updateChatInputAvailability(); // แท็บทีมโจร: ผู้สมรู้ร่วมคิดอ่านได้อย่างเดียว พิมพ์ไม่ได้ (ทับ placeholder ด้านบนถ้าจำเป็น)

}

// อัปเดตสถานะ "พิมพ์ได้/ไม่ได้" ของกล่องแชท เฉพาะกรณีแท็บทีมโจร (ผู้สมรู้ร่วมคิดอ่านได้อย่างเดียว พิมพ์ไม่ได้
// มีแค่หัวโจรเท่านั้นที่พิมพ์ได้) เรียกทั้งตอนสลับแท็บและตอนได้รับ your_role ใหม่ — ไม่แตะ mySilenced/กลางคืน
// เพราะเงื่อนไขพวกนั้นถูกจัดการแยกไว้แล้วที่อื่น (ฟังก์ชันนี้ทำงานทับเป็นชั้นสุดท้ายเท่านั้น)
function updateChatInputAvailability() {
    if (currentChatTab !== "bandit") return;
    const chatInputEl = document.getElementById("chatInput");
    const chatSendBtn = document.querySelector(".sendBtn");
    if (!window.__isBanditLeader) {
        if (chatInputEl) { chatInputEl.disabled = true; chatInputEl.placeholder = "🗡️ อ่านได้อย่างเดียว — มีแค่หัวโจรที่พิมพ์ได้"; }
        if (chatSendBtn) { chatSendBtn.disabled = true; }
    } else if (!mySilenced) {
        if (chatInputEl) { chatInputEl.disabled = false; chatInputEl.placeholder = "พิมพ์ข้อความ..."; }
        if (chatSendBtn) { chatSendBtn.disabled = false; }
    }
}

// getRoleIcon ดึง icon จาก allRolesData ที่ server ส่งมา (single source of truth)
function getRoleIcon(role) {
    const src = (allRolesData[role] && allRolesData[role].icon) || (wwImg("/images/default-role.jpg"));
    return `<img src="${src}" alt="${role}">`;
}
let allRolesData = {};   // จาก roles_data event
let openRoleDescKeys = new Set(); // เก็บว่าใบไหนกำลังเปิดคำอธิบายอยู่ (คงสถานะไว้ตอน re-render)
let lastRoomData = null; // เก็บ roomData ล่าสุดเพื่อ re-render กริดหลังรับบท

// พรีโหลดรูปไอคอนอาชีพทั้งหมดล่วงหน้า (โหลดแอบไว้ใน cache ของเบราว์เซอร์)
// เพื่อกันรูปกระตุก/เด้งช้าเวลาที่ต้องโผล่ขึ้นมาจริงๆ (เปิดดูบท, เปิดคำอธิบายอาชีพ ฯลฯ)
const preloadedIcons = new Set();
function preloadRoleImages(rolesData) {
    Object.values(rolesData || {}).forEach((info) => {
        const src = info && info.icon;
        if (!src || preloadedIcons.has(src)) return;
        preloadedIcons.add(src);
        const img = new Image();
        img.src = src;
    });
}
// wolfRoles และ allWolfRoles จะถูก populate จาก roles_data event ที่ server ส่งมา
// (server เก็บ __wolfRoles ไว้ใน buildRolesData()) ไม่ต้อง hardcode ที่นี่
let wolfRoles = new Set([
    "หมาป่า", "ลูกหมาป่า", "หมาป่าผู้พิทักษ์", "หมาป่าดื้อรั้น", "หมาป่านักเวท", "หมาป่าหยั่งรู้"
]);
// allWolfRoles ใช้ชื่อเดิมเพื่อ backward compat กับโค้ดที่ใช้ .includes()
let allWolfRoles = [...wolfRoles];

// บทบาทที่ "วางโล่ป้องกันการประหาร" ได้ (กลไก select_shield/guardianShieldAvailable ร่วมกัน)
// หมาป่าผู้พิทักษ์ (ทีมหมาป่า) และหนูน้อยผู้ใสซื่อ (ทีมชาวบ้าน, ไอคอน 🌼)
// ใช้กลไกเดียวกันทุกประการ ต่างกันแค่ทีม/ไอคอน — เพิ่มบทใหม่ที่ใช้กลไกนี้ที่นี่ที่เดียว
// โล่ของหมาป่าผู้พิทักษ์โดยเฉพาะเปลี่ยนจากอิโมจิ 🛡️ เป็นรูป shield.jpg แล้ว (หนูน้อยผู้ใสซื่อยังใช้ 🌼 อิโมจิเหมือนเดิม
// ไม่ได้ขอเปลี่ยน) — getGuardianShieldHTML() คืน HTML string (รูปหรืออิโมจิแล้วแต่บท) ใช้แทน getGuardianShieldIcon()
// เดิมทั้งสองจุด: ไอคอนบนปุ่มกดสกิล (#shieldIcon) และแบดจ์บนการ์ดคนที่โดนวางโล่ (.player-shield-badge)
const GUARDIAN_SHIELD_ICONS = { "หมาป่าผู้พิทักษ์": "🛡️", "หนูน้อยผู้ใสซื่อ": "🌼" };
const GUARDIAN_ROLES = new Set(Object.keys(GUARDIAN_SHIELD_ICONS));
function getGuardianShieldHTML(role) {
    if (role === "หมาป่าผู้พิทักษ์") return `<img src="${wwImg("/images/shield.jpg")}" alt="🛡️">`;
    return GUARDIAN_SHIELD_ICONS[role] || "🛡️";
}

function castVote(targetId) {
    if (!currentRoomId) return;
    socket.emit("cast_vote", { roomId: currentRoomId, targetId });
}

function castWolfKill(targetId) {
    if (!currentRoomId) return;
    socket.emit("cast_wolf_kill", { roomId: currentRoomId, targetId });
}

function castMurdererKill(targetId) {
    if (!currentRoomId) return;
    socket.emit("cast_murderer_kill", { roomId: currentRoomId, targetId });
}

// ผู้ยุยง: หลังผู้ศรัทธาทั้งสองตายแล้วเท่านั้น — ฆ่าผู้เล่นคนอื่นด้วยตัวเองได้ 1 คนต่อคืน (ดู cast_instigator_kill)
function castInstigatorKill(targetId) {
    if (!currentRoomId) return;
    socket.emit("cast_instigator_kill", { roomId: currentRoomId, targetId });
}

// ส่อง (หมาป่าหยั่งรู้ / ผู้มีลาง / ผู้หยั่งรู้) — เปิดเผยผลทันที ย้อนกลับไม่ได้ ใช้ได้คนละ 1 ครั้งต่อคืน
function scoutTarget(targetId) {
    if (!currentRoomId || !targetId) return;
    socket.emit("scout_target", { roomId: currentRoomId, targetId });
}

// นักสืบ: เลือก 2 คนพร้อมกันเพื่อดูว่าอยู่ทีมเดียวกันไหม (=/≠) — เปิดเผยผลทันที ย้อนกลับไม่ได้
// ใช้ได้คนละ 1 ครั้งต่อคืน (การเลือกทีละคนทำที่ฝั่ง client ผ่าน detectivePendingFirstId แล้วค่อยยิง event นี้ทีเดียวตอนครบ 2 คน)
function detectiveScout(targetAId, targetBId) {
    if (!currentRoomId || !targetAId || !targetBId) return;
    socket.emit("detective_scout", { roomId: currentRoomId, targetAId, targetBId });
}

// กามเทพ: เลือก 2 คนเพื่อ "เลือกไว้" (pending) — จะกลายเป็นคู่รักจริงตอนเช้า ก่อนหน้านั้นเปลี่ยนใจได้เรื่อยๆ
// เรียกซ้ำได้เสมอ (แม้ครบ/ไม่ครบ 2 คน) เพื่ออัปเดต/ยกเลิกค่าที่เซิร์ฟเวอร์ — ดู performCupidPair
function cupidPair(targetAId, targetBId) {
    if (!currentRoomId) return;
    socket.emit("cupid_pair", { roomId: currentRoomId, targetAId: targetAId || null, targetBId: targetBId || null });
}

// ผู้ยุยง: เลือก 2 คนเพื่อ "เลือกไว้" (pending) — ทำงานแบบเดียวกับกามเทพเป๊ะๆ ดู performInstigatorPair
function instigatorPair(targetAId, targetBId) {
    if (!currentRoomId) return;
    socket.emit("instigator_pair", { roomId: currentRoomId, targetAId: targetAId || null, targetBId: targetBId || null });
}

// หมาป่าหยั่งรู้: สละลางสังหรณ์ กลายเป็นหมาป่าธรรมดาที่ร่วมล่าได้ — ย้อนกลับไม่ได้
// เดิมใช้ confirm() ของเบราว์เซอร์ (บล็อกทั้งหน้า ไม่เข้าธีม) เปลี่ยนเป็น wwConfirm ป๊อปอัปของเกมเอง
// พร้อมอธิบายผลของการกดให้ครบ เพราะย้อนกลับไม่ได้
async function confirmGiveUpOracleSense() {
    if (!currentRoomId) return;
    const btn = document.getElementById("oracleBtn");
    if (btn && btn.classList.contains("depleted")) return;
    const ok = await wwConfirm(
        "สละลางสังหรณ์แล้วกลายเป็นหมาป่าธรรมดา?\n\nคุณจะร่วมออกล่าเหยื่อกับฝูงหมาป่าได้ (ตอนกลางคืน) แต่จะไม่สามารถส่องเปิดเผยตัวตนของผู้เล่นคนอื่นได้อีกต่อไป\n\nการกระทำนี้ย้อนกลับไม่ได้"
    );
    if (!ok) return;
    giveUpOracleSense();
}

function giveUpOracleSense() {
    if (!currentRoomId) return;
    socket.emit("give_up_oracle_sense", { roomId: currentRoomId });
}

// นายก: เปิดเผยตัวว่าเป็นนายก — เปิดเผยบทให้ทุกคนเห็น + ประกาศในแชท + โหวตของตัวเองนับเป็น 2 เสียง
// ใช้ได้ครั้งเดียวตลอดเกม ย้อนกลับไม่ได้ ใช้ pattern เดียวกับ confirmGiveUpOracleSense
async function confirmRevealMayor() {
    if (!currentRoomId) return;
    const btn = document.getElementById("mayorBtn");
    if (btn && btn.classList.contains("depleted")) return;
    const ok = await wwConfirm(
        "เปิดเผยตัวเป็นนายก?\n\nทุกคนในห้องจะเห็นว่าคุณเป็นนายกทันที และตั้งแต่นี้คะแนนโหวตของคุณจะนับเป็น 2 เสียง\n\nการกระทำนี้ย้อนกลับไม่ได้"
    );
    if (!ok) return;
    revealMayor();
}

function revealMayor() {
    if (!currentRoomId) return;
    socket.emit("reveal_mayor", { roomId: currentRoomId });
}

// หมาป่าผู้พิทักษ์: วาง/ยกเลิกโล่ป้องกันการประหาร
function castShield(targetId) {
    if (!currentRoomId) return;
    socket.emit("select_shield", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะวางโล่" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะวางโล่แทนที่จะโหวต
// ใช้ได้ทั้งวัน ไม่ต้องรอโฮสต์เปิดโหมดโหวตก่อน (ถ้าเปิดโหมดโหวตอยู่แล้วก็ยังใช้งานร่วมกันได้ตามปกติ)
function toggleShieldMode() {
    const btn = document.getElementById("shieldBtn");
    if (btn.classList.contains("depleted")) return;
    shieldModeActive = !shieldModeActive;
    btn.classList.toggle("active", shieldModeActive);
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// ลูกหมาป่า: เลือก/ยกเลิกเป้าลากตายด้วย — ใช้ event select_target เดียวกับหมอ/บอดี้การ์ด/แม่มด(ยาป้องกัน)
// server.js อนุญาตให้ลูกหมาป่าเลือกได้ตลอดเวลา (ไม่บังคับเฉพาะกลางคืนเหมือนบทบาทอื่นในกลุ่มนี้)
function castWolfCubTarget(targetId) {
    if (!currentRoomId) return;
    socket.emit("select_target", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะเลือกเป้าลากตาย" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะจองเป้าลากแทนที่จะโหวต/อย่างอื่น
// ใช้ได้ตลอดเวลา ทั้งกลางวันและกลางคืน (ต่างจากโล่หมาป่าผู้พิทักษ์ที่ใช้ได้แค่กลางวัน) เหมือนกันตรงที่ใช้ร่วมกับ
// โหมดโหวตได้โดยไม่ต้องรอโฮสต์ปิดโหมดโหวตก่อน
function toggleWolfCubMode() {
    const btn = document.getElementById("pawBtn");
    if (!btn || btn.classList.contains("depleted")) return;
    wolfCubModeActive = !wolfCubModeActive;
    btn.classList.toggle("active", wolfCubModeActive);
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// เด็กขี้โวยวาย: เลือก/ยกเลิกเป้าไว้ล่วงหน้า — ใช้ event select_target เดียวกับลูกหมาป่า/หมอ/บอดี้การ์ด
// server.js อนุญาตให้เลือกได้ตลอดเวลา (ยกเว้นคืนแรกของเกมที่ server จะเมินคำสั่งเฉยๆ)
function castLoudmouthTarget(targetId) {
    if (!currentRoomId) return;
    socket.emit("select_target", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะเลือกเป้า" ของเด็กขี้โวยวาย — เหมือนลูกหมาป่าเป๊ะๆ ใช้ได้ตลอดเวลาทั้งกลางวัน/กลางคืน
function toggleLoudmouthMode() {
    const btn = document.getElementById("mouthBtn");
    if (!btn || btn.classList.contains("depleted")) return;
    loudmouthModeActive = !loudmouthModeActive;
    btn.classList.toggle("active", loudmouthModeActive);
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// หมาป่านักเวท: เลือก/ยกเลิกเป้าร่ายเวท — เลือกได้ตอนกลางวันเท่านั้น เปลี่ยนใจ/เปลี่ยนเป้าได้ไม่จำกัดจำนวนครั้ง
// คำสาปมีผลแค่วันนั้น/คืนนั้นเท่านั้น พอเข้าสู่เช้าวันถัดไปจะถูกล้างทิ้งอัตโนมัติ (ดู server.js resolve_night)
// ต้องเลือกเป้าใหม่เองทุกวัน ไม่มีการต่อเป้าเดิมให้อัตโนมัติ แม้อยากร่ายคนเดิมซ้ำก็ต้องกดเลือกเองใหม่
function castCurse(targetId) {
    if (!currentRoomId) return;
    socket.emit("select_curse_target", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะร่ายเวท" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะเลือก/ยกเลิกเป้าร่ายเวทแทนปกติ
function toggleCurseMode() {
    const btn = document.getElementById("curseBtn");
    if (!btn) return;
    if (btn.classList.contains("depleted")) return;
    if (isNight) return; // ใช้ได้เฉพาะตอนกลางวัน
    curseModeActive = !curseModeActive;
    btn.classList.toggle("active", curseModeActive);
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// ผู้นำลัทธิ: ชักชวนผู้เล่นเข้าร่วมลัทธิ — เลือกได้เฉพาะตอนกลางคืนเท่านั้น เปลี่ยนใจ/ยกเลิกได้จนกว่าจะถึงเช้า
function castCultRecruit(targetId) {
    if (!currentRoomId) return;
    socket.emit("cult_action", { roomId: currentRoomId, mode: targetId ? "recruit" : null, targetId });
}

// สลับโหมด "กำลังจะชักชวนเข้าลัทธิ" — ปิดโหมดสังเวยทิ้งอัตโนมัติถ้าเปิดอยู่ (ใช้พร้อมกันไม่ได้)
function toggleCultRecruitMode() {
    const btn = document.getElementById("cultRecruitBtn");
    if (!btn) return;
    if (btn.classList.contains("depleted")) return; // ตายแล้ว/ไม่ใช่ตอนกลางคืน — กดไม่ได้เหมือนปุ่มอื่นๆ
    if (!isNight) return; // ใช้ได้เฉพาะตอนกลางคืนเท่านั้น
    cultRecruitModeActive = !cultRecruitModeActive;
    if (cultRecruitModeActive) {
        cultSacrificeModeActive = false;
        cultSacrificePendingMemberId = null;
        document.getElementById("cultSacrificeBtn")?.classList.remove("active");
    }
    btn.classList.toggle("active", cultRecruitModeActive);
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// ผู้นำลัทธิ: สังเวยสมาชิกลัทธิ 1 คน เพื่อฆ่าผู้เล่นอีกคนหนึ่ง — เลือกได้เฉพาะตอนกลางคืนเท่านั้น
function castCultSacrifice(sacrificeId, targetId) {
    if (!currentRoomId) return;
    socket.emit("cult_action", {
        roomId: currentRoomId,
        mode: (sacrificeId && targetId) ? "sacrifice" : null,
        sacrificeId,
        targetId,
    });
}

// สลับโหมด "กำลังจะสังเวยสมาชิก" — ต้องแตะ 2 คนตามลำดับ: สมาชิกลัทธิของตัวเองก่อน แล้วค่อยแตะเป้าที่จะฆ่า
function toggleCultSacrificeMode() {
    const btn = document.getElementById("cultSacrificeBtn");
    if (!btn) return;
    if (btn.classList.contains("depleted")) return; // ตายแล้ว/ไม่ใช่กลางคืน/ไม่มีสมาชิกให้สังเวย — กดไม่ได้
    if (!isNight) return; // ใช้ได้เฉพาะตอนกลางคืนเท่านั้น
    cultSacrificeModeActive = !cultSacrificeModeActive;
    cultSacrificePendingMemberId = null;
    if (cultSacrificeModeActive) {
        cultRecruitModeActive = false;
        document.getElementById("cultRecruitBtn")?.classList.remove("active");
    }
    btn.classList.toggle("active", cultSacrificeModeActive);
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// โจร: เปลี่ยนบทบาทผู้เล่นให้เป็นผู้สมรู้ร่วมคิด — ใช้ได้เฉพาะคืนที่ยังไม่มีผู้สมรู้ร่วมคิดเท่านั้น
// เปลี่ยนใจ/ยกเลิกได้จนกว่าจะถึงเช้า (targetId = null → ยกเลิกการเลือก) แตะการ์ดเป้าตรงๆ ได้เลย ไม่ต้อง
// กดปุ่มเข้าโหมดก่อน (ดู renderPlayerGrid — รวมอยู่กลุ่มเดียวกับหมอ/บอดี้การ์ด/ยายขี้โมโห)
function castBanditRecruit(targetId) {
    if (!currentRoomId) return;
    socket.emit("bandit_action", { roomId: currentRoomId, targetId });
}

// โจร/ผู้สมรู้ร่วมคิด: เลือกเป้าฆ่าร่วมกับทีมโจร — ใช้ได้เฉพาะคืนที่มีผู้สมรู้ร่วมคิดอยู่แล้วเท่านั้น
// หัวโจรกับผู้สมรู้ร่วมคิดต่างเลือกเป้าเองได้อิสระ ถ้าเลือกคนละเป้ากันจะสุ่ม 1 เป้าตอน resolve_night
// แตะการ์ดเป้าตรงๆ ได้เลยเช่นกัน ไม่ต้องกดปุ่มเข้าโหมดก่อน
function castBanditKill(targetId) {
    if (!currentRoomId) return;
    socket.emit("cast_bandit_kill", { roomId: currentRoomId, targetId });
}

// ศาลเตี้ย: ยิงปืน (มีนัดเดียว ใช้ได้เฉพาะตอนกลางวัน) — ยืนยันก่อนยิงทุกครั้งเพราะย้อนกลับไม่ได้
async function fireSheriffGun(targetId) {
    if (!currentRoomId || !targetId) return;
    const target = lastRoomData?.players?.find(p => p.id === targetId);
    const ok = await wwConfirm(`ยืนยันยิง ${target?.name || "ผู้เล่นนี้"} ด้วยกระสุนนัดเดียวของคุณ? การกระทำนี้ย้อนกลับไม่ได้ และบทของคุณจะถูกเปิดเผยให้ทุกคนเห็นทันที`);
    gunModeActive = false;
    const btn = document.getElementById("gunBtn");
    if (btn) btn.classList.remove("active");
    if (!ok) {
        if (lastRoomData) renderPlayerGrid(lastRoomData);
        return;
    }
    socket.emit("fire_sheriff_gun", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะเล็งยิง" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะยิงแทนที่จะเป็นการเลือกเป้าปกติ
function toggleGunMode() {
    const btn = document.getElementById("gunBtn");
    if (btn.classList.contains("depleted")) return;
    if (isNight) return; // ใช้ได้เฉพาะตอนกลางวัน
    gunModeActive = !gunModeActive;
    btn.classList.toggle("active", gunModeActive);
    // ปิดโหมดดูบทถ้ากำลังเปิดโหมดยิงอยู่ (ใช้ได้ทีละอย่าง วันละ 1 ความสามารถ)
    if (gunModeActive && peekModeActive) {
        peekModeActive = false;
        document.getElementById("peekBtn").classList.remove("active");
    }
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// ศาลเตี้ย: ดูบทบาทผู้เล่น (ดูได้คนเดียว เห็นเฉพาะตัวเอง เหมือนผู้หยั่งรู้ — ใช้ได้เฉพาะตอนกลางวัน)
function peekSheriffTarget(targetId) {
    if (!currentRoomId || !targetId) return;
    peekModeActive = false;
    const btn = document.getElementById("peekBtn");
    if (btn) btn.classList.remove("active");
    socket.emit("sheriff_peek_target", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะดูบทบาท" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะดูบทแทนที่จะเป็นการเลือกเป้าปกติ
function togglePeekMode() {
    const btn = document.getElementById("peekBtn");
    if (btn.classList.contains("depleted")) return;
    if (isNight) return; // ใช้ได้เฉพาะตอนกลางวัน
    peekModeActive = !peekModeActive;
    btn.classList.toggle("active", peekModeActive);
    // ปิดโหมดยิงถ้ากำลังเปิดโหมดดูบทอยู่ (ใช้ได้ทีละอย่าง วันละ 1 ความสามารถ)
    if (peekModeActive && gunModeActive) {
        gunModeActive = false;
        document.getElementById("gunBtn").classList.remove("active");
    }
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// นักเล่นกล: กด 🔥 ฆ่าผู้เล่นทุกคนที่ปลอมบทไว้ (สะสมจากหลายคืน) พร้อมกันทีเดียว ใช้ได้เฉพาะตอนกลางวัน
// ไม่ต้องเลือกเป้า — เซิร์ฟเวอร์จะฆ่าทุกคนใน illusionTargetIds ที่ยังมีชีวิตอยู่ให้เอง ยืนยันก่อนทุกครั้งเพราะย้อนกลับไม่ได้
async function illusionKillDisguised() {
    if (!currentRoomId) return;
    const myPlayer = lastRoomData?.players?.find(p => p.id === socket.id);
    const disguisedIds = Array.isArray(myPlayer?.illusionTargetIds) ? myPlayer.illusionTargetIds : [];
    const aliveDisguisedNames = disguisedIds
        .map((tid) => lastRoomData?.players?.find(p => p.id === tid))
        .filter((t) => t && t.alive)
        .map((t) => t.name);
    if (aliveDisguisedNames.length === 0) {
        wwAlert("ตอนนี้ยังไม่มีใครที่คุณปลอมบทไว้ที่ยังมีชีวิตอยู่ (หรืออาจจะยังเป็นเวลากลางคืนอยู่ — ใช้ได้เฉพาะตอนกลางวันเท่านั้น)");
        return;
    }
    const ok = await wwConfirm(`ยืนยันฆ่าผู้เล่นที่คุณปลอมบทไว้ทั้งหมด (${aliveDisguisedNames.join(", ")})? การกระทำนี้ย้อนกลับไม่ได้ และพวกเขาจะปรากฏเป็นนักเล่นกลให้ทุกคนเห็น`);
    if (!ok) return;
    socket.emit("illusion_kill_disguised", { roomId: currentRoomId });
}

// นักบวช: ปาน้ำมนต์ (มีขวดเดียวตลอดเกม ใช้ได้เฉพาะตอนกลางวัน) — ยืนยันก่อนปาทุกครั้งเพราะย้อนกลับไม่ได้
// ถ้าเป้าเป็นหมาป่า เป้าจะตาย แต่ถ้าเป้าไม่ใช่หมาป่า นักบวชจะตายเองแทน (server เป็นคนตัดสินผลจริง)
async function castPriestHolyWater(targetId) {
    if (!currentRoomId || !targetId) return;
    const target = lastRoomData?.players?.find(p => p.id === targetId);
    const ok = await wwConfirm(`ยืนยันปาน้ำมนต์ใส่ ${target?.name || "ผู้เล่นนี้"} ด้วยน้ำมนต์ขวดเดียวของคุณ? หากเป้าเป็นหมาป่า เป้าจะตาย แต่ถ้าไม่ใช่ คุณจะตายเองแทน การกระทำนี้ย้อนกลับไม่ได้ และบทของคุณจะถูกเปิดเผยให้ทุกคนเห็นทันที`);
    holyWaterModeActive = false;
    const btn = document.getElementById("holyWaterBtn");
    if (btn) btn.classList.remove("active");
    if (!ok) {
        if (lastRoomData) renderPlayerGrid(lastRoomData);
        return;
    }
    socket.emit("cast_priest_holy_water", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะปาน้ำมนต์" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะปาน้ำมนต์แทนที่จะเป็นการเลือกเป้าปกติ
function toggleHolyWaterMode() {
    const btn = document.getElementById("holyWaterBtn");
    if (!btn || btn.classList.contains("depleted")) return;
    if (isNight) return; // ปาได้เฉพาะตอนกลางวัน
    holyWaterModeActive = !holyWaterModeActive;
    btn.classList.toggle("active", holyWaterModeActive);
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// แม่มด: โยนยาพิษ (มีขวดเดียวตลอดเกม ใช้แล้วตายทันที) — ยืนยันก่อนทุกครั้งเพราะย้อนกลับไม่ได้
async function castWitchPoison(targetId) {
    if (!currentRoomId || !targetId) return;
    const target = lastRoomData?.players?.find(p => p.id === targetId);
    const ok = await wwConfirm(`ยืนยันโยนยาพิษใส่ ${target?.name || "ผู้เล่นนี้"}? ตายทันที ป้องกันไม่ได้ และย้อนกลับไม่ได้ (มีขวดเดียวตลอดเกม)`);
    poisonModeActive = false;
    const btn = document.getElementById("poisonBtn");
    if (btn) btn.classList.remove("active");
    if (!ok) {
        if (lastRoomData) renderPlayerGrid(lastRoomData);
        return;
    }
    socket.emit("cast_witch_poison", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะโยนยาพิษ" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะปายาพิษแทนที่จะเป็นการเลือกเป้าปกติ
function togglePoisonMode() {
    const btn = document.getElementById("poisonBtn");
    if (btn.classList.contains("depleted")) return;
    if (!isNight) return; // ใช้ได้เฉพาะตอนกลางคืน
    if ((lastRoomData?.nightCount || 0) <= 1) return; // ห้ามใช้คืนแรก — ปุ่มมืดเหมือนของหมดแล้ว ไม่ต้องแจ้งเตือน
    poisonModeActive = !poisonModeActive;
    btn.classList.toggle("active", poisonModeActive);
    // ปิดโหมดยาป้องกันถ้ากำลังเปิดโหมดยาพิษอยู่ (แม่มดใช้ได้ทีละโหมด — มี 2 โหมดแยกกัน: ยาป้องกัน/ยาพิษ)
    if (poisonModeActive && protectModeActive) {
        protectModeActive = false;
        document.getElementById("protectBtn")?.classList.remove("active");
    }
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// แม่มด: เลือก/ยกเลิกเป้าที่จะใช้ยาป้องกัน — ใช้กลไกเดียวกับหมอ/บอดี้การ์ด (select_target)
// มีขวดเดียวตลอดเกม แต่เปลี่ยนเป้าได้ทุกคืนจนกว่าจะเคยกันการโจมตีสำเร็จจริงหนึ่งครั้ง (ดู server.js)
function castProtect(targetId) {
    if (!currentRoomId) return;
    socket.emit("select_target", { roomId: currentRoomId, targetId });
}

// สลับโหมด "กำลังจะเลือกยาป้องกัน" — เมื่อเปิดอยู่ การแตะชื่อผู้เล่นในกริดจะวางยาป้องกันแทนที่จะเป็นการเลือกเป้าปกติ
// แม่มดมี 2 ความสามารถ (ยาป้องกัน/ยาพิษ) ที่ต่างกันตอนแตะการ์ดเดียวกัน จึงต้องมีปุ่มเข้าโหมดแยก
// ให้รู้ว่ากำลังจะใช้ความสามารถไหน (ต่างจากยายขี้โมโห/หมอ/บอดี้การ์ดที่มีแค่ความสามารถเดียว แตะตรงได้เลย)
function toggleProtectMode() {
    const btn = document.getElementById("protectBtn");
    if (!btn || btn.classList.contains("depleted")) return;
    if (!isNight) return; // ใช้ได้เฉพาะตอนกลางคืน
    if ((lastRoomData?.nightCount || 0) <= 1) return; // ห้ามใช้คืนแรก — ปุ่มมืดเหมือนของหมดแล้ว ไม่ต้องแจ้งเตือน
    protectModeActive = !protectModeActive;
    btn.classList.toggle("active", protectModeActive);
    // ปิดโหมดยาพิษถ้ากำลังเปิดโหมดยาป้องกันอยู่ (แม่มดใช้ได้ทีละโหมด)
    if (protectModeActive && poisonModeActive) {
        poisonModeActive = false;
        document.getElementById("poisonBtn")?.classList.remove("active");
    }
    if (lastRoomData) renderPlayerGrid(lastRoomData);
}

// หมายเหตุ: castSilence เดิมถูกตัดออกแล้ว เพราะยายขี้โมโหใช้ selectTarget() ตัวเดียวกับหมอ/บอดี้การ์ดโดยตรง
// (ทั้งสองก็ยิง "select_target" event เดียวกันอยู่แล้ว ไม่ต้องมีฟังก์ชันแยก)

// หมายเหตุ: เดิมมีปุ่มแยกเข้า "โหมดเลือกใบ้" (toggleSilenceMode) แต่ตัดออกแล้ว —
// ยายขี้โมโหแตะการ์ดเป้าตรงๆ ได้เลยเหมือนหมอ/บอดี้การ์ด ไม่ต้องกดปุ่มเข้าโหมดก่อนอีกต่อไป

// หมายเหตุ: แก้บั๊ก — เดิมพอแม่มดกดปุ่ม 🧪 เข้าโหมดแล้วแตะเลือกเป้าล็อกไว้ (ออกจากโหมดอัตโนมัติ)
// ไอคอนที่ควรค้างโชว์ที่เป้าที่ล็อกไว้กลับหายไปเลย เพราะ badge เดิมผูกกับ mode === "protect" เท่านั้น
// (เหมือนบั๊กเดียวกับโล่หมาป่าผู้พิทักษ์/อุ้งเท้าลูกหมาป่า) ตอนนี้แยก badge ตอน "ล็อกเป้าแล้ว" ออกมา
// แสดงผลอิสระจาก mode (ดู block "amIWitch" ในส่วนแสดงไอคอนด้านล่าง) ยังคงต้องกดปุ่มเข้าโหมดก่อนเลือก
// เป้าเหมือนเดิม (แยกจากยาพิษ) แต่พอเลือกล็อกแล้วไอคอนจะนิ่ง ไม่เด้ง และไม่หายไปอีก

function openRolePopup() {
    document.getElementById("rolePopup").classList.remove("hidden");
    document.getElementById("rolePopupOverlay").classList.remove("hidden");
    document.body.classList.add("vote-open");
}

function closeRolePopup() {
    document.getElementById("rolePopup").classList.add("hidden");
    document.getElementById("rolePopupOverlay").classList.add("hidden");
    document.body.classList.remove("vote-open");
}

// เปิด/ปิด คำอธิบายอาชีพอื่น ในลิสต์ "บทในเกมรอบนี้"
// หา panel จาก wrapper ของปุ่มที่กดจริง (ไม่ใช้ getElementById เพราะรายการนี้มี 2 สำเนา — ป๊อปอัปกับแผงซ้าย —
// ดูคอมเมนต์ที่ buildRows) แล้วซิงค์สถานะเปิด/ปิดให้ทุกสำเนาที่ใช้ key เดียวกัน จอกว้างที่เห็นทั้งสองที่พร้อมกัน
// จึงเปิด/ปิดตรงกันเสมอ
function toggleRoleDesc(btn, key) {
    const ownWrap = btn.closest(".role-row-wrap");
    const ownPanel = ownWrap && ownWrap.querySelector(".role-desc-panel");
    if (!ownPanel) return;

    const willOpen = ownPanel.classList.contains("hidden");

    document.querySelectorAll(".role-row-wrap").forEach((wrap) => {
        if (wrap.dataset.key !== key) return;
        const panel = wrap.querySelector(".role-desc-panel");
        const toggle = wrap.querySelector(".role-toggle-btn");
        if (panel) panel.classList.toggle("hidden", !willOpen);
        if (toggle) toggle.classList.toggle("open", willOpen);
    });

    if (willOpen) openRoleDescKeys.add(key);
    else openRoleDescKeys.delete(key);
}

// JOIN ROOM — ใช้แค่ครั้งแรกที่ตั้งชื่อ (การกดปุ่มนี้ = ยืนยันชื่อ) ครั้งต่อ ๆ ไป
// เครื่องนี้จะจำชื่อไว้แล้ว auto-join เอง ไม่ต้องกดปุ่มนี้อีก (ดู maybeAutoJoin/doJoin ด้านบน)
function join() {


    const playerName =
        document.getElementById("name")
        .value
        .trim();

    if (!playerName) {

        wwAlert("กรอกชื่อก่อน");
        return;

    }

    // ยืนยันชื่อ + ล็อกช่องกรอกไว้ทันที ต่อจากนี้เครื่องนี้จะจำชื่อนี้ตลอด
    // (แก้ได้อีกทีเฉพาะตอนโฮสต์เป็นคนแก้ให้เท่านั้น)
    nameConfirmed = true;
    updateJoinCardMode();

    // มีหลายห้องเปิดพร้อมกัน — ต้องพิมพ์โค้ดห้องเอง (ช่อง #room ถูกโชว์ไว้แล้ว) เพราะ "ห้องล่าสุด"
    // ที่เซิร์ฟเวอร์แนะนำมาอาจไม่ใช่ห้องที่ผู้เล่นตั้งใจจะเข้าจริงๆ
    const multiRoom = isMultiRoomMode();
    let roomCode;
    if (multiRoom) {
        roomCode = document.getElementById("room").value.trim().toUpperCase();
        if (!roomCode) {
            wwAlert("ตอนนี้เซิร์ฟเวอร์มีหลายห้องเปิดพร้อมกัน — กรอกโค้ดห้องที่ผู้เล่าเรื่องบอกไว้ก่อน");
            return;
        }
    } else {
        roomCode = (suggestedRoomData && suggestedRoomData.roomId) || "";
    }

    if (!roomCode) {
        // ยังไม่มีห้องเปิด — บันทึกชื่อไว้ก่อน พอห้องเปิดจะเข้าให้อัตโนมัติทันที
        ww_store.setItem("ww_playerName", playerName);
        renderRoomSuggestion();
        return;
    }

    const joinCode = document.getElementById("joinCode").value.trim();
    doJoin(playerName, roomCode, { code: joinCode });

}

// ===== ROLE REVEAL ANIMATION =====

const ALL_ROLE_NAMES = [
    "ชาวบ้าน","หมอ","บอดี้การ์ด","ศาลเตี้ย","แม่มด","นักบวช","ผู้มีลาง","ผู้หยั่งรู้","นักสืบ","ยายขี้โมโห","ผู้ถูกสาป","อันธพาล","หนูน้อยผู้ใสซื่อ","นายก","เด็กขี้โวยวาย",
    "หมาป่า","ลูกหมาป่า","หมาป่าผู้พิทักษ์","หมาป่าดื้อรั้น","หมาป่านักเวท","หมาป่าหยั่งรู้",
    "คนบ้า","นักล่าหัว","ฆาตกรต่อเนื่อง","นักเล่นกล","กามเทพ","ผู้ยุยง"
];

function spawnRevealStars() {
    const container = document.getElementById("revealStars");
    container.innerHTML = "";
    for (let i = 0; i < 18; i++) {
        const s = document.createElement("div");
        s.className = "reveal-star";
        const angle = Math.random() * 360;
        const dist = 80 + Math.random() * 160;
        const tx = Math.cos(angle * Math.PI/180) * dist + "px";
        const ty = Math.sin(angle * Math.PI/180) * dist + "px";
        s.style.cssText = `
            left:${20+Math.random()*60}%;
            top:${20+Math.random()*60}%;
            --tx:${tx};
            --ty:${ty};
            animation:starPop ${.6+Math.random()*.8}s ease both ${.4+Math.random()*.4}s;
        `;
        container.appendChild(s);
    }
}

function playRoleReveal(roleData) {
    const overlay = document.getElementById("roleRevealOverlay");
    const slotText = document.getElementById("revealSlotText");
    const revealDesc = document.getElementById("revealDesc");
    const huntBox = document.getElementById("revealHuntBox");
    const huntNameText = document.getElementById("revealHuntNameText");

    // reset
    overlay.classList.remove("hidden");
    overlay.style.animation = "revealFadeIn .4s ease both";
    slotText.className = "";
    slotText.textContent = "—";
    revealDesc.style.opacity = "0";
    huntBox.classList.remove("visible");

    spawnRevealStars();

    // ดึงบทที่เป็นไปได้จาก config ห้อง (ถ้ามี) หรือใช้ทั้งหมด
    let pool = [...ALL_ROLE_NAMES];

    // Phase 1: สุ่มหมุน slot (700ms)
    let spinCount = 0;
    const totalSpins = 18;
    const spinInterval = setInterval(() => {
        const r = pool[Math.floor(Math.random() * pool.length)];
        slotText.textContent = r;
        slotText.className = "slot-spinning";
        spinCount++;
        if (spinCount >= totalSpins) {
            clearInterval(spinInterval);

            // Phase 2: แสดงบทจริง
            setTimeout(() => {
                slotText.textContent = roleData.displayRole || roleData.role;
                slotText.className = "slot-final";
                spawnRevealStars();

                // แสดง desc
                setTimeout(() => {
                    if (roleData.roleInfo) {
                        // ตัดท่อนสรุป "ทีม:...    ลาง:..." ท้ายคำอธิบายออกเฉพาะตอนสไลด์เปิดบทตัวเอง
                        // (ป้ายชื่อ+ทีม/ลาง ไม่จำเป็นตอนนี้ เก็บไว้โชว์เฉพาะตอนเปิดดูคำอธิบายอาชีพทีหลังแทน)
                        revealDesc.innerHTML = roleData.roleInfo.desc
                            ? roleData.roleInfo.desc.replace(/<br><br>ทีม:.*/, "")
                            : "";
                    }
                    revealDesc.style.animation = "revealSlideDown .45s ease both";
                    revealDesc.style.opacity = "1";

                    // Phase 3: ถ้าเป็นนักล่าหัว → แสดง hunt target พร้อม crosshair (พร้อมกับ desc)
                    if (roleData.huntTarget) {
                        huntNameText.textContent = roleData.huntTarget;
                        huntBox.classList.add("visible");
                        huntBox.style.animation = "revealSlideDown .5s cubic-bezier(.34,1.56,.64,1) both";
                    }

                    // Phase 4: fade out overlay ทุกบทใช้เวลาเท่ากัน
                    setTimeout(() => {
                        overlay.style.animation = "revealFadeOut .7s ease both";
                        setTimeout(() => {
                            overlay.classList.add("hidden");
                            overlay.style.animation = "";
                        }, 700);
                    }, 3200);

                }, 300);
            }, 80);
        }
    }, 80);
}

// ROLE RECEIVE
socket.on(
    "your_role",
    (data) => {

    // เล่นอนิเมชั่นเปิดเผยบท (ข้ามถ้าเป็นการส่งซ้ำแบบ "เงียบ" ตอนเชื่อมต่อใหม่ ไม่ใช่ได้บทครั้งแรก)
    // ถ้าตอนนี้ไม่ได้อยู่หน้าจอ (สลับแอป/ปิดจอ) ให้ข้ามอนิเมชั่นไปเลย ไม่เล่นมัน เพราะ
    // setTimeout/setInterval ที่ทยอยเล่นอนิเมชั่นจะถูกเบราว์เซอร์ throttle จนค้างกลางทาง
    // ทำให้ overlay บังหน้าจอค้างอยู่จนกว่าจะเปิดแท็บกลับมาเอง (ดูเหมือน "บทต้องรอเปิดจอก่อนถึงโหลด")
    // ข้อมูลบทจริง (myRole ฯลฯ) ด้านล่างจะถูกตั้งค่าทันทีอยู่แล้วไม่ว่าจะข้ามอนิเมชั่นหรือไม่
    if (!data.silent) {
        if (document.visibilityState === "visible") {
            playRoleReveal(data);
        } else {
            document.getElementById("roleRevealOverlay").classList.add("hidden");
        }
    }

myRole = data.role;
myHuntTargetId = data.huntTargetId || null;

    // อัปเดต bottom bar
    document.getElementById("barRoleName").textContent = data.displayRole;
    document.getElementById("barRoleSub").textContent = "แตะหน้ากากเพื่อดูรายละเอียด";

    // ปุ่มโล่ (เฉพาะบทที่วางโล่ป้องกันการประหารได้ — หมาป่าผู้พิทักษ์/หนูน้อยผู้ใสซื่อ)
    // แสดง/ซ่อนตามบท การอัปเดตจำนวนโล่จริงจะถูกซิงค์อีกทีจาก room_update
    const shieldBtn = document.getElementById("shieldBtn");
    if (GUARDIAN_ROLES.has(data.role)) {
        shieldBtn.classList.remove("hidden");
        const shieldIconEl = document.getElementById("shieldIcon");
        if (shieldIconEl) shieldIconEl.innerHTML = getGuardianShieldHTML(data.role);
        document.getElementById("shieldCount").textContent = data.guardianShieldAvailable ?? 1;
        shieldBtn.classList.toggle("depleted", !(data.guardianShieldAvailable > 0));
    } else {
        shieldBtn.classList.add("hidden");
        shieldModeActive = false;
        shieldBtn.classList.remove("active");
    }

    // ปุ่มลากตาย 🐾 (เฉพาะลูกหมาป่า) — แสดง/ซ่อนตามบท ใช้ได้ตลอดเวลา ไม่มีจำนวนจำกัด (เลือกเปลี่ยนเป้าได้เรื่อยๆ)
    const pawBtn = document.getElementById("pawBtn");
    if (pawBtn) {
        if (data.role === "ลูกหมาป่า") {
            pawBtn.classList.remove("hidden");
        } else {
            pawBtn.classList.add("hidden");
            wolfCubModeActive = false;
            pawBtn.classList.remove("active");
        }
    }

    // ปุ่มเลือกเป้า 👄 (เฉพาะเด็กขี้โวยวาย) — แสดง/ซ่อนตามบท ใช้ได้ตลอดเวลา ไม่มีจำนวนจำกัด (เลือกเปลี่ยนเป้าได้เรื่อยๆ)
    const mouthBtn = document.getElementById("mouthBtn");
    if (mouthBtn) {
        if (data.role === "เด็กขี้โวยวาย") {
            mouthBtn.classList.remove("hidden");
        } else {
            mouthBtn.classList.add("hidden");
            loudmouthModeActive = false;
            mouthBtn.classList.remove("active");
        }
    }

    // ปุ่มร่ายเวท (เฉพาะหมาป่านักเวท) — แสดง/ซ่อนตามบท ร่ายได้ไม่จำกัดจำนวนครั้ง ไม่มีสิทธิ์หมด
    const curseBtn = document.getElementById("curseBtn");
    if (data.role === "หมาป่านักเวท") {
        curseBtn.classList.remove("hidden");
    } else {
        curseBtn.classList.add("hidden");
        curseModeActive = false;
        curseBtn.classList.remove("active");
    }

    // ปุ่ม 🔯/🕯️ ผู้นำลัทธิ — แสดง/ซ่อนตามบท ใช้ได้ไม่จำกัดจำนวนครั้ง (แค่จำกัดจำนวนสมาชิกที่ยังมีชีวิตอยู่พร้อมกัน ดูฝั่งเซิร์ฟเวอร์)
    const cultRecruitBtn = document.getElementById("cultRecruitBtn");
    const cultSacrificeBtn = document.getElementById("cultSacrificeBtn");
    if (data.role === "ผู้นำลัทธิ") {
        if (cultRecruitBtn) cultRecruitBtn.classList.remove("hidden");
        if (cultSacrificeBtn) cultSacrificeBtn.classList.remove("hidden");
    } else {
        if (cultRecruitBtn) {
            cultRecruitBtn.classList.add("hidden");
            cultRecruitBtn.classList.remove("active");
        }
        if (cultSacrificeBtn) {
            cultSacrificeBtn.classList.add("hidden");
            cultSacrificeBtn.classList.remove("active");
        }
        cultRecruitModeActive = false;
        cultSacrificeModeActive = false;
        cultSacrificePendingMemberId = null;
    }

    // (ไม่มีปุ่มโหมดสำหรับโจร/ผู้สมรู้ร่วมคิดแล้ว — แตะการ์ดเลือกเป้าได้ตรงๆ เลย)

    // ปุ่มปืน (เฉพาะศาลเตี้ย) — แสดง/ซ่อนตามบท จำนวนกระสุนจริงจะถูกซิงค์อีกทีจาก room_update
    const gunBtn = document.getElementById("gunBtn");
    if (data.role === "ศาลเตี้ย") {
        gunBtn.classList.remove("hidden");
        document.getElementById("gunCount").textContent = data.sheriffBullets ?? 1;
        gunBtn.classList.toggle("depleted", !(data.sheriffBullets > 0));
    } else {
        gunBtn.classList.add("hidden");
        gunModeActive = false;
        gunBtn.classList.remove("active");
    }

    // ปุ่มดูบทบาท (เฉพาะศาลเตี้ย) — แสดง/ซ่อนตามบท จำนวนสิทธิ์จริงจะถูกซิงค์อีกทีจาก room_update
    const peekBtn = document.getElementById("peekBtn");
    if (data.role === "ศาลเตี้ย") {
        peekBtn.classList.remove("hidden");
        document.getElementById("peekCount").textContent = data.sheriffPeeks ?? 1;
        peekBtn.classList.toggle("depleted", !(data.sheriffPeeks > 0));
    } else {
        peekBtn.classList.add("hidden");
        peekModeActive = false;
        peekBtn.classList.remove("active");
    }

    // ปุ่มฆ่าผู้เล่นที่ปลอมบทไว้ 🔥 (เฉพาะนักเล่นกล) — แสดง/ซ่อนตามบท จำนวนคนที่ปลอมบทไว้จะถูกซิงค์อีกทีจาก room_update
    const illusionKillBtn = document.getElementById("illusionKillBtn");
    if (illusionKillBtn) {
        if (data.role === "นักเล่นกล") {
            illusionKillBtn.classList.remove("hidden");
        } else {
            illusionKillBtn.classList.add("hidden");
        }
    }

    // ปุ่มปาน้ำมนต์ (เฉพาะนักบวช) — แสดง/ซ่อนตามบท จำนวนขวดจริงจะถูกซิงค์อีกทีจาก room_update
    const holyWaterBtn = document.getElementById("holyWaterBtn");
    if (holyWaterBtn) {
        if (data.role === "นักบวช") {
            holyWaterBtn.classList.remove("hidden");
            document.getElementById("holyWaterCount").textContent = data.priestHolyWaterPotions ?? 1;
            holyWaterBtn.classList.toggle("depleted", !(data.priestHolyWaterPotions > 0));
        } else {
            holyWaterBtn.classList.add("hidden");
            holyWaterModeActive = false;
            holyWaterBtn.classList.remove("active");
        }
    }

    // ปุ่มโยนยาพิษ (เฉพาะแม่มด) — แสดง/ซ่อนตามบท จำนวนขวดจริงจะถูกซิงค์อีกทีจาก room_update
    const poisonBtn = document.getElementById("poisonBtn");
    if (data.role === "แม่มด") {
        poisonBtn.classList.remove("hidden");
        document.getElementById("poisonCount").textContent = data.witchPoisonPotions ?? 1;
        poisonBtn.classList.toggle("depleted", !(data.witchPoisonPotions > 0));
    } else {
        poisonBtn.classList.add("hidden");
        poisonModeActive = false;
        poisonBtn.classList.remove("active");
    }

    // ปุ่มยาป้องกัน (เฉพาะแม่มด) — แสดง/ซ่อนตามบท จำนวนขวดจริงจะถูกซิงค์อีกทีจาก room_update
    const protectBtn = document.getElementById("protectBtn");
    if (data.role === "แม่มด") {
        protectBtn.classList.remove("hidden");
        document.getElementById("protectCount").textContent = data.witchProtectPotions ?? 1;
        protectBtn.classList.toggle("depleted", !(data.witchProtectPotions > 0));
    } else {
        protectBtn.classList.add("hidden");
        protectModeActive = false;
        protectBtn.classList.remove("active");
    }

    // ยายขี้โมโหไม่มีปุ่มเข้าโหมดใบ้แยกแล้ว (แตะการ์ดเป้าตรงๆ ได้เลยเหมือนหมอ/บอดี้การ์ด) — เหลือแค่เคลียร์ state เดิมไว้เผื่อบทเปลี่ยน
    silenceModeActive = false;

    // ปุ่มสละลางสังหรณ์ (เฉพาะหมาป่าหยั่งรู้) — แสดง/ซ่อนตามบททันที เหมือนปุ่มอื่น ๆ ด้านบน
    // สำคัญโดยเฉพาะตอน "สละ" สำเร็จ (role เปลี่ยนจากหมาป่าหยั่งรู้ → หมาป่าธรรมดา): ต้องซ่อนปุ่มนี้ทันที
    // ไม่งั้นจะค้างโชว์เป็นหมาป่าธรรมดาที่ยังมีปุ่ม 👁️ ให้กด ทั้งที่ไม่มีลางสังหรณ์ให้สละแล้ว
    const oracleBtn = document.getElementById("oracleBtn");
    if (data.role === "หมาป่าหยั่งรู้") {
        oracleBtn.classList.remove("hidden");
        oracleBtn.classList.remove("depleted");
    } else {
        oracleBtn.classList.add("hidden");
    }

    // ปุ่มเปิดเผยตัวนายก 🤠 (เฉพาะนายก) — แสดง/ซ่อนตามบททันที เหมือนปุ่มอื่น ๆ ด้านบน
    // depleted จริง (ใช้สิทธิ์ไปแล้ว/ตายแล้ว) จะถูกซิงค์อีกทีจาก room_update ด้านล่าง
    const mayorBtn = document.getElementById("mayorBtn");
    if (mayorBtn) {
        if (data.role === "นายก") {
            mayorBtn.classList.remove("hidden");
            mayorBtn.classList.remove("depleted");
        } else {
            mayorBtn.classList.add("hidden");
        }
    }

    // อัปเดต popup — ชื่อบท
    document.getElementById("popupRoleName").textContent = data.displayRole;

    // บทจริง (ถ้าสุ่ม)
    const popupRealRole = document.getElementById("popupRealRole");
    if (data.displayRole !== data.role) {
        popupRealRole.classList.remove("hidden");
        popupRealRole.innerHTML = `บทจริง: <b>${escapeHtml(data.role)}</b>`;
    } else {
        popupRealRole.classList.add("hidden");
    }

    // เป้าหมายล่า
    const popupHuntInfo = document.getElementById("popupHuntInfo");
    const barHuntBadge = document.getElementById("barHuntBadge");
    if (data.huntTarget) {
        popupHuntInfo.classList.remove("hidden");
        popupHuntInfo.innerHTML = `🎯 เป้าหมาย: <b>${escapeHtml(data.huntTarget)}</b>`;
        barHuntBadge.classList.remove("hidden");
        barHuntBadge.textContent = `🎯 ${data.huntTarget}`;
    } else {
        popupHuntInfo.classList.add("hidden");
        barHuntBadge.classList.add("hidden");
    }

    // คำอธิบายบท
    const popupRoleDesc = document.getElementById("popupRoleDesc");
    if (data.roleInfo) {
        const rawTitle = data.roleInfo.title || data.displayRole;
        const cleanTitle = rawTitle.replace(/<img[^>]*>/gi, "").trim() || data.displayRole;
        const icon = data.roleInfo.icon || (wwImg("/images/default-role.jpg"));
        popupRoleDesc.innerHTML = `
            <div class="role-desc-flex">
                <img class="role-desc-img big" src="${icon}" alt="${cleanTitle}" onerror="this.style.display='none'">
                <div class="role-desc-body">
                    <h3>${cleanTitle}</h3>
                    <div class="small">${data.roleInfo.desc}</div>
                </div>
            </div>
        `;
    } else {
        popupRoleDesc.innerHTML = "";
    }

    // ข้อมูลลัทธิ: เดิมมีกล่องข้อความบอกชื่อ "ใครคือหัวหน้าลัทธิ/ใครคือสมาชิก" ตรงนี้ด้วย — เอาออกตามคำขอ
    // ผู้ใช้ เพราะซ้ำซ้อนกับไอคอน 🔯 ที่ติดอยู่บนการ์ดผู้เล่นแต่ละคนอยู่แล้ว (ดูส่วน "🔯 ลัทธิ" ใน
    // renderPlayerGrid) ไม่ต้องมีข้อความสปอยล์ชื่อ/สถานะหัวหน้า-สมาชิกในกล่องคำอธิบายบทบาทอีกต่อไป
    const popupCultInfo = document.getElementById("popupCultInfo");
    if (popupCultInfo) {
        popupCultInfo.innerHTML = "";
        popupCultInfo.classList.add("hidden");
    }

    // แชทหมาป่า
    const tabWolf = document.getElementById("tabWolf");
    if (allWolfRoles.includes(data.role)) {
        tabWolf.classList.remove("hidden");
    } else {
        tabWolf.classList.add("hidden");
        if (currentChatTab === "wolf") {
            switchChatTab("global");
        }
    }

    // แชททีมยุยง (ผู้ยุยง + ผู้ศรัทธา 2 คนที่ถูกจับคู่ด้วย) — โชว์ก็ต่อเมื่ออยู่กลุ่มเดียวกันจริง
    const tabInstigator = document.getElementById("tabInstigator");
    if (data.instigatorGroupId) {
        tabInstigator.classList.remove("hidden");
    } else {
        tabInstigator.classList.add("hidden");
        if (currentChatTab === "instigator") {
            switchChatTab("global");
        }
    }

    // แชทลัทธิ (ผู้นำลัทธิ + สมาชิกที่ถูกชักชวนทุกคน) — โชว์ก็ต่อเมื่ออยู่ลัทธิเดียวกันจริง เหมือนแชทยุยงเป๊ะๆ
    const tabCult = document.getElementById("tabCult");
    if (tabCult) {
        if (data.cultGroupId) {
            tabCult.classList.remove("hidden");
        } else {
            tabCult.classList.add("hidden");
            if (currentChatTab === "cult") {
                switchChatTab("global");
            }
        }
    }

    // แชททีมโจร (หัวโจร + ผู้สมรู้ร่วมคิด 1 คน) — โชว์ก็ต่อเมื่ออยู่กลุ่มโจรเดียวกันจริง (เหมือนแชทลัทธิ)
    // ต่างกันตรงที่ "พิมพ์ได้เฉพาะหัวโจรเท่านั้น" — ผู้สมรู้ร่วมคิดอ่านได้อย่างเดียว (เช็คซ้ำฝั่งเซิร์ฟเวอร์ด้วย)
    const tabBandit = document.getElementById("tabBandit");
    if (tabBandit) {
        if (data.banditGroupId) {
            tabBandit.classList.remove("hidden");
        } else {
            tabBandit.classList.add("hidden");
            if (currentChatTab === "bandit") {
                switchChatTab("global");
            }
        }
    }
    // ผู้สมรู้ร่วมคิดพิมพ์แชททีมโจรไม่ได้ (อ่านได้อย่างเดียว) — ซ่อนกล่องพิมพ์ตอนอยู่แท็บนี้เฉพาะกรณีนี้
    window.__isBanditLeader = !!(data.banditInfo && data.banditInfo.isLeader);
    if (currentChatTab === "bandit") updateChatInputAvailability();

    // Re-render กริดผู้เล่นทันที เพื่อให้ hunt-target badge ขึ้นถูกที่
    // (room_update มาก่อน your_role ดังนั้นต้อง render ใหม่หลังได้รับบท)
    if (lastRoomData) {
        renderPlayerGrid(lastRoomData);
    }

    // แก้บั๊ก: ตอนรีคอนเนกต์ระหว่างเกม เซิร์ฟเวอร์ส่ง room_update (คำนวณ depleted ถูกต้องแล้ว
    // เช็ค isNight/ตายแล้ว/ใช้สิทธิ์วันนี้ไปแล้วครบ) มาก่อน แล้วค่อยส่ง your_role (silent) ตามมาทีหลัง
    // แต่ your_role ด้านบนตั้งค่า depleted แบบง่ายจากแค่ \"จำนวนคงเหลือ\" เท่านั้น (ตามคอมเมนต์เดิม
    // \"จำนวนกระสุนจริงจะถูกซิงค์อีกทีจาก room_update\" — ซึ่งไม่จริงอีกต่อไปเพราะ your_role มาทีหลัง)
    // ผลคือปุ่มที่ควรจาง (กลางคืน/ใช้ไปแล้ว/ตายแล้ว) กลับดูเหมือนกดได้หลังรีคอนเนกต์ — sync ซ้ำที่นี่
    // ด้วยสูตรเดียวกับใน room_update handler ด้านล่าง ให้ตรงกันเสมอไม่ว่า event ไหนจะมาถึงทีหลัง
    if (lastRoomData) {
        const myP2 = lastRoomData.players.find((p) => p.id === socket.id);
        if (myP2) {
            const alive2 = myP2.alive;
            if (GUARDIAN_ROLES.has(myP2.role)) {
                const avail2 = myP2.guardianShieldAvailable ?? 0;
                shieldBtn.classList.toggle("depleted", !(avail2 > 0) || !alive2 || !!lastRoomData.isNight);
            }
            if (myP2.role === "ศาลเตี้ย") {
                const usedToday2 = !!myP2.sheriffUsedToday;
                const bulletsLeft2 = myP2.sheriffBullets ?? 0;
                gunBtn.classList.toggle("depleted", !(bulletsLeft2 > 0) || !alive2 || !!lastRoomData.isNight || usedToday2);
                const peeksLeft2 = myP2.sheriffPeeks ?? 0;
                peekBtn.classList.toggle("depleted", !(peeksLeft2 > 0) || !alive2 || !!lastRoomData.isNight || usedToday2);
            }
            if (holyWaterBtn && myP2.role === "นักบวช") {
                const holyWaterLeft2 = myP2.priestHolyWaterPotions ?? 0;
                holyWaterBtn.classList.toggle("depleted", !(holyWaterLeft2 > 0) || !alive2 || !!lastRoomData.isNight);
            }
            if (myP2.role === "แม่มด") {
                // isFirstNight2: ใช้เช็คแค่ยาพิษเท่านั้น ยาป้องกันใช้ได้ตั้งแต่คืนแรกแล้ว (ตามคำขอผู้ใช้)
                const isFirstNight2 = (lastRoomData.nightCount || 0) <= 1;
                const poisonLeft2 = myP2.witchPoisonPotions ?? 0;
                poisonBtn.classList.toggle("depleted", !(poisonLeft2 > 0) || !alive2 || !lastRoomData.isNight || isFirstNight2);
                const protectLeft2 = myP2.witchProtectPotions ?? 0;
                protectBtn.classList.toggle("depleted", !(protectLeft2 > 0) || !alive2 || !lastRoomData.isNight);
            }
            if (mayorBtn && myP2.role === "นายก") {
                // ห้ามเปิดตัวตอนกำลังอยู่ในคืนแรกของเกม (ตามคำขอผู้ใช้) — เหมือนฝั่งเซิร์ฟเวอร์ (reveal_mayor)
                const mayorFirstNight2 = !!lastRoomData.isNight && (lastRoomData.nightCount || 0) <= 1;
                mayorBtn.classList.toggle("depleted", !alive2 || !!myP2.mayorRevealed || !(myP2.mayorAvailable > 0) || mayorFirstNight2);
            }
        }
    }

});

// ROLES DATA — sync wolfRoles จาก server เพื่อให้ตรงเสมอแม้เพิ่มบทใหม่
socket.on("roles_data", (data) => {
    allRolesData = data;
    window.wwRolesData = allRolesData; // เปิดให้ shared.server-control.js อ่านไปโชว์ตอนจอ "กำลังปิด" ได้
    preloadRoleImages(allRolesData);
    // server ฝัง __wolfRoles ไว้ใน roles_data — ใช้ sync ฝั่ง client โดยไม่ต้อง hardcode
    if (Array.isArray(data.__wolfRoles)) {
        wolfRoles = new Set(data.__wolfRoles);
        allWolfRoles = [...wolfRoles];
    }
});

// แสดง roles ทั้งหมดในเกมรอบนี้
function showGameInfo(roomData) {
    const config = roomData.config || {};
    const playerName = document.getElementById("name").value.trim() || "ผู้เล่น";
    const roomCode = document.getElementById("room").value.trim().toUpperCase();

    document.getElementById("gameRoomLabel").textContent = "ห้อง " + roomCode;
    document.getElementById("gamePlayerName").textContent = playerName;

    // จัดกลุ่ม: ขยาย random group → บทจริงที่ถูกใช้จาก players
    const randomGroups = {
        "สุ่มชาวบ้าน": ["ชาวบ้าน","หมอ","บอดี้การ์ด"],
        "สุ่มชาวบ้านสนับสนุน": ["ศาลเตี้ย","แม่มด"],
        "สุ่มหมาป่า": ["หมาป่า","ลูกหมาป่า","หมาป่าดื้อรั้น"],
        "สุ่มหมาป่าสนับสนุน": ["หมาป่าผู้พิทักษ์","หมาป่านักเวท"],
        "สุ่มบทบาทการโหวต": ["คนบ้า","นักล่าหัว"],
    };

    // นับบทจริงจาก players ใน room — ใช้ originalRole (บทตอนแจกครั้งแรก) เสมอ ไม่ใช่ p.role สดๆ
    // เพราะ p.role จะถูกเปลี่ยนกลางเกมเมื่อมีการกลายร่าง (เช่น ผู้ถูกสาปโดนกัดกลายเป็นหมาป่า)
    // ถ้าใช้ p.role ตรงๆ รายชื่ออาชีพที่ทุกคนเห็นได้นี้จะเปลี่ยนตามทันที ทำให้รู้ว่ามีคนกลายร่างไปแล้ว
    const realCounts = {};
    (roomData.players || []).forEach(p => {
        const r = p.originalRole || p.role;
        if (p.isHost || !r) return;
        realCounts[r] = (realCounts[r] || 0) + 1;
    });

// ถ้ายังไม่มีบทจริง (เกมยังไม่เริ่มจริงๆ) ใช้ config แทน
    const useReal = Object.keys(realCounts).length > 0;
    const counts = useReal ? realCounts : (() => {
        const c = {};
        Object.entries(config).forEach(([role, n]) => {
            if (randomGroups[role]) {
                // สุ่ม → แสดงชื่อกลุ่ม
                c[role] = n;
            } else {
                c[role] = (c[role] || 0) + n;
            }
        });
        return c;
    })();

    // แยกทีม
    const wolfTeam = {}, villagerTeam = {}, soloTeam = {};
    // ใช้ allWolfRoles ที่ sync มาจาก server แทนการ hardcode
    const soloRolesList = ["คนบ้า","นักล่าหัว","ฆาตกรต่อเนื่อง","นักเล่นกล","ผู้ยุยง"];

    Object.entries(counts).forEach(([role, n]) => {
        if (allWolfRoles.includes(role) || role.includes("สุ่มหมาป่า")) wolfTeam[role] = n;
        else if (soloRolesList.includes(role) || role.includes("สุ่มบทบาทการโหวต")) soloTeam[role] = n;
        else villagerTeam[role] = n;
    });

    // ดึงคำอธิบายอาชีพจาก allRolesData (รองรับหลายรูปแบบข้อมูลที่เซิร์ฟเวอร์อาจส่งมา)
    function getRoleDescHtml(role) {
        const info = allRolesData[role];
        if (!info) {
            return `<div class="role-desc-text">ยังไม่มีข้อมูลคำอธิบายอาชีพนี้</div>`;
        }
        if (typeof info === "string") {
            return `<div class="role-desc-text">${info}</div>`;
        }
        const rawTitle = info.title || role;
        // ชื่อบางอาชีพมี <img> ฝังอยู่ใน title อยู่แล้ว (เลี่ยงรูปซ้ำ) ตัดออกแล้วใช้แค่ข้อความ
        const cleanTitle = rawTitle.replace(/<img[^>]*>/gi, "").trim() || role;
        const desc = info.desc || info.description || "ยังไม่มีคำอธิบาย";
        const icon = info.icon || (wwImg("/images/default-role.jpg"));
        return `
            <div class="role-desc-flex">
                <img class="role-desc-img" src="${icon}" alt="${cleanTitle}" onerror="this.style.display='none'">
                <div class="role-desc-body">
                    <div class="role-desc-title">${cleanTitle}</div>
                    <div class="role-desc-text">${desc}</div>
                </div>
            </div>
        `;
    }

    function buildRows(map, cssClass) {
        // บทของเรา (isMine) ไม่ต้องแสดงซ้ำในลิสต์นี้อีก — รายละเอียด+จำนวน (×N) ย้ายไปแสดง
        // ที่ด้านบนสุดของป๊อปอัป (#popupRoleName / #popupRoleCount / #popupRoleDesc) แทนแล้ว
        const entries = Object.entries(map).filter(([role]) => role !== myRole);
        if (entries.length === 0) return "";
        return entries.map(([role, n], idx) => {
            const key = `${cssClass}_${idx}`;
            const isOpen = openRoleDescKeys.has(key);

            const toggleBtn = `
                <button type="button" class="role-toggle-btn${isOpen ? " open" : ""}" onclick="toggleRoleDesc(this,'${key}')" aria-label="ดูคำอธิบายอาชีพ ${role}">
                    <span class="role-toggle-arrow">▶</span>
                </button>`;

            // ห้ามใส่ id ให้ panel นี้: รายการเดียวกันถูก render ซ้ำ 2 ที่ (ป๊อปอัป #popupRolesInGame และแผงซ้าย
            // #rolesInGamePanel) id เดียวกันจึงซ้ำกัน และ getElementById() คืน "ตัวแรกใน DOM" เสมอ ซึ่งคือตัวในแผงซ้าย
            // (ที่ซ่อนอยู่ตอนจอ < 900px) → กดลูกศรในป๊อปอัปแล้วไปเปิดคำอธิบายของสำเนาที่มองไม่เห็นแทน
            // (ลูกศรหมุนแต่ไม่มีอะไรโผล่) — ใช้ data-key ที่ wrapper แล้วหา panel จากปุ่มที่กดจริงแทน (ดู toggleRoleDesc)
            const descPanel = `
                <div class="role-desc-panel${isOpen ? "" : " hidden"}">
                    ${getRoleDescHtml(role)}
                </div>`;

            return `
                <div class="role-row-wrap" data-key="${key}">
                    <div class="role-row ${cssClass}">
                        <span class="role-row-left">
                            ${toggleBtn}
                            <span class="role-row-name">${role}</span>
                        </span>
                        <span class="role-row-count">×${n}</span>
                    </div>
                    ${descPanel}
                </div>`;
        }).join("");
    }

    // ไม่แบ่งหัวข้อทีมให้เห็นอีกต่อไป (ไล่เรียงเป็นลิสต์เดียวรวด) — แต่ลำดับก่อน-หลังยังขึ้นกับทีมของเรา:
    // ถ้าเราอยู่ทีมหมาป่า ให้ไล่ทีมหมาป่าขึ้นก่อน ตามด้วยชาวบ้านแล้วโซโล (เห็นพวกตัวเองก่อนเป็นธรรมชาติ)
    // ถ้าไม่ใช่ทีมหมาป่า (ชาวบ้าน/โซโล) ใช้ลำดับปกติเดิม: ชาวบ้านก่อน ตามด้วยหมาป่าแล้วโซโล
    const myWolfTeam = allWolfRoles.includes(myRole);
    const orderedRows = myWolfTeam
        ? buildRows(wolfTeam, "wolf-role") + buildRows(villagerTeam, "villager-role") + buildRows(soloTeam, "solo-role")
        : buildRows(villagerTeam, "villager-role") + buildRows(wolfTeam, "wolf-role") + buildRows(soloTeam, "solo-role");

    document.getElementById("popupRolesInGame").innerHTML = `<div class="roles-list">${orderedRows}</div>`;
    // สำเนาเดียวกันไปแสดงในแผงซ้ายสุดของโหมดจอกว้างมาก ๆ (#rolesPanelCard — ดู player.css)
    const rolesPanelEl = document.getElementById("rolesInGamePanel");
    if (rolesPanelEl) rolesPanelEl.innerHTML = `<div class="roles-list">${orderedRows}</div>`;

    // จำนวน (×N) ของบทเรา — ย้ายมาแสดงติดกับชื่อบทที่ด้านบนสุดของป๊อปอัปแทนลิสต์ด้านล่าง
    const popupRoleCountEl = document.getElementById("popupRoleCount");
    if (popupRoleCountEl) {
        const myCount = counts[myRole] || 0;
        popupRoleCountEl.textContent = myCount > 0 ? `×${myCount}` : "";
    }
}

// ===== กรองกริดผู้เล่นตามสถานะ (ทั้งหมด / มีชีวิต / ตายแล้ว) — เริ่มต้นที่ "ทั้งหมด" =====
let playerListFilter = "all"; // "all" | "alive" | "dead"

function setPlayerFilter(filter) {
    playerListFilter = filter;
    document.querySelectorAll(".filterChip").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.filter === filter);
    });
    filterPlayerList();
}

function filterPlayerList() {
    const cards = document.querySelectorAll("#players .player[data-pid]");
    cards.forEach((card) => {
        const show =
            playerListFilter === "all" ||
            (playerListFilter === "alive" && card.dataset.alive === "1") ||
            (playerListFilter === "dead" && card.dataset.alive === "0");
        card.classList.toggle("search-hidden", !show);
    });
    // จำนวนการ์ดที่เห็นเปลี่ยนแล้ว — รอให้ DOM/class commit ก่อนวัด layout จริง
    scheduleFitPlayerGrid(true);
}

// ===== responsive player grid: JS คำนวณ "คอลัมน์จริง + ขนาดการ์ดจริง" เป็นชุดเดียวกัน =====
/*
   จุดสำคัญของระบบนี้คือจำนวนคอลัมน์ต้องเป็นค่าที่ JS กับ CSS ใช้ตรงกันจริง ๆ

   บั๊กในรุ่นก่อนเกิดจากการคำนวณขนาดการ์ดโดยลองหลายจำนวนคอลัมน์ แล้วเลือก "ขนาดที่ใหญ่ที่สุด"
   แต่หลังจากนั้น CSS กลับใช้ auto-fit เพื่อเลือกจำนวนคอลัมน์ใหม่จากขนาดการ์ดอีกที เช่น JS คำนวณ
   จาก 6 คอลัมน์ได้ 112.25px แต่ auto-fit อาจตีความว่า 112.25px ใส่ได้เพียง 5 คอลัมน์
   → จากที่ตั้งใจ 6 × 5 แถว กลายเป็น 5 × 6 แถว → ความสูงที่ต้องใช้มากขึ้น → แถวล่างล้น #players
   และ overflow:hidden ทำให้เห็นเป็น "การ์ดหาย/โดนตัด" ที่ขอบล่าง

   รุ่นนี้จึงเปลี่ยนหลักเป็น:
   1) วัดพื้นที่จริงของ #players
   2) ลองจำนวนคอลัมน์ที่เป็นไปได้
   3) หา layout ที่ใส่ผู้เล่นทั้งหมดได้จริงโดยไม่ล้นทั้งแนวตั้งและแนวนอน
   4) เลือกขนาดการ์ดที่ใหญ่ที่สุด โดยใช้ "อย่างน้อยประมาณ 5 คอลัมน์" เป็นเพียงความชอบเมื่อขนาด
      ใกล้เคียงกัน ไม่ใช่ข้อบังคับตายตัว
   5) ส่งทั้ง columns และ size เข้า CSS โดยตรง จึงไม่มี auto-fit มาตัดสินใหม่อีกรอบ

   ผลที่ต้องได้:
   - จำนวนผู้เล่นน้อย: การ์ดโตได้ถึงเพดานมาตรฐาน แต่ไม่ทำให้กริดสูงจนเกินเหตุ
   - จำนวนผู้เล่นมาก: การ์ดค่อย ๆ เล็กลงและจำนวนคอลัมน์เพิ่มตามพื้นที่จริง
   - iPad / Split View / หมุนจอ / resize: คำนวณใหม่ต่อเนื่อง โดยไม่มี breakpoint ของจำนวนคอลัมน์
   - ทุกการ์ดอยู่ภายในกรอบ #players จริง ไม่มีแถวล่างถูกตัดเพราะ JS กับ CSS เห็นจำนวนคอลัมน์ไม่ตรงกัน
*/

// ===== ความหนาแน่นของการ์ดตามจำนวนคน — ใช้เป็น "เพดานจริง" ของขนาดการ์ดแล้ว =====
// คนน้อย: การ์ดอ่านง่ายขึ้น แต่ไม่ปล่อยให้ใหญ่จนใช้พื้นที่ผิดสัดส่วน
// คนเยอะ: เพดานลดลงแบบต่อเนื่องเพื่อให้กริดยังรองรับหลายแถวในหน้าเดียว
function applyPlayerGridDensity(count) {
    const playersEl = document.getElementById("players");
    if (!playersEl) return;
    const ceiling = count <= 18 ? 88 : Math.max(34, 88 - (count - 18) * 0.9);
    playersEl.style.setProperty("--player-card-ceiling", `${ceiling.toFixed(1)}px`);
}

// ===== คำนวณ layout ผู้เล่นจากพื้นที่จริง =====
// pure function: ไม่แตะ DOM เพื่อให้อ่าน/ตรวจ logic ได้ง่าย
function computePlayerGridLayout(W, H, count, gap, minPx, maxPx, preferredCols = 5, rowGap = gap) {
    if (!(W > 0) || !(H > 0) || !(count > 0)) return null;

    gap = Number.isFinite(gap) && gap >= 0 ? gap : 6;
    rowGap = Number.isFinite(rowGap) && rowGap >= 0 ? rowGap : gap;
    minPx = Number.isFinite(minPx) && minPx > 0 ? minPx : 6;
    maxPx = Number.isFinite(maxPx) && maxPx >= minPx ? maxPx : 160;

    // จำนวนคอลัมน์สูงสุดที่ยังวางการ์ดขั้นต่ำตามแนวนอนได้จริง
    const colsAtMin = Math.max(1, Math.floor((W + gap) / (minPx + gap)));
    const maxCols = Math.min(count, colsAtMin);
    const preferred = Math.max(1, Math.min(count, Number(preferredCols) || 5));

    let candidates = [];
    for (let columns = 1; columns <= maxCols; columns++) {
        const rows = Math.ceil(count / columns);
        const byWidth = (W - (columns - 1) * gap) / columns;
        const byHeight = (H - (rows - 1) * rowGap) / rows;
        const size = Math.min(byWidth, byHeight, maxPx);

        if (!(size >= minPx)) continue;
        candidates.push({ columns, rows, size });
    }

    let fits = true;
    if (!candidates.length) {
        // พื้นที่เล็กผิดปกติจนการ์ดขั้นต่ำ 6px ยังเล็กเกินไปที่จะใส่ครบ:
        // อย่ากลับไปคืน minPx แบบรุ่นเก่า เพราะนั่นอาจทำให้แถวล่างล้นอีก ให้คำนวณด้วยขนาดจริง
        // ที่เล็กกว่า minPx แทน เพื่อรับประกันว่า layout ยัง "fit" ทางคณิตศาสตร์ได้
        fits = false;
        for (let columns = 1; columns <= count; columns++) {
            const rows = Math.ceil(count / columns);
            const byWidth = (W - (columns - 1) * gap) / columns;
            const byHeight = (H - (rows - 1) * rowGap) / rows;
            const size = Math.min(byWidth, byHeight, maxPx);
            if (!(size > 0)) continue;
            candidates.push({ columns, rows, size });
        }
    }

    if (!candidates.length) {
        // แม้แต่ช่องว่างระหว่างการ์ดก็ใหญ่กว่าพื้นที่ทั้งหมด: ลดจำนวนคอลัมน์เหลือ 1
        // และใช้ขนาดที่พอดีกับแนวนอน/แนวตั้งเท่าที่ทำได้ — เกิดได้เฉพาะ viewport ที่เล็กผิดปกติมาก
        const size = Math.max(0.01, Math.min(W, H / count, maxPx));
        return { columns: 1, rows: count, size, fits: false };
    }

    const maxSize = Math.max(...candidates.map((c) => c.size));
    // ถ้าขนาดต่างกันน้อยกว่า 2.5% ให้เลือกจำนวนคอลัมน์ที่ใกล้ preferred (5 โดยปกติ)
    // เพื่อให้กริดคงรูปร่างอ่านง่ายและไม่กระโดดจาก 5 → 4 ทั้งที่ขนาดการ์ดต่างกันแทบไม่เห็น
    const nearBest = candidates.filter((c) => c.size >= maxSize * 0.975 - 0.001);
    nearBest.sort((a, b) => {
        const da = Math.abs(a.columns - preferred);
        const db = Math.abs(b.columns - preferred);
        if (da !== db) return da - db;
        if (b.size !== a.size) return b.size - a.size;
        return a.columns - b.columns;
    });

    const best = nearBest[0];
    return {
        columns: best.columns,
        rows: best.rows,
        // ในโหมดปกติปัดลงทีละ 0.25px กันเศษจุดลอยตัว แต่ emergency layout ต้องรักษาขนาดจริงไว้มากที่สุด
        // เพื่อไม่ให้การปัดลงจากค่าที่เล็กกว่า 6px ทำให้เกิด overflow ที่ viewport เล็กมาก
        size: fits ? Math.floor(best.size * 4) / 4 : best.size,
        fits,
    };
}

function getPlayerGridMetrics(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const borderRight = parseFloat(cs.borderRightWidth) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
    const width = el.clientWidth - padLeft - padRight;
    const height = el.clientHeight - padTop - padBottom;
    const columnGap = Number.isFinite(parseFloat(cs.columnGap)) ? parseFloat(cs.columnGap) : 6;
    const rowGap = Number.isFinite(parseFloat(cs.rowGap)) ? parseFloat(cs.rowGap) : columnGap;
    const rect = el.getBoundingClientRect();
    return {
        width,
        height,
        columnGap,
        rowGap,
        contentLeft: rect.left + borderLeft + padLeft,
        contentRight: rect.right - borderRight - padRight,
        contentTop: rect.top + borderTop + padTop,
        contentBottom: rect.bottom - borderBottom - padBottom,
    };
}

function verifyPlayerGridFit(el, epsilon = 0.75) {
    if (!el) return { ok: true, overflow: 0 };
    const metrics = getPlayerGridMetrics(el);
    if (!metrics || !(metrics.width > 0) || !(metrics.height > 0)) return { ok: false, overflow: Infinity };
    let maxOverflow = 0;
    const cards = el.querySelectorAll(".player[data-pid]:not(.search-hidden)");
    cards.forEach((card) => {
        const r = card.getBoundingClientRect();
        const overflow = Math.max(
            metrics.contentLeft - r.left,
            r.right - metrics.contentRight,
            metrics.contentTop - r.top,
            r.bottom - metrics.contentBottom,
            0,
        );
        if (overflow > maxOverflow) maxOverflow = overflow;
    });
    return { ok: maxOverflow <= epsilon, overflow: maxOverflow };
}

function applyPlayerGridLayout(el, layout) {
    if (!el || !layout) return;
    const nextSize = `${layout.size}px`;
    const nextTemplate = `repeat(${layout.columns}, ${nextSize})`;
    if (el.style.getPropertyValue("--player-card-size") !== nextSize) {
        el.style.setProperty("--player-card-size", nextSize);
    }
    if (el.style.getPropertyValue("--player-grid-template") !== nextTemplate) {
        el.style.setProperty("--player-grid-template", nextTemplate);
    }
    el.dataset.gridColumns = String(layout.columns);
    el.dataset.gridRows = String(layout.rows);
    el.dataset.gridCardSize = String(layout.size);
    el.dataset.gridFitStatus = layout.fits ? "fit" : "emergency";
    el.dataset.gridOverflowPx = "0";
}

function fitPlayerGrid() {
    const MIN_PX = 6;
    const MAX_PX = 160;
    const PREFERRED_COLS = 5;
    const el = document.getElementById("players");
    if (!el) return;
    const count = el.querySelectorAll(".player[data-pid]:not(.search-hidden)").length;
    if (count === 0) return;
    const metrics = getPlayerGridMetrics(el);
    if (!metrics || !(metrics.width > 0) || !(metrics.height > 0)) return;

    let layout = computePlayerGridLayout(
        metrics.width,
        metrics.height,
        count,
        metrics.columnGap,
        MIN_PX,
        MAX_PX,
        PREFERRED_COLS,
        metrics.rowGap,
    );
    if (!layout) return;

    applyPlayerGridLayout(el, layout);
    centerLastRow(el, layout.columns);

    let verification = verifyPlayerGridFit(el);
    let attempts = 0;
    while (!verification.ok && attempts < 8) {
        attempts += 1;
        const currentSize = Number(layout.size);
        const factor = verification.overflow > 2 ? 0.96 : 0.9925;
        const safeSize = Math.max(0.5, currentSize * factor);
        layout = { ...layout, size: safeSize };
        applyPlayerGridLayout(el, layout);
        centerLastRow(el, layout.columns);
        verification = verifyPlayerGridFit(el);
    }

    el.dataset.gridFitStatus = verification.ok ? "fit" : "guarded";
    el.dataset.gridOverflowPx = String(Number.isFinite(verification.overflow) ? verification.overflow.toFixed(2) : "9999");
}

// จัดแถวสุดท้ายด้วย grid track จริง ไม่ใช้ relative-left/transform เพื่อไม่ให้ visual box หลุดกรอบ #players
function centerLastRow(el, columns) {
    const cards = Array.from(el.querySelectorAll(".player[data-pid]:not(.search-hidden)"));
    cards.forEach((c) => {
        c.style.gridColumnStart = "";
        c.style.left = "";
    });
    if (cards.length === 0 || !(columns > 1) || cards.length <= columns) return;
    const remainder = cards.length % columns;
    if (remainder === 0) return;
    const missing = columns - remainder;
    const startColumn = Math.max(1, Math.min(columns - remainder + 1, 1 + Math.floor(missing / 2)));
    cards[cards.length - remainder].style.gridColumnStart = String(startColumn);
}

// จัดใหม่ทุกครั้งที่ "พื้นที่กริด" เปลี่ยน: ลากขอบหน้าต่าง/Split View/หมุนจอ, แชท/แผงบทกว้างขึ้น-แคบลง
// รวมถึงช่วงเปลี่ยนจาก lobby -> game ซึ่ง parent #playersCard เพิ่งพ้น display:none
// และความสูงจริงของ #players ยังไม่ settle ในเฟรมแรก
//
// จุดสำคัญของรอบแก้นี้: อย่าวัดครั้งเดียวในเฟรมที่เพิ่งเปิดการ์ด เพราะ flex layout ของ parent
// ยังสามารถเปลี่ยนต่อในเฟรมถัดไปได้ ส่งผลให้การ์ดรอบแรกใหญ่เกินพื้นที่จริงและถูกตัดด้านล่าง
// (พอเพิ่มบอทจะมี render/resize รอบใหม่ จึงดูเหมือนหายเอง)
let playerGridFitRaf = 0;
let playerGridSettleRafs = 0;

function scheduleFitPlayerGrid(settle = false) {
    if (settle) playerGridSettleRafs = Math.max(playerGridSettleRafs, 2);
    if (playerGridFitRaf) return;
    playerGridFitRaf = requestAnimationFrame(() => {
        playerGridFitRaf = 0;
        fitPlayerGrid();
        if (playerGridSettleRafs > 0) {
            playerGridSettleRafs -= 1;
            scheduleFitPlayerGrid(false);
        }
    });
}

(function watchPlayerGridSize() {
    const el = document.getElementById("players");
    const card = document.getElementById("playersCard");
    // ระหว่างลาก resize ให้ fit ตามเฟรมปัจจุบันทันที; ไม่ใส่ settle delay เพราะ
    // Fluid Layout Engine ปิด geometry transition ระหว่าง resize และ ResizeObserver ของ #players/#playersCard
    // จะเรียกซ้ำเองเมื่อพื้นที่จริงเปลี่ยนในเฟรมถัดไป. settle มีไว้เฉพาะตอน DOM/layout เพิ่งเปลี่ยนโครงสร้าง.
    window.addEventListener("resize", () => scheduleFitPlayerGrid(false), { passive: true });
    if (!el) {
        scheduleFitPlayerGrid(true);
        return;
    }
    if (typeof ResizeObserver !== "undefined") {
        const schedule = () => scheduleFitPlayerGrid(false);
        try {
            const ro = new ResizeObserver(schedule);
            ro.observe(el, { box: "border-box" });
            if (card) ro.observe(card, { box: "border-box" });
        } catch (e) {
            const ro = new ResizeObserver(schedule);
            ro.observe(el);
            if (card) ro.observe(card);
        }
    }
    if (typeof MutationObserver !== "undefined") {
        try {
            const mo = new MutationObserver((mutations) => {
                if (mutations.some((m) => m.type === "childList")) scheduleFitPlayerGrid(true);
            });
            mo.observe(el, { childList: true });
        } catch (e) {}
    }
    scheduleFitPlayerGrid(true);
})();

// ===== px (อ้างอิงการ์ดดีฟอลต์ 88px) -> cqw (% ของความกว้างการ์ดจริงตอนนี้) =====
// ใช้แปลงค่า offset/ขนาดที่คำนวณเป็นตัวเลขใน JS (เช่น ตำแหน่ง badge มุมล่างขวาที่เลื่อนหนีกันเอง)
// ให้เป็นหน่วย container-query แทน px ตายตัว — การ์ดเล็กลงเมื่อไร (ดู applyPlayerGridDensity ด้านบน)
// ค่าที่คืนก็เล็กลงตามสัดส่วนเดียวกันโดยอัตโนมัติ ไม่ต้องคำนวณ/ผูกกับ --player-card-ceiling เองในนี้
// (ต้องมี container-type:inline-size; container-name:playercard; บน .player ใน player.css คู่กัน)
const PLAYER_CARD_CQW_RATIO = 100 / 88;
function toCardCqw(px) {
    return `${(px * PLAYER_CARD_CQW_RATIO).toFixed(2)}cqw`;
}

// แยก render กริดผู้เล่นเป็น function เพื่อสามารถเรียกใหม่ได้หลังรับบท
function renderPlayerGrid(roomData) {
    const players = document.getElementById("players");
    const me = socket.id;
    const selected = roomData.selectedTargets?.[me];
    const amIWolf = allWolfRoles.includes(myRole);
    const others = roomData.players.filter(p => !p.isHost);
    applyPlayerGridDensity(others.length);

    if (others.length === 0) {
        players.innerHTML = `<div class="empty-note">รอผู้เล่นคนอื่นเข้าร่วมห้อง...</div>`;
        players.classList.remove("mode-active");
        updateModeBanner("normal", {});
        return "normal";
    }

    // ถ้ามี empty-note ค้างอยู่ (ตอนยังไม่มีคนอื่น) ให้เคลียร์ก่อน sync ของจริง
    if (players.querySelector(".empty-note")) {
        players.innerHTML = "";
    }

    // ===== กำหนดโหมดปัจจุบันของกริด =====
    // โหมดโหวต/โหมดหมาป่าเลือกฆ่า แสดงผล "ภายในกริดผู้เล่นเดิม" นี้เลย แทนที่จะแยกเป็นป๊อปอัป
    // ลำดับความสำคัญ: โหมดโหวต > โหมดวางโล่ (หมาป่าผู้พิทักษ์ กดใช้ได้ทั้งวัน ไม่ต้องรอเข้าโหมดโหวต)
    // > โหมดหมาป่าเลือกฆ่า (เฉพาะคนที่เป็นทีมหมาป่า) > โหมดปกติ (เลือกเป้าหมายความสามารถกลางคืน)
    const voteMode = !!roomData.voteMode;
    const amIMurderer = myRole === "ฆาตกรต่อเนื่อง";
    const myPlayerObjEarly = roomData.players.find(p => p.id === me);
    const amIInstigator = myRole === "ผู้ยุยง";
    // ผู้ยุยง: ปลดล็อกสิทธิ์ฆ่าเองได้ 1 คนต่อคืน ก็ต่อเมื่อจับคู่ "ผู้ศรัทธา" ไว้แล้ว (instigatorPaired)
    // และผู้ศรัทธาทั้งสองคนตายครบแล้วเท่านั้น (เช็คจาก instigatorPairTargetIds ที่ server ส่งมาให้)
    const myInstigatorSoloKillUnlocked = !!(
        amIInstigator &&
        myPlayerObjEarly &&
        myPlayerObjEarly.instigatorPaired &&
        Array.isArray(myPlayerObjEarly.instigatorPairTargetIds) &&
        myPlayerObjEarly.instigatorPairTargetIds.length === 2 &&
        myPlayerObjEarly.instigatorPairTargetIds.every((id) => {
            const believer = roomData.players.find((x) => x.id === id);
            return believer && !believer.alive;
        })
    );
    // ไม่มีโหมดฆ่าให้โฮสต์เปิด-ปิดอีกแล้ว — เลือกเป้าได้เองตลอดคืน (เช็คแค่ roomData.isNight)
    const killModeActive = !!(roomData.isNight && (amIWolf || amIMurderer || myInstigatorSoloKillUnlocked));
    const amISheriff = myRole === "ศาลเตี้ย";
    const sheriffModeActive = !!(gunModeActive && amISheriff && !roomData.isNight);
    const peekModeOn = !!(peekModeActive && amISheriff && !roomData.isNight);
    const amIPriest = myRole === "นักบวช";
    const holyWaterModeOn = !!(holyWaterModeActive && amIPriest && !roomData.isNight);
    const amIWitch = myRole === "แม่มด";
    const poisonModeOn = !!(poisonModeActive && amIWitch && roomData.isNight);
    const protectModeOn = !!(protectModeActive && amIWitch && roomData.isNight);
    const amIOldLady = myRole === "ยายขี้โมโห";
    const amIDoctor = myRole === "หมอ";
    const amIBodyguard = myRole === "บอดี้การ์ด";
    const amIThug = myRole === "อันธพาล"; // ปกป้องตัวเองอัตโนมัติอยู่แล้ว + เลือกอีก 1 คนเพิ่มได้ต่อคืน (แตะการ์ดตรงๆ เหมือนหมอ/บอดี้การ์ด)
    const amIIllusionist = myRole === "นักเล่นกล"; // ปลอมบทผู้เล่น 1 คนต่อคืน (แตะการ์ดตรงๆ เหมือนหมอ/บอดี้การ์ด/อันธพาล — ผ่าน select_target ธรรมดา สะสมผลไว้ กดปุ่ม 🔥 ฆ่ารวดเดียวตอนกลางวัน)
    const amIWizardWolf = myRole === "หมาป่านักเวท";
    const curseModeOn = !!(curseModeActive && amIWizardWolf && !roomData.isNight);
    const myPlayerObjForCult = roomData.players.find(p => p.id === me);
    const amICultLeader = !!(myPlayerObjForCult && myPlayerObjForCult.role === "ผู้นำลัทธิ" && myPlayerObjForCult.alive);
    const cultRecruitModeOn = !!(cultRecruitModeActive && amICultLeader && roomData.isNight);
    const cultSacrificeModeOn = !!(cultSacrificeModeActive && amICultLeader && roomData.isNight);
    // สมาชิกลัทธิ (ไม่ใช่หัวหน้า): เก็บ id หัวหน้าลัทธิของตัวเองไว้ล่วงหน้า ใช้ตัดสินว่าการ์ดไหนคือ
    // การ์ดหัวหน้าลัทธิที่ตัวเองสังกัดอยู่ — ตามคำอธิบายบทผู้นำลัทธิ "คนที่เข้าลัทธิจะเห็นบทหัวลัทธิ"
    // ต่างจาก isMyCultMember ด้านล่างที่เป็นมุมมองของหัวหน้าลัทธิเอง (เห็นสมาชิก ไม่ใช่กลับกัน)
    const myCultLeaderId = myPlayerObjForCult && myPlayerObjForCult.cultLeaderId;
    const amICultMember = !amICultLeader && !!myCultLeaderId;
    // โจร/ผู้สมรู้ร่วมคิด: เช่นเดียวกับลัทธิด้านบน — ใช้ตัดสินว่าจะแตะเลือกได้แบบไหน (เปลี่ยนบทบาท/ฆ่าร่วม)
    // ไม่มีปุ่มเข้าโหมดแล้ว (แตะการ์ดตรงๆ ได้เลย) จึงไม่ต้องมีตัวแปร xxxModeOn คู่กันเหมือนลัทธิอีกต่อไป
    const amIBanditLeader = !!(myPlayerObjForCult && myPlayerObjForCult.role === "โจร" && myPlayerObjForCult.alive);
    const amIBanditAccomplice = !!(myPlayerObjForCult && myPlayerObjForCult.role === "ผู้สมรู้ร่วมคิด" && myPlayerObjForCult.alive);
    const myBanditLeaderId = amIBanditAccomplice ? myPlayerObjForCult.banditLeaderId : null;
    // หัวโจรมีผู้สมรู้ร่วมคิดอยู่แล้วหรือยัง (ตัดสินว่าแตะการ์ดแล้วจะเป็น "เปลี่ยนบทบาท" หรือ "เลือกฆ่าร่วม")
    const iBanditHasAccomplice = (amIBanditLeader || amIBanditAccomplice) && roomData.players.some(
        (pl) => pl.alive && !pl.isHost && pl.role === "ผู้สมรู้ร่วมคิด" && pl.banditLeaderId === (amIBanditLeader ? me : myBanditLeaderId)
    );
    // หมาป่าผู้พิทักษ์กดวางโล่ได้ทั้งวัน ไม่ว่าโฮสต์จะเปิดโหมดโหวตแล้วหรือยัง (แค่ห้ามใช้ตอนกลางคืน)
    const myPlayerObj = roomData.players.find(p => p.id === me);
    // นักเล่นกล: รายชื่อ id ผู้เล่นที่ปลอมบทไว้แล้วจริง (ยืนยันจากเซิร์ฟเวอร์ สะสมข้ามคืนได้ ไม่ใช่แค่ที่เลือกไว้
    // ตอนนี้ยังไม่ resolve) ใช้โชว์ไอคอน 🔥 ค้างไว้ถาวรที่ตัวคนนั้น ไม่ผูกกับ isNight/mode/รอบปัจจุบันเลย
    // (ต่างจาก selected ที่เป็นแค่เป้าที่ "กำลังจะเลือก" คืนนี้ ยังไม่ถูกบันทึกจนกว่าจะถึงเช้า)
    const myIllusionTargetIds = Array.isArray(myPlayerObj?.illusionTargetIds) ? myPlayerObj.illusionTargetIds : [];

    // แก้บั๊ก: กามเทพ ถ้าออกจากหน้าจอ/สลับแท็บ/รีเฟรชแล้วกลับเข้ามาใหม่ระหว่างคืนที่ยังไม่สรุปผล
    // ตัวแปร local cupidPendingFirstId/cupidPendingSecondId จะรีเซ็ตเป็น null (เพราะเป็นแค่ state
    // ฝั่ง client ไม่เคยถูกดึงกลับจากเซิร์ฟเวอร์) ทำให้ไอคอน 💖 ที่วางไว้ก่อนหน้าหายไปจากจอ ทั้งที่
    // room.pendingLoverPair ฝั่งเซิร์ฟเวอร์ยังเก็บค่าไว้ปกติ (ระบบข้างในทำงานถูกต้อง แค่ UI ไม่ซิงค์)
    // ดึงค่ากลับมาจาก roomData.pendingLoverPair (ส่งมาใน publicRoomView ทุกครั้งอยู่แล้ว) ถ้าเป็น
    // ของเราเองและยังไม่มีตัวเลือกค้างอยู่ในตัวแปร local เลย (กันไม่ให้ทับค่าที่กำลังเลือกอยู่สดๆ)
    if (myRole === "กามเทพ" && roomData.isNight && !(myPlayerObj && myPlayerObj.cupidPaired)) {
        const myPending = roomData.pendingLoverPair;
        if (myPending && myPending.selectorId === me && cupidPendingFirstId === null && cupidPendingSecondId === null) {
            cupidPendingFirstId = myPending.targetAId || null;
            cupidPendingSecondId = myPending.targetBId || null;
        }
    }

    const amIGuardianWolf = myPlayerObj && GUARDIAN_ROLES.has(myPlayerObj.role) && (myPlayerObj.guardianShieldAvailable > 0);
    const dayShieldPickActive = !!(shieldModeActive && amIGuardianWolf && !roomData.isNight);
    // ลูกหมาป่า: กดปุ่ม 🐾 เข้าโหมด "เลือกเป้าลากตาย" ได้ตลอดเวลา ทั้งกลางวันและกลางคืน
    // (ต่างจากโล่หมาป่าผู้พิทักษ์ที่ใช้ได้แค่กลางวัน) — priority สูงกว่าโหมดหมาป่าเลือกฆ่าตอนกลางคืน
    // เพื่อไม่ให้ชนกัน (ปิดโหมดนี้เมื่อไหร่ค่อยกลับไปโหวตฆ่าร่วมทีมตามปกติ)
    const amIWolfCub = !!(myPlayerObj && myPlayerObj.role === "ลูกหมาป่า" && myPlayerObj.alive);
    const wolfCubPickActive = !!(wolfCubModeActive && amIWolfCub);
    // เด็กขี้โวยวาย: กดปุ่ม 👄 เข้าโหมด "เลือกเป้า" ได้ตลอดเวลาเหมือนลูกหมาป่า (ห้ามใช้แค่คืนแรกของเกม
    // ซึ่ง server จะเมินคำสั่งเฉยๆ ฝั่ง client ไม่ต้องเช็คซ้ำ แค่ให้กดเข้าโหมดได้ตามปกติ)
    const amILoudmouth = !!(myPlayerObj && myPlayerObj.role === "เด็กขี้โวยวาย" && myPlayerObj.alive);
    const loudmouthPickActive = !!(loudmouthModeActive && amILoudmouth);
    // หมายเหตุ: ยายขี้โมโหไม่มี "โหมดเลือกใบ้" แยกอีกต่อไปแล้ว (แตะการ์ดเป้าตรงๆ ได้เลยเหมือนหมอ/บอดี้การ์ด)
    // จึงไม่มี "silence" ใน mode นี้อีก — badge 🤫 ของยายขี้โมโหเช็คจาก amIOldLady + selected ตรงๆ แทน (ดูด้านล่าง)
    // แม่มด: ยังคงต้องกดปุ่มเข้าโหมดก่อนเลือก (protectModeOn) เพราะมี 2 ความสามารถ (ยาป้องกัน/ยาพิษ)
    // แตะการ์ดเดียวกันแต่ทำคนละอย่าง จึงต้องมีโหมดบอกให้รู้ว่ากำลังจะใช้ความสามารถไหนอยู่
    const mode = voteMode ? "vote"
        : wolfCubPickActive ? "wolfcub"
        : loudmouthPickActive ? "loudmouth"
        : dayShieldPickActive ? "shield"
        : killModeActive ? "kill"
        : sheriffModeActive ? "sheriff"
        : peekModeOn ? "peek"
        : holyWaterModeOn ? "holywater"
        : poisonModeOn ? "poison"
        : protectModeOn ? "protect"
        : curseModeOn ? "curse"
        : cultRecruitModeOn ? "cultrecruit"
        : cultSacrificeModeOn ? "cultsacrifice"
        : "normal";

    players.classList.toggle("mode-active", mode !== "normal");

    // ข้อมูลโหวต (ใช้เมื่อ mode === "vote")
    const votes = roomData.votes || {};
    const myVoteTarget = votes[me];
    const voteTally = {};
    // นายกที่เปิดเผยตัวแล้ว (mayorRevealed) โหวตนับเป็น 2 เสียง — ต้องคำนวณให้ตรงกับฝั่ง server
    // (ดู getVoteWeight/closeVoteRound ใน server.js) ไม่งั้นตัวเลขที่โชว์ในกริดจะไม่ตรงกับผลจริง
    Object.entries(votes).forEach(([voterId, tid]) => {
        const voter = roomData.players.find(p => p.id === voterId);
        const weight = voter && voter.mayorRevealed ? 2 : 1;
        voteTally[tid] = (voteTally[tid] || 0) + weight;
    });
    const voteTargetName = {};
    Object.entries(votes).forEach(([vid, tid]) => {
        const t = roomData.players.find(p => p.id === tid);
        if (t) voteTargetName[vid] = t.name;
    });
    const aliveVotersCount = others.filter(p => p.alive).length;
    const voteThreshold = Math.ceil(aliveVotersCount / 2);

    // ข้อมูลโล่หมาป่าผู้พิทักษ์ (ใช้เมื่อ mode === "vote" หรือ mode === "shield")
    const shieldTargets = roomData.shieldTargets || {};
    const myShieldTarget = shieldTargets[me]; // ใช้กับตัวเองตอนเป็นหมาป่าผู้พิทักษ์
    // playerId ที่กำลังถูกวางโล่อยู่ → ใช้แสดงไอคอนโล่ให้ทุกคนเห็นว่าใครกำลังถูกปกป้อง
    const shieldedPlayerIds = new Set(Object.values(shieldTargets));

    // ข้อมูลเป้าร่ายเวทของหมาป่านักเวท (ใช้เมื่อ mode === "curse") — เห็นเฉพาะตัวเอง (เหมือนโล่)
    const curseTargets = roomData.curseTargets || {};
    const myCurseTarget = curseTargets[me];

    // ข้อมูลเป้าชักชวนเข้าลัทธิของผู้นำลัทธิ (ใช้เมื่อ mode === "cultrecruit") — เห็นเฉพาะตัวเอง
    const myCultAction = (roomData.cultActions || {})[me] || null;
    const myCultRecruitTarget = (myCultAction && myCultAction.mode === "recruit") ? myCultAction.targetId : null;
    // ข้อมูล "สังเวยสมาชิก" ที่ล็อกไว้แล้วจริงของผู้นำลัทธิ (ส่งครบทั้งสมาชิก+เป้าไปที่ room.cultActions
    // ฝั่งเซิร์ฟเวอร์แล้วผ่าน castCultSacrifice) — ต่างจาก cultSacrificePendingMemberId ที่เป็นแค่
    // "แตะคนแรกไว้ระหว่างเลือก ยังไม่ส่ง" ตัวนี้คือค่าที่ยืนยันแล้วจริง ใช้โชว์ไอคอนล็อกไว้เสมอไม่ว่าจะ
    // ยังเปิดโหมด "สังเวย" ค้างอยู่หรือปิดไปแล้วก็ตาม (ดู isMyCultSacrificeMemberPick/isMyCultSacrificeTargetPick
    // ด้านล่าง — เหมือนอุ้งเท้าลูกหมาป่า/เป้าชักชวนเข้าลัทธิด้านบนที่ไม่ผูกกับ mode ปัจจุบัน)
    const myCultSacrificeAction = (myCultAction && myCultAction.mode === "sacrifice") ? myCultAction : null;
    const myCultSacrificeLockedMemberId = myCultSacrificeAction ? myCultSacrificeAction.sacrificeId : null;
    const myCultSacrificeLockedTargetId = myCultSacrificeAction ? myCultSacrificeAction.targetId : null;

    // ข้อมูลเป้าเปลี่ยนบทบาทของหัวโจร (แตะการ์ดตรงๆ ได้เลย ไม่ต้องเข้าโหมด) — เห็นเฉพาะตัวเอง
    const myBanditAction = (roomData.banditActions || {})[me] || null;
    const myBanditRecruitTarget = myBanditAction ? myBanditAction.targetId : null;
    // ข้อมูลเป้าฆ่าร่วมทีมโจรของ "ทั้งกลุ่ม" (ไม่ใช่แค่ตัวเอง) — หัวโจรกับผู้สมรู้ร่วมคิดต่างเลือกเป้าเองได้
    // อิสระ (ดู cast_bandit_kill) แต่ต้องเห็น "กันและกัน" ว่าอีกฝ่ายเลือกใครไว้ด้วย (ไม่ใช่เห็นแค่ของตัวเอง)
    // — leader ใช้ 👉 ชี้นิ้ว, ผู้สมรู้ร่วมคิดใช้ 🗡️ วางดาบ (ดูตอนแสดง badge ด้านล่าง)
    const banditGroupLeaderIdForKill = amIBanditLeader ? me : (amIBanditAccomplice ? myBanditLeaderId : null);
    const banditGroupAccompliceIdForKill = banditGroupLeaderIdForKill
        ? (roomData.players.find((pl) => pl.alive && !pl.isHost && pl.role === "ผู้สมรู้ร่วมคิด" && pl.banditLeaderId === banditGroupLeaderIdForKill)?.id || null)
        : null;
    const banditLeaderKillTarget = banditGroupLeaderIdForKill ? ((roomData.banditKillVotes || {})[banditGroupLeaderIdForKill] || null) : null;
    const banditAccompliceKillTarget = banditGroupAccompliceIdForKill ? ((roomData.banditKillVotes || {})[banditGroupAccompliceIdForKill] || null) : null;
    const myBanditKillTarget = (roomData.banditKillVotes || {})[me] || null;

    // ข้อมูลหมาป่าเลือกฆ่า (ใช้เมื่อ mode === "kill")
    const killVotes = roomData.wolfKillVotes || {};
    const murdererVote = roomData.murdererKillVote || null;
    const instigatorVote = roomData.instigatorKillVote || null;
    // myKillTarget: ถ้าเป็นฆาตกรต่อเนื่องใช้ murdererKillVote, ถ้าเป็นผู้ยุยงที่ปลดล็อกแล้วใช้
    // instigatorKillVote, ถ้าเป็นหมาป่าใช้ wolfKillVotes
    const myKillTarget = amIMurderer
        ? (murdererVote && murdererVote.voterId === me ? murdererVote.targetId : null)
        : myInstigatorSoloKillUnlocked
            ? (instigatorVote && instigatorVote.voterId === me ? instigatorVote.targetId : null)
            : killVotes[me];
    const killTargetName = {};
    Object.entries(killVotes).forEach(([vid, tid]) => {
        const t = roomData.players.find(p => p.id === tid);
        if (t) killTargetName[vid] = t.name;
    });

    // อัปเดตแบนเนอร์โหมด (เหนือกริด) + สถานะของตัวเอง
    updateModeBanner(mode, { aliveVotersCount, voteThreshold, myVoteTarget, myKillTarget, myShieldTarget, myCurseTarget, amIGuardianWolf, roomData, myScoutedThisNight: !!(myPlayerObj && myPlayerObj.scoutedThisNight) });

    // เก็บกล่องผู้เล่นที่มีอยู่แล้วไว้ใช้ซ้ำ แทนการรื้อสร้างใหม่ทั้งกริดทุกครั้งที่มีคนกดเลือกเป้าหมาย
    // (กันรูป/การ์ดผู้เล่นที่ "ไม่ได้เปลี่ยน" กระตุกซ้ำ)
    const existingNodes = {};
    players.querySelectorAll(".player[data-pid]").forEach((node) => {
        existingNodes[node.dataset.pid] = node;
    });
    const seenIds = new Set();

    others.forEach((p, idx) => {
        seenIds.add(p.id);

        const isWolfMate = amIWolf && p.id !== me && allWolfRoles.includes(p.role);
        // สมาชิกลัทธิเห็นบทจริงของหัวหน้าลัทธิตัวเอง (ตามคำอธิบายบทผู้นำลัทธิ "คนที่เข้าลัทธิจะเห็นบทหัวลัทธิ")
        // คำนวณไว้ตั้งแต่ต้น loop ผู้เล่นคนนี้เลย เพื่อให้ badge อื่นๆ ที่เช็ค "ไอคอนอาชีพโชว์อยู่มุมนี้หรือยัง"
        // (roleIconShownHereForX ทุกจุดด้านล่าง) รู้ผลตรงกับไอคอนอาชีพจริงที่จะโชว์ตรงการ์ดนี้ กันบัง/ซ้อนกัน
        const isCultLeaderCardForMember = amICultMember && p.id === myCultLeaderId;
        const isMyHuntTarget = (myRole === "นักล่าหัว") && myHuntTargetId && (p.id === myHuntTargetId) && p.alive;
        const isSelected = mode === "normal" && selected === p.id;
        const isMyVote = mode === "vote" && !shieldModeActive && myVoteTarget === p.id;
        const isMyKill = mode === "kill" && myKillTarget === p.id;
        const isMurdererTarget = false; // ฆาตกรต่อเนื่องฆ่าใครก็ได้ยกเว้นตัวเอง
        const isWolfSeer = myRole === "หมาป่าหยั่งรู้";
        const myScoutedThisNight = !!(myPlayerObj && myPlayerObj.scoutedThisNight);
        const amIDetective = myRole === "นักสืบ";
        const myDetectiveScoutedThisNight = !!(myPlayerObj && myPlayerObj.detectiveScoutedThisNight);
        const amICupid = myRole === "กามเทพ";
        const myCupidPaired = !!(myPlayerObj && myPlayerObj.cupidPaired);
        const myInstigatorPaired = !!(myPlayerObj && myPlayerObj.instigatorPaired);
        const isKillRestricted = mode === "kill" && (p.id === me || (!amIMurderer && isWolfMate) || (isWolfSeer && myScoutedThisNight));
        const isMyShieldPick = (mode === "vote" || mode === "shield") && shieldModeActive && myShieldTarget === p.id;
        const isShielded = (mode === "vote" || mode === "shield") && shieldedPlayerIds.has(p.id);
        const isMyCursePick = mode === "curse" && myCurseTarget === p.id;
        // ผู้นำลัทธิ: เป้าที่ "ชักชวนเข้าลัทธิไว้แล้ว" (ส่งไปที่ room.cultActions ฝั่งเซิร์ฟเวอร์แล้วจริงๆ
        // ผ่าน castCultRecruit) โชว์ล็อกไว้เสมอไม่ว่าจะอยู่โหมด "ชักชวน" อยู่หรือไม่ (เหมือนหมอ/บอดี้การ์ด/
        // ลูกหมาป่า/เด็กขี้โวยวายด้านล่าง) — เดิมผูกกับ mode === "cultrecruit" ทำให้พอกดปิดโหมดชักชวน
        // (เช่นจะสลับไปดูโหมดสังเวยแทน หรือกดปิดเฉยๆ) ไอคอนที่เลือกไว้แล้วหายไปจากการ์ดทันที ทั้งที่ยังมีผล
        // อยู่จริงฝั่งเซิร์ฟเวอร์ (ยกเลิกได้เฉพาะแตะการ์ดเดิมซ้ำตอนอยู่ในโหมดเท่านั้น) ทำให้เข้าใจผิดว่าการ
        // เลือกหายไปแล้ว จะหายจริงก็ต่อเมื่อคืนนั้นจบ/สรุปผลแล้ว (room.cultActions ถูกล้างทุกคืนที่
        // resolve_night — ถ้าชวนสำเร็จจะกลายเป็นไอคอนสมาชิกลัทธิ 🔯 แทน ถ้าชวนไม่สำเร็จก็หายไปเฉยๆ)
        const isMyCultRecruitPick = amICultLeader && myCultRecruitTarget === p.id;
        // isMyCultSacrificeMemberPick: เฉพาะตอน "กำลังเลือกอยู่" (แตะคนแรกไว้ระหว่างโหมดเปิด รอแตะคนที่สอง)
        // ยังไม่ได้ส่งไปเซิร์ฟเวอร์ — ต่างจาก isMyCultSacrificeLockedMemberPick/-TargetPick ด้านล่างที่เป็น
        // ค่าที่ "ยืนยันส่งสำเร็จแล้วจริง" (ดูตัวแปร myCultSacrificeLockedMemberId ด้านบน)
        const isMyCultSacrificeMemberPick = mode === "cultsacrifice" && cultSacrificePendingMemberId === p.id;
        // สังเวย (ล็อกแล้วจริง): โชว์ไอคอนติดค้างไว้เสมอไม่ว่าจะปิดโหมด "สังเวย" ไปแล้วหรือไม่ก็ตาม
        // (เหมือนอุ้งเท้าลูกหมาป่า/เป้าชักชวนเข้าลัทธิด้านบน) กันไอคอนหายตอนกดปิดปุ่มโหมดทั้งที่ยังมีผลจริงอยู่
        // รวมกับ isMyCultSacrificeMemberPick (กำลังเลือกอยู่ ยังไม่ส่ง) ในบล็อกเดียวกันด้านล่าง กันเรนเดอร์ซ้ำ
        const isMyCultSacrificeLockedMemberPick = amICultLeader && myCultSacrificeLockedMemberId === p.id;
        const isMyCultSacrificeLockedTargetPick = amICultLeader && myCultSacrificeLockedTargetId === p.id;
        // ให้ผู้นำลัทธิเห็นว่าใครเป็นสมาชิกลัทธิของตัวเองบ้าง (ไอคอน 🔯 เล็กๆ มุมการ์ด) — เห็นเฉพาะตัวผู้นำลัทธิเอง
        // เหมือนกับที่บทอื่นเห็นข้อมูลลับของตัวเอง (โล่/คำสาป) เพราะข้อมูลดิบถูกส่งมาให้ทุกจอเหมือนกันหมดอยู่แล้ว
        // (ดูคอมเมนต์ระบบใน server.js publicRoomView) แต่ฝั่ง UI เลือกโชว์เฉพาะตอนที่ควรเห็นเท่านั้น
        const isMyCultMember = amICultLeader && p.cultLeaderId === me;
        // โจร: เป้าที่ "เลือกเปลี่ยนบทบาทไว้แล้ว" (ส่งไปที่ room.banditActions ฝั่งเซิร์ฟเวอร์แล้วจริงๆ
        // ผ่าน castBanditRecruit) โชว์ภาพหน้ากาก bandit_mask.jpg ล็อกไว้เสมอ จนกว่าจะสำเร็จ/ยกเลิก/เช้ามาถึง
        const isMyBanditRecruitPick = amIBanditLeader && myBanditRecruitTarget === p.id;
        // โจร/ผู้สมรู้ร่วมคิด: เป้าที่ "หัวโจร" กับ "ผู้สมรู้ร่วมคิด" เลือกฆ่าร่วมไว้ (ผ่าน castBanditKill)
        // ให้เห็น "กันและกัน" ทั้งคู่ ไม่ใช่แค่ของตัวเอง — หัวโจรใช้ 👉 ชี้นิ้ว, ผู้สมรู้ร่วมคิดใช้ 🗡️ วางดาบ
        const isBanditLeaderKillPick = (amIBanditLeader || amIBanditAccomplice) && banditLeaderKillTarget === p.id;
        const isBanditAccompliceKillPick = (amIBanditLeader || amIBanditAccomplice) && banditAccompliceKillTarget === p.id;
        // ให้หัวโจรเห็นบทจริงของผู้สมรู้ร่วมคิดตัวเอง (ไอคอนบทเต็ม ไม่ใช่ดาบเล็กๆ อีกต่อไป) — เห็นเฉพาะหัวโจรเอง
        const isMyBanditAccomplice = amIBanditLeader && p.role === "ผู้สมรู้ร่วมคิด" && p.banditLeaderId === me;
        // ผู้สมรู้ร่วมคิดเห็นบทจริงของหัวโจรตัวเอง (เหมือนสมาชิกลัทธิเห็นบทหัวหน้าลัทธิ)
        const isBanditLeaderCardForAccomplice = amIBanditAccomplice && p.id === myBanditLeaderId;
        // แม่มดไม่มีโหมด "protect" แยกอีกแล้ว (แตะการ์ดเป้าตรงๆ ได้เลยเหมือนยายขี้โมโห/หมอ/บอดี้การ์ด)
        const isMyProtectPick = amIWitch && selected === p.id;
        // ยายขี้โมโหไม่มีโหมดเลือกใบ้แยกแล้ว จึงเช็คจาก amIOldLady + selected ตรงๆ (เหมือนหมอ/บอดี้การ์ด)
        const isMySilencePick = amIOldLady && selected === p.id;
        // ลูกหมาป่า: เป้าที่ "จองไว้ลากตายด้วย" ถ้าตัวลูกหมาป่าตาย — โชว์ล็อกไว้เสมอไม่ว่าจะอยู่โหมดเลือกอยู่หรือไม่
        const isMyWolfCubPick = amIWolfCub && selected === p.id;
        // เด็กขี้โวยวาย: เป้าที่ "จองไว้แฉบทบาท" ถ้าตัวเองตาย — โชว์ล็อกไว้เสมอไม่ว่าจะอยู่โหมดเลือกอยู่หรือไม่
        const isMyLoudmouthPick = amILoudmouth && selected === p.id;

        let div = existingNodes[p.id];
        if (!div) {
            div = document.createElement("div");
            div.dataset.pid = p.id;
        }

        // ตรวจจับ "เพิ่งตาย" (alive → dead) เทียบกับ dataset ที่จำสถานะ "มีชีวิต" ไว้จาก render รอบก่อน
        // ครอบคลุมสาเหตุการตายทุกแบบ (แม่มดปายา/ลูกหมาป่าลาก/ศาลเตี้ยยิง/หมาป่ากัด/ฆาตกรต่อเนื่อง/ประหารตอนกลางวัน ฯลฯ)
        // เพราะเช็คจากการเปลี่ยนสถานะ alive ตรงๆ ไม่ต้องแยกเคสตามสาเหตุ — กันคนพลาดไม่เห็นว่ามีคนตายถ้าไม่ได้อ่านแชท
        // เงื่อนไข wasAlive === "1" (ไม่ใช่ undefined) กันไม่ให้เล่นอนิเมชันตอนเพิ่งโหลดหน้าเจอคนที่ตายไปก่อนแล้ว
        const justDied = div.dataset.wasAlive === "1" && !p.alive;
        div.dataset.wasAlive = p.alive ? "1" : "0";
        div.dataset.alive = p.alive ? "1" : "0";

        // หมายเหตุ: ตัดการอ้างอิงสถานะ disconnected/offline ออกจาก UI ทั้งหมดตามที่ตกลงกันแล้ว —
        // ไม่ต้องการให้ผู้เล่นเห็น/ถูกมองว่า "หลุด" เลย แม้จะปิดจอไว้ชั่วคราว (เช่น กันคนข้างๆ แอบดูบท)
        // ฝั่ง server ยังคงเก็บ flag พวกนี้ไว้เหมือนเดิมสำหรับ reconnect ด้วย token แต่ client จะไม่แสดงผล
        // หรือปิดกั้นการใช้งานใดๆ จาก flag นี้อีกต่อไป ผู้เล่นทุกคนจึงดูเหมือน "ออนไลน์" อยู่เสมอ
        div.className = "player "
            + (!p.alive ? "dead" : "")
            + (isSelected ? " selected" : "")
            + (isMyVote ? " my-target" : "")
            + (isMyKill ? " my-kill-target" : "")
            + (isKillRestricted ? " kill-restricted" : "")
            + (isMyHuntTarget ? " hunt-target" : "")
            + (isMyShieldPick ? " my-shield-target" : "")
            + (isMyCursePick ? " my-shield-target" : "")
            + (isMyProtectPick ? " my-protect-target" : "")
            + (isMySilencePick ? " my-silence-target" : "")
            + (isMyWolfCubPick ? " my-wolfcub-target" : "")
            + (isMyLoudmouthPick ? " my-loudmouth-target" : "")
            + (justDied ? " just-died" : "");

        div.onclick = () => {
            if (!myAlive) return;
            if (!p.alive) return;

            if ((mode === "vote" || mode === "shield") && shieldModeActive) {
                if (myShieldTarget === p.id) { castShield(null); } else { castShield(p.id); }
                // เลือก/ยกเลิกเสร็จแล้วออกจากโหมดเลือกทันทีเสมอ — อยากเปลี่ยน/ยกเลิกใหม่ต้องกดปุ่มโล่เข้าโหมดอีกครั้ง
                shieldModeActive = false;
                document.getElementById("shieldBtn")?.classList.remove("active");
                if (lastRoomData) renderPlayerGrid(lastRoomData);
            } else if ((mode === "vote" || mode === "wolfcub") && wolfCubModeActive) {
                // ลูกหมาป่า: จองเป้าลากตายด้วย — ใช้ได้ตลอด (แม้อยู่ระหว่างโหวต/กลางคืน) เหมือนโล่หมาป่าผู้พิทักษ์เป๊ะๆ
                if (p.id === me) return; // ห้ามเลือกตัวเอง
                if (isWolfMate) return; // ห้ามลากหมาป่าด้วยกันเอง (เซิร์ฟเวอร์เช็คซ้ำอีกชั้นด้วย)
                if (selected === p.id) { castWolfCubTarget(null); } else { castWolfCubTarget(p.id); }
                // เลือก/ยกเลิกเสร็จแล้วออกจากโหมดเลือกทันทีเสมอ — อยากเปลี่ยน/ยกเลิกใหม่ต้องกดปุ่ม 🐾 เข้าโหมดอีกครั้ง
                wolfCubModeActive = false;
                document.getElementById("pawBtn")?.classList.remove("active");
                if (lastRoomData) renderPlayerGrid(lastRoomData);
            } else if ((mode === "vote" || mode === "loudmouth") && loudmouthModeActive) {
                // เด็กขี้โวยวาย: จองเป้าไว้แฉบทบาท — ใช้ได้ตลอด (แม้อยู่ระหว่างโหวต/กลางคืน) เหมือนลูกหมาป่าเป๊ะๆ
                if (p.id === me) return; // ห้ามเลือกตัวเอง
                if (selected === p.id) { castLoudmouthTarget(null); } else { castLoudmouthTarget(p.id); }
                // เลือก/ยกเลิกเสร็จแล้วออกจากโหมดเลือกทันทีเสมอ — อยากเปลี่ยน/ยกเลิกใหม่ต้องกดปุ่ม 👄 เข้าโหมดอีกครั้ง
                loudmouthModeActive = false;
                document.getElementById("mouthBtn")?.classList.remove("active");
                if (lastRoomData) renderPlayerGrid(lastRoomData);
            } else if (mode === "vote") {
                if (p.id === me) return; // ห้ามโหวตตัวเอง
                if (myVoteTarget === p.id) { castVote(null); } else { castVote(p.id); }
            } else if (mode === "kill") {
                if (p.id === me) return; // ห้ามเลือกตัวเอง
                if (isWolfMate) return; // ห้ามหมาป่าเลือกฆ่ากันเอง (หมาป่าหยั่งรู้ก็ห้ามส่องหมาป่าด้วยกันเอง)
                if (isWolfSeer) {
                    if (myScoutedThisNight) return; // ส่องไปแล้วคืนนี้
                    scoutTarget(p.id); // เปิดเผยผลทันที ไม่มีการยกเลิก
                } else if (amIMurderer) {
                    if (myKillTarget === p.id) { castMurdererKill(null); } else { castMurdererKill(p.id); }
                } else if (myInstigatorSoloKillUnlocked) {
                    if (myKillTarget === p.id) { castInstigatorKill(null); } else { castInstigatorKill(p.id); }
                } else {
                    if (myKillTarget === p.id) { castWolfKill(null); } else { castWolfKill(p.id); }
                }
            } else if (mode === "sheriff") {
                if (p.id === me) return; // ห้ามยิงตัวเอง
                fireSheriffGun(p.id);
            } else if (mode === "peek") {
                if (p.id === me) return; // ห้ามดูบทตัวเอง
                peekSheriffTarget(p.id);
            } else if (mode === "holywater") {
                if (p.id === me) return; // ห้ามปาน้ำมนต์ใส่ตัวเอง
                castPriestHolyWater(p.id);
            } else if (mode === "poison") {
                if (p.id === me) return; // ห้ามโยนยาพิษใส่ตัวเอง
                castWitchPoison(p.id);
            } else if (mode === "protect") {
                if (p.id === me) return; // ห้ามป้องกันตัวเอง
                if (selected === p.id) { castProtect(null); } else { castProtect(p.id); }
                // เลือก/ยกเลิกเสร็จแล้วออกจากโหมดเลือกทันทีเสมอ — เหมือนโล่หมาป่าผู้พิทักษ์
                protectModeActive = false;
                document.getElementById("protectBtn")?.classList.remove("active");
                if (lastRoomData) renderPlayerGrid(lastRoomData);
            } else if (mode === "curse") {
                if (p.id === me) return; // ร่ายใส่ตัวเองไม่ได้
                if (myCurseTarget === p.id) { castCurse(null); } else { castCurse(p.id); }
            } else if (mode === "cultrecruit") {
                if (p.id === me) return; // ชักชวนตัวเองไม่ได้
                if (myCultRecruitTarget === p.id) { castCultRecruit(null); } else { castCultRecruit(p.id); }
                // เลือก/ยกเลิกเสร็จแล้วออกจากโหมดเลือกทันทีเสมอ — เหมือนยาป้องกันของแม่มด (protect) เป๊ะๆ
                // (ไอคอน 🔯 ที่เลือกไว้ไม่หายไปไหนหลังปิดโหมด เพราะโชว์จาก myCultRecruitTarget แยกต่างหาก
                // ไม่ผูกกับ mode แล้ว — ดูบล็อกอิสระใกล้ badge "อยู่ในลัทธิเดียวกัน")
                cultRecruitModeActive = false;
                document.getElementById("cultRecruitBtn")?.classList.remove("active");
                if (lastRoomData) renderPlayerGrid(lastRoomData);
            } else if (mode === "cultsacrifice") {
                if (p.id === me) return; // เลือกตัวเองไม่ได้ (ทั้งสองช่อง)
                const isMyMember = p.cultLeaderId === me;
                if (cultSacrificePendingMemberId === null) {
                    if (!isMyMember) return; // คนแรกที่แตะต้องเป็นสมาชิกลัทธิของตัวเองเท่านั้น
                    cultSacrificePendingMemberId = p.id;
                    if (lastRoomData) renderPlayerGrid(lastRoomData);
                } else if (cultSacrificePendingMemberId === p.id) {
                    cultSacrificePendingMemberId = null; // แตะซ้ำคนเดิม → ยกเลิก เลือกใหม่ได้
                    if (lastRoomData) renderPlayerGrid(lastRoomData);
                } else {
                    // แตะคนที่สอง — คือเป้าที่จะฆ่า ยิงคำสั่งทันที แล้วออกจากโหมด
                    castCultSacrifice(cultSacrificePendingMemberId, p.id);
                    cultSacrificePendingMemberId = null;
                    cultSacrificeModeActive = false;
                    document.getElementById("cultSacrificeBtn")?.classList.remove("active");
                    if (lastRoomData) renderPlayerGrid(lastRoomData);
                }
            } else if (myRole === "ผู้มีลาง" || myRole === "ผู้หยั่งรู้") {
                if (!roomData.isNight) return; // ส่องได้เฉพาะตอนกลางคืนเท่านั้น
                if (p.id === me) return; // ห้ามส่องตัวเอง
                if (myScoutedThisNight) return; // ส่องไปแล้วคืนนี้
                scoutTarget(p.id); // เปิดเผยผลทันที (เห็นเฉพาะตัวเอง) ไม่มีการยกเลิก
            } else if (amIDetective) {
                // นักสืบ: ต้องเลือก 2 คนถึงจะเห็นผล — แตะคนแรก (ค้างไว้รอ) แล้วแตะคนที่สองเพื่อยิงผลทันที
                if (!roomData.isNight) return; // ส่องได้เฉพาะตอนกลางคืนเท่านั้น
                if (p.id === me) return; // ห้ามส่องตัวเอง
                if (myDetectiveScoutedThisNight) return; // ส่องไปแล้วคืนนี้
                if (detectivePendingSecondId !== null) return; // กำลังอยู่ระหว่างหน่วงเวลาโชว์ 🔍 ก่อนยิงผล ห้ามกดซ้อน
                if (detectivePendingFirstId === null) {
                    detectivePendingFirstId = p.id; // เลือกคนแรก — ขึ้นไอคอน 🔍 ค้างไว้ รอแตะคนที่สอง
                    if (lastRoomData) renderPlayerGrid(lastRoomData);
                } else if (detectivePendingFirstId === p.id) {
                    detectivePendingFirstId = null; // แตะซ้ำคนเดิม → ยกเลิกการเลือกคนแรก เลือกคนใหม่ได้
                    if (lastRoomData) renderPlayerGrid(lastRoomData);
                } else {
                    // แตะคนที่สอง — โชว์ไอคอน 🔍 ค้างไว้บนคนที่สองแป๊ปหนึ่งก่อน แล้วค่อยยิงผล =/≠ จริง
                    const firstId = detectivePendingFirstId;
                    detectivePendingSecondId = p.id;
                    if (lastRoomData) renderPlayerGrid(lastRoomData);
                    setTimeout(() => {
                        detectivePendingFirstId = null;
                        detectivePendingSecondId = null;
                        detectiveScout(firstId, p.id); // เปิดเผยผลทันที (เห็นเฉพาะตัวเอง) ไม่มีการยกเลิก
                    }, DETECTIVE_REVEAL_DELAY_MS);
                }
            } else if (amICupid) {
                // กามเทพ: เลือก 2 คนเพื่อ "เลือกไว้" (pending) — ยังไม่จับคู่จริงทันที เปลี่ยนใจได้เรื่อยๆ
                // ตราบใดที่ยังเป็นกลางคืนอยู่ (ยังไม่เช้า) แตะการ์ดที่เลือกไว้แล้วซ้ำ (คนแรกหรือคนที่สอง)
                // เพื่อยกเลิกเฉพาะคนนั้นแล้วเลือกคนใหม่แทนได้ — ล็อกจริงแบบย้อนกลับไม่ได้ก็ต่อเมื่อถึงเช้า
                // (resolve_night) เท่านั้น (เช็คจาก myCupidPaired ว่าจับคู่จริงไปแล้วหรือยัง)
                if (!roomData.isNight) return; // จับคู่ได้เฉพาะตอนกลางคืนเท่านั้น
                if (p.id === me) return; // จับคู่ตัวเองไม่ได้
                if (myCupidPaired) return; // จับคู่จริงไปแล้วตลอดเกม แก้ไขไม่ได้อีก
                if (cupidPendingFirstId === p.id) {
                    cupidPendingFirstId = cupidPendingSecondId;
                    cupidPendingSecondId = null;
                } else if (cupidPendingSecondId === p.id) {
                    cupidPendingSecondId = null;
                } else if (cupidPendingFirstId === null) {
                    cupidPendingFirstId = p.id;
                } else {
                    // ไม่ว่าคนที่สองจะว่างอยู่หรือมีคนเลือกไว้แล้ว แตะคนใหม่จะแทนที่ช่องที่สองเสมอ
                    cupidPendingSecondId = p.id;
                }
                cupidPair(cupidPendingFirstId, cupidPendingSecondId); // อัปเดตค่า "เลือกไว้" ที่เซิร์ฟเวอร์ทันที (ไม่ล็อก)
                if (lastRoomData) renderPlayerGrid(lastRoomData);
            } else if (amIInstigator) {
                // ผู้ยุยง: ทำงานแบบเดียวกับกามเทพเป๊ะๆ — เลือกไว้ (pending) เปลี่ยนใจได้เรื่อยๆ จนกว่าจะเช้า
                if (!roomData.isNight) return; // จับคู่ได้เฉพาะตอนกลางคืนเท่านั้น
                if (p.id === me) return; // จับคู่ตัวเองไม่ได้
                if (myInstigatorPaired) return; // จับคู่จริงไปแล้วตลอดเกม แก้ไขไม่ได้อีก
                if (instigatorPendingFirstId === p.id) {
                    instigatorPendingFirstId = instigatorPendingSecondId;
                    instigatorPendingSecondId = null;
                } else if (instigatorPendingSecondId === p.id) {
                    instigatorPendingSecondId = null;
                } else if (instigatorPendingFirstId === null) {
                    instigatorPendingFirstId = p.id;
                } else {
                    instigatorPendingSecondId = p.id;
                }
                instigatorPair(instigatorPendingFirstId, instigatorPendingSecondId); // อัปเดตค่า "เลือกไว้" ที่เซิร์ฟเวอร์ทันที (ไม่ล็อก)
                if (lastRoomData) renderPlayerGrid(lastRoomData);
            } else if (amIWitch) {
                // แม่มด: ต้องกดปุ่มยาป้องกัน 🧪 เข้าโหมดก่อนถึงจะเลือกเป้าได้ (เหมือนหมาป่าผู้พิทักษ์ต้องกดปุ่มโล่ก่อน)
                // มี 2 ความสามารถ (ยาป้องกัน/ยาพิษ) ที่แตะการ์ดเดียวกันแต่ทำคนละอย่าง กันไม่ให้แตะเฉยๆ
                // แล้วป้องกัน/ปายาผิดเป้าไปโดยไม่ตั้งใจ ต้องเลือกโหมดก่อนเสมอ
                return;
            } else if (amIOldLady || amIDoctor || amIBodyguard || amIThug || amIIllusionist) {
                // ยายขี้โมโห (ใบ้)/หมอ (รักษา)/บอดี้การ์ด (ป้องกัน)/อันธพาล (ปกป้องเพิ่ม)/นักเล่นกล (ปลอมบท):
                // แตะการ์ดเป้าตรงๆ ได้เลย ไม่ต้องกดปุ่มเข้าโหมดก่อน (บทเหล่านี้มีความสามารถเดียว ไม่ต้องแยกโหมดเหมือนแม่มด)
                if (!roomData.isNight) return; // ความสามารถกลางคืน — เลือกเป้าหมายได้เฉพาะตอนกลางคืนเท่านั้น
                // ยายขี้โมโห: แก้บั๊ก — คำอธิบายบทบาทระบุว่าใช้ได้ "หลังจากคืนแรก" เท่านั้น แต่เดิมฝั่ง UI ไม่มีการกันไว้เลย
                // (เซิร์ฟเวอร์เพิ่งเพิ่มการกันแล้วใน performSelectTarget) กันซ้ำไว้ที่นี่ด้วยกันแตะแล้วเงียบๆ ไม่มีอะไรเกิดขึ้น
                if (amIOldLady && (roomData.nightCount || 0) <= 1) return;
                if (selected === p.id) { selectTarget(null); } else { selectTarget(p.id); }
            } else if (amIBanditLeader || amIBanditAccomplice) {
                // โจร/ผู้สมรู้ร่วมคิด: แตะการ์ดเป้าตรงๆ ได้เลย ไม่ต้องกดปุ่มเข้าโหมดก่อนเช่นกัน
                // หัวโจรที่ยังไม่มีผู้สมรู้ร่วมคิด → แตะแล้วเป็นการ "เปลี่ยนบทบาท" (bandit_action)
                // ส่วนกรณีอื่นทั้งหมด (มีผู้สมรู้ร่วมคิดแล้ว/ตัวเองเป็นผู้สมรู้ร่วมคิดอยู่) → แตะแล้วเป็นการ
                // "เลือกฆ่าร่วม" (cast_bandit_kill) — ดู iBanditHasAccomplice ด้านบน
                if (!roomData.isNight) return; // ความสามารถกลางคืนทั้งคู่ — ใช้ได้เฉพาะตอนกลางคืนเท่านั้น
                if (p.id === me) return; // เลือกตัวเองไม่ได้ทั้งสองแบบ
                if (amIBanditLeader && !iBanditHasAccomplice) {
                    if (myBanditRecruitTarget === p.id) { castBanditRecruit(null); } else { castBanditRecruit(p.id); }
                } else {
                    if (myBanditKillTarget === p.id) { castBanditKill(null); } else { castBanditKill(p.id); }
                }
            }
            // บทอื่นๆ ที่เหลือทั้งหมด (ไม่มีความสามารถเลือกเป้าตอนกลางคืนเลย เช่น ชาวบ้าน/คนบ้า/ผู้ถูกสาป ฯลฯ):
            // แตะการ์ดแล้วไม่ทำอะไรเลย — เอาระบบไฮไลท์ม่วง (.selected) ที่เคยขึ้นทั้งที่ไม่มีสกิลจริงออกแล้ว
            // (เดิมโค้ดตกลงมาที่ branch else ท้ายสุดแล้วเรียก selectTarget ให้ทุกบทที่เหลือโดยไม่ตั้งใจ)
        };

        // ไม่แยกสถานะออฟไลน์/กำลังเชื่อมต่อใหม่อีกต่อไป — ดูจากแค่ยังมีชีวิตอยู่ไหมพอ
        const dotClass = !p.alive ? "dot-dead" : "dot-alive";
        const dotTitle = !p.alive ? "ตายแล้ว" : "มีชีวิต";

        // ===== ส่วนเสริมตามโหมด: badge จำนวนโหวต/จำนวนถูกเลือกฆ่า + ใครเลือกใคร =====
        let modeExtraHtml = "";
        // ตัวช่วยกลางสำหรับ badge/ไอคอนสถานะทุกตัวที่แย่งมุมล่างขวาเดียวกับไอคอนอาชีพ (bottom:4px; right:5px)
        // ไม่ว่าจะเป็นโล่/อุ้งเท้า/ปาก/รักษา/ป้องกัน/ใบ้/นักสืบ/กามเทพ/คู่รัก/ผู้ยุยง/ลัทธิ/ถูกใบ้แล้ว หรือ badge ใหม่ในอนาคต —
        // เรียก claimBottomRightBadgeSlot(roleIconShown) ตอนกำลังจะแสดง badge นั้นจริงๆ (ไม่ใช่แค่คำนวณเผื่อไว้)
        // ตัวที่เรียกก่อนได้ตำแหน่งชิดในสุดก่อน (มาก่อนได้ก่อน) ตัวที่เรียกทีหลังจะขยับซ้ายเพิ่มไปอีกชั้นละ 24px
        // โดยอัตโนมัติ ไม่ทับกัน ไม่ต้องนับ/เขียนเลข offset เองทีละจุดอีกต่อไป
        // หน่วย right ที่คืนกลับมาต้องเป็น cqw (% ของความกว้างการ์ดตัวเอง ดู container-type บน .player
        // ใน player.css) ไม่ใช่ px ตายตัวอีกต่อไป — ตัวเลข 29/5/24 อ้างอิงจากขนาดการ์ดดีฟอลต์ 88px เดิม
        // (ดู applyPlayerGridDensity) คูณอัตราส่วน PLAYER_CARD_CQW_RATIO (=100/88) แปลงเป็น cqw ก่อนคืนค่า
        // ผลคือตำแหน่ง badge เลื่อนตามสัดส่วนเดียวกับขนาดการ์ดเสมอ ไม่ว่าการ์ดจะเล็กลงแค่ไหน
        let bottomRightBadgeSlotsUsed = 0;
        const claimBottomRightBadgeSlot = (roleIconShown) => {
            const base = roleIconShown ? 29 : 5;
            const right = base + bottomRightBadgeSlotsUsed * 24;
            const style = (roleIconShown || bottomRightBadgeSlotsUsed > 0) ? `right:${toCardCqw(right)};` : "";
            bottomRightBadgeSlotsUsed++;
            return style;
        };
        if (mode === "vote") {
            const receivedCount = voteTally[p.id] || 0;
            const reached = voteThreshold > 0 && receivedCount >= voteThreshold;
            const votedFor = voteTargetName[p.id] || null;
            const isRevealedMayor = !!p.mayorRevealed;
            modeExtraHtml = `
                <div class="mode-info-stack">
                    ${receivedCount > 0 ? `<span class="vote-count-badge${reached ? " reached" : ""}">${receivedCount} โหวต${reached ? " ☠️" : ""}</span>` : ""}
                    ${votedFor ? `<div class="vote-voter-list">➜ ${votedFor}${isRevealedMayor ? " 🤠x2" : ""}</div>` : ""}
                </div>
            `;
        } else if (mode === "kill") {
            const killedFor = (!amIMurderer && !isWolfSeer && !myInstigatorSoloKillUnlocked) ? (killTargetName[p.id] || null) : null;
            modeExtraHtml = `
                <div class="mode-info-stack">
                    ${(isWolfMate && !amIMurderer) ? `<div class="vote-voter-list" style="color:var(--wolf);">ห้ามเลือก</div>` : ""}
                    ${(isWolfSeer && myScoutedThisNight && !isWolfMate && p.id !== me) ? `<div class="vote-voter-list" style="color:var(--wolf);">ส่องไปแล้วคืนนี้</div>` : ""}
                    ${killedFor ? `<div class="vote-voter-list">➜ ${killedFor}</div>` : ""}
                </div>
            `;
        } else if (mode === "curse") {
            modeExtraHtml = `
                ${isMyCursePick ? `<span class="shield-placed-badge" title="คุณเลือกร่ายเวทใส่คนนี้">🪄</span>` : ""}
            `;
        } else if (mode === "cultrecruit") {
            // 🔯 เป้าชักชวนเข้าลัทธิ: ย้ายไปโชว์ในบล็อกอิสระที่ไม่ผูกกับ mode ด้านล่างแทนแล้ว (ดู
            // isMyCultRecruitPick ใกล้ๆ badge ลัทธิ "อยู่ในลัทธิเดียวกัน") กันไอคอนหายตอนปิดโหมด
        } else if (mode === "cultsacrifice") {
            // แก้บั๊ก: เดิมไม่ได้ห่อด้วย .mode-info-stack เหมือนโหมด vote/kill ทำให้ div นี้ไม่มี position
            // เป็นของตัวเอง (ต้องพึ่ง .mode-info-stack ถึงจะ absolute ไปแปะขอบล่างการ์ด) จึงลอยอยู่ใน
            // normal flow แทน แล้วไปทับกับ badge ลัทธิ 🔯 ที่ absolute จริงๆ ที่มุมเดียวกัน (การ์ดที่โชว์ข้อความ
            // นี้คือการ์ดสมาชิกลัทธิของตัวเอง ซึ่งก็โชว์ badge 🔯 "อยู่ในลัทธิเดียวกัน" อยู่แล้วเสมอ ชนกันทุกครั้ง)
            modeExtraHtml = `
                ${(cultSacrificePendingMemberId === null && p.cultLeaderId === me) ? `<div class="mode-info-stack"><div class="vote-voter-list">➜ แตะเพื่อสังเวย</div></div>` : ""}
            `;
        } else if (mode === "protect") {
            // ยาป้องกันของแม่มด (กำลังอยู่ระหว่างเลือก ยังไม่ล็อก): เห็นเฉพาะแม่มดเจ้าของยาเองเท่านั้น (คนอื่นไม่เห็น กันข้อมูลรั่ว)
            // เด้งย่อขยายชวนเลือกที่ทุกคนที่ยังมีชีวิต ยกเว้นคนที่เลือกล็อกไว้แล้ว (คนนั้นอยู่นิ่งๆ) — เหมือนโล่หมาป่าผู้พิทักษ์เป๊ะๆ
            // พอเลือกล็อกเป้าเสร็จแล้ว (ออกจากโหมดอัตโนมัติ) badge นิ่งๆ ที่เป้าจะย้ายไปแสดงในบล็อก "amIWitch"
            // ด้านล่างแทน (ไม่ผูกกับ mode อีกต่อไป) กันไม่ให้หายไปเวลาออกจากโหมด — ดูคอมเมนต์แก้บั๊กด้านล่าง
            const isSelectedProtectTarget = selected === p.id;
            const showProtectIcon = amIWitch && p.alive && p.id !== me && !isSelectedProtectTarget;
            const isRevealedToMeForProtect = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereProtect = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForProtect || isCultLeaderCardForMember;
            const protectBadgeShift = showProtectIcon ? claimBottomRightBadgeSlot(roleIconShownHereProtect) : "";
            modeExtraHtml = `
                ${showProtectIcon ? `<span class="player-protect-badge pulsing" style="${protectBadgeShift}" title="แตะเพื่อป้องกันคนนี้">🧪</span>` : ""}
            `;
        } else if (mode === "poison") {
            // ยาพิษของแม่มด: ใช้ครั้งเดียวจบ ไม่มีสถานะล็อกค้าง — เห็นเฉพาะแม่มดเจ้าของยาเอง
            // เด้งย่อขยายชวนเลือกที่ทุกคนที่ยังมีชีวิต แตะแล้วมีป๊อปอัพยืนยันก่อนทุกครั้ง (เอาอนิเมชั่นเดียวกับยาป้องกันมาใช้)
            const showPoisonIcon = amIWitch && p.alive && p.id !== me;
            const isRevealedToMeForPoison = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHerePoison = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForPoison || isCultLeaderCardForMember;
            const poisonBadgeShift = showPoisonIcon ? claimBottomRightBadgeSlot(roleIconShownHerePoison) : "";
            modeExtraHtml = `
                ${showPoisonIcon ? `<span class="player-poison-badge pulsing" style="${poisonBadgeShift}" title="แตะเพื่อโยนยาพิษใส่คนนี้ (มีป๊อปอัพยืนยันก่อนทุกครั้ง)">☠️</span>` : ""}
            `;
        }

        // แก้บั๊ก: เดิมโล่หมาป่าผู้พิทักษ์ (🛡️) และเป้าลากตายของลูกหมาป่า (🐾) ถูกผูกไว้กับ mode === "shield"/"wolfcub"
        // เท่านั้น พอกดออกจากโหมดเลือก (วางโล่/จองเป้าเสร็จแล้ว) mode จะเปลี่ยนไปเป็นค่าอื่น (เช่น "normal"/"kill")
        // ทำให้ไอคอนที่ล็อกเป้าไว้แล้วหายไปด้วย ทั้งที่โล่/เป้ายังคงมีผลอยู่จริง — ตอนนี้แยกออกมาคำนวณ
        // และแสดงผลอิสระจาก mode เลย ให้โชว์ค้างอยู่ตลอดตราบใดที่ยังล็อกเป้าไว้ (ไม่ใช่แค่ตอนกดปุ่มเข้าโหมด)
        {
            // โล่: แสดงเฉพาะให้เจ้าของสกิล (หมาป่าผู้พิทักษ์/หนูน้อยผู้ใสซื่อ) เห็นว่าตัวเองวางโล่ถูกคน (คนอื่นไม่เห็น กันข้อมูลรั่ว)
            // - อยู่โหมดเลือก (shieldModeActive) → โล่เด้งย่อขยายที่ทุกคนที่ยังมีชีวิต ยกเว้นคนที่ล็อกไว้แล้ว (คนนั้นอยู่นิ่งๆ)
            // - ไม่ได้อยู่โหมดเลือก (กดเลือก/ยกเลิกเสร็จแล้วออกจากโหมดอัตโนมัติ) → เหลือโชว์แค่คนที่ล็อกไว้ อยู่นิ่งๆ ตลอดไป คนอื่นไม่เห็นเลย
            //   อยากเปลี่ยน/ยกเลิกใหม่ต้องกดปุ่มโล่เข้าโหมดอีกครั้ง
            const isSelectedShieldTarget = myShieldTarget === p.id;
            const showShieldIcon = GUARDIAN_ROLES.has(myRole) && p.alive
                && (isSelectedShieldTarget || shieldModeActive);
            const shieldIconPulsing = shieldModeActive && !isSelectedShieldTarget;
            // ถ้ามุมขวาล่างมีไอคอนอาชีพโชว์อยู่แล้ว (ตัวเอง/เพื่อนหมาป่า/เปิดเผยแล้ว) ให้เลื่อนโล่ไปทางซ้ายไม่ทับกัน
            const isRevealedToMeForShield = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHere = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForShield || isCultLeaderCardForMember;
            if (showShieldIcon) {
                const shieldBadgeShift = claimBottomRightBadgeSlot(roleIconShownHere);
                const shieldEmoji = getGuardianShieldHTML(myRole);
                modeExtraHtml += `<span class="player-shield-badge${shieldIconPulsing ? " pulsing" : ""}" style="${shieldBadgeShift}" title="${isSelectedShieldTarget ? "คุณวางโล่ป้องกันคนนี้ไว้ — แตะอีกครั้งเพื่อยกเลิก" : "แตะเพื่อวางโล่ป้องกันคนนี้"}">${shieldEmoji}</span>`;
            }

            // 🐾 ลูกหมาป่า: เป้าที่จองไว้ลากตายด้วย — เห็นเฉพาะลูกหมาป่าเจ้าของสกิลเอง (คนอื่นไม่เห็น กันข้อมูลรั่ว)
            // เด้งย่อขยายชวนเลือกทุกคนที่ยังมีชีวิต (ยกเว้นตัวเองและเพื่อนหมาป่าที่เลือกไม่ได้อยู่แล้ว) ตอนกำลังอยู่โหมดเลือก
            // เหมือนโล่หมาป่าผู้พิทักษ์เป๊ะๆ — ล็อกเป้าแล้ว/ปิดโหมดแล้วเหลือแค่เด้งที่เป้าที่ล็อกไว้ อยู่นิ่งๆ ตลอดไป
            const isSelectedWolfCubTarget = amIWolfCub && selected === p.id;
            const showPawIcon = amIWolfCub && p.alive && p.id !== me && !isWolfMate
                && (isSelectedWolfCubTarget || wolfCubModeActive);
            const pawIconPulsing = wolfCubModeActive && !isSelectedWolfCubTarget;
            const isRevealedToMeForPaw = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereForPaw = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForPaw || isCultLeaderCardForMember;
            if (showPawIcon) {
                const pawBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereForPaw);
                modeExtraHtml += `<span class="player-pawprint-badge${pawIconPulsing ? " pulsing" : ""}" style="${pawBadgeShift}" title="${isSelectedWolfCubTarget ? "คุณเลือกลากคนนี้ตายตามไว้ — แตะอีกครั้งเพื่อยกเลิก" : "แตะเพื่อจองลากคนนี้ตายตามหากคุณตาย"}">🐾</span>`;
            }

            // 👄 เด็กขี้โวยวาย: เป้าที่จองไว้แฉบทบาท — เห็นเฉพาะเจ้าของสกิลเอง (คนอื่นไม่เห็น กันข้อมูลรั่ว)
            // เด้งย่อขยายชวนเลือกทุกคนที่ยังมีชีวิต (ยกเว้นตัวเอง) ตอนกำลังอยู่โหมดเลือก เหมือนอุ้งเท้าลูกหมาป่าเป๊ะๆ
            const isSelectedLoudmouthTarget = amILoudmouth && selected === p.id;
            const showMouthIcon = amILoudmouth && p.alive && p.id !== me
                && (isSelectedLoudmouthTarget || loudmouthModeActive);
            const mouthIconPulsing = loudmouthModeActive && !isSelectedLoudmouthTarget;
            const isRevealedToMeForMouth = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereForMouth = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForMouth || isCultLeaderCardForMember;
            if (showMouthIcon) {
                const mouthBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereForMouth);
                modeExtraHtml += `<span class="player-mouth-badge${mouthIconPulsing ? " pulsing" : ""}" style="${mouthBadgeShift}" title="${isSelectedLoudmouthTarget ? "คุณเลือกแฉคนนี้ไว้หากคุณตาย — แตะอีกครั้งเพื่อยกเลิก" : "แตะเพื่อจองแฉบทบาทคนนี้หากคุณตาย"}">👄</span>`;
            }
        }

        // เป้าที่ยายขี้โมโหเลือกใบ้ไว้ (🤫) / หมอเลือกรักษาไว้ (❤️) / บอดี้การ์ดเลือกป้องกันไว้ (🛡️) / แม่มดเลือกใช้ยาป้องกันไว้ (🧪):
        // ยายขี้โมโห/หมอ/บอดี้การ์ดแตะการ์ดเป้าตรงๆ ได้เลย ไม่มีปุ่มเข้าโหมด ส่วนแม่มดยังต้องกดปุ่ม 🧪 เข้าโหมดก่อน
        // (มี 2 ความสามารถแยกกับยาพิษ) แต่ทั้งสี่บทนี้พอ "ล็อกเป้าแล้ว" (selected === p.id) จะแสดงไอคอนนิ่งๆ
        // ที่มุมการ์ดเป้าเหมือนกันหมด ไม่มีอนิเมชั่นเด้ง ไม่ผูกกับ mode ปัจจุบัน (กันไม่ให้หายตอนออกจากโหมด)
        // เห็นเฉพาะเจ้าของบทเองเท่านั้น (คนอื่นไม่เห็นระหว่างคืน กันข้อมูลรั่ว)
        if ((amIOldLady || amIDoctor || amIBodyguard || amIWitch || amIThug) && roomData.isNight && p.alive && p.id !== me && selected === p.id) {
            const isRevealedToMeForHeal = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereHeal = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForHeal || isCultLeaderCardForMember;
            const healBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereHeal);
            if (amIOldLady) {
                modeExtraHtml += `<span class="player-silence-badge" style="${healBadgeShift}" title="คุณเลือกใบ้คนนี้ไว้ — แตะอีกครั้งเพื่อยกเลิก">🤫</span>`;
            } else if (amIDoctor) {
                modeExtraHtml += `<span class="player-heal-badge" style="${healBadgeShift}" title="คุณเลือกรักษาคนนี้ไว้ — แตะอีกครั้งเพื่อยกเลิก">❤️</span>`;
            } else if (amIWitch) {
                modeExtraHtml += `<span class="player-protect-badge" style="${healBadgeShift}" title="คุณเลือกป้องกันคนนี้ไว้ด้วยยาป้องกัน — แตะอีกครั้งเพื่อยกเลิก">🧪</span>`;
            } else if (amIThug) {
                modeExtraHtml += `<span class="player-shield-badge" style="${healBadgeShift}" title="คุณเลือกปกป้องคนนี้ไว้ด้วย — แตะอีกครั้งเพื่อยกเลิก">👊</span>`;
            } else {
                modeExtraHtml += `<span class="player-shield-badge" style="${healBadgeShift}" title="คุณเลือกป้องกันคนนี้ไว้ — แตะอีกครั้งเพื่อยกเลิก">🛡️</span>`;
            }
        }

        // 🔥 นักเล่นกล: คนที่ถูกปลอมบทไว้ (ทั้งที่ยืนยันแล้วจริงจาก illusionTargetIds และที่กำลังเลือกไว้คืนนี้
        // ยังไม่ resolve) โชว์ไอคอนค้างไว้ถาวรที่ตัวคนนั้นเสมอ ไม่ว่าจะกลางวัน/กลางคืน/สลับโหมดไปแล้วก็ตาม
        // จนกว่าคนนั้นจะตาย (ถูกนักเล่นกลกดฆ่ารวด หรือตายด้วยวิธีอื่น) — เห็นเฉพาะนักเล่นกลเจ้าของสกิลเอง
        if (amIIllusionist && p.alive && p.id !== me && (myIllusionTargetIds.includes(p.id) || selected === p.id)) {
            const isRevealedToMeForIllusion = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereIllusion = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForIllusion || isCultLeaderCardForMember;
            const illusionBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereIllusion);
            modeExtraHtml += `<span class="player-illusion-badge" style="${illusionBadgeShift}" title="คุณปลอมบทคนนี้ไว้แล้ว — จะค้างอยู่จนกว่าจะตาย">🔥</span>`;
        }

        // นักสืบ: การ์ดของ "คนแรกที่แตะเลือกไว้" (กำลังรอแตะคนที่สอง) — เห็นเฉพาะนักสืบเอง
        // แตะซ้ำการ์ดเดิมเพื่อยกเลิก (จัดการที่ตัว handler ด้านบน) แตะการ์ดคนอื่นเพื่อยิงผลเปรียบเทียบ
        // ทั้งคนแรกและคนที่สองจะขึ้นไอคอน 🔍 ค้างไว้แป๊ปหนึ่ง (ระหว่างช่วงหน่วงเวลา) ก่อนที่ผล =/≠ จะปรากฏ
        if (amIDetective && roomData.isNight && p.alive && p.id !== me && (detectivePendingFirstId === p.id || detectivePendingSecondId === p.id)) {
            const isRevealedToMeForDetective = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereDetective = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForDetective || isCultLeaderCardForMember;
            const detectiveBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereDetective);
            const isSecondPick = detectivePendingSecondId === p.id;
            const badgeTitle = isSecondPick
                ? "กำลังเทียบทีม..."
                : "เลือกคนนี้เป็นคนแรกแล้ว — แตะคนที่สองเพื่อดูผล หรือแตะการ์ดนี้ซ้ำเพื่อยกเลิก";
            modeExtraHtml += `<span class="player-detective-badge pulsing" style="${detectiveBadgeShift}" title="${badgeTitle}">🔍</span>`;
        }

        // กามเทพ: การ์ดของ "คนแรกที่แตะเลือกไว้" (กำลังรอแตะคนที่สอง) — เห็นเฉพาะกามเทพเอง โครงเดียวกับนักสืบเป๊ะๆ
        // แตะซ้ำการ์ดเดิมเพื่อยกเลิก (จัดการที่ตัว handler ด้านบน) แตะการ์ดคนอื่นเพื่อจับคู่จริง
        if (amICupid && roomData.isNight && p.alive && p.id !== me && (cupidPendingFirstId === p.id || cupidPendingSecondId === p.id)) {
            const isRevealedToMeForCupid = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereCupid = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForCupid || isCultLeaderCardForMember;
            const cupidBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereCupid);
            const isCupidSecondPick = cupidPendingSecondId === p.id;
            const cupidBadgeTitle = isCupidSecondPick
                ? "กำลังจับคู่..."
                : "เลือกคนนี้เป็นคนแรกแล้ว — แตะคนที่สองเพื่อจับคู่ หรือแตะการ์ดนี้ซ้ำเพื่อยกเลิก";
            modeExtraHtml += `<span class="player-cupid-badge pulsing" style="${cupidBadgeShift}" title="${cupidBadgeTitle}">💖</span>`;
        }

        // 💘 คู่รัก: เห็นเฉพาะสองคนที่ถูกกามเทพจับคู่ไว้ + ตัวกามเทพเองที่จับคู่นี้ไว้ (เห็นแค่ว่า "คู่ของตัวเองคือใคร"
        // ไม่เห็นว่าผู้ยุยงจับคู่ใครไว้) เช็คจาก myPlayerObj.loverId (สำหรับคู่รักสองคน) หรือ
        // myPlayerObj.cupidPairTargetIds (สำหรับกามเทพเอง — ตั้งค่าตอนสรุปผลเช้าใน resolve_night)
        // ไม่มีทางรู้ว่าใครคือกามเทพจากไอคอนนี้ (คู่รักสองคนไม่เห็น field คู่กามเทพ)
        {
            const myLoverId = myPlayerObj && myPlayerObj.loverId;
            const myCupidPairIds = (myPlayerObj && myPlayerObj.role === "กามเทพ" && Array.isArray(myPlayerObj.cupidPairTargetIds))
                ? myPlayerObj.cupidPairTargetIds
                : null;
            const showLoverBadge = (!!myLoverId && (p.id === me || p.id === myLoverId))
                || (!!myCupidPairIds && myCupidPairIds.includes(p.id));
            if (showLoverBadge) {
                // ย้ายมาไว้มุมล่างขวาถัดจากไอคอนอาชีพแทนมุมบนซ้ายเดิม — ใช้ตรรกะเลื่อนหลบแบบเดียวกับ
                // badge อื่นๆ ที่มุมนี้ทั้งหมด (เลื่อนซ้ายเมื่อมีไอคอนอาชีพโผล่อยู่ในมุมนั้นด้วย)
                const isRevealedToMeForLover = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
                const roleIconShownHereForLover = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForLover || isCultLeaderCardForMember;
                const loverBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereForLover);
                const loverBadgeSrc = wwImg("/images/love.jpg");
                modeExtraHtml += `<img src="${loverBadgeSrc}" class="player-lover-badge-bottom" style="${loverBadgeShift}object-fit:cover;border-radius:50%;" title="คู่รักที่ถูกจับคู่ไว้" onerror="this.style.display='none'">`;
            }
        }

        // ผู้ยุยง: การ์ดของ "คนแรกที่แตะเลือกไว้" (กำลังรอแตะคนที่สอง) — เห็นเฉพาะผู้ยุยงเอง โครงเดียวกับกามเทพเป๊ะๆ
        // แตะซ้ำการ์ดเดิมเพื่อยกเลิก (จัดการที่ตัว handler ด้านบน) แตะการ์ดคนอื่นเพื่อจับคู่จริง
        // ต่างจากกามเทพตรงที่ใช้รูปผู้ยุยงแทน emoji หัวใจทั้งหมด
        if (amIInstigator && roomData.isNight && p.alive && p.id !== me && (instigatorPendingFirstId === p.id || instigatorPendingSecondId === p.id)) {
            const isRevealedToMeForInstigator = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereInstigator = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForInstigator || isCultLeaderCardForMember;
            const instigatorBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereInstigator);
            const isInstigatorSecondPick = instigatorPendingSecondId === p.id;
            const instigatorBadgeTitle = isInstigatorSecondPick
                ? "กำลังจับคู่..."
                : "เลือกคนนี้เป็นคนแรกแล้ว — แตะคนที่สองเพื่อจับคู่ หรือแตะการ์ดนี้ซ้ำเพื่อยกเลิก";
            const instigatorBadgeIcon = wwImg("/images/instigater.jpg");
            modeExtraHtml += `<span class="player-instigator-badge pulsing" style="${instigatorBadgeShift}" title="${instigatorBadgeTitle}"><img src="${instigatorBadgeIcon}" alt="🎭" onerror="this.style.display='none'"></span>`;
        }

        // ผู้ยุยง: คู่ที่ถูกจับ — เห็นเฉพาะสองคนที่ถูกผู้ยุยงจับคู่ไว้ + ตัวผู้ยุยงเองที่จับคู่นี้ไว้ (เห็นแค่ว่า
        // "คู่ของตัวเองคือใคร" ไม่เห็นว่ากามเทพจับคู่ใครไว้) เช็คจาก myPlayerObj.instigatorLinkId (สำหรับคู่ที่ถูกจับ)
        // หรือ myPlayerObj.instigatorPairTargetIds (สำหรับผู้ยุยงเอง — ตั้งค่าตอนสรุปผลเช้าใน resolve_night)
        // ต่างจากคู่รักของกามเทพตรงที่คู่นี้ "เห็นตัวตนที่แท้จริงของผู้ยุยง" ได้ด้วย (ผ่าน roleRevealMutualWith
        // ที่ server push ไว้ตอนสรุปผล) — แต่ตัวผู้ยุยงเองไม่ได้รับสิทธิ์นั้นเพิ่ม แค่เห็นไอคอนว่าคู่ไหน
        {
            const myInstigatorLinkId = myPlayerObj && myPlayerObj.instigatorLinkId;
            const myInstigatorPairIds = (myPlayerObj && myPlayerObj.role === "ผู้ยุยง" && Array.isArray(myPlayerObj.instigatorPairTargetIds))
                ? myPlayerObj.instigatorPairTargetIds
                : null;
            const showInstigatorLinkBadge = (!!myInstigatorLinkId && (p.id === me || p.id === myInstigatorLinkId))
                || (!!myInstigatorPairIds && myInstigatorPairIds.includes(p.id));
            if (showInstigatorLinkBadge) {
                const instigatorLinkIcon = wwImg("/images/instigater.jpg");
                modeExtraHtml += `<span class="player-instigator-link-badge" title="ถูกผู้ยุยงจับคู่ไว้ด้วยกัน"><img src="${instigatorLinkIcon}" alt="🎭" onerror="this.style.display='none'"></span>`;
            }
        }

        // 🔯 ลัทธิ: ผู้นำลัทธิเห็นสมาชิกทุกคนของตัวเอง (ไม่ว่าจะยังมีชีวิตอยู่หรือตายไปแล้วก็ตาม — เข้าร่วมแล้ว
        // ถือว่าติดสัญลักษณ์ลัทธินี้ไปตลอด ไม่มีเงื่อนไข p.alive ในนี้โดยตั้งใจ) ส่วนสมาชิกเองก็เห็นสัญลักษณ์นี้
        // บนตัวเอง + หัวหน้าลัทธิ + เพื่อนสมาชิกคนอื่นทุกคนในลัทธิเดียวกันด้วย (ตามคำอธิบายบทบาทผู้นำลัทธิ
        // ที่ระบุไว้ว่า "เห็นว่าใครเป็นสมาชิกแต่ไม่เห็นบท") — เห็นแค่ไอคอนบอกว่า "อยู่ลัทธิเดียวกัน" เท่านั้น
        // ไม่มีข้อความบอกว่า "เป็นสมาชิก" ปนอยู่ในคำอธิบายอาชีพของตัวเองแต่อย่างใด ไม่เห็นบทบาทจริงของสมาชิกคนอื่นเลย
        {
            const myCultLeaderIdBadge = myPlayerObj && myPlayerObj.cultLeaderId;
            const showCultBadge = amICultLeader
                ? p.cultLeaderId === me // ผู้นำลัทธิ: เห็นสมาชิกของตัวเองทุกคน ไม่ว่าจะตายไปแล้วหรือไม่
                // สมาชิก: เห็นตัวเอง + เพื่อนสมาชิกคนอื่นทุกคนในลัทธิเดียวกัน (ไม่ว่าจะตายไปแล้วหรือไม่)
                // ไม่รวมการ์ดหัวหน้าลัทธิอีกต่อไป (p.id === myCultLeaderIdBadge) — การ์ดหัวหน้าลัทธิ
                // เปลี่ยนไปโชว์ไอคอนบทจริงแทนสัญลักษณ์ 🔯 แล้ว ดู showRole ด้านล่าง (isCultLeaderCardForMember)
                : !!myCultLeaderIdBadge && (p.id === me || p.cultLeaderId === myCultLeaderIdBadge);
            if (showCultBadge) {
                // ย้ายไปมุมบนขวา (สมมาตรกับ badge "ถูกจับคู่ยุยง" ที่อยู่มุมบนซ้าย) ไม่ใช้ระบบ
                // claimBottomRightBadgeSlot อีกต่อไป เพราะอยู่คนละมุมกับ badge อื่นในสล็อตนั้น ไม่มีทางชนกัน
                const cultBadgeIcon = wwImg("/images/sect_members.jpg");
                modeExtraHtml += `<span class="player-cult-badge" title="อยู่ในลัทธิเดียวกัน"><img src="${cultBadgeIcon}" alt="🔯" onerror="this.style.display='none'"></span>`;
            }
        }

        // 🔯 ลัทธิ (ชักชวน — ล็อกแล้วจริง) + 🕯️/🗡️ ลัทธิ (สังเวย): เห็นเฉพาะผู้นำลัทธิเจ้าของสกิลเอง
        // ไม่ผูกกับ mode ปัจจุบันทั้งคู่ (isMyCultRecruitPick มาจาก myCultRecruitTarget, isMyCultSacrificeMemberPick/
        // -LockedMemberPick/-LockedTargetPick มาจาก cultSacrificePendingMemberId ที่กำลังเลือกอยู่ หรือ
        // room.cultActions ที่เซิร์ฟเวอร์ยืนยันรับไว้จริงแล้ว) กันไอคอนหายตอนกดปิดปุ่มโหมดทั้งที่การเลือก
        // ยังมีผลอยู่จนกว่าจะถึงเช้า/สรุปผล เหมือนอุ้งเท้าลูกหมาป่า (🐾) เป๊ะๆ
        if (isMyCultRecruitPick) {
            const isRevealedToMeForRecruit = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereForRecruit = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForRecruit || isCultLeaderCardForMember;
            const recruitBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereForRecruit);
            const recruitBadgeSrc = wwImg("/images/sect1.jpg");
            modeExtraHtml += `<img src="${recruitBadgeSrc}" class="player-lover-badge-bottom" style="${recruitBadgeShift}object-fit:cover;border-radius:50%;" title="คุณเลือกชักชวนคนนี้เข้าลัทธิไว้แล้วคืนนี้" onerror="this.style.display='none'">`;
        }
        if (isMyCultSacrificeMemberPick || isMyCultSacrificeLockedMemberPick) {
            const isRevealedToMeForSacMember = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereForSacMember = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForSacMember || isCultLeaderCardForMember;
            const sacMemberBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereForSacMember);
            const sacMemberTitle = isMyCultSacrificeMemberPick && !isMyCultSacrificeLockedMemberPick
                ? "เลือกเป็นสมาชิกที่จะสังเวยแล้ว — แตะคนถัดไปเพื่อเลือกเป้าที่จะฆ่า"
                : "เลือกสังเวยคนนี้ไว้แล้วคืนนี้";
            const sacMemberBadgeSrc = wwImg("/images/sect2.jpg");
            modeExtraHtml += `<img src="${sacMemberBadgeSrc}" class="player-lover-badge-bottom" style="${sacMemberBadgeShift}object-fit:cover;border-radius:50%;" title="${sacMemberTitle}" onerror="this.style.display='none'">`;
        }
        if (isMyCultSacrificeLockedTargetPick) {
            const isRevealedToMeForSacTarget = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereForSacTarget = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForSacTarget || isCultLeaderCardForMember;
            const sacTargetBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereForSacTarget);
            modeExtraHtml += `<span class="player-lover-badge-bottom" style="${sacTargetBadgeShift}" title="เป้าที่จะถูกฆ่าด้วยการสังเวยคืนนี้">🗡️</span>`;
        }

        // isMyBanditAccomplice ไม่ต้องมี badge เล็กแยกแล้ว — เพิ่มเข้า showRole ด้านล่างให้เห็นไอคอนบทเต็ม
        // (accomplice.jpg) ไปเลยแทน "ดาบ" (ดู const showRole ด้านล่างในฟังก์ชันนี้)

        // 🎭 โจร: เป้าที่ "กำลังเลือกเปลี่ยนบทบาทไว้" (ยังไม่ resolve) โชว์ภาพหน้ากาก bandit_mask.jpg
        // ค้างไว้ที่ตัวคนนั้น จนกว่าจะสำเร็จ (แล้ว badge นี้จะหายไปเอง เพราะกลายเป็นการเห็นบทเต็มแทน) /
        // ถูกยกเลิก / หรือถึงเช้า (room.banditActions ถูกล้างทุกครั้งตอน resolve_night)
        if (isMyBanditRecruitPick) {
            const isRevealedToMeForBanditRecruit = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
            const roleIconShownHereForBanditRecruit = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMeForBanditRecruit || isCultLeaderCardForMember;
            const banditRecruitBadgeShift = claimBottomRightBadgeSlot(roleIconShownHereForBanditRecruit);
            const banditMaskSrc = wwImg("/images/bandit_mask.jpg");
            modeExtraHtml += `<img src="${banditMaskSrc}" class="player-lover-badge-bottom" style="${banditRecruitBadgeShift}object-fit:cover;border-radius:50%;" title="คุณเลือกเปลี่ยนบทบาทคนนี้ไว้แล้วคืนนี้" onerror="this.style.display='none'">`;
        }
        // 👉/🗡️ เป้าฆ่าร่วมทีมโจร — ให้หัวโจรกับผู้สมรู้ร่วมคิด "เห็นกันและกัน" ว่าใครเลือกใครไว้ (ไม่ใช่แค่ของตัวเอง)
        // หัวโจร = 👉 ชี้นิ้วมุมขวาบนของการ์ด เอียงชี้ทแยงลงมาทางชื่อ, ผู้สมรู้ร่วมคิด = 🗡️ วางมีดกลางการ์ด
        // ไม่ใช้ claimBottomRightBadgeSlot เพราะอยู่คนละตำแหน่งกับ badge อื่นๆ ทั้งหมด ไม่มีทางชนกัน
        if (isBanditLeaderKillPick) {
            modeExtraHtml += `<span class="player-bandit-point-badge" title="หัวโจรเลือกฆ่าร่วมกับคนนี้ไว้">👉</span>`;
        }
        if (isBanditAccompliceKillPick) {
            modeExtraHtml += `<span class="player-bandit-sword-badge" title="ผู้สมรู้ร่วมคิดเลือกฆ่าร่วมกับคนนี้ไว้">🗡️</span>`;
        }

        const newInnerHTML = `
            <div class="pname" style="${p.id === me ? "color:#facc15;font-weight:700;" : (isWolfMate ? "color:var(--wolf);font-weight:700;" : "")}">
                ${isMyHuntTarget ? `<span style="font-size:${toCardCqw(14)};line-height:1;" title="เป้าหมายของคุณ">🎯</span> ` : ""}${escapeHtml(p.name)}<span class="status-dot ${dotClass}" title="${dotTitle}"></span>
            </div>
            ${(() => {
                // ผลจาก "ส่อง" (หมาป่าหยั่งรู้/ผู้มีลาง/ผู้หยั่งรู้) — รูปใหญ่กลางการ์ด อยู่ต่อจาก .pname
                // ใน flow ปกติ (ไม่ absolute) จึงไม่มีทางบังชื่อได้เลย ต่างจากไอคอนอาชีพเล็กมุมล่างขวา
                const wolfSeerRevealed = amIWolf && !!p.wolfSeerRevealed; // เห็นทั้งทีมหมาป่า
                const trueSeerRevealed = Array.isArray(p.trueSeerRevealedTo) && p.trueSeerRevealedTo.includes(me); // เห็นเฉพาะตัวเอง
                const sheriffRevealed = Array.isArray(p.sheriffRevealedTo) && p.sheriffRevealedTo.includes(me); // ศาลเตี้ยดูบทตอนกลางวัน เห็นเฉพาะตัวเอง

                if (wolfSeerRevealed || trueSeerRevealed || sheriffRevealed) {
                    // ใช้บทที่ "เห็นตอนส่อง" แบบ snapshot ที่เซิร์ฟเวอร์เก็บไว้ตอนส่อง แทนการอ่าน
                    // p.role สดๆ ตรงๆ — กันไม่ให้ไอคอน/ผลส่องเก่าเปลี่ยนไปเองเมื่อบทจริงของเป้าหมาย
                    // เปลี่ยนภายหลัง (เช่น ผู้ถูกสาปโดนกัดกลายเป็นหมาป่าอัตโนมัติตอนเช้า)
                    const snapshotRole = wolfSeerRevealed
                        ? (p.wolfSeerRevealedRole || p.role)
                        : trueSeerRevealed
                        ? ((p.trueSeerRevealedRoleBy && p.trueSeerRevealedRoleBy[me]) || p.role)
                        : ((p.sheriffRevealedRoleBy && p.sheriffRevealedRoleBy[me]) || p.role);
                    return `<div class="player-scout-reveal" title="${snapshotRole}">${getRoleIcon(snapshotRole)}</div>`;
                }
                const auraResult = p.auraRevealedTo && p.auraRevealedTo[me]; // เห็นเฉพาะตัวเอง (ผู้มีลาง)
                if (auraResult) {
                    const auraIcon = auraResult === "ดี" ? "✅" : auraResult === "ร้าย" ? "☠️" : "❓";
                    const auraColor = auraResult === "ดี" ? "rgba(34,197,94,.7)" : auraResult === "ร้าย" ? "rgba(239,68,68,.7)" : "rgba(148,163,184,.6)";
                    return `<div class="player-scout-reveal player-scout-aura" style="border-color:${auraColor};" title="ลาง: ${auraResult}">${auraIcon}</div>`;
                }
                // ผลจาก "นักสืบ" (detective_scout) — สัญลักษณ์ = (ทีมเดียวกัน) หรือ ≠ (คนละทีม) ตัวใหญ่กลางการ์ด
                // เห็นเฉพาะนักสืบเอง (self-only เหมือนผู้มีลาง/ผู้หยั่งรู้) โชว์ที่การ์ดทั้งสองคนที่ถูกเทียบ
                const detectiveResult = p.detectiveRevealedTo && p.detectiveRevealedTo[me];
                if (detectiveResult) {
                    const sameTeam = !!detectiveResult.same;
                    const symbol = sameTeam ? "=" : "≠";
                    const color = sameTeam ? "rgba(34,197,94,.85)" : "rgba(239,68,68,.85)";
                    const withName = detectiveResult.withName || "";
                    return `<div class="player-scout-reveal player-scout-detective" style="border-color:${color};color:${color};" title="เทียบกับ ${escapeHtml(withName)}: ${sameTeam ? "ทีมเดียวกัน" : "คนละทีมกัน"}">${symbol}</div>`;
                }
                return "";
            })()}
            ${(() => {
                // เปิดเผยไอคอนอาชีพที่มุมล่างขวาของการ์ดผู้เล่น เมื่อใดก็ตามที่:
                // - เป็นตัวเราเอง หรือเป็นเพื่อนทีมหมาป่า (เดิม)
                // - บทบาทนี้ถูกเปิดเผยต่อสาธารณะแล้ว (roleRevealPublic) เช่น ศาลเตี้ยยิง/ลูกหมาป่าตาย/
                //   อันธพาลตายจากบาดแผล (ไม่ใช่โหวต) — ทุกคนเห็นเหมือนกันหมด
                // - บทบาทนี้ถูกเปิดเผยแบบส่วนตัวให้เราเห็นโดยเฉพาะ (roleRevealMutualWith รวม id ของเรา)
                //   เช่น อันธพาลกับผู้โจมตีที่เห็นบทบาทกันและกัน
                const isRevealedToMe = Array.isArray(p.roleRevealMutualWith) && p.roleRevealMutualWith.includes(me);
                // isCultLeaderCardForMember (คำนวณไว้ตอนต้น loop ผู้เล่นคนนี้แล้ว ดูด้านบน): โชว์ไอคอนบทจริง
                // ตรงการ์ดหัวหน้าลัทธิแทนสัญลักษณ์ 🔯 ทั่วไป (ดู showCultBadge ด้านบนที่ตัดการ์ดหัวหน้าลัทธิ
                // ออกจากสัญลักษณ์นั้นแล้ว เพื่อไม่ให้ซ้อนกันสองไอคอน)
                const showRole = (myRole && p.id === me) || isWolfMate || !!p.roleRevealPublic || isRevealedToMe || isCultLeaderCardForMember || isBanditLeaderCardForAccomplice || isMyBanditAccomplice;
                // ผลของการใบ้จะเปิดเผยให้ทุกคนเห็นก็ต่อเมื่อถึงเช้า (กลางวัน) เท่านั้น — ตอนกลางคืนที่ยายขี้โมโหกำลังเลือกเป้าอยู่
                // จะยังไม่มีใครเห็น (กันข้อมูลรั่ว เหมือนยาป้องกัน/ยาพิษของแม่มด)
                const showSilenced = p.silenced && p.alive && !roomData.isNight;
                // นักเล่นกล 🔥 ฆ่าใครที่ปลอมบทไว้ (illusionDeathReveal) → คนนั้นเปิดเผยต่อสาธารณะเป็น
                // "นักเล่นกล" แทนบทจริงเสมอ (คนอื่นเท่านั้น — ตัวเราเองยังเห็นบทจริงของตัวเองปกติ)
                const roleLabel = p.id === me ? myRole : (p.illusionDeathReveal ? "นักเล่นกล" : p.role);
                // ไอคอนอาชีพอยู่มุมล่างขวาเสมอ ไม่มีการเลื่อนหนีอีกต่อไป — ถ้ามีสถานะอื่น (เช่นถูกใบ้)
                // ต้องโผล่มุมเดียวกัน ให้สถานะอื่นนั้นเลื่อนไปทางซ้ายแทน (ตรงข้ามกับพฤติกรรมเดิม)
                const roleHtml = showRole
                    ? `<div class="player-role-icon" title="${roleLabel}">${getRoleIcon(roleLabel)}</div>`
                    : "";
                // ใช้ตัวช่วยกลางเดียวกับ badge อื่นๆ ทั้งหมดที่มุมนี้ — ถ้ามี badge อื่น (เช่นคู่รัก/ลัทธิ) โผล่ไปก่อนแล้ว
                // ไอคอนถูกใบ้จะขยับซ้ายเพิ่มต่อจากมันโดยอัตโนมัติ ไม่ใช่แค่หลบไอคอนอาชีพเหมือนเดิม
                const silencedShift = showSilenced ? claimBottomRightBadgeSlot(showRole) : "";
                const silencedHtml = showSilenced
                    ? `<div class="player-silenced-icon" style="${silencedShift}" title="ถูกใบ้"><img src="${wwImg("/images/silenced.jpg")}" alt="🤐"></div>`
                    : "";
                return roleHtml + silencedHtml;
            })()}
            ${modeExtraHtml}
        `;
        // อัปเดตเนื้อหาเฉพาะตอนที่เปลี่ยนจริงๆ เพื่อไม่ให้รูปไอคอนต้องสร้าง/โหลดใหม่ทุกครั้ง
        if (div.innerHTML !== newInnerHTML) {
            div.innerHTML = newInnerHTML;
        }

        // จัดลำดับให้ตรงกับลำดับผู้เล่นจริง (เผื่อมีคนเข้าร่วมห้องเพิ่มระหว่างทาง)
        if (players.children[idx] !== div) {
            players.insertBefore(div, players.children[idx] || null);
        }
    });

    // ลบกล่องของผู้เล่นที่ไม่อยู่ในห้องแล้ว (หลุดห้อง/ตัดการเชื่อมต่อ)
    Object.keys(existingNodes).forEach((pid) => {
        if (!seenIds.has(pid)) {
            existingNodes[pid].remove();
        }
    });

    filterPlayerList();

    return mode;
}

// อัปเดตหัวข้อการ์ดผู้เล่น (ตรงคำว่า "ผู้เล่นในห้อง" เดิม) ให้กลายเป็นป้ายบอกช่วง/โหมดปัจจุบันแทน
// (เดิมแยกเป็นแบนเนอร์ต่างหากเหนือกริด แต่แบนเนอร์โผล่/หายทำให้กริดผู้เล่นขยับขึ้นลง เปลืองพื้นที่จอ
// ย้ายมาไว้ที่หัวข้อซึ่งอยู่คงที่ตลอดแทน ส่วนรายละเอียดเสริม (จำนวนโหวต/นับถอยหลัง) ใช้ #playersSub
// ซึ่งก็อยู่คงที่เช่นกัน ไม่ทำให้ผังหน้าขยับ)
function updateModeBanner(mode, ctx) {
    const icon = document.getElementById("phaseIcon");
    const text = document.getElementById("phaseText");
    const thresholdText = document.getElementById("playersSubThreshold");
    if (!text) return;

    const roomData = ctx.roomData;

    thresholdText.textContent = "";
    if (mode !== "vote") stopVoteCountdown();
    text.style.color = "";

    if (mode === "normal") {
        if (!roomData.started) {
            icon.textContent = "🕓";
            text.textContent = "รอเกมเริ่ม";
        } else if (roomData.gameOver) {
            icon.textContent = "🏁";
            text.textContent = "จบเกมแล้ว";
        } else if (roomData.isNight) {
            icon.textContent = "🌙";
            text.textContent = roomData.nightCount ? `ช่วงกลางคืน (คืนที่ ${roomData.nightCount})` : "ช่วงกลางคืน";
        } else {
            icon.textContent = "☀️";
            text.textContent = roomData.dayCount ? `ช่วงเช้า (วันที่ ${roomData.dayCount})` : "ช่วงเช้า";
        }
        return;
    }

    if (mode === "vote") {
        if (shieldModeActive) {
            icon.textContent = "🛡️";
            text.textContent = "โหมดวางโล่";
            text.style.color = "#38bdf8";
        } else if (wolfCubModeActive) {
            icon.textContent = "🐾";
            text.textContent = "โหมดเลือกเป้าลาก";
            text.style.color = "#f97316";
        } else if (loudmouthModeActive) {
            icon.textContent = "👄";
            text.textContent = "โหมดเลือกเป้าแฉบท";
            text.style.color = "#ec4899";
        } else {
            icon.textContent = "🗳️";
            text.textContent = "ช่วงโหวต";
            text.style.color = "var(--safe)";
        }

        // จำนวนโหวตที่ต้องการ + เวลานับถอยหลังของรอบโหวต — โชว์ทั้งในโหมดโหวตปกติและระหว่างวางโล่ (รอบเดียวกัน)
        thresholdText.textContent = ctx.aliveVotersCount > 0
            ? `ต้องการ ${ctx.voteThreshold} โหวต (จากผู้มีชีวิต ${ctx.aliveVotersCount} คน)`
            : "";
        if (roomData.voteDeadline) {
            startVoteCountdown(roomData.voteDeadline);
        } else {
            stopVoteCountdown();
        }
    } else if (mode === "shield") {
        icon.textContent = "🛡️";
        text.textContent = "โหมดวางโล่";
        text.style.color = "#38bdf8";
    } else if (mode === "wolfcub") {
        icon.textContent = "🐾";
        text.textContent = "โหมดเลือกเป้าลาก";
        text.style.color = "#f97316";
    } else if (mode === "loudmouth") {
        icon.textContent = "👄";
        text.textContent = "โหมดเลือกเป้าแฉบท";
        text.style.color = "#ec4899";
    } else if (mode === "kill") {
        const isMurdererMode = myRole === "ฆาตกรต่อเนื่อง";
        const isWolfSeerMode = myRole === "หมาป่าหยั่งรู้";
        const isInstigatorMode = myRole === "ผู้ยุยง";
        icon.textContent = isMurdererMode ? "🗡️" : isWolfSeerMode ? "🔮" : isInstigatorMode ? "🎭" : "🐺";
        text.textContent = isMurdererMode ? "ช่วงฆาตกรต่อเนื่องออกล่า" : isWolfSeerMode ? "โหมดหมาหยั่งส่อง" : isInstigatorMode ? "โหมดผู้ยุยงลงมือฆ่าเอง" : "โหมดหมาป่าเลือกเหยื่อ";
        text.style.color = isMurdererMode ? "#a78bfa" : isWolfSeerMode ? "#c084fc" : isInstigatorMode ? "#f472b6" : "var(--wolf)";

        // หมายเหตุ: ปุ่ม "สละลางสังหรณ์" ย้ายไปอยู่ที่ #oracleBtn ในแถบล่างแล้ว (ดูการซิงค์สถานะที่ role === "หมาป่าหยั่งรู้"
        // ในตัวจัดการ room_update) หัวข้อตรงนี้เลยเหลือแค่บอกชื่อช่วงเวลาเฉยๆ ไม่มีปุ่มฝังอีกต่อไป
    } else if (mode === "sheriff") {
        icon.textContent = "🔫";
        text.textContent = "โหมดยิง";
        text.style.color = "#f87171";
    } else if (mode === "peek") {
        icon.textContent = "📣";
        text.textContent = "โหมดเปิดดูบท";
        text.style.color = "#facc15";
    } else if (mode === "holywater") {
        icon.textContent = "🫙";
        text.textContent = "โหมดปาน้ำมนต์";
        text.style.color = "#38bdf8";
    } else if (mode === "poison") {
        icon.textContent = "☠️";
        text.textContent = "โหมดโยนยาพิษ";
        text.style.color = "#a855f7";
    } else if (mode === "protect") {
        icon.textContent = "🧪";
        text.textContent = "โหมดเลือกยาป้องกัน";
        text.style.color = "#22c55e";
    } else if (mode === "curse") {
        icon.textContent = "🪄";
        text.textContent = "โหมดร่ายเวท";
        text.style.color = "#a855f7";
    } else if (mode === "cultrecruit") {
        icon.textContent = "🔯";
        text.textContent = "โหมดชักชวนเข้าลัทธิ";
        text.style.color = "#eab308";
    } else if (mode === "cultsacrifice") {
        icon.textContent = "🕯️";
        text.textContent = cultSacrificePendingMemberId
            ? "เลือกสมาชิกแล้ว — แตะเป้าที่จะฆ่า"
            : "โหมดสังเวย — แตะสมาชิกลัทธิของคุณก่อน";
        text.style.color = "#eab308";
    }
}

// ===== IN-GAME HUD SYNC =====
// The legacy phase nodes remain the single source of truth for gameplay text. This function mirrors
// them into the compact beach HUD without duplicating mode logic, keeping the visual layer purely presentational.
function syncGameHud(roomData, mode) {
    roomData = roomData || {};
    const players = Array.isArray(roomData.players) ? roomData.players : [];
    const nonHostPlayers = players.filter((p) => !p.isHost);
    const total = nonHostPlayers.length;
    const alive = nonHostPlayers.filter((p) => p.alive).length;

    const phaseIcon = document.getElementById("phaseIcon");
    const phaseText = document.getElementById("phaseText");
    const hudIcon = document.getElementById("gameHudPhaseIcon");
    const hudText = document.getElementById("gameHudPhaseText");
    const hudSub = document.getElementById("gameHudPhaseSub");
    const hudRoom = document.getElementById("gameHudRoom");
    const hudPeople = document.getElementById("gameHudPeople");
    const countLabel = document.getElementById("playerCountLabel");
    const aliveLabel = document.getElementById("aliveCountLabel");

    if (hudIcon) hudIcon.textContent = (phaseIcon && phaseIcon.textContent.trim()) || "⌛";
    if (hudText) hudText.textContent = (phaseText && phaseText.textContent.trim()) || (roomData.started ? "เกมกำลังดำเนินอยู่" : "รอเกมเริ่ม");

    let sub = "";
    if (!roomData.started) sub = "รอผู้เล่าเรื่องเริ่มเกม";
    else if (roomData.gameOver) sub = "ดูสรุปผลและเตรียมรอบถัดไป";
    else if (mode === "vote") sub = "แตะการ์ดผู้เล่นเพื่อโหวต";
    else if (mode && mode !== "normal") sub = "แตะการ์ดผู้เล่นเพื่อใช้ความสามารถ";
    else if (roomData.isNight) sub = "กลางคืน — ทำความสามารถของบทคุณ";
    else sub = "กลางวัน — พูดคุยและสังเกตผู้เล่น";
    if (hudSub) hudSub.textContent = sub;

    const roomCode = String(currentRoomId || roomData.roomId || "").trim().toUpperCase();
    if (hudRoom) hudRoom.textContent = roomCode || "—";
    if (hudPeople) hudPeople.textContent = `${alive}/${total}`;
    if (countLabel) countLabel.textContent = `${total} ผู้เล่น`;
    if (aliveLabel) aliveLabel.textContent = `มีชีวิต ${alive} คน`;

    updateChatUnreadTotal();
}

// ROOM UPDATE
socket.on("room_update", (roomData) => {

    lastRoomData = roomData; // เก็บไว้ให้ your_role re-render กริดได้

    // FALLBACK กันบั๊ก "ack ของ join_room หายไประหว่างทาง" — ถ้าเรามี join ค้างอยู่
    // (pendingJoinRoomId) และห้องนี้มีตัวเราอยู่ในรายชื่อผู้เล่นแล้วจริง (เทียบจาก token
    // เพราะ id เป็น socket.id ที่เปลี่ยนได้ทุกครั้งที่ต่อใหม่) ให้ถือว่าเข้าห้องสำเร็จแล้วทันที
    // โดยไม่ต้องรอ ack ที่อาจไม่มีวันมาถึงอีกเลย (server ประมวลผล join ไปแล้วจริง แค่ ack
    // หลุดหายไปกับ connection เก่าตอนเน็ตสะดุดพอดี)
    if (!joined && pendingJoinRoomId && Array.isArray(roomData.players)
        && roomData.players.some((p) => p.token === clientToken)) {
        finalizeJoin(pendingJoinRoomId);
    }

    // สลับ card เมื่อเกมเริ่ม
    if (roomData.started) {
        document.getElementById("joinCard").classList.add("hidden");
        document.querySelector('.app').classList.add("game-visible");
        document.querySelector('.app').classList.add("game-started");
        document.getElementById("playersCard").classList.remove("hidden");
        document.getElementById("chatCard").classList.remove("hidden");
        document.getElementById("rolesPanelCard").classList.remove("hidden");
        document.getElementById("bottomBar").classList.remove("hidden");
        document.getElementById("bottomBar").classList.add("bar-visible");
        // parent flex layout เพิ่งถูกเปิด: scheduleFitPlayerGrid() จะคำนวณหลัง DOM/layout commit และตรวจ box จริง
        scheduleFitPlayerGrid(true);
    } else if (!joined) {
        // ยังไม่ได้ join → แสดง joinCard ตามปกติ
        document.getElementById("joinCard").classList.remove("hidden");
        document.querySelector('.app').classList.remove("game-visible");
        document.querySelector('.app').classList.remove("game-started");
        document.getElementById("bottomBar").classList.remove("bar-visible");
    } else {
        // เข้าห้องอยู่แล้วแต่ started กลายเป็น false (โฮสต์กด "🔄 เริ่มต้นใหม่" ระหว่างที่เรายังอยู่ในห้อง)
        // → เคลียร์บทเก่าทิ้ง กลับไปโหมด "รอโฮสต์เริ่มเกมรอบใหม่" โดยไม่เด้งออกจากห้อง
        document.querySelector('.app').classList.remove("game-started");
        myRole = "";
        myHuntTargetId = null;
        document.getElementById("bottomBar").classList.remove("bar-visible");
        document.getElementById("barRoleName").textContent = "ยังไม่ได้รับบท";
        document.getElementById("barRoleSub").textContent = "รอโฮสต์เริ่มเกมรอบใหม่";
        document.getElementById("barHuntBadge")?.classList.add("hidden");
        document.getElementById("barIllusionBadge")?.classList.add("hidden");
    }

    // อัปเดตลิสต์ "บทในเกมรอบนี้" ทุกครั้งที่ห้องมีการเปลี่ยนแปลง
    // ไม่ต้องรอให้เกมเริ่ม เพื่อให้เห็นจำนวนอาชีพที่โฮสต์เพิ่ม/ลดแบบเรียลไทม์ตั้งแต่ตอนรอในห้อง
    showGameInfo(roomData);

    // ถ้าเพิ่งเริ่มเกมใหม่ (justStarted) หรือโฮสต์เพิ่งกด "🔄 เริ่มต้นใหม่" (justReset) → ล้างแชทเก่าทิ้ง
    // ทั้งสองธงนี้เซิร์ฟเวอร์จะติดไว้ "แค่รอบ room_update เดียว" ที่ส่งมาพร้อมกับตอนที่เกิดเหตุการณ์จริงๆ
    // เท่านั้น (ดู start_game/restart_room ฝั่ง server.js) เพื่อให้จอที่เปิดค้างอยู่ตอนนี้ (ไม่ต้องรอ
    // reconnect/request_sync รอบถัดไป) เคลียร์กล่องแชทของ "เกมที่แล้ว" ทิ้งทันที ไม่ให้ข้อความเก่าค้างโชว์ปน
    // กับเกมใหม่ — แก้บั๊ก: เดิม justReset ไม่มี ทำให้กด "เริ่มต้นใหม่" แล้วข้อความเกมก่อนหน้ายังค้างอยู่ในกล่อง
    // แชทของทุกจอที่เปิดทิ้งไว้ตอนนั้น (แม้ฝั่งเซิร์ฟเวอร์จะล้างข้อมูลไปแล้วก็ตาม)
    if ((roomData.started && roomData.justStarted) || roomData.justReset) {
        document.getElementById("chatBoxGlobal").innerHTML = "";
        document.getElementById("chatBoxWolf").innerHTML = "";
        document.getElementById("chatBoxInstigator").innerHTML = "";
        document.getElementById("chatBoxCult").innerHTML = "";
        document.getElementById("chatBoxBandit").innerHTML = "";
        myHuntTargetId = null;
        openRoleDescKeys = new Set();
        // reset unread badges
        playerBadgeCounts = { global: 0, wolf: 0, instigator: 0, cult: 0, bandit: 0 };
        document.getElementById("badgeGlobal").textContent = "0";
        document.getElementById("badgeGlobal").classList.add("zero");
        document.getElementById("badgeWolf").textContent = "0";
        document.getElementById("badgeWolf").classList.add("zero");
        document.getElementById("badgeInstigator").textContent = "0";
        document.getElementById("badgeInstigator").classList.add("zero");
        document.getElementById("badgeCult").textContent = "0";
        document.getElementById("badgeCult").classList.add("zero");
        document.getElementById("badgeBandit").textContent = "0";
        document.getElementById("badgeBandit").classList.add("zero");
        updateChatUnreadTotal();
    }

    const me = socket.id;

    // อัพเดทสถานะมีชีวิตของตัวเอง
    const myPlayer = roomData.players.find(p => p.id === me);

    // โหมดผู้ทดสอบ: sync ว่าจอนี้กำลังเข้าสิงบอทอยู่จริงไหม (ใช้เช็คใน dblclick listener ของ #players
    // ด้านบนที่คืนความเป็นบอท) เช็คทุกครั้งที่ room_update มา เพราะ myPlayer.id เปลี่ยนได้ตลอด แต่ isBot ไม่เคยเปลี่ยน
    myIsBot = !!(TESTER_MODE && myPlayer && myPlayer.isBot);

    if (myPlayer) {
        myAlive = myPlayer.alive;
        mySilenced = !!myPlayer.silenced;

        // ซิงค์จำนวนโล่ที่เหลือของหมาป่าผู้พิทักษ์/หนูน้อยผู้ใสซื่อ (ลดลงเมื่อใช้สำเร็จ)
        if (GUARDIAN_ROLES.has(myPlayer.role)) {
            const shieldBtn = document.getElementById("shieldBtn");
            const shieldIconEl = document.getElementById("shieldIcon");
            if (shieldIconEl) shieldIconEl.innerHTML = getGuardianShieldHTML(myPlayer.role);
            const available = myPlayer.guardianShieldAvailable ?? 0;
            document.getElementById("shieldCount").textContent = available;
            shieldBtn.classList.remove("hidden");
            const depleted = !(available > 0) || !myAlive || !!roomData.isNight;
            shieldBtn.classList.toggle("depleted", depleted);
            if (depleted && shieldModeActive) {
                shieldModeActive = false;
                shieldBtn.classList.remove("active");
            }
        }

        // ซิงค์ปุ่มลากตาย 🐾 ของลูกหมาป่า — ใช้ได้ตลอดเวลาไม่จำกัดจำนวน depleted แค่ตอนตายแล้วเท่านั้น
        // (ไม่เช็ค roomData.isNight เหมือนบทบาทอื่น เพราะลูกหมาป่าจองเป้าได้ทั้งวันทั้งคืน)
        if (myPlayer.role === "ลูกหมาป่า") {
            const pawBtn = document.getElementById("pawBtn");
            if (pawBtn) {
                pawBtn.classList.remove("hidden");
                const pawDepleted = !myAlive;
                pawBtn.classList.toggle("depleted", pawDepleted);
                if (pawDepleted && wolfCubModeActive) {
                    wolfCubModeActive = false;
                    pawBtn.classList.remove("active");
                }
            }
        }

        // ซิงค์ปุ่มเลือกเป้า 👄 ของเด็กขี้โวยวาย — ใช้ได้ตลอดเวลาไม่จำกัดจำนวน depleted ตอนตายแล้ว
        // หรือระหว่างกำลังอยู่ในคืนแรกของเกมจริงๆ เท่านั้น (server เมินคำสั่งช่วงนี้อยู่แล้ว แต่ปิดปุ่มไว้กันงงฝั่ง UI ด้วย)
        // แก้บั๊ก: เดิมเช็คแค่ nightCount<=1 เฉยๆ โดยไม่ดู isNight เลย ทำให้ nightCount ที่ยังค้างอยู่ที่ 1
        // ตลอดทั้ง "วันแรก" (หลังคืนแรกจบ ก่อนคืนที่สองเริ่ม) ไปปิดปุ่มทั้งวันแรกไปด้วยทั้งที่ควรกดได้แล้ว
        if (myPlayer.role === "เด็กขี้โวยวาย") {
            const mouthBtn = document.getElementById("mouthBtn");
            if (mouthBtn) {
                mouthBtn.classList.remove("hidden");
                const mouthDepleted = !myAlive || (!!roomData.isNight && (roomData.nightCount || 0) <= 1);
                mouthBtn.classList.toggle("depleted", mouthDepleted);
                if (mouthDepleted && loudmouthModeActive) {
                    loudmouthModeActive = false;
                    mouthBtn.classList.remove("active");
                }
            }
        }

        // ซิงค์จำนวนกระสุนที่เหลือของศาลเตี้ย (ลดลงเมื่อยิงสำเร็จ) — ใช้ได้เฉพาะตอนกลางวัน
        // และ "ดูบทบาท" (ลดลงเมื่อดูสำเร็จ) — ใช้ได้ทีละอย่างต่อวัน (sheriffUsedToday ล็อกทั้งคู่ร่วมกัน)
        if (myPlayer.role === "ศาลเตี้ย") {
            const usedToday = !!myPlayer.sheriffUsedToday;

            const gunBtn = document.getElementById("gunBtn");
            const bulletsLeft = myPlayer.sheriffBullets ?? 0;
            document.getElementById("gunCount").textContent = bulletsLeft;
            gunBtn.classList.remove("hidden");
            const gunDepleted = !(bulletsLeft > 0) || !myAlive || !!roomData.isNight || usedToday;
            gunBtn.classList.toggle("depleted", gunDepleted);
            if (gunDepleted && gunModeActive) {
                gunModeActive = false;
                gunBtn.classList.remove("active");
            }

            const peekBtn = document.getElementById("peekBtn");
            const peeksLeft = myPlayer.sheriffPeeks ?? 0;
            document.getElementById("peekCount").textContent = peeksLeft;
            peekBtn.classList.remove("hidden");
            const peekDepleted = !(peeksLeft > 0) || !myAlive || !!roomData.isNight || usedToday;
            peekBtn.classList.toggle("depleted", peekDepleted);
            if (peekDepleted && peekModeActive) {
                peekModeActive = false;
                peekBtn.classList.remove("active");
            }
        }

        // ซิงค์ปุ่ม 🔥 ฆ่าผู้เล่นที่ปลอมบทไว้ของนักเล่นกล (ใช้ได้เฉพาะตอนกลางวัน — นับจาก illusionTargetIds
        // ที่ยังมีชีวิตอยู่จริงตอนนี้เท่านั้น คนที่ตายไปแล้วด้วยสาเหตุอื่นจะไม่ถูกนับ)
        // เพิ่ม barIllusionBadge แสดง "รายชื่อ" คนที่ปลอมบทไว้ (ไม่ใช่แค่ตัวเลข) ให้เห็นตลอด ทั้งกลางวัน/กลางคืน
        // ตามที่ผู้ใช้แจ้งว่าเดิมไม่เห็นว่าตัวเองเลือกใครไปแล้วบ้างพอถึงเช้า
        if (myPlayer.role === "นักเล่นกล") {
            const illusionKillBtn = document.getElementById("illusionKillBtn");
            const disguisedIds = Array.isArray(myPlayer.illusionTargetIds) ? myPlayer.illusionTargetIds : [];
            const aliveDisguisedPlayers = disguisedIds
                .map((tid) => roomData.players.find((p) => p.id === tid))
                .filter((p) => p && p.alive);
            const aliveDisguisedCount = aliveDisguisedPlayers.length;

            const illusionBadge = document.getElementById("barIllusionBadge");
            if (illusionBadge) {
                if (aliveDisguisedCount > 0) {
                    illusionBadge.textContent = `🎭 ปลอมบทไว้: ${aliveDisguisedPlayers.map((p) => p.name).join(", ")}`;
                    illusionBadge.title = illusionBadge.textContent;
                    illusionBadge.classList.remove("hidden");
                } else {
                    illusionBadge.classList.add("hidden");
                }
            }

            if (illusionKillBtn) {
                const illusionCountEl = document.getElementById("illusionKillCount");
                if (illusionCountEl) illusionCountEl.textContent = aliveDisguisedCount;
                illusionKillBtn.classList.remove("hidden");
                // หมายเหตุ: ตั้งใจไม่ใส่ pointer-events:none ตอน depleted (ต่างจากปุ่มอื่น) — กันเคส
                // ข้อมูลฝั่ง client คลาดเคลื่อนชั่วขณะ (เช่น room_update มาไม่ทัน) แล้วบล็อกการกดทั้งที่
                // ฝั่งเซิร์ฟเวอร์มีเป้าให้ฆ่าจริงอยู่ — ให้กดได้เสมอ ปล่อยให้เซิร์ฟเวอร์ (performIllusionKillDisguised)
                // เป็นคนตัดสินใจจริงว่าจะฆ่าได้หรือไม่ (no-op เงียบๆ ถ้าเงื่อนไขไม่ผ่านจริง)
                illusionKillBtn.classList.toggle("depleted", !(aliveDisguisedCount > 0) || !myAlive || !!roomData.isNight || !!roomData.voteMode);
            }
        }

        // ซิงค์จำนวนขวดน้ำมนต์ที่เหลือของนักบวช (ขวดเดียวตลอดเกม ใช้ได้เฉพาะตอนกลางวัน)
        if (myPlayer.role === "นักบวช") {
            const holyWaterBtn = document.getElementById("holyWaterBtn");
            const holyWaterLeft = myPlayer.priestHolyWaterPotions ?? 0;
            document.getElementById("holyWaterCount").textContent = holyWaterLeft;
            holyWaterBtn.classList.remove("hidden");
            const holyWaterDepleted = !(holyWaterLeft > 0) || !myAlive || !!roomData.isNight;
            holyWaterBtn.classList.toggle("depleted", holyWaterDepleted);
            if (holyWaterDepleted && holyWaterModeActive) {
                holyWaterModeActive = false;
                holyWaterBtn.classList.remove("active");
            }
        }

        // ซิงค์จำนวนขวดยาพิษที่เหลือของแม่มด (มีขวดเดียวตลอดเกม ใช้ได้เฉพาะตอนกลางคืน ห้ามใช้คืนแรก
        // ตามคำขอผู้ใช้ — ดู performWitchPoison/performSelectTarget ฝั่งเซิร์ฟเวอร์)
        if (myPlayer.role === "แม่มด") {
            const isFirstNight = (roomData.nightCount || 0) <= 1;
            const poisonBtn = document.getElementById("poisonBtn");
            const poisonLeft = myPlayer.witchPoisonPotions ?? 0;
            document.getElementById("poisonCount").textContent = poisonLeft;
            poisonBtn.classList.remove("hidden");
            const poisonDepleted = !(poisonLeft > 0) || !myAlive || !roomData.isNight || isFirstNight;
            poisonBtn.classList.toggle("depleted", poisonDepleted);
            if (poisonDepleted && poisonModeActive) {
                poisonModeActive = false;
                poisonBtn.classList.remove("active");
            }

            // ซิงค์จำนวนขวดยาป้องกันที่เหลือของแม่มด (มีขวดเดียวตลอดเกม เสียก็ต่อเมื่อเคยกันการโจมตีสำเร็จ
            // ใช้ได้เฉพาะตอนกลางคืน — ใช้ได้ตั้งแต่คืนแรกเลย ต่างจากยาพิษด้านบน ตามคำขอผู้ใช้)
            const protectBtn = document.getElementById("protectBtn");
            const protectLeft = myPlayer.witchProtectPotions ?? 0;
            document.getElementById("protectCount").textContent = protectLeft;
            protectBtn.classList.remove("hidden");
            const protectDepleted = !(protectLeft > 0) || !myAlive || !roomData.isNight;
            protectBtn.classList.toggle("depleted", protectDepleted);
            if (protectDepleted && protectModeActive) {
                protectModeActive = false;
                protectBtn.classList.remove("active");
            }
        }

        // นักสืบ: ล้างค่า "คนแรกที่แตะเลือกไว้" ทิ้ง ถ้าส่องไปแล้วคืนนี้ หรือพ้นช่วงกลางคืนไปแล้ว
        // (กันค้างข้ามรอบ เช่นเลือกคนแรกไว้แล้วโฮสต์ปิดคืน/เข้าเช้าก่อนจะแตะคนที่สอง)
        if (myPlayer.role === "นักสืบ" && (myPlayer.detectiveScoutedThisNight || !roomData.isNight)) {
            detectivePendingFirstId = null;
            detectivePendingSecondId = null;
        }

        // กามเทพ: ล้างค่า "คนแรกที่แตะเลือกไว้" ทิ้ง ถ้าจับคู่ไปแล้ว (ตลอดเกม) หรือพ้นช่วงกลางคืนไปแล้ว
        // (กันค้างข้ามรอบ โครงเดียวกับนักสืบ)
        if (myPlayer.role === "กามเทพ" && (myPlayer.cupidPaired || !roomData.isNight)) {
            cupidPendingFirstId = null;
            cupidPendingSecondId = null;
        }

        // ผู้ยุยง: ล้างค่า "คนแรกที่แตะเลือกไว้" ทิ้ง ถ้าจับคู่ไปแล้ว (ตลอดเกม) หรือพ้นช่วงกลางคืนไปแล้ว
        // (กันค้างข้ามรอบ ทำงานแบบเดียวกับกามเทพเป๊ะๆ)
        if (myPlayer.role === "ผู้ยุยง" && (myPlayer.instigatorPaired || !roomData.isNight)) {
            instigatorPendingFirstId = null;
            instigatorPendingSecondId = null;
        }

        // ยายขี้โมโหไม่มีปุ่มเข้าโหมดใบ้แยกแล้ว — แตะการ์ดเป้าตรงๆ ได้เลยเหมือนหมอ/บอดี้การ์ด จึงไม่ต้องซิงค์ปุ่มนี้อีก

        // หมาป่าหยั่งรู้: ปุ่ม "สละลางสังหรณ์" — เป็นการกระทำครั้งเดียวจบ (กด confirmGiveUpOracleSense())
        // กดได้ทั้งวันทั้งคืน (ไม่ได้จำกัดแค่กลางคืนเหมือนสกิลอื่น) เพราะเป็นการสละพลังล้วน ๆ ไม่ใช่การกระทำต่อเป้าหมาย
        // ต่างจากบทบาทอื่นในบาร์ตรงที่บทนี้ "เปลี่ยนบท" ไปเป็นหมาป่าธรรมดาได้เมื่อกดสำเร็จ (ดู transformOracleWolfToNormal ฝั่งเซิร์ฟเวอร์)
        // เลยต้องซ่อนปุ่มกลับ (else) ทันทีที่ role ไม่ตรงแล้ว ไม่งั้นปุ่มจะค้างโชว์อยู่หลังกลายร่างไปแล้ว
        // (ซ่อนทันทีจริง ๆ เกิดขึ้นที่ตัวจัดการ "your_role" ด้านบนแล้ว ตรงนี้แค่ซิงค์ตามหลัง)
        const oracleBtn = document.getElementById("oracleBtn");
        if (oracleBtn) {
            if (myPlayer.role === "หมาป่าหยั่งรู้") {
                oracleBtn.classList.remove("hidden");
                oracleBtn.classList.toggle("depleted", !myAlive);
            } else {
                oracleBtn.classList.add("hidden");
            }
        }

        // นายก: ปุ่ม 🤠 "เปิดเผยตัว" — เป็นการกระทำครั้งเดียวจบเหมือนปุ่มสละลางสังหรณ์
        // กดได้ทั้งวันทั้งคืน (ยกเว้นคืนแรกของเกม — ตามคำขอผู้ใช้) depleted เมื่อตายแล้ว หรือใช้สิทธิ์ไปแล้ว
        // (mayorRevealed / ไม่มี mayorAvailable เหลือ) หรือกำลังอยู่ในคืนแรก (เหมือนฝั่งเซิร์ฟเวอร์
        // reveal_mayor — เช็ค isNight ควบคู่ nightCount<=1 กันไม่ให้ "วันแรก" หลังคืนแรกจบไปโดนบล็อกด้วย)
        const mayorBtn = document.getElementById("mayorBtn");
        if (mayorBtn) {
            if (myPlayer.role === "นายก") {
                mayorBtn.classList.remove("hidden");
                const mayorFirstNight = !!roomData.isNight && (roomData.nightCount || 0) <= 1;
                const mayorDepleted = !myAlive || !!myPlayer.mayorRevealed || !(myPlayer.mayorAvailable > 0) || mayorFirstNight;
                mayorBtn.classList.toggle("depleted", mayorDepleted);
            } else {
                mayorBtn.classList.add("hidden");
            }
        }

        // หมาป่านักเวท: ใช้ได้เฉพาะตอนกลางวัน — ปิดโหมดร่ายเวทอัตโนมัติถ้าเข้าสู่กลางคืนแล้ว
        if (myPlayer.role === "หมาป่านักเวท") {
            const curseBtn = document.getElementById("curseBtn");
            const curseTargets = roomData.curseTargets || {};
            const myCurseTarget = curseTargets[me];
            const curseDot = document.getElementById("curseDot");
            if (curseDot) curseDot.classList.toggle("show", !!myCurseTarget);
            if (curseBtn) {
                curseBtn.classList.toggle("depleted", !myAlive || !!roomData.isNight);
                if ((!myAlive || roomData.isNight) && curseModeActive) {
                    curseModeActive = false;
                    curseBtn.classList.remove("active");
                }
            }
        }

        // ผู้นำลัทธิ: ใช้ได้เฉพาะตอนกลางคืน (ตรงข้ามกับหมาป่านักเวท) — ปิดโหมดอัตโนมัติถ้าเข้าสู่กลางวันแล้ว
        if (myPlayer.role === "ผู้นำลัทธิ") {
            const cultRecruitBtn = document.getElementById("cultRecruitBtn");
            const cultSacrificeBtn = document.getElementById("cultSacrificeBtn");
            const cultDepleted = !myAlive || !roomData.isNight;
            if (cultRecruitBtn) {
                cultRecruitBtn.classList.toggle("depleted", cultDepleted);
                if (cultDepleted && cultRecruitModeActive) {
                    cultRecruitModeActive = false;
                    cultRecruitBtn.classList.remove("active");
                }
            }
            if (cultSacrificeBtn) {
                // สังเวยต้องมี "สมาชิกลัทธิที่ยังมีชีวิตอยู่" อย่างน้อย 1 คนให้เลือกก่อน — ไม่งั้นกดเข้าโหมด
                // ไปก็ไม่มีใครให้แตะเลือกเป็นคนที่ 1 อยู่ดี ปุ่มควรจางเหมือนปุ่มอื่นๆ ที่ "หมดสิทธิ์ใช้" แล้ว
                const aliveCultMemberCount = roomData.players.filter(
                    (p) => p.alive && !p.isHost && p.cultLeaderId === me
                ).length;
                const cultSacrificeDepleted = cultDepleted || aliveCultMemberCount === 0;
                cultSacrificeBtn.classList.toggle("depleted", cultSacrificeDepleted);
                if (cultSacrificeDepleted && cultSacrificeModeActive) {
                    cultSacrificeModeActive = false;
                    cultSacrificePendingMemberId = null;
                    cultSacrificeBtn.classList.remove("active");
                }
            }
        }

        // (ไม่มีปุ่มโหมดสำหรับโจร/ผู้สมรู้ร่วมคิดแล้ว — ไม่ต้องซิงค์สถานะ depleted ของปุ่มอีกต่อไป)
    }


    // อัปเดตสถานะกลางคืน
    isNight = !!roomData.isNight;

    // ฉากกลางวัน/กลางคืน + ป้ายบอกสถานะ จะโชว์ก็ต่อเมื่อเกมเริ่มแล้ว, ยังไม่จบ,
    // และผ่านการกด "เริ่มช่วงกลางคืน" มาแล้วอย่างน้อยครั้งนึง (กันไม่ให้ตอนรอเริ่มเกม/เพิ่งกดเริ่มเกม
    // ขึ้นเป็น "วันที่ 1" ทั้งที่ยังไม่เคยผ่านคืนที่ 1 มาก่อน)
    const dayNightCycleStarted = (roomData.nightCount || 0) > 0 || (roomData.dayCount || 0) > 0;
    const showDayNight = !!roomData.started && !roomData.gameOver && dayNightCycleStarted;

    // อัปเดตฉากพื้นหลังกลางวัน/กลางคืน + ป้ายบอกสถานะ (ลอยมุมขวาบน)
    document.body.classList.toggle("is-night", showDayNight && isNight);
    document.body.classList.toggle("is-day", showDayNight && !isNight);
    const dnBadge = document.getElementById("dayNightBadge");
    const dnIcon = document.getElementById("dnIcon");
    const dnText = document.getElementById("dnText");
    if (dnBadge) {
        dnBadge.classList.toggle("hidden", !showDayNight);
        if (showDayNight && dnIcon && dnText) {
            dnIcon.textContent = isNight ? "🌙" : "☀️";
            dnText.textContent = isNight
                ? `คืนที่ ${roomData.nightCount || 1}`
                : `วันที่ ${roomData.dayCount || 1}`;
        }
    }

    // อัปเดต UI โดนใบ้ + กลางคืน
    const silencedNotice = document.getElementById("silencedNotice");
    const nightNotice = document.getElementById("nightNotice");
    const chatInputEl = document.getElementById("chatInput");
    const chatSendBtn = document.querySelector(".sendBtn");
    if (silencedNotice) {
        if (mySilenced) {
            silencedNotice.classList.add("visible");
            if (chatInputEl) { chatInputEl.disabled = true; chatInputEl.placeholder = "🤐 ถูกใบ้ — พิมพ์ไม่ได้"; }
            if (chatSendBtn) { chatSendBtn.disabled = true; chatSendBtn.textContent = "🤐"; }
        } else {
            silencedNotice.classList.remove("visible");
            if (chatInputEl) {
                chatInputEl.disabled = false;
                chatInputEl.placeholder = isNight ? "พิมพ์ข้อความ... (ส่งไม่ได้ช่วงกลางคืน)" : "พิมพ์ข้อความ...";
            }
            if (chatSendBtn) { chatSendBtn.disabled = false; chatSendBtn.textContent = "ส่ง"; }
        }
    }
    updateChatInputAvailability(); // เช็คซ้ำเรื่องแท็บแชททีมโจร (ผู้สมรู้ร่วมคิดพิมพ์ไม่ได้) ทับสถานะโดนใบ้ด้านบนอีกที
    // แสดง/ซ่อน notice กลางคืน
    if (nightNotice) {
        if (isNight && currentChatTab === "global") {
            nightNotice.classList.add("visible");
        } else {
            nightNotice.classList.remove("visible");
        }
    }

    // render กริดผู้เล่น — รวมโหมดโหวต/โหมดหมาป่าเลือกฆ่าไว้ในกริดเดียวกันนี้เลย (renderPlayerGrid คืนค่าโหมดปัจจุบันกลับมา)
    const mode = renderPlayerGrid(roomData);
    syncGameHud(roomData, mode);

    // แสดงสถานะการเลือก (select_target ปกติ) — แสดงเฉพาะตอนอยู่โหมดปกติเท่านั้น
    // เพราะตอนอยู่โหมดโหวต/โหมดหมาป่าเลือกฆ่า สถานะของตัวเองจะถูกแสดงในแบนเนอร์เหนือกริดแทนแล้ว
    const info = document.getElementById("selectInfo");

    // แก้ตามคำขอ: เอาข้อความ "📍 กำลังเลือก: ..." ออกทั้งหมด ไม่ต้องแสดงอีกต่อไปไม่ว่าอาชีพไหนก็ตาม
    // (เดิมงดแสดงเฉพาะยายขี้โมโห/หมอ/บอดี้การ์ดที่มีไอคอนติดมุมการ์ดเป้าแทนอยู่แล้ว ตอนนี้ขยายให้ครอบคลุม
    // ทุกอาชีพเหมือนกันหมด รวมถึงอาชีพที่ไม่มีไอคอนมุมการ์ดด้วย) — ยังคงเก็บ roomData.selectedTargets
    // ไว้ทำงานปกติเบื้องหลังเหมือนเดิมทุกประการ (โค้ดส่วนอื่นที่ใช้ค่านี้ในฟังก์ชัน renderPlayerGrid เช่น
    // การไฮไลต์การ์ดเป้าหมาย/ไอคอนมุมการ์ด ยังทำงานตามปกติ) แค่ "ไม่ต้องขึ้นข้อความบอกว่ากำลังเลือกใครอยู่"
    // บนกริดอีกต่อไปเท่านั้น
    if (mode !== "normal") {
        info.innerHTML = "";
    } else if (!myAlive) {
        info.innerHTML = `<span style="color:var(--wolf)">💀 คุณตายแล้ว — ไม่สามารถโหวตได้</span>`;
    } else {
        info.innerHTML = "";
    }

    // ===== GAME OVER SUMMARY =====
    if (roomData.gameOver && roomData.gameResult) {
        // fallback: ถ้า socket.id ใหม่หลัง reconnect หา myPlayer ไม่เจอ ให้ลองหาจาก token
        const myPlayerForResult = myPlayer
            || (roomData.players || []).find(p => p.token === clientToken);
        showGameOverOverlay(roomData, myPlayerForResult);
    } else {
        hideGameOverOverlay();
    }

});

// แสดงสรุปผลเกม (แพ้/ชนะ ตามทีมของบทตัวเอง) + ปุ่ม "ดำเนินการต่อ" ที่กดอัตโนมัติใน 5 วิ
// ถ้าไม่กด (กันคนเกรียนค้างหน้าจอไว้ไม่กด ทำให้ห้องเริ่มเกมใหม่ไม่ได้)
function showGameOverOverlay(roomData, myPlayer) {
    const overlay = document.getElementById("gameOverOverlay");
    if (!overlay) return;

    const result = roomData.gameResult;
    // server ส่ง winners เป็น array ของ {id, token} — ตรวจด้วย token (ยังใช้ได้แม้ socket id เปลี่ยน)
    const winners = new Set((result.winners || []).map(w => w.token ?? w));
    const won = myPlayer ? winners.has(myPlayer.token) : false;

    const resultEl = document.getElementById("gameOverResult");
    resultEl.textContent = won ? "ชนะ" : "แพ้";
    resultEl.className = "gameover-result " + (won ? "win" : "lose");

    document.getElementById("gameOverIcon").textContent = won ? "🏆" : "💀";
    document.getElementById("gameOverTitleLine").textContent = result.title;

    const roleNameEl = document.getElementById("gameOverRoleName");
    const roleIconEl = document.getElementById("gameOverRoleIcon");
    if (myPlayer && myPlayer.role) {
        roleNameEl.textContent = `บทของคุณ: ${myPlayer.role}`;
        const src = (allRolesData[myPlayer.role] && allRolesData[myPlayer.role].icon) || (wwImg("/images/default-role.jpg"));
        roleIconEl.src = src;
        roleIconEl.classList.remove("hidden");
    } else {
        roleNameEl.textContent = "";
        roleIconEl.classList.add("hidden");
    }

    // สรุปบทของทุกคน (ใครเป็นอะไร แพ้/ชนะ) — โชว์ตอนจบเกมเท่านั้น
    const roleListEl = document.getElementById("gameOverRoleList");
    if (roleListEl) {
        const nonHostPlayers = (roomData.players || []).filter(p => !p.isHost);
        roleListEl.innerHTML = nonHostPlayers.map((p) => {
            const win = winners.has(p.token);
            const isMe = myPlayer && p.id === myPlayer.id;
            return `
                <div class="gameOverRow ${win ? "win" : "lose"}${isMe ? " is-me" : ""}">
                    <div>
                        <div class="goName">${escapeHtml(p.name)}${isMe ? " (คุณ)" : ""}</div>
                        <div class="goRole">${p.role || "?"}${!p.alive ? " · 💀" : ""}</div>
                    </div>
                    <div class="goTag">${win ? "ชนะ" : "แพ้"}</div>
                </div>
            `;
        }).join("");
    }

    overlay.classList.remove("hidden");

    // อัปเดตจำนวนคนที่กด "ดำเนินการต่อ" แล้ว
    const ready = roomData.continueReady || {};
    const nonHostPlayers = (roomData.players || []).filter(p => !p.isHost);
    const readyCount = nonHostPlayers.filter(p => ready[p.id]).length;
    document.getElementById("gameOverReadyCount").textContent = readyCount;
    document.getElementById("gameOverTotalCount").textContent = nonHostPlayers.length;

    // ถ้าเรากดไปแล้ว (หรือ server บอกว่าเรา ready แล้ว) ให้โชว์สถานะรอคนอื่นแทนปุ่ม
    const meReady = myPlayer ? !!ready[myPlayer.id] : false;
    if (meReady) {
        gameOverConfirmed = true;
    }

    const btn = document.getElementById("gameOverContinueBtn");
    const waiting = document.getElementById("gameOverWaiting");

    if (gameOverConfirmed) {
        btn.classList.add("hidden");
        waiting.classList.remove("hidden");
        if (gameOverCountdownTimer) {
            clearInterval(gameOverCountdownTimer);
            gameOverCountdownTimer = null;
        }
        return;
    }

    btn.classList.remove("hidden");
    waiting.classList.add("hidden");

    // เริ่มนับถอยหลัง 5 วิ กดอัตโนมัติให้ ถ้ายังไม่เคยเริ่มนับสำหรับรอบนี้
    if (!gameOverCountdownTimer) {
        let secondsLeft = 5;
        document.getElementById("gameOverCountdown").textContent = `(${secondsLeft})`;
        gameOverCountdownTimer = setInterval(() => {
            secondsLeft -= 1;
            if (secondsLeft <= 0) {
                confirmContinue();
                return;
            }
            const el = document.getElementById("gameOverCountdown");
            if (el) el.textContent = `(${secondsLeft})`;
        }, 1000);
    }
}

function hideGameOverOverlay() {
    const overlay = document.getElementById("gameOverOverlay");
    if (overlay) overlay.classList.add("hidden");
    if (gameOverCountdownTimer) {
        clearInterval(gameOverCountdownTimer);
        gameOverCountdownTimer = null;
    }
    gameOverConfirmed = false;
}

// ปุ่ม "ดำเนินการต่อ" หลังเห็นสรุปผลเกม — ยืนยันว่าพร้อมให้รีบทบาท/ข้อมูลรอบนี้แล้ว
function confirmContinue() {
    if (gameOverConfirmed) return;
    gameOverConfirmed = true;

    if (gameOverCountdownTimer) {
        clearInterval(gameOverCountdownTimer);
        gameOverCountdownTimer = null;
    }

    document.getElementById("gameOverContinueBtn").classList.add("hidden");
    document.getElementById("gameOverWaiting").classList.remove("hidden");

    socket.emit("confirm_continue", { roomId: currentRoomId });
}

// DISCONNECT — ตามที่ตกลงกันไว้ ไม่ต้องการให้ผู้เล่นเห็นสถานะ "หลุด/กำลังเชื่อมต่อใหม่" อีกต่อไป
// (เดิมโชว์แบนเนอร์ตรงนี้ แต่บางคนปิดจอไว้แป๊บเดียวเพื่อกันคนข้างๆ แอบดูบท แล้วโดนมองว่าหลุด
// พอเปิดจอกลับมาก็เจอแบนเนอร์/ต้องรอเหมือนโหลดใหม่ น่ารำคาญ) socket.io จะพยายามเชื่อมต่อใหม่
// และ auto-rejoin ด้วย token เดิมให้เองอยู่เบื้องหลังเงียบๆ โดยไม่ต้องแจ้งอะไรผู้เล่นเลย
socket.on("disconnect", () => {
    // เจตนาปล่อยว่าง — ไม่แสดงแบนเนอร์ใดๆ ให้ผู้เล่นเห็น
});

// CONNECT — เรียกทั้งตอนเชื่อมต่อครั้งแรก และทุกครั้งที่ socket.io เชื่อมต่อใหม่สำเร็จ
// (เช่น เน็ตสะดุด/มือถือล็อกสกรีน/สลับแอปกลับมา) ถ้าตอนหลุดเรา "join" ห้องอยู่
// ให้ส่ง token เดิมไป join_room ซ้ำทันที เพื่อให้เซิร์ฟเวอร์รู้ว่าเป็นคนเดิม
// แล้วส่งกริดผู้เล่น/บทบาทกลับมาให้ใหม่ ไม่ต้องกดเข้าร่วมห้องเองอีกรอบ
socket.on("connect", async () => {
    await bootstrapPlayerAccount();
    sendPlayerPresence();
    document.getElementById("connBanner").classList.add("hidden");

    if (!joined && !pendingJoinRoomId && !BOT_CONTROLLED_TAB) {
        checkPreviousRoomResume();
    }

    // reconnect ของหน้าเดิมจริงเท่านั้นที่ auto-rejoin ได้
    const rejoinRoomId = currentRoomId || pendingJoinRoomId;
    if ((joined || pendingJoinRoomId) && rejoinRoomId) {
        pendingJoinRoomId = rejoinRoomId;
        wwRejoinRoom(rejoinRoomId, 0);
    }
});

// ข้อความตามเหตุผลจริงที่ server ตอบ (res.code) — ห้ามใช้ข้อความเดียวรวบทุก error
// (โดยเฉพาะห้ามอ้างว่าเป็นเรื่อง "อัปเดต": การอัปเดตไม่เกี่ยวกับการเข้าห้องเดิมไม่ได้ — ระบบแจ้งอัปเดตอยู่ที่หน้า index เท่านั้น)
//   ROOM_NOT_FOUND : ไม่มีห้องนี้บน server (โฮสต์ปิดห้อง / แอดมินปิดเซิร์ฟเวอร์ / server ยังไม่กู้คืนห้องจาก persistence สำเร็จ)
//   AUTH_FAILED    : รหัสห้องไม่ตรง   TOO_MANY_ATTEMPTS: ลองผิดหลายครั้ง   ROOM_STARTED: เกมเริ่มแล้วและ token ไม่ตรงคนเดิม
//   ROOM_FULL      : ห้องเต็ม          SERVER_ERROR: server error ชั่วคราว (ไม่ถือว่าห้องหาย → ลองใหม่ ไม่รีเซ็ตจอ)
function wwRejoinFailMessage(res) {
    switch (res && res.code) {
        case "ROOM_NOT_FOUND": return "ไม่พบห้องนี้แล้ว หรือเซิร์ฟเวอร์ยังไม่สามารถกู้คืนห้องได้";
        case "AUTH_FAILED": return "รหัสห้องไม่ตรง — กรุณากรอกรหัสห้องใหม่";
        case "TOO_MANY_ATTEMPTS": return "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่";
        case "ROOM_STARTED": return "เกมในห้องนี้เริ่มไปแล้ว เข้าร่วมกลางเกมไม่ได้";
        case "ROOM_FULL": return "ห้องเต็มแล้ว";
        default: return "เข้าห้องเดิมไม่สำเร็จ" + (res && res.error ? " (" + res.error + ")" : "");
    }
}

function wwRejoinRoom(rejoinRoomId, attempt) {
    socket.emit(
        "join_room",
        {
            roomId: rejoinRoomId,
            name: ww_store.getItem("ww_playerName") || undefined,
            token: clientToken,
            ...(TESTER_MODE ? {} : (window.wwAccount ? window.wwAccount.payload() : {})),
            isTester: TESTER_MODE, // แค่ "คำขอ" — server ตัดสินสิทธิ์ผู้ทดสอบเองจากบัตรผ่าน (ค่านี้ปลอมแล้วไม่ได้สิทธิ์อะไร)
            testerSessionId: TESTER_MODE ? (urlParams.get("ts") || "") : ""
        },
        (res) => {
            if (res && res.error) {
                // server error ชั่วคราว: ห้องยังอาจอยู่ → อย่ารีเซ็ตจอ ลองใหม่ (สูงสุด 3 ครั้ง ห่างกัน 3 วิ) — ไม่เด้งข้อความอะไรให้ผู้เล่นตกใจ
                if (res.code === "SERVER_ERROR" && attempt < 3 && pendingJoinRoomId === rejoinRoomId) {
                    setTimeout(() => { if (socket.connected && pendingJoinRoomId === rejoinRoomId) wwRejoinRoom(rejoinRoomId, attempt + 1); }, 3000);
                    return;
                }
                // ห้องหายจริง/เข้าไม่ได้ระหว่างที่เราหลุดการเชื่อมต่อ (เช่น โฮสต์ปิดห้อง แอดมินปิดเซิร์ฟเวอร์ หรือระบบ recovery ยังไม่พร้อม)
                // ต้องรีเซ็ต UI กลับไปหน้ากรอกห้อง/ชื่อด้วย ไม่ใช่แค่เคลียร์ตัวแปร ไม่งั้นจะค้างอยู่หน้าเกม
                if (res && res.code === "PLAYER_LEFT_GAME") {
                    if (pendingJoinRoomId === rejoinRoomId) pendingJoinRoomId = null;
                    ww_store.removeItem("ww_joinedRoom");
                    previousRoomDecisionPending = false;
                    previousRoomCheckDone = true;
                    previousRoomResumeState = null;
                    setResumeModalVisible(false);
                    openPlayerRoomPicker();
                    return;
                }
                if (pendingJoinRoomId === rejoinRoomId) pendingJoinRoomId = null;
                // ในโหมดทดลอง ห้องหาย = จอทดลองจบ ไม่ใช่ให้บอท/ผู้ทดสอบค้างหน้า "รอเข้าห้อง"
                if (TESTER_MODE) {
                    try { socket.disconnect(); } catch (e) {}
                    try { sessionStorage.clear(); } catch (e) {}
                    returnFromTesterPlayer();
                    return;
                }
                resetToJoinScreen(wwRejoinFailMessage(res));
                return;
            }
            // ถ้าสำเร็จ: finalizeJoin เผื่อไว้กรณียังไม่เคย join สำเร็จมาก่อน (เคส 2)
            // ส่วนกรณี (1) ที่ join อยู่แล้ว room_update / your_role จะตามมาทาง event ปกติ
            finalizeJoin(rejoinRoomId);
        }
    );
}

// VISIBILITY CHANGE — เมื่อสลับกลับมาที่แท็บ/หน้าจอนี้ (สลับแอป/ปลดล็อกสกรีน)
// บางครั้ง browser มือถือจะ throttle จนกระบวนการ reconnect ของ socket.io เองทำงานช้า
// หรือไม่ทำงานจนกว่าจะมี interaction บังคับให้เช็ค-ต่อใหม่ทันทีเมื่อกลับมาเห็นจอ
// แทนที่จะรอ backoff ของ socket.io เพียงอย่างเดียว
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !socket.connected) {
        socket.connect();
    }
    // แก้บั๊ก "สลับกลับมาแล้วไม่เห็นอาชีพ/ข้อมูลเกม": เคสที่ socket "ไม่เคยหลุดการเชื่อมต่อเลย"
    // (แค่แท็บถูกซ่อน/พับจอไว้) event "connect" ด้านบนจะไม่ทำงานเลย เพราะไม่ได้ reconnect จริง
    // จึงไม่มีการส่ง join_room ซ้ำ ทำให้ state ฝั่ง client อาจไม่ตรงกับเซิร์ฟเวอร์ (เช่น พลาด
    // room_update บาง event ระหว่างที่ browser throttle อยู่เบื้องหลัง) — ขอสถานะล่าสุดทั้งหมด
    // ตรงจากเซิร์ฟเวอร์ทุกครั้งที่กลับมาเห็นจอ เพื่อให้ข้อมูล (บทบาท/ตำแหน่ง/แชท) ตรงกับความจริง
    // ของเซิร์ฟเวอร์เสมอ ไม่ต้องพึ่ง state เก่าที่ client จำไว้เอง
    if (document.visibilityState === "visible" && joined && currentRoomId) {
        socket.emit("request_sync", { roomId: currentRoomId, token: clientToken });
    }
    // ถ้าสลับออกไประหว่างอนิเมชั่นเปิดเผยบทกำลังเล่นอยู่ ให้ปิด overlay ทิ้งไปเลยทันที
    // ไม่งั้น setTimeout ของอนิเมชั่นที่เหลือจะถูก throttle ค้างกลางทาง ทำให้กลับมาเจอจอ
    // ค้างบังอยู่ (ข้อมูลบทจริงถูกตั้งไว้แล้วตั้งแต่ตอนได้รับ your_role อยู่แล้ว ไม่กระทบ)
    if (document.visibilityState === "hidden") {
        const overlay = document.getElementById("roleRevealOverlay");
        if (overlay && !overlay.classList.contains("hidden")) {
            overlay.classList.add("hidden");
        }
    }
});
// และกรณีที่ join_room ตอน reconnect ถูกปฏิเสธ (ห้องถูกปิด/ไม่พบห้อง)
// เพื่อไม่ให้ผู้เล่นค้างอยู่หน้าเกมทั้งที่ไม่ได้อยู่ในห้องแล้ว
function resetToJoinScreen(message) {

    if (message) wwAlert(message);

    joined = false;
    currentRoomId = null;
    pendingJoinRoomId = null;
    myRole = "";
    myHuntTargetId = null;
    shieldModeActive = false;
    curseModeActive = false;
    gunModeActive = false;
    peekModeActive = false;
    holyWaterModeActive = false;
    poisonModeActive = false;
    protectModeActive = false;
    silenceModeActive = false;
    wolfCubModeActive = false;
    loudmouthModeActive = false;
    detectivePendingFirstId = null;
    detectivePendingSecondId = null;
    cupidPendingFirstId = null;
    cupidPendingSecondId = null;
    instigatorPendingFirstId = null;
    instigatorPendingSecondId = null;
    ww_store.removeItem("ww_joinedRoom");

    // reset UI กลับสู่หน้าเริ่ม
    document.querySelector('.app').classList.remove("game-visible");
    document.querySelector('.app').classList.remove("game-started");
    document.body.classList.add("lobby-beach");
    document.body.classList.remove("room-picker-open");
    closePlayerChat();
    document.getElementById("joinCard").classList.remove("hidden");
    document.getElementById("playersCard").classList.add("hidden");
    document.getElementById("chatCard").classList.add("hidden");
    document.getElementById("rolesPanelCard").classList.add("hidden");
    document.getElementById("bottomBar").classList.add("hidden");
    document.getElementById("bottomBar").classList.remove("bar-visible");
    document.getElementById("barRoleName").textContent = "ยังไม่ได้รับบท";
    document.getElementById("barRoleSub").textContent = "แตะหน้ากากเพื่อดูรายละเอียด";
    document.getElementById("barHuntBadge").classList.add("hidden");
    document.getElementById("barIllusionBadge")?.classList.add("hidden");
    document.getElementById("shieldBtn").classList.add("hidden");
    document.getElementById("shieldBtn").classList.remove("active");
    document.getElementById("pawBtn")?.classList.add("hidden");
    document.getElementById("pawBtn")?.classList.remove("active");
    document.getElementById("curseBtn").classList.add("hidden");
    document.getElementById("curseBtn").classList.remove("active");
    document.getElementById("cultRecruitBtn")?.classList.add("hidden");
    document.getElementById("cultRecruitBtn")?.classList.remove("active");
    document.getElementById("cultSacrificeBtn")?.classList.add("hidden");
    document.getElementById("cultSacrificeBtn")?.classList.remove("active");
    cultRecruitModeActive = false;
    cultSacrificeModeActive = false;
    cultSacrificePendingMemberId = null;
    document.getElementById("popupRoleName").textContent = "—";
    document.getElementById("popupRoleCount").textContent = "";
    document.getElementById("popupRealRole").classList.add("hidden");
    document.getElementById("popupHuntInfo").classList.add("hidden");
    document.getElementById("popupRoleDesc").innerHTML = "";
    const rolesPanelResetEl = document.getElementById("rolesInGamePanel");
    if (rolesPanelResetEl) rolesPanelResetEl.innerHTML = "";
    document.getElementById("popupRolesInGame").innerHTML = "";
    document.getElementById("selectInfo").innerHTML = "";
    document.getElementById("players").innerHTML = "";
    document.getElementById("players").classList.remove("mode-active");
    document.getElementById("chatBoxGlobal").innerHTML = "";
    document.getElementById("chatBoxWolf").innerHTML = "";
    document.getElementById("chatBoxInstigator").innerHTML = "";
    document.getElementById("chatBoxCult").innerHTML = "";
    document.getElementById("chatBoxBandit").innerHTML = "";
    document.getElementById("phaseIcon").textContent = "";
    document.getElementById("phaseText").textContent = "ผู้เล่นในห้อง";
    document.getElementById("playersSubThreshold").textContent = "";
    stopVoteCountdown();
    document.body.classList.remove("vote-open");
    document.body.classList.remove("is-night");
    document.body.classList.remove("is-day");
    document.getElementById("dayNightBadge").classList.add("hidden");
    document.getElementById("room").value = "";
    closeRolePopup();
    renderRoomSuggestion();

}

// ===== ออกจากห้องจริง (กดย้อนกลับแล้วยืนยันออก) =====
// ต่างจาก resetToJoinScreen() ตรงที่ resetToJoinScreen แค่รีเซ็ต UI กลับไปหน้ากรอกห้องของ player.html
// เฉยๆ (ยังจำชื่อ/ห้องล่าสุดไว้ในเครื่องอยู่) แต่ตรงนี้ผู้เล่นตั้งใจ "ออกจากห้อง" จริงๆ ผ่านปุ่มย้อนกลับ
// ของเบราว์เซอร์ จึงแจ้งเซิร์ฟเวอร์ให้เอาชื่อออกจากห้องทันที (กันชื่อค้างเป็น "🟡 กำลังเชื่อมต่อ..." อยู่
// ในสายตาโฮสต์/ผู้เล่นคนอื่นจนกว่า timeout จะลบทิ้งเอง) แล้วล้างข้อมูลจำไว้ในเครื่องทั้งหมดเพื่อไม่ให้
// auto-rejoin ดึงกลับเข้าห้องเดิม/auto-fill ชื่อ-ห้องเดิมให้อีก ผู้เล่นต้องกรอกชื่อ/ห้องใหม่เองถ้าจะเข้าอีกครั้ง
function leaveRoomViaBack() {
    playerAllowIntentionalExit("browser_back_confirmed");
    if (currentRoomId) {
        // ส่งแบบมี ack แต่ไม่รอผลลัพธ์นาน (เผื่อเน็ตช้า/หลุด) — ยังไงก็จะพาไปหน้าแรกอยู่ดี ฝั่งเซิร์ฟเวอร์
        // เองก็มีกลไก disconnect ตามหลังมาเก็บกวาดซ้ำอีกชั้นถ้า leave_room ไปไม่ถึงจริงๆ
        socket.emit("leave_room", { roomId: currentRoomId, token: clientToken });
    }

    ww_store.removeItem("ww_token");
    ww_store.removeItem("ww_playerName");
    ww_store.removeItem("ww_lastRoom");
    ww_store.removeItem("ww_joinedRoom");

    returnFromTesterPlayer();
}

// โหมดทดลองไม่มีเส้นทางย้อนกลับไปหน้าเกมจริง — ถ้าไม่ได้อยู่ในห้องแล้ว ให้ย้อนกลับแอดมินเสมอ
// (แท็บบอทที่ถูกเข้าสิงใช้ opener/room_closed จัดการแยกต่างหาก)
if (TESTER_MODE) {
    history.pushState({ wwTesterRootGuard: true }, "", window.location.href);
    window.addEventListener("popstate", () => {
        if (!currentRoomId) returnFromTesterPlayer();
    });
}

// ===== ดักปุ่ม/ท่าทาง "ย้อนกลับ" ของเบราว์เซอร์ตอนอยู่ในห้องที่เกมยังไม่เริ่ม =====
// ใช้ history.pushState() ไว้เป็น "การ์ด" กันหน้าเว็บหลุดออกไปเงียบๆ (ดันไว้ตอน finalizeJoin() สำเร็จ
// ด้านบนของไฟล์) พอผู้เล่นกดย้อนกลับ browser จะ pop การ์ดตัวนั้นออกแล้วยิง popstate มาที่นี่ก่อน (ไม่มีการ
// โหลดหน้าใหม่ เพราะเป็น state ที่ pushState ไว้เอง ไม่ใช่หน้าเอกสารอื่นจริงๆ)
let ww_leaveConfirmOpen = false;
window.addEventListener("popstate", () => {
    // เกมเริ่มไปแล้ว หรือยังไม่ได้เข้าห้อง → ปล่อยให้ย้อนกลับตามปกติ ไม่ต้องถามอะไร (ไม่ใช่ขอบเขตของฟีเจอร์นี้)
    const stillInLobby = joined && !!currentRoomId && !(lastRoomData && lastRoomData.started);
    if (!stillInLobby) return;

    // ดันการ์ดกลับเข้าไปทันที กันไม่ให้เบราว์เซอร์หลุดออกจากหน้านี้จริงๆ ก่อนผู้เล่นจะตอบยืนยัน
    history.pushState({ ww_roomGuard: true }, "", window.location.href);

    if (ww_leaveConfirmOpen) return; // มีกล่องยืนยันค้างอยู่แล้ว ไม่ต้องเปิดซ้อน
    ww_leaveConfirmOpen = true;

    wwConfirm("ต้องการออกจากห้องนี้ใช่หรือไม่? เมื่อออกแล้วต้องกรอกชื่อและรหัสห้องใหม่หากต้องการเข้าห้องอีกครั้ง").then((ok) => {
        ww_leaveConfirmOpen = false;
        if (ok) leaveRoomViaBack();
        // กดยกเลิก: ไม่ต้องทำอะไรเพิ่ม เพราะดันการ์ดกลับเข้าไปแล้วด้านบน ยังอยู่ในห้องเดิมตามปกติ
    });
});

// ROOM CLOSED (โฮสต์หลุด/รีห้อง)
socket.on("room_closed", () => {
    playerBrowserExitServerClosed = true;
    playerBrowserExitGuardState(false, "room_closed");
    // ห้องถูกปิด = บอท/แท็บทดสอบไม่มีเหตุผลให้ค้างอยู่หน้า "รอเข้าห้อง"
    // บอทไม่มีตัวตนจริง เป็นเพียงหน้าจอทดลองของแอดมิน จึงปิดแท็บกลับไปยังโฮสต์ทันที
    // และถ้าโฮสต์แท็บหายไปแล้ว ให้กลับหน้าแอดมินแทน ไม่เข้า index.html ของเกมจริง
    if (BOT_CONTROLLED_TAB) {
        try { socket.disconnect(); } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
        returnFromTesterPlayer();
        return;
    }

    if (!joined) return;

    if (TESTER_MODE) {
        try { socket.disconnect(); } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
        returnFromTesterPlayer();
        return;
    }

    resetToJoinScreen("ห้องถูกปิด เนื่องจากผู้สร้างห้องออกจากเกม");

});

// SEND CHAT
function sendChat() {

    // ถ้าโดนใบ้ ห้ามส่งแชท
    if (mySilenced) return;

    // ช่วงกลางคืน: แชทรวมส่งไม่ได้ (แต่พิมพ์ไว้ได้)
    if (isNight && currentChatTab === "global") return;

    // แชทลัทธิ: ส่งได้เฉพาะตอนกลางวันเท่านั้น ตามที่ระบุไว้ในคำอธิบายบทบาทผู้นำลัทธิ
    if (isNight && currentChatTab === "cult") return;

    // แชททีมโจร: พิมพ์ได้เฉพาะหัวโจรเท่านั้น (ผู้สมรู้ร่วมคิดอ่านได้อย่างเดียว) — เช็คซ้ำฝั่งเซิร์ฟเวอร์ด้วย
    if (currentChatTab === "bandit" && !window.__isBanditLeader) return;

    const input =
        document.getElementById(
            "chatInput"
        );

    const text =
        input.value.trim();

    if (!text) return;
    if (!currentRoomId) return;

    const type = currentChatTab;

    socket.emit("send_chat", { roomId: currentRoomId, text, type });

    input.value = "";

}

// RENDER ONE CHAT MESSAGE
// countUnread: true เฉพาะข้อความที่มาสดๆ ผ่าน event "chat_message" เท่านั้น — ตอน sync ประวัติแชท
// (wolf_chat_history/global_chat_history/private_chat_history) จะส่ง false มาเสมอ เพราะข้อความ
// เหล่านั้นเป็นของเก่าที่เคยถูกนับไปแล้วก่อนหน้านี้ ไม่ใช่ข้อความใหม่ — เดิมไม่แยกกรณีนี้ ทำให้ทุกครั้งที่
// ซิงค์ห้องใหม่ (reconnect/สลับแท็บมือถือ/ซิงค์เต็มรูปแบบเป็นระยะ) จะเคลียร์กล่องแชทแล้ว render ประวัติ
// ทั้งหมดซ้ำ และตัวนับ badge ก็ถูกบวกเพิ่มซ้ำทุกครั้งไปด้วย (บั๊ก: กล่องแชทมีแค่ 1 ข้อความ แต่ badge
// ขึ้นเลขสะสมจากการ sync ซ้ำหลายรอบ เช่น 5 ข้อความ)
function renderChatMessage(msg, countUnread = true) {

    // กรองแชทหมาป่าเหมือนเดิม
    if (
        msg.type === "wolf" &&
        !allWolfRoles.includes(myRole) &&
        !msg.isHost
    ) return;

    // กรองแชททีมยุยง: เห็นได้เฉพาะคนที่อยู่กลุ่มเดียวกันเท่านั้น (server กรองไม่ส่งมาให้อยู่แล้ว
    // แต่เผื่อ host เห็นทุกข้อความ ก็ยังโชว์ให้จอโฮสต์ได้ตามปกติ ไม่ต้องกรองซ้ำฝั่ง client)
    const chatBox =
        msg.type === "wolf"
        ? document.getElementById("chatBoxWolf")
        : msg.type === "instigator"
        ? document.getElementById("chatBoxInstigator")
        : msg.type === "cult"
        ? document.getElementById("chatBoxCult")
        : msg.type === "bandit"
        ? document.getElementById("chatBoxBandit")
        : document.getElementById("chatBoxGlobal");

    const div =
        document.createElement("div");

    let className = "msg msgGlobal";

    if (msg.type === "wolf") {
        className = "msg msgWolf";
    }
    if (msg.type === "instigator") {
        className = "msg msgInstigator";
    }
    if (msg.type === "cult") {
        className = "msg msgCult";
    }
    if (msg.type === "bandit") {
        className = "msg msgBandit";
    }

    if (msg.isHost) {
        className = "msg msgHost";
    }

    // ✅ FIX: private ต้อง override ทุกอย่าง
    if (msg.type === "private") {
        className = "msg msgPrivate";
    }

    // ข้อความจากเกม (isSystem) ให้เป็นสีเขียวเสมอ ไม่ว่าจะอยู่แชทไหน
    if (msg.isSystem) {
        className += " msgSystem";
    }

    // ข้อความที่ server ตัดสินแล้วว่า "มีคนตายจริง" (isDeath) ให้เป็นสีแดงเสมอ ไม่ว่าจะตายด้วย
    // สาเหตุอะไร (ถูกฆ่ากลางคืน/ประหาร/ยาพิษ/ลากตาย/ยิงตาย ฯลฯ) — ทับสีเขียวของ msgSystem
    if (msg.isDeath) {
        className += " msgDeath";
    }

    // ข้อความประกาศ "เปิดเผยตัวนายก" (isMayor) ให้เป็นสีทองเสมอ — ทับสีเขียวของ msgSystem
    if (msg.isMayor) {
        className += " msgMayor";
    }

    div.className = className;

    div.innerHTML = `
        <div class="msgLine">
            <span class="msgName">${escapeHtml(msg.name)}:</span>
            <span class="msgText">${escapeHtml(msg.text)}</span>
        </div>

        <div class="msgType">
            ${
                msg.type === "private"
                ? "🟢 PRIVATE"
                : msg.type === "wolf"
                ? "🔴 แชทหมาป่า"
                : msg.type === "instigator"
                ? "🎭 แชททีมยุยง"
                : msg.type === "cult"
                ? "🔯 แชทลัทธิ"
                : msg.type === "bandit"
                ? "🗡️ แชททีมโจร"
                : "🔵 แชทรวม"
            }
        </div>
    `;

    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;

    // increment unread badge if this tab is not active — เฉพาะข้อความสดใหม่เท่านั้น (ดูคอมเมนต์บนฟังก์ชัน)
    const tabKey = msg.type === "wolf" ? "wolf" : msg.type === "instigator" ? "instigator" : msg.type === "cult" ? "cult" : msg.type === "bandit" ? "bandit" : "global";
    if (countUnread && currentChatTab !== tabKey) {
        playerBadgeCounts[tabKey] = (playerBadgeCounts[tabKey] || 0) + 1;
        const badgeEl = document.getElementById(CHAT_TAB_IDS[tabKey]?.badge || "badgeGlobal");
        badgeEl.textContent = playerBadgeCounts[tabKey];
        badgeEl.classList.remove("zero");
    }
    updateChatUnreadTotal();
}

// RECEIVE CHAT
socket.on("chat_message", (msg) => {
    renderChatMessage(msg);
});

// RECEIVE WOLF CHAT HISTORY (เมื่อผู้ถูกสาปกลายเป็นหมาป่า)
socket.on("wolf_chat_history", (messages) => {
    document.getElementById("chatBoxWolf").innerHTML = "";
    (messages || []).forEach((m) => renderChatMessage(m, false));
});

// RECEIVE INSTIGATOR TEAM CHAT HISTORY (ตอน join/reconnect/sync — ดู instigator_chat_history ฝั่ง server)
socket.on("instigator_chat_history", (messages) => {
    document.getElementById("chatBoxInstigator").innerHTML = "";
    (messages || []).forEach((m) => renderChatMessage(m, false));
});

// RECEIVE CULT TEAM CHAT HISTORY (ตอน join/reconnect/sync — ดู cult_chat_history ฝั่ง server)
socket.on("cult_chat_history", (messages) => {
    document.getElementById("chatBoxCult").innerHTML = "";
    (messages || []).forEach((m) => renderChatMessage(m, false));
});

// RECEIVE BANDIT TEAM CHAT HISTORY (ตอน join/reconnect/sync — ดู bandit_chat_history ฝั่ง server)
socket.on("bandit_chat_history", (messages) => {
    document.getElementById("chatBoxBandit").innerHTML = "";
    (messages || []).forEach((m) => renderChatMessage(m, false));
});

// RECEIVE GLOBAL CHAT HISTORY (ตอนเข้าห้องใหม่ หรือหลุดแล้วโหลดกลับมาใหม่)
socket.on("global_chat_history", (messages) => {
    document.getElementById("chatBoxGlobal").innerHTML = "";
    (messages || []).forEach((m) => renderChatMessage(m, false));
});

// RECEIVE PRIVATE CHAT HISTORY (เดิมใช้ตอน sync/reconnect แต่ตอนนี้เซิร์ฟเวอร์รวมข้อความ private
// เข้ากับ global_chat_history เป็นไทม์ไลน์เดียวเรียงตามลำดับเวลาจริงแล้ว (ดู
// mergedGlobalAndPrivateHistory ฝั่ง server.js) แก้บั๊กที่ข้อความ private เช่น "คุณตกหลุมรักกับ..."
// เคยถูกต่อท้ายกล่องแชทเสมอทุกครั้งที่ sync ใหม่ ทำให้ลำดับไม่ตรงกับตอนเล่นสด — event นี้จึงไม่ถูกยิง
// จากฝั่งเซิร์ฟเวอร์อีกต่อไปแล้วตอนนี้ (คงไว้เผื่ออนาคตอยากใช้แยกอีกครั้ง ไม่มีผลอะไรถ้าไม่เคยถูกเรียก)
socket.on("private_chat_history", (messages) => {
    document.querySelectorAll("#chatBoxGlobal .msgPrivate").forEach((el) => el.remove());
    (messages || []).forEach((m) => renderChatMessage(m, false));
});

socket.on("kicked", () => {
    // ล้าง token และข้อมูลห้องออก ป้องกัน reconnect กลับเข้ามาใหม่
    ww_store.removeItem("ww_token");
    ww_store.removeItem("ww_lastRoom");
    ww_store.removeItem("ww_joinedRoom");

    // แสดง overlay แจ้งถูกเตะ
    const overlay = document.createElement("div");
    overlay.id = "kickedOverlay";
    overlay.innerHTML = `
        <div class="kicked-box">
            <div class="kicked-icon">⛔</div>
            <div class="kicked-title">คุณถูกเตะออกจากห้อง</div>
            <div class="kicked-sub">กำลังพากลับไปหน้าหลัก...</div>
        </div>
    `;
    document.body.appendChild(overlay);

    setTimeout(() => {
        overlay.remove();
        resetToJoinScreen(); // ใช้ฟังก์ชันกลาง ไม่ต้องซ้ำโค้ด
    }, 2500);
});


document.addEventListener(
    "keydown",
    (e) => {

    if (e.key === "Escape" && document.body.classList.contains("player-chat-open")) {
        closePlayerChat();
        return;
    }

    if (
    e.key === "Enter" &&
    document.activeElement.id === "chatInput"
)  {

        sendChat();

    }

});

// ===== KEYBOARD MODE: #chatCard กลายเป็น fixed overlay เหนือคีย์บอร์ดมือถือ/iPad =====
// เดิม: พอแตะช่องพิมพ์ คำนวณความสูงคีย์บอร์ดจาก VisualViewport แล้วลอยแค่ #chatRow (ช่องพิมพ์+ปุ่มส่ง)
// ขึ้นไปด้วย transform — ปัญหาคือ #chatCard/ข้อความแชททั้งก้อนยังอยู่ layout เดิม ไม่ได้ขยับ/หดตาม
// พื้นที่ที่มองเห็นจริงเหนือคีย์บอร์ด โดยเฉพาะ iPad แนวนอนที่คีย์บอร์ดกินพื้นที่เกือบครึ่งจอ ข้อความ
// แชทแถวบนๆ เลยโดนคีย์บอร์ดบัง/layout เพี้ยน
//
// ตอนนี้เปลี่ยน architecture: ทั้ง #chatCard (แท็บ + ข้อความ + ช่องพิมพ์) กลายเป็น fixed overlay ที่ใช้
// พื้นที่ของ Visual Viewport จริงทั้งหมด (อ่าน vv.offsetTop/offsetLeft/width/height ตรงๆ ไม่ใช่
// window.innerHeight ซึ่งใช้ได้แค่ fallback คำนวณ keyboardHeight) เกมด้านหลัง (.app/กริดผู้เล่น/
// roles panel/bottomBar) ไม่ถูกแตะต้องเลย แค่โดนคลาส keyboard-mode บังด้วย z-index เท่านั้น — ดู
// #chatCard.keyboard-mode ใน player.css
//
// keyboard mode ต้องตัดสินจาก "ช่องพิมพ์ focus อยู่" + "เป็นอุปกรณ์จอสัมผัส (กัน desktop เข้าใจผิด
// ตอน browser chrome เปลี่ยนขนาดนิดหน่อย)" + "viewport หดลงเกิน threshold จริง" ร่วมกัน ไม่ใช้แค่
// width ของจอ (iPad landscape กว้างเกิน breakpoint desktop ปกติ แต่ก็ต้องเข้าโหมดนี้ได้ถ้าคีย์บอร์ดเปิด)
// ===== WINDOW RESIZE PERFORMANCE =====
// ระหว่างลากขอบ Chrome/Safari จะยิง resize หลายครั้งต่อวินาที. ไม่ควรให้ JS คำนวณ
// grid เองหรือแก้ width/height ทุก event — CSS Grid ทำงานต่อเนื่องให้เองอยู่แล้ว.
// สิ่งที่ทำเพิ่มมีเพียงปิดเอฟเฟกต์ที่ทำให้ GPU/paint หนักชั่วคราว แล้วคืนกลับหลังหยุดลาก
// เพื่อให้เฟรมระหว่าง resize ถูกใช้กับ "จัดตำแหน่งเนื้อหา" แทนการวาด blur/shadow ซ้ำ ๆ.
(function () {
    let rafId = null;
    let releaseTimer = null;

    function markResizing() {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
            rafId = null;
            document.body.classList.add("is-resizing");
        });

        clearTimeout(releaseTimer);
        // หน่วงสั้น ๆ หลัง resize ครั้งสุดท้าย เพื่อไม่ให้เอฟเฟกต์เปิด/ปิดถี่ ๆ
        // ถ้าผู้ใช้ลากต่อเนื่อง class จะค้างตลอดช่วงการลาก.
        releaseTimer = setTimeout(() => {
            document.body.classList.remove("is-resizing");
        }, 120);
    }

    window.addEventListener("resize", markResizing, { passive: true });
})();

(function () {
    if (!window.visualViewport) return; // เบราว์เซอร์เก่าไม่รองรับ — ปล่อยพฤติกรรมปกติ ไม่ทำอะไรเพิ่ม

    const chatCard = document.getElementById("chatCard");
    const chatInputEl = document.getElementById("chatInput");
    if (!chatCard || !chatInputEl) return;

    // อุปกรณ์จอสัมผัส/ไม่มี hover เท่านั้นถึงจะมีคีย์บอร์ดจอเสมือนที่ทำให้ visual viewport หด — เช็คครั้งเดียว
    // ตอนโหลด (ประเภทอุปกรณ์ไม่เปลี่ยนกลางเซสชัน) กัน desktop ที่ focus input แล้ว browser chrome ขยับ
    // viewport เล็กน้อยถูกเข้าใจผิดว่าเป็นคีย์บอร์ด
    const isTouchCapable =
        (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
        (window.matchMedia && (
            window.matchMedia("(pointer:coarse)").matches ||
            window.matchMedia("(hover:none)").matches
        ));

    const KEYBOARD_THRESHOLD = 80; // กันสั่นตอนแถบ URL/แถบเครื่องมือย่อ-ขยายเล็กน้อย (ไม่ใช่คีย์บอร์ดจริง)
    let rafId = null;
    let isKeyboardMode = false;

    // แชทที่กำลังเปิดดูอยู่ตอนนี้ (แชทรวม/หมาป่า/ฯลฯ) — ใช้ตัวแปร/แมปที่มีอยู่แล้วในไฟล์นี้
    // (currentChatTab, CHAT_TAB_IDS ประกาศไว้ด้านบนของไฟล์ที่ switchChatTab())
    function activeChatBox() {
        const ids = (typeof CHAT_TAB_IDS !== "undefined") ? CHAT_TAB_IDS[currentChatTab] : null;
        return document.getElementById(ids ? ids.box : "chatBoxGlobal");
    }

    function enterKeyboardMode(vv) {
        const box = activeChatBox();
        // จำไว้ก่อนเปลี่ยน layout ว่าผู้ใช้อยู่ที่ข้อความล่าสุดอยู่แล้วหรือเปล่า (ห่างขอบล่างไม่เกิน 24px
        // ถือว่า "อยู่ล่างสุด") — ถ้าใช่ ต้องเลื่อนตามลงไปให้อีกทีหลัง resize เพราะพื้นที่แสดงผลเปลี่ยน
        // ไป ถ้ากำลังอ่านข้อความเก่าอยู่ (ไม่ใช่ล่างสุด) ห้ามบังคับกระโดดลง
        const wasAtBottom = !!box && (box.scrollHeight - box.scrollTop - box.clientHeight <= 24);

        document.documentElement.style.setProperty("--vv-top", vv.offsetTop + "px");
        document.documentElement.style.setProperty("--vv-left", vv.offsetLeft + "px");
        document.documentElement.style.setProperty("--vv-width", vv.width + "px");
        document.documentElement.style.setProperty("--vv-height", vv.height + "px");

        // ตั้งตำแหน่ง/ขนาดจริงเป็น inline style ตรงๆ (ชนะทุก breakpoint ของ #chatCard 660px/900px
        // แน่นอนโดยไม่ต้องพึ่ง !important) — ดูคอมเมนต์ #chatCard.keyboard-mode ใน player.css
        chatCard.style.position = "fixed";
        chatCard.style.top = vv.offsetTop + "px";
        chatCard.style.left = vv.offsetLeft + "px";
        chatCard.style.width = vv.width + "px";
        chatCard.style.height = vv.height + "px";
        chatCard.style.right = "auto";
        chatCard.style.bottom = "auto";
        chatCard.style.margin = "0";

        chatCard.classList.add("keyboard-mode");
        document.body.classList.add("chat-keyboard-mode");
        isKeyboardMode = true;

        if (wasAtBottom && box) box.scrollTop = box.scrollHeight;
    }

    function leaveKeyboardMode() {
        if (!isKeyboardMode) return;
        chatCard.classList.remove("keyboard-mode");
        document.body.classList.remove("chat-keyboard-mode");
        // เอา inline style ที่ใส่ไว้ตอน keyboard mode ออกให้หมด คืน layout เดิม 100% (ให้ CSS
        // breakpoint เดิมของ #chatCard เป็นคนคุมต่อ ไม่มี top/left/width/height/transform ค้าง)
        chatCard.style.position = "";
        chatCard.style.top = "";
        chatCard.style.left = "";
        chatCard.style.width = "";
        chatCard.style.height = "";
        chatCard.style.right = "";
        chatCard.style.bottom = "";
        chatCard.style.margin = "";
        isKeyboardMode = false;
    }

    // baseline = ความสูง visual viewport ตอน "ไม่มีคีย์บอร์ด" (จำไว้ขณะช่องพิมพ์ไม่ได้ focus)
    // เหตุผล: บน iPad/iOS บางกรณี window.innerHeight หดตาม visual viewport ตอนคีย์บอร์ดเปิด ทำให้
    // innerHeight - vv.height ได้ ~0 แล้ว detection พลาด — จึงเทียบกับ baseline ที่จำไว้ก่อน focus แทน
    // (ใช้ทั้งสองวิธีแล้วเอาค่าที่มากกว่า)
    let baseVVHeight = window.visualViewport.height;
    let baseVVWidth = window.visualViewport.width;

    function trackBaseline(vv) {
        // กำลังซูมนิ้ว (scale > 1) ทำให้ vv หดโดยไม่ใช่คีย์บอร์ด — ไม่เก็บ baseline ตอนนั้น
        if (vv.scale && vv.scale > 1.01) return;
        const widthChanged = Math.abs(vv.width - baseVVWidth) > 50; // หมุนจอ/ปรับขนาดหน้าต่าง
        // คีย์บอร์ดกำลังหุบ (blur แล้วแต่ viewport ยังเตี้ยอยู่) → height น้อยกว่า baseline เกิน threshold
        // และความกว้างเท่าเดิม = ห้ามเอามาเป็น baseline ใหม่
        if (widthChanged || vv.height >= baseVVHeight - KEYBOARD_THRESHOLD) {
            baseVVHeight = vv.height;
            baseVVWidth = vv.width;
        }
    }

    function update() {
        rafId = null;
        const vv = window.visualViewport;
        const focused = document.activeElement === chatInputEl;

        if (!focused) trackBaseline(vv);
        else if (Math.abs(vv.width - baseVVWidth) > 50) {
            // หมุนจอขณะพิมพ์อยู่: baseline เดิมใช้ไม่ได้ (ความสูงคนละแนว) → ใช้แค่วิธี innerHeight ไปก่อน
            baseVVHeight = vv.height;
            baseVVWidth = vv.width;
        }

        const kbByWindow = window.innerHeight - vv.height - vv.offsetTop;
        const kbByBaseline = baseVVHeight - vv.height;
        const keyboardHeight = Math.max(0, kbByWindow, kbByBaseline);
        // ต้อง focus + เป็น touch device + viewport หดลงเกิน threshold จริงๆ ร่วมกันถึงจะถือว่าคีย์บอร์ดเปิด
        const isOpen = focused && isTouchCapable && keyboardHeight > KEYBOARD_THRESHOLD;

        if (isOpen) enterKeyboardMode(vv);
        else leaveKeyboardMode();
    }

    function scheduleUpdate() {
        if (rafId !== null) return; // ยุบหลายอีเวนต์ติดกันเหลือแค่เฟรมเดียว กันอนิเมชั่นกระตุก
        rafId = requestAnimationFrame(update);
    }

    // focus/blur เช็คทันที ไม่ต้องรอ resize event ของ VisualViewport อย่างเดียว (บาง browser หน่วง
    // event นี้กว่าคีย์บอร์ดจะเด้ง/หุบเสร็จจริง) — listener ชุดเดียวจบทั้งหมดในไฟล์นี้ ไม่ซ้ำกับตัวเดิม
    chatInputEl.addEventListener("focus", scheduleUpdate);
    chatInputEl.addEventListener("blur", scheduleUpdate);
    window.visualViewport.addEventListener("resize", scheduleUpdate);
    window.visualViewport.addEventListener("scroll", scheduleUpdate);
    window.addEventListener("orientationchange", function () { setTimeout(scheduleUpdate, 300); });
    window.addEventListener("resize", scheduleUpdate, { passive: true });
})();
