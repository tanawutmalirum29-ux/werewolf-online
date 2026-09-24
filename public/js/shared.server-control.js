// shared.server-control.js
// ฝั่งผู้เล่น/โฮสต์ของปุ่มในหน้า admin.html แท็บ "จัดการระบบ" (ดู server.js หัวข้อ "เปิด/ปิดเซิร์ฟเวอร์ + บังคับรีโหลด")
// ใช้ในหน้า index / player / host (ไม่ใช้ใน admin.html)
//
// หลักการใหม่: "ปิด/เปิดเซิร์ฟเวอร์" และ "บังคับรีโหลดทุกแบบ" = จบเซสชันเดิมทั้งหมด
//   - server ปิดทุกห้องแบบเงียบ (ไม่นับสถิติ/ไม่นับ "ออกเกม" ให้ใคร — ดู closeAllRoomsSilently ใน server.js)
//   - ทุกเครื่อง (ผู้เล่น/โฮสต์) ถูกพากลับ "หน้าแรก (index)" เสมอ ไม่กลับเข้าห้องเดิม/ไม่ค้างอยู่หน้าเล่นเกม
//   - ก่อนกลับหน้าแรก ล้างเฉพาะ "ของที่ผูกกับห้อง/เซสชันเก่า" (ห้องล่าสุด, token, รหัสห้อง ฯลฯ — ดู clearSessionIdentity)
//     ชื่อที่ตั้งไว้ + สถานะผ่านรหัสโฮสต์/ผู้ทดสอบ "ไม่ถูกล้าง" (ไม่ต้องตั้งชื่อ/กรอกรหัสใหม่) ต่างจากปุ่ม "ล้างข้อมูลเกมทั้งหมด"
//     ที่ล้างทุกอย่างผ่าน shared.reset-guard.js
//
// ทำ 3 อย่าง
//
// 1) บังคับรีโหลด (ปุ่ม "ไฟล์เกม" / "รูปภาพ" / "ทั้งสอง") + ปิด/เปิดเซิร์ฟเวอร์ (kind = "session")
//    server มีเลข reloadEpoch (มากับ /api/config และ socket event "force_reload") ที่เปลี่ยนทุกครั้งที่แอดมินกดปุ่ม
//    หน้านี้จำเลขที่เห็นตอน "โหลดหน้า" ไว้ในตัวแปร (baseline) — ทำงานก็ต่อเมื่อเลขบน server "ไม่ตรงกับ baseline"
//    หน้าใหม่ (หน้าแรก) อ่านเลขล่าสุดมาเป็น baseline ของตัวเอง จึง "ทำครั้งเดียวต่อการกดหนึ่งครั้ง" ไม่มีทางวนลูป
//    (ไม่ได้เก็บเลขไว้ใน storage ตั้งใจ — เลขที่ค้างใน storage ต่างหากที่เป็นต้นเหตุของลูปแบบ "รีโหลดแล้วยังเห็นว่าไม่ตรง")
//    - server รีสตาร์ท → เลขกลายเป็นค่าว่าง → เมินเฉย (การ deploy/รีสตาร์ทไม่ใช่คำสั่งรีโหลด — แจ้งอัปเดตเฉพาะที่หน้า index.html ดู index.auto-update.js)
//    - ไม่เกี่ยวกับ data.version (version = เนื้อหาไฟล์ ใช้แจ้ง "มีรุ่นใหม่" ที่ index เท่านั้น ไม่เคยสั่ง reload)
//    - ห้องผู้ทดสอบ/ผู้ถือบัตรผู้ทดสอบ: server ไม่ส่ง force_reload/เลข epoch ใหม่ให้ (ดู /api/config + isProtectedRequest) จึงไม่ถูกพากลับหน้าแรก
//    - "ไฟล์เกม": ก่อนกลับหน้าแรกสั่ง fetch(..., {cache:"reload"}) ตัวหน้าปัจจุบัน + "หน้าแรกปลายทาง" + ทุก <script>/<link stylesheet>
//      ของทั้งสองหน้า เพื่อ "บังคับข้ามแคชจริงๆ" (รวมเคสเครื่องที่เคยโดน Cache-Control: immutable รุ่นเก่าค้างไว้) แล้วค่อยพาไปหน้าแรก
//    - "รูปภาพ": server ต่อท้าย URL รูปทุกใบด้วย ?v=<imageEpoch> → URL ใหม่ = โหลดรูปใหม่จริง (ดู wwImg ด้านล่าง)
//    - กระจายเวลาแบบสุ่ม ~0.4–1.9 วิ กันทุกเครื่องกระแทก server พร้อมกัน / มีตัวกันวนลูปสำรอง (สั่งการเกิน 3 ครั้ง/นาทีจะหยุด)
//
// 2) เซิร์ฟเวอร์ปิด (ปุ่ม "ปิดเซิร์ฟเวอร์")
//    ขึ้นจอเต็ม "เซิร์ฟเวอร์กำลังปิด" ทับทุกอย่างทันทีที่ได้ event server_closed / socket ถูกปฏิเสธ (connect_error = server_closed)
//    / หรือ /api/config บอก serverOpen=false แล้วเช็คสถานะทุก ~4 วิ พอ server เปิดคืนก็ "ล้างห้องที่จำไว้แล้วพากลับหน้าแรก"
//    (ห้องเดิมถูกปิดไปตั้งแต่ตอนกดปิดแล้ว จึงไม่มีอะไรให้ auto-rejoin) — ส่วน "รีเฟรชระหว่างปิดแล้วเข้าได้" ถูกกันที่ server
//    (ตอบหน้าปิดแทนทุกหน้าเกม)
//
// 2.5) แจ้งเตือนก่อนปิด (ปุ่ม "ปิดแบบนับถอยหลัง")
//    server ยังเปิดอยู่ เล่นได้ปกติ แต่ทุกเครื่องเห็นแถบเตือนด้านบน "จะปิดใน mm:ss" + ข้อความจากแอดมิน + เวลาที่คาดว่าจะเปิด
//    - หน้าแรก (index): โชว์แถบตลอดเวลาที่นับถอยหลังอยู่ (เหมือนเดิม)
//    - หน้าเกม (player/host): ปกติไม่โชว์ (กันรบกวนคนกำลังเล่น) ยกเว้นเหลือ <= 5 นาที → โผล่ 5 วิ ทุก 1 นาที
//      และเหลือ <= 1 นาที → โชว์ค้างตลอด (ดู shouldShowInGame / closingTick)
//    ได้ข้อมูลจาก socket event server_closing / server_closing_cancelled (เครื่องที่เล่นอยู่) และจาก /api/config
//    (closingInMs, noticeMessage, reopenAt — เครื่องที่ไม่ได้ต่อ socket เช่นหน้าแรก/เครื่องที่เพิ่งตื่น) ครบเวลาแล้ว server ปิดจริงเอง
//    จอ "กำลังปิด" ก็โชว์ข้อความ + เวลาที่คาดว่าจะเปิดเดียวกัน (อัปเดตตามที่แอดมินแก้ระหว่างปิดได้ ผ่านการโพลทุก ~4 วิ)
//    ข้อความของแอดมินโชว์ด้วย textContent เสมอ (ไม่ใช้ innerHTML) กัน HTML/สคริปต์แทรก
//
// 3) window.wwImg(path) — ประกอบ URL รูป = WW_IMG_BASE + path + ?v=<imageEpoch>
//    imageEpoch จำไว้ใน localStorage คีย์ wwx_img_ver (ไม่ขึ้นต้นด้วย "ww_" ตั้งใจ เพื่อไม่โดนล้างตอนแอดมินกดล้างข้อมูลเกม)
//    เพื่อให้รู้เลขรุ่นตั้งแต่เฟรมแรกก่อนที่ /api/config จะตอบกลับมา
//
// player.main.js / host.main.js ต่อ socket event เข้ามาที่ window.wwServerControl (ดูหัวไฟล์ทั้งสอง)
(function () {
    "use strict";

    // ===== กันหน้าค้างจาก bfcache (back-forward cache) =====
    // เบราว์เซอร์มือถือบางตัว พอกดปุ่ม "ย้อนกลับ" กลับมาหน้านี้ จะดึงหน้าเดิมที่ "แช่แข็ง" ไว้ตอนออกจากหน้า
    // (snapshot ก่อน navigate ไปหน้าอื่น) มาโชว์ทันทีโดยไม่รันโค้ด JS ใหม่เลย — หน้าตาเหมือนเดิมทุกอย่าง
    // แต่ event/ตัวแปรบางส่วนค้างอยู่ในสถานะ "กำลังจะออกจากหน้า" ทำให้กดปุ่มไม่ตอบสนอง
    // event "pageshow" พร้อม persisted=true คือสัญญาณว่าเจอ bfcache แบบนี้ → สั่ง reload จริงทันที
    // ได้หน้าสดๆ ทุกครั้ง ไม่ต้องมาหาสาเหตุเจาะจงว่าตัวแปร/handler ตัวไหนค้าง (กันเหมาทุกเคสในคราวเดียว)
    // หมายเหตุ: นี่ไม่ใช่การรีโหลดเพราะ "มีเวอร์ชันใหม่/อัปเดต/บำรุงรักษา" — เกิดเฉพาะตอนเบราว์เซอร์กู้หน้าจาก bfcache หลังผู้ใช้กดย้อนกลับ/ไปข้างหน้าเองเท่านั้น
    // (การสลับแอป/ล็อกจอ/ย้าย tab ไม่ทำให้เกิด pageshow persisted=true) จึงไม่รบกวนเกมที่กำลังเล่นอยู่
    window.addEventListener("pageshow", function (e) {
        if (e.persisted) location.reload();
    });

    var POLL_MS = 20000;         // เช็ค /api/config ปกติ (คนที่ต่อ socket อยู่ได้รับ event ทันทีอยู่แล้ว อันนี้กันตกหล่น + หน้าแรกที่ไม่มี socket)
    var CLOSING_POLL_MS = 5000;  // ระหว่างแถบ "จะปิดใน..." โชว์อยู่ เช็คถี่ขึ้น (กันพลาด event ยกเลิก/ปิดจริง)
    var CLOSED_POLL_MS = 4000;   // ระหว่างขึ้นจอ "กำลังปิด" เช็คถี่ขึ้นเพื่อกลับเข้าเกมไวหลังเปิด
    var IMG_VER_KEY = "wwx_img_ver";
    var RELOAD_LOG_KEY = "wwx_reload_log";
    var TESTER_SESSION_KEY = "ww_tester_launch_id";
    var TESTER_ADMIN_CONTROLLER_KEY = "ww_tester_admin_controller_id";

    // แท็บผู้ทดสอบเปิดจาก admin.html ต้องมี opener ไว้สำหรับ "กลับแท็บเดิม + ปิดแท็บทดสอบ"
    // แต่การเปิดแบบมี opener ตามมาตรฐานสามารถทำให้ sessionStorage ถูก clone จากแท็บ admin ได้
    // จึงใช้ launch id ที่ไม่ซ้ำกันเป็นสัญญาณว่าเป็นการเปิดแท็บทดสอบครั้งแรก แล้วล้าง sessionStorage
    // เฉพาะครั้งแรกของ launch นั้น ก่อน host.main.js/player.main.js จะอ่าน token ใด ๆ
    var testerPageRequested = false;
    var testerLaunchId = "";
    var testerAdminControllerId = "";
    var testerHostControllerId = "";
    var testerIsHostPage = false;
    try {
        var testerQs = new URLSearchParams(window.location.search);
        testerPageRequested = testerQs.get("tester") === "1";
        testerLaunchId = testerQs.get("ts") || "";
        testerAdminControllerId = testerQs.get("ac") || "";
        testerHostControllerId = testerQs.get("hc") || "";
        testerIsHostPage = /\/host(?:\.html)?$/i.test(String(window.location.pathname || ""));
        if (testerPageRequested && testerLaunchId) {
            var oldLaunchId = sessionStorage.getItem(TESTER_SESSION_KEY);
            if (oldLaunchId !== testerLaunchId) {
                sessionStorage.clear();
                sessionStorage.setItem(TESTER_SESSION_KEY, testerLaunchId);
            }
        }
    } catch (e) {
        // storage/URL API ใช้ไม่ได้ — ปล่อยให้ main.js ใช้ fallback ตามปกติ
    }

    // บอทที่ถูกสิงส่งสัญญาณกลับมาหา Host controller โดยตรงเป็นเส้นทางสำรอง
    // นอกเหนือจาก window.opener — ช่วยกรณี iPad/Chrome เปลี่ยน opener ตอน blank -> navigate
    // แต่ห้ามให้เส้นทางนี้นำทางไปเปิด host.html ใหม่ เพราะ Host เดิมยังเป็นศูนย์ควบคุมอยู่แล้ว
    function focusTesterHostController() {
        try { window.focus(); } catch (e) {}
    }
    if (testerPageRequested && testerIsHostPage && testerHostControllerId) {
        try {
            if (typeof BroadcastChannel !== "undefined") {
                var hostReturnChannel = new BroadcastChannel("ww_tester_host_" + testerHostControllerId);
                hostReturnChannel.onmessage = function (event) {
                    var d = event && event.data;
                    if (d && d.type === "tester_return_to_host") focusTesterHostController();
                };
                window.addEventListener("beforeunload", function () { try { hostReturnChannel.close(); } catch (e) {} });
            }
        } catch (e) {}
        window.addEventListener("storage", function (event) {
            if (event.key !== "ww_tester_return_host_" + testerHostControllerId || !event.newValue) return;
            try {
                var d = JSON.parse(event.newValue);
                if (d && d.type === "tester_return_to_host") focusTesterHostController();
            } catch (e) {}
        });
    }

    var baselineEpoch = null;    // null = ยังไม่เคยอ่าน /api/config สำเร็จในหน้านี้
    var reloading = false;
    var closedShown = false;
    var pollTimer = null;

    // ประกาศจากแอดมิน (ดูหัวข้อ 2.5 ด้านบน)
    var clockSkew = 0;           // เวลา server - เวลาเครื่องนี้ (ms) ไว้คำนวณ "อีกกี่นาทีจะเปิด" ให้ตรงแม้นาฬิกาเครื่องเพี้ยน
    var closedInfo = { message: "", reopenAt: 0 };
    // true = server ยืนยันจาก cookie/room token ว่าแท็บนี้เป็นผู้ทดสอบ
    // โหมดนี้ต้องไม่รับผลของการปิด/นับถอยหลัง/force-reload ของเซิร์ฟเวอร์หลัก
    var testerShielded = false;
    var closingActive = false;   // กำลังโชว์แถบ "จะปิดใน..." อยู่หรือไม่
    var closingEndsAt = 0;       // เวลา (นาฬิกาเครื่องนี้) ที่จะปิด — ได้จาก "เวลาที่เหลือ" ที่ server ส่งมา + เวลาที่รับ
    var closingInfo = { message: "", reopenAt: 0 };
    var closingTicker = null;
    var lastFastCheckAt = 0;

    // ---------- กติกาแถบเตือนบนหน้าเกม (player/host) ----------
    // หน้าแรก (index) = เห็นแถบตลอดเวลาที่นับถอยหลังอยู่ (เหมือนเดิม)
    // หน้าเกม (player/host) = ปกติไม่โชว์ (กันรบกวนคนกำลังเล่น) ยกเว้น
    //   - เหลือ <= 5 นาที: โผล่มา 5 วิ ทุกๆ 1 นาที (นับจากจุดที่เข้าเขต 5 นาที ไม่ใช่นาฬิกาปัดเศษ)
    //   - เหลือ <= 1 นาที: โชว์ค้างตลอดเวลา
    var FIVE_MIN_MS = 5 * 60000;
    var ONE_MIN_MS = 60000;
    var PULSE_SHOW_MS = 5000;
    var PULSE_PERIOD_MS = 60000;

    function shouldShowInGame(remainMs) {
        if (remainMs <= 0) return true; // ครบเวลาแล้วแต่ยังไม่ได้ event ปิดจริง โชว์ไว้ก่อน
        if (remainMs <= ONE_MIN_MS) return true;
        if (remainMs > FIVE_MIN_MS) return false;
        var sinceFiveMin = FIVE_MIN_MS - remainMs; // เวลาที่ผ่านมาแล้วนับจากเข้าเขต 5 นาที
        return (sinceFiveMin % PULSE_PERIOD_MS) < PULSE_SHOW_MS;
    }

    // ---------- wwImg ----------
    function readImgVer() {
        try { return localStorage.getItem(IMG_VER_KEY) || ""; } catch (e) { return ""; }
    }
    window.WW_IMG_VER = readImgVer();

    function rememberImgVer(v) {
        // ค่าว่างจาก server (เช่น เพิ่งรีสตาร์ทแล้วโหลด DB ไม่ได้) ไม่เคยไปล้างค่าที่จำไว้ — ไม่งั้น URL รูปจะย้อนกลับไปแบบเก่าที่แคชค้าง
        if (typeof v !== "string" || v === "" || v === window.WW_IMG_VER) return;
        window.WW_IMG_VER = v;
        try { localStorage.setItem(IMG_VER_KEY, v); } catch (e) { /* ไม่เป็นไร */ }
    }

    window.wwImg = function (path) {
        var base = typeof window.WW_IMG_BASE === "string" ? window.WW_IMG_BASE : "";
        if (!base) return "";
        var v = window.WW_IMG_VER;
        return base + path + (v ? "?v=" + encodeURIComponent(v) : "");
    };

    // ---------- UI ----------
    function ensureStyle() {
        if (document.getElementById("wwServerControlStyle")) return;
        var st = document.createElement("style");
        st.id = "wwServerControlStyle";
        st.textContent =
            "@keyframes wwScDot{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}" +
            "@keyframes wwScSpin{to{transform:rotate(360deg)}}" +
            "#wwClosedOverlay .wwScDots span{display:inline-block;width:9px;height:9px;margin:0 4px;border-radius:50%;background:#7c5cff;animation:wwScDot 1.3s infinite ease-in-out}" +
            "#wwClosedOverlay .wwScDots span:nth-child(2){animation-delay:.2s}" +
            "#wwClosedOverlay .wwScDots span:nth-child(3){animation-delay:.4s}" +
            "#wwTesterUpdateNotice{position:fixed;z-index:2147483000;left:max(14px,env(safe-area-inset-left));right:max(14px,env(safe-area-inset-right));top:max(14px,env(safe-area-inset-top));display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid rgba(255,224,120,.55);border-radius:14px;background:rgba(20,17,8,.94);box-shadow:0 12px 34px rgba(0,0,0,.3);color:#fff7d0;font:600 14px/1.3 system-ui,sans-serif;backdrop-filter:blur(12px)}" +
            "#wwTesterUpdateNotice .wwTuText{flex:1;min-width:0}#wwTesterUpdateNotice .wwTuBtn{border:0;border-radius:10px;padding:9px 12px;background:#ffe68c;color:#211b08;font-weight:800;cursor:pointer;white-space:nowrap}#wwTesterUpdateNotice .wwTuClose{border:0;background:transparent;color:#fff7d0;font-size:18px;cursor:pointer;padding:4px}";
        (document.head || document.documentElement).appendChild(st);
    }

    function noteServerNow(n) {
        if (typeof n === "number" && n > 0) clockSkew = n - Date.now();
    }
    function serverNow() { return Date.now() + clockSkew; }

    function fmtMins(mins) {
        if (mins < 60) return mins + " นาที";
        var h = Math.floor(mins / 60), m = mins % 60;
        return h + " ชม." + (m ? " " + m + " นาที" : "");
    }

    // "คาดว่าจะเปิดประมาณ 15:30 น. (อีกประมาณ 12 นาที)" — ว่าง = แอดมินไม่ได้ระบุเวลา
    function etaText(reopenAt) {
        if (!reopenAt) return "";
        var d = new Date(reopenAt);
        var clock;
        try {
            clock = d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });
            if (d.toDateString() !== new Date(serverNow()).toDateString()) {
                clock = d.toLocaleDateString("th-TH", { day: "numeric", month: "short" }) + " " + clock;
            }
        } catch (e) {
            clock = d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2);
        }
        var mins = Math.ceil((reopenAt - serverNow()) / 60000);
        if (mins <= 0) return "เลยเวลาที่คาดไว้แล้ว — กำลังรอแอดมินเปิด";
        return "คาดว่าจะเปิดประมาณ " + clock + " น. (อีกประมาณ " + fmtMins(mins) + ")";
    }

    function fmtCountdown(ms) {
        var sec = Math.max(0, Math.ceil(ms / 1000));
        var m = Math.floor(sec / 60), r = sec % 60;
        return m + ":" + (r < 10 ? "0" : "") + r;
    }

    // ---------- แถบเตือน "เซิร์ฟเวอร์จะปิดใน mm:ss" ----------
    function renderClosingBanner() {
        var el = document.getElementById("wwClosingBanner");
        if (!el) return;
        var remain = closingEndsAt - Date.now();
        el.querySelector(".wwCbTitle").textContent = remain > 0
            ? "⚠️ เซิร์ฟเวอร์จะปิดใน " + fmtCountdown(remain)
            : "🔧 กำลังปิดเซิร์ฟเวอร์...";
        var msg = el.querySelector(".wwCbMsg");
        msg.textContent = closingInfo.message || "";
        msg.style.display = closingInfo.message ? "block" : "none";
        var eta = etaText(closingInfo.reopenAt);
        el.querySelector(".wwCbNote").textContent =
            "ทุกห้องที่กำลังเล่นอยู่จะถูกปิด และทุกคนจะกลับหน้าแรกเมื่อเปิดคืน" + (eta ? " · " + eta : "");
    }

    function closingTick() {
        var el = document.getElementById("wwClosingBanner");
        if (el) {
            var show = isHomePage() || shouldShowInGame(closingEndsAt - Date.now());
            if (show) {
                el.style.display = "";
                renderClosingBanner();
            } else {
                el.style.display = "none";
            }
        }
        // เวลาครบแล้วแต่ยังไม่ได้ event/สถานะปิด (เช่น เครื่องหน้าแรกที่ไม่มี socket) → เช็ค /api/config ถี่ๆ จนกว่าจะรู้
        if (closingEndsAt - Date.now() <= 0 && Date.now() - lastFastCheckAt > 2000) {
            lastFastCheckAt = Date.now();
            check();
        }
    }

    function showClosing(inMs, message, reopenAt) {
        if (closedShown || reloading || !(inMs > 0)) return;
        // server ส่ง 1 ms เมื่อเวลาครบแล้วแต่ยังไม่ปิดจริง — ถ้าแถบนับถึง 0 อยู่แล้วให้คงสถานะ "กำลังปิด..." ไว้ ไม่รีเซ็ตกลับไปนับใหม่
        if (closingActive && inMs <= 1) return;
        closingEndsAt = Date.now() + inMs;
        closingInfo = { message: message || "", reopenAt: reopenAt || 0 };
        if (!document.getElementById("wwClosingBanner")) {
            var el = document.createElement("div");
            el.id = "wwClosingBanner";
            el.setAttribute("role", "alert");
            el.style.cssText =
                "display:none;position:fixed;left:0;right:0;top:0;z-index:2147482500;text-align:center;color:#fff;" +
                "padding:calc(env(safe-area-inset-top,0px) + 8px) 14px 9px;" +
                "background:linear-gradient(135deg,#d97706,#b45309);box-shadow:0 4px 16px rgba(0,0,0,.45);" +
                "font-family:'IBM Plex Sans Thai','Noto Sans Thai',system-ui,sans-serif;line-height:1.45;" +
                "pointer-events:none;-webkit-user-select:none;user-select:none;";
            el.innerHTML =
                '<div class="wwCbTitle" style="font-size:15px;font-weight:700"></div>' +
                '<div class="wwCbMsg" style="font-size:13.5px;font-weight:600;margin-top:2px;word-break:break-word"></div>' +
                '<div class="wwCbNote" style="font-size:12px;opacity:.9;margin-top:2px"></div>';
            (document.body || document.documentElement).appendChild(el);
        }
        var wasActive = closingActive;
        closingActive = true;
        closingTick(); // ตัดสินใจทันทีว่าโชว์/ซ่อน (หน้าแรกโชว์เสมอ, หน้าเกมดูตามกฎ 5 นาที/1 นาที)
        if (!closingTicker) closingTicker = setInterval(closingTick, 500);
        if (!wasActive) schedulePoll(); // ระหว่างนับถอยหลังโพลถี่ขึ้น กันพลาดตอนแอดมินยกเลิก
    }

    function showTempToast(text, ms) {
        var t = document.createElement("div");
        t.style.cssText =
            "position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);transform:translateX(-50%);z-index:2147482600;" +
            "background:#166534;color:#fff;padding:11px 18px;border-radius:12px;font-size:14px;font-weight:600;" +
            "box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:'IBM Plex Sans Thai',system-ui,sans-serif;" +
            "max-width:90vw;text-align:center;pointer-events:none;";
        t.textContent = text;
        (document.body || document.documentElement).appendChild(t);
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 4000);
    }

    // notify = true → บอกผู้เล่นว่าแอดมินยกเลิกการปิดแล้ว (เล่นต่อได้)
    function hideClosing(notify) {
        if (closingTicker) { clearInterval(closingTicker); closingTicker = null; }
        var el = document.getElementById("wwClosingBanner");
        if (el && el.parentNode) el.parentNode.removeChild(el);
        var was = closingActive;
        closingActive = false;
        if (was) schedulePoll();
        if (was && notify) showTempToast("✅ แอดมินยกเลิกการปิดเซิร์ฟเวอร์ — เล่นต่อได้ตามปกติ", 4500);
    }

    // ---------- ข้อความ/เวลาที่คาดว่าจะเปิด บนจอ "กำลังปิด" ----------
    function renderClosedInfo() {
        var msg = document.getElementById("wwClosedMsg");
        var eta = document.getElementById("wwClosedEta");
        if (msg) {
            msg.textContent = closedInfo.message || "";
            msg.style.display = closedInfo.message ? "block" : "none";
        }
        if (eta) {
            var t = etaText(closedInfo.reopenAt);
            eta.textContent = t;
            eta.style.display = t ? "block" : "none";
        }
    }

    // ---------- ลิสต์คำอธิบายอาชีพ บนจอ "กำลังปิด" (ให้มีอะไรเลื่อนอ่านระหว่างรอ) ----------
    // แหล่งข้อมูล: (1) window.wwRolesData ที่ player.main.js/host.main.js เก็บไว้ตอนรับ socket "roles_data" ก่อนปิด (ถ้ามี)
    //              (2) ไม่มี (หน้าเพิ่งโหลดสด/index/ไม่เคยเข้าเกม/localStorage ว่าง/เข้าผ่าน iPad ตอนปิดอยู่พอดี) → ขอเองจาก GET /api/roles-data
    //                  ซึ่ง server เปิดให้ผ่านด่านตอนปิดเซิร์ฟเวอร์ (ไม่ต้อง login, ไม่ผูกห้อง) — ต้องไม่พึ่ง socket/storage เลย
    var rolesFetchState = 0; // 0 = ยังไม่ขอ, 1 = กำลังขอ, 2 = ได้แล้ว
    function renderClosedRoles() {
        var box = document.getElementById("wwClosedRoles");
        var list = document.getElementById("wwClosedRolesList");
        if (!box || !list) return;
        var data = window.wwRolesData;
        if (!data || typeof data !== "object") {
            box.style.display = "none";
            if (rolesFetchState === 0) {
                rolesFetchState = 1;
                fetch("/api/roles-data", { cache: "no-store" })
                    .then(function (r) { if (!r.ok) throw new Error("bad_status"); return r.json(); })
                    .then(function (d) {
                        if (d && typeof d === "object") { window.wwRolesData = d; rolesFetchState = 2; renderClosedRoles(); }
                        else rolesFetchState = 0;
                    })
                    .catch(function () { rolesFetchState = 0; /* เน็ตสะดุด — รอบโพลถัดไป (โชว์ closed ทุก ~4 วิ) จะลองใหม่ */ });
            }
            return;
        }

        var keys = Object.keys(data).filter(function (k) { return k.indexOf("__") !== 0; });
        if (keys.length === 0) { box.style.display = "none"; return; }
        if (list.childElementCount > 0) { box.style.display = "block"; return; } // เรนเดอร์ครั้งเดียวพอ ข้อมูลไม่เปลี่ยนระหว่างปิด

        var html = keys.map(function (role) {
            var info = data[role];
            var title = role, desc = "ยังไม่มีคำอธิบาย", icon = "";
            if (info && typeof info === "object") {
                title = (info.title || role).replace(/<img[^>]*>/gi, "").trim() || role;
                desc = info.desc || info.description || desc;
                icon = info.icon || "";
            } else if (typeof info === "string") {
                desc = info;
            }
            return (
                '<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.08)">' +
                (icon
                    ? '<img src="' + icon + '" alt="" style="width:32px;height:32px;border-radius:8px;object-fit:cover;flex:0 0 auto" onerror="this.style.display=\'none\'">'
                    : "") +
                '<div style="min-width:0">' +
                '<div style="font-size:13.5px;font-weight:700;margin-bottom:2px">' + title + "</div>" +
                '<div style="font-size:12.5px;line-height:1.55;color:rgba(255,255,255,.75)">' + desc + "</div>" +
                "</div></div>"
            );
        }).join("");

        list.innerHTML = html;
        box.style.display = "block";
    }

    // info = { message, reopenAt } จาก event server_closed หรือ /api/config (เรียกซ้ำได้เพื่ออัปเดตข้อความตอนแอดมินแก้)
    function showClosed(info) {
        if (info) closedInfo = { message: info.message || "", reopenAt: info.reopenAt || 0 };
        if (closedShown) { renderClosedInfo(); renderClosedRoles(); return; }
        closedShown = true;
        hideClosing(false);
        ensureStyle();

        var el = document.createElement("div");
        el.id = "wwClosedOverlay";
        el.setAttribute("role", "alert");
        el.style.cssText =
            "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;overflow-y:auto;" +
            "display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;" +
            "background:radial-gradient(circle at 50% 28%,#1b2440 0%,#0b0f19 72%);color:#fff;" +
            "font-family:'IBM Plex Sans Thai','Noto Sans Thai',system-ui,sans-serif;" +
            "touch-action:pan-y;-webkit-overflow-scrolling:touch;-webkit-user-select:none;user-select:none;";
        el.innerHTML =
            '<div style="max-width:420px;max-height:100%;display:flex;flex-direction:column;align-items:center">' +
            '<div style="font-size:56px;line-height:1;margin-bottom:14px">🔧</div>' +
            '<div style="font-size:24px;font-weight:700;margin-bottom:10px">เซิร์ฟเวอร์กำลังปิด</div>' +
            '<div style="font-size:15px;line-height:1.7;color:rgba(255,255,255,.72);margin-bottom:22px">' +
            "ตอนนี้ยังเข้าเกมไม่ได้ (รีเฟรชก็ไม่ได้)<br>เมื่อเซิร์ฟเวอร์เปิดอีกครั้ง ระบบจะพาคุณกลับหน้าแรกให้อัตโนมัติ" +
            "</div>" +
            '<div id="wwClosedMsg" style="display:none;font-size:16px;font-weight:600;line-height:1.6;margin:-6px 0 12px;padding:10px 14px;border-radius:12px;background:rgba(255,255,255,.08);word-break:break-word"></div>' +
            '<div id="wwClosedEta" style="display:none;font-size:14px;color:#c9bcff;margin:0 0 20px"></div>' +
            '<div class="wwScDots" style="margin-bottom:18px"><span></span><span></span><span></span></div>' +
            '<div id="wwClosedRoles" style="display:none;width:100%;text-align:left;max-height:34vh;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;background:rgba(255,255,255,.06);border-radius:12px;padding:10px 14px;">' +
            '<div style="font-size:12.5px;font-weight:700;color:rgba(255,255,255,.85);margin-bottom:6px">📖 เลื่อนอ่านคำอธิบายอาชีพระหว่างรอได้</div>' +
            '<div id="wwClosedRolesList"></div>' +
            "</div>" +
            "</div>";
        (document.body || document.documentElement).appendChild(el);
        renderClosedInfo();
        renderClosedRoles();
        try { document.documentElement.style.overflow = "hidden"; } catch (e) { /* ไม่เป็นไร */ }

        schedulePoll(); // สลับไปเช็คถี่
    }

    function showToast(text) {
        if (document.getElementById("wwReloadToast")) return;
        var t = document.createElement("div");
        t.id = "wwReloadToast";
        t.style.cssText =
            "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147482000;" +
            "background:#1f2937;color:#fff;padding:12px 20px;border-radius:12px;font-size:14px;" +
            "box-shadow:0 8px 24px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.12);" +
            "font-family:'IBM Plex Sans Thai',system-ui,sans-serif;max-width:90vw;text-align:center;";
        t.textContent = text;
        (document.body || document.documentElement).appendChild(t);
    }

    // ---------- ล้างตัวตนเซสชันเกม ----------
    // คีย์ที่ผูกกับ "ห้อง/เซสชันที่จบไปแล้ว" — ต้องล้างก่อนพากลับหน้าแรกเสมอ ไม่งั้นหน้าเกมจะพยายามกลับเข้าห้องเดิม/เดาห้องเก่า
    //   ww_joinedRoom / ww_lastRoom : ห้องที่ผู้เล่นเข้าอยู่/ห้องล่าสุด (auto-rejoin, auto-fill)
    //   ww_token / ww_host_token    : ตัวตนผู้เล่น/โฮสต์ในห้องนั้น
    //   ww_host_room / ww_bot_tokens: ห้องที่โฮสต์คุมอยู่ + token บอทของห้องนั้น
    //   ww_room_pass_* / ww_room_joincode_* : รหัสผ่าน/รหัสเข้าร่วมของห้องที่จำไว้ (ห้องตายแล้ว ใช้ไม่ได้อีก)
    // ไม่ล้าง: ww_playerName / ww_host_display_name (ชื่อที่ตั้งไว้),
    //         ww_reset_epoch (ของ reset-guard), wwx_* — ผู้เล่นไม่ต้องตั้งชื่อ/กรอกรหัสใหม่ แค่กลับมาหน้าแรกตามปกติ
    var SESSION_KEYS = ["ww_joinedRoom", "ww_lastRoom", "ww_token", "ww_host_room", "ww_host_token", "ww_bot_tokens"];
    var SESSION_PREFIXES = ["ww_room_pass_", "ww_room_joincode_"];

    function clearSessionIdentity() {
        // ล้างทั้ง localStorage (โหมดปกติ) และ sessionStorage (โหมดผู้ทดสอบเก็บ token ต่อแท็บไว้ที่นี่)
        ["localStorage", "sessionStorage"].forEach(function (name) {
            try {
                var store = window[name];
                SESSION_KEYS.forEach(function (k) { store.removeItem(k); });
                var keys = [];
                for (var i = 0; i < store.length; i++) keys.push(store.key(i));
                keys.forEach(function (k) {
                    if (k && SESSION_PREFIXES.some(function (p) { return k.indexOf(p) === 0; })) store.removeItem(k);
                });
            } catch (e) { /* เบราว์เซอร์บล็อก storage — ข้าม */ }
        });
    }

    function isHomePage() {
        var p = location.pathname;
        return p === "/" || /\/index\.html$/.test(p);
    }

    // ---------- รีโหลด / กลับหน้าแรก ----------
    // ตัวกันวนลูปสำรอง: การสั่งการที่ "แอดมินสั่ง" เกิน 3 ครั้งในหนึ่งนาทีของแท็บนี้ = ผิดปกติ หยุดเลย (ปกติต่อการกดหนึ่งครั้งเกิดแค่ 1 ครั้ง)
    function tooManyReloads() {
        try {
            var now = Date.now();
            var log = JSON.parse(sessionStorage.getItem(RELOAD_LOG_KEY) || "[]").filter(function (t) { return now - t < 60000; });
            if (log.length >= 3) return true;
            log.push(now);
            sessionStorage.setItem(RELOAD_LOG_KEY, JSON.stringify(log));
        } catch (e) { /* storage ใช้ไม่ได้ก็ไม่เป็นไร ปล่อยผ่าน */ }
        return false;
    }

    // พากลับปลายทางหลังจบเซสชัน — หน้าเกมปกติล้างห้อง/token แล้วกลับ index
    // แต่แท็บผู้ทดสอบใช้ admin.html เดิมเป็นศูนย์ควบคุม จึงต้องโฟกัส opener และปิดแท็บทดสอบแทน
    // ถ้าอยู่หน้าแรกอยู่แล้วก็แค่รีโหลด (เอาไฟล์ใหม่ + เริ่มหน้าสะอาด) — ไม่ใช้ replace("/") เพราะจะไม่ทำอะไรเลยเมื่อ URL เหมือนเดิม
    // เครื่องออฟไลน์อยู่พอดี → อย่าไปหน้า error ของเบราว์เซอร์ รอจนเน็ตกลับมา (เหมือน wwSafeReload ใน *.auto-update.js)
    function clearTesterSessionIdentity() {
        // ห้ามแตะ localStorage ของแท็บ admin/ผู้ใช้จริง — tester ใช้ sessionStorage ของแท็บตัวเองเป็นหลัก
        try {
            SESSION_KEYS.forEach(function (k) { sessionStorage.removeItem(k); });
            var keys = [];
            for (var i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i));
            keys.forEach(function (k) {
                if (k && SESSION_PREFIXES.some(function (prefix) { return k.indexOf(prefix) === 0; })) sessionStorage.removeItem(k);
            });
            sessionStorage.removeItem(TESTER_SESSION_KEY);
        } catch (e) { /* storage ใช้ไม่ได้ — ปิดแท็บต่อได้ */ }
    }

    // ---------- สายบังคับบัญชาแท็บผู้ทดสอบ ----------
    // อย่าเชื่อ window.opener ว่าเป็น Admin/Host โดยอัตโนมัติ เพราะเมื่อมีหลายแท็บ tester
    // browser/WebView บางตัวอาจทำให้ opener ชี้ไปแท็บ tester รุ่นพี่ได้
    function getSafeOpener(startWindow) {
        try {
            var w = startWindow || window.opener;
            if (!w || w === window || w.closed) return null;
            return w;
        } catch (e) { return null; }
    }

    function getWindowPath(w) {
        try { return String(w.location.pathname || ""); } catch (e) { return ""; }
    }

    function getWindowSearch(w) {
        try { return String(w.location.search || ""); } catch (e) { return ""; }
    }

    function isAdminWindow(w) {
        return /\/admin(?:\.html)?$/i.test(getWindowPath(w));
    }

    function isTesterHostWindow(w) {
        if (!/\/host(?:\.html)?$/i.test(getWindowPath(w))) return false;
        try {
            return new URLSearchParams(getWindowSearch(w)).get("tester") === "1";
        } catch (e) { return false; }
    }

    function findInOpenerChain(predicate, maxDepth) {
        var w = getSafeOpener();
        var seen = [];
        var depth = 0;
        var limit = Number.isFinite(maxDepth) ? Math.max(1, maxDepth) : 8;
        while (w && depth < limit) {
            if (seen.indexOf(w) !== -1) break;
            seen.push(w);
            try { if (predicate(w)) return w; } catch (e) {}
            var next = null;
            try { next = w.opener; } catch (e) {}
            if (!next || next === w || next === window) break;
            try { if (next.closed) break; } catch (e) {}
            w = next;
            depth += 1;
        }
        return null;
    }

    function focusAndCloseSelf(target) {
        if (!target || target === window) return false;
        try { target.focus(); } catch (e) {}
        try { window.close(); } catch (e) {}
        try { window.open("", "_self"); window.close(); } catch (e) {}
        return true;
    }

    function findTesterAdminWindow() {
        return findInOpenerChain(isAdminWindow, 8);
    }

    function findTesterHostWindow() {
        return findInOpenerChain(isTesterHostWindow, 8);
    }

    function notifyTesterAdminController() {
        if (!testerAdminControllerId) return false;
        var message = {
            type: "tester_return_to_admin",
            launchId: testerLaunchId || "",
            at: Date.now(),
        };
        var delivered = false;
        try {
            if (typeof BroadcastChannel !== "undefined") {
                var channel = new BroadcastChannel("ww_tester_admin_" + testerAdminControllerId);
                channel.postMessage(message);
                channel.close();
                delivered = true;
            }
        } catch (e) {}
        // storage event เป็น fallback ข้ามแท็บที่เรียบง่ายและใช้ได้ใน browser รุ่นเก่ากว่า
        // โดย key มี controller ID จึงไม่มี Admin ตัวอื่นรับข้อความผิดตัว
        try {
            var key = "ww_tester_return_" + testerAdminControllerId;
            localStorage.setItem(key, JSON.stringify(message));
            // อย่าลบทันที: storage event ของอีกแท็บถูก dispatch แบบ asynchronous
            setTimeout(function () {
                try { localStorage.removeItem(key); } catch (e) {}
            }, 1500);
            delivered = true;
        } catch (e) {}
        return delivered;
    }

    function closeSelfAfterControllerNotify() {
        // ไม่ต้องพยายาม focus opener ที่อาจเป็น Host คนอื่น — Admin จะ focus ตัวเองจาก BroadcastChannel
        try { window.close(); } catch (e) {}
        try { window.open("", "_self"); window.close(); } catch (e) {}
    }

    function returnTesterToAdmin() {
        clearTesterSessionIdentity();
        // Primary path: แจ้ง Admin controller โดยตรง ไม่พึ่ง opener เลย
        if (notifyTesterAdminController()) {
            closeSelfAfterControllerNotify();
            return;
        }
        // Secondary path: เดินย้อน opener chain เผื่อ BroadcastChannel ใช้ไม่ได้ใน WebView รุ่นเก่า
        var admin = findTesterAdminWindow();
        if (focusAndCloseSelf(admin)) return;
        window.location.replace("/admin.html");
    }

    function notifyTesterHostController() {
        if (!testerHostControllerId) return false;
        var message = { type: "tester_return_to_host", at: Date.now() };
        var delivered = false;
        try {
            if (typeof BroadcastChannel !== "undefined") {
                var channel = new BroadcastChannel("ww_tester_host_" + testerHostControllerId);
                channel.postMessage(message);
                channel.close();
                delivered = true;
            }
        } catch (e) {}
        try {
            var key = "ww_tester_return_host_" + testerHostControllerId;
            localStorage.setItem(key, JSON.stringify(message));
            setTimeout(function () { try { localStorage.removeItem(key); } catch (e) {} }, 1500);
            delivered = true;
        } catch (e) {}
        return delivered;
    }

    function returnTesterToHost() {
        clearTesterSessionIdentity();
        // เส้นทางหลักของบอท: แจ้ง Host เดิมโดยตรงแล้วปิดแท็บ — ห้าม navigate ไป host.html
        // เพราะจะสร้าง Host ใหม่และแยก session/h้องออกจาก Host ที่กำลังคุมอยู่
        if (testerHostControllerId && notifyTesterHostController()) {
            closeSelfAfterControllerNotify();
            return;
        }
        // Bot tab ต้องกลับ Host ก่อนเสมอ — ห้ามแจ้ง Admin เป็นเส้นทางแรก
        var host = findTesterHostWindow();
        if (focusAndCloseSelf(host)) return;
        // ถ้า Host หายไปแล้ว จึงใช้ Admin controller เป็นศูนย์สำรอง
        if (notifyTesterAdminController()) {
            closeSelfAfterControllerNotify();
            return;
        }
        var admin = findTesterAdminWindow();
        if (focusAndCloseSelf(admin)) return;
        window.location.replace("/admin.html");
    }

    function goHome(forceNetwork) {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
            window.addEventListener("online", function () { goHome(forceNetwork); }, { once: true });
            return;
        }
        // เส้นทางของแท็บผู้ทดสอบไม่เคยเข้า index.html — ศูนย์ควบคุมของมันคือ admin.html
        if (testerPageRequested) {
            returnTesterToAdmin();
            return;
        }
        clearSessionIdentity();
        if (forceNetwork) {
            // เปลี่ยน URL ด้วย nonce ใหม่ทุกครั้ง เพื่อกัน browser bfcache/service-worker/cache key เดิม
            // หลังจาก refreshAssetCache พยายามดึง resource รุ่นใหม่แล้ว หน้าแรกต้องเป็น request ใหม่อีกชั้น
            var target = isHomePage() ? (location.pathname || "/") : "/";
            try {
                var url = new URL(target, location.origin);
                url.searchParams.set("_ww_force", String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8));
                location.replace(url.pathname + url.search + url.hash);
            } catch (e) {
                location.replace(target);
            }
            return;
        }
        if (isHomePage()) location.reload();
        else location.replace("/");
    }

    // บังคับดึงหน้านี้ + "หน้าแรกปลายทาง" + สคริปต์/สไตล์ของทั้งสองหน้าใหม่จากเครือข่ายจริงๆ
    // (cache: "reload" = ข้ามแคชแล้ว "เขียนทับ" แคชด้วยของใหม่) — ต้องรวมหน้าแรกด้วย เพราะตอนนี้ปลายทางคือหน้าแรก ไม่ใช่หน้าเดิม
    // ต้องอ่าน body ให้จบด้วย ไม่งั้นเบราว์เซอร์อาจยังเขียนแคชไม่เสร็จตอนที่เราไปต่อ; รอไม่เกิน 12 วิ แล้วไปต่อไม่ว่าจะเสร็จหรือไม่
    function refreshAssetCache(kind) {
        var seen = {};
        var freshUrls = [];
        var forceNonce = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 7);
        var wantFiles = kind === "files" || kind === "both";
        var wantImages = kind === "images" || kind === "both";
        function add(u, base) {
            try {
                var a = new URL(u, base || location.href);
                if (a.origin !== location.origin) return;
                a.hash = "";
                a.searchParams.set("_ww_force", forceNonce);
                var key = a.href;
                if (!seen[key]) { seen[key] = 1; freshUrls.push(key); }
            } catch (e) {}
        }
        function fetchFreshText(u) {
            try {
                var a = new URL(u, location.href);
                a.searchParams.set("_ww_force", forceNonce);
                u = a.href;
            } catch (e) {}
            return fetch(u, { cache: "reload", credentials: "same-origin" })
                .then(function (r) { return r.text().then(function (text) { return { ok:r.ok, text:text, url:u }; }); })
                .catch(function () { return null; });
        }
        function fetchFreshBinary(u) {
            return fetch(u, { cache: "reload", credentials: "same-origin" })
                .then(function (r) { return r.arrayBuffer().then(function () { return r.ok; }); })
                .catch(function () { return false; });
        }

        var codeJob = Promise.resolve();
        if (wantFiles) {
            var htmlUrls = [
                location.href,
                location.origin + "/?_ww_force=" + forceNonce,
                location.origin + "/host.html?_ww_force=" + forceNonce,
                location.origin + "/player.html?_ww_force=" + forceNonce
            ];
            var htmlJobs = htmlUrls.map(fetchFreshText);
            var currentNodes = document.querySelectorAll("script[src], link[rel~='stylesheet'][href]");
            for (var i = 0; i < currentNodes.length; i++) add(currentNodes[i].src || currentNodes[i].href);

            codeJob = Promise.all([
                fetch("/api/config?_ww_force=" + forceNonce, { cache:"no-store", credentials:"same-origin" }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
                fetch("/api/build-manifest?_ww_force=" + forceNonce, { cache:"no-store", credentials:"same-origin" }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }),
                Promise.all(htmlJobs)
            ]).then(function(pair) {
                var cfg = pair[0];
                var manifest = pair[1];
                var pages = pair[2];
                var expectedClientHash = manifest && manifest.clientHash ? String(manifest.clientHash) : (cfg && cfg.clientHash ? String(cfg.clientHash) : "");
                var all = [];
                if (manifest && Array.isArray(manifest.clientFiles)) {
                    manifest.clientFiles.forEach(function (item) {
                        if (item && item.path) add(item.path, location.origin + "/");
                    });
                }
                pages.forEach(function (p) {
                    if (!p || !p.ok) return;
                    try {
                        var doc = new DOMParser().parseFromString(p.text, "text/html");
                        var refs = doc.querySelectorAll("script[src], link[rel~='stylesheet'][href]");
                        for (var j = 0; j < refs.length; j++) {
                            var raw = refs[j].getAttribute("src") || refs[j].getAttribute("href");
                            try {
                                var a = new URL(raw, location.origin + "/");
                                if (a.origin !== location.origin) continue;
                                var pathName = a.pathname || "";
                                if (/^\/js\/|^\/css\//.test(pathName)) {
                                    if (expectedClientHash && a.searchParams.get("v") !== expectedClientHash) {
                                        // HTML ที่ตอบกลับไม่ใช่ชุดเดียวกับ config ปัจจุบัน — ดึงต่อด้วย URL บังคับใหม่ไม่ได้ประโยชน์
                                        throw new Error("STALE_CLIENT_HTML:" + pathName);
                                    }
                                }
                            } catch (e) { if (String(e && e.message).indexOf("STALE_CLIENT_HTML:") === 0) throw e; }
                            add(raw, location.origin + "/");
                        }
                    } catch (e) {
                        if (String(e && e.message).indexOf("STALE_CLIENT_HTML:") === 0) throw e;
                    }
                });
                for (var k = 0; k < freshUrls.length; k++) all.push(fetchFreshBinary(freshUrls[k]));
                return Promise.all(all);
            });
        }

        var imageJob = Promise.resolve();
        if (wantImages) {
            imageJob = Promise.all([
                fetch("/api/roles-data?_ww_force=" + forceNonce, { cache:"no-store", credentials:"same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function(){ return null; }),
                fetch("/api/build-manifest?_ww_force=" + forceNonce, { cache:"no-store", credentials:"same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).catch(function(){ return null; })
            ])
                .then(function (pair) {
                    var roles = pair[0];
                    var manifest = pair[1];
                    var urls = [];
                    function addImageUrl(u) {
                        if (!u || typeof u !== "string") return;
                        try {
                            var a = new URL(u, location.href);
                            a.searchParams.set("_ww_force", forceNonce);
                            var x = a.href;
                            if (urls.indexOf(x) < 0) urls.push(x);
                        } catch (e) {}
                    }
                    var imgs = document.querySelectorAll("img[src]");
                    for (var i = 0; i < imgs.length; i++) addImageUrl(imgs[i].src);
                    if (roles && typeof roles === "object") Object.keys(roles).forEach(function (key) { if (roles[key] && roles[key].icon) addImageUrl(roles[key].icon); });
                    // Site/profile icons are S3-only. Never probe the game origin for these assets.
                    // The page HTML is rewritten by the server to IMAGE_BASE_URL before this runs.
                    if (window.WW_IMG_BASE) {
                        ["/favicon.ico","/favicon-16x16.png","/favicon-32x32.png","/apple-touch-icon.png","/cover-1200x630.png"]
                            .forEach(function (p) { addImageUrl(window.WW_IMG_BASE + p); });
                    }
                    if (manifest && Array.isArray(manifest.imageUrls)) manifest.imageUrls.forEach(addImageUrl);
                    return Promise.all(urls.map(function (u) {
                        return fetch(u, { cache:"reload", credentials:"same-origin", mode:"cors" }).then(function (r) { return r.ok; }).catch(function () {
                            return new Promise(function (resolve) { var im = new Image(); im.onload=function(){resolve(true)}; im.onerror=function(){resolve(false)}; im.src=u; });
                        });
                    }));
                })
                .catch(function () { return []; });
        }

        var tasks = [];
        if (wantFiles) tasks.push(codeJob);
        if (wantImages) tasks.push(imageJob);
        if (!tasks.length) return Promise.resolve();
        return Promise.race([Promise.all(tasks), new Promise(function(resolve){ setTimeout(resolve, 12000); })]);
    }


    // reason: "admin" (แอดมินสั่งรีโหลด/เปลี่ยนสถานะเซิร์ฟเวอร์) | "reopen" (เซิร์ฟเวอร์เปิดคืนหลังปิด — เครื่องที่เห็นจอ "กำลังปิด")
    // ทั้งสองแบบจบที่ goHome() เหมือนกัน (กลับหน้าแรก) ต่างกันแค่ข้อความ/การล้างแคชไฟล์
    function startReload(reason, kind, imageEpoch) {
        // safety net ฝั่ง client: แท็บผู้ทดสอบไม่ควรถูกบังคับจบเซสชันจากระบบ server-control
        // แม้จะมี event เก่าหลุดมาถึงก่อน /api/config จะตอบ testerShielded ก็ตาม
        if (testerPageRequested) {
            return;
        }
        if (reloading) return;
        if (reason === "admin" && tooManyReloads()) return;
        reloading = true;

        if (imageEpoch) rememberImgVer(imageEpoch); // จำเลขรุ่นรูปก่อนไป หน้าแรกจะได้ใช้ ?v= ใหม่ตั้งแต่เฟรมแรก
        if (reason === "admin") {
            showToast(kind === "session"
                ? "🔄 เซิร์ฟเวอร์เพิ่งเปิดใหม่ — กำลังพากลับหน้าแรก..."
                : "🔄 แอดมินสั่งโหลดเกมใหม่ — กำลังพากลับหน้าแรก...");
        }

        var jitter = reason === "reopen" ? Math.random() * 2500 : 400 + Math.random() * 1500;
        setTimeout(function () {
            var wantFiles = reason === "admin" && (kind === "files" || kind === "both");
            var wantImages = reason === "admin" && (kind === "images" || kind === "both");
            ((wantFiles || wantImages) ? refreshAssetCache(kind) : Promise.resolve()).then(function(){ goHome(true); }, function(){ goHome(true); });
        }, jitter);
    }

    // ---------- version display ----------
    // ป้ายนี้ใช้ Running version จาก server โดยตรง (Elastic Beanstalk VersionLabel)
    // และเปิดให้ทุกหน้าที่ใช้ shared.server-control.js อัปเดตได้ทั้งจาก /api/config และ socket event
    window.wwSetServerVersion = function (version) {
        if (typeof version !== "string" || !version.trim()) return;
        window.__WW_SERVER_VERSION = version.trim();
        var badge = document.getElementById("wwVersionBadge");
        if (badge) badge.textContent = window.__WW_SERVER_VERSION;
    };
    // socket connection อาจตอบ serverInfo ก่อน HTML จะสร้าง badge ด้านล่างของ body
    // จึงเก็บค่าไว้ก่อน แล้วเติมให้อีกครั้งเมื่อ DOM พร้อม
    document.addEventListener("DOMContentLoaded", function () {
        if (window.__WW_SERVER_VERSION) window.wwSetServerVersion(window.__WW_SERVER_VERSION);
    });

    // ---------- release / tester update ----------
    function loadedBuildVersion() {
        try {
            var meta = document.querySelector('meta[name="ww-build-version"]');
            var value = meta && meta.getAttribute("content");
            return value ? String(value).trim() : "";
        } catch (e) { return ""; }
    }
    function loadedClientHash() {
        try {
            var nodes = document.querySelectorAll("script[src],link[href]");
            for (var i = 0; i < nodes.length; i++) {
                var raw = nodes[i].getAttribute("src") || nodes[i].getAttribute("href") || "";
                if (raw.indexOf("/js/shared.server-control.js") < 0) continue;
                var u = new URL(raw, location.href);
                var v = u.searchParams.get("v");
                if (v) return String(v);
            }
        } catch (e) {}
        return "";
    }
    function isTesterUpdateContext() { return !!(testerPageRequested || testerShielded); }
    function hideTesterUpdateNotice() {
        if (testerUpdateNotice && testerUpdateNotice.parentNode) testerUpdateNotice.parentNode.removeChild(testerUpdateNotice);
        testerUpdateNotice = null;
    }
    function showTesterUpdateNotice() {
        if (!isTesterUpdateContext() || testerUpdateReloading) return;
        if (testerUpdateNotice && testerUpdateNotice.parentNode) return;
        ensureStyle();
        var n = document.createElement("div");
        n.id = "wwTesterUpdateNotice";
        var t = document.createElement("div"); t.className = "wwTuText";
        t.textContent = "🧪 มีรุ่นทดสอบใหม่ พร้อมอัปเดตโดยไม่ต้องกลับหน้า Index";
        var b = document.createElement("button"); b.className = "wwTuBtn"; b.type = "button"; b.textContent = "อัปเดต";
        b.addEventListener("click", function () { startTesterReload("files", "manual"); });
        var c = document.createElement("button"); c.className = "wwTuClose"; c.type = "button"; c.setAttribute("aria-label", "ปิดการแจ้งเตือน"); c.textContent = "×";
        c.addEventListener("click", hideTesterUpdateNotice);
        n.appendChild(t); n.appendChild(b); n.appendChild(c);
        (document.body || document.documentElement).appendChild(n);
        testerUpdateNotice = n;
    }
    function reloadCurrentTesterPage() {
        if (navigator.onLine === false) { window.addEventListener("online", reloadCurrentTesterPage, { once:true }); return; }
        try {
            var u = new URL(location.href);
            u.searchParams.set("_ww_force", String(Date.now()) + "-" + Math.random().toString(36).slice(2,8));
            location.replace(u.pathname + u.search + u.hash);
        } catch (e) { location.reload(); }
    }
    function startTesterReload(kind, source) {
        if (!isTesterUpdateContext() || testerUpdateReloading) return;
        testerUpdateReloading = true;
        hideTesterUpdateNotice();
        var toast = document.createElement("div");
        toast.style.cssText = "position:fixed;z-index:2147483001;left:50%;top:50%;transform:translate(-50%,-50%);padding:14px 18px;border-radius:14px;background:rgba(12,18,28,.94);color:#fff;box-shadow:0 16px 50px rgba(0,0,0,.35);font:700 15px/1.3 system-ui,sans-serif";
        toast.textContent = "🧪 กำลังอัปเดตโหมดทดสอบ…";
        (document.body || document.documentElement).appendChild(toast);
        var wantsFiles = kind === "files" || kind === "both";
        var wantsImages = kind === "images" || kind === "both";
        var job = (wantsFiles || wantsImages) ? refreshAssetCache(kind) : Promise.resolve();
        job.catch(function () {}).then(function () { reloadCurrentTesterPage(); }, function () { reloadCurrentTesterPage(); });
    }

    // ---------- อ่าน config / event ----------
    function applyConfig(cfg) {
        if (!cfg || typeof cfg !== "object") return;

        // ใช้สถานะที่ server ยืนยันเท่านั้น ห้ามใช้ ?tester=1 เป็นตัวตัดสินสิทธิ์
        testerShielded = cfg.testerShielded === true;
        rememberImgVer(cfg.imageEpoch);
        noteServerNow(cfg.serverNow);

        // ค่าแสดงผลล้วนๆ (ไม่ใช่ระบบอัปเดต): ที่อยู่ต้นทางรูป + ป้ายเวอร์ชันมุมซ้ายบน
        // (เดิมสองอย่างนี้ถูกเติมโดยสคริปต์ตรวจอัปเดตของหน้าเกมที่ถอดออกไปแล้ว — ย้ายมาไว้ที่นี่ ไม่มีการเทียบ version/บันทึก pending/รีโหลดใดๆ)
        window.WW_IMG_BASE = typeof cfg.imageBase === "string" ? cfg.imageBase : (window.WW_IMG_BASE || "");
        window.wwSetServerVersion(cfg.appVersion);

        // ปิดอยู่ → จอเต็ม แล้วไม่ต้องสนใจเรื่องสั่งการ (ตอนเปิดคืนจะถูกพากลับหน้าแรกอยู่แล้ว)
        if (cfg.serverOpen === false && !testerShielded && !testerPageRequested) {
            showClosed({ message: cfg.noticeMessage, reopenAt: cfg.reopenAt });
            return;
        }
        // เปิดคืนแล้ว → ล้างห้องที่จำไว้แล้วพากลับหน้าแรก (ห้องเดิมถูกปิดไปตั้งแต่ตอนกดปิด ไม่มีอะไรให้กลับเข้า)
        if (closedShown) {
            startReload("reopen");
            return;
        }

        // แอดมินตั้งนับถอยหลังปิดไว้ → โชว์แถบเตือน / ถ้าเคยโชว์แล้วแต่ตอนนี้ไม่มีแล้ว = ถูกยกเลิก (พลาด event มา)
        if (!testerShielded && !testerPageRequested && cfg.closingInMs > 0) showClosing(cfg.closingInMs, cfg.noticeMessage, cfg.reopenAt);
        else if (closingActive) hideClosing(true);

        var epoch = (testerShielded || testerPageRequested) ? "" : (cfg.reloadEpoch || "");
        if (baselineEpoch === null) {
            baselineEpoch = epoch; // ครั้งแรกในหน้านี้ = ของที่หน้านี้เพิ่งโหลดมา ไม่ถือเป็นคำสั่งรีโหลด
            return;
        }
        // epoch ว่าง = server เพิ่งรีสตาร์ท (เลขไม่ได้เก็บข้ามการรีสตาร์ท) → เมิน ไม่ถือว่าเป็นคำสั่ง
        // (ครอบคลุมเครื่องที่หลับตอนแอดมินปิด/เปิดเซิร์ฟเวอร์ หรือกดรีโหลด: กลับมาเจอเลขใหม่ที่ไม่ตรง baseline → กลับหน้าแรกตาม)
        if (epoch && epoch !== baselineEpoch) {
            startReload("admin", cfg.reloadKind, cfg.imageEpoch);
        }
    }

    // ตัวตนห้องที่เครื่องนี้จำไว้ (ผู้เล่น: ww_joinedRoom+ww_token / โฮสต์: ww_host_room+ww_host_token) — แนบไปกับการโพล /api/config
    // เพื่อให้ "server" เป็นคนตัดสินว่านี่คือสมาชิกห้องผู้ทดสอบจริงไหม (ตรวจ token กับสถานะห้องบน server) ห้องผู้ทดสอบจะไม่ถูกสั่งกลับ index/ขึ้นจอ "กำลังปิด"
    // ค่าที่แนบเป็นแค่ "หลักฐาน" ให้ server ตรวจ — ไม่ใช่การประกาศสิทธิ์ (ไม่มี isTester อยู่ในนี้เลย)
    function readRoomIdentity() {
        // Possessed-bot tester tabs carry their exact room + bot token in the launch URL.
        // Prefer that pair over localStorage because window.open() may clone the Host tab's
        // sessionStorage and localStorage is shared by the entire browser origin.
        if (testerPageRequested) {
            try {
                var qs = new URLSearchParams(window.location.search);
                var launchRoom = qs.get("jr") || "";
                var launchToken = qs.get("t") || "";
                if (launchRoom && launchToken) return { roomId: String(launchRoom), token: String(launchToken) };
            } catch (e) { /* fallback to storage */ }
        }
        var stores = [];
        try { stores.push(sessionStorage); } catch (e) { /* ข้าม */ }
        try { stores.push(localStorage); } catch (e) { /* ข้าม */ }
        for (var i = 0; i < stores.length; i++) {
            try {
                var room = stores[i].getItem("ww_joinedRoom") || stores[i].getItem("ww_host_room");
                var token = stores[i].getItem("ww_token") || stores[i].getItem("ww_host_token");
                if (room && token) return { roomId: String(room), token: String(token) };
            } catch (e) { /* ข้าม */ }
        }
        return null;
    }
    function readRoomIdentityHeaders() {
        var id = readRoomIdentity();
        var headers = {};
        if (id) { headers["X-WW-Room"] = id.roomId; headers["X-WW-Token"] = id.token; }
        // ww_tp อาจติดอยู่กับ browser ทั้งตัวจากแท็บ Tester — ระบุว่า request นี้มาจาก Tester
        // เฉพาะแท็บที่มี ?tester=1 จริง ๆ เพื่อไม่ให้ index ปกติใน browser เดียวกันถูก shield ไปด้วย
        if (testerPageRequested) headers["X-WW-Tester-Page"] = "1";
        return headers;
    }

    function check() {
        if (reloading) return;
        window.wwGetConfig({ init: { cache: "no-store", headers: readRoomIdentityHeaders() } })
            .then(applyConfig)
            .catch(function () { /* ออฟไลน์/server ล่มชั่วคราว — เช็คใหม่รอบหน้า ไม่ถือว่าเป็นอะไรทั้งนั้น */ });
    }

    function schedulePoll() {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(function () {
            check();
            schedulePoll();
        }, closedShown ? CLOSED_POLL_MS : (closingActive ? CLOSING_POLL_MS : POLL_MS));
    }

    // ---------- ให้ main.js ต่อ socket event เข้ามา ----------
    window.wwServerControl = {
        // socket "force_reload" { epoch, kind, imageEpoch }
        onForceReload: function (d) {
            if (!d) return;
            if (d.testerUpdate === true) {
                if (isTesterUpdateContext()) startTesterReload(d.kind || "both", "admin");
                return;
            }
            if (testerPageRequested || testerShielded || closedShown) return;
            // เลขตรงกับที่หน้านี้เพิ่งอ่านมาแล้ว = โหลดหน้าหลังกดปุ่ม (ของใหม่อยู่แล้ว) ไม่ต้องรีโหลดซ้ำ
            // ถ้ายังไม่เคยอ่าน config (baseline = null) → รีโหลดไว้ก่อน: ปลอดภัย เพราะ event ยิงครั้งเดียวต่อการกด ไม่วนซ้ำ
            if (baselineEpoch !== null && d.epoch === baselineEpoch) return;
            startReload("admin", d.kind, d.imageEpoch);
        },
        // socket "server_closed" { message, reopenAt, now }
        onServerClosed: function (d) {
            if (testerPageRequested || testerShielded || (d && d.testerShielded === true)) return;
            if (d) noteServerNow(d.now);
            showClosed(d ? { message: d.message, reopenAt: d.reopenAt } : null);
        },
        // socket "server_closing" { inMs, message, reopenAt, now } — แอดมินตั้งนับถอยหลังปิด
        onServerClosing: function (d) {
            if (testerPageRequested || testerShielded || !d) return;
            noteServerNow(d.now);
            showClosing(d.inMs, d.message, d.reopenAt);
        },
        // socket "server_closing_cancelled" — แอดมินยกเลิกการปิด
        onServerClosingCancelled: function () { if (!testerPageRequested && !testerShielded) hideClosing(true); },
        // socket "connect_error" — ต่อไม่ได้เพราะ server ปฏิเสธ (message = "server_closed") ต่างจากเน็ตหลุดธรรมดา
        onConnectError: function (err) {
            if (testerPageRequested || testerShielded) return;
            if (err && err.message === "server_closed") { showClosed(null); check(); } // check() = ดึงข้อความ/เวลาที่คาดว่าจะเปิดมาโชว์ (event เกมถูกบล็อกแล้ว)
        },
        // ให้ host.main.js/player.main.js แนบไปกับ io({ auth: ... }) ตอนสร้าง socket — เป็น "หลักฐาน" เดียวกับ
        // readRoomIdentityHeaders ด้านบน (roomId+token) ให้ server เช็คตอน handshake ว่านี่คือสมาชิกห้องผู้ทดสอบจริงไหม
        // (ดู isProtectedHandshake ใน server.js) เพื่อให้ต่อ socket กลับเข้าห้องผู้ทดสอบได้แม้เซิร์ฟเวอร์หลักปิดอยู่และ
        // เครื่องนี้ไม่ได้ถือบัตรผู้ทดสอบ (tp cookie) — ไม่มีหลักฐานก็แนบ object ว่างไปเฉยๆ ไม่กระทบเครื่องทั่วไป
        roomIdentityAuth: function () { return readRoomIdentity() || {}; },
        returnTesterToAdmin: returnTesterToAdmin,
        returnTesterToHost: returnTesterToHost,
        isTesterPageRequested: function () { return testerPageRequested; },
        check: check
    };

    check();
    schedulePoll();
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") check();
    });
})();
