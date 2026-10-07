const { ROOM_PRESENCE_REFRESH_MS, initializeRoomActivity, touchRoomActivity, hasLiveRoomMember, roomIdleExpired } = require("./utils/room-idle");
const { redactRoomViewForPlayer } = require("./utils/room-view");
const express = require("express");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const os = require("os");
const compression = require("compression");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { getAppVersion, getCachedAppVersion, getAppEnvironmentState, getCachedAppEnvironmentState, startAppVersionRefresh } = require("./utils/getAppVersion");
const {
    configuredEnvironmentName,
    normalizeVersionLabel,
    isValidVersionLabel,
    publicApplicationVersion,
    isKnownDeployableStatus,
    describeEnvironment,
    listApplicationVersions,
    getApplicationVersion,
    deployApplicationVersion,
    getSourceBundleObject,
    makeSafeDownloadFilename,
} = require("./utils/elastic-beanstalk-version-manager");
const { getGithubBugReportConfig, buildGithubBugReportStatus, buildGithubBugReportIssue, createGithubBugReportIssue, publicGithubText } = require("./utils/github-bug-reports");

// ============================================================
// LIGHTWEIGHT RUNTIME ERROR COMPATIBILITY
// Production intentionally has no diagnostic center/replay engine. These tiny helpers
// keep older gameplay error paths safe while doing no persistence or analysis.
// ============================================================
function makeDiagnosticId(prefix = "id") {
    const body = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex");
    return `${String(prefix || "id")}-${body}`;
}
function safeDiagnosticValue(value, depth = 0) {
    if (depth > 3 || value === null || value === undefined) return value == null ? "" : String(value);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 12).map((v) => safeDiagnosticValue(v, depth + 1));
    if (typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).slice(0, 24)) out[String(key).slice(0, 80)] = safeDiagnosticValue(value[key], depth + 1);
        return out;
    }
    return String(value).slice(0, 500);
}
function currentDiagnosticContext() { return {}; }
function addDiagnosticBreadcrumb() {}
let bugReportSink = null;
function recordDiagnostic(event = {}) {
    if (!bugReportSink || !(event.level === "error" || /(?:failed|failure|exception|unhandled|error)/i.test(event.kind || ""))) return null;
    return bugReportSink({ source:"server", page:event.page || "server", roomId:event.roomId || event.context?.roomId || "",
        message:`${event.kind || "server_error"}: ${event.message || "Runtime failure"}`, stack:event.stack || "" });
}
function linkDiagnosticEvents() {}
function publicDiagnosticText(value, max = 12000) { return String(value ?? "").slice(0, max); }
function sanitizeDiagnosticPath(value) {
    const raw = String(value || "");
    try { if (/^https?:\/\//i.test(raw)) { const u = new URL(raw); return `${u.origin}${u.pathname}`.slice(0, 600); } } catch (_) {}
    return raw.split(/[?#]/, 1)[0].slice(0, 600);
}
const diagnosticAsyncContext = { run(_ctx, fn) { return fn(); }, getStore() { return {}; } };

// Process-level exceptions are fatal startup/runtime faults. Log them, then terminate so
// Elastic Beanstalk can replace the broken instance instead of leaving nginx with a dead
// Node upstream that only looks like a persistent 502.
let processFatalErrorScheduled = false;
function terminateAfterProcessError(label, err) {
    console.error(label, err);
    if (processFatalErrorScheduled) return;
    processFatalErrorScheduled = true;
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref?.();
}
process.on("uncaughtException", (err) => {
    terminateAfterProcessError("[uncaughtException]", err);
});
process.on("unhandledRejection", (err) => {
    terminateAfterProcessError("[unhandledRejection]", err);
});

const app = express();
const server = http.createServer(app);

// ============================================================
// DEPLOYMENT RESILIENCE / HEALTH GATES
// ============================================================
// /health is intentionally registered before the global server-state middleware.
// It remains a lightweight liveness endpoint. Elastic Beanstalk/Load Balancer uses /ready
// below as the strict traffic gate so a new immutable instance cannot receive traffic
// before bootstrap/recovery and mandatory production Admin Auth are ready.
let appBootReady = false;
let appDraining = false;

app.get("/health", (req, res) => {
    const alive = !appDraining;
    const ready = appBootReady && !appDraining && roomRecoveryHealthy && adminAuthReadyForDeployment();
    const environmentState = getCachedAppEnvironmentState();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    return res.status(alive ? 200 : 503).json({
        ok: alive,
        status: alive ? "ok" : "draining",
        ready,
        serverOpen: !serverClosed,
        recoveryHealthy: !!roomRecoveryHealthy,
        bootReady: !!appBootReady,
        adminAuthConfigured: !!ADMIN_AUTH_CONFIGURED,
        adminAuthRequiredInDeployment: !!EB_ENVIRONMENT_NAME,
        uptimeSec: Math.round(process.uptime()),
        version: getCachedAppVersion(),
        environmentStatus: environmentState.status,
        environmentVersionLabel: environmentState.versionLabel,
        deploymentState: environmentState.deploymentState,
        deploymentInProgress: environmentState.deploymentState === "updating",
    });
});

app.get("/ready", (req, res) => {
    const baseReady = appBootReady && !appDraining && roomRecoveryHealthy;
    const environmentState = getCachedAppEnvironmentState();
    const adminReady = adminAuthReadyForDeployment();
    const ready = baseReady && adminReady;
    let status = "ready";
    if (!ready) {
        if (appDraining) status = "draining";
        else if (!adminReady) status = "admin_auth_not_configured";
        else status = "not_ready";
    }
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    return res.status(ready ? 200 : 503).json({
        ok: ready,
        status,
        ready,
        serverOpen: !serverClosed,
        recoveryHealthy: !!roomRecoveryHealthy,
        bootReady: !!appBootReady,
        adminAuthConfigured: !!ADMIN_AUTH_CONFIGURED,
        adminAuthRequiredInDeployment: !!EB_ENVIRONMENT_NAME,
        uptimeSec: Math.round(process.uptime()),
        version: getCachedAppVersion(),
        environmentStatus: environmentState.status,
        environmentVersionLabel: environmentState.versionLabel,
        deploymentState: environmentState.deploymentState,
        deploymentInProgress: environmentState.deploymentState === "updating",
    });
});

// บีบอัด (gzip) ทุก response ที่เป็นข้อความ (html/js/css/json) ก่อนส่งออกไป
// host.html / player.html หนักไฟล์ละ ~120-140KB ต่อครั้ง — ข้อความ/โค้ดพวกนี้บีบอัดได้ดีมาก
// (ปกติเหลือ ~20-30% ของขนาดเดิม) ช่วยลดทั้งเวลาโหลดและปริมาณเน็ตที่ผู้เล่นแต่ละคนต้องโหลด
// ตอนเข้าห้องครั้งแรก โดยเฉพาะบนเน็ตช้า/มือถือ ไม่กระทบไฟล์รูปภาพ (.jpg/.png ถูกบีบอัดอยู่แล้ว
// ในตัวเอง compression middleware จะข้าม content-type พวกนี้ให้อัตโนมัติ)
app.use(compression());

// pingTimeout/pingInterval ที่นานขึ้น เพื่อทนต่อการที่มือถือ "หรี่"/throttle JS
// ของแท็บที่ไม่ได้อยู่หน้าจอ (สลับแอป/ล็อกสกรีน) ค่า default (ping 25s / timeout 20s)
// สั้นเกินไปสำหรับเคสนี้ ทำให้ socket หลุดบ่อยกว่าที่ควรจะเป็นจริง ๆ
// (เพิ่ม pingTimeout อีกจาก 60s → 90s ให้ยิ่งทนต่อเน็ตกระตุกนานๆ ได้มากขึ้น)
const io = new Server(server, {
    pingInterval: 25_000,
    pingTimeout: 90_000, // เดิม 20s → 60s → 90s
    // ช่วยกู้ connection state ของ Socket.IO เองในกรณีเน็ตสะดุด/แท็บถูกพักชั่วคราว
    // ภายใน instance เดิม; การสลับ instance ระหว่าง Immutable deployment ยังใช้ membershipId +
    // durable room snapshot เป็น source of truth และจะ auto-rejoin ต่อให้ Socket.IO state recovery นี้ใช้ไม่ได้
    connectionStateRecovery: {
        maxDisconnectionDuration: 120_000,
        skipMiddlewares: false,
    },
    // perMessageDeflate: บีบอัดข้อมูลที่วิ่งผ่าน WebSocket (room_update ทุกครั้งที่มีการ
    // เปลี่ยนสถานะห้อง คือข้อความที่ส่งบ่อย/ถี่ที่สุดในเกมนี้) ค่า default ของ socket.io
    // ปิดฟีเจอร์นี้ไว้ (เพื่อประหยัด CPU/RAM ฝั่ง server) แต่สำหรับเกมนี้ผู้เล่นส่วนใหญ่อยู่บน
    // มือถือ/เน็ตช้า จึงคุ้มกว่าที่จะยอมแลก CPU ฝั่ง server เพิ่มอีกนิด เพื่อลด "เน็ตที่ผู้เล่นต้องใช้"
    // ลงจริง ๆ — threshold กันไม่ให้ไปบีบอัด message เล็ก ๆ (ได้ไม่คุ้มเสีย เพราะมี overhead)
    perMessageDeflate: {
        threshold: 1024, // บีบอัดเฉพาะ message ที่ใหญ่กว่า 1KB ขึ้นไป
    },
});

// ============================================================
// เปิด/ปิดเซิร์ฟเวอร์ + บังคับรีโหลด (ปุ่มในหน้า admin.html แท็บ "จัดการระบบ")
// ============================================================
// สถานะที่ใช้ร่วมกันทั้งไฟล์ (ตัวจัดการปุ่มอยู่ในหัวข้อ "ADMIN — เปิด/ปิดเซิร์ฟเวอร์" ใต้ /api/admin/reset)
//   serverClosed : true = ปิดอยู่ → ผู้เล่นเข้าหน้าเกม/ต่อ socket ไม่ได้เลย (ยกเว้นหน้า admin.html และแท็บผู้ทดสอบที่แอดมินเปิดมาพร้อม "บัตรผ่านผู้ทดสอบ" — ดูหัวข้อนั้นด้านล่าง)
//   reloadEpoch  : เลขรุ่นของ "การสั่งรีโหลด/จบเซสชันล่าสุด" เปลี่ยนทุกครั้งที่แอดมินกดปุ่มรีโหลด "และ" ทุกครั้งที่กดปิด/เปิดเซิร์ฟเวอร์
//                  (สถานะเปลี่ยนจริง) — client จำเลขที่เห็นตอนโหลดหน้าไว้ ถ้าเลขเปลี่ยนถึงจะทำงาน (ไม่ใช่ทำทุกครั้งที่ได้ event)
//                  จึงไม่มีทางวนลูป ค่าว่าง = ยังไม่เคยมีคำสั่งรีโหลดค้างอยู่ (เก็บใน SERVER_STATE เพื่อไม่ให้คำสั่งหายเมื่อ process รีสตาร์ท)
//                  ทุกครั้งที่เลขเปลี่ยน = "จบเซสชันเดิมทั้งหมด": server ปิดทุกห้องแบบเงียบ (closeAllRoomsSilently — ไม่นับสถิติ/ไม่นับออกเกม)
//                  และ client ทุกเครื่องถูกพากลับ "หน้าแรก (index)" พร้อมล้างห้อง/token ที่จำไว้ (ดู shared.server-control.js)
//   reloadKind   : "files" | "images" | "both" (แอดมินกดรีโหลด) | "session" (ปิด/เปิดเซิร์ฟเวอร์) ของการสั่งล่าสุด
//   imageEpoch   : เลขรุ่นของรูปภาพ — ถูกต่อท้ายทุก URL รูปเป็น ?v=... (ดู imgUrl ด้านล่าง) เก็บลง DynamoDB ด้วย
//                  เพื่อไม่ให้ URL รูปกลับไปเป็นแบบเก่า (ที่เครื่องผู้เล่นแคชค้างไว้) ตอน server รีสตาร์ท
let serverClosed = false;
//   closedMessage / closedReopenAt : ข้อความจากแอดมิน + เวลาที่คาดว่าจะเปิด (epoch ms, 0 = ไม่ระบุ) ที่โชว์บนจอ "เซิร์ฟเวอร์กำลังปิด"
//                  เก็บลง DynamoDB พร้อมสถานะปิด (ดู saveServerState) เพื่อให้ยังโชว์ต่อหลัง deploy/รีสตาร์ทตอนปิดค้างอยู่
//   closingPlan  : การ "นับถอยหลังก่อนปิด" ที่แอดมินตั้งไว้ { closeAt, message, reopenAt, timer } (null = ไม่มี)
//                  ระหว่างนับ เซิร์ฟเวอร์ยังเปิด เล่นได้ปกติ แต่ทุกเครื่องเห็นแถบเตือน + เวลาถอยหลัง (server_closing / /api/config)
//                  ไม่เก็บลง DB ตั้งใจ (รีสตาร์ทระหว่างนับ = ห้องหายเองอยู่แล้ว การนับที่ค้างไว้ก็ถือว่ายกเลิก)
let closedMessage = "";
let closedReopenAt = 0;
let closingPlan = null;
let reloadEpoch = "";
let reloadKind = "";
let testerReloadEpoch = "";
let imageEpoch = "";
// เวลาเริ่มเซสชันใหม่ล่าสุดของห้องปกติ — snapshot ห้องปกติที่เก่ากว่าเวลานี้จะไม่ถูกกู้หลัง
// admin ปิด/บังคับรีโหลด แม้ snapshot เก่าจะยังค้างใน DynamoDB จากความล้มเหลวชั่วคราวตอนลบ
let roomResetAt = 0;
// แอดมินสั่งเองหลังบูตแล้ว → ห้ามเอาค่าจาก DB ที่โหลดช้า (เช่น DB เพิ่งกลับมาหลังบูตไปแล้ว) มาเขียนทับคำสั่งนั้น
// แยกเป็น 2 ตัวเพราะกดรีโหลดไฟล์เกม/รูปไม่ได้แปลว่าแอดมินตั้งใจเปลี่ยนสถานะ "ปิด/เปิด" (ค่าจาก DB ยังมีผลกับเรื่องปิด/เปิดอยู่)
let serverOpenTouchedByAdmin = false;
let reloadEpochTouchedByAdmin = false;
let imageEpochTouchedByAdmin = false;

// serverStateReady: รอโหลดสถานะ "ปิด/เปิด" ที่บันทึกไว้จาก DynamoDB ตอนบูต (รอไม่เกิน ~3 วิ แล้วถือว่าเปิด)
// ทุก request/socket ที่เข้ามาจะรอตรงนี้ก่อนตัดสินใจ — กันช่วงบูตหลัง deploy ที่แอดมินปิดเซิร์ฟเวอร์ค้างไว้
// แล้วมีคนหลุดเข้ามาก่อนที่จะรู้ว่า "ยังปิดอยู่" (เดิมถ้าไม่รอ ผู้เล่นที่รอหน้า "กำลังปิด" อยู่จะกดรีเฟรชเข้าเกมได้ทันทีที่ server ขึ้น)
// และไม่ได้ทำให้ socket ที่กำลัง reconnect หลัง deploy ปกติถูกปฏิเสธ — แค่หน่วงไม่เกิน 3 วิ แล้วปล่อยเข้าตามปกติ
let serverStateResolve;
const serverStateReady = new Promise((resolve) => { serverStateResolve = resolve; });

const MAINTENANCE_FALLBACK_HTML = '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>เซิร์ฟเวอร์ปิดอยู่</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f19;color:#fff;font-family:sans-serif;text-align:center"><div><div style="width:72px;height:72px;margin:0 auto 14px"><img id="serverIcon" src="" alt="" width="72" height="72" style="display:block;width:72px;height:72px;object-fit:contain;border-radius:16px"></div><h1>เซิร์ฟเวอร์กำลังปิด</h1><p>กรุณารอสักครู่</p></div><script>function check(){fetch("/api/config",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){if(d&&d.serverIconUrl){var i=document.getElementById("serverIcon");if(i)i.src=String(d.serverIconUrl);}if(d&&d.serverOpen===true){try{["ww_joinedRoom","ww_lastRoom","ww_token","ww_host_room","ww_host_token","ww_bot_tokens"].forEach(function(k){localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch(e){}location.replace("/")}}).catch(function(){})}check();setInterval(check,4000)</script></body></html>';
let maintenanceHtmlCache = null;
function getMaintenanceHtml() {
    if (maintenanceHtmlCache === null) {
        try {
            maintenanceHtmlCache = fs.readFileSync(path.join(__dirname, "public", "maintenance.html"), "utf8");
        } catch (e) {
            console.error("[server-control] อ่าน public/maintenance.html ไม่ได้ ใช้หน้าสำรองแทน:", e.message);
            maintenanceHtmlCache = MAINTENANCE_FALLBACK_HTML;
        }
        // maintenance.html is served directly by the closed-server gate, not through getStampedHtml().
        // Rewrite only the dedicated server icon marker to the bundled local asset.
        const src = imgUrl(SERVER_CLOSED_ICON_PATH);
        maintenanceHtmlCache = maintenanceHtmlCache.replace(/src=""([^>]*id="serverIcon"[^>]*)>/i, `src="${src}"$1>`);
        maintenanceHtmlCache = maintenanceHtmlCache.replace(/src=""([^>]*id='serverIcon'[^>]*)>/i, `src="${src}"$1>`);
    }
    return maintenanceHtmlCache;
}

// ตอนปิดอยู่ ปล่อยผ่านเฉพาะสิ่งที่แอดมินต้องใช้เปิดเซิร์ฟเวอร์คืน + ให้หน้า "กำลังปิด" เช็คสถานะได้
//   - /api/config (คืน serverOpen), /api/admin/* (ปุ่มเปิด/ปิด ฯลฯ), /socket.io/* (ด่านของ socket อยู่ที่ io.use ด้านล่าง)
//   - admin.html, maintenance.html และไอคอน
// นอกนั้น: หน้าเว็บ (/, *.html, path ไม่มีนามสกุล) → ตอบหน้า "เซิร์ฟเวอร์กำลังปิด" แทน (status 200 ไม่ใช่ 503 ตั้งใจ:
// Elastic Beanstalk/Load Balancer เช็คสุขภาพที่ "/" ถ้าได้ 503 จะมองว่าเครื่องพัง แล้วอาจถอย deploy/สั่งเปลี่ยนเครื่อง)
// ทุกอย่างส่ง Cache-Control: no-store เพื่อไม่ให้หน้า "กำลังปิด" ถูกแคชไว้แล้วโผล่ค้างหลังเปิดเซิร์ฟเวอร์
// ------------------------------------------------------------
// บัตรผ่านผู้ทดสอบ (tester pass) — ให้ "โหมดผู้ทดสอบที่เปิดจากหน้า admin.html" เล่น/ทดสอบได้แม้ปิดเซิร์ฟเวอร์อยู่
// ------------------------------------------------------------
// ใช้ลองเล่นอัปเดตใหม่หลัง deploy ตอนที่ยังปิดเซิร์ฟเวอร์ค้างไว้ (ผู้เล่นทั่วไปยังเข้าไม่ได้เหมือนเดิม)
//   - แอดมินขอบัตรผ่านที่ POST /api/admin/tester-pass (ต้องใส่รหัสผ่านแอดมินถ้าตั้ง ADMIN_RESET_PASSWORD ไว้ — ระดับเดียวกับปุ่มปิด/เปิดเซิร์ฟเวอร์)
//     ได้ token แบบ signed อายุ TESTER_PASS_TTL_MS; secret ใช้ร่วมกันข้าม process/instance และเก็บใน SERVER_STATE ของ DynamoDB
//     (ถ้าตั้ง TESTER_PASS_SECRET ใน environment จะใช้ค่านี้แทน DB) จึงไม่ทำให้บัตรเก่าหายเพียงเพราะ deploy/restart
//   - หน้า admin เปิดแท็บทดสอบพร้อม ?tp=<token> → ตอนหน้านั้นโหลด server ฝัง cookie ww_tp ให้ (HttpOnly) —
//     ใช้ cookie สำหรับ HTTP/maintenance path ของแท็บที่ถูกเปิดจาก launch link; Socket.IO ใช้ testerPass ใน handshake โดยตรง
//   - "ห้องผู้ทดสอบ" (room.isTesterRoom) อยู่นอกวงจรปิดเซิร์ฟเวอร์/บังคับรีโหลด: closeAllRoomsSilently ข้ามห้องนี้, ไม่ส่ง force_reload/
//     server_closed/server_closing ให้ socket ในห้องนี้, /api/config ไม่ส่งเลข reloadEpoch/นับถอยหลังให้เครื่องที่ถือบัตร/เป็นสมาชิกห้องนี้
//     ห้องนี้เป็น "ห้องผู้ทดสอบ" ก็ต่อเมื่อ server ตัดสินเอง: socket ที่สร้างห้องถือบัตรผ่านที่ server ออกให้ (Socket.IO handshake → socket.data.testerToken)
//     "และ" client ขอโหมดผู้ทดสอบมา — ค่า isTester ที่ client ส่งมาอย่างเดียวไม่มีผลต่อสิทธิ์ใดๆ (ดู resolveTesterFlag)
//   - ยกเว้น: /api/admin/reset (ล้างข้อมูลทั้งระบบ) ยังล้างทุกห้องรวมห้องทดสอบ — เป็นการล้างข้อมูลไม่ใช่การปิดเซิร์ฟเวอร์
// หมายเหตุ: cookie ผูกกับเบราว์เซอร์ทั้งตัว (ไม่ใช่แค่แท็บทดสอบ) — เครื่องของแอดมินเองที่ถือบัตรอยู่จึงเปิดเกมทุกหน้าได้ตอนปิด ซึ่งตั้งใจ
const TESTER_PASS_COOKIE = "ww_tp";
const TESTER_PASS_TTL_MS = 12 * 60 * 60 * 1000; // 12 ชม.
// เดิมบัตรผ่านอยู่ใน Map ของ process → deploy/restart แล้วบัตรทุกใบกลายเป็น invalid ทันที
// ทำให้แท็บผู้ทดสอบที่ยังเปิดอยู่สูญเสียสิทธิ์คุ้มครองและถูกระบบปิด/redirect ตามผู้เล่นปกติ
// เปลี่ยนเป็น token แบบลงลายเซ็น (HMAC) ที่ตรวจสอบได้จาก secret เดียวกันทุก instance/restart
// และเก็บ secret ไว้ใน SERVER_STATE ของ DynamoDB เพื่อให้ deploy ไม่เปลี่ยน secret
const TESTER_PASS_SECRET_ENV = process.env.TESTER_PASS_SECRET || "";
let testerPassSecret = TESTER_PASS_SECRET_ENV;

function b64urlEncode(value) {
    return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(value) {
    return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function testerPassSignature(payloadPart) {
    if (!testerPassSecret) return "";
    return b64urlEncode(crypto.createHmac("sha256", testerPassSecret).update(payloadPart).digest());
}
function issueTesterPass() {
    const now = Date.now();
    const payload = {
        v: 1,
        exp: now + TESTER_PASS_TTL_MS,
        n: crypto.randomBytes(18).toString("hex"),
    };
    const body = b64urlEncode(JSON.stringify(payload));
    return `v1.${body}.${testerPassSignature(body)}`;
}
function isTesterPassValid(token) {
    if (typeof token !== "string" || !token || !testerPassSecret) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return false;
    const body = parts[1];
    const given = parts[2];
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(given)) return false;
    const expected = testerPassSignature(body);
    try {
        const a = Buffer.from(given);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
        const payload = JSON.parse(b64urlDecode(body));
        return payload && payload.v === 1 && Number(payload.exp) > Date.now();
    } catch (e) {
        return false;
    }
}
function readCookie(header, name) {
    if (typeof header !== "string" || !header) return "";
    for (const part of header.split(";")) {
        const i = part.indexOf("=");
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return "";
}
function normalizeRoomToken(value) {
    const token = String(value || "").trim();
    return token.slice(0, 256);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
// token จาก cookie เท่านั้น (ใช้กับ request ทั่วไป/handshake ของ socket) — ?tp= ใช้เฉพาะตอนโหลดหน้าครั้งแรก ดู middleware ด้านล่าง
function testerTokenFromCookie(headers) {
    return readCookie(headers && headers.cookie, TESTER_PASS_COOKIE);
}

// ============================================================
// ADMIN AUTHENTICATION CONFIG
// ============================================================
const ADMIN_PANEL_PASSWORD = String(process.env.ADMIN_PANEL_PASSWORD || process.env.ADMIN_RESET_PASSWORD || "").trim();
const ADMIN_AUTH_CONFIGURED = !!ADMIN_PANEL_PASSWORD;
const ADMIN_SESSION_SECRET = String(process.env.ADMIN_SESSION_SECRET || "").trim()
    || (ADMIN_AUTH_CONFIGURED ? crypto.createHash("sha256").update(`werewolf-admin-session:${ADMIN_PANEL_PASSWORD}`).digest("hex") : "");
const ADMIN_SESSION_COOKIE = "ww_admin";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_TAB_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminTabSessionRevoked = new Map();

// ============================================================
// ADMIN AUTHENTICATION
// ============================================================
function sanitizeAdminTabId(value) {
    const id = String(value || "").trim();
    return /^[A-Za-z0-9_-]{16,128}$/.test(id) ? id : "";
}
function createAdminSessionToken(meta = {}) {
    if (!ADMIN_SESSION_SECRET || !ADMIN_AUTH_CONFIGURED) return "";
    const tabId = sanitizeAdminTabId(meta.tabId);
    return createSignedState({
        v: 1,
        admin: true,
        sessionType: tabId ? "tab" : "cookie",
        tabId,
        provider: "password",
        exp: Date.now() + (tabId ? ADMIN_TAB_SESSION_TTL_MS : ADMIN_SESSION_TTL_MS),
        n: crypto.randomBytes(18).toString("hex"),
    }, ADMIN_SESSION_SECRET);
}
function getAdminBearerToken(reqOrHeaders) {
    const source = reqOrHeaders || {};
    const headers = source?.headers || source || {};
    const authorization = String(headers.authorization || "").trim();
    if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, "").trim();
    return String(source?.auth?.adminToken || "").trim();
}
function getAdminPresentedTabId(reqOrHeaders) {
    const source = reqOrHeaders || {};
    const headers = source?.headers || source || {};
    return sanitizeAdminTabId(headers["x-ww-admin-tab-id"] || headers["X-WW-Admin-Tab-Id"] || source?.auth?.adminTabId || "");
}
function getAdminPrincipal(reqOrHeaders) {
    if (!ADMIN_AUTH_CONFIGURED) return null;
    const source = reqOrHeaders || {};
    const headers = source?.headers || source || {};
    const bearer = getAdminBearerToken(source);
    const cookie = readCookie(headers.cookie, ADMIN_SESSION_COOKIE);
    const token = bearer || cookie;
    const payload = verifySignedState(token, ADMIN_SESSION_SECRET);
    if (!payload || payload.admin !== true) return null;
    if (payload.sessionType === "tab") {
        const revokedUntil = Number(adminTabSessionRevoked.get(String(payload.n || "")) || 0);
        if (revokedUntil > Date.now()) return null;
        if (revokedUntil) adminTabSessionRevoked.delete(String(payload.n || ""));
        const presentedTabId = getAdminPresentedTabId(source);
        if (!payload.tabId || !presentedTabId || payload.tabId !== presentedTabId) return null;
        return { ...payload, tabScoped: true };
    }
    if (bearer) return null;
    return { ...payload, tabScoped: false };
}
function isAdminSessionValid(reqOrHeaders) {
    return !!getAdminPrincipal(reqOrHeaders);
}
function adminAuthRequired() { return ADMIN_AUTH_CONFIGURED; }
// ใน Elastic Beanstalk ต้องมีวิธียืนยัน Admin เสมอ; ถ้าการตั้งค่านี้หายตอน deploy
// instance ใหม่จะต้อง "ไม่พร้อมรับ traffic" เพื่อให้นโยบาย Immutable เหลือ instance เดิมไว้
// แทนการปล่อยให้หน้า Admin ขึ้นข้อความ "ยังไม่ได้ตั้งค่า" ชั่วคราว/ใช้งานไม่ได้
function adminAuthReadyForDeployment() {
    return !!ADMIN_AUTH_CONFIGURED || !EB_ENVIRONMENT_NAME;
}
function adminSessionCookieSecure(req) { return authCookieSecure(req); }

app.use("/api/admin", (req, res, next) => {
    if (req.path === "/login" || req.path === "/session" || req.path === "/logout") return next();
    if (!adminAuthRequired()) return res.status(503).json({ error: "admin_auth_not_configured", code: "ADMIN_AUTH_NOT_CONFIGURED" });
    if (isAdminSessionValid(req)) return next();
    return res.status(401).json({ error: "admin_auth_required", code: "ADMIN_AUTH_REQUIRED" });
});

// IMPORTANT: this route is intentionally registered before the server-closed gate.
// A valid Admin download ticket must remain usable even while the public game is
// temporarily closed, so an Admin can recover a previous source bundle during an
// incident/rollback workflow.
app.get("/api/eb-version-download/:ticket", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");

    const payload = verifySignedState(String(req.params.ticket || ""), ADMIN_SESSION_SECRET);
    const now = Date.now();
    const nonce = String(payload?.n || "");
    const envName = configuredEnvironmentName();
    const versionLabel = normalizeVersionLabel(payload?.versionLabel);

    const revokedUntil = Number(adminTabSessionRevoked.get(String(payload?.adminSessionNonce || "")) || 0);
    if (!payload || payload.type !== "admin_eb_version_download" || payload.admin !== true || !nonce
        || !envName || payload.environmentName !== envName || !isValidVersionLabel(versionLabel)
        || Number(payload.exp || 0) <= now || revokedUntil > now) {
        return res.status(404).type("text/plain").send("download_ticket_invalid");
    }

    try {
        const environment = await describeEnvironment({ environmentName: envName });
        const applicationName = String(environment.ApplicationName || "").trim();
        if (!applicationName || applicationName !== String(payload.applicationName || "").trim()) {
            return res.status(404).type("text/plain").send("download_source_changed");
        }
        const version = await getApplicationVersion({ applicationName, versionLabel });
        if (!version.downloadable) {
            return res.status(404).type("text/plain").send("download_source_not_found");
        }

        const object = await getSourceBundleObject({ version });
        if (!object?.Body) throw Object.assign(new Error("S3 GetObject returned no body"), { code: "EB_VERSION_SOURCE_EMPTY" });
        const filename = makeSafeDownloadFilename(versionLabel);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/zip");
        if (Number.isFinite(Number(object.ContentLength))) res.setHeader("Content-Length", String(object.ContentLength));
        if (object.LastModified) res.setHeader("Last-Modified", new Date(object.LastModified).toUTCString());
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        await pipeline(object.Body, res);
    } catch (e) {
        const code = String(e?.code || e?.name || "");
        const message = String(e?.message || e || "");
        const accessDenied = /AccessDenied|Forbidden|not authorized|UnauthorizedOperation/i.test(`${code} ${message}`);
        recordDiagnostic({
            source: "server",
            kind: accessDenied ? "admin_version_download_access_denied" : "admin_version_download_failed",
            page: "admin",
            action: "admin_version_download",
            operation: "S3.GetObject",
            message: message || code || "Elastic Beanstalk source-bundle download failed",
            stack: e?.stack || "",
            endpoint: `/api/eb-version-download/${versionLabel}`,
            data: { versionLabel, environmentName: envName, code: code.slice(0, 160) },
        });
        if (res.headersSent) {
            try { res.destroy(e); } catch (_) {}
            return;
        }
        if (accessDenied) return res.status(403).type("text/plain").send("EB_VERSION_SOURCE_ACCESS_DENIED");
        if (e?.code === "EB_VERSION_SOURCE_NOT_FOUND" || e?.code === "EB_VERSION_NOT_FOUND") {
            return res.status(404).type("text/plain").send("EB_VERSION_SOURCE_NOT_FOUND");
        }
        return res.status(503).type("text/plain").send("EB_VERSION_DOWNLOAD_FAILED");
    }
});

const CLOSED_ALLOWED_PATHS = new Set([
    "/admin.html", "/maintenance.html", "/health", "/ready",
]);
app.use(async (req, res, next) => {
    await serverStateReady;

    // บัตรผ่านผู้ทดสอบ: หน้าที่แอดมินเปิดมาจะมี ?tp=<token> → ฝัง cookie ไว้ (ฝังทั้งตอนเปิด/ปิด เพื่อให้แท็บที่เปิดไว้ก่อนกดปิดยังเล่นต่อได้)
    const qTp = typeof req.query.tp === "string" ? req.query.tp : "";
    if (isTesterPassValid(qTp)) {
        res.setHeader("Set-Cookie", `${TESTER_PASS_COOKIE}=${qTp}; Path=/; Max-Age=${Math.floor(TESTER_PASS_TTL_MS / 1000)}; SameSite=Lax; HttpOnly`);
        return next();
    }
    if (isTesterPassValid(testerTokenFromCookie(req.headers))) return next();

    const p = req.path;

    // EB/CloudFront can briefly keep more than one Node instance alive during a
    // rolling/immutable deploy. serverClosed is process-local, while the persisted
    // SERVER_STATE row is shared. Reconcile the navigation/config state before the
    // closed-server gate so an instance that still thinks "closed" never returns the
    // maintenance document after Admin has already reopened the server elsewhere.
    const shouldSyncPersistedState = p === "/" || p === "/index.html" || p === "/api/config" || p === "/api/server-state";
    if (shouldSyncPersistedState) {
        const forceAuthorityRead = p === "/" || p === "/index.html" || (p === "/api/server-state" && (req.query.boot === "1" || req.query.verify === "1"));
        await syncServerStateFromAuthority({ force: forceAuthorityRead });
    }

    if (!serverClosed) return next();

    if (p === "/api/config" || p === "/api/server-state" || p.startsWith("/api/admin/") || p === "/api/bug-reports" || p.startsWith("/socket.io/") || CLOSED_ALLOWED_PATHS.has(p)) {
        return next();
    }
    // หน้า "เซิร์ฟเวอร์กำลังปิด" ต้องโหลดข้อมูลอาชีพ + รูปอาชีพเองได้แม้เพิ่งเปิดหน้าเว็บ/ไม่เคยเข้าเกมมาก่อน (iPad/iPhone/Android)
    // → เปิด GET/HEAD ของ /api/roles-data (ข้อมูลสาธารณะล้วน ไม่มี auth/ไม่ผูกกับห้อง) และรูปใน /images/ ให้ผ่านด่านตอนปิด
    // (รูปอาชีพเป็นข้อมูลสาธารณะอยู่แล้ว; ยังปิด js/css/html และ API อื่นทั้งหมดเหมือนเดิม)
    if ((req.method === "GET" || req.method === "HEAD") && (p === "/api/roles-data" || p.startsWith("/images/"))) {
        return next();
    }

    res.setHeader("Cache-Control", "no-store");
    if (p.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
        return res.status(503).json({ error: "server_closed" });
    }
    const ext = path.extname(p).toLowerCase();
    if (ext === "" || ext === ".html" || ext === ".htm") {
        // Do not let a maintenance document become a reusable browser/CDN snapshot.
        // This is especially important on iPad/Chrome when the root page is reloaded
        // immediately after an Admin reopen on another instance.
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Surrogate-Control", "no-store");
        res.setHeader("Expires", "0");
        return res.status(200).type("html").send(getMaintenanceHtml());
    }
    return res.status(503).type("text/plain").send("server_closed");
});

// หน้า admin.html เชื่อม socket ด้วย admin intent + tab-scoped bearer
// ค่า auth.admin เป็นเพียง intent: server ตรวจ signed Admin credential + tabId ทุกครั้ง
// ก่อนอนุญาต event admin_* จึงไม่มีทางลัดจากการปลอม auth.admin=true
function isAdminSocket(socket) {
    const auth = socket && socket.handshake && socket.handshake.auth;
    if (!(auth && auth.admin === true)) return false;
    if (!ADMIN_AUTH_CONFIGURED) return false;
    return isAdminSessionValid(socket.handshake);
}
io.use(async (socket, next) => {
    await serverStateReady;
    await roomRecoveryReady;
    if (appDraining) {
        const err = new Error("server_draining");
        err.data = { code: "SERVER_DRAINING", retryAfterMs: 5000 };
        return next(err);
    }
    // บัตรผ่านผู้ทดสอบสำหรับ Socket.IO ต้องผูกกับ "แท็บที่เปิดโหมดทดสอบ" เท่านั้น
    // ห้ามอ่าน ww_tp จาก cookie มาเลื่อนสิทธิ์ให้ socket ปกติ เพราะ HttpOnly cookie
    // เป็น cookie ระดับ origin เดียวกันทั้งเบราว์เซอร์: ถ้าแอดมินเปิดแท็บ Tester แล้ว
    // แท็บ index ปกติใน iPad/Chrome ใช้ origin เดียวกัน มันจะส่ง cookie ใบเดียวกันมาด้วย
    // และ socket ปกติจะถูกตีความเป็น tester ได้เฉพาะจาก server-side tester pass
    // ทั้งที่ฝั่ง client ไม่มี tester=true เลย (ตรงกับ Diagnostic v16 วันที่ 24/09/69 13:20)
    //
    // ใช้ launch credential ที่ส่งใน Socket.IO handshake แทน ซึ่งหน้า tester/player/host
    // ปัจจุบันแนบ ?tp= ให้เฉพาะแท็บทดสอบและ server ตรวจ signature + expiry ทุกครั้ง
    // ส่วน cookie ww_tp ยังมีไว้สำหรับ HTTP/maintenance path ที่ต้องผ่านด่านตอน server ปิด
    // แต่จะไม่ถูกนำมาเป็น identity ของ socket อีกต่อไป
    const authTpToken = String(socket.handshake?.auth?.testerPass || "").trim();
    const testerPassPresented = !!authTpToken;
    let testerPassValid = false;
    if (testerPassPresented) {
        // อย่าตรวจบัตรก่อน shared secret พร้อม: ระหว่าง deploy/instance ใหม่ อาจเห็น Socket
        // ก่อน initServerState โหลด/สร้าง secret เสร็จ และทำให้บัตรที่ถูกต้องกลายเป็น invalid
        // แบบสุ่ม → join_room ต้องใช้ room token / tester pass ตามประเภทห้อง
        try {
            await ensureTesterPassSecretPersistent();
            testerPassValid = isTesterPassValid(authTpToken);
        } catch (e) {
            socket.data.testerPassBootstrapError = String(e?.code || e?.name || "TESTER_PASS_UNAVAILABLE");
            recordDiagnostic({
                source: "server", kind: "tester_auth_bootstrap_error", page: "server",
                message: "ไม่สามารถโหลด shared tester pass secret ก่อนตรวจ Socket.IO handshake",
                data: { testerPassPresented: true, code: socket.data.testerPassBootstrapError },
                traceId: String(socket.data.diagnosticTraceId || ""),
                sessionId: String(socket.data.diagnosticSessionId || ""),
            });
        }
    }
    socket.data.testerPassPresented = testerPassPresented;
    socket.data.testerPassValid = testerPassValid;
    const adminAuthToken = String(socket.handshake?.auth?.adminToken || "").trim();
    const adminPresentedTabId = sanitizeAdminTabId(socket.handshake?.auth?.adminTabId || "");
    const adminSessionValid = isAdminSocket(socket);
    socket.data.isAdmin = adminSessionValid;
    addDiagnosticBreadcrumb({ source:"server", type:"socket", label:"auth.handshake", traceId:String(socket.data.diagnosticTraceId || ""), sessionId:String(socket.data.diagnosticSessionId || ""), page:"server", detail:{
        authObservation:{
            testerPassPresented,
            testerPassValid,
            testerPassBootstrapError:String(socket.data.testerPassBootstrapError || ""),
            hasAdminIntent:socket.handshake?.auth?.admin === true,
            hasAdminToken:!!adminAuthToken,
            hasAdminTabId:!!adminPresentedTabId,
            adminSessionValid,
            hasDiagSession:!!socket.handshake?.auth?.wwDiagSessionId,
        },
    } });
    if (testerPassValid) socket.data.testerToken = authTpToken;
    // สมาชิกห้องผู้ทดสอบที่ไม่ได้ถือบัตร tp cookie (ดูคอมเมนต์ที่ isProtectedHandshake ด้านบน) — ถือว่าผ่านด่านปิด
    // เหมือนกับถือบัตรเลย (roomTesterAuth) ให้ครอบคลุมทั้ง handshake นี้และ event ต่างๆ ที่จะตามมา (ดู socket.on wrapper ด้านล่าง)
    if (isProtectedHandshake(socket)) socket.data.roomTesterAuth = true;

    // Admin sockets must fail the handshake when their signed tab credential is
    // missing/expired/mismatched. Previously an { auth: { admin:true } } socket
    // could connect while not actually authenticated; the later admin_* event
    // guard then returned ADMIN_AUTH_REQUIRED. That left the Admin UI connected
    // at the transport layer but unable to load rooms, and because the
    // handshake itself succeeded it did not reliably enter the client's
    // connect_error → ensureAdminLogin recovery path.
    if (socket.handshake?.auth?.admin === true && !isAdminSocket(socket)) {
        addDiagnosticBreadcrumb({
            source: "server",
            type: "socket",
            label: "auth.rejected:admin_auth_required",
            traceId: String(socket.data.diagnosticTraceId || ""),
            sessionId: String(socket.data.diagnosticSessionId || ""),
            page: "server",
            detail: {
                reason: "admin_auth_required",
                code: "ADMIN_AUTH_REQUIRED",
                hasAdminToken: !!adminAuthToken,
                hasAdminTabId: !!adminPresentedTabId,
            },
        });
        return next(new Error("admin_auth_required"));
    }

    if (!serverClosed || isAdminSocket(socket) || socket.data.testerToken || socket.data.roomTesterAuth) return next();
    // ถูกปฏิเสธที่ middleware → socket.io client จะ "ไม่ reconnect เอง" (socket.active=false) และยิง connect_error
    // (message = "server_closed") — หน้าเกมจับตัวนี้ไปโชว์หน้า "เซิร์ฟเวอร์กำลังปิด" ส่วนตอนเปิดคืนหน้านั้นจะรีโหลดเองจาก /api/config
    next(new Error("server_closed"));
});

// SERVER VERSION: hash ของเนื้อหาไฟล์เกม/asset ที่ client ใช้ตรวจว่า "มีรุ่นใหม่จริง" หรือไม่
// ไม่ผูกกับการ restart process เอง — Node restart ที่ไฟล์ชุดเดิมให้ version เดิม เพื่อไม่เตะห้องจากการรีสตาร์ทเฉยๆ
//
// หมายเหตุสำคัญ: ไม่ใช้ Date.now() ตัวเดียวตอนบูตเฉย ๆ เพราะถ้า deploy แบบสลับไฟล์ static
// (public/*.html) โดยที่ตัว process Node ไม่ได้ถูก restart จริง ๆ ค่านี้จะไม่เปลี่ยนเลย
// ทำให้ client แท็บที่เปิดค้างไว้ตรวจไม่เจอว่ามีอัปเดตใหม่ ต้องกดรีเฟรชเองอยู่ดี
// จึงคำนวณจาก mtime ของไฟล์จริงบนดิสก์ประกอบด้วย (เปลี่ยนทุกครั้งที่ไฟล์ถูกเขียนทับ ไม่ว่า
// process จะ restart หรือไม่) รวมกับเวลาบูต (เผื่อ restart แล้ว mtime บังเอิญไม่เปลี่ยน)
// ---- VERSION = "เนื้อหาไฟล์เกมจริง" (content hash) — ไม่ผูกกับเวลาบูต/instance ใดๆ ----
// เหตุผลที่ตัด BOOT_TIME ออก: เดิม version = BOOT_TIME + hash ไฟล์ → (1) Node restart เฉยๆ (ไฟล์เหมือนเดิม) ก็ทำให้
// ทุกเครื่องเห็นว่า "มีอัปเดตใหม่", (2) ถ้ามีมากกว่า 1 instance/process (เช่น rolling deploy บน Elastic Beanstalk)
// แต่ละตัวมี BOOT_TIME ไม่เท่ากัน → เครื่องที่โดน route ไปคนละตัว (เช่น Android กับ iPhone) เห็น version คนละค่าสลับไปมา
// ตอนนี้ version คำนวณจาก "เนื้อหา" ล้วนๆ → ไฟล์ชุดเดียวกัน = version เดียวกันเสมอ ไม่ว่า instance/เวลาบูตไหน
// version ประกอบด้วย 4 ส่วน (แยกเก็บไว้ ใช้ต่างกัน):
//   clientHash : public/**/*.{html,js,css,json,svg,...} (ไม่รวม admin.html/maintenance.html) — ใช้ต่อท้าย URL js/css ของหน้าเกมด้วย (?v=)
//   assetsHash : public/**/*.{png,jpg,webp,ico,ฟอนต์,เสียง,...} รวม public/images/** (รูปอาชีพ/ไอคอน)
//   serverHash : server.js (โค้ดกติกาเกมและ backend ที่ผู้เล่นใช้งาน)
//   imageEpoch : เลขรุ่น asset รูปที่แอดมินกด เพื่อบังคับ client ที่ออนไลน์ให้เริ่ม session/asset ใหม่
// หน้าที่ของ version มีอย่างเดียว: "บอกว่ามีรุ่นใหม่" ให้หน้า index เอาไปเทียบ — ไม่ได้สั่ง reload อะไรทั้งสิ้น
const PUBLIC_DIR = path.join(__dirname, "public");
const CLIENT_CODE_EXTS = new Set([".html", ".htm", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest", ".txt", ".xml"]);
const CLIENT_ASSET_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".ogg", ".wav", ".m4a"]);
const CLIENT_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"]);
const VERSION_SKIP_FILES = new Set([path.join(PUBLIC_DIR, "admin.html"), path.join(PUBLIC_DIR, "maintenance.html")]);
const SERVER_CODE_FILES = ["server.js"].map((f) => path.join(__dirname, f));
const ASSET_CONTENT_HASH_MAX_BYTES = 4 * 1024 * 1024; // รูปที่ใหญ่กว่านี้ใช้ path+ขนาดแทนเนื้อหา (กันอ่านไฟล์ใหญ่ซ้ำบน event loop)
const VERSION_SCAN_TTL_MS = 3000; // /api/config ถูกโพลถี่ — สแกน stat ของไฟล์ทั้งโฟลเดอร์ไม่เกินทุก 3 วิ
let _versionCache = { scannedAt: 0, sigs: { client: "", assets: "", server: "" }, hashes: { client: "", assets: "", server: "" } };

function walkPublicFiles(dir, codeOut, assetOut) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
            walkPublicFiles(full, codeOut, assetOut);
        } else if (!VERSION_SKIP_FILES.has(full)) {
            const ext = path.extname(ent.name).toLowerCase();
            if (CLIENT_CODE_EXTS.has(ext)) codeOut.push(full);
            else if (CLIENT_ASSET_EXTS.has(ext)) assetOut.push(full);
        }
    }
}

function fileSig(f) {
    try { const st = fs.statSync(f); return `${f}:${Math.floor(st.mtimeMs)}:${st.size}`; } catch (e) { return `${f}:0:0`; }
}

// hash เนื้อหาของกลุ่มไฟล์ — คีย์ด้วย "path สัมพัทธ์" (ไม่ใช่ path เต็ม/mtime) เพื่อให้เครื่อง/instance/โฟลเดอร์ deploy ต่างกันได้ค่าเท่ากัน
function hashFileGroup(files, { bigFileBySizeOnly } = {}) {
    const h = crypto.createHash("sha1");
    for (const f of files) {
        h.update(path.relative(__dirname, f).split(path.sep).join("/"));
        try {
            const st = fs.statSync(f);
            if (bigFileBySizeOnly && st.size > ASSET_CONTENT_HASH_MAX_BYTES) h.update(`size:${st.size}`);
            else h.update(fs.readFileSync(f));
        } catch (e) { /* ไฟล์หาย = ข้าม */ }
    }
    return h.digest("hex").slice(0, 12);
}

function refreshVersionParts() {
    const now = Date.now();
    if (_versionCache.scannedAt && now - _versionCache.scannedAt < VERSION_SCAN_TTL_MS) return _versionCache.hashes;
    const code = [];
    const assets = [];
    walkPublicFiles(PUBLIC_DIR, code, assets);
    code.sort();
    assets.sort();
    const server = SERVER_CODE_FILES.filter((f) => fs.existsSync(f)).sort();
    const sigs = {
        client: code.map(fileSig).join("|"),
        assets: assets.map(fileSig).join("|"),
        server: server.map(fileSig).join("|"),
    };
    const prev = _versionCache;
    const hashes = {
        client: sigs.client === prev.sigs.client && prev.hashes.client ? prev.hashes.client : hashFileGroup(code),
        assets: sigs.assets === prev.sigs.assets && prev.hashes.assets ? prev.hashes.assets : hashFileGroup(assets, { bigFileBySizeOnly: true }),
        server: sigs.server === prev.sigs.server && prev.hashes.server ? prev.hashes.server : hashFileGroup(server),
    };
    _versionCache = { scannedAt: now, sigs, hashes };
    return hashes;
}

// fingerprint รุ่นที่หน้า Admin ควรตรวจจับ — ไม่ใช่แค่ admin.html อย่างเดียว
// เพราะการ deploy ใหม่อาจเปลี่ยน server.js / client JS / CSS / asset โดยไม่ได้แก้ admin.html
// แต่ Admin ที่เปิดค้างอยู่ก็ควรรู้ว่าชุดโปรแกรมที่รันอยู่เปลี่ยนรุ่นแล้ว
// ใช้ hash ของ admin.html + version parts ของ client/assets/server เพื่อให้
// deploy ที่มีผลต่อระบบจริงสร้าง admin release ใหม่อย่างสม่ำเสมอทุก instance
function computeAdminHash() {
    try {
        const adminFile = fs.readFileSync(path.join(PUBLIC_DIR, "admin.html"));
        const parts = refreshVersionParts();
        const releaseSource = Buffer.concat([
            Buffer.from("admin-html\0"), adminFile,
            Buffer.from(`\0client:${parts.client}\0assets:${parts.assets}\0server:${parts.server}`)
        ]);
        return crypto.createHash("sha1").update(releaseSource).digest("hex").slice(0, 12);
    } catch (_) {
        return "0";
    }
}

// คืน hash ของโค้ดฝั่ง client ล้วนๆ (ใช้ต่อท้าย URL js/css) — เปลี่ยนเมื่อ html/js/css/json ใน public เปลี่ยนเท่านั้น
function computeClientHash() {
    try { return refreshVersionParts().client; } catch (e) { return "0"; }
}

// คืน version รวมที่ส่งให้ client (/api/config) — เปลี่ยนเมื่อ ไฟล์ client / รูปและ asset / โค้ดบอท+server / เลขรุ่นรูปที่แอดมินกด เปลี่ยน
// ไม่ขึ้นกับ BOOT_TIME → Node restart ที่ไฟล์เหมือนเดิม "ไม่ใช่การอัปเดต"
function computeServerVersion() {
    try {
        const p = refreshVersionParts();
        // Canonical update version is intentionally broader than clientHash:
        // changing Admin itself is still an application update, so /api/config -> version
        // must move even when public/admin.html is the only file changed. Keep clientHash
        // semantics unchanged so ordinary game asset cache-busting does not broaden.
        const adminRelease = computeAdminHash();
        return crypto.createHash("sha1").update(`${p.client}|${p.assets}|${p.server}|${imageEpoch || ""}|admin:${adminRelease}`).digest("hex").slice(0, 12);
    } catch (e) {
        return "0";
    }
}

// เลขรุ่นรูปที่ต่อท้าย URL รูปทุกใบ (?v=) = เลขที่แอดมินกด + hash ของรูปใน public/ (ถ้ามี) → เปลี่ยนรูปแล้ว URL เปลี่ยนเอง ไม่ต้องรอแอดมินกด
// imageEpoch ยังเก็บเป็น server-side version signal; ตัวไฟล์จริงอยู่ใน public/images/ และถูก hash ตรวจจับได้
function currentImageVersion() {
    let assetsHash = "";
    try { assetsHash = refreshVersionParts().assets; } catch (e) { /* ไม่เป็นไร */ }
    // ไม่มีไฟล์ asset เลย (เช่น รูปทั้งหมดอยู่บน S3) hash ของกลุ่มว่างจะคงที่ — ตัดออกไม่ให้ URL มี ?v= โดยไม่จำเป็น
    const emptyAssetsHash = crypto.createHash("sha1").digest("hex").slice(0, 12);
    const parts = [imageEpoch || "", assetsHash && assetsHash !== emptyAssetsHash ? assetsHash : ""].filter(Boolean);
    return parts.join("-");
}

// รูปภาพของเกมเป็น asset ที่ deploy ไปพร้อมกับแอปโดยตรง
// แหล่งเดียวคือ public/images/ และ client จะเรียกผ่าน same-origin /images/...
// รูปเกมไม่มี external image origin; ใช้ LOCAL_IMAGE_BASE เดียวกับ public/images/ เท่านั้น
const LOCAL_IMAGE_BASE = "/images";
// ใช้ไฟล์ที่มีอยู่จริงในโปรเจกต์สำหรับจอเซิร์ฟเวอร์ปิด
const SERVER_CLOSED_ICON_PATH = "/images/favicon-32x32.jpg";

// imgUrl: สร้าง same-origin URL ของ asset ใน public/images เท่านั้น
// imageEpoch ยังใช้เป็น version signal สำหรับระบบ force-reload ของ Admin แต่ไม่ถูกเก็บใน browser storage
function imgUrl(imgPath) {
    const raw = String(imgPath || "").trim();
    if (!raw) return "";
    const pathName = raw.startsWith("/images/") ? raw : `/images/${raw.replace(/^\/+/, "")}`;
    const v = currentImageVersion();
    return `${pathName}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
}

// ============================================================
// DYNAMODB + DURABLE ROOM STATE
// ============================================================
// Guest-first production model: DynamoDB is used only for room/server persistence and deployment recovery.
// Player identity is local to the browser; room data contains only gameplay state.
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand, PutCommand, ScanCommand, GetCommand, BatchWriteCommand, DeleteCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
let dynamoDocClientPromise = null;

const EB_ENVIRONMENT_NAME = String(process.env.EB_ENVIRONMENT_NAME || "").trim();

const rooms = {};
// Server-internal pointer used by diagnostics to snapshot the live room registry without coupling early boot code to the rooms lexical binding.
globalThis.__WEREWOLF_ROOMS__ = rooms;

// ============================================================
// DURABLE ROOM SNAPSHOTS / RECOVERY
// ============================================================
// rooms ยังคงอยู่ใน RAM เพื่อความเร็ว แต่ snapshot ของห้องที่ยัง active จะถูกเก็บใน DynamoDB
// เป็นระยะ และถูกโหลดกลับก่อนรับ socket หลัง Node restart/deploy โดยใช้ token ของผู้เล่น/โฮสต์
// เป็นตัวตนถาวรแทน socket.id ซึ่งเปลี่ยนทุกครั้งที่ reconnect
//
// แนะนำให้ตั้ง DYNAMODB_ROOMS_TABLE เป็นชื่อตารางห้องโดยเฉพาะ.
// WEREWOLF_ROOMS_TABLE รองรับชื่อ env เดิมของ room persistence เท่านั้น.
// ปิดชั่วคราวได้ด้วย ROOM_PERSISTENCE_ENABLED=false (เหมาะเฉพาะ local dev)
const ROOM_PERSISTENCE_ENABLED = process.env.ROOM_PERSISTENCE_ENABLED !== "false";
const ROOM_PERSISTENCE_TABLE = process.env.DYNAMODB_ROOMS_TABLE || process.env.WEREWOLF_ROOMS_TABLE || "WerewolfRooms";
const ROOM_SNAPSHOT_STAT_KEY = "ROOM_SNAPSHOT";
const ROOM_INDEX_STAT_KEY = "ROOM_INDEX";
const ROOM_KEY_PREFIX = "__ROOM__:";
const ROOM_SNAPSHOT_SCHEMA = 2;
const ROOM_PERSISTENCE_DEBOUNCE_MS = Math.max(250, Number(process.env.ROOM_PERSISTENCE_DEBOUNCE_MS) || 750);
const ROOM_PERSISTENCE_SCAN_MS = Math.max(750, Number(process.env.ROOM_PERSISTENCE_SCAN_MS) || 1500);
const ROOM_RECOVERY_TIMEOUT_MS = Math.max(2000, Number(process.env.ROOM_RECOVERY_TIMEOUT_MS) || 8000);
const ROOM_SNAPSHOT_MAX_BYTES = Math.min(380 * 1024, Math.max(100 * 1024, Number(process.env.ROOM_SNAPSHOT_MAX_BYTES) || 350 * 1024));

// Deployment handoff / fencing. A room is never treated as "missing" merely because the
// new Immutable instance has not received the old instance's final handoff yet. The lease is
// intentionally a short-lived coordination record: it protects the deployment boundary without
// turning normal multi-instance read/recovery into a hard single-instance dependency.
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const ROOM_LEASE_STAT_KEY = "ROOM_LEASE";
const ROOM_LEASE_TTL_MS = Math.max(8_000, Math.min(60_000, Number(process.env.ROOM_LEASE_TTL_MS) || 20_000));
const ROOM_LEASE_RENEW_MS = Math.max(2_000, Math.min(10_000, Number(process.env.ROOM_LEASE_RENEW_MS) || 5_000));
const ROOM_FAILOVER_RETRY_MS = Math.max(500, Math.min(8_000, Number(process.env.ROOM_FAILOVER_RETRY_MS) || 1_500));
const roomLeaseEpochs = new Map();
const roomLeaseTimers = new Map();
let roomRecoveryDeferred = false;
let roomRecoveryDeferredTimer = null;
let deploymentRoomRecoveryCompleted = false;

const roomPersistenceTimers = new Map();
const roomPersistenceSignatures = new Map();
const roomPersistenceKnownIds = new Set();
let roomPersistenceStarted = false;
let roomPersistenceScanTimer = null;
let roomRecoveryHealthy = !ROOM_PERSISTENCE_ENABLED;
let roomRecoveryError = "";
let roomRecoveryResolve;
const roomRecoveryReady = new Promise((resolve) => { roomRecoveryResolve = resolve; });

Promise.all([serverStateReady, roomRecoveryReady]).then(() => {
    appBootReady = true;
}).catch((err) => {
    console.error("[boot] readiness gate failed:", err?.message || err);
});


// ============================================================
// SHARED ROOM / ADMIN CRYPTO HELPERS
// ============================================================
function normalizeDeviceId(deviceId) {
    const value = String(deviceId || "").trim();
    if (!value || value.length > 160) return "";
    return value.replace(/[^A-Za-z0-9._:-]/g, "_");
}
function normalizeTabId(tabId) {
    const value = String(tabId || "").trim();
    if (!value || value.length > 160) return "";
    return value.replace(/[^A-Za-z0-9._:-]/g, "_");
}
function generateMembershipId() {
    return crypto.randomUUID ? crypto.randomUUID() : `mem-${genId()}-${genId()}-${genId()}`;
}
function hmacState(payloadPart, secret) {
    return b64urlEncode(crypto.createHmac("sha256", String(secret || "")).update(payloadPart).digest());
}
function createSignedState(payload, secret) {
    const body = b64urlEncode(JSON.stringify(payload));
    return `v1.${body}.${hmacState(body, secret)}`;
}
function verifySignedState(token, secret) {
    if (typeof token !== "string" || !token || !secret) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const [_, body, sig] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
    try {
        const expected = hmacState(body, secret);
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        const payload = JSON.parse(b64urlDecode(body));
        if (!payload || payload.v !== 1 || Number(payload.exp) <= Date.now()) return null;
        return payload;
    } catch (_) { return null; }
}
function authCookieSecure(req) {
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "").split(",")[0].trim().toLowerCase();
    return proto === "https";
}
function appendSetCookie(res, cookie) {
    const existing = res.getHeader("Set-Cookie");
    if (!existing) return res.setHeader("Set-Cookie", [cookie]);
    const list = Array.isArray(existing) ? existing.slice() : [String(existing)];
    list.push(cookie);
    res.setHeader("Set-Cookie", list);
}
function clearHttpOnlyCookie(res, name, secure, pathValue = "/") {
    const parts = [`${name}=`, `Path=${pathValue}`, "Max-Age=0", "HttpOnly", "SameSite=Lax"];
    if (secure) parts.push("Secure");
    appendSetCookie(res, parts.join("; "));
}

async function resolveAwsRegion() {
    if (process.env.AWS_REGION) return process.env.AWS_REGION;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
        const tokenRes = await fetch("http://169.254.169.254/latest/api/token", {
            method: "PUT",
            headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
            signal: controller.signal,
        });
        const token = await tokenRes.text();
        if (!token) return "";
        const regionRes = await fetch("http://169.254.169.254/latest/meta-data/placement/region", {
            headers: { "X-aws-ec2-metadata-token": token },
            signal: controller.signal,
        });
        return (await regionRes.text()).trim();
    } catch (_) {
        return "";
    } finally {
        clearTimeout(timeout);
    }
}

async function getDynamoDocClient() {
    if (!dynamoDocClientPromise) {
        dynamoDocClientPromise = resolveAwsRegion().then((region) => {
            const raw = new DynamoDBClient(region ? { region } : {});
            const doc = DynamoDBDocumentClient.from(raw);
            const originalSend = doc.send.bind(doc);
            doc.send = async (command, options) => {
                const startedAt = Date.now();
                const ctx = currentDiagnosticContext();
                const operation = command?.constructor?.name || "DynamoDBCommand";
                const input = command?.input || {};
                const tableName = String(input.TableName || Object.keys(input.RequestItems || {})[0] || "");
                const commandRoomId = String(input.Item?.roomId || input.Item?.id || input.Key?.roomId || input.Key?.id || "").toUpperCase().slice(0, 12);
                const effectiveRoomId = String(ctx.roomId || commandRoomId || "").toUpperCase().slice(0, 12);
                try {
                    const out = await originalSend(command, options);
                    addDiagnosticBreadcrumb({ source:"server", type:"aws", label:`dynamodb.ok ${operation}`, traceId:ctx.traceId || "", sessionId:ctx.sessionId || "", page:"server", detail:{ table:tableName, durationMs:Date.now()-startedAt } });
                    return out;
                } catch (err) {
                    const durationMs = Date.now() - startedAt;
                    const requestItemSummary = input.RequestItems
                        ? Object.keys(input.RequestItems).reduce((acc, key) => { acc[key] = Array.isArray(input.RequestItems[key]) ? input.RequestItems[key].length : 0; return acc; }, {})
                        : undefined;
                    const safeInput = safeDiagnosticValue({
                        TableName: tableName,
                        Key: input.Key,
                        RequestItems: requestItemSummary,
                        UpdateExpression: input.UpdateExpression,
                        ConditionExpression: input.ConditionExpression,
                        KeyConditionExpression: input.KeyConditionExpression,
                        FilterExpression: input.FilterExpression,
                    });
                    addDiagnosticBreadcrumb({ source:"server", type:"aws", label:`dynamodb.error ${operation}`, traceId:ctx.traceId || "", sessionId:ctx.sessionId || "", page:"server", detail:{ table:tableName, durationMs, error:err?.name || "Error", message:err?.message || String(err) } });
                    if (input.Item?.playerName !== "__BUG_REPORTS__" && input.Key?.playerName !== "__BUG_REPORTS__" && input.ExpressionAttributeValues?.[":partition"] !== "__BUG_REPORTS__") recordDiagnostic({
                        source:"server", kind:"aws_dynamodb_error", page:"server",
                        message:err?.message || String(err), stack:err?.stack || "", operation,
                        data:safeInput,
                        context:{ awsService:"DynamoDB", operation, tableName, errorName:err?.name || "Error" },
                        traceId:ctx.traceId, sessionId:ctx.sessionId, action:ctx.action,
                        roomId:effectiveRoomId, requestId:ctx.requestId, clientRequestId:ctx.clientRequestId,
                        durationMs,
                    });
                    throw err;
                }
            };
            return doc;
        });
    }
    return dynamoDocClientPromise;
}

async function deleteTableItemsWithFallback(doc, tableName, keys) {
    if (!tableName || !Array.isArray(keys) || !keys.length) return;
    try {
        let pending = keys.map((k) => ({ DeleteRequest: { Key: k } }));
        for (let i = 0; i < pending.length; i += 25) {
            let batch = pending.slice(i, i + 25);
            for (let attempt = 0; attempt < 7 && batch.length; attempt++) {
                const out = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: batch } }));
                batch = (out.UnprocessedItems && out.UnprocessedItems[tableName]) || [];
                if (batch.length) await sleepMs(100 * 2 ** attempt);
            }
            if (batch.length) throw new Error(`DynamoDB ยังประมวลผลรายการลบของ ${tableName} ไม่ครบ`);
        }
    } catch (e) {
        const denied = /AccessDenied|not authorized|UnauthorizedOperation/i.test(String(e?.message || e));
        if (!denied) throw e;
        for (const key of keys) await doc.send(new DeleteCommand({ TableName: tableName, Key: key }));
    }
}

const ADMIN_VERSION_DOWNLOAD_TTL_MS = 5 * 60_000;
function adminVersionError(res, status, code, message, details = {}) {
    return res.status(status).json({ ok:false, error:code, code, message, ...details });
}

app.get("/api/admin/versions", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    const envName = configuredEnvironmentName();
    if (!envName) {
        return adminVersionError(res, 503, "EB_VERSION_MANAGER_NOT_CONFIGURED", "ยังไม่ได้ตั้งค่า EB_ENVIRONMENT_NAME");
    }
    try {
        const environment = await describeEnvironment({ environmentName: envName });
        const applicationName = String(environment.ApplicationName || "").trim();
        if (!applicationName) return adminVersionError(res, 503, "EB_APPLICATION_NAME_MISSING", "Elastic Beanstalk ไม่ส่งชื่อ Application ของ environment นี้");
        const currentVersion = String(environment.VersionLabel || "").trim();
        const versions = await listApplicationVersions({ applicationName });
        return res.json({
            ok: true,
            environment: {
                name: envName,
                applicationName,
                status: String(environment.Status || "").trim(),
                health: String(environment.Health || "").trim(),
                healthStatus: String(environment.HealthStatus || "").trim(),
                versionLabel: currentVersion,
                abortableOperationInProgress: !!environment.AbortableOperationInProgress,
            },
            versions: versions.map((version) => ({
                ...publicApplicationVersion(version),
                current: version.versionLabel === currentVersion,
                rollbackAllowed: version.versionLabel !== currentVersion
                    && isKnownDeployableStatus(version.status)
                    && String(environment.Status || "") === "Ready"
                    && !environment.AbortableOperationInProgress,
            })),
        });
    } catch (e) {
        const code = String(e?.code || e?.name || "EB_VERSION_LIST_FAILED");
        recordDiagnostic({ source: "server", kind: "admin_version_list_failed", page: "admin", action: "admin_versions_list", operation: code, message: e?.message || String(e), stack: e?.stack || "" });
        return adminVersionError(res, 503, code === "CredentialsProviderError" ? "EB_VERSION_AWS_CREDENTIALS" : "EB_VERSION_LIST_FAILED", "อ่านประวัติเวอร์ชันจาก Elastic Beanstalk ไม่สำเร็จ");
    }
});

app.post("/api/admin/versions/download-ticket", express.json({ limit: "4kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    const envName = configuredEnvironmentName();
    const versionLabel = normalizeVersionLabel(req.body?.versionLabel);
    if (!envName) return adminVersionError(res, 503, "EB_VERSION_MANAGER_NOT_CONFIGURED", "ยังไม่ได้ตั้งค่า EB_ENVIRONMENT_NAME");
    if (!isValidVersionLabel(versionLabel)) return adminVersionError(res, 400, "EB_VERSION_LABEL_INVALID", "Version Label ไม่ถูกต้อง");
    try {
        const environment = await describeEnvironment({ environmentName: envName });
        const applicationName = String(environment.ApplicationName || "").trim();
        const version = await getApplicationVersion({ applicationName, versionLabel });
        if (!version.downloadable) return adminVersionError(res, 404, "EB_VERSION_SOURCE_NOT_FOUND", "เวอร์ชันนี้ไม่มี source bundle ให้ดาวน์โหลดแล้ว");
        const principal = getAdminPrincipal(req);
        const nonce = crypto.randomBytes(18).toString("hex");
        const exp = Date.now() + ADMIN_VERSION_DOWNLOAD_TTL_MS;
        const ticket = createSignedState({
            v: 1,
            admin: true,
            type: "admin_eb_version_download",
            applicationName,
            environmentName: envName,
            versionLabel,
            adminSessionNonce: String(principal?.n || "").slice(0, 128),
            exp,
            n: nonce,
        }, ADMIN_SESSION_SECRET);
        if (!ticket) {
            return adminVersionError(res, 503, "EB_VERSION_TICKET_FAILED", "สร้างลิงก์ดาวน์โหลดไม่สำเร็จ");
        }
        return res.json({ ok: true, versionLabel, expiresAt: exp, url: `/api/eb-version-download/${encodeURIComponent(ticket)}` });
    } catch (e) {
        const code = String(e?.code || e?.name || "EB_VERSION_DOWNLOAD_TICKET_FAILED");
        recordDiagnostic({ source: "server", kind: "admin_version_download_ticket_failed", page: "admin", action: "admin_version_download_ticket", operation: code, message: e?.message || String(e), stack: e?.stack || "", data: { versionLabel, environmentName: envName } });
        const status = code === "EB_VERSION_NOT_FOUND" ? 404 : 503;
        return adminVersionError(res, status, code === "EB_VERSION_NOT_FOUND" ? code : "EB_VERSION_DOWNLOAD_TICKET_FAILED", status === 404 ? "ไม่พบ Application Version นี้" : "สร้างลิงก์ดาวน์โหลดไม่สำเร็จ");
    }
});

app.post("/api/admin/versions/rollback", express.json({ limit: "4kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    const envName = configuredEnvironmentName();
    const versionLabel = normalizeVersionLabel(req.body?.versionLabel);
    if (!envName) return adminVersionError(res, 503, "EB_VERSION_MANAGER_NOT_CONFIGURED", "ยังไม่ได้ตั้งค่า EB_ENVIRONMENT_NAME");
    if (!isValidVersionLabel(versionLabel)) return adminVersionError(res, 400, "EB_VERSION_LABEL_INVALID", "Version Label ไม่ถูกต้อง");
    try {
        const environment = await describeEnvironment({ environmentName: envName });
        const currentVersion = String(environment.VersionLabel || "").trim();
        if (versionLabel === currentVersion) return adminVersionError(res, 409, "EB_VERSION_ALREADY_RUNNING", "เวอร์ชันนี้กำลังรันอยู่แล้ว", { currentVersion });
        if (String(environment.Status || "") !== "Ready" || environment.AbortableOperationInProgress) {
            return adminVersionError(res, 409, "EB_VERSION_ENVIRONMENT_BUSY", "Elastic Beanstalk environment กำลังมี operation อยู่ จึงยังไม่สลับเวอร์ชัน", {
                environmentStatus: String(environment.Status || ""),
                abortableOperationInProgress: !!environment.AbortableOperationInProgress,
                currentVersion,
            });
        }
        const applicationName = String(environment.ApplicationName || "").trim();
        const version = await getApplicationVersion({ applicationName, versionLabel });
        if (!isKnownDeployableStatus(version.status)) {
            return adminVersionError(res, 409, "EB_VERSION_NOT_DEPLOYABLE", `Application Version ${versionLabel} มีสถานะ ${version.status || "ไม่ทราบ"} และยังไม่ควรถูกนำกลับมาใช้`);
        }
        await deployApplicationVersion({ environmentName: envName, versionLabel });
        recordDiagnostic({ source: "server", kind: "admin_version_rollback_requested", page: "admin", action: "admin_version_rollback", operation: "elasticbeanstalk.UpdateEnvironment", message: `Requested rollback to ${versionLabel}`, data: { environmentName: envName, applicationName, versionLabel, previousVersion: currentVersion } });
        return res.json({ ok: true, requestedVersion: versionLabel, previousVersion: currentVersion, environmentName: envName, applicationName, deploymentStarted: true });
    } catch (e) {
        const code = String(e?.code || e?.name || "EB_VERSION_ROLLBACK_FAILED");
        recordDiagnostic({ source: "server", kind: "admin_version_rollback_failed", page: "admin", action: "admin_version_rollback", operation: code, message: e?.message || String(e), stack: e?.stack || "", data: { versionLabel, environmentName: envName } });
        if (code === "EB_VERSION_NOT_FOUND") return adminVersionError(res, 404, code, "ไม่พบ Application Version นี้");
        if (/InvalidParameterValue|InsufficientPrivileges|AccessDenied|Unauthorized/i.test(code)) return adminVersionError(res, 503, "EB_VERSION_AWS_PERMISSION_FAILED", "AWS ไม่อนุญาตคำสั่งย้อนเวอร์ชัน — ตรวจ IAM ของ Elastic Beanstalk");
        return adminVersionError(res, 503, "EB_VERSION_ROLLBACK_FAILED", "สั่งย้อนเวอร์ชันไม่สำเร็จ");
    }
});

// APP_VERSION_LABEL: ป้ายเวอร์ชันที่จะโชว์ให้เห็นในเกม (มุมซ้ายบนทุกหน้า)
// แหล่งเดียวกับ Running version ของ AWS Elastic Beanstalk ผ่าน utils/getAppVersion.js
// /api/config และ socket ใช้ Running Version จาก utility เดียวกัน
// utility จะ refresh เป็นระยะ และ /api/config มี short timeout + last-known-good fallback
// เพื่อให้ได้เลข deployment ใหม่โดยไม่ปล่อยให้ AWS control-plane ทำให้ endpoint เกมค้าง

// อ่าน Running Version ตั้งแต่ server start และ refresh ต่อเนื่อง เพราะ Elastic Beanstalk
// อาจอัปเดต VersionLabel หลัง process เริ่มแล้ว ถ้า cache ครั้งเดียวจะค้างอยู่ที่ deployment ก่อนหน้า
startAppVersionRefresh();
getAppVersion({ force: true }).then((version) => {
    console.log("Running version:", version);
}).catch((err) => {
    console.error("Failed to initialize app version:", err);
});

// endpoint เล็ก ๆ ให้ client ฝั่ง front-end อ่านค่ารุ่นปัจจุบัน + ที่อยู่รูปภาพตอนโหลดหน้า/โพลเป็นระยะ
// คำนวณ version สดทุกครั้งที่มีการเรียก (ไม่ใช้ค่า cache ตายตัว) เพื่อให้จับการเปลี่ยนไฟล์ static
// ได้ทันทีแม้ deploy แบบสลับไฟล์โดยไม่ restart process
// Client-side error intake — deliberately separate from game socket so a broken game JS file can still report.
// ============================================================
// LIGHTWEIGHT BUG REPORTS
// ============================================================
// Production keeps only a small report inbox for Admin. No diagnostic graph, replay,
// screenshot pipeline, incident correlation, or runtime audit is stored here.
const BUG_REPORT_MAX = 200;
const BUG_REPORT_TEXT_MAX = 6000;
const bugReports = [];
const bugReportRate = new Map();
const { createBugReportStore } = require("./utils/bug-report-store");
const bugReportStore = createBugReportStore({ client:getDynamoDocClient, table:ROOM_PERSISTENCE_TABLE,
    QueryCommand, PutCommand, DeleteCommand, GetCommand, enabled:process.env.BUG_REPORT_PERSISTENCE_ENABLED === "true" || (process.env.BUG_REPORT_PERSISTENCE_ENABLED !== "false" && ROOM_PERSISTENCE_ENABLED) });
let bugReportStorageError = "";
const pendingBugReportIds = new Set();
const githubReportInFlight = new Set();
function cacheBugReport(report) {
    const index = bugReports.findIndex(item => item.id === report.id);
    if (index >= 0) bugReports.splice(index, 1);
    bugReports.push(report);
    bugReports.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    while (bugReports.length > BUG_REPORT_MAX) pendingBugReportIds.delete(bugReports.pop().id);
}
async function persistBugReport(report) {
    try { await bugReportStore.save(report); pendingBugReportIds.delete(report.id); bugReportStorageError = ""; }
    catch (error) { bugReportStorageError = String(error.name || "StorageError"); throw error; }
}
async function refreshBugReportInbox() {
    if (!bugReportStore.enabled) return;
    try {
        const durable = await bugReportStore.list(BUG_REPORT_MAX);
        const pending = bugReports.filter(report => pendingBugReportIds.has(report.id));
        bugReports.length = 0;
        for (const report of [...durable, ...pending]) cacheBugReport(report);
        bugReportStorageError = "";
    }
    catch (error) { bugReportStorageError = String(error.name || "StorageError"); }
}

function bugReportClientIp(req) {
    return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
        || String(req.ip || req.socket?.remoteAddress || "unknown");
}
function trimBugReportText(value, max = BUG_REPORT_TEXT_MAX) {
    return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, max);
}
function publicBugReport(report) {
    return {
        id: String(report.id || ""),
        createdAt: String(report.createdAt || ""),
        source: String(report.source || "client"),
        page: String(report.page || ""),
        version: String(report.version || ""),
        message: trimBugReportText(report.message, 2400),
        stack: trimBugReportText(report.stack, 5000),
        roomId: String(report.roomId || "").slice(0, 20),
        playerName: String(report.playerName || "").slice(0, 120),
        status: String(report.status || "new"),
        githubIssueUrl: String(report.githubIssueUrl || ""),
        userAgent: String(report.userAgent || "").slice(0, 600),
    };
}
function addBugReport(data = {}) {
    const report = {
        id: /^[a-zA-Z0-9_-]{1,96}$/.test(String(data.id || "")) ? String(data.id) : makeDiagnosticId("bug"),
        createdAt: Number.isFinite(Date.parse(data.createdAt)) && Math.abs(Date.now()-Date.parse(data.createdAt)) < 30*86400_000
            ? new Date(data.createdAt).toISOString() : new Date().toISOString(),
        source: trimBugReportText(data.source || "client", 30),
        page: trimBugReportText(data.page || "", 80),
        version: trimBugReportText(data.version || "", 100),
        message: trimBugReportText(data.message || "", BUG_REPORT_TEXT_MAX),
        stack: trimBugReportText(data.stack || "", BUG_REPORT_TEXT_MAX),
        roomId: trimBugReportText(data.roomId || "", 20),
        playerName: trimBugReportText(data.playerName || "", 120),
        userAgent: trimBugReportText(data.userAgent || "", 600),
        status: "new",
        githubIssueUrl: "",
    };
    if (!report.message && !report.stack) return null;
    cacheBugReport(report);
    pendingBugReportIds.add(report.id);
    return report;
}
bugReportSink = data => {
    const recent = bugReports.find(report => report.source === "server" && report.message === trimBugReportText(data.message) && report.page === data.page && Date.now()-Date.parse(report.createdAt)<8000);
    if (recent) return recent;
    const report = addBugReport(data);
    if (report) persistBugReport(report).catch(error => console.error("[bug-inbox] Persistence failed:", error.name));
    return report;
};
let bugReportRetryBusy = false;
const bugReportRetryTimer = setInterval(async () => {
    if (bugReportRetryBusy || !pendingBugReportIds.size || !bugReportStore.enabled) return;
    bugReportRetryBusy = true;
    try { for (const report of bugReports.filter(item => pendingBugReportIds.has(item.id)).slice(0, 10)) {
        try { await persistBugReport(report); } catch (_) { break; }
    } } finally { bugReportRetryBusy = false; }
}, 30_000);
bugReportRetryTimer.unref?.();
app.post("/api/bug-reports", express.json({ limit: "24kb" }), async (req, res) => {
    const ip = bugReportClientIp(req);
    const now = Date.now();
    const old = bugReportRate.get(ip);
    if (old && now - old.at < 60_000 && old.count >= 120) {
        res.setHeader("Retry-After", "60");
        return res.status(429).json({ ok:false, error:"rate_limited", code:"BUG_REPORT_RATE_LIMITED" });
    }
    bugReportRate.set(ip, (!old || now - old.at >= 60_000) ? { at:now, count:1 } : { at:old.at, count:old.count+1 });
    const data = req.body || {};
    let duplicate = bugReports.find(report => report.id === data.id);
    if (!duplicate && data.id && Number.isFinite(Date.parse(data.createdAt))) {
        try { duplicate = await bugReportStore.find({id:String(data.id),createdAt:new Date(data.createdAt).toISOString()}); }
        catch (_) { return res.status(503).json({ok:false,error:"report_storage_unavailable"}); }
    }
    const report = duplicate || addBugReport(data);
    if (!report) return res.status(400).json({ ok:false, error:"report_empty", code:"BUG_REPORT_EMPTY" });
    try { await persistBugReport(report); }
    catch (_) { return res.status(503).json({ ok:false, code:"BUG_REPORT_STORAGE_UNAVAILABLE", error:"report_storage_unavailable" }); }
    res.status(201).json({ ok:true, report:publicBugReport(report) });
});
app.get("/api/admin/bug-reports", async (req, res) => {
    await refreshBugReportInbox();
    const limit = Math.min(BUG_REPORT_MAX, Math.max(1, Number(req.query.limit) || 50));
    res.setHeader("Cache-Control", "no-store, private");
    res.json({ ok:true, reports:bugReports.slice(0, limit).map(publicBugReport), total:bugReports.length,
        storage:bugReportStorageError ? "degraded" : bugReportStore.enabled ? "durable" : "memory",
        storageError:bugReportStorageError, github:buildGithubBugReportStatus() });
});
app.post("/api/admin/bug-reports/:id/status", express.json({ limit:"2kb" }), async (req,res) => {
    await refreshBugReportInbox();
    const id=String(req.params.id || "").trim();
    const status=String(req.body?.status || "").trim();
    if (!['new','reviewed','sent_to_github','closed'].includes(status)) return res.status(400).json({ok:false,error:"status_invalid",code:"BUG_REPORT_STATUS_INVALID"});
    const report=bugReports.find((item)=>item.id===id);
    if (!report) return res.status(404).json({ok:false,error:"report_not_found",code:"BUG_REPORT_NOT_FOUND"});
    const updated = { ...report, status };
    try { await persistBugReport(updated); } catch (_) { return res.status(503).json({ok:false,error:"report_storage_unavailable"}); }
    cacheBugReport(updated);
    res.json({ok:true,report:publicBugReport(updated)});
});
app.post("/api/admin/bug-reports/:id/github", express.json({ limit:"2kb" }), async (req,res) => {
    const requestId = String(req.params.id || "").trim();
    if (githubReportInFlight.has(requestId)) return res.status(409).json({ok:false,error:"github_send_in_progress"});
    githubReportInFlight.add(requestId);
    try {
    await refreshBugReportInbox();
    const report=bugReports.find((item)=>item.id===String(req.params.id || "").trim());
    if (!report) return res.status(404).json({ok:false,error:"report_not_found",code:"BUG_REPORT_NOT_FOUND"});
    if (report.githubIssueUrl) {
        try { await persistBugReport(report); } catch (_) { return res.status(503).json({ok:false,error:"report_storage_unavailable"}); }
        return res.json({ok:true,issue:{issueUrl:report.githubIssueUrl},report:publicBugReport(report)});
    }
    const config=getGithubBugReportConfig();
    if (!config.configured) return res.status(503).json({ok:false,error:"github_not_configured",code:config.configurationError || "GITHUB_NOT_CONFIGURED"});
    try {
        const issue=buildGithubBugReportIssue({ report:publicBugReport(report) });
        const created=await createGithubBugReportIssue({ issue, config });
        report.status="sent_to_github";
        report.githubIssueUrl=created.issueUrl;
        pendingBugReportIds.add(report.id);
        await persistBugReport(report);
        res.json({ok:true,issue:created,report:publicBugReport(report)});
    } catch (e) {
        const code=String(e?.publicCode || e?.code || "GITHUB_CREATE_ISSUE_FAILED");
        res.status(502).json({ok:false,error:"github_bug_report_failed",code,message:publicGithubText(e?.message || String(e))});
    }
    } finally { githubReportInFlight.delete(requestId); }
});
app.delete("/api/admin/bug-reports/:id", async (req,res) => {
    await refreshBugReportInbox();
    const id=String(req.params.id || "").trim();
    const index=bugReports.findIndex((item)=>item.id===id);
    if (index<0) return res.status(404).json({ok:false,error:"report_not_found",code:"BUG_REPORT_NOT_FOUND"});
    try { await bugReportStore.remove(bugReports[index]); } catch (_) { return res.status(503).json({ok:false,error:"report_storage_unavailable"}); }
    pendingBugReportIds.delete(id);
    bugReports.splice(index,1);
    res.json({ok:true});
});

// CloudFront-safe Admin release probe:
// บาง distribution อาจไม่ใช้ query string เป็น cache key แม้ origin จะส่ง no-store
// ดังนั้นหน้า Admin จะเรียก GET path ที่เปลี่ยนตามช่วงเวลาแทน /api/config?... เพื่อให้
// cache key ของ CloudFront เปลี่ยนจริงทุกช่วงตรวจรุ่น และยังอ่าน fingerprint จาก origin ได้
const ADMIN_RELEASE_PROBE_WINDOW_MS = 30 * 1000;
function adminReleaseProbeBucket() {
    return Math.floor(Date.now() / ADMIN_RELEASE_PROBE_WINDOW_MS).toString(36);
}
function adminReleaseConfigPayload() {
    const parts = refreshVersionParts();
    return {
        ok: true,
        adminHash: computeAdminHash(),
        clientHash: parts.client,
        assetsHash: parts.assets,
        serverHash: parts.server,
        version: computeServerVersion(),
        serverNow: Date.now(),
    };
}
app.get("/api/admin/release-check/:bucket", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Surrogate-Control", "no-store");
    res.setHeader("Vary", "Accept-Encoding, Cookie");
    res.setHeader("X-WW-Release-Probe", adminReleaseProbeBucket());
    res.json(adminReleaseConfigPayload());
});

// /api/server-state — lightweight first-paint gate for the public index page.
// Keep this endpoint deliberately independent from getAppVersion()/AWS control-plane work so
// an open server can release the Lobby quickly, while a closed server is confirmed before first paint.
app.get("/api/server-state", async (req, res) => {
    const shielded = req.query.real !== "1" && isProtectedRequest(req);
    const forceAuthorityRead = req.query.boot === "1" || req.query.verify === "1";
    const persisted = await syncServerStateFromAuthority({ force: forceAuthorityRead });
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Surrogate-Control", "no-store");
    res.setHeader("Vary", "Cookie, X-WW-Room, X-WW-Token");
    res.setHeader("X-WW-Server-State-Source", persisted ? "dynamodb" : "local-fallback");
    res.json({
        ok: true,
        serverOpen: !serverClosed || shielded,
        testerShielded: !!shielded,
        serverNow: Date.now(),
        closingInMs: !shielded && closingPlan ? Math.max(1, closingPlan.closeAt - Date.now()) : 0,
        noticeMessage: shielded ? "" : (closingPlan ? closingPlan.message : closedMessage),
        reopenAt: shielded ? 0 : (closingPlan ? closingPlan.reopenAt : closedReopenAt),
        imageBase: LOCAL_IMAGE_BASE,
        imageVersion: imageEpoch || "",
        serverIconUrl: imgUrl(SERVER_CLOSED_ICON_PATH),
    });
});

app.get("/api/config", async (req, res) => {
    try {
        const deploymentProbe = req.query.deploymentProbe === "1";
        const versionPromise = getAppEnvironmentState({ force: deploymentProbe }).then((state) => state.versionLabel);
        const versionTimeout = new Promise((resolve) => setTimeout(() => resolve(getCachedAppVersion()), 1200));
        const appVersion = await Promise.race([versionPromise, versionTimeout]);
        const environmentState = getCachedAppEnvironmentState();
        ensureResetEpochLoaded();
        const shielded = req.query.real !== "1" && isProtectedRequest(req);
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Surrogate-Control", "no-store");
        res.setHeader("Vary", "Cookie, X-WW-Room, X-WW-Token, X-WW-Config-Attempt");
        const versionParts = refreshVersionParts();
        res.json({
            version: computeServerVersion(), clientHash: versionParts.client, assetsHash: versionParts.assets,
            serverHash: versionParts.server, adminHash: computeAdminHash(), buildVersion: computeServerVersion(),
            imageBase: LOCAL_IMAGE_BASE, serverIconUrl: imgUrl(SERVER_CLOSED_ICON_PATH),
            appVersion, environmentStatus: environmentState.status, environmentVersionLabel: environmentState.versionLabel,
            deploymentState: environmentState.deploymentState, deploymentInProgress: environmentState.deploymentState === "updating",
            deploymentAbortable: !!environmentState.abortableOperationInProgress,
            resetEpoch: resetEpoch || "", resetInProgress: !!resetInProgress,
            serverOpen: !serverClosed || shielded, testerShielded: !!shielded,
            reloadEpoch: shielded ? "" : reloadEpoch, reloadKind: shielded ? "" : reloadKind,
            testerReloadEpoch: shielded ? testerReloadEpoch : "", imageEpoch: currentImageVersion(), serverNow: Date.now(),
            closingInMs: !shielded && closingPlan ? Math.max(1, closingPlan.closeAt - Date.now()) : 0,
            noticeMessage: shielded ? "" : (closingPlan ? closingPlan.message : closedMessage),
            reopenAt: shielded ? 0 : (closingPlan ? closingPlan.reopenAt : closedReopenAt),
        });
    } catch (e) {
        console.error("[config] unavailable:", e?.message || e);
        if (!res.headersSent) res.status(500).json({ error:"config_unavailable" });
    }
});

// ============================================================
// /api/build-manifest — manifest สำหรับตรวจว่า client ได้ไฟล์ build ปัจจุบันจริง
// ไม่เปิดเผย server source; ส่งเฉพาะไฟล์ public ที่หน้าเกมใช้ + hash ของกลุ่มไฟล์
// ============================================================
function sha256File(file) {
    try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
    catch (_) { return ""; }
}

function collectReferencedImagePaths(codeFiles, assetFiles) {
    const refs = new Set();
    const imageExt = "(?:png|jpe?g|gif|webp|avif|ico)";
    const re = /["'`]((?:\/)?images\/[^"'`?#\s]+\.(?:png|jpe?g|gif|webp|avif|ico))[?#]?/gi;
    for (const f of codeFiles) {
        try {
            const text = fs.readFileSync(f, "utf8");
            let m;
            while ((m = re.exec(text))) refs.add("/" + m[1].replace(/^\/+/, ""));
        } catch (_) {}
    }
    for (const f of assetFiles) {
        if (CLIENT_IMAGE_EXTS.has(path.extname(f).toLowerCase())) {
            refs.add("/" + path.relative(PUBLIC_DIR, f).split(path.sep).join("/"));
        }
    }
    return [...refs].sort();
}

function buildClientManifest() {
    const code = [];
    const assets = [];
    walkPublicFiles(PUBLIC_DIR, code, assets);
    code.sort();
    assets.sort();
    const pageFiles = Object.values(STAMPED_PAGES);
    const uniquePages = [...new Set(pageFiles)].map((f) => path.join(PUBLIC_DIR, f)).filter((f) => fs.existsSync(f));
    const imagePaths = collectReferencedImagePaths(code, assets);
    return {
        clientHash: computeClientHash(),
        assetsHash: refreshVersionParts().assets,
        serverHash: refreshVersionParts().server,
        version: computeServerVersion(),
        imageEpoch: currentImageVersion(),
        imageBase: LOCAL_IMAGE_BASE,
        generatedAt: Date.now(),
        pages: uniquePages.map((f) => ({ path: "/" + path.relative(PUBLIC_DIR, f).split(path.sep).join("/"), sha256: sha256File(f) })),
        clientFiles: code.map((f) => ({ path: "/" + path.relative(PUBLIC_DIR, f).split(path.sep).join("/"), sha256: sha256File(f) })),
        localImages: assets.filter((f) => CLIENT_IMAGE_EXTS.has(path.extname(f).toLowerCase())).map((f) => ({ path: "/" + path.relative(PUBLIC_DIR, f).split(path.sep).join("/"), sha256: sha256File(f) })),
        imageUrls: imagePaths.map((imgPath) => imgUrl(imgPath)),
    };
}

app.get("/api/build-manifest", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie");
    res.json(buildClientManifest());
});

// ============================================================
// /api/roles-data — ข้อมูลอาชีพ (ชื่อ/คำอธิบาย/ไอคอน) แบบ HTTP สำหรับหน้า "เซิร์ฟเวอร์กำลังปิด"
// ============================================================
// เดิมข้อมูลอาชีพส่งทาง socket event roles_data เท่านั้น → หน้า "กำลังปิด" ที่เพิ่งเปิดสดตอนปิดอยู่ (ไม่มี socket/ไม่เคยเข้าเกม/localStorage ว่าง)
// จึงไม่มีข้อมูลอาชีพเลย (iPad เห็นหน้าว่างๆ) — endpoint นี้ไม่ต้อง login, ไม่ผูกกับห้อง/ผู้เล่น, ผ่านด่านตอนปิดเซิร์ฟเวอร์ (ดู CLOSED gate ด้านบน)
// ข้อมูลชุดเดียวกับ socket roles_data (buildRolesData) ไอคอนต่อ ?v= ตามเลขรุ่นรูปปัจจุบัน
// no-store + ETag ปิด: ตอบ JSON สดทุกครั้ง กัน Safari แคชข้อมูล/รูป URL เก่า
app.get("/api/roles-data", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(buildRolesData());
});

// ============================================================
// หน้าเกมหลัก (index/host/player) — เสิร์ฟพร้อม "ประทับ version" ที่ URL ของ js/css (?v=<clientHash>)
// ============================================================
// เหตุผล: หน้า HTML เดิมอ้าง js/*.js, css/*.css แบบไม่มี query → เบราว์เซอร์ (โดยเฉพาะ Safari + bfcache/หน้าที่แช่แข็งไว้)
// อาจได้ "HTML รุ่นหนึ่ง + JS/CSS อีกรุ่นหนึ่ง" ปนกัน ทำให้ Android/iOS เห็นเกมคนละรุ่นได้ — ตอนนี้ URL ของ js/css เปลี่ยนทุกครั้งที่ไฟล์
// client เปลี่ยน (hash ของเนื้อหา) → HTML ชุดไหนก็ดึง js/css "ชุดเดียวกับตัวเอง" เสมอ เครื่องไหนโหลด HTML รุ่นใหม่ก็ได้ js/css รุ่นใหม่ทันที
// ไม่มีการ reload/redirect เกิดขึ้นจากตรงนี้ — แค่เปลี่ยนสิ่งที่หน้าใหม่ที่ "ผู้ใช้เปิดเอง" จะดึง
// Cache-Control: no-cache (ถามเซิร์ฟเวอร์ทุกครั้งด้วย ETag) — express สร้าง ETag จากเนื้อหาที่ประทับแล้ว จึงได้ 304 เมื่อไม่เปลี่ยน
const STAMPED_PAGES = { "/": "index.html", "/index.html": "index.html", "/host.html": "host.html", "/player.html": "player.html" };

// Internal Admin Browser pages use a release-scoped pathname so CDN/cache policy for the
// top-level game pages cannot leave an iframe stuck on a stale/blocked response. The
// document immediately restores the canonical /index.html|/host.html|/player.html URL
// before any game script executes, so existing client code still sees its normal pathname.
const ADMIN_EMBED_PAGE_RE = /^\/__(?:ww_admin_embed)__\/([a-zA-Z0-9_-]{1,80})\/(index|host|player)\.html$/;
function getAdminEmbeddedHtml(fileName, canonicalPath) {
    const html = getStampedHtml(fileName);
    if (html === null) return null;
    const bootstrap = `<base href="/">` +
        `<script>(function(){try{history.replaceState(null,document.title,"${canonicalPath}"+location.search+location.hash);}catch(_){}})();</script>`;
    return html.replace(/<head>/i, `<head>${bootstrap}`);
}
const _stampedCache = new Map(); // fileName -> { hash, mtime, html }
const STAMP_REF_RE = /(\b(?:src|href)=")((?:js|css)\/[^"?#]+\.(?:js|css))(")/g;

function getStampedHtml(fileName) {
    const file = path.join(PUBLIC_DIR, fileName);
    const hash = computeClientHash();
    let mtime = 0;
    try { mtime = Math.floor(fs.statSync(file).mtimeMs); } catch (e) { return null; }
    const cached = _stampedCache.get(fileName);
    if (cached && cached.hash === hash && cached.mtime === mtime) return cached.html;
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return null; }
    let html = raw.replace(STAMP_REF_RE, (_m, pre, url, post) => `${pre}${url}?v=${hash}${post}`);
    html = html.replace(/<head>/i, `<head><script src="/js/admin-frame-storage.js?v=${hash}"></script>`);
    _stampedCache.set(fileName, { hash, mtime, html });
    return html;
}
app.get("/__ww_admin_embed__/:release/:page.html", (req, res, next) => {
    const page = String(req.params.page || "");
    const fileName = page === "index" ? "index.html" : page === "host" ? "host.html" : page === "player" ? "player.html" : "";
    const canonicalPath = page === "index" ? "/index.html" : page === "host" ? "/host.html" : page === "player" ? "/player.html" : "";
    if (!fileName || !canonicalPath) return next();
    const html = getAdminEmbeddedHtml(fileName, canonicalPath);
    if (html === null) return next();
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Surrogate-Control", "no-store");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
    res.setHeader("Vary", "Accept-Encoding, Cookie");
    res.type("html").send(html);
});

app.get(Object.keys(STAMPED_PAGES), (req, res, next) => {
    const html = getStampedHtml(STAMPED_PAGES[req.path]);
    if (html === null) return next(); // อ่านไม่ได้ → ให้ express.static ตอบตามเดิม
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", "Accept-Encoding");
    res.type("html").send(html);
});

// admin.html / maintenance.html: ไม่เข้าระบบ hash เวอร์ชัน js/css แต่ site/profile icons ชี้ไปยัง public/images/
const ICON_ONLY_PAGES = { "/admin.html": "admin.html", "/maintenance.html": "maintenance.html" };
const _iconOnlyCache = new Map();
function getIconStampedHtml(fileName) {
    const file = path.join(PUBLIC_DIR, fileName);
    let mtime = 0;
    try { mtime = Math.floor(fs.statSync(file).mtimeMs); } catch (e) { return null; }
    const cached = _iconOnlyCache.get(fileName);
    const release = fileName === "admin.html" ? computeAdminHash() : "";
    if (cached && cached.mtime === mtime && cached.release === release) return cached.html;
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return null; }
    let html = raw;
    if (fileName === "admin.html") html = html.replace(/(\b(?:src|href)=")((?:\/)?(?:js|css)\/[^"?#]+\.(?:js|css))(?:\?[^"#]*)?(")/g, (_m, pre, url, post) => `${pre}${url}?v=${release}${post}`);
    if (fileName === "admin.html") html = html.replace(/(<meta\s+name="ww-admin-release"\s+content=")__WW_ADMIN_RELEASE__("\s*\/?\s*>)/i, `$1${release}$2`);
    _iconOnlyCache.set(fileName, { mtime, html, release });
    return html;
}
// CloudFront-safe Admin reload endpoint. A unique pathname prevents a cached /admin.html
// object (or a distribution that ignores query strings) from serving the previous shell again.
app.get("/admin-refresh/:nonce", (req, res) => {
    const html = getIconStampedHtml("admin.html");
    if (html === null) return res.status(503).type("text").send("Admin page unavailable");
    const nonce = String(req.params.nonce || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "refresh";
    const freshHtml = html.replace(
        /<head>/i,
        `<head><script>(function(){try{history.replaceState(null,document.title,"/admin.html");}catch(_){}})();<\/script>`
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Surrogate-Control", "no-store");
    res.setHeader("X-WW-Admin-Reload", nonce);
    res.type("html").send(freshHtml);
});

app.get(Object.keys(ICON_ONLY_PAGES), (req, res, next) => {
    const html = getIconStampedHtml(ICON_ONLY_PAGES[req.path]);
    if (html === null) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
});

// Game images are bundled with the application under public/images/.
// no-store is intentional: starting a new game page must request the asset again instead of
// treating a browser-side cached copy as the source of truth.
app.use("/images", express.static(path.join(PUBLIC_DIR, "images"), {
    fallthrough: false,
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Surrogate-Control", "no-store");
    },
}));

// maxAge: ให้เบราว์เซอร์ cache ไฟล์ static (รูปไอคอนอาชีพ ฯลฯ) ไว้ ไม่ต้องโหลดซ้ำทุกครั้งที่เจอ
// ยกเว้นไฟล์ .html/.js/.css — ห้าม cache ไฟล์พวกนี้นาน ๆ เด็ดขาด เพราะพอ deploy โค้ดใหม่
// คนที่เข้าลิงก์ซ้ำ (ไม่ใช่แค่แท็บที่เปิดค้าง) จะยังได้ของเก่าจาก cache ของเบราว์เซอร์อยู่ดี
// ตั้งเป็น no-cache (ไม่ใช่ no-store) เพื่อให้ยัง revalidate ด้วย ETag ได้ ไม่ต้องโหลดเต็มทุกครั้งถ้าไฟล์ไม่เปลี่ยน
//
// หมายเหตุบั๊กเดิม: เงื่อนไขเช็คแค่ ".html" อย่างเดียว ทำให้ .js/.css หลุดไปโดน
// "immutable" (30 วัน ไม่ revalidate เลยแม้แต่ครั้งเดียว) ไปด้วยทั้งที่ตั้งใจจะให้แค่รูปภาพ
// Safari เชื่อฟัง immutable เข้มงวดมาก ผลคือกด refresh หน้า .html เท่าไหร่ก็ตาม ตัว .js/.css
// ที่หน้านั้นอ้างถึงก็ยังใช้ของเก่าจากแคชเครื่องอยู่ดี เพราะ URL ไม่มี query/hash เปลี่ยนให้เบราว์เซอร์
// มีเหตุผลไปขอใหม่ แก้โดยเช็ค whitelist เฉพาะไฟล์ที่ควร cache ยาว (รูปภาพ) แทน
// อัปเดต: รูปภาพ/ฟอนต์ก็ใช้ no-cache เหมือนไฟล์อื่น (เดิมเป็น immutable 30 วัน)
// เหตุผล: ถ้าเปลี่ยนรูป (เช่น favicon, โลโก้, cover) ผู้เล่นที่เคยเข้าเกมแล้วจะไม่เห็นรูปใหม่เลยนาน 30 วัน
// no-cache ไม่ได้แปลว่า "โหลดใหม่ทุกครั้ง" — เบราว์เซอร์ยังเก็บรูปไว้ในเครื่อง แต่จะถามเซิร์ฟเวอร์สั้น ๆ ว่า
// "รูปนี้เปลี่ยนตั้งแต่วันที่/เวลา (Last-Modified / ETag) ที่ฉันมีหรือยัง?"
//   - ไม่เปลี่ยน → ตอบ 304 (ไม่มีตัวรูป เบามาก) เบราว์เซอร์ใช้รูปในเครื่องต่อได้เลย
//   - เปลี่ยนแล้ว → ส่งรูปใหม่ให้ทันที
// (รูปไอคอนอาชีพที่อยู่บน S3 ต้องตั้ง Cache-Control: no-cache ที่ตัว object ใน S3 ด้วย — ดู how_to_deploy.md)

// express.static ต้องมาหลังเส้นทางด้านบน (ไม่งั้น "/" จะได้ index.html ดิบที่ไม่มี ?v=)
app.use(express.static(PUBLIC_DIR, {
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath && path.dirname(filePath) === path.join(PUBLIC_DIR, "images")) {
            res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Surrogate-Control", "no-store");
            return;
        }
        res.setHeader("Cache-Control", "no-cache");
    },
}));

function roomStorageKey(roomId) {
    return `${ROOM_KEY_PREFIX}${String(roomId || "").toUpperCase()}`;
}

function roomIdsFromDynamoSet(value) {
    if (!value) return [];
    if (value instanceof Set) return [...value].map(String);
    if (Array.isArray(value)) return value.map(String);
    return [];
}

function trimHistoryArray(arr, max) {
    return Array.isArray(arr) && arr.length > max ? arr.slice(-max) : (Array.isArray(arr) ? arr : []);
}

function compactRoomSnapshot(room, aggressive = false) {
    const cloned = JSON.parse(JSON.stringify(room));
    // Socket IDs are transient connection handles. Keep the legacy player.id inside the snapshot
    // only because older game-state maps still reference it; token + membershipId are the
    // durable room identity and are now the primary reconnect keys.
    // hostIds/host are only live socket bookkeeping and must never be restored as active sockets.
    cloned.host = "";
    cloned.hostIds = [];
    if (Array.isArray(cloned.players)) {
        cloned.players.forEach((p) => { if (p) { delete p.activeDeviceId; delete p.activeTabId; } });
    }

    const normalMax = aggressive ? 40 : 150;
    const globalMax = aggressive ? 80 : 250;
    cloned.globalChatHistory = trimHistoryArray(cloned.globalChatHistory, globalMax);
    cloned.wolfChatHistory = trimHistoryArray(cloned.wolfChatHistory, normalMax);
    cloned.hostPrivateChatLog = trimHistoryArray(cloned.hostPrivateChatLog, normalMax);

    for (const field of ["instigatorChatHistory", "cultChatHistory", "banditChatHistory"]) {
        const src = cloned[field];
        if (!src || typeof src !== "object") continue;
        for (const key of Object.keys(src)) src[key] = trimHistoryArray(src[key], normalMax);
    }
    if (cloned.privateChatLog && typeof cloned.privateChatLog === "object") {
        for (const token of Object.keys(cloned.privateChatLog)) {
            cloned.privateChatLog[token] = trimHistoryArray(cloned.privateChatLog[token], normalMax);
        }
    }
    return cloned;
}

function makeRoomSnapshotPayload(room) {
    let snapshot = compactRoomSnapshot(room, false);
    let serialized = JSON.stringify(snapshot);
    let truncated = false;
    if (Buffer.byteLength(serialized, "utf8") > ROOM_SNAPSHOT_MAX_BYTES) {
        snapshot = compactRoomSnapshot(room, true);
        serialized = JSON.stringify(snapshot);
        truncated = true;
    }
    // Extremely chat-heavy rooms should never make DynamoDB reject the item. If even the
    // aggressive snapshot is too large, preserve gameplay state and drop chat history only.
    if (Buffer.byteLength(serialized, "utf8") > ROOM_SNAPSHOT_MAX_BYTES) {
        snapshot.globalChatHistory = [];
        snapshot.wolfChatHistory = [];
        snapshot.hostPrivateChatLog = [];
        snapshot.instigatorChatHistory = {};
        snapshot.cultChatHistory = {};
        snapshot.banditChatHistory = {};
        snapshot.privateChatLog = {};
        serialized = JSON.stringify(snapshot);
        truncated = true;
    }
    if (Buffer.byteLength(serialized, "utf8") > ROOM_SNAPSHOT_MAX_BYTES) {
        throw new Error(`ROOM_SNAPSHOT_TOO_LARGE:${Buffer.byteLength(serialized, "utf8")}`);
    }
    return { serialized, truncated };
}

function roomSignature(room) {
    try {
        const { serialized } = makeRoomSnapshotPayload(room);
        return crypto.createHash("sha1").update(serialized).digest("hex");
    } catch (_) {
        return "error";
    }
}

function deploymentHandoffInProgress() {
    return getCachedAppEnvironmentState().deploymentState === "updating";
}

function roomLeaseKey(roomId) {
    return { playerName: roomStorageKey(roomId), statKey: ROOM_LEASE_STAT_KEY };
}

function roomLeaseOwnedLocally(roomId) {
    return roomLeaseEpochs.has(String(roomId || "").toUpperCase());
}

async function acquireRoomLease(roomId, { allowDuringDeployment = true } = {}) {
    if (!ROOM_PERSISTENCE_ENABLED || !roomId) return { ok: false, code: "ROOM_PERSISTENCE_DISABLED" };
    const id = String(roomId).trim().toUpperCase();
    if (!id) return { ok: false, code: "ROOM_ID_REQUIRED" };
    const doc = await getDynamoDocClient();
    const key = roomLeaseKey(id);
    const now = Date.now();
    const until = now + ROOM_LEASE_TTL_MS;
    const existing = (await doc.send(new GetCommand({
        TableName: ROOM_PERSISTENCE_TABLE,
        Key: key,
        ConsistentRead: true,
    })) ).Item || null;
    const currentOwner = String(existing?.ownerInstanceId || "");
    const currentUntil = Number(existing?.leaseUntil || 0);
    const currentEpoch = Number(existing?.leaseEpoch || 0);
    if (!allowDuringDeployment && deploymentHandoffInProgress()) {
        return { ok: false, code: "ROOM_FAILOVER_WAIT", retryAfterMs: ROOM_FAILOVER_RETRY_MS, ownerInstanceId: currentOwner };
    }

    const canTake = !existing || currentOwner === INSTANCE_ID || currentUntil <= now;
    if (!canTake) {
        return { ok: false, code: "ROOM_LEASE_UNAVAILABLE", retryAfterMs: ROOM_FAILOVER_RETRY_MS, ownerInstanceId: currentOwner, leaseUntil: currentUntil, leaseEpoch: currentEpoch };
    }

    const nextEpoch = currentOwner === INSTANCE_ID && currentEpoch > 0 ? currentEpoch : Math.max(1, currentEpoch + 1);
    try {
        await doc.send(new PutCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Item: {
                ...key,
                roomId: id,
                ownerInstanceId: INSTANCE_ID,
                leaseEpoch: nextEpoch,
                leaseUntil: until,
                renewedAt: now,
                draining: false,
            },
            ConditionExpression: "attribute_not_exists(#leaseUntil) OR #leaseUntil <= :now OR #owner = :owner",
            ExpressionAttributeNames: { "#leaseUntil": "leaseUntil", "#owner": "ownerInstanceId" },
            ExpressionAttributeValues: { ":now": now, ":owner": INSTANCE_ID },
        }));
        roomLeaseEpochs.set(id, nextEpoch);
        return { ok: true, roomId: id, ownerInstanceId: INSTANCE_ID, leaseEpoch: nextEpoch, leaseUntil: until };
    } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") {
            const winner = (await doc.send(new GetCommand({ TableName: ROOM_PERSISTENCE_TABLE, Key: key, ConsistentRead: true }))).Item || null;
            return {
                ok: false,
                code: "ROOM_LEASE_UNAVAILABLE",
                retryAfterMs: ROOM_FAILOVER_RETRY_MS,
                ownerInstanceId: String(winner?.ownerInstanceId || ""),
                leaseUntil: Number(winner?.leaseUntil || 0),
                leaseEpoch: Number(winner?.leaseEpoch || 0),
            };
        }
        throw e;
    }
}

function scheduleRoomLeaseRenewal(roomId) {
    const id = String(roomId || "").toUpperCase();
    if (!id || roomLeaseTimers.has(id) || !ROOM_PERSISTENCE_ENABLED) return;
    const timer = setInterval(() => {
        renewRoomLease(id).catch((e) => console.error(`[room-lease] renew ${id} failed:`, e?.name || "Error", e?.message || e));
    }, ROOM_LEASE_RENEW_MS);
    timer.unref?.();
    roomLeaseTimers.set(id, timer);
}

async function renewRoomLease(roomId) {
    const id = String(roomId || "").toUpperCase();
    const epoch = Number(roomLeaseEpochs.get(id) || 0);
    if (!id || !epoch || !ROOM_PERSISTENCE_ENABLED || appDraining) return false;
    const doc = await getDynamoDocClient();
    const now = Date.now();
    const until = now + ROOM_LEASE_TTL_MS;
    try {
        await doc.send(new UpdateCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Key: roomLeaseKey(id),
            UpdateExpression: "SET #until = :until, #renewed = :now, #draining = :false",
            ConditionExpression: "#owner = :owner AND #epoch = :epoch",
            ExpressionAttributeNames: { "#until": "leaseUntil", "#renewed": "renewedAt", "#draining": "draining", "#owner": "ownerInstanceId", "#epoch": "leaseEpoch" },
            ExpressionAttributeValues: { ":until": until, ":now": now, ":false": false, ":owner": INSTANCE_ID, ":epoch": epoch },
        }));
        return true;
    } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") {
            clearRoomLeaseRenewal(id);
            roomLeaseEpochs.delete(id);
            return false;
        }
        throw e;
    }
}

function clearRoomLeaseRenewal(roomId) {
    const id = String(roomId || "").toUpperCase();
    const timer = roomLeaseTimers.get(id);
    if (timer) clearInterval(timer);
    roomLeaseTimers.delete(id);
}

async function releaseRoomLease(roomId) {
    const id = String(roomId || "").toUpperCase();
    if (!id || !ROOM_PERSISTENCE_ENABLED) return false;
    const epoch = Number(roomLeaseEpochs.get(id) || 0);
    clearRoomLeaseRenewal(id);
    roomLeaseEpochs.delete(id);
    if (!epoch) return false;
    const doc = await getDynamoDocClient();
    try {
        await doc.send(new DeleteCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Key: roomLeaseKey(id),
            ConditionExpression: "#owner = :owner AND #epoch = :epoch",
            ExpressionAttributeNames: { "#owner": "ownerInstanceId", "#epoch": "leaseEpoch" },
            ExpressionAttributeValues: { ":owner": INSTANCE_ID, ":epoch": epoch },
        }));
        return true;
    } catch (e) {
        if (e?.name === "ConditionalCheckFailedException" || e?.name === "ResourceNotFoundException") return false;
        throw e;
    }
}

async function releaseAllLocalRoomLeases(reason = "shutdown") {
    const ids = [...roomLeaseEpochs.keys()];
    for (const id of ids) {
        try { await releaseRoomLease(id); }
        catch (e) { console.error(`[room-lease] release ${id} failed (${reason}):`, e?.name || "Error", e?.message || e); }
    }
}

async function updatePersistedRoomIndex(roomId, { add = false, remove = false, clear = false } = {}) {
    if (!ROOM_PERSISTENCE_ENABLED) return;
    const doc = await getDynamoDocClient();
    const key = { playerName: SYSTEM_PLAYER_KEY, statKey: ROOM_INDEX_STAT_KEY };
    if (clear) {
        await doc.send(new PutCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            // DynamoDB ไม่ยอมรับ Set ว่าง จึงลบ field activeRoomIds ออกไปเลยเมื่อไม่มีห้อง active
            Item: { ...key, at: new Date().toISOString() },
        }));
        return;
    }
    const now = new Date().toISOString();
    const roomSet = new Set([String(roomId).toUpperCase()]);
    if (add) {
        await doc.send(new UpdateCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Key: key,
            // DynamoDB: "at" เป็น reserved keyword และ ADD/DELETE ควรวางหลัง SET ตามรูปแบบ update expression มาตรฐาน
            UpdateExpression: "SET #at = :at ADD activeRoomIds :ids",
            ExpressionAttributeNames: { "#at": "at" },
            ExpressionAttributeValues: { ":ids": roomSet, ":at": now },
        }));
    } else if (remove) {
        await doc.send(new UpdateCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Key: key,
            UpdateExpression: "SET #at = :at DELETE activeRoomIds :ids",
            ExpressionAttributeNames: { "#at": "at" },
            ExpressionAttributeValues: { ":ids": roomSet, ":at": now },
        }));
    }
}

// Serialize writes per room so a snapshot already in flight cannot resurrect a closed room.
const roomSnapshotWrites = new Map();
function persistRoomSnapshot(room, options = {}) {
    if (!room || room.isClosing) return Promise.resolve(false);
    const id = String(room.id || "").toUpperCase();
    const previous = roomSnapshotWrites.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => writeRoomSnapshot(room, options));
    roomSnapshotWrites.set(id, task);
    task.finally(() => {
        if (roomSnapshotWrites.get(id) === task) roomSnapshotWrites.delete(id);
    }).catch(() => {});
    return task;
}
async function writeRoomSnapshot(room, { register = false } = {}) {
    if (!beginGameDataWrite()) return false;
    try {
    if (!ROOM_PERSISTENCE_ENABLED || !room || !room.id || room.isClosing) return false;
    ensureRoomMemberships(room);
    initializeRoomActivity(room);
    const { serialized, truncated } = makeRoomSnapshotPayload(room);
    const now = Date.now();
    const doc = await getDynamoDocClient();
    const roomId = String(room.id).toUpperCase();
    const localStateVersion = Math.max(1, Number(room.stateVersion) || 1);
    const leaseEpoch = Number(roomLeaseEpochs.get(roomId) || room.roomLeaseEpoch || 0);
    if (room.isTesterRoom !== true && leaseEpoch <= 0) {
        room.__persistenceConflict = { code: "ROOM_LEASE_UNAVAILABLE", localVersion: localStateVersion, at: Date.now() };
        return false;
    }
    const snapshotHash = crypto.createHash("sha1").update(serialized).digest("hex");
    try {
        await doc.send(new PutCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Item: {
                playerName: roomStorageKey(room.id),
                statKey: ROOM_SNAPSHOT_STAT_KEY,
                roomId,
                isTesterRoom: room.isTesterRoom === true,
                schema: ROOM_SNAPSHOT_SCHEMA,
                snapshot: serialized,
                stateVersion: localStateVersion,
                snapshotHash,
                writerInstanceId: INSTANCE_ID,
                leaseEpoch,
                truncatedChat: truncated,
                persistedAt: now,
                expiresAt: room.roomIdleExpiresAt,
            },
            // Deployment handoff fencing: normal rooms may only be written by the instance
            // that currently owns the room lease epoch. Tester rooms intentionally keep the
            // legacy version/hash guard because they are isolated from normal room persistence.
            ConditionExpression: room.isTesterRoom === true
                ? "attribute_not_exists(#stateVersion) OR #stateVersion < :stateVersion OR (#stateVersion = :stateVersion AND #snapshotHash = :snapshotHash)"
                : "attribute_not_exists(#stateVersion) OR (attribute_not_exists(#leaseEpoch) AND attribute_not_exists(#writer)) OR #leaseEpoch < :leaseEpoch OR (#writer = :writer AND #leaseEpoch = :leaseEpoch AND (#stateVersion < :stateVersion OR (#stateVersion = :stateVersion AND #snapshotHash = :snapshotHash)))",
            ExpressionAttributeNames: {
                "#stateVersion": "stateVersion",
                "#snapshotHash": "snapshotHash",
                "#writer": "writerInstanceId",
                "#leaseEpoch": "leaseEpoch",
            },
            ExpressionAttributeValues: {
                ":stateVersion": localStateVersion,
                ":snapshotHash": snapshotHash,
                ":writer": INSTANCE_ID,
                ":leaseEpoch": leaseEpoch,
            },
        }));
    } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") {
            // A newer copy already won. Do not turn this into an incident/error storm; mark the
            // local signature as stale so the next recovery/sync path can reconcile it.
            const latest = await doc.send(new GetCommand({
                TableName: ROOM_PERSISTENCE_TABLE,
                Key: { playerName: roomStorageKey(room.id), statKey: ROOM_SNAPSHOT_STAT_KEY },
                ConsistentRead: true,
            })).catch(() => null);
            const remoteVersion = Number(latest?.Item?.stateVersion || 0);
            const remoteHash = String(latest?.Item?.snapshotHash || "");
            if (remoteVersion > localStateVersion) {
                room.__persistenceConflict = { remoteVersion, localVersion: localStateVersion, at: Date.now() };
                return false;
            }
            if (remoteVersion === localStateVersion && remoteHash === snapshotHash) {
                roomPersistenceKnownIds.add(roomId);
                roomPersistenceSignatures.set(roomId, snapshotHash);
                return true;
            }
        }
        throw e;
    }
    if (register) await updatePersistedRoomIndex(room.id, { add: true });
    roomPersistenceKnownIds.add(String(room.id).toUpperCase());
    roomPersistenceSignatures.set(String(room.id).toUpperCase(), crypto.createHash("sha1").update(serialized).digest("hex"));
    return true;
    } finally {
        endGameDataWrite();
    }
}

async function deletePersistedRoom(roomId) {
    if (!ROOM_PERSISTENCE_ENABLED || !roomId) return false;
    if (!beginGameDataWrite()) return false;
    try {
        const id = String(roomId).toUpperCase();
        const doc = await getDynamoDocClient();
        const room = rooms[id];
        const isTester = room?.isTesterRoom === true;

        if (!isTester && !roomLeaseOwnedLocally(id)) {
            const lease = await acquireRoomLease(id, { allowDuringDeployment: true });
            if (!lease.ok) {
                const err = new Error(lease.code || "ROOM_LEASE_UNAVAILABLE");
                err.code = lease.code || "ROOM_LEASE_UNAVAILABLE";
                err.retryAfterMs = lease.retryAfterMs || ROOM_FAILOVER_RETRY_MS;
                throw err;
            }
            if (room) room.roomLeaseEpoch = lease.leaseEpoch;
            scheduleRoomLeaseRenewal(id);
        }

        const leaseEpoch = Number(roomLeaseEpochs.get(id) || room?.roomLeaseEpoch || 0);
        let deletedSnapshot = false;
        try {
            const deleteParams = {
                TableName: ROOM_PERSISTENCE_TABLE,
                Key: { playerName: roomStorageKey(id), statKey: ROOM_SNAPSHOT_STAT_KEY },
            };
            if (!isTester) {
                if (leaseEpoch <= 0) {
                    throw Object.assign(new Error("ROOM_LEASE_UNAVAILABLE"), { code: "ROOM_LEASE_UNAVAILABLE", retryAfterMs: ROOM_FAILOVER_RETRY_MS });
                }
                deleteParams.ConditionExpression = "(attribute_not_exists(#leaseEpoch) AND attribute_not_exists(#writer)) OR (#writer = :writer AND #leaseEpoch = :leaseEpoch)";
                deleteParams.ExpressionAttributeNames = { "#writer": "writerInstanceId", "#leaseEpoch": "leaseEpoch" };
                deleteParams.ExpressionAttributeValues = { ":writer": INSTANCE_ID, ":leaseEpoch": leaseEpoch };
            }
            await doc.send(new DeleteCommand(deleteParams));
            deletedSnapshot = true;
        } catch (e) {
            if (e?.name === "ConditionalCheckFailedException") {
                // Another instance owns a newer room lease. Never delete its snapshot or index.
                throw Object.assign(new Error("ROOM_LEASE_UNAVAILABLE"), { code: "ROOM_LEASE_UNAVAILABLE", retryAfterMs: ROOM_FAILOVER_RETRY_MS });
            }
            throw e;
        }

        if (deletedSnapshot) {
            try { await updatePersistedRoomIndex(id, { remove: true }); } catch (e) { console.error(`[room-persist] ลบห้อง ${id} จาก ROOM_INDEX ไม่สำเร็จ:`, e.name, e.message); }
            roomPersistenceKnownIds.delete(id);
            roomPersistenceSignatures.delete(id);
        }
        await releaseRoomLease(id).catch((e) => console.error(`[room-lease] ลบ lease ห้อง ${id} ไม่สำเร็จ:`, e?.message || e));
        const timer = roomPersistenceTimers.get(id);
        if (timer) clearTimeout(timer);
        roomPersistenceTimers.delete(id);
        return true;
    } finally {
        endGameDataWrite();
    }
}

function schedulePersistRoom(roomId, immediate = false) {
    if (resetInProgress || appDraining) return;
    if (!ROOM_PERSISTENCE_ENABLED || !roomId) return;
    const id = String(roomId).toUpperCase();
    const oldTimer = roomPersistenceTimers.get(id);
    if (oldTimer) clearTimeout(oldTimer);
    const delay = immediate ? 0 : ROOM_PERSISTENCE_DEBOUNCE_MS;
    const timer = setTimeout(async () => {
        roomPersistenceTimers.delete(id);
        if (resetInProgress) return;
        const room = rooms[id];
        if (!room) return;
        try {
            await persistRoomSnapshot(room, { register: !roomPersistenceKnownIds.has(id) });
        } catch (e) {
            console.error(`[room-persist] บันทึกห้อง ${id} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
        }
    }, delay);
    roomPersistenceTimers.set(id, timer);
}

async function scanAndPersistChangedRooms() {
    if (resetInProgress || appDraining) return;
    if (!ROOM_PERSISTENCE_ENABLED) return;
    for (const id of Object.keys(rooms)) {
        const room = rooms[id];
        if (!room || room.isClosing) continue;
        const sig = roomSignature(room);
        if (sig !== roomPersistenceSignatures.get(id)) schedulePersistRoom(id);
        else roomPersistenceKnownIds.add(id);
    }
    // If a room vanished outside an explicit close helper, remove its durable snapshot too.
    for (const id of [...roomPersistenceKnownIds]) {
        if (!rooms[id]) {
            try { await deletePersistedRoom(id); } catch (e) { console.error(`[room-persist] ลบ snapshot ห้อง ${id} ไม่สำเร็จ:`, e.name, e.message); }
        }
    }
}

async function clearAllPersistedRoomSnapshots() {
    if (!ROOM_PERSISTENCE_ENABLED) return 0;
    const doc = await getDynamoDocClient();
    const keys = [];
    let lastKey;

    // ล้างจากข้อมูลจริงในตาราง ไม่พึ่ง ROOM_INDEX อย่างเดียว
    // เพราะ index อาจเสีย/ไม่ตรงกับ snapshot จากเหตุขัดข้องก่อนหน้าได้
    do {
        const page = await doc.send(new ScanCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            ProjectionExpression: "playerName, statKey",
            ExclusiveStartKey: lastKey,
        }));
        for (const it of (page.Items || [])) {
            const pk = String(it.playerName || "");
            const sk = String(it.statKey || "");
            if ((sk === ROOM_SNAPSHOT_STAT_KEY || sk === ROOM_LEASE_STAT_KEY) && pk.startsWith(ROOM_KEY_PREFIX)) {
                keys.push({ playerName: pk, statKey: sk });
            }
        }
        lastKey = page.LastEvaluatedKey;
    } while (lastKey);

    await deleteTableItemsWithFallback(doc, ROOM_PERSISTENCE_TABLE, keys);

    // ROOM_INDEX เป็น metadata ของระบบ ไม่ใช่ game snapshot — ล้างให้เป็น index ว่าง
    await updatePersistedRoomIndex("", { clear: true });
    roomPersistenceKnownIds.clear();
    roomPersistenceSignatures.clear();
    for (const timer of roomPersistenceTimers.values()) clearTimeout(timer);
    roomPersistenceTimers.clear();
    return keys.length;
}

const roomRecoveryInflight = new Map();

// กู้คืนห้องเดียวแบบ on-demand สำหรับกรณีที่ request เข้ามายัง instance ที่ RAM ไม่มีห้อง
// แต่ snapshot ของห้องยังอยู่ใน DynamoDB (เช่น Elastic Beanstalk มีหลาย instance, instance เพิ่งขึ้น,
// หรือหน้า host ค้างอยู่ก่อน deploy แล้วกลับมา login ใหม่) — ป้องกันอาการ "host เห็นห้อง แต่ host_login
// บอก ROOM_NOT_FOUND" ทั้งที่ผู้เล่นที่ต่ออีก instance ยังเข้าได้จริง
async function recoverPersistedRoomById(roomId, { reason = "on-demand", requireLease = deploymentRoomRecoveryCompleted } = {}) {
    if (!ROOM_PERSISTENCE_ENABLED) return null;
    const id = String(roomId || "").trim().toUpperCase();
    if (!id) return null;
    if (rooms[id]) return rooms[id];
    if (roomRecoveryInflight.has(id)) return roomRecoveryInflight.get(id);

    const task = (async () => {
        const doc = await getDynamoDocClient();

        // ต้องเช็ค activeRoomIds ก่อนกู้ เพื่อไม่ชุบห้องที่ถูก close แล้วแต่ snapshot เก่ายังลบไม่หมด
        const indexOut = await doc.send(new GetCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Key: { playerName: SYSTEM_PLAYER_KEY, statKey: ROOM_INDEX_STAT_KEY },
        }));
        const activeIds = roomIdsFromDynamoSet(indexOut.Item && indexOut.Item.activeRoomIds)
            .map((x) => String(x).toUpperCase());
        if (!activeIds.includes(id)) return null;

        // During Immutable deployment the old instance remains authoritative until its drain
        // completes. Never resurrect the room on a new instance while the environment is still
        // updating; callers receive a transient failover code and retry against the next ready
        // instance instead of being told the room was deleted.
        if (deploymentHandoffInProgress()) return null;

        const out = await doc.send(new GetCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Key: { playerName: roomStorageKey(id), statKey: ROOM_SNAPSHOT_STAT_KEY },
            ConsistentRead: true,
        }));
        const item = out.Item;
        if (!item || !item.snapshot) return null;
        if (Number(item.expiresAt) > 0 && Number(item.expiresAt) <= Date.now()) return null;
        if (Number(item.schema || 0) !== ROOM_SNAPSHOT_SCHEMA) return null;

        // ถ้า server ถูกสั่งปิด/เริ่ม session ใหม่ ห้องปกติจาก snapshot เก่าต้องไม่ฟื้นกลับมา
        if (item.isTesterRoom !== true && roomResetAt > 0 && Number(item.persistedAt) > 0 && Number(item.persistedAt) <= roomResetAt) return null;

        let room;
        try {
            room = JSON.parse(String(item.snapshot));
        } catch (e) {
            console.error(`[room-recovery] on-demand ${id} snapshot JSON เสีย:`, e.message);
            return null;
        }
        if (!room || String(room.id || "").toUpperCase() !== id || !Array.isArray(room.players)) return null;
        initializeRoomActivity(room);
        if (roomIdleExpired(room, io.sockets.sockets)) return null;
        ensureRoomRuntimeState(room);
        ensureRoomMemberships(room);
        // `isTesterRoom` is duplicated at the top level of the durable record so recovery on a
        // different instance can restore the security-critical room classification even if an
        // older/partial snapshot omitted the field. The metadata is written only by server code.
        if (item.isTesterRoom === true) room.isTesterRoom = true;
        if (serverClosed && room.isTesterRoom !== true) return null;
        if (room.isTesterRoom !== true && !roomLeaseOwnedLocally(id)) {
            try {
                const lease = await acquireRoomLease(id);
                if (lease.ok) {
                    room.roomLeaseEpoch = lease.leaseEpoch;
                    scheduleRoomLeaseRenewal(id);
                } else if (requireLease) {
                    throw Object.assign(new Error(lease.code || "ROOM_LEASE_UNAVAILABLE"), {
                        code: lease.code || "ROOM_LEASE_UNAVAILABLE",
                        retryAfterMs: lease.retryAfterMs || ROOM_FAILOVER_RETRY_MS,
                    });
                }
            } catch (e) {
                if (requireLease) throw e;
                console.error(`[room-lease] on-demand ${id} coordination failed:`, e?.name || "Error", e?.message || e);
            }
        }

        room.host = "";
        room.hostIds = [];
        room.players.forEach((p) => {
            if (p) p.disconnected = true;
        });
        room.__recoveredAt = Date.now();
        rooms[id] = room;
        roomPersistenceKnownIds.add(id);
        roomPersistenceSignatures.set(id, roomSignature(room));
        console.log(`[room-recovery] on-demand กู้คืนห้อง ${id} สำเร็จ (${reason})`);
        return room;
    })();

    roomRecoveryInflight.set(id, task);
    try {
        return await task;
    } finally {
        if (roomRecoveryInflight.get(id) === task) roomRecoveryInflight.delete(id);
    }
}

async function recoverPersistedRooms({ requireLease = false } = {}) {
    if (!ROOM_PERSISTENCE_ENABLED) return { recovered: 0, skipped: 0, deferred: false };
    const doc = await getDynamoDocClient();
    const indexOut = await doc.send(new GetCommand({
        TableName: ROOM_PERSISTENCE_TABLE,
        Key: { playerName: SYSTEM_PLAYER_KEY, statKey: ROOM_INDEX_STAT_KEY },
    }));
    const ids = roomIdsFromDynamoSet(indexOut.Item && indexOut.Item.activeRoomIds)
        .map((id) => id.toUpperCase())
        .filter(Boolean);
    if (!ids.length) return { recovered: 0, skipped: 0, deferred: false };
    if (deploymentHandoffInProgress()) {
        roomRecoveryDeferred = true;
        return { recovered: 0, skipped: ids.length, deferred: true };
    }

    let recovered = 0;
    let skipped = 0;
    let leaseDeferred = 0;
    const requests = ids.map((id) => ({
        playerName: roomStorageKey(id),
        statKey: ROOM_SNAPSHOT_STAT_KEY,
    }));
    for (let i = 0; i < requests.length; i += 100) {
        const batch = requests.slice(i, i + 100);
        // ใช้ GetItem แทน BatchGetItem เพื่อให้ room recovery ทำงานได้กับ IAM role
        // ที่มีสิทธิ์อ่านตารางอยู่แล้ว แต่ไม่ได้เปิด BatchGetItem โดยไม่จำเป็น
        // (GetItem เป็นสิทธิ์ขั้นต่ำที่ระบบนี้ใช้อยู่ใน production แล้ว)
        const items = [];
        const GET_CONCURRENCY = 20;
        for (let j = 0; j < batch.length; j += GET_CONCURRENCY) {
            const keys = batch.slice(j, j + GET_CONCURRENCY);
            const results = await Promise.all(keys.map(async (key) => {
                try {
                    const out = await doc.send(new GetCommand({
                        TableName: ROOM_PERSISTENCE_TABLE,
                        Key: key,
                        ConsistentRead: false,
                    }));
                    return out.Item || null;
                } catch (e) {
                    // รักษาพฤติกรรมเดิม: ถ้า DynamoDB อ่านไม่ได้จริง ให้ recovery ล้มเหลว
                    // เพื่อให้ readiness/diagnostics แสดงปัญหาอย่างตรงไปตรงมา
                    throw e;
                }
            }));
            items.push(...results.filter(Boolean));
        }
        for (const item of items) {
            try {
                const id = String(item.roomId || "").toUpperCase();
                if (!id || !item.snapshot) { skipped++; continue; }
                if (Number(item.expiresAt) > 0 && Number(item.expiresAt) <= Date.now()) { skipped++; continue; }
                const room = JSON.parse(String(item.snapshot));
                if (!room || room.id !== id || !Array.isArray(room.players)) { skipped++; continue; }
                initializeRoomActivity(room);
                if (roomIdleExpired(room, io.sockets.sockets)) { skipped++; continue; }
                ensureRoomRuntimeState(room);
                if (item.isTesterRoom === true) room.isTesterRoom = true;
                // Normal rooms must never resurrect while the server is intentionally closed.
                if (serverClosed && room.isTesterRoom !== true) { skipped++; continue; }
                if (room.isTesterRoom !== true && !roomLeaseOwnedLocally(id)) {
                    try {
                        const lease = await acquireRoomLease(id);
                        if (lease.ok) {
                            room.roomLeaseEpoch = lease.leaseEpoch;
                            scheduleRoomLeaseRenewal(id);
                        } else if (requireLease) {
                            leaseDeferred++;
                            skipped++;
                            continue;
                        }
                    } catch (e) {
                        if (requireLease) {
                            leaseDeferred++;
                            skipped++;
                            continue;
                        }
                        console.error(`[room-lease] recovery ${id} coordination failed:`, e?.name || "Error", e?.message || e);
                    }
                }
                // หลัง admin ปิด/force-reload แล้วเริ่ม session ใหม่ ห้องปกติจาก session ก่อนหน้า
                // ถือว่าจบไปแล้ว แม้ snapshot เดิมยังค้างเพราะ DB ลบไม่สำเร็จตอนคำสั่งปิด
                if (room.isTesterRoom !== true && roomResetAt > 0 && Number(item.persistedAt) > 0 && Number(item.persistedAt) <= roomResetAt) {
                    skipped++; continue;
                }
                room.host = "";
                room.hostIds = [];
                room.players.forEach((p) => {
                    if (p && p.isHost) p.disconnected = true;
                    else if (p) p.disconnected = true;
                });
                room.__recoveredAt = Date.now();
                rooms[id] = room;
                roomPersistenceKnownIds.add(id);
                roomPersistenceSignatures.set(id, roomSignature(room));
                recovered++;
            } catch (e) {
                skipped++;
                console.error("[room-recovery] snapshot ห้องเสีย/อ่านไม่ได้:", e.message);
            }
        }
    }
    // Recreate server-side timers from durable deadlines. The deadline is authoritative; timer
    // handles themselves are deliberately never persisted.
    for (const id of Object.keys(rooms)) {
        const room = rooms[id];
        scheduleRecoveredRoomTimers(room);
    }
    roomRecoveryDeferred = leaseDeferred > 0;
    return { recovered, skipped, deferred: leaseDeferred > 0 };
}

async function maybeCompleteDeferredRoomRecovery() {
    if (!roomRecoveryDeferred || appDraining || !ROOM_PERSISTENCE_ENABLED) return false;
    try {
        await getAppEnvironmentState({ force: false });
        if (deploymentHandoffInProgress()) return false;
        roomRecoveryDeferred = false;
        const out = await recoverPersistedRooms({ requireLease: true });
        roomRecoveryDeferred = !!out.deferred;
        if (roomRecoveryDeferred) {
            console.log(`[room-recovery] handoff still waiting for room leases: recovered=${out.recovered}, skipped=${out.skipped}`);
            return false;
        }
        deploymentRoomRecoveryCompleted = true;
        console.log(`[room-recovery] handoff complete: recovered=${out.recovered}, skipped=${out.skipped}`);
        return true;
    } catch (e) {
        console.error("[room-recovery] deferred handoff recovery failed:", e?.name || "Error", e?.message || e);
        return false;
    }
}

function startRoomPersistence() {
    if (roomPersistenceStarted || !ROOM_PERSISTENCE_ENABLED) {
        if (!ROOM_PERSISTENCE_ENABLED) roomRecoveryResolve();
        return;
    }
    roomPersistenceStarted = true;
    (async () => {
        let released = false;
        const release = () => { if (!released) { released = true; roomRecoveryResolve(); } };
        const timeout = setTimeout(() => {
            roomRecoveryHealthy = false;
            roomRecoveryError = "recovery_timeout";
            console.error(`[room-recovery] เกิน ${ROOM_RECOVERY_TIMEOUT_MS}ms จึงปล่อยให้ server รับ connection ต่อ (ห้องที่กู้ไม่ได้จะไม่ถูกสร้างใน RAM)`);
            release();
        }, ROOM_RECOVERY_TIMEOUT_MS);
        try {
            await serverStateReady;
            try { await getAppEnvironmentState({ force: false }); } catch (_) {}
            const out = await recoverPersistedRooms();
            roomRecoveryHealthy = true;
            roomRecoveryDeferred = !!out.deferred;
            deploymentRoomRecoveryCompleted = !roomRecoveryDeferred && !deploymentHandoffInProgress();
            console.log(`[room-recovery] กู้คืนห้องจาก DynamoDB สำเร็จ ${out.recovered} ห้อง, ข้าม ${out.skipped} รายการ${out.deferred ? " (deferred during deployment)" : ""}`);
            release();
        } catch (e) {
            roomRecoveryHealthy = false;
            roomRecoveryError = `${e.name || "Error"}: ${e.message || e}`;
            console.error("[room-recovery] โหลดห้องจาก DynamoDB ไม่สำเร็จ:", roomRecoveryError);
            // Fail-open: เกมใหม่ยังใช้งานได้ตามปกติ แม้ persistence จะล่มชั่วคราว
            release();
        } finally {
            clearTimeout(timeout);
        }
        roomPersistenceScanTimer = setInterval(() => {
            scanAndPersistChangedRooms().catch((e) => console.error("[room-persist] รอบสแกน snapshot ล้มเหลว:", e.name, e.message));
            if (roomRecoveryDeferred) maybeCompleteDeferredRoomRecovery().catch((e) => console.error("[room-recovery] deferred check failed:", e?.message || e));
        }, ROOM_PERSISTENCE_SCAN_MS);
        roomPersistenceScanTimer.unref?.();
        if (roomRecoveryDeferred) {
            roomRecoveryDeferredTimer = setInterval(() => {
                maybeCompleteDeferredRoomRecovery().catch((e) => console.error("[room-recovery] handoff watcher failed:", e?.message || e));
            }, Math.max(750, ROOM_PERSISTENCE_SCAN_MS));
            roomRecoveryDeferredTimer.unref?.();
        }
    })();
}

// เริ่ม recovery หลังประกาศ helper ทั้งหมด แต่ก่อน server.listen ด้านล่าง

// ============================================================
// TESTER ROOM (ฝั่ง server ตัดสินเอง — ห้ามเชื่อ isTester จาก client)
// ============================================================
// ห้องผู้ทดสอบ = ห้องที่สร้างโดย socket ที่ "ถือบัตรผ่านผู้ทดสอบที่ server ออกให้และยังไม่หมดอายุ" (io.use ฝัง socket.data.testerToken
// จาก cookie ww_tp ตอน handshake) ค่า isTester ที่ client ส่งมากับ create_room/join_room เป็นแค่ "คำขอ" — ถ้า server ไม่เห็นบัตรที่ใช้ได้
// คำขอนั้นไม่มีผลอะไร (ไม่ได้ป้ายผู้ทดสอบ ไม่ได้ห้องที่รอดการปิดเซิร์ฟเวอร์) ต่อให้ปลอม {isTester:true} หรือ handshake.auth.isTester ก็ตาม
function resolveTesterFlag(socket, requested) {
    // ต้องมีทั้ง 2 อย่าง: client ขอ ?tester=1/isTester:true และ server เห็นบัตรผ่านที่ออกให้จริง
    // กันกรณี cookie ww_tp ผูกกับ browser ทั้งตัว แล้วแท็บปกติของ browser เดียวกันเผลอได้ socket.data.testerToken
    // การมีบัตรอย่างเดียวจึงไม่ควรเปลี่ยนห้องปกติให้กลายเป็นห้องผู้ทดสอบ
    return requested === true && !!(socket && socket.data && isTesterPassValid(socket.data.testerToken));
}
function isTesterRoom(room) {
    return !!(room && room.isTesterRoom === true);
}
// socket นี้เป็นสมาชิกห้องแบบไหน: "tester" | "normal" | null (ยังไม่อยู่ห้องไหน) — ดูจากสถานะห้องบน server เท่านั้น
function socketRoomKind(socket) {
    let kind = null;
    for (const id in rooms) {
        const room = rooms[id];
        const isMember = (Array.isArray(room.hostIds) && room.hostIds.includes(socket.id))
            || room.players.some((p) => p && p.id === socket.id);
        if (!isMember) continue;
        if (isTesterRoom(room)) return "tester";
        kind = "normal";
    }
    return kind;
}
// socket ที่ "ไม่ถูกกระทบ" จากการปิดเซิร์ฟเวอร์/บังคับรีโหลด:
//   - อยู่ในห้องผู้ทดสอบ (แม้บัตรหมดอายุระหว่างเล่น ก็อยู่ต่อ), หรือ
//   - ถือบัตรที่ใช้ได้และ "ไม่ได้อยู่ในห้องปกติ" (เช่น กำลังจะสร้างห้องทดสอบ) — ถ้าบัตรอยู่ในห้องปกติ ห้องนั้นโดนปิดตามปกติ ผู้เล่นก็โดนเหมือนคนอื่น
function isProtectedSocket(socket) {
    const kind = socketRoomKind(socket);
    if (kind === "tester") return true;
    if (kind === "normal") return false;
    return !!(socket && socket.data && isTesterPassValid(socket.data.testerToken));
}
// เวอร์ชัน HTTP (/api/config): ไม่มี socket ให้ดู → ใช้บัตร cookie หรือ "token ผู้เล่นที่อยู่ในห้องผู้ทดสอบจริง" (header X-WW-Room/X-WW-Token
// ที่ shared.server-control.js แนบมา — token เป็นความลับที่ server ออกให้ตอนเข้าห้อง ปลอมเดาไม่ได้)
function isProtectedRequest(req) {
    // ww_tp เป็น cookie ระดับ origin ไม่ใช่ระดับแท็บ — ห้ามใช้ cookie เดี่ยว ๆ ทำให้ index/host/player ปกติ
    // ใน browser เดียวกับ Admin/Tester กลายเป็น protected. หน้า Tester ต้องประกาศตัวตนเพิ่มใน header
    // และ server ยังตรวจ signed cookie ซ้ำอีกชั้น; สมาชิกห้อง Tester ใช้ room+token ที่ server ตรวจเองด้านล่าง
    const testerPageHeader = String(req.headers["x-ww-tester-page"] || "") === "1";
    if (testerPageHeader && isTesterPassValid(testerTokenFromCookie(req.headers))) return true;
    const rid = String(req.headers["x-ww-room"] || "").toUpperCase();
    const tok = String(req.headers["x-ww-token"] || "");
    if (!rid || !tok) return false;
    const room = rooms[rid];
    return !!(room && isTesterRoom(room) && room.players.some((p) => p.token === tok));
}
// เวอร์ชัน socket handshake (io.use ตอนต่อ/reconnect ครั้งใหม่): ตอนนี้ socket ยังไม่ทันเข้าห้อง (socketRoomKind
// ยังคืน null แน่ๆ) จึงเช็คจาก "หลักฐาน" ที่ client แนบมาใน io({ auth: { roomId, token } }) แทน — อ่านจาก
// ww_joinedRoom+ww_token (ผู้เล่น) หรือ ww_host_room+ww_host_token (โฮสต์) ที่เครื่องนั้นจำไว้ (ดู
// wwServerControl.roomIdentityAuth ใน shared.server-control.js) เทียบกับ token จริงของสมาชิกห้องบน server
// แบบเดียวกับ isProtectedRequest ด้านบน — แก้บั๊ก: เดิมสมาชิกห้องผู้ทดสอบที่ไม่ได้ถือบัตร tp cookie (ทุกคนยกเว้น
// เครื่องแอดมินที่เปิดลิงก์ ?tp= เอง) ถ้า socket หลุด (พับจอมือถือ/เน็ตสะดุด/รีเฟรชหน้า) ระหว่างเซิร์ฟเวอร์ปิดอยู่
// จะต่อ socket กลับไม่ได้เลยแม้ห้องนั้นควรรอดพ้นการปิดก็ตาม (ถูก io.use ปฏิเสธด้วย server_closed ตั้งแต่ handshake
// ก่อนจะทันได้ join_room/host_login ด้วยซ้ำ)
function isProtectedHandshake(socket) {
    const auth = socket && socket.handshake && socket.handshake.auth;
    if (!auth) return false;
    const rid = String(auth.roomId || "").toUpperCase();
    const tok = String(auth.token || "");
    if (!rid || !tok) return false;
    const room = rooms[rid];
    return !!(room && isTesterRoom(room) && room.players.some((p) => p.token === tok));
}

// ============================================================
// PUBLIC ROOM VIEW (ลดปริมาณข้อมูลที่ส่งผ่านเน็ต)
// ============================================================
// room_update จะถูกส่งออกทุกครั้งที่มีการเปลี่ยนสถานะห้อง (โหวต, สลับโหมด, ฯลฯ)
// ให้ผู้เล่น "ทุกคน" ในห้องอยู่แล้ว แต่ตัว room object เก็บ wolfChatHistory /
// globalChatHistory ซึ่งเป็น log ข้อความที่ "โตขึ้นเรื่อย ๆ" ตลอดเกม
// ถ้าปล่อยให้ field พวกนี้ติดไปกับ room_update ทุกครั้ง จะกลายเป็นว่ายิ่งเกมดำเนินไปนาน/
// แชทเยอะ ทุก action เล็ก ๆ (เช่นแค่โหวต 1 ครั้ง) ก็จะพ่วงข้อความแชททั้งหมดที่ผ่านมากลับไปส่งซ้ำ
// ให้ทุกคนในห้องทุกครั้ง ทั้งที่จริง ๆ ไม่มีใครใช้ field นี้จาก room_update เลย —
// ประวัติแชทถูกส่งแยกอยู่แล้วผ่าน event "wolf_chat_history" / "global_chat_history"
// (ตอน join/reconnect) และข้อความใหม่ส่งทีละข้อความผ่าน "chat_message"
// จึงตัด field เหล่านี้ออกจาก payload ของ room_update ทุกจุดเพื่อประหยัดเน็ตของผู้เล่น

// ============================================================
// RUNTIME ROOM STATE / SNAPSHOT CONTRACT
// ============================================================
const ROOM_TIMELINE_MAX = Math.max(40, Math.min(300, Number(process.env.ROOM_TIMELINE_MAX) || 120));

function ensureRoomMemberships(room) {
    if (!room || !Array.isArray(room.players)) return room;
    room.hostMembershipId = room.hostMembershipId || "";
    // Guest mode has no account/ownership records. Remove legacy fields left by older
    // persisted snapshots so they cannot leak through roomData or be used by stale logic.
    delete room.ownerAccountId;
    room.players.forEach((p) => {
        if (!p) return;
        if (!p.membershipId) p.membershipId = generateMembershipId();
        p.roomId = String(room.id || room.roomId || "").trim().toUpperCase();
        delete p.accountId;
        delete p.accountToken;
        delete p.activeDeviceId;
        delete p.activeTabId;
        if (p.isHost && !room.hostMembershipId) room.hostMembershipId = p.membershipId;
    });
    return room;
}

function ensureRoomRuntimeState(room) {
    if (!room || typeof room !== "object") return room;
    const version = Number(room.stateVersion);
    room.stateVersion = Number.isSafeInteger(version) && version > 0 ? version : 1;
    room.stateChangedAt = Number(room.stateChangedAt) > 0 ? Number(room.stateChangedAt) : Date.now();
    room.timeline = Array.isArray(room.timeline) ? room.timeline.filter(Boolean).slice(-ROOM_TIMELINE_MAX) : [];
    const seq = Number(room.timelineSeq);
    room.timelineSeq = Number.isSafeInteger(seq) && seq >= 0
        ? seq
        : room.timeline.reduce((max, e) => Math.max(max, Number(e?.seq) || 0), 0);
    room.voteDeadline = Number(room.voteDeadline) > 0 ? Number(room.voteDeadline) : null;
    room.gameOverDeadlineAt = Number(room.gameOverDeadlineAt) > 0 ? Number(room.gameOverDeadlineAt) : null;
    room.roomLeaseEpoch = Number(room.roomLeaseEpoch) > 0 ? Number(room.roomLeaseEpoch) : 0;
    return room;
}

function roomRuntimePhase(room) {
    if (!room) return "unknown";
    if (room.gameOver) return "game_over";
    if (!room.started) return "waiting";
    if (room.isNight) return "night";
    if (room.voteMode) return "day_vote";
    return "day";
}

function recordRoomTimeline(room, type = "state_changed", detail = {}) {
    if (!room) return null;
    ensureRoomRuntimeState(room);
    const event = {
        seq: ++room.timelineSeq,
        at: Date.now(),
        stateVersion: room.stateVersion,
        type: String(type || "state_changed").slice(0, 80),
        phase: roomRuntimePhase(room),
        playerCount: Array.isArray(room.players) ? room.players.filter((p) => !p?.isHost).length : 0,
        aliveCount: Array.isArray(room.players) ? room.players.filter((p) => !p?.isHost && p?.alive !== false).length : 0,
    };
    if (detail && typeof detail === "object") {
        if (typeof detail.reason === "string" && detail.reason) event.reason = detail.reason.slice(0, 120);
        if (typeof detail.source === "string" && detail.source) event.source = detail.source.slice(0, 80);
        if (typeof detail.label === "string" && detail.label) event.label = detail.label.slice(0, 120);
        if (Number.isFinite(Number(detail.count))) event.count = Number(detail.count);
    }
    room.timeline.push(event);
    if (room.timeline.length > ROOM_TIMELINE_MAX) room.timeline = room.timeline.slice(-ROOM_TIMELINE_MAX);
    return event;
}

function bumpRoomState(room, type = "state_changed", detail = {}) {
    if (!room) return 0;
    ensureRoomRuntimeState(room);
    room.stateVersion += 1;
    room.stateChangedAt = Date.now();
    recordRoomTimeline(room, type, detail);
    return room.stateVersion;
}

function broadcastRoomUpdate(roomId, room, { timelineType = "state_changed", reason = "", source = "server" } = {}) {
    if (!room) return null;
    const stateVersion = bumpRoomState(room, timelineType, { reason, source });
    // One state mutation must result in exactly one room_update emission.
    // Keep the state-version/timeline update in this wrapper, then emit the sanitized view
    // directly; calling broadcastRoomUpdate() recursively here would overflow the stack.
    emitRoomUpdateToRoom(roomId, room);
    return stateVersion;
}

// WW_REDACT_ROOM_VIEW=0 ปิดการซ่อนข้อมูลแยกตามผู้ดู (ใช้ย้อนกลับฉุกเฉินเท่านั้น)
const REDACT_ROOM_VIEW = process.env.WW_REDACT_ROOM_VIEW !== "0";

// มุมมองห้องของ socket หนึ่งตัว: โฮสต์เห็นครบ ผู้เล่นเห็นเฉพาะที่มีสิทธิ์รู้ (บท/token ของคนอื่นถูกซ่อน)
function roomViewForSocket(room, socket, base = null) {
    const view = base || publicRoomView(room);
    if (!REDACT_ROOM_VIEW || !socket || isHostSocket(room, socket.id)) return view;
    return redactRoomViewForPlayer(room, view, getRoomPlayerForSocket(room, socket), { wolfRoles: WOLF_ROLES });
}

// ส่ง room_update ให้ทุก socket ในห้อง โดยแต่ละ socket ได้มุมมองของตัวเอง
function emitRoomUpdateToRoom(roomId, room) {
    const base = publicRoomView(room);
    const members = io.sockets.adapter.rooms.get(String(roomId));
    if (!members) return;
    for (const sid of members) {
        const s = io.sockets.sockets.get(sid);
        if (s) s.emit("room_update", roomViewForSocket(room, s, base));
    }
}

function publicTimeline(room, limit = 24) {
    ensureRoomRuntimeState(room);
    const max = Math.max(1, Math.min(60, Number(limit) || 24));
    return room.timeline.slice(-max).map((e) => ({
        seq: Number(e?.seq) || 0,
        at: Number(e?.at) || 0,
        stateVersion: Number(e?.stateVersion) || 0,
        type: String(e?.type || "state_changed"),
        phase: String(e?.phase || "unknown"),
        playerCount: Number(e?.playerCount) || 0,
        aliveCount: Number(e?.aliveCount) || 0,
        ...(e?.reason ? { reason: String(e.reason).slice(0, 120) } : {}),
        ...(e?.source ? { source: String(e.source).slice(0, 80) } : {}),
        ...(e?.label ? { label: String(e.label).slice(0, 120) } : {}),
        ...(Number.isFinite(Number(e?.count)) ? { count: Number(e.count) } : {}),
    }));
}

function roomActionError(code, extra = {}) {
    return { ok: false, code: String(code || "ACTION_REJECTED"), ...extra };
}

// Generic server-side preflight. Existing role-specific handlers remain authoritative for
// nuanced rules; this layer only covers identity, membership, lifecycle and stale-state checks.
function validateRoomAction(socket, room, opts = {}) {
    if (!room || room.isClosing) return roomActionError("ROOM_NOT_FOUND");
    ensureRoomRuntimeState(room);
    if (opts.host && !isHostSocket(room, socket?.id)) return roomActionError("NOT_HOST");
    if (opts.member !== false && !isHostSocket(room, socket?.id)) {
        const player = getRoomPlayerForSocket(room, socket);
        if (!player) return roomActionError("NOT_IN_ROOM");
        if (opts.alive && player.alive === false) return roomActionError("NOT_ALIVE");
    }
    if (opts.started === true && !room.started) return roomActionError("GAME_NOT_STARTED");
    if (opts.notStarted === true && room.started) return roomActionError("ROOM_STARTED");
    if (Array.isArray(opts.phases) && opts.phases.length > 0) {
        const phase = roomRuntimePhase(room);
        if (!opts.phases.includes(phase)) return roomActionError("INVALID_PHASE", { phase });
    }
    const expectedVersion = Number(opts.stateVersion);
    // heartbeat ของ room idle เพิ่ม stateVersion ทีละ 1 โดยไม่เปลี่ยนสถานะเกม — ยอมรับ action ที่ส่งมาด้วยเวอร์ชันก่อน heartbeat นั้น
    // (ใช้ได้เฉพาะเมื่อยังไม่มี state change อื่นตามมา เพราะ heartbeatStateVersion จะไม่เท่ากับ stateVersion อีกต่อไป)
    const heartbeatOnlyGap = Number(room.heartbeatStateVersion) === room.stateVersion && expectedVersion === room.stateVersion - 1;
    if (Number.isSafeInteger(expectedVersion) && expectedVersion > 0 && expectedVersion !== room.stateVersion && !heartbeatOnlyGap) {
        return roomActionError("STALE_STATE", {
            stateVersion: room.stateVersion,
            stateChangedAt: room.stateChangedAt,
            roomId: String(room.id || "").toUpperCase(),
        });
    }
    return { ok: true, stateVersion: room.stateVersion };
}

function publicRoomView(room) {
    if (!room) return room;
    // hostPassword ต้องไม่หลุดออกไปกับ room_update เด็ดขาด (broadcast ไปถึงผู้เล่นทุกคนในห้อง
    // ไม่ใช่แค่จอโฮสต์) ตัดออกเหมือน chat history อื่นๆ — ส่งแค่ hasHostPassword (true/false)
    // แทน ให้ client เช็คได้ว่าห้องนี้ตั้งรหัสไว้หรือยังโดยไม่เห็นค่าจริง
    const { wolfChatHistory, globalChatHistory, instigatorChatHistory, hostPassword, joinCode, ...publicRoom } = room;
    publicRoom.hasHostPassword = !!hostPassword;
    // joinCode (รหัสห้องฝั่งผู้เล่น) ก็ไม่ควรหลุดออกไปกับ room_update เหมือนกัน (คนในห้องที่เข้ามาแล้ว
    // ไม่จำเป็นต้องเห็นค่าจริง) ส่งแค่ hasJoinCode ให้ client เช็คได้ว่าห้องนี้ตั้งรหัสไว้หรือยัง
    publicRoom.hasJoinCode = !!joinCode;
    ensureRoomRuntimeState(room);
    publicRoom.stateVersion = room.stateVersion;
    publicRoom.stateChangedAt = room.stateChangedAt;
    publicRoom.timeline = publicTimeline(room, 24);
    // ส่งสถานะการเปิดบทผู้ตายให้ client ใช้ควบคุม UI/การแสดงผลเท่านั้น; ถ้าห้องเก่าขาดฟิลด์นี้ให้ถือว่าเปิด
    // เพื่อคงพฤติกรรมเดิม และไม่แก้ข้อมูลห้องเก่าทันทีเพียงเพราะส่ง room_update
    publicRoom.revealDeadRole = room.revealDeadRole !== false;
    publicRoom.hostConnected = (room.hostIds || []).some((id) => io.sockets.sockets.get(id)?.connected === true);
    // เพิ่มสถานะ connected ต่อผู้เล่นแบบคำนวณสด เพื่อให้ Host เห็นว่าบอท/ผู้เล่นกำลังถูกควบคุมอยู่หรือไม่
    publicRoom.players = (room.players || []).map((p) => {
        const { testerSessionId, testerPlayerSlot, ...safePlayer } = p;
        // Host reconnect token is a credential; never broadcast it to room players.
        if (p.isHost) delete safePlayer.token;
        return {
            ...safePlayer,
            connected: p.leftGameRoundId && p.leftGameRoundId === getRoomGameRoundId(room)
                ? false
                : isPlayerCurrentlyConnected(p),
        };
    });
    // room_update ถูกเรียกหลังการเปลี่ยน state สำคัญแทบทุกจุด จึงใช้เป็นสัญญาณให้ snapshot เร็วขึ้น
    // โดยยัง debounce เพื่อไม่ยิง DynamoDB ทุก emit ที่ถี่ติดกัน; รอบสแกน 1.5s เป็น safety net สำหรับ
    // mutation ที่ไม่ได้ emit room_update (เช่นค่าที่เปลี่ยนระหว่าง timer/AI)
    schedulePersistRoom(room.id);
    return publicRoom;
}

// ระยะเวลาที่ยอม "รอ" ผู้เล่นที่หลุดการเชื่อมต่อก่อนเปลี่ยนเป็น offline (จุดดำ)
// (กันกรณีปิดจอประหยัดแบตทั้งคืน — 1 คืนในเกมมักยาวเป็นนาทีๆ ไม่ใช่แค่ไม่กี่วินาที
//  ถ้าตั้งสั้นไปจะขึ้นว่าหลุดทั้งห้องพร้อมกันทุกครั้งที่เข้าคืน ทั้งที่จริงๆ แค่ปิดจอเฉยๆ)
const RECONNECT_GRACE_MS = 10 * 60_000; // 10 นาที (เดิม 1 นาที → 2 นาที → ตอนนี้ 10 นาที)

// ระยะเวลาที่ "รอเงียบๆ" ก่อนจะเริ่มโชว์สถานะ "🟡 กำลังเชื่อมต่อ..." ให้คนอื่นเห็นเลย
// ตั้งให้ยาวคลุมความยาวคืนปกติทั้งคืนได้ — ถ้ากลับมาต่อได้ทันภายในนี้ (เช่นแค่ปิดจอไว้)
// จะไม่มีสถานะหลุดโชว์ให้เห็นเลยแม้แต่แวบเดียว ทั้งห้องจะยังขึ้น "ออนไลน์" อยู่ตามปกติ
const DISCONNECT_INDICATOR_DELAY_MS = 5 * 60_000; // 5 นาที (เดิม 15 วิ)

// เก็บ timer ของผู้เล่นที่กำลังรอถูกเตะ แยกไว้นอก room/player object เสมอ
// (ห้ามฝัง timer handle ไว้ใน room หรือ player เพราะ object พวกนั้นถูกส่งทั้งก้อนผ่าน
//  io.emit("room_update", publicRoomView(room)) ซึ่งต้อง JSON-serialize ได้ ถ้ามี timer handle ติดไปจะพัง)
const pendingRemovals = {};

// socket ที่กำลังจะถูกตัดการเชื่อมต่อเพราะโฮสต์สั่ง "ปล่อยบอท" โดยตรง
// ใช้เป็น transient state แทนการใส่ flag ลงใน player object เพื่อไม่ให้สถานะนี้ถูก persist
// ลง DynamoDB แล้วไปมีผลผิดรอบในอนาคตหลัง server restart/reconnect
const releasedBotSockets = new Set();

// timer ระยะสั้นก่อนจะเริ่มโชว์สถานะ "กำลังเชื่อมต่อ..." (ดู DISCONNECT_INDICATOR_DELAY_MS ด้านบน)
// แยกไว้นอก room/player object เหมือน pendingRemovals
const pendingIndicators = {};

// ============================================================
// BROWSER EXIT GUARD — แยก "ผู้ใช้ปิดแท็บจริง" ออกจากการหลุดเน็ต/สลับแอป
// ============================================================
// beforeunload ฝั่ง browser ใช้สร้างกล่องยืนยันของ browser เอง; ถ้าผู้ใช้เลือก "ออก" แล้ว
// pagehide จะส่งสัญญาณ exit แบบ keepalive/beacon มาที่ server. Server จึงค่อยเริ่มออกจริง
// ไม่ใช้ disconnect เป็นหลัก เพราะ disconnect เดียวกันเกิดจากเน็ตหลุด/สลับเครือข่ายได้
// และไม่ควรทำให้คนที่แค่สลับแอปถูกนับว่าออกเกมทันที.
const BROWSER_EXIT_PLAYER_GRACE_MS = 3_000;
const pendingBrowserExits = new Map();
// Socket disconnect and pagehide can arrive in either order. Keep a very short-lived
// record of real socket disconnects so a late pagehide does not start a second exit
// transaction for the same session. This is especially important on iOS/Safari where
// pagehide may be delivered a few milliseconds after Socket.IO reports transport close.
const recentSocketDisconnects = new Map();
const RECENT_SOCKET_DISCONNECT_TTL_MS = 15_000;

function browserExitKey(kind, roomId, token) {
    return `${String(kind || '')}:${String(roomId || '').toUpperCase()}:${String(token || '')}`;
}

function rememberSocketDisconnect(kind, roomId, token, socketId = "") {
    const key = browserExitKey(kind, roomId, token);
    if (!key || key.endsWith(":")) return;
    recentSocketDisconnects.set(key, {
        kind, roomId: String(roomId || "").toUpperCase(), token: String(token || ""),
        socketId: String(socketId || ""), time: Date.now(),
    });
}

function recentSocketDisconnect(kind, roomId, token, socketId = "") {
    const key = browserExitKey(kind, roomId, token);
    const item = recentSocketDisconnects.get(key);
    if (!item) return null;
    if (Date.now() - Number(item.time || 0) > RECENT_SOCKET_DISCONNECT_TTL_MS) {
        recentSocketDisconnects.delete(key);
        return null;
    }
    if (socketId && item.socketId && String(socketId) !== item.socketId) return null;
    return item;
}

function clearPendingBrowserExit(kind, roomId, token, meta = {}) {
    const key = browserExitKey(kind, roomId, token);
    const pending = pendingBrowserExits.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingBrowserExits.delete(key);
    const cancelEvent = recordDiagnostic({
        source: "server", kind: "browser_exit_cancelled", page: pending.page || kind,
        message: `${pending.page || kind} browser exit was cancelled by a reconnect or intentional flow`,
        traceId: String(meta.traceId || pending.traceId || ''),
        sessionId: String(meta.sessionId || pending.sessionId || ''),
        roomId: String(roomId || '').toUpperCase(),
        context: { kind, roomId: String(roomId || '').toUpperCase(), source: meta.source || 'reconnect', pendingForMs: Math.max(0, Date.now() - Number(pending.startedAt || Date.now())) },
        causalHint: { failureStage: "browser.lifecycle", causeCode: "BROWSER_EXIT_CANCELLED", confidence: "high", upstreamEventIds: pending.armDiagnosticId ? [pending.armDiagnosticId] : [] },
    });
    if (pending.armDiagnosticId && cancelEvent?.id) linkDiagnosticEvents(pending.armDiagnosticId, cancelEvent.id, "causes");
    addDiagnosticBreadcrumb({
        source: 'server', type: 'browser_exit', label: 'browser_exit.cancelled',
        traceId: String(meta.traceId || pending.traceId || ''),
        sessionId: String(meta.sessionId || pending.sessionId || ''),
        page: pending.page || kind,
        detail: { kind, roomId: String(roomId || '').toUpperCase(), source: meta.source || 'reconnect',
            pendingForMs: Math.max(0, Date.now() - Number(pending.startedAt || Date.now())), armDiagnosticId: pending.armDiagnosticId || "", cancelDiagnosticId: cancelEvent?.id || "" }
    });
    return true;
}

function armPendingBrowserExit(kind, roomId, token, apply, meta = {}, graceMs) {
    const id = String(roomId || '').trim().toUpperCase();
    const tok = String(token || '');
    if (!id || !tok || typeof apply !== 'function') return false;
    clearPendingBrowserExit(kind, id, tok, { source: 'replace' });
    const key = browserExitKey(kind, id, tok);
    const startedAt = Date.now();
    const pending = {
        key, kind, roomId: id, token: tok, page: meta.page || kind,
        traceId: String(meta.traceId || ''), sessionId: String(meta.sessionId || ''),
        startedAt, socketId: String(meta.socketId || ''), membershipId: String(meta.membershipId || '').slice(0,160), deviceId: normalizeDeviceId(meta.deviceId || ''), source: String(meta.source || 'pagehide'),
        timer: null, armDiagnosticId: "", signalDiagnosticId: String(meta.signalDiagnosticId || ""),
    };
    const armEvent = recordDiagnostic({
        source: "server", kind: "browser_exit_armed", page: pending.page,
        message: `${pending.page} browser exit signal accepted; exit is delayed for reconnect grace`,
        traceId: pending.traceId, sessionId: pending.sessionId, roomId: id,
        context: { kind, roomId: id, source: pending.source, graceMs: Math.max(250, Number(graceMs) || BROWSER_EXIT_PLAYER_GRACE_MS), socketId: pending.socketId ? "present" : "missing" },
        causalHint: { failureStage: "browser.lifecycle", causeCode: "BROWSER_EXIT_ARMED", confidence: "high", upstreamEventIds: pending.signalDiagnosticId ? [pending.signalDiagnosticId] : [] },
    });
    pending.armDiagnosticId = String(armEvent?.id || "");
    if (pending.signalDiagnosticId && pending.armDiagnosticId) linkDiagnosticEvents(pending.signalDiagnosticId, pending.armDiagnosticId, "causes");
    pending.timer = setTimeout(async () => {
        const current = pendingBrowserExits.get(key);
        if (current !== pending) return;
        pendingBrowserExits.delete(key);
        try {
            await apply(pending);
        } catch (e) {
            console.error(`[browser-exit] apply ${kind} ${id} failed:`, e?.name || 'Error', e?.message || e);
            recordDiagnostic({
                source: 'server', kind: 'browser_exit_apply_error', page: pending.page,
                message: e?.message || String(e), stack: e?.stack || '',
                traceId: pending.traceId, sessionId: pending.sessionId,
                context: { code: 'BROWSER_EXIT_APPLY_ERROR', kind, roomId: id, source: pending.source }
            });
        }
    }, Math.max(250, Number(graceMs) || BROWSER_EXIT_PLAYER_GRACE_MS));
    pendingBrowserExits.set(key, pending);
    addDiagnosticBreadcrumb({
        source: 'server', type: 'browser_exit', label: 'browser_exit.armed',
        traceId: pending.traceId, sessionId: pending.sessionId, page: pending.page,
        detail: { kind, roomId: id, source: pending.source, graceMs: Math.max(250, Number(graceMs) || BROWSER_EXIT_PLAYER_GRACE_MS) }
    });
    return true;
}

async function closeRoomNow(roomId, reason) {
    const room = rooms[roomId];
    if (!room || room.isClosing) return false;
    // กัน allocator แจก tester slot เดิมซ้ำระหว่างที่การลบ snapshot กำลัง await อยู่
    room.isClosing = true;
    bumpRoomState(room, "room_closed", { reason, source: "room" });

    io.to(roomId).emit('room_closed', { reason, stateVersion: room.stateVersion });

    room.players.forEach((p) => {
        io.sockets.sockets.get(p.id)?.leave(roomId);
        if (pendingRemovals[p.token]) {
            clearTimeout(pendingRemovals[p.token].timer);
            delete pendingRemovals[p.token];
        }
        if (pendingIndicators[p.token]) {
            clearTimeout(pendingIndicators[p.token]);
            delete pendingIndicators[p.token];
        }
    });

    (room.hostIds || []).forEach((hid) => {
        io.sockets.sockets.get(hid)?.leave(hostRoomName(roomId));
        delete hostSocketRooms[hid];
    });

    for (const [key, pending] of pendingBrowserExits.entries()) {
        if (pending.roomId === String(roomId || '').toUpperCase()) {
            clearTimeout(pending.timer);
            pendingBrowserExits.delete(key);
        }
    }

    // Reject new snapshots once closing, then drain old ones before deleting the durable copy.
    await roomSnapshotWrites.get(String(roomId).toUpperCase())?.catch(() => {});
    if (ROOM_PERSISTENCE_ENABLED) {
        return deletePersistedRoom(roomId)
            .catch((e) => {
                console.error(`[room-persist] ลบ snapshot ห้อง ${roomId} ตอนปิดห้องไม่สำเร็จ:`, e.name, e.message);
            })
            .then(async () => {
                await releaseRoomLease(roomId).catch((e) => console.error(`[room-lease] release ${roomId} on close failed:`, e?.message || e));
                delete rooms[roomId];
                clearGameOverTimer(roomId);
                clearVoteTimer(roomId);
                broadcastSuggestedRoom();
                return true;
            });
    }

    return releaseRoomLease(roomId)
        .catch((e) => console.error(`[room-lease] release ${roomId} on close failed:`, e?.message || e))
        .then(() => {
            delete rooms[roomId];
            clearGameOverTimer(roomId);
            clearVoteTimer(roomId);
            broadcastSuggestedRoom();
            return true;
        });
}

// ============================================================
// บั๊ก/ความเสี่ยง (พบใหม่): host_login (hostPassword) และ join_room (joinCode) เช็ครหัส
// ด้วย string เทียบตรงๆ โดยไม่มีการจำกัดจำนวนครั้งที่ลองผิดเลยสักจุด — รหัสทั้งสองแบบเป็น
// ตัวอักษรที่ผู้ใช้ตั้งเองยาวได้สูงสุด 20 ตัว (ส่วนมากจะสั้นๆ เพราะพิมพ์บนมือถือ) การเปิด
// socket connection ใหม่มาลองรหัสซ้ำๆ ทำได้ง่ายกว่าและถี่กว่า HTTP request ทั่วไปมาก (ไม่มี
// TLS handshake ใหม่ทุกครั้งถ้าใช้ connection เดิม, ไม่มี rate-limit ระดับ HTTP มาช่วยกันเลย)
// เท่ากับเปิดช่องให้ brute-force รหัสห้อง/รหัสคุมโฮสต์ได้ในเวลาไม่นาน — ใส่ตัวจำกัดจำนวนครั้ง
// ที่ลองผิดต่อห้อง (ไม่ใช่ต่อ socket เพราะเปิด socket ใหม่ได้เรื่อยๆ อยู่ดี) ไว้กันไว้: ผิดเกิน
// จำนวนที่กำหนดภายในช่วงเวลาสั้นๆ จะถูกล็อกไม่ให้ลองต่อชั่วคราว ผ่านไปแล้วรีเซ็ตนับใหม่
const LOGIN_ATTEMPT_MAX = 8; // ลองผิดได้ไม่เกินกี่ครั้งก่อนโดนล็อกชั่วคราว
const LOGIN_ATTEMPT_WINDOW_MS = 60_000; // นับจำนวนครั้งภายในช่วงเวลานี้
const LOGIN_ATTEMPT_LOCKOUT_MS = 30_000; // ล็อกไว้นานเท่านี้เมื่อลองผิดครบโควตา
const loginAttemptTracker = {}; // key: `${type}:${roomId}` -> { count, windowStart, lockedUntil }

// คืนค่า true ถ้ายัง "ลองได้" อยู่ (ยังไม่ถูกล็อก) — เรียกก่อนเช็ครหัสทุกครั้ง
function isLoginAttemptAllowed(key) {
    const entry = loginAttemptTracker[key];
    if (!entry) return true;
    const now = Date.now();
    if (entry.lockedUntil && now < entry.lockedUntil) return false;
    if (entry.lockedUntil && now >= entry.lockedUntil) {
        delete loginAttemptTracker[key]; // พ้นช่วงล็อกแล้ว เริ่มนับใหม่รอบถัดไป
    }
    return true;
}

// เรียกทุกครั้งที่เช็ครหัสแล้ว "ผิด" — นับจำนวนครั้งสะสมภายในหน้าต่างเวลา ถ้าเกินโควตาจะล็อก
function recordFailedLoginAttempt(key) {
    const now = Date.now();
    let entry = loginAttemptTracker[key];
    if (!entry || now - entry.windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
        entry = { count: 0, windowStart: now, lockedUntil: 0 };
        loginAttemptTracker[key] = entry;
    }
    entry.count += 1;
    if (entry.count >= LOGIN_ATTEMPT_MAX) {
        entry.lockedUntil = now + LOGIN_ATTEMPT_LOCKOUT_MS;
    }
}

// เรียกทุกครั้งที่เช็ครหัสแล้ว "ถูก" — เคลียร์ประวัติลองผิดของห้องนี้ทิ้ง (ผู้เล่นจริงเข้าห้องได้
// ตามปกติแล้ว ไม่ต้องเก็บนับต่อ)
function clearFailedLoginAttempts(key) {
    delete loginAttemptTracker[key];
}

// เช็คว่า player คนนี้ยัง "เชื่อมต่ออยู่จริง" ในตอนนี้หรือไม่ (เทียบจาก socket ที่ผูกกับ id ปัจจุบัน)
// ใช้แทนการเช็ค player.disconnected เดิม เพราะ id ของ player จะถูกอัปเดตเป็น socket.id
// ใหม่ทันทีที่ reconnect สำเร็จ (ดู join_room / host_login) ทำให้เช็คจาก socket จริงแม่นกว่า
function getRoomPlayerForSocket(room, socket, { includeHost = false } = {}) {
    if (!room || !socket) return null;
    const socketRoomId = String(socket.data?.roomId || '').trim().toUpperCase();
    const socketMembershipId = String(socket.data?.membershipId || '').trim();
    if (socketRoomId === String(room.id || '').trim().toUpperCase() && socketMembershipId) {
        const member = (room.players || []).find((p) => {
            if (!p || (!includeHost && p.isHost)) return false;
            return String(p.membershipId || '').trim() === socketMembershipId;
        });
        if (member) return member;
    }
    return (room.players || []).find((p) => p && p.id === socket.id && (includeHost || !p.isHost)) || null;
}

function getRoomPlayerIdForSocket(room, socket) {
    const player = getRoomPlayerForSocket(room, socket);
    return player?.id || socket?.id || '';
}

function isPlayerCurrentlyConnected(player) {
    if (!player) return false;
    if (player.isHost) {
        return false;
    }
    const roomId = String(player.roomId || '').trim().toUpperCase();
    const membershipId = String(player.membershipId || '').trim();
    if (membershipId && roomId && io?.sockets?.sockets) {
        for (const sock of io.sockets.sockets.values()) {
            if (!sock?.connected || sock.data?.resetInvalidated) continue;
            if (String(sock.data?.roomId || '').trim().toUpperCase() !== roomId) continue;
            if (String(sock.data?.membershipId || '').trim() === membershipId) return true;
        }
    }
    const sock = io.sockets.sockets.get(player.id);
    return !!sock && sock.connected && !sock.data?.resetInvalidated;
}

// ============================================================
// MULTI-SCREEN HOST SUPPORT
// ============================================================
// รองรับกรณีโฮสต์คุมเกมจาก "หลายจอพร้อมกัน" (เช่น โน้ตบุ๊ก + มือถือ)
// เดิมระบบเก็บโฮสต์เป็น socket เดียว (room.host) พอมีจอที่สอง login เข้ามา
// จอแรกจะถูก "แย่งสิทธิ์" ไปทันที เพราะทุกปุ่ม (เริ่มเกม/เริ่มต้นใหม่/ฯลฯ) เช็คแค่
// socket.id === room.host ตัวเดียว ทำให้จอแรกกดอะไรไม่ได้อีกเลยจนกว่าจะ login ซ้ำ
// เปลี่ยนมาเก็บเป็น "ชุดของ socket โฮสต์ที่ล็อกอินอยู่พร้อมกันได้" (room.hostIds) แทน
// ทุกจอที่ login ด้วย token โฮสต์เดียวกันจะมีสิทธิ์เท่ากันหมด และได้รับ broadcast ของ
// โฮสต์ (host_error, ข้อความส่วนตัวของโฮสต์ ฯลฯ) ครบทุกจอพร้อมกัน ไม่ต้องกดซ้ำสองจอ
const hostSocketRooms = {}; // socket.id -> roomId ("โฮสต์ socket นี้อยู่ห้องไหน") ใช้ตอน disconnect

function hostRoomName(roomId) {
    return `${roomId}::host`;
}

// เช็คว่า socket นี้เป็นหนึ่งใน "จอโฮสต์" ของห้องนี้หรือไม่ (แทนการเทียบ === room.host ตัวเดียว)
function isHostSocket(room, socketId) {
    return !!room && Array.isArray(room.hostIds) && room.hostIds.includes(socketId);
}

// หา "ผู้เล่นที่เลือกเป็นเป้าหมายได้จริง" ในเกม — กันโฮสต์ออกเสมอในจุดเดียวรวมศูนย์
// (โฮสต์ยังถูกเก็บอยู่ใน room.players เป็นแถวหนึ่งด้วยเหตุผลด้าน backward-compat ของโค้ดเดิม
// (alive:true, role:null) แต่ไม่ใช่ผู้เล่นในเกมจริง ไม่ควรถูกเลือกเป็นเป้าของความสามารถ/โหวต/
// ส่องบทใดๆ ได้เลย) เดิมแต่ละ handler เขียนเช็ค `target.isHost` เองแยกจุด ทำให้พลาดได้ง่ายเวลา
// เพิ่มบทบาทใหม่ (เกิดขึ้นจริงกับ scout_target/detective_scout/select_target ที่ไม่มีการเช็คนี้
// มาก่อน) — บทบาท/ความสามารถใหม่ในอนาคตควรเรียกใช้ฟังก์ชันนี้แทนการ room.players.find(...) ตรงๆ
// เพื่อไม่ให้บั๊กแบบเดียวกันเกิดซ้ำอีก
function findTargetablePlayer(room, targetId, { requireAlive = true } = {}) {
    if (!room || !targetId) return null;
    const target = room.players.find((p) => p.id === targetId);
    if (!target || target.isHost) return null;
    if (requireAlive && !target.alive) return null;
    return target;
}

// เพิ่ม socket นี้เข้าเป็นหนึ่งในจอโฮสต์ของห้อง — ไม่ไล่จอเก่าที่ยังเชื่อมต่ออยู่ออก
function addHostSocket(room, roomId, socket) {
    room.hostIds = room.hostIds || [];
    if (!room.hostIds.includes(socket.id)) room.hostIds.push(socket.id);
    room.host = socket.id; // เก็บไว้เผื่อโค้ดเก่าอ้างอิง (ใช้เป็น "จอที่ login ล่าสุด" เฉยๆ)
    hostSocketRooms[socket.id] = roomId;
    socket.join(roomId);
    socket.join(hostRoomName(roomId));
}

// เอา socket นี้ออกจากรายชื่อจอโฮสต์ของห้อง (ตอน disconnect)
// คืนค่า true ถ้ายังเหลือจอโฮสต์อื่นที่เชื่อมต่ออยู่
function removeHostSocket(room, socketId) {
    delete hostSocketRooms[socketId];
    if (!room || !Array.isArray(room.hostIds)) return false;
    room.hostIds = room.hostIds.filter((id) => id !== socketId);
    return room.hostIds.length > 0;
}

// timer "ดำเนินการต่ออัตโนมัติ" หลังเกมจบ — แยกไว้นอก room object เหมือน pendingRemovals
// เดิม logic นี้ทำฝั่ง client ด้วย setInterval อย่างเดียว (นับ 5 วิแล้วกดให้)
// ปัญหา: ถ้าจอนั้นไม่ได้เปิดอยู่ (สลับแท็บ/พับจอ) เบราว์เซอร์จะ throttle/หยุด setInterval
// ทำให้ไม่กดต่อให้ และเกมค้าง รอจนกว่าจะมีคนเปิดจอนั้นเอง
// ย้าย "นาฬิกาจริง" มาไว้ที่ server แทน เพื่อให้เกมเดินต่อได้แม้ไม่มีจอไหนเปิดอยู่เลย
// (client ฝั่งหน้าจอที่เปิดอยู่ยังนับโชว์ UI เหมือนเดิม แต่ไม่ใช่ตัวตัดสินอีกต่อไป)
const gameOverTimers = {};

function clearGameOverTimer(roomId) {
    if (gameOverTimers[roomId]) {
        clearTimeout(gameOverTimers[roomId]);
        delete gameOverTimers[roomId];
    }
    const room = rooms[String(roomId || "").toUpperCase()];
    if (room) room.gameOverDeadlineAt = null;
}

// ----------------------------------------------------------------------
// เวลานับถอยหลังของ "โหมดโหวต" — โฮสต์กดเปิดโหวตแล้วมีเวลา VOTE_ROUND_MS
// หมดเวลาจะปิดโหมดโหวต (นับคะแนน/ประหาร) แล้วเข้าคืนถัดไปให้อัตโนมัติเลย
// ถ้าโฮสต์กดปิดโหวตเองก่อนหมดเวลา ก็ปิดโหมดแล้วเข้าคืนอัตโนมัติเหมือนกัน
// เก็บ timer handle ไว้นอก room object เหมือน gameOverTimers (ห้าม JSON-serialize ปนไปกับ room)
// ----------------------------------------------------------------------
const VOTE_ROUND_MS = 15000;
const voteTimers = {};

function clearVoteTimer(roomId) {
    if (voteTimers[roomId]) {
        clearTimeout(voteTimers[roomId]);
        delete voteTimers[roomId];
    }
    const room = rooms[String(roomId || "").toUpperCase()];
    if (room) room.voteDeadline = null;
}

function scheduleAutoContinue(room, roomId, delayMs = 5_000) {
    clearGameOverTimer(roomId);
    const delay = Math.max(0, Number(delayMs) || 0);
    room.gameOverDeadlineAt = Date.now() + delay;
    gameOverTimers[roomId] = setTimeout(() => {
        delete gameOverTimers[roomId];
        const r = rooms[roomId];
        if (!r || !r.gameOver) return;
        r.gameOverDeadlineAt = null;
        r.continueReady = r.continueReady || {};
        r.players.filter((p) => !p.isHost).forEach((p) => {
            r.continueReady[p.id] = true;
        });
        broadcastRoomUpdate(roomId, r);
    }, delay);
}

function scheduleRecoveredRoomTimers(room) {
    if (!room || !room.id) return;
    const id = String(room.id).toUpperCase();

    // Capture durable deadlines BEFORE clearing local timer handles. clear*Timer() also clears
    // the durable deadline fields, so reading them afterwards would silently lose recovery data.
    const recoveredGameOverDeadlineAt = Number(room.gameOverDeadlineAt) > 0 ? Number(room.gameOverDeadlineAt) : 0;
    const recoveredVoteDeadline = Number(room.voteDeadline) > 0 ? Number(room.voteDeadline) : 0;

    clearGameOverTimer(id);
    clearVoteTimer(id);

    if (room.gameOver) {
        const delay = recoveredGameOverDeadlineAt > 0
            ? Math.max(0, recoveredGameOverDeadlineAt - Date.now())
            : 5_000;
        scheduleAutoContinue(room, id, delay);
    }

    if (room.voteMode && room.voteTimerEnabled !== false && recoveredVoteDeadline > 0) {
        const delay = Math.max(0, recoveredVoteDeadline - Date.now());
        const markVoteResolutionPending = () => {
            const current = rooms[id];
            if (!current || !current.voteMode || current.voteTimerEnabled === false) return;
            current.voteDeadline = null;
            current.__recoveredVoteResolutionPending = true;
            schedulePersistRoom(id, true);
        };
        if (delay === 0) {
            markVoteResolutionPending();
        } else {
            const timer = setTimeout(() => {
                delete voteTimers[id];
                markVoteResolutionPending();
            }, delay);
            timer.unref?.();
            voteTimers[id] = timer;
        }
    } else if (room.voteMode && room.voteTimerEnabled !== false && recoveredVoteDeadline <= 0) {
        // Older snapshots may predate the durable vote deadline. Do not invent a fresh full round;
        // mark it for immediate resolution when a live game socket reconnects.
        room.__recoveredVoteResolutionPending = true;
    }
}

function resumeRecoveredRoomRuntimeTransitions(room, roomId) {
    if (!room || !room.id || room.gameOver) return false;
    const id = String(roomId || room.id).toUpperCase();
    if (!room.__recoveredVoteResolutionPending || !room.voteMode) return false;
    room.__recoveredVoteResolutionPending = false;
    closeVoteRound(room, id);
    schedulePersistRoom(id, true);
    return true;
}

// ============================================================
// CONSTANTS
// ============================================================

// บทบาททีมหมาป่าทั้งหมด (ใช้ทั้งฝั่ง server และส่งให้ client ผ่าน roles_data)
// เพิ่มบทใหม่ที่นี่ที่เดียว — ทุกจุดที่ใช้จะได้รับค่าถูกต้องอัตโนมัติ
const WOLF_ROLES = new Set([
    "หมาป่า",
    "ลูกหมาป่า",
    "หมาป่าผู้พิทักษ์",
    "หมาป่าดื้อรั้น",
    "หมาป่านักเวท",
    "หมาป่าหยั่งรู้",
]);

// บทบาทที่ "วางโล่ป้องกันการประหาร" ได้ (กลไก select_shield/guardianShieldAvailable ร่วมกัน)
// หมาป่าผู้พิทักษ์ (ทีมหมาป่า) และหนูน้อยผู้ใสซื่อ (ทีมชาวบ้าน) ใช้กลไกเดียวกันทุกประการ
// ต่างกันแค่ทีม/ไอคอน/ข้อความ — เพิ่มบทใหม่ที่ใช้กลไกนี้ที่นี่ที่เดียว
const GUARDIAN_ROLES = new Set(["หมาป่าผู้พิทักษ์", "หนูน้อยผู้ใสซื่อ"]);

// บทบาททีมเดี่ยว (solo) ที่มี "ความสามารถฆ่า" จริงๆ เท่านั้น — ใช้กรองตอนผู้ยุยงจับคู่อัตโนมัติ
// (ดู start_game: wolfOrSoloPool) ทีมเดี่ยวทั้งหมดมี 3 บท: คนบ้า/นักล่าหัว/ฆาตกรต่อเนื่อง แต่มีแค่
// "ฆาตกรต่อเนื่อง" เท่านั้นที่ลงมือฆ่าคนเองได้จริง (คนบ้าไม่มีสกิลฆ่าเลย ส่วนนักล่าหัวแค่ "จิ้มเป้าไว้ล่วงหน้า
// รอให้หมู่บ้านโหวตประหารเอง" ไม่ได้ลงมือฆ่าเอง — ดูคอมเมนต์ "ไม่มีความสามารถฆ่าเพื่อเคลียร์เกมเอง" ที่
// checkGameEndGeneral) ถ้าปล่อยให้คนบ้า/นักล่าหัวถูกจับคู่ได้ คู่ที่ถูกจับจะไม่ได้จับคู่กับ "คนที่มีพลังฆ่า"
// จริงๆ ตามที่ผู้ยุยงควรจับคู่ด้วย (คู่ต่างขั้ว ชาวบ้าน x ฝ่ายที่ฆ่าคนได้)
const SOLO_KILLER_ROLES = new Set(["ฆาตกรต่อเนื่อง", "นักเล่นกล"]);

// ============================================================
// ผู้นำลัทธิ (CULT LEADER) — บทบาททีมพิเศษ "ลัทธิ": เปลี่ยนทีมของผู้เล่นคนอื่นให้เข้าร่วมลัทธิได้
// (โดยไม่เปลี่ยน role เดิม แค่เปลี่ยน "ทีมที่มีผลจริง" — ดู effectiveTeam) หรืออีกทางหนึ่งสังเวย
// สมาชิกลัทธิเพื่อฆ่าผู้เล่นคนอื่น — ดู performCultAction/resolve_night
// ============================================================
const CULT_MAX_MEMBERS = 5; // จำนวนสมาชิกลัทธิที่ยังมีชีวิตอยู่สูงสุดต่อผู้นำลัทธิ 1 คน
// บทบาทที่ห้ามชักชวนเข้าลัทธิเด็ดขาด: หมาป่าทุกชนิด, ฆาตกรต่อเนื่อง (นักฆ่าเดี่ยว),
// ผู้นำลัทธิคนอื่น (กันเปลี่ยนทีมกันเอง) และผู้ถูกสาป (ระบุไว้ในคำอธิบายบทบาทผู้ถูกสาปเองอยู่แล้วว่า
// "ไม่สามารถโดนเปลี่ยนไปอยู่ทีมอื่นจากผู้นำลัทธิ ฯลฯ ได้")
const CULT_RECRUIT_IMMUNE_ROLES = new Set(["ผู้ถูกสาป"]);

function isCultLeaderPlayer(p) {
    return !!p && p.role === "ผู้นำลัทธิ";
}
function isCultMemberPlayer(p) {
    return !!(p && p.cultLeaderId);
}
// คืน id ของผู้นำลัทธิที่ p สังกัดอยู่ (ทั้งตัวผู้นำเองและสมาชิก) — null ถ้าไม่เกี่ยวข้องกับลัทธิใดเลย
// ใช้เทียบ "กลุ่มลัทธิเดียวกัน" (กันเคสมีผู้นำลัทธิมากกว่า 1 คนในห้องเดียวกันแล้วกลุ่มไปปนกัน)
function cultGroupIdOf(p) {
    if (!p) return null;
    if (isCultLeaderPlayer(p)) return p.id;
    return p.cultLeaderId || null;
}
// สมาชิกลัทธิที่ยังมีชีวิตอยู่ทั้งหมดของผู้นำคนนี้ (ไม่รวมตัวผู้นำเอง)
function aliveCultMembersOf(room, leaderId) {
    return room.players.filter((p) => p.alive && !p.isHost && p.cultLeaderId === leaderId);
}
// ผู้เล่นประเภท "โจมตีแบบระบุตัวได้" (ไม่ใช่การกัดแบบสุ่มลำดับชั้นของหมาป่า) — ใช้ตัดสินว่าจะ
// เปิดเผยตัวผู้โจมตีจริง (killedByPlayerId) หรือใช้ pickBiter(room) แบบหมาป่าทั่วไป
const PERSONAL_ATTACKER_KILL_TYPES = new Set(["murderer", "instigator", "cult", "bandit"]);
function attackerLabelFor(killedBy) {
    if (killedBy === "instigator") return "ผู้ยุยง";
    if (killedBy === "murderer") return "ฆาตกรต่อเนื่อง";
    if (killedBy === "cult") return "ลัทธิ";
    if (killedBy === "bandit") return "โจร";
    return "หมาป่า";
}

// ============================================================
// โจร (BANDIT) — ทีมพิเศษ "โจร": ต่างจากผู้นำลัทธิตรงที่เป้าหมายที่ถูกชักชวนจะถูก "เปลี่ยนบทบาทจริง"
// เป็น "ผู้สมรู้ร่วมคิด" ไปเลย (ไม่ใช่แค่เปลี่ยนทีมที่มีผลจริงแบบลัทธิ) และมีผู้สมรู้ร่วมคิดได้ครั้งละ
// สูงสุด 1 คนเท่านั้น (ชวนใหม่ได้อีกถ้าคนเดิมตายไปแล้ว) — ในคืนที่ยังไม่มีผู้สมรู้ร่วมคิด หัวโจรเลือก
// เปลี่ยนบทบาทผู้เล่นคนอื่นได้ (ถ้าเป้าหมายเป็นมนุษย์หมาป่า จะถูกฆ่าทันทีแทนการเปลี่ยนบทบาท) ส่วนคืน
// ที่มีผู้สมรู้ร่วมคิดอยู่แล้ว หัวโจร + ผู้สมรู้ร่วมคิด เลือกฆ่าผู้เล่นร่วมกันได้คืนละ 1 คน (เลือกแยกเป้า
// กันได้ ถ้าคนละเป้าจะสุ่ม 1 เป้าเหมือนกลไกหมาป่า) — ดู performBanditAction/performBanditKill/resolve_night
// แชททีมโจร: พิมพ์ได้เฉพาะหัวโจรเท่านั้น ผู้สมรู้ร่วมคิดอ่านได้อย่างเดียว — ดู send_chat (type "bandit")
// ============================================================
const BANDIT_RECRUIT_IMMUNE_ROLES = new Set(["ผู้ถูกสาป"]); // เหตุผลเดียวกับลัทธิ (ผู้ถูกสาปห้ามถูกเปลี่ยนทีม/บทบาทจากภายนอก)
const BANDIT_ROLES = new Set(["โจร", "ผู้สมรู้ร่วมคิด"]);
// อาชีพที่ "ได้มาจากการเปลี่ยนบทบาทกลางเกมเท่านั้น" ห้ามเป็นอาชีพเริ่มต้นที่โฮสต์ติ๊กเลือกไว้ล่วงหน้าได้
// เด็ดขาด — ใช้ทั้งกรองออกจาก __nonSelectableRoles (ที่ส่งให้ client ผ่าน roles_data) และกันซ้ำอีกชั้น
// ตอน start_game (เผื่อ config หลุดรอดมาจากช่องทางอื่นที่ไม่ผ่าน UI ปกติ)
const NON_SELECTABLE_ROLES = new Set(["ผู้สมรู้ร่วมคิด"]);

function isBanditLeaderPlayer(p) {
    return !!p && p.role === "โจร";
}
function isBanditAccomplicePlayer(p) {
    return !!p && p.role === "ผู้สมรู้ร่วมคิด";
}
// id ของหัวโจรที่ผู้เล่นคนนี้สังกัดกลุ่มอยู่ (หัวโจรเองคืน id ตัวเอง, ผู้สมรู้ร่วมคิดคืน id หัวโจรที่เปลี่ยนตน,
// คนอื่นคืน null) — ใช้เทียบ "กลุ่มโจรเดียวกัน" กันเคสห้องเดียวกันมีหัวโจรมากกว่า 1 คน
function banditGroupIdOf(p) {
    if (!p) return null;
    if (isBanditLeaderPlayer(p)) return p.id;
    if (isBanditAccomplicePlayer(p)) return p.banditLeaderId || null;
    return null;
}
// ผู้สมรู้ร่วมคิดที่ยังมีชีวิตอยู่ของหัวโจรคนนี้ (ปกติมีได้สูงสุดแค่ 1 คนต่อครั้ง)
function aliveBanditAccomplicesOf(room, leaderId) {
    return room.players.filter((p) => p.alive && !p.isHost && p.role === "ผู้สมรู้ร่วมคิด" && p.banditLeaderId === leaderId);
}

// ============================================================
// ลำดับชั้นหมาป่าสำหรับเลือก "คนกัด" ตอนต้องเปิดเผยตัวตนแบบส่วนตัว// ============================================================
// ลำดับชั้นหมาป่าสำหรับเลือก "คนกัด" ตอนต้องเปิดเผยตัวตนแบบส่วนตัว
// (เช่น โจมตีอันธพาลแล้วโดนป้องกันตัวเอง) — ยศต่ำสุดถูกเปิดเผยก่อน ไล่ขึ้นไปเรื่อยๆ:
// ลูกหมาป่า → หมาป่าปกติที่มาจากผู้ถูกสาป → หมาป่าปกติ → หมามีสกิลต่างๆ → หมาป่าหยั่งรู้ (ยศสูงสุด)
// ============================================================
const WOLF_BITE_RANK = {
    "ลูกหมาป่า": 0,
    "หมาป่า:cursed": 1, // ผู้ถูกสาปที่กลายร่างเป็นหมาป่า (p.transformed === true)
    "หมาป่า": 2,
    "หมาป่าผู้พิทักษ์": 3,
    "หมาป่าดื้อรั้น": 3,
    "หมาป่านักเวท": 3,
    "หมาป่าหยั่งรู้": 4,
};

function getWolfBiteRank(p) {
    // สำคัญ: เช็ค !p.oracleTransformed ก่อน เพราะหมาป่าหยั่งรู้ที่กลายร่างก็ใช้ p.role === "หมาป่า"
    // เหมือนกัน แต่ไม่ใช่ผู้ถูกสาป ไม่ควรตกไปอยู่ยศต่ำสุดร่วมกับผู้ถูกสาปกลายร่าง
    if (p.role === "หมาป่า" && p.transformed && !p.oracleTransformed) return WOLF_BITE_RANK["หมาป่า:cursed"];
    return WOLF_BITE_RANK[p.role] ?? 99;
}

// เลือก "คนกัด" จากหมาป่าที่ยังมีชีวิตอยู่ทั้งหมดในทีม (ไม่สนว่าใครโหวตเป้านี้จริงหรือไม่)
// ยศต่ำสุดถูกเลือกก่อน ถ้ายศเท่ากันสุ่มเลือก 1 ตัว
function pickBiter(room) {
    const aliveWolves = room.players.filter((p) => p.alive && WOLF_ROLES.has(p.role));
    if (aliveWolves.length === 0) return null;
    let minRank = Infinity;
    aliveWolves.forEach((p) => {
        const r = getWolfBiteRank(p);
        if (r < minRank) minRank = r;
    });
    const candidates = aliveWolves.filter((p) => getWolfBiteRank(p) === minRank);
    return candidates[Math.floor(Math.random() * candidates.length)];
}

// เงื่อนไขจบเกมที่รองรับ — เพิ่มที่นี่ที่เดียวถ้าต้องการเพิ่มเงื่อนไขใหม่
const WIN_CONDITIONS = ["fool", "headhunter", "wolf", "murderer", "illusionist", "villager", "lovers", "instigators"];

const teamLabels = {
    wolf: "หมาป่า",
    villager: "ชาวบ้าน",
    fool: "คนบ้า",
    headhunter: "นักล่าหัว",
    murderer: "ฆาตกรต่อเนื่อง",
    illusionist: "นักเล่นกล",
    lovers: "คู่รัก",
    instigators: "ผู้ยุยง",
};

// ============================================================
// ROLE DEFINITIONS
// ============================================================

const roles = {
    "หมาป่า":           { team: "wolf",     score: 2, messages: [] },
    "ลูกหมาป่า":        { team: "wolf",     score: 4, messages: ["จะลากใครคลิ๊กไว้"] },
    "หมาป่าผู้พิทักษ์":   { team: "wolf",     score: 3, messages: ["ปกป้องหมาตัวไหนคลิ๊กเลย"] },
    "หมาป่าดื้อรั้น":  { team: "wolf",     score: 3, messages: ["คุณได้รับบาดเจ็บ หากถูกโจมตีอีกครั้งคุณจะตาย"] },
    "หมาป่านักเวท":    { team: "wolf",     score: 4, messages: ["ร่ายเวทย์ใส่ใครกดคลิ๊ก"] },
    "หมาป่าหยั่งรู้":      { team: "wolf",     score: 3, messages: [] }, // ยศสูงสุดของหมาป่า — ส่องเห็นบทบาทจริงของคนที่ไม่ใช่หมาป่าให้ทีมหมาป่ารู้ทั้งทีม (ผ่าน scout_target ตอนโหมดเลือกฆ่า)

    "ชาวบ้าน":         { team: "villager", score: 3, messages: ["ไอไก่"] },
    "ผู้ถูกสาป":       { team: "villager", score: 3, messages: [] }, // กลายร่างอัตโนมัติตอน resolve_night ไม่ต้องมี preset ให้โฮสต์กดแล้ว
    "หมอ":             { team: "villager", score: 3, messages: [] }, // เกมแจ้งอัตโนมัติแล้วตอน resolve_night (ข้อความ "การป้องกันของคุณได้ช่วย X ไว้")
    "บอดี้การ์ด":      { team: "villager", score: 3, messages: [] }, // ปกป้องตัวเองอัตโนมัติตอน resolve_night แล้ว ไม่ต้องมี preset ให้โฮสต์กด
    "อันธพาล":        { team: "villager", score: 3, messages: [] }, // ปกป้องตัวเองอัตโนมัติตอน resolve_night แล้ว ไม่ต้องมี preset ให้โฮสต์กด
    "หนูน้อยผู้ใสซื่อ": { team: "villager", score: 3, messages: [] }, // ก็อปกลไกหมาป่าผู้พิทักษ์มาทั้งหมด (วางโล่ป้องกันการประหารผ่าน select_shield) แค่เปลี่ยนทีม/ไอคอน — ดู GUARDIAN_ROLES
    "ผู้มีลาง":        { team: "villager", score: 3, messages: [] }, // ส่องอัตโนมัติแล้วผ่าน scout_target (ลาง:ดี/ร้าย/ไม่ทราบ) ไม่ต้องให้โฮสต์กดพรีเซ็ตเองแล้ว
    "ผู้หยั่งรู้":      { team: "villager", score: 4, messages: [] }, // ส่องเห็นบทบาทจริงแบบเป๊ะๆ เหมือนหมาป่าหยั่งรู้ แต่เห็นคนเดียว (self-only) ผ่าน scout_target
    "นักสืบ":          { team: "villager", score: 4, messages: [] }, // เลือก 2 คนต่อคืนเพื่อดูว่าอยู่ทีมเดียวกันไหม (=/≠) ผ่าน detective_scout — เห็นผลเฉพาะตัวเอง (self-only)
    "ยายขี้โมโห":          { team: "villager", score: 3, messages: ["ใบ้ใครคลิ๊กเลย"] },
    "แม่มด":           { team: "villager", score: 3, messages: ["เลือกยาป้องกันใส่ใครคลิ๊กเลย", "โยนยาพิษใส่ใครคลิ๊กเลย"] },
    "ศาลเตี้ย":        { team: "villager", score: 3, messages: [] },
    "นักบวช":          { team: "villager", score: 3, messages: [] }, // มีน้ำมนต์ 1 ขวดตลอดเกม ปาได้เฉพาะตอนกลางวัน — ปาโดนหมาป่าคือหมาป่าตาย ปาโดนคนอื่นคือตัวเองตายแทน เปิดเผยบทตัวเองทันทีที่ปา ไม่ว่าผลจะเป็นอย่างไร — ดู cast_priest_holy_water
    "นายก":            { team: "villager", score: 4, messages: [] }, // กดปุ่ม 🤠 เพื่อเปิดเผยตัวเอง (ใช้ได้ครั้งเดียวตลอดเกม) แล้วโหวตของตัวเองนับเป็น 2 เสียงตั้งแต่นั้น — ดู reveal_mayor
    "เด็กขี้โวยวาย":   { team: "villager", score: 3, messages: [] }, // กด 👄 เข้าโหมด เลือกเป้าไว้ล่วงหน้าได้ตลอดเวลา (เหมือนลูกหมาป่า) ถ้าตัวเองตาย บทบาทจริงของเป้าที่เลือกไว้จะถูกเปิดเผยต่อสาธารณะทันที (ไม่ตายตามเหมือนลูกหมาป่า) คืนแรกใช้สกิลไม่ได้ — ดู cleanupAfterDeath/performSelectTarget

    "คนบ้า":           { team: "solo",     score: 2, messages: [] },
    "นักล่าหัว":       { team: "solo",     score: 4, messages: [] },
    "ฆาตกรต่อเนื่อง":           { team: "solo",     score: 4, messages: [] },
    "นักเล่นกล":       { team: "solo",     score: 4, messages: ["ปลอมบทใครกดคลิ๊ก"] }, // ในแต่ละคืนปลอมบทบาทผู้เล่น 1 คนได้ (สะสมได้หลายคน) แล้วกดปุ่ม 🔥 ฆ่าทุกคนที่ถูกปลอมตัวไว้พร้อมกันตอนกลางวันได้ — ดู SOLO_KILLER_ROLES/illusion_kill_disguised
    "กามเทพ":          { team: "villager", score: 4, messages: [] }, // เป็นชาวบ้านปกติ (นับทีม villager จริงๆ ไม่ใช่ solo — มีผลกับ checkGameEndGeneral และผลส่องของนักสืบ) เลือก 2 คน (คืนไหนก็ได้) เพื่อจับคู่เป็นคู่รัก ผ่าน cupid_pair — ดู performCupidPair — การจับคู่จะยังเป็นแค่ "เลือกไว้" (pending) จนกว่าจะสรุปผลตอนเช้า ถึงจะกลายเป็นคู่จริง ดู resolve_night
    "ผู้นำลัทธิ":       { team: "cult",     score: 4, messages: [] }, // ทีมพิเศษ "ลัทธิ" ของตัวเอง — ชักชวนผู้เล่นคนอื่นให้เปลี่ยนทีมมาเข้าร่วมได้ (role เดิมไม่เปลี่ยน แค่ทีมที่มีผลจริงเปลี่ยน — ดู effectiveTeam) หรือสังเวยสมาชิกลัทธิเพื่อฆ่าคนอื่น ผ่าน cult_action — ดู performCultAction/resolve_night
    "ผู้ยุยง":         { team: "solo",     score: 4, messages: [] }, // ทำงานแบบเดียวกับกามเทพ (เลือก 2 คนเพื่อจับคู่ กลายเป็นคู่จริงตอนเช้าเหมือนกัน) ผ่าน instigator_pair — ดู performInstigatorPair — ต่างจากกามเทพตรงที่ตัวผู้ยุยงเองยังเป็นทีม solo อยู่ แต่คู่ที่ถูกจับ (รวมถึงตัวผู้ยุยงเอง) จะถูกนักสืบมองว่า "ทีมเดียวกัน" เสมอเวลาถูกส่องคู่กัน ผ่าน p.instigatorGroupId
                                                                     // ต่างจากกามเทพตรงที่: (1) คู่ที่ถูกจับจะชนะร่วมกับ "ทีมผู้ยุยง" เท่านั้น ไม่ชนะร่วมกับทีมเดิมของตัวเองอีก
                                                                     // (2) คู่ที่ถูกจับเห็นบทบาทที่แท้จริงของ "ผู้ยุยง" เองด้วย ไม่ใช่แค่เห็นกันและกัน
    "โจร":              { team: "bandit",   score: 4, messages: [] }, // ทีมพิเศษ "โจร" ของตัวเอง — คืนที่ยังไม่มีผู้สมรู้ร่วมคิด เปลี่ยนบทบาทผู้เล่นคนอื่นให้เป็นผู้สมรู้ร่วมคิดได้ (หมาป่าจะถูกฆ่าทันทีแทน) คืนที่มีผู้สมรู้ร่วมคิดแล้ว ร่วมกันเลือกฆ่าได้คืนละ 1 คน ผ่าน bandit_action/cast_bandit_kill — ดู resolve_night
    "ผู้สมรู้ร่วมคิด":  { team: "bandit",   score: 3, messages: [] }, // เกิดจากถูกโจรเปลี่ยนบทบาท (role เปลี่ยนจริง ไม่ใช่แค่เปลี่ยนทีมแบบลัทธิ) ร่วมมือกับหัวโจรเลือกฆ่าได้คืนละ 1 คน อ่านแชททีมโจรได้แต่พิมพ์ไม่ได้
};

// Internal diagnostics profile source-of-truth. These refs stay server-only and are never sent directly to clients.
globalThis.__WEREWOLF_ROLES__ = roles;
globalThis.__WEREWOLF_TEAM_LABELS__ = teamLabels;
globalThis.__WEREWOLF_WIN_CONDITIONS__ = WIN_CONDITIONS;

const roleDescription = {
    "หมาป่า": {
        icon: "/images/werewolf.jpg",
        title: "🐺 หมาป่า",
        desc: "ร่วมกันเลือกเหยื่อในกลุ่มหมาป่า และล่าในตอนกลางคืน<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },
    "ลูกหมาป่า": {
        icon: "/images/junior_werewolf.jpg",
        title: "🐺 ลูกหมาป่า",
        desc: "คุณคือลูกหมาป่า เพราะคุณน่ารักมาก คุณ สามารถเลือกผู้เล่นอีกคนให้ตายตามคุณได้เมื่อคุณตาย<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },
    "หมาป่าผู้พิทักษ์": {
        icon: "/images/guardian_wolf.jpg",
        title: "🐺 หมาป่าผู้พิทักษ์",
        desc: "คุณเป็นมนุษย์หมาป่าที่สามารถปกป้องผู้เล่นจาก การถูกประหารได้หนึ่งคน คุณสามารถปกป้องได้ เพียงครั้งเดียวต่อเกมเท่านั้น<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },
    "หมาป่าดื้อรั้น": {
        icon: "/images/stubborn_werewolf.jpg",
        title: "🐺 หมาป่าดื้อรั้น",
        desc: "คุณเป็นมนุษย์หมาป่าธรรมดา แต่คุณแข็งแกร่ง กว่าปกติ เมื่อคุณถูกโจมตี คุณจะได้รับบาดเจ็บ และยังมีชีวิตอยู่ต่อได้ แต่การโจมตีครั้งต่อไปจะ ฆ่าคุณ<br><br>ทีม:หมาป่า    ลาง:ไม่ทราบ",
    },
    "หมาป่านักเวท": {
        icon: "/images/wolf_shaman.jpg",
        title: "🐺 หมาป่านักเวทย์",
        desc: "ในตอนกลางวัน คุณสามารถร่ายเวทย์ใส่ผู้เล่นคน หนึ่งได้ เมื่อผู้หยั่งรู้, ผู้มีลาง, ฯลฯ ตรวจสอบเขา จะ เห็นบทบาทของผู้เล่นคนนั้นเป็นหมาป่านักเวทย์ใน คืนหลังที่ร่าย<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },
    "หมาป่าหยั่งรู้": {
        icon: "/images/wolf_seer.jpg",
        title: "🐺🔮 หมาป่าหยั่งรู้",
        desc: "ในแต่ละคืน คุณสามารถเลือกผู้เล่นหนึ่งคนเพื่อตรวจสอบบทบาทของเขา หากคุณเป็นมนุษย์หมาป่าตัวสุดท้ายที่ยังมีชีวิตอยู่ คุณจะไม่สามารถ ใช้ความสามารถนี้ได้อีก และจะเปลี่ยนเป็นการโหวตผู้เล่นที่จะฆ่าในตอนกลางคืนแทน คุณสามารถสละความสามารถนี้เมื่อใดก็ได้เพื่อกลายเป็นมนุษย์หมาป่าธรรมดา<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },

    "ชาวบ้าน": {
        icon: "/images/village.jpg",
        title: "🏘️ ชาวบ้าน",
        desc: "ไม่มีพลังพิเศษ ใช้การโหวตเพื่อหาหมาป่า<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "ผู้ถูกสาป": {
        icon: "/images/cursed.jpg",
        title: "🧟 ผู้ถูกสาป",
        desc: "คุณคือสมาชิกฝ่ายชาวบ้านจนกระทั่งมนุษย์ หมาป่าพยายามที่จะฆ่าคุณ เมื่อถึงตอนนั้นคุณก็ จะกลายร่างเป็นมนุษย์หมาป่า คุณจำเป็นต้องช่วย ทีมชาวบ้านเท่านั้นจนกว่าคุณจะถูกกัดโดยมนุษย์ หมาป่าเพราะหากคุณเลือกที่จะช่วยทีมมนุษย์ หมาป่าก่อนที่คุณจะถูกกัดจะถือว่าโยนเกมทันที คุณไม่สามารถโดนเปลี่ยนไปอยู่ทีมอื่นจากผู้นำ ลัทธิ ฯลฯ ได้<br><br>ทีม:ชาวบ้าน    ลาง:ดีหรือร้าย",
    },
    "หมอ": {
        icon: "/images/doctor.jpg",
        title: "🩺 หมอ",
        desc: "ในแต่ละคืนคุณสามารถเลือกผู้เล่นเพื่อที่จะ ปกป้องเขาได้ ผู้เล่นที่ถูกป้องกันจะไม่ถูกฆ่าในคืน นั้น<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "บอดี้การ์ด": {
        icon: "/images/bodyguard.jpg",
        title: "💂 บอดี้การ์ด",
        desc: "ในแต่ละคืนคุณสามารถเลือกปกป้องผู้เล่นคนอื่นได้ ผู้เล่นที่ถูกป้องกันจะไม่ถูกฆ่าในคืนนั้น แต่คุณ จะถูกโจมตีแทนผู้เล่นคนนั้น เพราะร่างกายของ คุณแข็งแรงมาก คุณจะสามารถรอดชีวิตมาได้ในการโจมตีครั้งแรก แต่คุณจะตายเมื่อโดนโจมตีอีก ครั้ง และในทุกคืนคุณจะปกป้องตัวเองอัตโนมัติ<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "อันธพาล": {
        icon: "/images/tough_guy.jpg",
        title: "💪 อันธพาล",
        desc: "คุณสามารถเลือกที่จะปกป้องผู้เล่นหนึ่งคนในแต่ละคืนได้ ถ้าคุณหรือผู้เล่นที่คุณปกป้องถูกโจมตีคุณจะยังไม่ตาย คุณและผู้เล่นที่โจมตีสามารถมองเห็นบทบาทของกันและกันได้ คุณจะตายหลังจากจบวันนั้นเพราะทนพิษจากบาดแผลไม่ไหว<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "ผู้มีลาง": {
        icon: "/images/aura_seer.jpg",
        title: "🔮 ผู้มีลาง",
        desc: "ในแต่ละคืนคุณสามารถเลือกผู้เล่นเพื่อดูฝ่ายของ เขาได้: ดี, ร้าย หรือ ไม่ทราบฝ่าย ผู้เล่นฝ่ายร้าย คือทีมมนุษย์หมาป่า และผู้เล่นฝ่ายดีคือทีมชาว บ้าน<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "หนูน้อยผู้ใสซื่อ": {
        icon: "/images/flower_child.jpg",
        title: "🌼 หนูน้อยผู้ใสซื่อ",
        desc: "คุณเป็นชาวบ้านที่สามารถปกป้องผู้เล่นจากการ ถูกประหารได้หนึ่งคน คุณสามารถปกป้องได้เพียง ครั้งเดียวต่อเกมเท่านั้น<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "ผู้หยั่งรู้": {
        icon: "/images/seer.jpg",
        title: "🔮✨ ผู้หยั่งรู้",
        desc: "ในแต่ละคืนคุณสามารถเลือกผู้เล่นเพื่อดูบทบาท ของเขาได้<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "นักสืบ": {
        icon: "/images/detective.jpg",
        title: "🕵️ นักสืบ",
        desc: "ในแต่ละคืน คุณสามารถเลือกผู้เล่นสองคนเพื่อตรวจสอบว่าบทบาทของพวกเขาอยู่ในทีมเดียวกัน หรือไม่ ทีมที่เป็นไปได้คือ: ชาวบ้าน, มนุษย์หมาป่า, คนบ้า, นักล่าหัว, ฆาตกรต่อเนื่อง, ฯลฯ<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "ยายขี้โมโห": {
        icon: "/images/grumpy_grandma.jpg",
        title: "👵 ยายขี้โมโห",
        desc: "ในแต่ละคืนหลังจากคืนแรก คุณสามารถเลือกผู้ เล่นเพื่อปิดเสียงพวกเขาได้ และเขาจะไม่สามารถ พูดคุยหรือโหวตได้ในวันถัดไป คุณไม่สามารถปิด เสียงผู้เล่นคนเดิมสองครั้งติดต่อกันได้<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "แม่มด": {
        icon: "/images/witch.jpg",
        title: "🧙‍♀️ แม่มด",
        desc: "คุณมีน้ำยาสองขวด: ขวดแรกใช้ฆ่าผู้เล่นคน อื่น และอีกขวดหนึ่งใช้ป้องกันผู้เล่นคนอื่น น้ำยา ป้องกันจะถูกใช้งานก็ต่อเมื่อผู้เล่นคนนั้นถูกโจมตี คุณไม่สามารถใช้น้ำยาฆ่าผู้เล่นคนอื่นได้ในคืน แรก<br><br>ทีม:ชาวบ้าน    ลาง:ไม่ทราบ",
    },
    "ศาลเตี้ย": {
        icon: "/images/detective.jpg",
        title: "🔫 ศาลเตี้ย",
        desc: "ในระหว่างวัน คุณสามารถเลือกที่จะยิงหรือเลือก ที่จะเปิดเผยบทบาทของผู้เล่นคนอื่นซึ่งจะมีเพียง แค่คุณเท่านั้นที่จะเห็นบทบาทของเขา หากผู้เล่นที่ คุณเปิดเผยบทบาทเป็นฝ่ายร้ายเขาจะเห็นบทบาท ของคุณ การกระทำทั้งสองสามารถทำได้เพียง ครั้งเดียวต่อเกมเท่านั้นและไม่สามารถทำในวัน เดียวกันได้ บทบาทของคุณจะถูกเปิดเผยให้แก่ ทุกคนเมื่อคุณยิงผู้เล่นคนอื่น<br><br>ทีม:ชาวบ้าน    ลาง:ไม่ทราบ",
    },
    "นักบวช": {
        icon: "/images/priest.jpg",
        title: "🫙 นักบวช",
        desc: "คุณสามารถสาดน้ำมนต์ใส่ผู้เล่นคนอื่นได้ เขาจะ ตายถ้าเขาเป็นมนุษย์หมาป่า แต่ถ้าไม่ใช่ คุณก็จะ ตายเอง<br><br>ทีม:ชาวบ้าน    ลาง:ไม่ทราบ",
    },
    "นายก": {
        icon: "/images/mayor.jpg",
        title: "🤠 นายก",
        desc: "คุณสามารถเปิดเผยบทบาทของคุณให้ผู้เล่นทุก คนเห็นได้ว่าคุณคือนายก ซึ่งจะทำให้คะแนนโหวต ของคุณเป็นสองคะแนน<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "เด็กขี้โวยวาย": {
        icon: "/images/loudmouth.jpg",
        title: "👄 เด็กขี้โวยวาย",
        desc: "หลังจากคืนแรก คุณสามารถเลือกผู้เล่นคนหนึ่งไว้ ล่วงหน้าได้ตลอดเวลา ทั้งกลางวันและกลางคืน และเปลี่ยนเป้าที่เลือกได้เรื่อยๆ ไม่จำกัดจำนวน ครั้ง หากคุณตาย บทบาทจริงของผู้เล่นที่คุณ เลือกไว้จะถูกเปิดเผยต่อทุกคนทันที (เขาไม่ตาย ตามคุณ)<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },

    "นักล่าหัว": {
        icon: "/images/headhunter.jpg",
        title: "🎯 นักล่าหัว",
        desc: "เมื่อเริ่มเกมคุณจะได้รับการกำหนดเป้าหมาย จุดมุ่งหมายของคุณคือการทำให้เป้าหมายของคุณ ถูกโหวตประหารโดยหมู่บ้านในช่วงระหว่างวัน เงื่อนไขการชนะคือเป้าหมายของคุณจะต้องถูก โหวตประหารก่อนที่คุณจะตาย ถ้าเป้าหมายของ คุณตายด้วยวิธีอื่นคุณจะยังคงเป็นนักล่าหัว แต่ ชนะกับฝ่ายพันธมิตรชั่วร้าย (มนุษย์หมาป่าและนัก ฆ่าเดี่ยว) แทน<br><br>ทีม:เดี่ยว    ลาง:ไม่ทราบ",
    },
    "คนบ้า": {
        icon: "/images/fool.jpg",
        title: "🃏 คนบ้า",
        desc: "เป้าหมายของคุณคือการโดนโหวตประหาร ถ้าทุก คนโหวตประหารคุณ คุณจะชนะทันที<br><br>ทีม:เดี่ยว    ลาง:ไม่ทราบ",
    },
    "ฆาตกรต่อเนื่อง": {
        icon: "/images/serial_killer.jpg",
        title: "🗡️ ฆาตกรต่อเนื่อง",
        desc: "ในแต่ละคืนคุณสามารถฆ่าผู้เล่นได้หนึ่งคน<br><br>ทีม:เดี่ยว    ลาง:ไม่ทราบ",
    },
    "นักเล่นกล": {
        icon: "/images/Illusionist.jpg",
        title: "🎭 นักเล่นกล",
        desc: "ในแต่ละคืน คุณสามารถปลอมบทบาทของผู้เล่นคนหนึ่งได้ โดยผู้เล่นที่ถูกปลอมตัวจะถูกเหล่าผู้หยั่งรู้มองเห็นเป็นนักเล่นกล คุณสามารถฆ่าผู้เล่นทุกคนที่โดนปลอมตัวได้ในช่วงประชุม ผู้เล่นที่ถูกฆ่าจะปรากฏเป็นนักเล่นกลให้ทุกคนเห็น<br><br>ทีม:เดี่ยว    ลาง:ไม่ทราบ",
    },
    "กามเทพ": {
        icon: "/images/cupid.jpg",
        title: "💖 กามเทพ",
        desc: "ในคืนแรก คุณสามารถเลือกผู้เล่นสองคนให้เป็น คู่รักกันได้ หากใครคนใดคนหนึ่งตายอีกคนก็ จะตายตามไปด้วย คุณและผู้เล่นที่เป็นทีมคู่รัก จำเป็นจะต้องพยายามร่วมมือกันเพื่อให้มีชีวิตอยู่ รอดจนกว่าจะจบเกม หากคู่รักของคุณตายคุณ จะสามารถชนะกับชาวบ้านได้ และคุณจำเป็นต้อง ช่วยคู่รักก่อนหากคู่รักยังมีชีวิตรอดอยู่<br><br>ทีม:ชาวบ้าน    ลาง:ไม่ทราบ",
    },
    "ผู้นำลัทธิ": {
        icon: "/images/sect_leader.jpg",
        title: "🔯 ผู้นำลัทธิ",
        desc: "ในแต่ละคืน คุณสามารถเลือกผู้เล่นให้เข้าร่วม ลัทธิของคุณได้ โดยผู้เล่นที่เข้าร่วมลัทธิจะไม่ถูก เปลี่ยนบทบาทเดิมเป็นบทบาทใหม่ แต่จะเปลี่ยน จากทีมเดิมของพวกเขาเป็นทีมลัทธิ หรืออีกทาง หนึ่ง คุณสามารถสังเวยสมาชิกลัทธิหนึ่งคนเพื่อฆ่าผู้เล่นคนอื่น ข้อจำกัดคือคุณสามารถมีสมาชิก ลัทธิที่ยังมีชีวิตอยู่ได้สูงสุด 5 คนในเวลาเดียวกัน และคุณไม่สามารถเปลี่ยนมนุษย์หมาป่าหรือนัก ฆ่าเดี่ยวให้เข้าร่วมลัทธิของคุณได้ คุณสามารถส่ง ข้อความส่วนตัวถึงสมาชิกลัทธิของคุณได้ในตอน กลางวัน สมาชิกลัทธิทั้งหมดจะหลบหนีออกจาก หมู่บ้านหากผู้นำลัทธิได้เสียชีวิตลง<br><br>ทีม:ลัทธิ    ลาง:ไม่ทราบ",
    },
    "ผู้ยุยง": {
        icon: "/images/instigater.jpg",
        get title() { return `<img src="${imgUrl("/images/instigater.jpg")}" class="role-title-icon" alt="ผู้ยุยง"> ผู้ยุยง`; },
        desc: "เมื่อเริ่มเกม ผู้เล่นสองคนจะเข้าร่วมทีมคุณในฐานะ ผู้ศรัทธา: ทีมชาวบ้านหนึ่งคนและทีมหมาป่าหรือบทบาทนักฆ่าเดี่ยว สมาชิกทีมของคุณต้องชนะ ด้วยกันเท่านั้นและจะไม่ใช่ส่วนหนึ่งของทีมเดิมอีก ต่อไป ในฐานะผู้ยุยงคุณสามารถส่งข้อความส่วน ตัวให้กับทีมของคุณได้ วิญญาณของผู้ศรัทธาทั้ง สองจะถูกผูกไว้ด้วยกัน ซึ่งหมายความว่าหากคน ใดคนหนึ่งตายอีกคนก็จะตายตามไปด้วย เมื่อผู้ ศรัทธาทั้งสองตายคุณจะสามารถฆ่าผู้เล่นคนอื่น ด้วยตัวคุณเองได้หนึ่งคนต่อคืน<br><br>ทีม:เดี่ยว    ลาง:ไม่ทราบ",
    },
    "โจร": {
        icon: "/images/bandit.jpg",
        title: "🗡️ โจร",
        desc: "ในคืนที่คุณไม่มีผู้สมรู้ร่วมคิด คุณสามารถเลือกที่ จะเปลี่ยนบทบาทของผู้เล่นคนใดคนหนึ่งให้เป็นผู้ สมรู้ร่วมคิดได้ หากผู้เล่นที่คุณพยายามจะเปลี่ยน เป็นมนุษย์หมาป่า คุณจะฆ่าพวกเขาทันที คุณและ ผู้สมรู้ร่วมคิดสามารถฆ่าผู้เล่นหนึ่งคนในแต่ละคืน ได้ คุณสามารถส่งข้อความส่วนตัวถึงผู้สมรู้ร่วมคิด ของคุณได้ (มีแค่คุณเท่านั้นที่พิมพ์ได้)<br><br>ทีม:โจร    ลาง:ไม่ทราบ",
    },
    "ผู้สมรู้ร่วมคิด": {
        icon: "/images/accomplice.jpg",
        title: "🗡️ ผู้สมรู้ร่วมคิด",
        desc: "คุณถูกโจรเปลี่ยนบทบาทให้กลายเป็นผู้สมรู้ร่วมคิด แล้ว คุณสามารถร่วมมือกับหัวโจรเลือกฆ่าผู้เล่น หนึ่งคนในแต่ละคืนได้ และสามารถอ่านข้อความ ในแชททีมโจรได้ (แต่พิมพ์ไม่ได้ มีแค่หัวโจรเท่านั้น ที่พิมพ์ได้)<br><br>ทีม:โจร    ลาง:ร้าย",
    },
};

// ============================================================
// AURA RESULT — ผลลัพธ์ที่ "ผู้มีลาง" จะเห็นเมื่อส่องแต่ละบทบาท
// ค่านี้ต้องตรงกับคำต่อท้าย "ลาง:..." ที่เขียนไว้ในคำอธิบายแต่ละบทบาทด้านบนเป๊ะๆ
// (single source of truth — แก้ต้องแก้ทั้ง 2 ที่ให้ตรงกันเสมอ)
// ============================================================
const AURA_RESULT = {
    "หมาป่า": "ร้าย",
    "ลูกหมาป่า": "ร้าย",
    "หมาป่าผู้พิทักษ์": "ร้าย",
    "หมาป่าดื้อรั้น": "ไม่ทราบ",
    "หมาป่านักเวท": "ร้าย",
    "หมาป่าหยั่งรู้": "ร้าย",
    "ชาวบ้าน": "ดี",
    "หมอ": "ดี",
    "บอดี้การ์ด": "ดี",
    "อันธพาล": "ดี",
    "หนูน้อยผู้ใสซื่อ": "ดี",
    "ผู้มีลาง": "ดี",
    "ผู้หยั่งรู้": "ดี",
    "นักสืบ": "ดี",
    "ยายขี้โมโห": "ดี",
    "แม่มด": "ไม่ทราบ",
    "ศาลเตี้ย": "ไม่ทราบ",
    "นักบวช": "ไม่ทราบ",
    "นายก": "ดี",
    "เด็กขี้โวยวาย": "ดี",
    "นักล่าหัว": "ไม่ทราบ",
    "คนบ้า": "ไม่ทราบ",
    "ฆาตกรต่อเนื่อง": "ไม่ทราบ",
    "นักเล่นกล": "ไม่ทราบ",
    "กามเทพ": "ไม่ทราบ",
    "ผู้ยุยง": "ไม่ทราบ",
    "ผู้นำลัทธิ": "ไม่ทราบ",
    "โจร": "ไม่ทราบ",
    "ผู้สมรู้ร่วมคิด": "ร้าย",
};

// ผู้ถูกสาป: ลาง "ดีหรือร้าย" ขึ้นอยู่กับว่ากลายร่างเป็นหมาป่าไปแล้วหรือยัง
// ทีมลัทธิ (ผู้นำลัทธิเอง + สมาชิกที่ถูกชักชวนเข้าร่วม): ลาง "ไม่ทราบ" เสมอ ไม่ว่าบทเดิมของสมาชิก
// จะเป็นอะไรก็ตาม (ต้องเช็คก่อนเงื่อนไขอื่นทั้งหมด เพราะสมาชิกลัทธิยังคง role เดิมของตัวเองอยู่)
function getAuraResult(player) {
    if (!player) return "ไม่ทราบ";
    if (isCultLeaderPlayer(player) || isCultMemberPlayer(player)) return "ไม่ทราบ";
    if (player.role === "ผู้ถูกสาป") return player.transformed ? "ร้าย" : "ดี";
    return AURA_RESULT[player.role] || "ไม่ทราบ";
}

// role icon paths ในรายการด้านล่างเป็น same-origin logical paths ใต้ public/images/
// getter ใช้ imgUrl() เพื่อเติม asset version สำหรับ force-reload โดยไม่ใช้ external origin
// จึงไม่ต้องแก้ path ทีละบรรทัดในรายการ roleDescription ด้านบน
// เพื่อให้ ?v=<imageEpoch> ตามทันเมื่อแอดมินกดรีโหลดรูป — spread ({ ...roleDescription[k] }) ใน buildRolesData
// และ JSON ที่ส่งผ่าน socket อ่านค่าผ่าน getter (enumerable) ได้ตามปกติ ผลลัพธ์หน้าตาเหมือนเดิมทุกประการ
Object.values(roleDescription).forEach((r) => {
    if (!r.icon) return;
    const rawIconPath = r.icon;
    Object.defineProperty(r, "icon", {
        get: () => imgUrl(rawIconPath),
        enumerable: true,
        configurable: true,
    });
});

// รวม roles + roleDescription เป็น object เดียว ส่งให้ client ใช้งาน (event: roles_data)
function buildRolesData() {
    const merged = {};
    const keys = new Set([...Object.keys(roles), ...Object.keys(roleDescription)]);
    keys.forEach((key) => {
        merged[key] = { ...(roles[key] || {}), ...(roleDescription[key] || {}) };
    });
    // ส่ง wolfRoles list ไปด้วย ให้ client ใช้ได้โดยไม่ต้อง hardcode
    merged.__wolfRoles = [...WOLF_ROLES];
    // อาชีพที่ "ได้มาจากการเปลี่ยนบทบาทกลางเกมเท่านั้น" ห้ามให้โฮสต์ติ๊กเลือกไว้ตั้งแต่ก่อนเริ่มเกม
    // (ผู้สมรู้ร่วมคิด: เกิดจากโจรเปลี่ยนบทบาทผู้เล่นคนอื่นให้เท่านั้น ไม่มีทางเลือกเป็นบทเริ่มต้นได้)
    // ข้อมูล roleDescription/aura ของบทเหล่านี้ยังต้องส่งไปตามปกติ (ใช้แสดงไอคอน/คำอธิบายตอนถูกเปลี่ยนบทบาทจริง)
    // แค่ไม่ให้ขึ้นเป็นช่องติ๊กในหน้าตั้งค่าห้องเท่านั้น — ดู renderRoles() ฝั่ง host.main.js
    merged.__nonSelectableRoles = [...NON_SELECTABLE_ROLES];
    return merged;
}

function broadcastRoles() {
    io.emit("roles_data", buildRolesData());
}

// ============================================================
// ROOM HELPERS
// ============================================================

function genId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// บั๊ก/ความเสี่ยง: ชื่อผู้เล่น (name) ที่รับจาก client ไม่เคยถูกตรวจสอบชนิด/ความยาวเลยตลอด
// ทั้งไฟล์ — client ส่งอะไรมาก็ถูกเก็บ/ส่งต่อ (broadcast) ให้ทุกคนในห้องตรงๆ ทั้งใน room_update
// และในข้อความแชท (name ของผู้ส่ง) โค้ดฝั่ง client (public/js/host.main.js, player.main.js)
// เอาค่านี้ไปแปะใน innerHTML/onclick ตรงๆ โดยไม่ escape เลย จึงเป็นช่องโหว่ XSS/JS-injection ได้
// (ดูการแก้ escapeHtml ในฝั่ง client ประกอบ) ฟังก์ชันนี้เป็นด่านป้องกันฝั่ง server เพิ่มเติม:
// บังคับให้เป็น string เสมอ, ตัดช่องว่างหัวท้าย, จำกัดความยาวกันชื่อยาวเกินไปจนล้น UI/DB
const PLAYER_NAME_MAX_LENGTH = 24;
// ชื่อชุดนี้สงวนไว้ให้ Player Tester เท่านั้น ทั้งไทยและอังกฤษ:
//   ผู้เล่น / ผู้เล่น1 / ผู้เล่น2 ...
//   Player / Player1 / Player2 ...
// เปรียบเทียบแบบ case-insensitive สำหรับภาษาอังกฤษ และตรวจหลังตัด whitespace แล้ว
// เพื่อกันการเลี่ยงด้วย "Player 1", "P l a y e r1" หรือการ paste ช่องว่างเข้ามา
const RESERVED_TESTER_NAME_RE = /^(?:player|ผู้เล่น)(?:[0-9]+)?$/iu;

function normalizeNameWhitespace(name) {
    if (typeof name !== "string") return "";
    return name.replace(/\s+/gu, "").slice(0, PLAYER_NAME_MAX_LENGTH);
}

function isReservedTesterName(name) {
    return RESERVED_TESTER_NAME_RE.test(normalizeNameWhitespace(name));
}

function assertUserDisplayNameAllowed(name) {
    const normalized = normalizeNameWhitespace(name);
    if (!normalized) throw Object.assign(new Error("ชื่อไม่ถูกต้อง"), { code: "BAD_NAME" });
    if (isReservedTesterName(normalized)) {
        throw Object.assign(new Error("ชื่อนี้สงวนไว้สำหรับ Player Tester"), { code: "NAME_RESERVED" });
    }
    return normalized;
}

function sanitizeName(name, fallback = "ผู้เล่น") {
    if (typeof name !== "string") return fallback;
    const normalized = normalizeNameWhitespace(name);
    return normalized.length ? normalized : fallback;
}

// ตั้งค่าห้องที่โฮสต์กรอกไว้ "ก่อนสร้างห้อง" (หน้า "🛠️ ตั้งค่าห้องก่อนสร้าง" ใน host.html) — ส่งมากับ create_room
// เพื่อให้ห้องถูกสร้างพร้อมค่าเหล่านี้ในครั้งเดียว ไม่มีช่วงที่ห้องมีอยู่แล้วแต่ยังไม่ได้ตั้งรหัส/บทบาท
// (เดิมสร้างห้องปุ๊บ ผู้เล่นเข้าได้ทันทีด้วยโค้ดห้อง ก่อนที่โฮสต์จะทันตั้งค่าอะไร)
// ค่าที่ client ส่งมาไม่เชื่อถือ: ตรวจชนิด/ตัดความยาว/กรองบทที่ไม่มีจริงหรือเลือกไม่ได้ทิ้งเหมือนที่ start_game กันไว้
// ใช้ค่าเริ่มต้นเดียวกับห้องที่เพิ่งสร้างแบบเดิมทุกประการเมื่อไม่ได้ส่งฟิลด์นั้นมา (client รุ่นเก่าไม่ส่ง settings เลยก็ยังทำงานได้)
function sanitizeRoomSettings(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const code = (v) => (typeof v === "string" ? v.trim().slice(0, 20) : "");

    const n = parseInt(s.maxPlayers, 10);
    const maxPlayers = Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0;

    const config = {};
    if (s.config && typeof s.config === "object" && !Array.isArray(s.config)) {
        Object.keys(s.config).forEach((role) => {
            if (role.startsWith("__") || NON_SELECTABLE_ROLES.has(role)) return;
            if (!Object.prototype.hasOwnProperty.call(roles, role)) return;
            const cnt = Math.floor(Number(s.config[role]));
            if (Number.isFinite(cnt) && cnt > 0) config[role] = Math.min(cnt, 99);
        });
    }

    const tc = s.testerConditions && typeof s.testerConditions === "object" ? s.testerConditions : {};
    const testerConditions = Object.fromEntries(WIN_CONDITIONS.map((k) => [k, tc[k] !== false]));

    // เปิดเป็นค่าเริ่มต้นเพื่อรักษาพฤติกรรมเดิมของเกมสำหรับห้องเก่า/ไคลเอนต์รุ่นก่อน:
    // "ตายแล้วเปิดบท" จะทำงานเหมือนเดิมจนกว่าโฮสต์จะปิดเองก่อนเริ่มเกม
    const revealDeadRole = s.revealDeadRole !== false;

    return {
        hostPassword: "", // legacy field retained; host access uses owner tokens only
        joinCode: code(s.joinCode),
        maxPlayers,
        config,
        revealDeadRole,
        testerConditions,
        voteTimerEnabled: s.voteTimerEnabled !== false,
    };
}

// เรียงเลขบอทใหม่ให้ไม่มีช่องว่าง — เรียกทุกครั้งหลังมีบอทถูกลบออกจากห้อง (เตะ) เพื่อให้
// บอทที่เหลือกลายเป็น "บอท 1, บอท 2, บอท 3, ..." ต่อเนื่องกันเสมอ (เดิม: เตะ "บอท 2" ออกจาก
// 1,2,3,4,5 จะเหลือ 1,3,4,5 มีช่องว่างค้าง) เรียงตามลำดับที่ยังอยู่ใน room.players (ลำดับเพิ่ม
// เข้ามาเดิม ไม่ใช่สุ่ม) ไม่กระทบ id/token ของบอท กระทบแค่ชื่อที่แสดงเท่านั้น
function renumberBots(room) {
    let n = 0;
    room.players.forEach((p) => {
        if (!p.isBot) return;
        n += 1;
        p.name = `🤖 บอท ${n}`;
    });
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// หาห้องที่เปิดอยู่ล่าสุดสำหรับแนะนำ ROOM CODE อัตโนมัติ
function getLatestOpenRoom() {
    const ids = Object.keys(rooms);
    if (ids.length === 0) return null;
    const id = ids[ids.length - 1];
    const room = rooms[id];
    if (!room) return null;
    const hostPlayer = room.players.find((p) => p.isHost);
    return {
        roomId: id,
        hostName: hostPlayer ? hostPlayer.name : "",
        playerCount: room.players.filter((p) => !p.isHost).length,
        maxPlayers: room.maxPlayers || 0,
        started: !!room.started,
        totalRooms: ids.length,
        // ให้ client รู้ล่วงหน้าว่าห้องนี้ต้องใช้รหัสเข้าร่วมไหม (โชว์ช่องกรอกรหัสให้ทันที
        // แทนที่จะต้องลอง join_room พลาดก่อนหนึ่งรอบถึงจะรู้)
        hasJoinCode: !!room.joinCode,
    };
}

function broadcastSuggestedRoom() {
    io.emit("suggested_room", getLatestOpenRoom());
}

// รายชื่อห้องที่ยังเปิดอยู่ทั้งหมด ให้หน้าโฮสต์เอาไปแสดงเป็นกริดให้เลือก
function isRoomListable(room) {
    return !!room && !room.isClosing && !roomIdleExpired(room, io.sockets.sockets);
}

function getOpenRoomsList() {
    return Object.keys(rooms).filter((id) => isRoomListable(rooms[id])).map((id) => {
        const room = rooms[id];
        const hostPlayer = room.players.find((p) => p.isHost);
        return {
            roomId: id,
            hostName: hostPlayer ? hostPlayer.name : "",
            hostConnected: hostPlayer ? !hostPlayer.disconnected : false,
            playerCount: room.players.filter((p) => !p.isHost).length,
            maxPlayers: room.maxPlayers || 0, // 0 = ไม่จำกัด
            started: !!room.started,
            hasPassword: !!room.hostPassword, // ไม่ส่งค่ารหัสจริง แค่บอกว่าห้องนี้ล็อกไว้หรือไม่ ให้กริดโชว์ 🔒
            hasJoinCode: !!room.joinCode, // เช่นกัน — แค่บอกว่าตั้งรหัสฝั่งผู้เล่นไว้หรือไม่
        };
    });
}

// รายชื่อห้องที่ยังเปิดอยู่ทั้งหมด ให้หน้าผู้เล่นเอาไปแสดงเป็นกริดให้เลือกตอนมีหลายห้อง
// พร้อมกัน (คู่กับ getOpenRoomsList ด้านบนที่ใช้ฝั่งโฮสต์) — ตัด hasPassword (รหัสผ่านกันแอดมิน
// แย่งคุม ไม่เกี่ยวกับผู้เล่น) และ hostConnected ออก เหลือแค่ข้อมูลที่ผู้เล่นต้องใช้ตัดสินใจเลือกห้องจริงๆ
function getOpenRoomsListForPlayers() {
    return Object.keys(rooms).filter((id) => isRoomListable(rooms[id])).map((id) => {
        const room = rooms[id];
        const hostPlayer = room.players.find((p) => p.isHost);
        return {
            roomId: id,
            hostName: hostPlayer ? hostPlayer.name : "",
            playerCount: room.players.filter((p) => !p.isHost).length,
            maxPlayers: room.maxPlayers || 0, // 0 = ไม่จำกัด
            started: !!room.started,
            hasJoinCode: !!room.joinCode, // บอกผู้เล่นล่วงหน้าว่าห้องนี้ต้องกรอกรหัสห้องไหม
        };
    });
}

// ============================================================
// RECONNECT HELPERS
// ============================================================

// เมื่อผู้เล่นเชื่อมต่อใหม่ด้วย socket id ใหม่ ต้องอัปเดต id เดิม
// ที่ฝังอยู่ในโหวต/เป้าหมายต่างๆ ให้กลายเป็น id ใหม่ ไม่ให้ข้อมูลหาย
function remapPlayerId(room, oldId, newId) {
    if (oldId === newId) return;

    const maps = [
        room.votes,
        room.selectedTargets,
        room.wolfKillVotes,
        room.shieldTargets,
        room.curseTargets,
        room.continueReady,
        room.banditKillVotes,
    ];

    // murdererKillVote
    if (room.murdererKillVote) {
        if (room.murdererKillVote.voterId === oldId) room.murdererKillVote.voterId = newId;
        if (room.murdererKillVote.targetId === oldId) room.murdererKillVote.targetId = newId;
    }

    // instigatorKillVote (สิทธิ์ฆ่าเองของผู้ยุยงหลังผู้ศรัทธาทั้งสองตาย — ดู cast_instigator_kill)
    if (room.instigatorKillVote) {
        if (room.instigatorKillVote.voterId === oldId) room.instigatorKillVote.voterId = newId;
        if (room.instigatorKillVote.targetId === oldId) room.instigatorKillVote.targetId = newId;
    }

    // cultActions (การเลือกของผู้นำลัทธิที่ "เลือกไว้ก่อน" รอสรุปผลตอน resolve_night — ดู performCultAction)
    // เก็บด้วย key = leaderId เหมือน room.selectedTargets แต่ value เป็น object {mode,targetId,sacrificeId}
    // ไม่ใช่ id เดี่ยวๆ เลยต้อง remap เองแยกจาก `maps` ทั่วไปด้านล่าง
    if (room.cultActions) {
        if (oldId in room.cultActions) {
            room.cultActions[newId] = room.cultActions[oldId];
            delete room.cultActions[oldId];
        }
        Object.values(room.cultActions).forEach((action) => {
            if (!action) return;
            if (action.targetId === oldId) action.targetId = newId;
            if (action.sacrificeId === oldId) action.sacrificeId = newId;
        });
    }

    // cultChatHistory (ประวัติแชทลัทธิ แยกรายกลุ่ม เก็บด้วย key = leaderId เหมือน instigatorChatHistory)
    if (room.cultChatHistory && oldId in room.cultChatHistory) {
        room.cultChatHistory[newId] = room.cultChatHistory[oldId];
        delete room.cultChatHistory[oldId];
    }

    // banditActions (การเลือกของหัวโจรที่ "เลือกไว้ก่อน" รอสรุปผลตอน resolve_night — ดู performBanditAction)
    // เก็บด้วย key = leaderId เหมือน room.cultActions แต่ value เป็น object {targetId} เท่านั้น
    if (room.banditActions) {
        if (oldId in room.banditActions) {
            room.banditActions[newId] = room.banditActions[oldId];
            delete room.banditActions[oldId];
        }
        Object.values(room.banditActions).forEach((action) => {
            if (!action) return;
            if (action.targetId === oldId) action.targetId = newId;
        });
    }

    // banditChatHistory (ประวัติแชททีมโจร แยกรายกลุ่ม เก็บด้วย key = leaderId เหมือน cultChatHistory)
    if (room.banditChatHistory && oldId in room.banditChatHistory) {
        room.banditChatHistory[newId] = room.banditChatHistory[oldId];
        delete room.banditChatHistory[oldId];
    }

    // แก้บั๊ก: room.pendingLoverPair/pendingInstigatorPair (ดู performCupidPair/performInstigatorPair
    // และ resolve_night) เก็บ selectorId/targetAId/targetBId เป็น socket.id ไว้ชั่วคราวระหว่างรอเช้า
    // มาสรุปผล — ถ้ากามเทพ/ผู้ยุยง/เป้าหมายที่ถูกเลือกไว้ "หลุดแล้ว reconnect" (หรือถูกเข้าสิงใหม่)
    // ก่อนถึงเช้า id เดิมที่ค้างอยู่ในนี้จะไม่ตรงกับ id ใหม่อีกต่อไป ทำให้ resolve_night หาตัวไม่เจอ
    // (selector/targetA/targetB เป็น undefined) และข้ามการจับคู่ทั้งคู่ไปเงียบๆ โดยไม่แจ้งใครเลย
    [room.pendingLoverPair, room.pendingInstigatorPair].forEach((pending) => {
        if (!pending) return;
        if (pending.selectorId === oldId) pending.selectorId = newId;
        if (pending.targetAId === oldId) pending.targetAId = newId;
        if (pending.targetBId === oldId) pending.targetBId = newId;
    });

    maps.forEach((map) => {
        if (!map) return;
        // อัปเดต key ก่อน (คนที่เป็นคน "เลือก")
        if (oldId in map) {
            map[newId] = map[oldId];
            delete map[oldId];
        }
        // อัปเดต value (คนที่ถูกเลือก)
        Object.keys(map).forEach((key) => {
            if (map[key] === oldId) map[key] = newId;
        });
    });

    room.players.forEach((p) => {
        if (p.huntTargetId === oldId) p.huntTargetId = newId;

        // แก้บั๊ก: roleRevealMutualWith เก็บ socket.id ของอีกฝ่ายไว้ (เช่น อันธพาล<->ผู้โจมตี,
        // ศาลเตี้ย<->อันธพาล) พอฝ่ายใดฝ่ายหนึ่งหลุดแล้ว reconnect กลับมา id จะเปลี่ยน ทำให้
        // อีกฝ่ายที่ id ยังไม่เปลี่ยนหาไม่เจอ (และตัวเองก็หาอีกฝ่ายไม่เจอถ้าเขาก็เพิ่งเปลี่ยน id มาก่อน)
        // เลยเห็นบทบาทกันไม่ได้เหมือนเดิม ต้อง remap id เก่า -> ใหม่ในทุก array นี้ด้วย
        if (Array.isArray(p.roleRevealMutualWith)) {
            p.roleRevealMutualWith = p.roleRevealMutualWith.map((id) => (id === oldId ? newId : id));
        }

        // ผู้ยุยง/คู่ที่ถูกจับ: p.instigatorLinkId เก็บ socket.id ของอีกฝ่ายไว้เหมือนกัน ต้อง remap ด้วยเหตุผลเดียวกัน
        if (p.instigatorLinkId === oldId) p.instigatorLinkId = newId;

        // ผู้นำลัทธิ/สมาชิกลัทธิ: p.cultLeaderId เก็บ socket.id ของผู้นำลัทธิที่สังกัดไว้ ต้อง remap
        // ด้วยเหตุผลเดียวกัน (ไม่งั้นพอผู้นำลัทธิหรือสมาชิกหลุดแล้ว reconnect กลับมา จะเช็คกลุ่มลัทธิ
        // เดียวกันผิดพลาด ทั้งเรื่องแชทลัทธิ, aura, effectiveTeam, และ detective_scout)
        if (p.cultLeaderId === oldId) p.cultLeaderId = newId;

        // โจร/ผู้สมรู้ร่วมคิด: p.banditLeaderId เก็บ socket.id ของหัวโจรที่เปลี่ยนบทบาทตนไว้เหมือนกัน
        // ต้อง remap ด้วยเหตุผลเดียวกันทุกประการ (แชททีมโจร, aura, effectiveTeam, และ detective_scout)
        if (p.banditLeaderId === oldId) p.banditLeaderId = newId;

        // กามเทพ/คู่รัก: p.loverId เก็บ socket.id ของคู่รักอีกฝ่ายไว้เหมือนกัน ต้อง remap ด้วยเหตุผลเดียวกัน
        // ไม่งั้นพอฝ่ายใดฝ่ายหนึ่งหลุดแล้ว reconnect กลับมา คู่รักจะหากันไม่เจอ (ทั้งเรื่องเห็นบทบาทกัน
        // และเรื่องตายตามกัน)
        if (p.loverId === oldId) p.loverId = newId;

        // แก้บั๊ก: อีก 5 field ที่เก็บ socket.id ของคนอื่นไว้เหมือนกัน แต่ตกหล่นไม่เคย remap มาก่อน —
        // ทำให้พอฝ่ายที่ถูกอ้างอิงอยู่ (ไม่ใช่ตัว p เอง) หลุดแล้ว reconnect กลับมา (เช่น กด "เข้าสิง"
        // บอทที่เป็นกามเทพ/ผู้ยุยง/หมอ/แม่มด หรือคนที่เคยถูกจับคู่/ถูกส่อง/ถูกวางยา) ค่าที่เก็บ id เก่า
        // ไว้จะหาตัวจริงไม่เจออีกต่อไป (เทียบ id เก่ากับ id ใหม่ของอีกฝ่ายไม่ตรงกัน):
        //   - cupidPairTargetIds / instigatorPairTargetIds: id คู่ที่กามเทพ/ผู้ยุยงจับไว้ (โชว์ไอคอนคู่บนการ์ด)
        //   - instigatorGroupId: id ของผู้ยุยงที่ใช้เทียบ "ทีมเดียวกัน" ตอนนักสืบส่อง
        //   - killedByPlayerId: id ฆาตกรต่อเนื่องตัวจริงที่ลงมือ (ใช้แจ้งผลส่วนตัว)
        //   - witchPoisonCasterId: id แม่มดที่วางยา (ใช้ตอนสรุปผล/แจ้งเตือน)
        if (Array.isArray(p.cupidPairTargetIds)) {
            p.cupidPairTargetIds = p.cupidPairTargetIds.map((id) => (id === oldId ? newId : id));
        }
        if (Array.isArray(p.instigatorPairTargetIds)) {
            p.instigatorPairTargetIds = p.instigatorPairTargetIds.map((id) => (id === oldId ? newId : id));
        }
        if (p.instigatorGroupId === oldId) p.instigatorGroupId = newId;
        if (p.killedByPlayerId === oldId) p.killedByPlayerId = newId;
        if (p.witchPoisonCasterId === oldId) p.witchPoisonCasterId = newId;
    });

    if (room.host === oldId) room.host = newId;
}

// ============================================================
// DEATH / CLEANUP HELPERS
// ============================================================

// เปิดเผยบทบาทของ player คนนี้ให้ "ทุกคน" เห็นไอคอนอาชีพในกริดผู้เล่นถาวร (ใช้ตอนตาย/เปิดตัวเอง)
function revealRolePublic(player) {
    if (!player) return;
    player.roleRevealPublic = true;
}

// กฎกลางของห้อง: ถ้าเปิด "แสดงบทคนตาย" ให้เปิดบทของผู้เล่นที่ตายจริงทุกคนในกริดสาธารณะ
// เรียกจาก cleanupAfterDeath() เพื่อครอบคลุมการตายปกติและการตายแบบลาก/ตายตามคู่ด้วยจุดเดียว
// แต่ยังไม่ไปลบ/ปิดการเปิดบทจากสกิลที่ตั้งใจเปิดบทเอง (ศาลเตี้ย/นักบวช/เด็กขี้โวยวาย/นายก ฯลฯ)
function revealDeadRoleIfEnabled(room, player) {
    if (!room || !player) return;
    if (room.revealDeadRole !== false) revealRolePublic(player);
}

// เปิดเผยบทบาทระหว่าง 2 คนแบบส่วนตัว (รู้กันแค่สองฝ่ายนี้ เห็นไอคอนอาชีพของกันและกันในกริด
// เฉพาะตอนที่ตัวเองล็อกอินอยู่ — คนอื่นในห้องจะไม่เห็นเลย)
function revealRoleMutual(playerA, playerB) {
    if (!playerA || !playerB || playerA.id === playerB.id) return;
    playerA.roleRevealMutualWith = playerA.roleRevealMutualWith || [];
    playerB.roleRevealMutualWith = playerB.roleRevealMutualWith || [];
    if (!playerA.roleRevealMutualWith.includes(playerB.id)) playerA.roleRevealMutualWith.push(playerB.id);
    if (!playerB.roleRevealMutualWith.includes(playerA.id)) playerB.roleRevealMutualWith.push(playerA.id);
}

// ผู้ยุยง: เช็คว่า "ผู้ศรัทธา" ทั้งสองคนที่ถูกจับคู่ไว้ตายครบทั้งคู่แล้วหรือยัง — ถ้าใช่ ผู้ยุยงจะปลดล็อก
// สิทธิ์ฆ่าผู้เล่นคนอื่นด้วยตัวเองได้เอง 1 คนต่อคืน (ดูคำอธิบายบทบาทผู้ยุยง + cast_instigator_kill)
function instigatorBelieversBothDead(room, player) {
    if (!player || !Array.isArray(player.instigatorPairTargetIds) || player.instigatorPairTargetIds.length !== 2) {
        return false;
    }
    return player.instigatorPairTargetIds.every((id) => {
        const believer = room.players.find((p) => p.id === id);
        return believer && !believer.alive;
    });
}

// ============================================================
// ลำดับข้อความแชท (chatSeq) — แก้บั๊ก "ออกเข้าใหม่แล้วแชทเรียงลำดับไม่เหมือนเดิม"
// ============================================================
// เดิมข้อความ "แชทรวม" (globalChatHistory) กับข้อความ "private" (privateChatLog ต่อคน /
// hostPrivateChatLog) ถูกเก็บคนละ array กัน ตอนเล่นสดๆ ข้อความจะโผล่ในกล่องแชทตามลำดับเวลาจริงที่
// เกิดขึ้น (เพราะยิง "chat_message" ทีละข้อความสดๆ) แต่พอออกจากห้อง/รีเฟรช/สลับแอปแล้ว sync ใหม่
// (join_room reconnect, request_sync, host_login) ฝั่งเซิร์ฟเวอร์จะส่ง global_chat_history ทั้งก้อน
// ก่อน (เคลียร์กล่องแล้วเรนเดอร์ข้อความรวมทั้งหมดตามลำดับ array เดิม) แล้วค่อยส่ง
// private_chat_history ตามหลัง (ต่อท้ายเข้าไปท้ายกล่องเสมอ) ผลคือข้อความ private ที่จริงๆ "แทรกกลาง"
// ระหว่างข้อความรวมตอนเล่นสด (เช่น "คุณตกหลุมรักกับ..." ที่เกิดพร้อมๆ กับประกาศเช้า) กลับถูกเลื่อนไป
// กองอยู่ท้ายกล่องเสมอทุกครั้งที่ sync ใหม่ — ไม่ตรงกับลำดับที่เห็นตอนเล่นสดครั้งแรก
//
// วิธีแก้: ประทับเลขลำดับ (seq) ที่ "นับรวมกันทั้งห้อง" ให้ทุกข้อความ "แชทรวม" และ "private" ตอนที่
// เกิดขึ้นจริง (ไม่ใช่คำนวณสดจากอะไรทีหลัง) แล้วตอน sync ให้รวมสอง array เข้าด้วยกันแล้ว sort ตาม seq
// ก่อนส่งกลับไปให้ client เรนเดอร์ทีเดียว — รับประกันว่าลำดับที่เห็นตอน sync ใหม่จะตรงกับลำดับเวลาจริง
// ที่ข้อความเกิดขึ้นเป๊ะๆ เหมือนตอนเล่นสด ไม่ว่าจะออกเข้าใหม่กี่รอบก็ตาม
function nextChatSeq(room) {
    room.chatSeq = (room.chatSeq || 0) + 1;
    return room.chatSeq;
}

// ใช้แทน room.globalChatHistory.push(msg) ตรงๆ ทุกจุด เพื่อประทับ seq ให้ข้อความแชทรวมทุกข้อความเสมอ
function pushGlobalChat(room, msg) {
    msg.seq = nextChatSeq(room);
    room.globalChatHistory = room.globalChatHistory || [];
    room.globalChatHistory.push(msg);
}

// รวมประวัติ "แชทรวม" + "private เฉพาะคนนี้/โฮสต์" เป็นไทม์ไลน์เดียวเรียงตาม seq จริง — ใช้แทนการส่ง
// global_chat_history แล้วค่อยส่ง private_chat_history แยกทีหลัง (ดูคอมเมนต์ด้านบน)
function mergedGlobalAndPrivateHistory(room, privateList) {
    const global = room.globalChatHistory || [];
    const priv = privateList || [];
    return [...global, ...priv].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

// ส่งข้อความแชทแบบ private (ให้เห็นคนเดียว) และเก็บ log ไว้ต่อผู้เล่นด้วย (คีย์ด้วย token ที่ไม่เปลี่ยน
// ตอน reconnect ต่างจาก socket.id) — แก้บั๊ก: เดิมข้อความ private ส่งสดๆ ทางเดียวไม่มีการเก็บไว้เลย
// พอผู้เล่นหลุดแล้วโหลดหน้าใหม่ ตอน reconnect global_chat_history จะเคลียร์กล่องแชทรวมแล้วเติมกลับ
// เฉพาะข้อความสาธารณะ ทำให้ข้อความ private (เช่น "เมื่อคืนคุณถูกโจมตีโดย...") ที่เคยเห็นหายไปทันที
// targetIdOrPlayer รับได้ทั้ง player object (มี .id) หรือ socket id ตรงๆ (เช่นจาก privateBiteMessages)
function sendPrivateChat(room, targetIdOrPlayer, msg) {
    const targetId = typeof targetIdOrPlayer === "string" ? targetIdOrPlayer : targetIdOrPlayer?.id;
    if (!targetId) return;
    msg.seq = nextChatSeq(room); // ประทับลำดับเดียวกับแชทรวม เพื่อ merge เรียงลำดับตอน sync ได้ถูกต้อง
    io.to(targetId).emit("chat_message", msg);

    // เป้าหมายคือ "ห้องโฮสต์" (เช่นข้อความ [โฮสต์เท่านั้น]) ไม่ใช่ผู้เล่นคนใดคนหนึ่ง — เก็บ log
    // แยกไว้ต่างหาก ไม่ผูกกับ token ของผู้เล่น เพราะจอโฮสต์ (หลายจอพร้อมกันได้) ไม่มี token ต่อคนแบบผู้เล่น
    // แก้บั๊ก: เดิมข้อความพวกนี้ (เช่น "คืออันธพาล รอดจากการโจมตีของ...") ไม่ถูกเก็บไว้เลย
    // พอจอโฮสต์หลุดแล้ว login กลับมาใหม่ ข้อความที่พลาดไปตอนออฟไลน์จะหายไปถาวร
    if (room.id && targetId === hostRoomName(room.id)) {
        room.hostPrivateChatLog = room.hostPrivateChatLog || [];
        room.hostPrivateChatLog.push(msg);
        if (room.hostPrivateChatLog.length > 100) {
            room.hostPrivateChatLog.shift();
        }
        return;
    }

    const player = room.players.find((pl) => pl.id === targetId);
    if (!player) return;
    room.privateChatLog = room.privateChatLog || {};
    room.privateChatLog[player.token] = room.privateChatLog[player.token] || [];
    room.privateChatLog[player.token].push(msg);
    if (room.privateChatLog[player.token].length > 100) {
        room.privateChatLog[player.token].shift(); // กันโตไม่หยุด เก็บแค่ 100 ข้อความหลังสุดต่อคน
    }
}

// ============================================================
// หมาป่านักเวท — คำนวณสถานะ "ถูกร่ายเวท" ใหม่ทั้งหมดจาก room.curseTargets
// เรียกใช้ตอนเข้าสู่กลางคืน (beginNight) เพื่อให้คำสาปเริ่มมีผลจริง และเรียกซ้ำเมื่อมีการเปลี่ยนแปลง
// ที่อาจกระทบระหว่างคืนนั้น (หมาป่านักเวทตาย, เป้าตาย) เพื่อให้ "wizardCursed" ตรงกับเป้าที่เลือกไว้
// อยู่เสมอ — ตอนกลางวันตอนที่เลือกเป้ายังไม่มีผลใดๆ (ดู select_curse_target)
// ============================================================
function recomputeWizardCurses(room) {
    room.players.forEach((p) => { p.wizardCursed = false; });
    if (!room.curseTargets) return;
    Object.entries(room.curseTargets).forEach(([wizId, targetId]) => {
        const wiz = room.players.find((p) => p.id === wizId);
        if (!wiz || !wiz.alive || wiz.role !== "หมาป่านักเวท") return;
        const target = room.players.find((p) => p.id === targetId);
        if (!target || target.isHost || !target.alive) return;
        target.wizardCursed = true;
    });
}

// ผู้เล่นที่จะเอามาสุ่มแทนคู่รักที่ตายไปก่อนความสัมพันธ์จะเริ่ม (ดู reassignFreshLoverPair ด้านล่าง)
// เลือกคนที่ยังไม่มีคู่รักก่อนเป็นอันดับแรก (กันจับคู่ซ้อนคู่เดิม) ถ้าไม่มีเหลือค่อยยอมรับคนที่มีคู่แล้ว
function pickReplacementLoverFor(room, excludeIds) {
    const alivePool = room.players.filter((p) => p.alive && !p.isHost && !excludeIds.includes(p.id));
    const preferred = alivePool.filter((p) => !p.loverId);
    const pool = preferred.length > 0 ? preferred : alivePool;
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
}

// แก้บั๊ก/ปรับพฤติกรรมตามคำขอ: เดิมถ้ากามเทพจับคู่ 1 กับ 2 ไว้ แล้ว 2 ดันตายไปคืนเดียวกันนั้นเอง (เช่น
// โดนหมาป่ากัด) ก่อนที่ทั้งคู่จะรู้ตัวด้วยซ้ำว่าถูกจับคู่กัน กลไก "ตายตามคู่รัก" ด้านบนจะทำให้ 1 ตายตาม
// 2 ไปทันทีตั้งแต่คืนแรกที่เพิ่งถูกจับคู่ ทั้งที่ยังไม่เคยได้ "เป็นคู่รักกันจริงๆ" เลยสักคืน — ไม่ยุติธรรม
// กับผู้เล่นคนที่รอด (1) เปลี่ยนเป็น: ถ้าคู่ที่เพิ่งถูกจับคืนนี้เอง (ดู room._freshLoverPairsThisResolve
// ที่ resolve_night ตั้งไว้ตอนสรุปผล cupid_pair) มีฝ่ายใดฝ่ายหนึ่งตายไปก่อน ให้สุ่มจับคู่ใหม่ให้ฝ่ายที่รอด
// กับผู้เล่นคนอื่นแทน โดยไม่ตายตามไปด้วย — เฉพาะคืนที่เพิ่งจับคู่เท่านั้น คืนถัดๆ ไปที่ความสัมพันธ์เริ่มแล้ว
// ยังคงตายตามกันตามกลไกเดิมทุกประการ
function reassignFreshLoverPair(room, freshPair, survivor, deadPartner) {
    survivor.loverId = null;
    const selector = room.players.find((p) => p.id === freshPair.selectorId);
    const replacement = pickReplacementLoverFor(room, [survivor.id, deadPartner.id]);

    if (!replacement) {
        // ไม่มีใครเหลือให้จับคู่ใหม่ได้จริงๆ (ผู้เล่นเหลือน้อยเกินไป) — ปล่อยให้ survivor ไม่มีคู่ต่อไป
        if (selector) selector.cupidPairTargetIds = null;
        return;
    }

    survivor.loverId = replacement.id;
    replacement.loverId = survivor.id;
    revealRoleMutual(survivor, replacement);
    // กันไม่ให้ replacement ถูกจับคู่ใหม่ซ้อนอีกทีถ้าเผลอตายในลูปเดียวกันนี้อีก (เช่นโดนยาพิษด้วย)
    freshPair.aId = survivor.id;
    freshPair.bId = replacement.id;

    if (selector) {
        selector.lastCupidPairText = `${survivor.name} × ${replacement.name}`;
        selector.cupidPairTargetIds = [survivor.id, replacement.id];
    }

    sendPrivateChat(room, survivor.id, {
        name: "เกม",
        text: `💘 คู่ที่กามเทพจับไว้แต่แรก (${deadPartner.name}) เสียชีวิตไปก่อนที่ความสัมพันธ์จะเริ่มต้น กามเทพจึงจับคู่คุณกับ ${replacement.name} แทน คุณจะต้องช่วยกันเพื่อให้ชนะทีมคู่รัก หากอีกฝ่ายตายคุณจะตายด้วย`,
        type: "private",
        isSystem: true,
    });
    sendPrivateChat(room, replacement.id, {
        name: "เกม",
        text: `💘กามเทพได้จับคู่คุณกับ ${survivor.name} คุณจะต้องช่วยกันเพื่อให้ชนะทีมคู่รัก หากอีกฝ่ายตายคุณจะตายด้วย`,
        type: "private",
        isSystem: true,
    });
    if (selector) {
        sendPrivateChat(room, selector.id, {
            name: "เกม",
            text: `💘 ${deadPartner.name} ที่คุณจับคู่ไว้เสียชีวิตไปเมื่อคืนก่อนจะกลายเป็นคู่จริง ระบบเลยสุ่มจับคู่ ${survivor.name} กับ ${replacement.name} แทนให้อัตโนมัติ`,
            type: "private",
            isSystem: true,
        });
    }
}

// ลบ "เล็งเป้าหมาย" ที่ค้างอยู่บนผู้เล่นที่ตายแล้ว
// คืนค่า array ของ { victim, by } สำหรับคนที่ตายตามไปด้วย (cascade)
// freshLoverPairs (ไม่บังคับส่ง): array ของคู่กามเทพที่เพิ่ง "กลายเป็นคู่จริง" ในการสรุปผลรอบนี้เอง
// (ตั้งค่าจาก resolve_night เท่านั้น — ดู reassignFreshLoverPair ด้านบน) ใช้เช็คว่าจะปล่อยให้คู่รัก
// ตายตามกันตามปกติ หรือจะสุ่มจับคู่ใหม่ให้แทนเพราะเพิ่งจับคู่กันคืนนี้เอง

// การหนีออกจากเกมกลางเกม = ตายทันที แต่เป็น "การตายแบบถอนตัว" ที่ไม่ทำให้เอฟเฟกต์การตาย
// เดิมของบทบาทอื่นทำงานต่อ เช่น คู่รัก/คู่ยุยง/ลูกหมาป่า/ผู้นำลัทธิไม่ลากคนอื่นตายตาม
// หลักสำคัญคือถอนเฉพาะเอฟเฟกต์ที่ผู้เล่นคนนี้เป็นเจ้าของ/กำลังมีผลแบบยกเลิกได้
// แต่คงสถานะที่ผู้ใช้กำหนดว่า "ติดแล้ว" ไว้: คู่รัก, คู่ยุยง, ผู้สมรู้ร่วมคิด และคำสาป
// ของหมาป่านักเวทที่ติดตั้งไปแล้วเมื่อเข้าสู่กลางคืน รวมถึงสถานะผู้ถูกสาปที่กลายเป็นหมาป่าแล้ว
function cleanupAfterVoluntaryLeaveDeath(room, player) {
    if (!room || !player) return;

    // 1) ไม่ให้เอฟเฟกต์การป้องกัน/การเลือกเป้าของคนที่หนีค้างอยู่ในเกม
    const protectRoles = new Set(["หมอ", "บอดี้การ์ด", "แม่มด"]);
    if (room.selectedTargets) {
        Object.keys(room.selectedTargets).forEach((selectorId) => {
            const targetId = room.selectedTargets[selectorId];
            if (selectorId === player.id) {
                const selector = room.players.find((p) => p.id === selectorId);
                const target = room.players.find((p) => p.id === targetId);
                if (selector && target && protectRoles.has(selector.role)) target.protected = false;
                delete room.selectedTargets[selectorId];
                return;
            }
            if (targetId === player.id) delete room.selectedTargets[selectorId];
        });
    }

    if (room.shieldTargets) {
        Object.keys(room.shieldTargets).forEach((selectorId) => {
            if (selectorId === player.id || room.shieldTargets[selectorId] === player.id) {
                delete room.shieldTargets[selectorId];
            }
        });
    }

    // 2) นักเล่นกลที่หนี: ถอนรายชื่อคนที่ปลอมบทไว้ทั้งหมด และคืนสถานะปลอมบทให้เป้าหมาย
    //    คนที่ถูกปลอมบทหนี/ตายอยู่แล้วก็ไม่ควรเหลือ flag ค้าง
    const ownedIllusions = Array.isArray(player.illusionTargetIds) ? player.illusionTargetIds.slice() : [];
    ownedIllusions.forEach((targetId) => {
        const target = room.players.find((p) => p.id === targetId);
        if (target) target.illusionDisguised = false;
    });
    player.illusionTargetIds = [];
    room.players.forEach((p) => {
        if (p.id !== player.id && Array.isArray(p.illusionTargetIds) && p.illusionTargetIds.includes(player.id)) {
            p.illusionTargetIds = p.illusionTargetIds.filter((id) => id !== player.id);
        }
        if (p.id === player.id) p.illusionDisguised = false;
    });

    // 3) ลัทธิ: ไม่ให้การหนีของผู้นำทำให้สมาชิกตายตาม แต่สมาชิกทุกคนต้องกลับไปทีมเดิมทันที
    //    เพราะ cultLeaderId เป็นตัวเดียวที่เปลี่ยน effectiveTeam โดยไม่เปลี่ยน role เดิม
    if (isCultLeaderPlayer(player)) {
        room.players.forEach((member) => {
            if (member.cultLeaderId === player.id) member.cultLeaderId = null;
        });
        if (room.cultActions) delete room.cultActions[player.id];
        if (room.cultChatHistory) delete room.cultChatHistory[player.id];
    } else if (isCultMemberPlayer(player)) {
        player.cultLeaderId = null;
    }

    // 4) ผู้สมรู้ร่วมคิด: ห้ามล้าง banditLeaderId เพราะเป็นสถานะบทบาทที่เปลี่ยนจริง
    //    (ผู้สมรู้ร่วมคิดยังคงเป็นผู้สมรู้ร่วมคิดในข้อมูลรอบนั้นแม้ตาย/หนี)
    //    คู่รักและคู่ยุยงก็ไม่ล้าง link เช่นกัน ตามกติกาที่กำหนด
    //    player.loverId / player.instigatorLinkId จึงจงใจไม่แตะต้อง

    // 5) คำสาปของหมาป่านักเวท: ถ้าเข้าสู่กลางคืนแล้ว wizardCursed ติดไปแล้ว ให้คงไว้
    //    แม้ผู้ร่ายจะหนีออกจากเกม เพราะผลถูกติดตั้งไปแล้วและควรมีผลต่อการส่องจนจบรอบคืน
    //    ถ้ายังเป็นกลางวันอยู่ คำสาปยังไม่ active จึงล้าง selection ที่ยังไม่ติดตั้งได้
    if (!room.isNight && room.curseTargets) {
        delete room.curseTargets[player.id];
    }

    // ไม่เรียก recomputeWizardCurses() ที่นี่โดยตั้งใจ เพราะจะทำลายคำสาปที่ติดไปแล้วในคืนปัจจุบัน
    // และไม่เรียก cleanupAfterDeath() เพราะนั่นคือ pipeline "ตายตาม" ที่ผู้หนีต้องไม่กระตุ้น
}

function cleanupAfterDeath(room, player, freshLoverPairs) {
    const cascadeDeaths = [];
    if (player && !player.isHost) {
        recordRoomTimeline(room, "player_died", { source: "game", label: String(player.name || "ผู้เล่น").slice(0, 80) });
    }
    const protectRoles = ["หมอ", "บอดี้การ์ด", "แม่มด"];

    // การตายทุกชนิดที่เข้าผ่าน cleanup นี้ใช้กฎเดียวกัน: ถ้าโฮสต์เปิดการตั้งค่าไว้ ให้เปิดบท
    // ทันทีที่ตาย; ถ้าปิดไว้ จะไม่สร้าง roleRevealPublic เพิ่มขึ้นเอง
    revealDeadRoleIfEnabled(room, player);

    // กามเทพ/คู่รัก: ถ้าฝ่ายใดฝ่ายหนึ่งในคู่รักตาย อีกฝ่ายจะเสียใจตายตามไปด้วยทันที (ไม่ว่าฝ่ายแรก
    // จะตายด้วยสาเหตุอะไรก็ตาม — หมาป่ากัด/โหวตประหาร/ยาพิษ/ฯลฯ) เช็คก่อนเงื่อนไขอื่นทั้งหมดในฟังก์ชันนี้
    // อีกฝ่ายที่ตายตามจะถูกเรียก cleanupAfterDeath ซ้ำแบบ recursive ด้วย (เผื่อฝ่ายนั้นมีสกิลตาย-แล้ว-
    // มีผลอื่นต่อ เช่น ลูกหมาป่าที่ลากเป้าไว้) ปลอดภัยจาก infinite loop เพราะ player.alive ถูกตั้งเป็น
    // false ไปแล้วก่อนเรียกฟังก์ชันนี้เสมอ (ดูทุก call site) ทำให้เช็ค partner.alive ฝั่งตรงข้ามจะเจอ
    // ตัวเองเป็น false แล้ว ไม่วนกลับมาซ้ำ
    if (player.loverId) {
        const partner = room.players.find((p) => p.id === player.loverId);
        if (partner && partner.alive) {
            const freshPair = Array.isArray(freshLoverPairs) && freshLoverPairs.find((fp) =>
                (fp.aId === player.id && fp.bId === partner.id) || (fp.bId === player.id && fp.aId === partner.id)
            );
            if (freshPair) {
                // เพิ่งจับคู่กันคืนนี้เอง — ไม่ให้ตายตามกัน สุ่มจับคู่ใหม่ให้ผู้รอดแทน (ดูคอมเมนต์ด้านบน)
                reassignFreshLoverPair(room, freshPair, partner, player);
            } else {
                partner.alive = false;
                cascadeDeaths.push({ victim: partner, by: player, loverDeath: true });
                cascadeDeaths.push(...cleanupAfterDeath(room, partner, freshLoverPairs));
            }
        }
    }

    // ผู้ยุยง/คู่ที่ถูกจับ: ทำงานแบบเดียวกับกามเทพ/คู่รัก — ถ้าฝ่ายใดฝ่ายหนึ่งของคู่ที่ผู้ยุยงจับไว้ตาย
    // อีกฝ่ายจะตายตามไปด้วยทันที (ไม่ว่าฝ่ายแรกจะตายด้วยสาเหตุอะไรก็ตาม) เช็คแยกจาก loverId ข้างบน
    // เพราะเป็นคนละกลไกกัน (ห้องที่มีทั้งกามเทพและผู้ยุยงอยู่ด้วยกันจะไม่ชนกัน) — ยังคงตายตามกันเสมอ
    // ไม่ว่าคืนไหน ผู้ใช้ขอปรับพฤติกรรมนี้เฉพาะฝั่งกามเทพเท่านั้น
    if (player.instigatorLinkId) {
        const linkedPartner = room.players.find((p) => p.id === player.instigatorLinkId);
        if (linkedPartner && linkedPartner.alive) {
            linkedPartner.alive = false;
            cascadeDeaths.push({ victim: linkedPartner, by: player, instigatorDeath: true });
            cascadeDeaths.push(...cleanupAfterDeath(room, linkedPartner, freshLoverPairs));
        }
    }

    // ลูกหมาป่า: ถ้าลูกหมาป่าตาย คนที่ถูกลากไว้จะตายตาม
    // และเปิดเผยบทบาทให้ทุกคนเห็นทันที "เฉพาะตอนที่มีการลากคนตายตามไปด้วยจริง" — ถ้าไม่ได้เลือกลากใครไว้
    // (draggedTargetId ไม่มี หรือเป้าหมายตายไปก่อนแล้ว) บทจะไม่เปิดเผย เหมือนหมาป่าปกติทั่วไป
    if (player.role === "ลูกหมาป่า") {
        const draggedTargetId = room.selectedTargets?.[player.id];
        if (draggedTargetId) {
            const draggedTarget = room.players.find((p) => p.id === draggedTargetId);
            if (draggedTarget && draggedTarget.alive && draggedTarget.id !== player.id) {
                revealRolePublic(player);
                draggedTarget.alive = false;
                cascadeDeaths.push({ victim: draggedTarget, by: player });
                cascadeDeaths.push(...cleanupAfterDeath(room, draggedTarget, freshLoverPairs));
            }
        }
    }

    // เด็กขี้โวยวาย: ถ้าตัวเองตาย บทบาทจริงของเป้าที่เลือกไว้ (ถ้ามี) จะถูกเปิดเผยต่อสาธารณะทันที
    // ต่างจากลูกหมาป่าตรงที่เป้าไม่ตายตามไปด้วย แค่ "ถูกแฉ" บทบาทให้ทุกคนเห็นเฉยๆ
    if (player.role === "เด็กขี้โวยวาย") {
        const loudmouthTargetId = room.selectedTargets?.[player.id];
        if (loudmouthTargetId) {
            const loudmouthTarget = room.players.find((p) => p.id === loudmouthTargetId);
            if (loudmouthTarget && loudmouthTarget.id !== player.id && !loudmouthTarget.roleRevealPublic) {
                revealRolePublic(loudmouthTarget);
                cascadeDeaths.push({ reveal: true, victim: loudmouthTarget, by: player });
            }
        }
    }

    // ผู้นำลัทธิ: ถ้าผู้นำลัทธิตาย สมาชิกลัทธิทั้งหมดที่ยังมีชีวิตอยู่จะ "หลบหนีออกจากหมู่บ้าน" ทันที
    // (นับเป็นตายจริง (isDeath=true, ขึ้นสีแดง) เหมือนกัน แค่ข้อความประกาศใช้คำว่า "หลบหนี"
    // แทนคำว่า "ตาย"/"ถูกฆ่า" ตรงๆ เพราะลัทธิล่มสลายไม่มีผู้นำแล้ว — ดู announceCascadeDeaths ด้านล่าง)
    // ตั้ง alive=false เพื่อไม่ให้นับเป็นผู้เล่นที่ยังอยู่ในเกม (กันชนะ/แพ้/โหวตต่อ) และเรียก cleanupAfterDeath
    // ซ้ำแบบ recursive กับสมาชิกแต่ละคนด้วย (เผื่อสมาชิกคนนั้นมีสกิลตาย-แล้ว-มีผลอื่นต่อ เช่น เป็นคู่รักอยู่ด้วย)
    if (player.role === "ผู้นำลัทธิ") {
        aliveCultMembersOf(room, player.id).forEach((member) => {
            member.alive = false;
            cascadeDeaths.push({ victim: member, by: player, cultFled: true });
            cascadeDeaths.push(...cleanupAfterDeath(room, member, freshLoverPairs));
        });
    }

    // ลบ selectedTargets ที่เล็งคนที่ตายนี้อยู่
    if (room.selectedTargets) {
        Object.keys(room.selectedTargets).forEach((selectorId) => {
            if (room.selectedTargets[selectorId] !== player.id) return;
            const selector = room.players.find((p) => p.id === selectorId);
            if (selector && protectRoles.includes(selector.role)) {
                player.protected = false;
            }
            delete room.selectedTargets[selectorId];
        });

        // ลบ selectedTargets ที่ player ที่ตายแล้วเป็นคนเลือกไว้ด้วย
        if (player.id in room.selectedTargets) {
            if (protectRoles.includes(player.role)) {
                const prevTarget = room.players.find(
                    (p) => p.id === room.selectedTargets[player.id]
                );
                if (prevTarget) prevTarget.protected = false;
            }
            delete room.selectedTargets[player.id];
        }
    }

    // ลบ shieldTargets ที่เกี่ยวข้องกับ player ที่ตาย
    if (room.shieldTargets) {
        Object.keys(room.shieldTargets).forEach((selectorId) => {
            if (room.shieldTargets[selectorId] === player.id) {
                delete room.shieldTargets[selectorId];
            }
        });
        if (player.id in room.shieldTargets) {
            delete room.shieldTargets[player.id];
        }
    }

    // ลบ curseTargets ที่เกี่ยวข้องกับ player ที่ตาย (ทั้งเป้าที่ตาย และหมาป่านักเวทที่ตาย)
    // แล้วคำนวณ wizardCursed ใหม่ทันที (เผื่อหมาป่านักเวทที่ตายไปทำให้คำสาปเป้าเก่าควรหายไปด้วย)
    if (room.curseTargets) {
        Object.keys(room.curseTargets).forEach((selectorId) => {
            if (room.curseTargets[selectorId] === player.id) {
                delete room.curseTargets[selectorId];
            }
        });
        if (player.id in room.curseTargets) {
            delete room.curseTargets[player.id];
        }
    }
    player.wizardCursed = false;
    recomputeWizardCurses(room);

    return cascadeDeaths;
}

// ประกาศในแชทสำหรับคนที่ตายตามลูกหมาป่าไป
function announceCascadeDeaths(room, roomId, cascadeDeaths) {
    if (!cascadeDeaths || cascadeDeaths.length === 0) return;
    room.globalChatHistory = room.globalChatHistory || [];
    cascadeDeaths.forEach(({ victim, by, reveal, loverDeath, instigatorDeath, cultFled }) => {
        const msg = reveal
            ? {
                name: "เกม",
                text: `👄 ${by.name} (เด็กขี้โวยวาย) ตาย เปิดเผยอาชีพ: ${victim.name} คือ ${roleDescription[victim.role]?.title || victim.role}`,
                type: "global",
                isSystem: true,
            }
            : loverDeath
            ? {
                name: "เกม",
                text: `💔 ${victim.name} เสียใจตายตามคู่รักของตน (${by.name}) ไปด้วย!`,
                type: "global",
                isSystem: true,
                isDeath: true,
            }
            : instigatorDeath
            ? {
                name: "เกม",
                text: `🎭 ${victim.name} ตายตามคู่ที่ผู้ยุยงจับไว้ (${by.name}) ไปด้วยทันที!`,
                type: "global",
                isSystem: true,
                isDeath: true,
            }
            : cultFled
            ? {
                name: "เกม",
                text: `🏃 ${victim.name} หลบหนีออกจากหมู่บ้านไปทันที หลังผู้นำลัทธิ (${by.name}) เสียชีวิต!`,
                type: "global",
                isSystem: true,
                isDeath: true, // นับเป็นตายจริง (ขึ้นสีแดง) แค่ข้อความใช้คำว่า "หลบหนี" แทน "ตาย"/"ถูกฆ่า" เฉยๆ
            }
            : {
                name: "เกม",
                text: `🐾 ${by.name} (ลูกหมาป่า) ตาย ลาก ${victim.name} ตายตามไปด้วย!`,
                type: "global",
                isSystem: true,
                isDeath: true, // มีคนตายจริง — ให้ client แสดงข้อความนี้เป็นสีแดงเสมอ
            };
        pushGlobalChat(room, msg);
        io.to(roomId).emit("chat_message", msg);
    });
}

// ============================================================
// VOTE HELPERS
// ============================================================

// จำนวนโหวตที่ต้องใช้เพื่อประหาร = จำนวนผู้เล่นที่มีชีวิต / 2 ปัดขึ้น
function getVoteThreshold(room) {
    const aliveVoters = room.players.filter((p) => !p.isHost && p.alive).length;
    return { aliveVoters, threshold: Math.ceil(aliveVoters / 2) };
}

// น้ำหนักโหวตของผู้เล่นคนนี้ — ปกติ 1 เสียง ยกเว้น "นายก" ที่เปิดเผยตัวแล้ว (p.mayorRevealed)
// จะนับเป็น 2 เสียงไปตลอดเกม (ดู reveal_mayor ด้านล่าง)
function getVoteWeight(player) {
    return player && player.mayorRevealed ? 2 : 1;
}

// ============================================================
// GAME END
// ============================================================

function teamOf(role) {
    return roles[role]?.team ?? null;
}

// ทีม "ที่มีผลจริง" ของผู้เล่นคนนี้ — ต่างจาก teamOf(role) ตรงที่คำนึงถึงการถูกชักชวนเข้าลัทธิด้วย
// (ผู้นำลัทธิเอง และสมาชิกที่ถูกชักชวน จะนับเป็นทีม "cult" เสมอ แม้ role เดิมของสมาชิกจะไม่เปลี่ยนก็ตาม)
// ใช้แทน teamOf(p.role) ทุกจุดที่ต้องนับพวก/เช็คทีมของ "ผู้เล่น" (ไม่ใช่แค่ role เฉยๆ)
function effectiveTeam(player) {
    if (!player) return null;
    if (isCultLeaderPlayer(player) || isCultMemberPlayer(player)) return "cult";
    return teamOf(player.role);
}

// นักล่าหัวที่ "เป้าหมายตายแล้ว" และตัวเองยังมีชีวิต ถือว่าผันตัวไปอยู่ฝ่ายชั่วร้าย
// (ชนะร่วมไปกับหมาป่า หรือ ฆาตกรต่อเนื่อง — แล้วแต่ว่าฝ่ายไหนชนะเกมจริง ๆ)
function isHeadhunterActivated(player, room) {
    if (!player || player.role !== "นักล่าหัว" || !player.alive) return false;
    if (!player.huntTargetId) return false;
    const target = room.players.find((p) => p.id === player.huntTargetId);
    return !!target && target.alive === false;
}

function isWinner(player, resultTeam, room) {
    if (!player || player.isHost) return false;

    // ผู้นำลัทธิ + สมาชิกลัทธิ: ยังไม่มีเงื่อนไขชนะเป็นของตัวเอง (ยังไม่ได้ระบุมาตอนออกแบบบทบาทนี้)
    // เช็คก่อนเงื่อนไขอื่นทั้งหมด — ตัดสิทธิ์ชนะร่วมกับทีมเดิมของตัวเองไปเลย เพราะเปลี่ยนทีมไปลัทธิแล้ว
    // (เหมือนหลักการเดียวกับผู้ยุยง/คู่ที่ถูกจับ ที่ตัดสิทธิ์ชนะร่วมกับทีมเดิมทันทีที่ย้ายทีม)
    if (isCultLeaderPlayer(player) || isCultMemberPlayer(player)) return false;

    // โจร + ผู้สมรู้ร่วมคิด: เช่นเดียวกับลัทธิ ยังไม่มีเงื่อนไขชนะเป็นของตัวเอง (ตามที่ผู้ใช้ระบุไว้
    // ตอนออกแบบบทบาทนี้ไม่ได้พูดถึงเงื่อนไขชนะแยก) — role เปลี่ยนไปเป็น "ผู้สมรู้ร่วมคิด" แล้วจริงๆ
    // จึงไม่มีทีมเดิมให้ชนะร่วมด้วยอยู่แล้วโดยธรรมชาติ (ต่างจากลัทธิที่ role เดิมยังอยู่)
    if (player.role === "โจร" || player.role === "ผู้สมรู้ร่วมคิด") return false;

    const t = teamOf(player.role);

    // ผู้ยุยง: คู่ที่ถูกผู้ยุยงจับไว้ (เช็คจาก p.instigatorLinkId) จะชนะร่วมกับ "ทีมผู้ยุยง" เท่านั้น
    // ไม่มีสิทธิ์ชนะร่วมกับทีมเดิมของตัวเองอีกต่อไป (ต่างจากคู่รักของกามเทพที่ยังชนะร่วมกับทีมเดิมได้
    // ตามปกติด้วย) — เช็คก่อนเงื่อนไขอื่นทั้งหมดด้านล่างเสมอ ดูคำอธิบายบทบาทผู้ยุยง
    if (player.instigatorLinkId) return resultTeam === "instigators";

    // กามเทพ: ชนะร่วมกับ "ทีมชาวบ้าน" เสมอเมื่อฝ่ายชาวบ้านชนะเกมจริง (นอกเหนือจากชนะร่วมกับ
    // ทีมคู่รักที่เช็คแยกด้านล่างที่ resultTeam === "lovers") — ดูคำอธิบายบทบาทกามเทพ
    // ผู้ยุยง: ชนะร่วมกับ "ทีมชาวบ้าน" เสมอเมื่อฝ่ายชาวบ้านชนะเกมจริงเช่นเดียวกัน (ทำงานแบบเดียวกับกามเทพ)
    if (resultTeam === "wolf")     return t === "wolf" || isHeadhunterActivated(player, room);
    if (resultTeam === "villager") return t === "villager" || player.role === "กามเทพ" || player.role === "ผู้ยุยง";
    if (resultTeam === "fool")     return player.role === "คนบ้า";
    if (resultTeam === "headhunter") return player.role === "นักล่าหัว";
    if (resultTeam === "murderer") return player.role === "ฆาตกรต่อเนื่อง" || isHeadhunterActivated(player, room);
    if (resultTeam === "illusionist") return player.role === "นักเล่นกล" || isHeadhunterActivated(player, room);
    // ทีมคู่รัก: ชนะได้ทั้งคู่รักสองคนที่ถูกกามเทพจับคู่ไว้ (เช็คจาก p.loverId) และตัวกามเทพเอง
    // (ไม่ต้องเช็คว่ากามเทพยังมีชีวิตอยู่หรือเปล่า เหมือนนักล่าหัว/ทีมอื่นๆ ในเกมนี้ที่นับเป็นผู้ชนะ
    // ได้แม้ตายไปแล้วระหว่างเกม ถ้าทีมตัวเองชนะเกมจริงในตอนจบ)
    if (resultTeam === "lovers")   return !!player.loverId || player.role === "กามเทพ";
    // ทีมผู้ยุยง: ตัวผู้ยุยงเองชนะเมื่อทีมผู้ยุยงชนะ (คู่ที่ถูกจับไปชนะแล้วผ่านการเช็ค instigatorLinkId
    // ด้านบนสุดของฟังก์ชันนี้ไปแล้ว ไม่ตกลงมาถึงบรรทัดนี้)
    if (resultTeam === "instigators") return player.role === "ผู้ยุยง";
    return false;
}

function conditionEnabled(room, resultTeam) {
    if (!room.testerConditions) return true;
    return room.testerConditions[resultTeam] !== false;
}

// จบเกม: ตั้งค่าผลลัพธ์ + แจ้งทุกคน
function endGame(room, roomId, resultTeam) {
    if (!room || room.gameOver) return false;

    if (!conditionEnabled(room, resultTeam)) {
        io.to(hostRoomName(roomId)).emit(
            "host_error",
            `🧪 [โหมดผู้ทดสอบ] เข้าเงื่อนไขจบเกมแล้ว (ทีม${teamLabels[resultTeam] || resultTeam}ชนะ) แต่ปิดเงื่อนไขนี้ไว้เพื่อทดสอบอยู่`
        );
        return false;
    }

    const winners = room.players.filter((p) => isWinner(p, resultTeam, room));

    // ถ้านักล่าหัว "เป้าหมายตายแล้ว" ชนะร่วมไปกับฝ่ายชั่วร้ายที่ชนะเกมจริง (หมาป่า/ฆาตกรต่อเนื่อง)
    // ให้ขึ้นชื่อนักล่าหัวต่อท้ายชื่อทีมที่ชนะด้วย
    const joinedByHeadhunter =
        (resultTeam === "wolf" || resultTeam === "murderer" || resultTeam === "illusionist") &&
        winners.some((p) => p.role === "นักล่าหัว");

    const baseTitle = `ทีม${teamLabels[resultTeam] || resultTeam}ชนะ`;

    room.gameOver = true;
    room.gameResult = {
        team: resultTeam,
        label: teamLabels[resultTeam] || resultTeam,
        title: joinedByHeadhunter ? `${baseTitle} + นักล่าหัว` : baseTitle,
        // BUG FIX: เก็บทั้ง token และ id เพื่อให้ทั้ง host และ player ตรวจสอบได้
        winners: winners.map((p) => ({ id: p.id, token: p.token })),
    };
    room.continueReady = {};
    scheduleAutoContinue(room, roomId);

    const msg = {
        name: "เกม",
        text: `🏁 จบเกม — ${room.gameResult.title}`,
        type: "global",
        isSystem: true,
    };
    room.globalChatHistory = room.globalChatHistory || [];
    pushGlobalChat(room, msg);
    io.to(roomId).emit("chat_message", msg);
    broadcastRoomUpdate(roomId, room, { timelineType: "game_ended", source: "game" });
    return true;
}

// รวม payload ของ event "your_role" ที่เดิมก็อปวางซ้ำกัน 6 จุดในไฟล์นี้ให้เหลือฟังก์ชันเดียว
// extended (ค่าเริ่มต้น true) รวมตัวนับความสามารถพิเศษ (โล่/กระสุน/ยา) ด้วย — ใช้ตอน join/reconnect/
// sync/เริ่มเกม/รีเซ็ตห้อง ส่วน extended:false ใช้ตอน "กลายร่างกลางเกม" (ผู้ถูกสาป/หมาป่าหยั่งรู้/ถูกกัด)
// ที่ยศเปลี่ยนแต่ตัวนับความสามารถของผู้เล่นคนนั้นไม่เกี่ยวข้อง/ไม่เปลี่ยน
function buildYourRolePayload(p, { silent = false, extended = true } = {}, room = null) {
    const payload = {
        role: p.role,
        displayRole: p.displayRole,
        huntTarget: p.huntTarget,
        huntTargetId: p.huntTargetId || null,
        roleInfo: p.role ? (roleDescription[p.role] || null) : null,
        // กลุ่มแชททีมยุยง (ตัวผู้ยุยงเอง + ผู้ศรัทธา 2 คนที่ถูกจับคู่ด้วย) — ใช้ฝั่ง client
        // ตัดสินใจว่าจะโชว์แท็บ "🎭 แชททีมยุยง" ให้เห็นหรือไม่ (ดู instigatorGroupId ที่ start_game)
        instigatorGroupId: p.instigatorGroupId || null,
        // ลัทธิ (ผู้นำลัทธิ + สมาชิก): ให้ client ตัดสินใจโชว์แท็บ "🔯 แชทลัทธิ" + การ์ดข้อมูลลัทธิ
        // cultGroupId: id ของผู้นำลัทธิที่กลุ่มนี้สังกัด (null = ไม่เกี่ยวข้องกับลัทธิใดเลย)
        // cultInfo: ข้อมูลลัทธิที่ผู้เล่นคนนี้ "มีสิทธิ์เห็น" เท่านั้น — สมาชิกเห็นบทหัวลัทธิจริง +
        // รายชื่อสมาชิกคนอื่น (ไม่เห็นบทของสมาชิกคนอื่น) ตามที่ระบุไว้ในคำอธิบายบทบาท
        cultGroupId: cultGroupIdOf(p),
        cultInfo: room ? buildCultInfoFor(p, room) : null,
        // โจร (หัวโจร + ผู้สมรู้ร่วมคิด): ให้ client ตัดสินใจโชว์แท็บ "🗡️ แชททีมโจร" + การ์ดข้อมูล
        // banditGroupId: id ของหัวโจรที่กลุ่มนี้สังกัด (null = ไม่เกี่ยวข้องกับกลุ่มโจรใดเลย)
        banditGroupId: banditGroupIdOf(p),
        banditInfo: room ? buildBanditInfoFor(p, room) : null,
    };
    if (extended) {
        payload.guardianShieldAvailable = p.guardianShieldAvailable || 0;
        payload.sheriffBullets = p.sheriffBullets || 0;
        payload.sheriffPeeks = p.sheriffPeeks || 0;
        payload.witchProtectPotions = p.witchProtectPotions || 0;
        payload.witchPoisonPotions = p.witchPoisonPotions || 0;
        payload.priestHolyWaterPotions = p.priestHolyWaterPotions || 0;
    }
    if (silent) payload.silent = true;
    return payload;
}

// ข้อมูลลัทธิที่จะฝังลงใน your_role เฉพาะของผู้เล่นคนนี้เท่านั้น (ไม่ใช่ broadcast รวม)
// null ถ้าไม่เกี่ยวข้องกับลัทธิใดเลย — ดูคำอธิบายบทบาทผู้นำลัทธิ:
// "คนที่เข้าลัทธิจะเห็นบทหัวลัทธิ และเห็นว่าใครเป็นสมาชิกแต่ไม่เห็นบท"
function buildCultInfoFor(p, room) {
    const groupId = cultGroupIdOf(p);
    if (!groupId || !room) return null;
    const leader = room.players.find((pl) => pl.id === groupId);
    if (!leader) return null;
    const members = aliveCultMembersOf(room, groupId).map((m) => ({ id: m.id, name: m.name }));
    return {
        isLeader: p.id === groupId,
        leaderId: leader.id,
        leaderName: leader.name,
        // สมาชิกเห็นบทบาทจริงของหัวลัทธิ (ผู้นำลัทธิเห็นบทตัวเองอยู่แล้วผ่าน payload.role ปกติ)
        leaderRole: p.id === groupId ? null : leader.role,
        leaderRoleInfo: p.id === groupId ? null : (roleDescription[leader.role] || null),
        members, // ชื่อสมาชิกที่ยังมีชีวิตอยู่ทั้งหมด (ไม่รวมหัวลัทธิ) — ไม่มี role ติดไปด้วยเลย ตามที่ระบุไว้
        maxMembers: CULT_MAX_MEMBERS,
    };
}

// ข้อมูลกลุ่มโจรที่จะฝังลงใน your_role เฉพาะของผู้เล่นคนนี้เท่านั้น (ไม่ใช่ broadcast รวม) —
// ทำงานแบบเดียวกับ buildCultInfoFor แต่มีผู้สมรู้ร่วมคิดได้สูงสุดแค่ 1 คนต่อครั้ง (ไม่ใช่ลิสต์)
function buildBanditInfoFor(p, room) {
    const groupId = banditGroupIdOf(p);
    if (!groupId || !room) return null;
    const leader = room.players.find((pl) => pl.id === groupId);
    if (!leader) return null;
    const accomplice = aliveBanditAccomplicesOf(room, groupId)[0] || null;
    return {
        isLeader: p.id === groupId,
        leaderId: leader.id,
        leaderName: leader.name,
        accompliceId: accomplice ? accomplice.id : null,
        accompliceName: accomplice ? accomplice.name : null,
    };
}


// ส่ง your_role ใหม่ให้ทุกคนในกลุ่มลัทธินี้ (หัวลัทธิ + สมาชิกที่ยังมีชีวิตอยู่ทั้งหมด) — เรียกทุกครั้งที่
// รายชื่อสมาชิกเปลี่ยน (ชักชวนสำเร็จ/สังเวยสมาชิก/สมาชิกตาย) เพื่อให้ cultInfo.members ที่ทุกคนเห็นตรงกันเสมอ
function broadcastCultRoster(room, leaderId) {
    const leader = room.players.find((p) => p.id === leaderId);
    if (!leader) return;
    const group = [leader, ...aliveCultMembersOf(room, leaderId)];
    group.forEach((p) => {
        io.to(p.id).emit("your_role", buildYourRolePayload(p, { silent: true }, room));
    });
}

// รีเซ็ตสถานะรายผู้เล่นทั้งหมดของรอบเก่า (ก่อนเริ่มเกมใหม่/รีสตาร์ทห้อง) — เดิมก็อปวางซ้ำ
// กันเป๊ะ 2 จุด (start_game และ restart_room) รวมเป็นฟังก์ชันเดียวเพื่อกันหลุดตกหล่นเวลาต้อง
// เพิ่ม field ใหม่ในอนาคต (ต้องแก้แค่จุดเดียว)
function resetPlayerRoundState(p) {
    p.role = null;
    p.originalRole = null;
    p.displayRole = null;
    p.alive = true;
    p.protected = false;
    p.killed = false;
    p.silenced = false;
    p.huntTarget = null;
    p.huntTargetId = null;
    p.guardianShieldAvailable = 0;
    p.sheriffBullets = 0;
    p.sheriffPeeks = 0;
    p.sheriffUsedToday = false;
    p.transformed = false;
    p.oracleTransformed = false;
    p.bodyguardInjured = false;
    p.musclemanExposed = false;
    p.musclemanPendingDeath = false;
    p.stubbornInjured = false;
    p.roleRevealPublic = false;
    p.illusionDeathReveal = false;
    p.roleRevealMutualWith = [];
    p.scoutedThisNight = false;
    p.wolfSeerRevealed = false;
    p.wolfSeerRevealedRole = null;
    p.trueSeerRevealedTo = [];
    p.trueSeerRevealedRoleBy = {};
    p.sheriffRevealedTo = [];
    p.sheriffRevealedRoleBy = {};
    p.auraRevealedTo = {};
    p.detectiveScoutedThisNight = false;
    p.detectiveRevealedTo = {};
    p.lastDetectiveScoutText = null;
    p.lastScoutTargetName = null;
    p.lastScoutTargetId = null;
    p.scoutAnnouncedTargetIds = []; // เฟส 5: เคลียร์ประวัติ "เผยข้อมูลไปแล้ว" ของเกมก่อนหน้าทิ้งด้วย
    p.witchProtectPotions = 0;
    p.witchPoisonPotions = 0;
    p.witchPoisonPending = false;
    p.priestHolyWaterPotions = 0; // นักบวช: น้ำมนต์ 1 ขวดตลอดเกม (แจกจริงตอนแจกบท — ดู start_game)
    p.mayorAvailable = 0;
    p.mayorRevealed = false;
    p.loverId = null; // กามเทพ/คู่รัก: id ของคู่รักอีกฝ่าย (null = ยังไม่ถูกจับคู่)
    p.cupidPaired = false; // กามเทพ: ใช้สิทธิ์จับคู่ไปแล้วหรือยัง (ใช้ได้แค่ครั้งเดียวตลอดเกม ไม่รีเซ็ตรายคืน)
    p.lastCupidPairText = null;
    p.cupidPairTargetIds = null; // กามเทพเท่านั้น: id ของคู่รักสองคนที่ตัวเองจับคู่ไว้ (ให้เห็นไอคอน 💘 บนการ์ดคู่นั้น
                                  // เหมือนที่คู่รักเห็นกันเอง — แต่กามเทพเองไม่ได้เป็นคู่รัก จึงต้องเก็บแยกจาก loverId)
    p.instigatorLinkId = null; // ผู้ยุยง/คู่ที่ถูกจับ: id ของอีกฝ่าย (null = ยังไม่ถูกจับคู่) — คนละ field กับ loverId กันชนกัน
    p.instigatorPaired = false; // ผู้ยุยง: ใช้สิทธิ์จับคู่ไปแล้วหรือยัง (ใช้ได้แค่ครั้งเดียวตลอดเกม ไม่รีเซ็ตรายคืน)
    p.lastInstigatorPairText = null;
    p.instigatorPairTargetIds = null; // ผู้ยุยงเท่านั้น: id ของคู่ที่ตัวเองจับไว้ (ให้เห็นไอคอนรูปผู้ยุยงบนการ์ดคู่นั้น
                                       // เหมือนที่คู่ที่ถูกจับเห็นกันเอง — แต่ผู้ยุยงเองไม่ได้อยู่ในคู่ จึงเก็บแยกจาก instigatorLinkId)
    p.instigatorGroupId = null; // ผู้ยุยง + คู่ที่ถูกจับทั้งสอง: ตั้งเป็น id ของ "ผู้ยุยง" คนเดียวกันหมด — ให้ detective_scout
                                 // มองว่าทั้งสามคนนี้ "ทีมเดียวกัน" เสมอเวลาส่องคู่กันเอง แม้บทจริงจะคนละทีมก็ตาม
    p.cultLeaderId = null; // ผู้นำลัทธิ (ดู CULT_MAX_MEMBERS ด้านบน): id ของผู้นำลัทธิที่ผู้เล่นคนนี้ถูกชักชวนเข้าร่วม
                            // (null = ยังไม่ได้เข้าลัทธิใดเลย) — เปลี่ยน "ทีมที่มีผลจริง" เท่านั้น (ดู effectiveTeam) ไม่แตะ p.role เลย
    p.banditLeaderId = null; // โจร: id ของหัวโจรที่เปลี่ยนบทบาทผู้เล่นคนนี้ให้เป็น "ผู้สมรู้ร่วมคิด" (null = ยังไม่ถูกเปลี่ยน)
                              // ต่างจาก cultLeaderId ตรงที่ p.role ของผู้เล่นคนนี้ถูกเปลี่ยนเป็น "ผู้สมรู้ร่วมคิด" จริงๆ ไปแล้ว (ดู BANDIT_ROLES)
    // Explicitly leaving to choose a new room is recorded immediately and locked to this round.
    p.leftGameRoundId = null;
    p.leaveReason = null;
    p.leaveRecordedAt = null;
}

// ตรวจเงื่อนไขจบเกมที่อิงจากจำนวนคนที่เหลือ
// ============================================================
// หมาป่าหยั่งรู้ตัวสุดท้าย — ถ้าเหลือหมาป่าเผ่าเดียวและเป็นหมาป่าหยั่งรู้ ให้กลายร่างเป็น
// หมาป่าธรรมดาโดยอัตโนมัติ (คล้ายผู้ถูกสาปกลายร่าง) เพื่อให้ยังร่วมล่าได้ในคืนถัดไป
// (ไม่งั้นทีมหมาป่าจะฆ่าใครไม่ได้เลย เพราะหมาป่าหยั่งรู้ไม่ร่วมล่า ใช้ scout_target แทน)
// ============================================================
function transformOracleWolfToNormal(room, roomId, p, reason) {
    p.role = "หมาป่า";
    p.displayRole = "หมาป่า (หมาป่าหยั่งรู้)";
    p.oracleTransformed = true; // แยกจาก p.transformed ของผู้ถูกสาปเพื่อไม่ให้ยศตอนกัดสับสนกัน

    io.to(p.id).emit("your_role", buildYourRolePayload(p, { silent: true, extended: false }, room));

    const privText = reason === "solo"
        ? "คุณเหลือเป็นหมาป่าตัวสุดท้าย จึงสละพลังหยั่งรู้และกลายเป็นหมาป่าธรรมดาที่ร่วมล่าได้แล้ว!"
        : "คุณสละลางสังหรณ์และกลายเป็นหมาป่าธรรมดาที่ร่วมล่าได้แล้ว!";
    sendPrivateChat(room, p.id, {
            name: "เกม",
        text: privText,
        type: "private",
        isSystem: true,
    });

    if (room.wolfChatHistory?.length) {
        io.to(p.id).emit("wolf_chat_history", room.wolfChatHistory);
    }

    const wolfMsg = {
        name: "เกม",
        text: `🔮🐺 ${p.name} (หมาป่าหยั่งรู้) กลายเป็นหมาป่าธรรมดาแล้ว!`,
        type: "wolf",
        isSystem: true,
    };
    room.wolfChatHistory = room.wolfChatHistory || [];
    room.wolfChatHistory.push(wolfMsg);
    room.players.forEach((wp) => {
        if (WOLF_ROLES.has(wp.role)) io.to(wp.id).emit("chat_message", wolfMsg);
    });
    io.to(hostRoomName(roomId)).emit("chat_message", wolfMsg); // ส่งให้ทุกจอโฮสต์
}

// เช็คทุกครั้งที่มีคนตาย (ถูกเรียกจาก checkGameEndGeneral) ว่าเหลือหมาป่าแค่ตัวเดียวและเป็น
// หมาป่าหยั่งรู้หรือเปล่า ถ้าใช่ให้กลายร่างอัตโนมัติทันที
function checkSoloOracleWolf(room, roomId) {
    if (!room || room.gameOver) return;
    const aliveWolves = room.players.filter((p) => !p.isHost && p.alive && WOLF_ROLES.has(p.role));
    if (aliveWolves.length === 1 && aliveWolves[0].role === "หมาป่าหยั่งรู้") {
        transformOracleWolfToNormal(room, roomId, aliveWolves[0], "solo");
    }
}

// กามเทพ/คู่รัก: เช็คก่อนเงื่อนไขจบเกมอื่นๆ ทั้งหมดเสมอ — คู่รักชนะทันทีเมื่อผู้รอดชีวิตที่เหลือ
// อยู่ในกลุ่ม "คู่รักสองคน + กามเทพ (ถ้ายังไม่ตาย)" เท่านั้น ไม่ว่าทีมเดิมของแต่ละคนจะเป็นอะไรก็ตาม
// (เช่น คู่รักฝั่งหมาป่า+ชาวบ้านที่เหลือรอดกันแค่สองคนสุดท้าย จะชนะร่วมกันแบบคู่รัก แทนที่จะเข้า
// เงื่อนไข "หมาป่าครบจำนวน" ตามปกติ) ต้องเช็คก่อนเสมอเพราะเงื่อนไขอื่นด้านล่างอาจจบเกมไปก่อนได้
function checkLoversWinAlone(room, roomId) {
    if (!room || room.gameOver) return false;

    // เกมนี้รองรับกามเทพจับคู่ได้แค่ 1 คู่ต่อเกม (จับคู่ได้ครั้งเดียวตลอดเกม) — หาคู่รักที่ยังมีชีวิต
    // อยู่ทั้งคู่จาก p.loverId (เซ็ตไว้แบบ cross-reference ทั้งสองฝ่ายตอน cupid_pair)
    const loverA = room.players.find((p) => !p.isHost && p.alive && p.loverId);
    if (!loverA) return false;
    const loverB = room.players.find((p) => p.id === loverA.loverId);
    if (!loverB || !loverB.alive) return false;

    const alive = room.players.filter((p) => !p.isHost && p.alive);
    const onlyLoversAndCupidLeft = alive.every(
        (p) => p.id === loverA.id || p.id === loverB.id || p.role === "กามเทพ"
    );
    if (onlyLoversAndCupidLeft) {
        endGame(room, roomId, "lovers");
        return true;
    }
    return false;
}

// ผู้ยุยง/คู่ที่ถูกจับ: ทำงานแบบเดียวกับ checkLoversWinAlone เป๊ะๆ (เช็คก่อนเงื่อนไขจบเกมอื่นๆ
// ทั้งหมดเสมอ) แค่ใช้ p.instigatorLinkId แทน p.loverId และจบเกมด้วย resultTeam "instigators" แทน "lovers"
function checkInstigatorsWinAlone(room, roomId) {
    if (!room || room.gameOver) return false;

    // เกมนี้รองรับผู้ยุยงจับคู่ได้แค่ 1 คู่ต่อเกม (จับคู่ได้ครั้งเดียวตลอดเกม) — หาคู่ที่ยังมีชีวิต
    // อยู่ทั้งคู่จาก p.instigatorLinkId (เซ็ตไว้แบบ cross-reference ทั้งสองฝ่ายตอน instigator_pair)
    const linkA = room.players.find((p) => !p.isHost && p.alive && p.instigatorLinkId);
    if (!linkA) return false;
    const linkB = room.players.find((p) => p.id === linkA.instigatorLinkId);
    if (!linkB || !linkB.alive) return false;

    const alive = room.players.filter((p) => !p.isHost && p.alive);
    const onlyLinkedAndInstigatorLeft = alive.every(
        (p) => p.id === linkA.id || p.id === linkB.id || p.role === "ผู้ยุยง"
    );
    if (onlyLinkedAndInstigatorLeft) {
        endGame(room, roomId, "instigators");
        return true;
    }
    return false;
}

function checkGameEndGeneral(room, roomId) {
    if (!room || room.gameOver || !room.started) return;

    checkSoloOracleWolf(room, roomId);

    if (checkLoversWinAlone(room, roomId)) return;
    if (checkInstigatorsWinAlone(room, roomId)) return;

    const alive = room.players.filter((p) => !p.isHost && p.alive);
    if (alive.length === 0) return;

    const wolves    = alive.filter((p) => effectiveTeam(p) === "wolf");
    const villagers = alive.filter((p) => effectiveTeam(p) === "villager");
    const solos     = alive.filter((p) => effectiveTeam(p) === "solo");
    const cults     = alive.filter((p) => effectiveTeam(p) === "cult"); // ผู้นำลัทธิ + สมาชิกที่ถูกชักชวน — ไม่ใช่หมาป่า นับรวมเป็น "ไม่ใช่หมาป่า" กันหมาป่าชนะไปทั้งที่ลัทธิยังอยู่ครบ
    const bandits   = alive.filter((p) => effectiveTeam(p) === "bandit"); // หัวโจร + ผู้สมรู้ร่วมคิด — เช่นเดียวกับลัทธิ นับรวมเป็น "ไม่ใช่หมาป่า"
    // บทเดี่ยวที่มีความสามารถฆ่าจริง (ฆาตกรต่อเนื่อง/นักเล่นกล — ดู SOLO_KILLER_ROLES) — ใช้ generic
    // แทนตัวแปร murderer เดี่ยวเดิม เพื่อรองรับกรณีมีบทเดี่ยวฆ่าได้มากกว่า 1 ชนิดอยู่ในห้องเดียวกัน
    const soloKillers = alive.filter((p) => SOLO_KILLER_ROLES.has(p.role));

    // นักล่าหัวที่เป้าหมายตายแล้ว (รอลุ้นชนะร่วมกับหมาป่า/ฆาตกรต่อเนื่อง/นักเล่นกล ถ้าฝ่ายนั้นชนะเกมจริง)
    const activatedHeadhunters = alive.filter((p) => isHeadhunterActivated(p, room));

    // เงื่อนไข 4: เหลือบทเดี่ยวที่ฆ่าได้จริงรอด — คนอื่นที่เหลือเป็นได้แค่นักล่าหัวที่ผันตัวมาแล้ว (จะชนะร่วมกัน)
    if (soloKillers.length > 0) {
        const others = alive.filter((p) => !soloKillers.includes(p));
        const onlyActivatedHeadhuntersLeft = others.every((p) =>
            activatedHeadhunters.includes(p)
        );
        if (onlyActivatedHeadhuntersLeft) {
            // ห้องปกติจะมีบทเดี่ยวฆ่าได้จริงแค่ชนิดเดียวที่เหลือรอด แต่ถ้าบังเอิญมีมากกว่า 1 ชนิด
            // รอดพร้อมกัน ให้ฆาตกรต่อเนื่องมีสิทธิ์ก่อน (พฤติกรรมเดิม) — ไม่ใช่กรณีที่คาดว่าจะเกิดจริง
            const hasMurderer = soloKillers.some((p) => p.role === "ฆาตกรต่อเนื่อง");
            endGame(room, roomId, hasMurderer ? "murderer" : "illusionist");
            return;
        }
    }

    // เงื่อนไข 3: หมาป่าครบจำนวน
    if (wolves.length > 0) {
        const nonWolves = villagers.length + solos.length + cults.length + bandits.length;
        if (wolves.length >= nonWolves) {
            if (soloKillers.length === 0 || nonWolves === 0) {
                endGame(room, roomId, "wolf");
            }
            return;
        }
    }

    // เงื่อนไขเสริม: หมาป่าตายหมด + ไม่มีบทเดี่ยวฆ่าได้จริงคุกคาม
    // (นักล่าหัวที่ผันตัวแล้วแต่ไม่มีฝ่ายชั่วร้ายให้ชนะร่วม ไม่มีความสามารถฆ่าเพื่อเคลียร์เกมเอง
    //  ดังนั้นไม่ทำให้ชาวบ้านพลาดการชนะ — ชาวบ้านชนะตามปกติ ส่วนนักล่าหัวแพ้ไปด้วย)
    if (wolves.length === 0 && soloKillers.length === 0) {
        endGame(room, roomId, "villager");
    }
}

// ============================================================
// ปิดโหมดโหวต — นับคะแนน/ประหาร แล้วเข้าคืนถัดไปให้อัตโนมัติเลย
// เรียกจากทั้ง 2 ทาง: โฮสต์กดปิดโหวตเอง และ timer หมดเวลา 15 วิอัตโนมัติ
//
// แก้บั๊ก (พบภายหลัง): เดิมฟังก์ชันนี้เรียก beginNight() ตรงๆ แล้ว "ไม่ได้" ตามด้วย
// เพราะ closeVoteRound() เป็นฟังก์ชันระดับบนสุดของไฟล์ (ประกาศก่อน io.on("connection", ...))
// จึงไม่เห็น performWolfKill/performSelectTarget/ฯลฯ ที่ถูกประกาศไว้ข้างในนั้น (คนละ scope กัน)
// ผลคือ: ทุกคืนที่เริ่มจากการปิดโหวต (คือแทบทุกคืนในเกมจริง ยกเว้นคืนที่โฮสต์กด "เริ่มคืน" เองตรงๆ
// ซึ่งไม่ค่อยเกิดในโฟลว์ปกติ) บอทหมาป่า/บอทบทบาทพิเศษจะไม่ทำ action ให้เลย ดูเหมือนบอท "ค้าง"
// ตั้งแต่คืนที่ 1-2 เป็นต้นไป — แก้โดยรับ deps เข้ามาเป็นพารามิเตอร์ที่ 3 (ตัวเรียกฝั่ง
// io.on("connection", ...) ส่งเข้ามาได้เพราะอยู่ scope เดียวกับ performWolfKill ฯลฯ) แล้วยิง
function closeVoteRound(room, roomId) {
    clearVoteTimer(roomId);
    room.voteMode = false;
    room.voteDeadline = null;

    const { threshold } = getVoteThreshold(room);
    const tally = {};
    Object.entries(room.votes || {}).forEach(([voterId, tid]) => {
        const voter = room.players.find((p) => p.id === voterId);
        tally[tid] = (tally[tid] || 0) + getVoteWeight(voter);
    });

    let executed = null;
    let shieldedPlayer = null;
    let stubbornSurvivor = null;
    let cascadeDeaths = [];

    if (threshold > 0 && Object.keys(tally).length > 0) {
        const maxVotes = Math.max(...Object.values(tally));

        if (maxVotes >= threshold) {
            const topCandidates = Object.keys(tally).filter(
                (tid) => tally[tid] === maxVotes
            );

            // ถ้าเสมอกัน → ไม่ประหารใคร
            if (topCandidates.length === 1) {
                const target = room.players.find((p) => p.id === topCandidates[0]);
                if (target && target.alive) {
                    // ตรวจหมาป่าผู้พิทักษ์วางโล่ไว้
                    const shieldTargets = room.shieldTargets || {};
                    const guardianId = Object.keys(shieldTargets).find(
                        (gid) => shieldTargets[gid] === target.id
                    );
                    const guardian = guardianId
                        ? room.players.find((p) => p.id === guardianId)
                        : null;

                    if (guardian && guardian.alive && guardian.guardianShieldAvailable > 0) {
                        guardian.guardianShieldAvailable = 0;
                        shieldedPlayer = target;
                    } else if (target.role === "หมาป่าดื้อรั้น" && !target.stubbornInjured) {
                        // หมาป่าดื้อรั้นมี 2 ชีวิต — โดนประหารครั้งแรกรอด (บาดเจ็บ) ไม่ตาย นับรวมกับที่โดนฆ่าตอนกลางคืนด้วย
                        target.stubbornInjured = true;
                        stubbornSurvivor = target;
                    } else {
                        target.alive = false;
                        executed = target;
                    }
                }
            }
        }
    }

    const resultMsg = {
        name: "เกม",
        text: shieldedPlayer
            ? `ผู้เล่น...${shieldedPlayer.name} ถูกปกป้องจากการประหาร`
            : stubbornSurvivor
            ? `🐺💢 หมาป่าดื้อรั้นถูกโจมตีและได้รับบาดเจ็บ`
            : executed
            ? `ชาวบ้านตัดสินใจประหาร ${executed.name}`
            : "ชาวบ้านตัดสินใจไม่ประหารใคร",
        type: "global",
        isSystem: true,
        // แดงเฉพาะกรณีมีคนตายจริง (ถูกประหาร) — โล่ป้องกัน/บาดเจ็บ/ไม่ประหารใคร ไม่ใช่การตาย
        isDeath: !!executed,
    };
    room.globalChatHistory = room.globalChatHistory || [];
    pushGlobalChat(room, resultMsg);
    io.to(roomId).emit("chat_message", resultMsg);

    if (stubbornSurvivor) {
        sendPrivateChat(room, stubbornSurvivor.id, {
            name: "เกม",
            text: "คุณได้รับบาดเจ็บ หากถูกโจมตีอีกครั้งคุณจะตาย",
            type: "private",
            isSystem: true,
        });
    }

    let endedByVote = false;
    if (executed) {
        cascadeDeaths = cleanupAfterDeath(room, executed);
        announceCascadeDeaths(room, roomId, cascadeDeaths);

        if (executed.role === "คนบ้า") {
            endedByVote = endGame(room, roomId, "fool");
        } else {
            const headhunter = room.players.find(
                (p) => p.role === "นักล่าหัว" && p.alive && p.huntTargetId === executed.id
            );
            if (headhunter) endedByVote = endGame(room, roomId, "headhunter");
        }
    }

    room.votes = {};
    room.shieldTargets = {};

    if (!endedByVote) checkGameEndGeneral(room, roomId);

    // ปิดโหวตแล้ว เข้าคืนถัดไปให้อัตโนมัติเลย (ยกเว้นเกมจบไปแล้วระหว่างนับคะแนน)
    if (!room.gameOver) {
        broadcastRoomUpdate(roomId, room, { timelineType: "vote_resolved", source: "game", reason: executed ? "executed" : "no_execution" });
        beginNight(room, roomId); // เรียก room_update ให้เองในตัว

        // ที่นี่เหมือนที่ start_night handler ทำ — ต้องเช็ค deps ก่อนเพราะบางจุดเรียกไม่ได้ส่งมา
        // (กันเหนียว ไม่ควรเกิดถ้าแก้ครบทุก call site แล้ว)
        if (deps) {
        }
    } else {
        broadcastRoomUpdate(roomId, room);
    }
}

// ============================================================
// เริ่มคืน — ใช้ทั้งตอนโฮสต์กดปุ่ม "เริ่มคืน" เอง (start_night) และตอนเริ่มเกมใหม่
// (start_game) ซึ่งอยากให้ข้ามไปคืนแรกอัตโนมัติทันทีที่แจกบทเสร็จ ไม่ต้องรอกดซ้ำ
// ============================================================
function beginNight(room, roomId) {
    room.globalChatHistory = room.globalChatHistory || [];

    // อันธพาลที่ถูกเปิดเผยเมื่อคืนก่อน (รอดจากการโจมตีด้วยการป้องกันตัวเอง)
    // จะเสียชีวิตตอนนี้ — หลังจบการประชุมกลางวัน ก่อนเริ่มคืนถัดไป
    const musclemenDue = room.players.filter((p) => p.alive && p.musclemanPendingDeath);
    if (musclemenDue.length > 0) {
        let musclemanCascade = [];
        musclemenDue.forEach((p) => {
            p.alive = false;
            p.musclemanPendingDeath = false;
            // ตายจากบาดแผล (ไม่ใช่การโหวต) — เปิดเผยบทบาทอันธพาลให้ทุกคนเห็นไอคอนอาชีพในกริดเลย
            // เพื่อเพิ่มความท้าทาย เพราะมีโอกาสที่คนอื่นจะไม่เชื่อว่าเป็นอันธพาลจริง มองว่าโบ้ย
            revealRolePublic(p);
            musclemanCascade.push(...cleanupAfterDeath(room, p));
            const dieMsg = {
                name: "เกม",
                text: `${p.name} เสียชีวิตจากบาดแผลที่ถูกโจมตีเมื่อคืนก่อน`,
                type: "global",
                isSystem: true,
                isDeath: true,
            };
            pushGlobalChat(room, dieMsg);
            io.to(roomId).emit("chat_message", dieMsg);
        });
        announceCascadeDeaths(room, roomId, musclemanCascade);
        checkGameEndGeneral(room, roomId);
        if (room.gameOver) {
            broadcastRoomUpdate(roomId, room);
            return;
        }
    }

    // ล้าง silenced และประกาศในแชท
    const wasSilenced = room.players.filter((p) => !p.isHost && p.silenced);
    room.players.forEach((p) => { p.silenced = false; });

    if (wasSilenced.length > 0) {
        const liftMsg = {
            name: "เกม",
            text: `🔊 คำสาปใบ้ได้สิ้นสุดลงแล้ว — ${wasSilenced.map((p) => p.name).join(", ")} กลับมาพูดได้ตามปกติ`,
            type: "global",
            isSystem: true,
        };
        pushGlobalChat(room, liftMsg);
        io.to(roomId).emit("chat_message", liftMsg);
    }

    room.nightCount = (room.nightCount || 0) + 1;
    room.isNight = true;

    // รีเซ็ตสิทธิ์ "ส่อง" รายคืนของหมาป่าหยั่งรู้/ผู้มีลาง/ผู้หยั่งรู้ — ส่องได้คนละ 1 ครั้งต่อคืน
    // (นักสืบใช้ flag แยกต่างหาก detectiveScoutedThisNight เพราะเลือก 2 เป้าพร้อมกันในการกระทำเดียว)
    room.players.forEach((p) => { p.scoutedThisNight = false; p.detectiveScoutedThisNight = false; });

    // เข้าสู่คืนใหม่แล้ว → เคลียร์ไอคอนผลดูบทของ "ศาลเตี้ย" ทิ้ง (ศาลเตี้ยใช้สิทธิ์ตอนกลางวัน
    // ผลจึงควรอยู่แค่ช่วงกลางวันวันนั้น พอตกกลางคืนถือว่าหมดอายุ ไม่รอไปเคลียร์พร้อมของฝั่ง
    // ส่องกลางคืนตอนเช้าถัดไป ไม่งั้นจะค้างข้ามคืนเกินจำเป็น)
    room.players.forEach((p) => {
        p.sheriffRevealedTo = [];
        p.sheriffRevealedRoleBy = {};
    });

    // ล้างการเลือกฆ่าของหมาป่า/ฆาตกรต่อเนื่องจากคืนก่อนหน้า (ปกติถูกเคลียร์ไปแล้วตอน resolve_night
    // แต่เคลียร์ซ้ำไว้ตรงนี้ด้วยกันเหนียว — คืนใหม่ต้องเริ่มเลือกใหม่เสมอ ไม่ให้เป้าเก่าค้าง)
    room.wolfKillVotes = {};
    room.murdererKillVote = null;
    room.instigatorKillVote = null;

    // ============================================================
    // ร่ายเวท (หมาป่านักเวท) — คำสาปเพิ่งจะเริ่มมีผลจริงตอนนี้ (ตอนเข้าสู่กลางคืน) จากเป้าที่เลือกไว้
    // ตอนกลางวัน (room.curseTargets) — ตอนกลางวันตอนกดเลือกยังไม่มีผลใดๆ (ดู select_curse_target)
    // แล้วประกาศให้ทีมหมาป่ารู้ว่าใครกำลังถูกร่ายเวทอยู่ในคืนนี้ คำสาปนี้มีผลแค่คืนนี้คืนเดียว
    // พอเข้าสู่เช้าวันถัดไปจะถูกล้างทิ้งอัตโนมัติ (ดู resolve_night)
    // ============================================================
    recomputeWizardCurses(room);
    const cursedNow = room.players.filter((p) => p.alive && p.wizardCursed);
    if (cursedNow.length > 0) {
        room.wolfChatHistory = room.wolfChatHistory || [];
        cursedNow.forEach((target) => {
            const msg = {
                name: "เกม",
                text: `🪄 ${target.name}... ถูกร่ายเวท`,
                type: "wolf",
                isSystem: true,
            };
            room.wolfChatHistory.push(msg);
            room.players.forEach((p) => {
                if (WOLF_ROLES.has(p.role)) io.to(p.id).emit("chat_message", msg);
            });
            io.to(hostRoomName(roomId)).emit("chat_message", msg); // ส่งให้ทุกจอโฮสต์
        });
    }

    const nightMsg = {
        name: "เกม",
        text: `🌙 เริ่มคืนที่ ${room.nightCount}`,
        type: "wolf",
        isSystem: true,
    };
    room.wolfChatHistory = room.wolfChatHistory || [];
    room.wolfChatHistory.push(nightMsg);

    room.players.forEach((p) => {
        if (WOLF_ROLES.has(p.role)) {
            io.to(p.id).emit("chat_message", nightMsg);
        }
    });
    io.to(hostRoomName(roomId)).emit("chat_message", nightMsg); // ส่งให้ทุกจอโฮสต์

    broadcastRoomUpdate(roomId, room, { timelineType: "phase_started", source: "game", reason: `night_${room.nightCount}` });
}

// ============================================================
// ADMIN — ล้างข้อมูลเกมทั้งหมด (RESET EVERYTHING) — ปุ่มในหน้า admin.html
// ============================================================
// ทำอะไรบ้าง (ล้างห้องและข้อมูลเกมที่เก็บไว้ ให้ผู้เล่นเริ่มเล่นแบบ Guest ใหม่):
//   1) ลบทุกแถวในตาราง DynamoDB (สถิติแพ้/ชนะ, รายชื่อผู้เล่นทั้งหมด, ประวัติเข้าเล่น) — เว้นแถวระบบ __SYSTEM__
//   2) เปลี่ยน "resetEpoch" (เก็บใน DynamoDB แถว __SYSTEM__ เพื่อให้ไม่หายตอน server รีสตาร์ท)
//   3) ลบทุกห้อง/ตัวจับเวลา/รหัสล็อกอินที่ค้างในหน่วยความจำของ server
//   4) สั่ง client ทุกเครื่องที่ออนไลน์ผ่าน socket (force_reset) ให้ล้างข้อมูลในเครื่อง (ชื่อ, token, รหัสโฮสต์ ฯลฯ
//      — ทุกคีย์ที่ขึ้นต้น "ww_") แล้วเด้งกลับหน้าแรก ส่วนเครื่องที่ออฟไลน์อยู่ตอนนั้น จะล้างเองตอนเปิดเกมครั้งถัดไป
//      เพราะ resetEpoch ที่จำไว้ในเครื่องไม่ตรงกับของ server (ดู public/js/shared.reset-guard.js)
// ลำดับสำคัญ: ทำส่วน DynamoDB ก่อน ถ้าล้มเหลว (เช่น role ไม่มีสิทธิ์ลบ) จะหยุดทันที ยังไม่แตะห้อง/เครื่องผู้เล่นเลย
// ป้องกัน: ถ้าตั้ง env var ADMIN_RESET_PASSWORD ไว้ ต้องส่งรหัสนี้มาด้วย (แนะนำให้ตั้ง เพราะหน้า admin ไม่มี login)
const SYSTEM_PLAYER_KEY = "__SYSTEM__";
const RESET_EPOCH_STAT_KEY = "RESET_EPOCH";
// ล็อกส่วน reset ทั้งชุด: กัน room persistence เขียนข้อมูลกลับระหว่างกำลังล้าง
let resetInProgress = false;
// นับงานเขียนข้อมูลเกมที่ "เริ่มก่อน" reset เพื่อให้ reset รอจนงานเหล่านั้นจบก่อนล้างฐานข้อมูล
// ป้องกัน race แบบ: write เริ่มก่อน reset -> reset ล้าง -> write เดิมกลับมาเขียนหลังล้างอีกครั้ง
let activeGameDataWrites = 0;

function beginGameDataWrite() {
    if (resetInProgress) return false;
    activeGameDataWrites += 1;
    return true;
}

function endGameDataWrite() {
    activeGameDataWrites = Math.max(0, activeGameDataWrites - 1);
}

async function waitForGameDataWritesDrain(maxMs = 15000) {
    const startedAt = Date.now();
    while (activeGameDataWrites > 0) {
        if (Date.now() - startedAt >= maxMs) return false;
        await sleepMs(50);
    }
    return true;
}

let resetEpoch = null; // null = ยังโหลดไม่ได้
let resetEpochLoading = false;
let resetEpochLastTryAt = 0;

async function loadResetEpoch() {
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({
        TableName: ROOM_PERSISTENCE_TABLE,
        Key: { playerName: SYSTEM_PLAYER_KEY, statKey: RESET_EPOCH_STAT_KEY },
    }));
    // ไม่เคยกดล้างเลย = "0" (เครื่องที่ยังไม่เคยจำค่าไหนไว้ก็ถือเป็น "0" เหมือนกัน จึงไม่โดนล้างโดยไม่จำเป็น)
    resetEpoch = (out.Item && out.Item.value) ? String(out.Item.value) : "0";
}

function ensureResetEpochLoaded() {
    if (resetEpoch !== null || resetEpochLoading) return;
    if (Date.now() - resetEpochLastTryAt < 30_000) return; // ลองใหม่ไม่ถี่เกินไป
    resetEpochLoading = true;
    resetEpochLastTryAt = Date.now();
    loadResetEpoch()
        .catch((e) => console.error("[reset] โหลด resetEpoch จาก DynamoDB ไม่สำเร็จ:", e.name, e.message))
        .finally(() => { resetEpochLoading = false; });
}
ensureResetEpochLoaded();

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Guard a request that crosses an external/persistence boundary so an HTTP route cannot
// remain open until the CloudFront/Elastic Beanstalk gateway timeout. The original promise
// is deliberately observed after a timeout to prevent a late rejection from becoming an
// unhandled rejection while the browser has already moved on.
async function withTimeout(promise, timeoutMs, code, message) {
    const observed = Promise.resolve(promise);
    let timer = null;
    try {
        return await Promise.race([
            observed,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error(message), { code })), Math.max(1000, Number(timeoutMs) || 10000));
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        observed.catch(() => {});
    }
}

// ลบทุกแถวในตาราง (ยกเว้นแถวระบบ) — Scan เฉพาะคีย์ แล้ว BatchWrite ลบทีละ 25 แถว (ขีดจำกัดของ DynamoDB)
async function wipeRoomPersistenceTable() {
    const doc = await getDynamoDocClient();
    let deleted = 0;
    let lastKey;
    do {
        const page = await doc.send(new ScanCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            ProjectionExpression: "playerName, statKey",
            ExclusiveStartKey: lastKey,
        }));
        const keys = (page.Items || []).filter((it) => it.playerName !== SYSTEM_PLAYER_KEY);
        for (let i = 0; i < keys.length; i += 25) {
            let batch = keys.slice(i, i + 25).map((k) => ({
                DeleteRequest: { Key: { playerName: k.playerName, statKey: k.statKey } },
            }));
            const size = batch.length;
            try {
                await deleteTableItemsWithFallback(doc, batch.map((x) => x.DeleteRequest.Key));
            } catch (e) {
                throw e;
            }
            deleted += size;
        }
        lastKey = page.LastEvaluatedKey;
    } while (lastKey);
    return deleted;
}

// ล้างทุกอย่างที่ค้างในหน่วยความจำของ server (ห้อง, timer, รหัสล็อกอินที่ลองผิด)
// keepTesterRooms = true → "ห้องผู้ทดสอบ" (room.isTesterRoom) และทุกอย่างที่ผูกกับมัน (timer โหวต/จบเกม, timer รอผู้เล่นกลับมา,
// สถานะโฮสต์ socket, ตัวนับรหัสผิด) ถูกเก็บไว้ครบ — ใช้กับ "ปิดเซิร์ฟเวอร์/บังคับรีโหลด" (ดู closeAllRoomsSilently)
// ค่าเริ่มต้น false = ล้างหมดทุกห้อง (ใช้กับ /api/admin/reset ที่ล้างข้อมูลทั้งระบบเท่านั้น)
function wipeAllRoomsInMemory({ keepTesterRooms = false } = {}) {
    const keepIds = new Set();
    const keepTokens = new Set();
    Object.keys(rooms).forEach((id) => {
        const room = rooms[id];
        if (keepTesterRooms && isTesterRoom(room)) {
            keepIds.add(id);
            room.players.forEach((p) => keepTokens.add(p.token)); // รวมโทเค็นของบอท (ยังมีสิทธิ์ถูกสิง/รอต่อกลับ)
            return;
        }
        clearGameOverTimer(id);
        clearVoteTimer(id);
        delete rooms[id];
    });
    Object.keys(gameOverTimers).forEach((id) => { if (!keepIds.has(id)) clearGameOverTimer(id); });
    Object.keys(voteTimers).forEach((id) => { if (!keepIds.has(id)) clearVoteTimer(id); });
    Object.keys(pendingRemovals).forEach((t) => {
        const entry = pendingRemovals[t];
        if (keepIds.has(entry && entry.roomId)) return;
        clearTimeout(entry && entry.timer);
        delete pendingRemovals[t];
    });
    Object.keys(pendingIndicators).forEach((t) => {
        if (keepTokens.has(t)) return;
        clearTimeout(pendingIndicators[t]);
        delete pendingIndicators[t];
    });
    Object.keys(hostSocketRooms).forEach((k) => { if (!keepIds.has(hostSocketRooms[k])) delete hostSocketRooms[k]; });
    for (const id of [...roomLeaseEpochs.keys()]) {
        if (!keepIds.has(id)) {
            clearRoomLeaseRenewal(id);
            roomLeaseEpochs.delete(id);
        }
    }
    Object.keys(loginAttemptTracker).forEach((k) => {
        // คีย์รูปแบบ "host:<roomId>" / "join:<roomId>" (ดู isLoginAttemptAllowed) — เก็บของห้องที่รอดไว้
        const roomPart = String(k).split(":").slice(1).join(":");
        if (keepIds.has(roomPart)) return;
        delete loginAttemptTracker[k];
    });
    // สำคัญ: ห้ามปล่อย debounce timer ของห้องที่เพิ่งล้างไว้ ไม่งั้น timer รุ่นเก่าอาจพยายาม persist หลัง reset
    for (const [id, timer] of roomPersistenceTimers) {
        if (keepIds.has(id)) continue;
        clearTimeout(timer);
        roomPersistenceTimers.delete(id);
        roomPersistenceKnownIds.delete(id);
        roomPersistenceSignatures.delete(id);
    }
    if (!keepIds.size) {
        roomPersistenceKnownIds.clear();
        roomPersistenceSignatures.clear();
    }
    broadcastSuggestedRoom();
}

function countTesterRooms() {
    return Object.keys(rooms).filter((id) => isTesterRoom(rooms[id])).length;
}

// ปิด "ทุกห้องปกติที่กำลังเล่น/รออยู่" แบบเงียบ — ใช้ตอนแอดมินปิด/เปิดเซิร์ฟเวอร์ และตอนกดบังคับรีโหลดทุกแบบ
// ห้องผู้ทดสอบ (room.isTesterRoom — server ตัดสินจากบัตรผ่านตอนสร้างห้อง ไม่ใช่ค่าที่ client ส่งมา) "ไม่ถูกปิด" ห้อง/บอท/โทเค็นสิง/ผู้เล่นอยู่ครบ
// (ต่างจาก /api/admin/reset ด้านบน: ไม่แตะข้อมูลผู้เล่น/สถิติ/ประวัติ — แต่ลบ snapshot ของห้องปกติจาก room persistence เพื่อไม่ให้ฟื้นกลับมา)
//  ลบห้อง/ตัวจับเวลาที่ค้างในหน่วยความจำ และลบ snapshot ของห้องปกติจาก persistence เพื่อไม่ให้ฟื้นกลับมา
// ห้ามเรียก endGame/game result persistence ตรงนี้ → เกมที่ค้างอยู่ "ไม่นับเป็นเกมเลย" ไม่มีแพ้/ชนะ/ออกเกมเข้าประวัติของใคร
// ต้องเรียก "ก่อน" ที่ socket ถูกตัดเสมอ (ดู closeServerNow / force-reload) ไม่งั้น handler "disconnect" จะเห็นว่าห้องยังอยู่
// // ไม่ยิง room_closed ตั้งใจ: หน้าเกมจะขึ้นข้อความ "ห้องถูกปิด เนื่องจากผู้สร้างห้องออกจากเกม" ซึ่งไม่ตรงความจริง
// และหน้าโฮสต์จะดีดกลับ index เองทีละจอ — ให้ทุกเครื่องไปทางเดียวกันคือถูกพากลับหน้าแรกจาก event/epoch ของแอดมินแทน
// คืนจำนวน "ห้องที่ถูกปิดจริง" (ไม่นับห้องผู้ทดสอบที่รอด — ดู countTesterRooms)
async function closeAllRoomsSilently({ fast = false } = {}) {
    const ids = Object.keys(rooms).filter((id) => !isTesterRoom(rooms[id]));
    ids.forEach((id) => {
        // ให้ socket ที่ยังต่ออยู่ออกจากห้อง socket.io ของห้องนี้ด้วย — กัน socket เก่าค้างในห้องแล้วไปรับ broadcast
        // ของห้องใหม่ที่บังเอิญได้รหัสเดิมทีหลัง (เฉพาะห้องที่ถูกปิดจริง ห้องผู้ทดสอบไม่ถูกแตะ)
        try {
            io.socketsLeave(id);
            io.socketsLeave(hostRoomName(id));
        } catch (_) { /* ไม่เป็นไร */ }
    });

    // FAST PATH (force-reload): notification ต้องไม่รอ DynamoDB หรือจำนวนห้อง.
    // startNewSessionEpoch() เปลี่ยน roomResetAt ก่อนหน้านี้แล้ว จึงกัน snapshot รุ่นเก่าฟื้นกลับได้
    // แม้การลบ DynamoDB จะกำลังทำงานอยู่เบื้องหลัง.
    if (fast) {
        wipeAllRoomsInMemory({ keepTesterRooms: true });
        if (ROOM_PERSISTENCE_ENABLED && ids.length) {
            Promise.all(ids.map((id) => deletePersistedRoom(id).catch((e) => {
                console.error(`[room-persist] ลบ snapshot ห้อง ${id} แบบเบื้องหลังไม่สำเร็จ:`, e.name, e.message);
            }))).catch(() => {});
        }
        return ids.length;
    }

    // เส้นทางปกติยังรอ cleanup ให้เสร็จจริง เพื่อคง semantics เดิมของ server shutdown
    // และ call site อื่นที่ต้องการรอการลบ snapshot ก่อนดำเนินการต่อ.
    if (ROOM_PERSISTENCE_ENABLED) {
        await Promise.all(ids.map((id) => deletePersistedRoom(id).catch((e) => {
            console.error(`[room-persist] ลบ snapshot ห้อง ${id} ตอนปิดเซิร์ฟเวอร์ไม่สำเร็จ:`, e.name, e.message);
        })));
    }
    wipeAllRoomsInMemory({ keepTesterRooms: true });
    return ids.length;
}

// เริ่ม "เซสชันใหม่": เปลี่ยน reloadEpoch/reloadKind (มากับ /api/config) ให้ทุกเครื่องรู้ตัวว่าเซสชันเดิมจบแล้ว
// แม้เครื่องที่หลับ/ออฟไลน์ตอนกด ก็จะเจอเลขใหม่เองตอนกลับมาเช็ค /api/config แล้วถูกพากลับหน้าแรกตามกัน
function startNewSessionEpoch(kind) {
    const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    reloadEpoch = epoch;
    reloadKind = kind;
    roomResetAt = Date.now();
    return epoch;
}

const adminLoginRate = new Map();
const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
const ADMIN_LOGIN_BLOCK_MS = 15 * 60 * 1000;
function adminLoginClientKey(req) {
    return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 128);
}
function adminLoginAllowed(req) {
    const key = adminLoginClientKey(req);
    const now = Date.now();
    const old = adminLoginRate.get(key);
    if (!old || now - old.windowAt >= ADMIN_LOGIN_WINDOW_MS) {
        adminLoginRate.set(key, { windowAt: now, attempts: 0, blockedUntil: 0 });
        return { ok: true, retryAfterMs: 0 };
    }
    if (old.blockedUntil > now) return { ok: false, retryAfterMs: old.blockedUntil - now };
    if (old.attempts >= ADMIN_LOGIN_MAX_ATTEMPTS) {
        old.blockedUntil = now + ADMIN_LOGIN_BLOCK_MS;
        return { ok: false, retryAfterMs: ADMIN_LOGIN_BLOCK_MS };
    }
    return { ok: true, retryAfterMs: 0 };
}
function recordAdminLoginFailure(req) {
    const key = adminLoginClientKey(req);
    const now = Date.now();
    const old = adminLoginRate.get(key);
    if (!old || now - old.windowAt >= ADMIN_LOGIN_WINDOW_MS) {
        adminLoginRate.set(key, { windowAt: now, attempts: 1, blockedUntil: 0 });
        return;
    }
    old.attempts += 1;
    if (old.attempts >= ADMIN_LOGIN_MAX_ATTEMPTS) old.blockedUntil = now + ADMIN_LOGIN_BLOCK_MS;
    if (adminLoginRate.size > 5000) {
        for (const [k, v] of adminLoginRate) {
            if (now - Number(v.windowAt || 0) > ADMIN_LOGIN_WINDOW_MS && Number(v.blockedUntil || 0) <= now) adminLoginRate.delete(k);
        }
    }
}
function clearAdminLoginFailures(req) {
    adminLoginRate.delete(adminLoginClientKey(req));
}

app.get("/api/admin/session", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // ระหว่าง instance ใหม่กำลัง warm-up หรือกำลัง drain อย่าแปลงสถานะเป็น
    // "ยังไม่ได้ตั้งค่า Admin" เพราะนั่นทำให้ผู้ดูแลเข้าใจว่า env หายถาวร ทั้งที่เป็นช่วง deploy
    if (EB_ENVIRONMENT_NAME && (!appBootReady || !roomRecoveryHealthy || appDraining)) {
        return res.status(503).json({
            ok: false,
            required: true,
            authenticated: false,
            passwordEnabled: !!ADMIN_PANEL_PASSWORD,
            code: appDraining ? "ADMIN_SERVER_DRAINING" : "ADMIN_SERVER_WARMING",
        });
    }
    const principal = adminAuthRequired() ? getAdminPrincipal(req) : null;
    res.json({
        ok: true,
        required: adminAuthRequired(),
        authenticated: !!principal,
        tabScoped: !!principal?.tabScoped,
        provider: principal?.provider || "",
        email: principal?.email || "",
        expiresAt: Number(principal?.exp || 0),
        passwordEnabled: !!ADMIN_PANEL_PASSWORD,
        deploymentReady: adminAuthReadyForDeployment(),
    });
});

app.post("/api/admin/login", express.json({ limit: "2kb" }), (req, res) => {
    if (!ADMIN_AUTH_CONFIGURED) return res.status(503).json({ ok: false, error: "admin_auth_not_configured", code: "ADMIN_AUTH_NOT_CONFIGURED" });
        const limit = adminLoginAllowed(req);
    if (!limit.ok) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
        return res.status(429).json({ ok: false, error: "too_many_attempts", code: "ADMIN_LOGIN_RATE_LIMITED" });
    }
    const given = String(req.body?.password || "");
    const a = Buffer.from(given);
    const b = Buffer.from(ADMIN_PANEL_PASSWORD);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!valid) {
        recordAdminLoginFailure(req);
        return res.status(403).json({ ok: false, error: given ? "wrong_password" : "password_required", code: given ? "ADMIN_WRONG_PASSWORD" : "ADMIN_PASSWORD_REQUIRED" });
    }
    clearAdminLoginFailures(req);
    const tabId = sanitizeAdminTabId(req.body?.tabId);
    if (!tabId) return res.status(400).json({ ok:false, error:"admin_tab_id_required", code:"ADMIN_TAB_ID_REQUIRED" });
    const token = createAdminSessionToken({ provider:"password", tabId });
    if (!token) return res.status(503).json({ ok:false, error:"admin_session_create_failed", code:"ADMIN_SESSION_CREATE_FAILED" });
    res.json({ ok:true, required:true, authenticated:true, tabScoped:true, provider:"password", token, tabId, expiresAt:Date.now()+ADMIN_TAB_SESSION_TTL_MS });
});

app.post("/api/admin/logout", (req, res) => {
    const principal = getAdminPrincipal(req);
    if (principal?.tabScoped && principal.n) {
        adminTabSessionRevoked.set(String(principal.n), Number(principal.exp || Date.now() + ADMIN_TAB_SESSION_TTL_MS));
        if (adminTabSessionRevoked.size > 5000) {
            const now = Date.now();
            for (const [key, exp] of adminTabSessionRevoked) if (Number(exp || 0) <= now) adminTabSessionRevoked.delete(key);
        }
    }
    clearHttpOnlyCookie(res, ADMIN_SESSION_COOKIE, adminSessionCookieSecure(req));
    res.json({ ok: true });
});

app.post("/api/admin/reset", express.json({ limit: "2kb" }), async (req, res) => {
    const body = req.body || {};
    if (body.confirm !== "RESET") {
        return res.status(400).json({ error: "confirm_required" });
    }
    const requiredPassword = ADMIN_PANEL_PASSWORD;
    if (requiredPassword && !isAdminSessionValid(req)) {
        const given = String(body.password || "");
        const a = Buffer.from(given);
        const b = Buffer.from(String(requiredPassword));
        const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
        if (!valid) return res.status(403).json({ error: given ? "wrong_password" : "password_required" });
    }
    if (resetInProgress) {
        return res.status(409).json({ error: "reset_in_progress" });
    }
    await serverStateReady;
    resetInProgress = true;
    // Admin must invalidate any live room/presence snapshot immediately. A reset can run while
    // background polling/room screens are still open, so waiting for the final epoch event
    // would leave a short window where stale room data can reappear.
    io.sockets.sockets.forEach((s) => {
        if (s.data && s.data.isAdmin) {
            try { s.emit("admin_reset_started", { resetEpoch: resetEpoch || "" }); } catch (_) {}
        }
    });
    const writesDrained = await waitForGameDataWritesDrain(15000);
    if (!writesDrained) {
        console.error(`[reset] ยังมีงานเขียนข้อมูลเกมค้าง ${activeGameDataWrites} งานเกินเวลารอ — ยกเลิก reset เพื่อไม่ให้ล้างครึ่งเดียว`);
        return res.status(503).json({ error: "game_data_write_drain_timeout", activeWrites: activeGameDataWrites });
    }
        // ยกเลิก snapshot debounce ของทุกห้องตั้งแต่ต้น ไม่ให้ timer เก่ามีสิทธิ์เขียนกลับเข้าฐานข้อมูล
    for (const timer of roomPersistenceTimers.values()) clearTimeout(timer);
    roomPersistenceTimers.clear();
    roomPersistenceKnownIds.clear();
    roomPersistenceSignatures.clear();
    try {
        // 1) DynamoDB — ถ้าพังตรงนี้ หยุดทันที (ยังไม่แตะห้อง/เครื่องผู้เล่น) แก้สิทธิ์แล้วกดใหม่ได้
        let deletedRows;
        try {
            deletedRows = await wipeRoomPersistenceTable();
        } catch (e) {
            console.error("[reset] ลบข้อมูลใน DynamoDB ล้มเหลว:", e.name, e.message);
            return res.status(500).json({ error: "db_wipe_failed", detail: `${e.name}: ${e.message}` });
        }

        // 2) ล้าง room persistence ให้เรียบร้อยก่อนเปลี่ยน resetEpoch — ถ้าฐานข้อมูลห้องล้มเหลวจะยังไม่
        // เปลี่ยน epoch/ล้างห้องใน RAM เพื่อไม่ให้ reset สำเร็จแค่ครึ่งเดียวและห้องเก่ากลับมาอีกตอน restart
        if (ROOM_PERSISTENCE_ENABLED) {
            try {
                const removedRoomSnapshots = await clearAllPersistedRoomSnapshots();
                console.log(`[reset] ลบ room snapshots ถาวร ${removedRoomSnapshots} ห้องแล้ว`);
            } catch (e) {
                console.error("[reset] ล้าง room persistence ล้มเหลว:", e.name, e.message);
                return res.status(500).json({ error: "room_persistence_wipe_failed", detail: `${e.name}: ${e.message}` });
            }
        }

        try {
            const deletedRowsFinal = await wipeRoomPersistenceTable();
            deletedRows += deletedRowsFinal;
        } catch (e) {
            console.error("[reset] ล้างฐานข้อมูลรอบยืนยันผลล้มเหลว:", e.name, e.message);
            return res.status(500).json({ error: "db_final_wipe_failed", detail: `${e.name}: ${e.message}` });
        }

        // 3) บันทึก epoch ใหม่ลง DynamoDB (ให้คงอยู่แม้ server รีสตาร์ท)
        const newEpoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        try {
            const doc = await getDynamoDocClient();
            await doc.send(new PutCommand({
                TableName: ROOM_PERSISTENCE_TABLE,
                Item: { playerName: SYSTEM_PLAYER_KEY, statKey: RESET_EPOCH_STAT_KEY, value: newEpoch, at: new Date().toISOString() },
            }));
        } catch (e) {
            console.error("[reset] บันทึก resetEpoch ล้มเหลว:", e.name, e.message);
            return res.status(500).json({ error: "epoch_save_failed", detail: `${e.name}: ${e.message}` });
        }

        // 4) สลับ epoch ในหน่วยความจำ + ล้างห้องทั้งหมด + สั่งทุกเครื่องที่ออนไลน์ให้ล้างตัวตน
        const closedRooms = Object.keys(rooms).length;
        resetEpoch = newEpoch;
        roomResetAt = Date.now();
        reloadEpoch = "";
        reloadKind = "";
        reloadEpochTouchedByAdmin = true;
            wipeAllRoomsInMemory();
        let statePersisted = true;
        try { await saveServerState(); } catch (e) {
            statePersisted = false;
            console.error("[reset] บันทึกสถานะหลังล้างข้อมูลไม่สำเร็จ:", e.name, e.message);
        }
        // Admin ไม่ต้องถูก reset แต่ต้องถูกแจ้งให้ทิ้ง state/requests รุ่นเก่า
        // ส่วน socket เกม/ทดสอบทั้งหมดถูก mark เป็น pre-reset ก่อนส่ง force_reset
        io.sockets.sockets.forEach((s) => {
            if (s.data && s.data.isAdmin) {
                try { s.emit("admin_reset_completed", { epoch: newEpoch }); } catch (_) {}
                return;
            }
            s.data = s.data || {};
            s.data.resetInvalidated = true;
            s.data.resetEpoch = newEpoch;
            try { s.emit("force_reset", { epoch: newEpoch }); } catch (_) {}
        });

        console.log(`[reset] ล้างข้อมูลเกมทั้งหมดแล้ว: ลบ ${deletedRows} แถวใน DynamoDB, ปิด ${closedRooms} ห้อง, epoch=${newEpoch}`);
        res.json({ ok: true, deletedRows, closedRooms, epoch: newEpoch, statePersisted });
    } finally {
        resetInProgress = false;
    }
});

// ============================================================
// ADMIN — เปิด/ปิดเซิร์ฟเวอร์ + บังคับทุกคนรีโหลด (ปุ่มในหน้า admin.html แท็บ "จัดการระบบ")
// ============================================================
// ตัวแปรสถานะ + ด่านกัน (HTTP + socket) อยู่ด้านบนสุดของไฟล์ (หัวข้อเดียวกัน) ตรงนี้คือ
//   1) บันทึก/โหลดสถานะจาก DynamoDB แถว __SYSTEM__ / SERVER_STATE (ปิดอยู่หรือไม่ + imageEpoch)
//      ใช้ตารางห้อง/สถานะเดียวกับ resetEpoch — ไม่ต้องเพิ่ม IAM
//      /api/admin/reset ไม่ลบแถว __SYSTEM__ (ดู wipeRoomPersistenceTable) และไม่มีตารางประวัติผู้เล่นแล้ว จึงไม่ปนข้อมูลผู้เล่น
//   2) POST /api/admin/server-open  { open: true|false, closeAt?, message?, reopenAt? }
//        - closeAt / reopenAt เป็น epoch ms (หรือสตริงวันที่ที่ Date.parse อ่านได้) ของ "เวลาจริง" ที่จะปิด/คาดว่าจะเปิด ไม่ใช่ตัวเลขนับถอยหลังอีกต่อไป
//        - open:false + closeAt ในอนาคต (เกิน ~1.5 วิจากตอนนี้) → "ตั้งเวลาปิดล่วงหน้า" (ดู closingPlan/armClosingPlan) ยังไม่ปิดจริงจนกว่าจะถึงเวลา
//          ตั้งซ้ำระหว่างนับถอยหลังอยู่ = แทนที่ของเดิม ใช้ปรับเวลาปิดให้ไวขึ้น/ถอยออกได้ (ทั้งวันที่และเวลา)
//        - open:false + ไม่ส่ง closeAt หรือ closeAt ใกล้ตอนนี้/เป็นอดีต → ปิดทันที
//        - open:false ตอนปิดอยู่แล้ว → แก้ข้อความ/เวลาที่คาดว่าจะเปิด (reopenAt) อย่างเดียว (ไม่ยุ่งกับห้อง/epoch)
//        - กำหนดการปิดที่ตั้งล่วงหน้ายังไม่ถึงเวลา จะถูกบันทึกลง DB ด้วย (planCloseAt ฯลฯ) กันหายถ้าเซิร์ฟเวอร์รีสตาร์ท/deploy ระหว่างรอ
//   3) POST /api/admin/server-close-cancel — ยกเลิกการนับถอยหลังปิด
//   4) POST /api/admin/force-reload { kind: "files" | "images" | "both" }
// ป้องกันด้วยรหัสเดียวกับปุ่มล้างข้อมูล: ถ้าตั้ง env var ADMIN_RESET_PASSWORD ไว้ ต้องส่ง password มาด้วย
const SERVER_STATE_STAT_KEY = "SERVER_STATE";
const SERVER_STATE_AUTHORITY_CACHE_MS = 1500;
const serverStateAuthorityCache = {
    at: 0,
    state: null,
    inFlight: null,
};

async function readAuthoritativeServerState({ force = false } = {}) {
    const now = Date.now();
    if (!force && serverStateAuthorityCache.state && now - serverStateAuthorityCache.at < SERVER_STATE_AUTHORITY_CACHE_MS) {
        return serverStateAuthorityCache.state;
    }
    if (serverStateAuthorityCache.inFlight) return serverStateAuthorityCache.inFlight;

    serverStateAuthorityCache.inFlight = loadServerState()
        .then((state) => {
            serverStateAuthorityCache.at = Date.now();
            serverStateAuthorityCache.state = state;
            return state;
        })
        .catch((e) => {
            console.error("[server-control] อ่าน SERVER_STATE แบบ authoritative ไม่สำเร็จ:", e.name, e.message);
            return null;
        })
        .finally(() => {
            serverStateAuthorityCache.inFlight = null;
        });

    return serverStateAuthorityCache.inFlight;
}

function cacheCurrentServerState() {
    serverStateAuthorityCache.at = Date.now();
    serverStateAuthorityCache.state = {
        closed: serverClosed === true,
        imageEpoch: imageEpoch || "",
        reloadEpoch: reloadEpoch || "",
        reloadKind: reloadKind || "",
        testerReloadEpoch: testerReloadEpoch || "",
        message: serverClosed ? (closedMessage || "") : "",
        reopenAt: serverClosed ? (closedReopenAt || 0) : 0,
        planCloseAt: !serverClosed && closingPlan ? closingPlan.closeAt : 0,
        planMessage: !serverClosed && closingPlan ? (closingPlan.message || "") : "",
        planReopenAt: !serverClosed && closingPlan ? (closingPlan.reopenAt || 0) : 0,
        roomResetAt: roomResetAt || 0,
        testerPassSecret: "",
    };
}

async function syncServerStateFromAuthority(options = {}) {
    const persisted = await readAuthoritativeServerState(options);
    if (!persisted) return null;

    // คำสั่งจาก Admin บน instance นี้ต้องมีสิทธิ์ชนะค่าที่อ่านมาจาก DB จนกว่าจะบันทึกเสร็จ
    // instance อื่นที่ไม่มี local admin mutation จะค่อย ๆ sync ตาม row เดียวกันเอง
    if (!serverOpenTouchedByAdmin) {
        const persistedClosed = persisted.closed === true;
        if (persistedClosed && !serverClosed) {
            closedMessage = persisted.message || "";
            closedReopenAt = persisted.reopenAt || 0;
            closeServerNow();
            await closeAllRoomsSilently({ fast: true });
        } else if (!persistedClosed && serverClosed) {
            // Instance นี้รู้ตัวช้า หลังอีก instance เปิดคืนแล้ว: จบ session เดิมให้ตรงกับ
            // roomResetAt/reloadEpoch ใน DB ก่อนเปิดรับ public traffic ต่อ เพื่อไม่ให้ห้องเก่าฟื้นกลับมา
            await closeAllRoomsSilently({ fast: true });
            serverClosed = false;
            closedMessage = "";
            closedReopenAt = 0;
            clearClosingPlan();
        }
    }

    if (!reloadEpochTouchedByAdmin) {
        reloadEpoch = persisted.reloadEpoch || "";
        reloadKind = persisted.reloadKind || "";
    }
    testerReloadEpoch = persisted.testerReloadEpoch || testerReloadEpoch;
    if (!imageEpochTouchedByAdmin && persisted.imageEpoch) imageEpoch = persisted.imageEpoch;
    if (persisted.roomResetAt > roomResetAt) roomResetAt = persisted.roomResetAt;

    if (!serverClosed && persisted.planCloseAt > 0) {
        if (persisted.planCloseAt <= Date.now()) {
            // กำหนดการเก่าหมดเวลาแล้ว → ให้ state machine ปิดจริงผ่าน path เดียวกับตอนบูต
            await performServerClose({ message: persisted.planMessage, reopenAt: persisted.planReopenAt });
        } else if (!closingPlan) {
            armClosingPlan(persisted.planCloseAt, persisted.planMessage, persisted.planReopenAt);
        }
    } else if (serverClosed || persisted.planCloseAt <= 0) {
        if (closingPlan) clearClosingPlan();
    }

    return persisted;
}

async function loadServerState() {
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({
        TableName: ROOM_PERSISTENCE_TABLE,
        Key: { playerName: SYSTEM_PLAYER_KEY, statKey: SERVER_STATE_STAT_KEY },
    }));
    const it = out.Item || {};
    return {
        closed: it.closed === true,
        imageEpoch: it.imageEpoch ? String(it.imageEpoch) : "",
        reloadEpoch: it.reloadEpoch ? String(it.reloadEpoch) : "",
        reloadKind: it.reloadKind ? String(it.reloadKind) : "",
        testerReloadEpoch: it.testerReloadEpoch ? String(it.testerReloadEpoch) : "",
        message: typeof it.closedMessage === "string" ? it.closedMessage : "",
        reopenAt: Number(it.closedReopenAt) > 0 ? Number(it.closedReopenAt) : 0,
        testerPassSecret: typeof it.testerPassSecret === "string" ? it.testerPassSecret : "",
        // กำหนดการ "จะปิดตอนไหน" ที่ยังไม่ถึงเวลาจริง (ตั้งไว้ล่วงหน้าเป็นวันที่/เวลา) — เก็บแยกจาก closed/closedMessage ด้านบน
        // เพื่อให้รอดจากเซิร์ฟเวอร์รีสตาร์ท/deploy ระหว่างที่ยังนับถอยหลังอยู่ (ดู initServerState)
        planCloseAt: Number(it.planCloseAt) > 0 ? Number(it.planCloseAt) : 0,
        planMessage: typeof it.planMessage === "string" ? it.planMessage : "",
        planReopenAt: Number(it.planReopenAt) > 0 ? Number(it.planReopenAt) : 0,
        roomResetAt: Number(it.roomResetAt) > 0 ? Number(it.roomResetAt) : 0,
    };
}

let testerPassSecretReadyPromise = null;
let testerPassSecretPersistent = false;

// ทำให้ secret ของ Tester เป็นค่าเดียวกันทุก Elastic Beanstalk instance/restart
// โดยให้ DynamoDB เป็น source of truth และใช้ conditional write แบบ atomic ตอนที่ยังไม่มีค่า
// ห้ามใช้ PutCommand เขียน SERVER_STATE ทับ testerPassSecret จากค่าที่แต่ละ instance สุ่มเอง
// เพราะช่วง Immutable/rolling deploy อาจมีหลาย instance เริ่มพร้อมกันและแต่ละตัวสุ่มคนละ secret
// ผลคือบัตร ?tp ที่ออกจาก instance A ใช้กับ instance B ไม่ได้ → tester join_room ถูกปฏิเสธ
// จึงต้องใช้ secret ที่แชร์ร่วมกันทั้ง deployment
async function ensureTesterPassSecretPersistent(knownSecret = "") {
    if (TESTER_PASS_SECRET_ENV) {
        testerPassSecret = TESTER_PASS_SECRET_ENV;
        testerPassSecretPersistent = true;
        return testerPassSecret;
    }
    const known = String(knownSecret || "").trim();
    if (known) {
        testerPassSecret = known;
        testerPassSecretPersistent = true;
        return testerPassSecret;
    }
    if (testerPassSecret && testerPassSecretPersistent) return testerPassSecret;
    if (testerPassSecretReadyPromise) return testerPassSecretReadyPromise;

    testerPassSecretReadyPromise = (async () => {
        const doc = await getDynamoDocClient();
        const key = { playerName: SYSTEM_PLAYER_KEY, statKey: SERVER_STATE_STAT_KEY };

        const readCurrent = async () => {
            const out = await doc.send(new GetCommand({
                TableName: ROOM_PERSISTENCE_TABLE,
                Key: key,
                ConsistentRead: true,
            }));
            const value = typeof out.Item?.testerPassSecret === "string" ? out.Item.testerPassSecret.trim() : "";
            return value;
        };

        let current = await readCurrent();
        if (current) {
            testerPassSecret = current;
            testerPassSecretPersistent = true;
            return testerPassSecret;
        }

        const candidate = crypto.randomBytes(32).toString("hex");
        try {
            await doc.send(new UpdateCommand({
                TableName: ROOM_PERSISTENCE_TABLE,
                Key: key,
                UpdateExpression: "SET #secret = :secret, #at = :at",
                ExpressionAttributeNames: { "#secret": "testerPassSecret", "#at": "at" },
                ExpressionAttributeValues: { ":secret": candidate, ":at": new Date().toISOString() },
                ConditionExpression: "attribute_not_exists(#secret)",
            }));
            testerPassSecret = candidate;
            testerPassSecretPersistent = true;
            return testerPassSecret;
        } catch (e) {
            const code = String(e?.name || e?.code || "");
            if (code !== "ConditionalCheckFailedException") throw e;
            current = await readCurrent();
            if (!current) throw new Error("TESTER_PASS_SECRET_RACE_LOST_WITHOUT_WINNER");
            testerPassSecret = current;
            testerPassSecretPersistent = true;
            return testerPassSecret;
        }
    })();

    try {
        return await testerPassSecretReadyPromise;
    } finally {
        testerPassSecretReadyPromise = null;
    }
}

async function saveServerState() {
    const doc = await getDynamoDocClient();
    const hasPendingPlan = !serverClosed && !!closingPlan;
    // ใช้ UpdateCommand ไม่ใช่ PutCommand เพื่อไม่ลบ testerPassSecret ที่ถูก bootstrap แบบ atomic
    // และเพื่อไม่ให้ instance หนึ่งเขียนทับ secret ที่ instance อื่นเป็นผู้ชนะ race
    // ทุก field ด้านล่างเป็น mutable server-control state; testerPassSecret จงใจไม่อยู่ในชุดนี้
    // เพราะมันเป็น credential ระดับ environment/process ที่ต้องคงค่าเดิมข้าม deploy ทุก instance
    await doc.send(new UpdateCommand({
        TableName: ROOM_PERSISTENCE_TABLE,
        Key: { playerName: SYSTEM_PLAYER_KEY, statKey: SERVER_STATE_STAT_KEY },
        UpdateExpression: [
            "SET #closed = :closed",
            "#reloadEpoch = :reloadEpoch",
            "#reloadKind = :reloadKind",
            "#testerReloadEpoch = :testerReloadEpoch",
            "#imageEpoch = :imageEpoch",
            "#closedMessage = :closedMessage",
            "#closedReopenAt = :closedReopenAt",
            "#planCloseAt = :planCloseAt",
            "#planMessage = :planMessage",
            "#planReopenAt = :planReopenAt",
            "#roomResetAt = :roomResetAt",
            "#at = :at"
        ].join(", "),
        ExpressionAttributeNames: {
            "#closed": "closed",
            "#reloadEpoch": "reloadEpoch",
            "#reloadKind": "reloadKind",
            "#testerReloadEpoch": "testerReloadEpoch",
            "#imageEpoch": "imageEpoch",
            "#closedMessage": "closedMessage",
            "#closedReopenAt": "closedReopenAt",
            "#planCloseAt": "planCloseAt",
            "#planMessage": "planMessage",
            "#planReopenAt": "planReopenAt",
            "#roomResetAt": "roomResetAt",
            "#at": "at",
        },
        ExpressionAttributeValues: {
            ":closed": serverClosed,
            ":reloadEpoch": reloadEpoch || "",
            ":reloadKind": reloadKind || "",
            ":testerReloadEpoch": testerReloadEpoch || "",
            ":imageEpoch": imageEpoch || "",
            ":closedMessage": serverClosed ? closedMessage : "",
            ":closedReopenAt": serverClosed ? closedReopenAt : 0,
            ":planCloseAt": hasPendingPlan ? closingPlan.closeAt : 0,
            ":planMessage": hasPendingPlan ? closingPlan.message : "",
            ":planReopenAt": hasPendingPlan ? closingPlan.reopenAt : 0,
            ":roomResetAt": roomResetAt || 0,
            ":at": new Date().toISOString(),
        },
    }));
    cacheCurrentServerState();
}

function playerSockets() {
    return [...io.sockets.sockets.values()].filter((s) => !(s.data && s.data.isAdmin));
}

// ปิด: บอกทุกคนก่อน (server_closed → หน้าเกมขึ้นจอเต็ม "เซิร์ฟเวอร์กำลังปิด") แล้วค่อยตัด socket หลังผ่านไป 0.8 วิ
// เพื่อให้ event ถึงเครื่องก่อนแน่ๆ — ถ้าแอดมินเปิดคืนภายใน 0.8 วิ จะไม่ตัดใคร
// ฟังก์ชันนี้ "ไม่ปิดห้อง" เอง (ถูกเรียกตอนบูตด้วย ถ้า DB บอกว่าปิดค้างไว้ — ตอนนั้นไม่มีห้องอยู่แล้ว) — ตัวจัดการปุ่ม
// POST /api/admin/server-open เป็นคนเรียก closeAllRoomsSilently() ต่อทันทีหลังฟังก์ชันนี้ (ก่อนที่ socket จะถูกตัดจริง)
// socket ที่ "ได้รับการคุ้มครอง" (isProtectedSocket: อยู่ในห้องผู้ทดสอบ หรือถือบัตรผ่านและไม่ได้อยู่ในห้องปกติ)
// ไม่ถูกส่ง server_closed / ไม่ถูกตัดการเชื่อมต่อ — ห้อง/บอท/การสิงของเขายังเล่นต่อได้ตามปกติ
function isTesterSocket(s) {
    return isProtectedSocket(s);
}
function closeServerNow() {
    serverClosed = true;
    // ตัดสินตอนนี้ (ก่อน closeAllRoomsSilently) — ผู้ถือบัตรที่อยู่ในห้องปกติยังเห็นสถานะ "อยู่ห้องปกติ" ถูกปิดตามห้อง
    const targets = playerSockets().filter((s) => !isTesterSocket(s));
    // แนบข้อความ/เวลาที่คาดว่าจะเปิดไปด้วย ให้จอ "กำลังปิด" โชว์ได้ทันที (ไม่ต้องรอโพล /api/config)
    targets.forEach((s) => { try { s.emit("server_closed", { message: closedMessage, reopenAt: closedReopenAt, now: Date.now(), testerShielded: false }); } catch (_) { /* ไม่เป็นไร */ } });
    // เก็บ id ไว้ตัดหลัง 0.8 วิ (ห้องปกติถูกปิดไปแล้วตอนนั้น จะเช็คสมาชิกห้องซ้ำไม่ได้) — ตัดเฉพาะกลุ่มที่ตัดสินไว้ตอนนี้ และยังต้องไม่ได้รับการคุ้มครอง
    // ณ ตอนนั้น (เช่นเพิ่งเข้าห้องผู้ทดสอบภายใน 0.8 วิ)
    const kickIds = targets.map((s) => s.id);
    setTimeout(() => {
        if (!serverClosed) return;
        kickIds.forEach((id) => {
            const s = io.sockets.sockets.get(id);
            if (!s || (s.data && s.data.isAdmin)) return;
            if (socketRoomKind(s) === "tester") return;
            try { s.disconnect(true); } catch (_) { /* ไม่เป็นไร */ }
        });
    }, 800);
    return targets.length;
}

// โหลดสถานะตอนบูต — ล้มเหลว (เช่น ยังไม่ให้สิทธิ์/ตารางไม่มี) = ถือว่าเปิดตามปกติ (fail-open: DB พังต้องไม่ทำให้ทั้งเกมเข้าไม่ได้)
// แต่ยังลองใหม่เป็นระยะ ถ้าโหลดได้ทีหลังแล้วพบว่า "ควรปิดอยู่" ก็ปิดตามนั้น (ยกเว้นแอดมินสั่งเองไปแล้วหลังบูต)
(async function initServerState() {
    let released = false;
    const release = () => { if (!released) { released = true; serverStateResolve(); } };
    setTimeout(release, 3000); // ไม่ยอมให้ทุก request รอ DynamoDB เกิน 3 วิ
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const st = await loadServerState();
            // Secret ของ Tester ต้องคงเดิมข้าม deploy/restart และต้องเป็นค่าเดียวกันทุก instance
            // ถ้าไม่มีค่าใน DB ให้สร้างด้วย conditional write แบบ atomic ก่อนจึงอนุญาตให้แจกบัตรใหม่
            await ensureTesterPassSecretPersistent(st.testerPassSecret);
            if (!reloadEpochTouchedByAdmin) {
                reloadEpoch = st.reloadEpoch || "";
                reloadKind = st.reloadKind || "";
            }
            testerReloadEpoch = st.testerReloadEpoch || testerReloadEpoch;
            if (!imageEpochTouchedByAdmin) imageEpoch = st.imageEpoch;
            roomResetAt = st.roomResetAt || roomResetAt;
            if (!serverOpenTouchedByAdmin && st.closed && !serverClosed) {
                closedMessage = st.message;
                closedReopenAt = st.reopenAt;
                const kicked = closeServerNow();
                console.log(`[server-control] สถานะที่บันทึกไว้คือ "ปิดอยู่" → ปิดเซิร์ฟเวอร์ต่อ (ตัดการเชื่อมต่อ ${kicked} เครื่อง)`);
            } else if (!serverOpenTouchedByAdmin && !st.closed && st.planCloseAt > 0 && !serverClosed) {
                // มีกำหนดการปิดที่ตั้งไว้ล่วงหน้าค้างอยู่ตอนที่เซิร์ฟเวอร์ล่ม/รีสตาร์ท/deploy
                if (st.planCloseAt <= Date.now()) {
                    // เลยเวลาที่ตั้งไว้ไปแล้วระหว่างที่หายไป → ปิดตามกำหนดการเดิมทันที
                    performServerClose({ message: st.planMessage, reopenAt: st.planReopenAt })
                        .then((r) => console.log(`[server-control] กำหนดการปิดที่ตั้งไว้ก่อนรีสตาร์ทเลยเวลาไปแล้ว → ปิดเซิร์ฟเวอร์ทันที (ตัดการเชื่อมต่อ ${r.kicked} เครื่อง, ปิดห้อง ${r.closedRooms} ห้อง)`))
                        .catch((e) => console.error("[server-control] ปิดเซิร์ฟเวอร์ตามกำหนดการเดิมหลังบูตล้มเหลว:", e));
                } else {
                    armClosingPlan(st.planCloseAt, st.planMessage, st.planReopenAt);
                    console.log(`[server-control] กู้คืนกำหนดการปิดเซิร์ฟเวอร์ที่ตั้งไว้ก่อนรีสตาร์ท (จะปิดใน ${Math.round((st.planCloseAt - Date.now()) / 1000)} วิ)`);
                }
            }
            // ensureTesterPassSecretPersistent() เป็นผู้เขียน secret เข้าสู่ DB แบบ atomic แล้ว
            // จึงไม่ต้องใช้ saveServerState() ทับ SERVER_STATE เพื่อเก็บ secret อีกต่อไป
            release();
            return;
        } catch (e) {
            console.error("[server-control] โหลดสถานะเปิด/ปิดจาก DynamoDB ไม่สำเร็จ:", e.name, e.message);
            release();
            await sleepMs(10_000);
        }
    }
})();

function checkAdminPassword(req, res) {
    const required = ADMIN_PANEL_PASSWORD;
    if (!required || isAdminSessionValid(req)) return true;
    const given = (req.body && req.body.password) || "";
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(required));
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!valid) {
        res.status(403).json({ error: given ? "wrong_password" : "password_required" });
        return false;
    }
    return true;
}

// ----------------------------------------------------------------
// ปิดแบบนับถอยหลัง + ประกาศข้อความ/เวลาที่คาดว่าจะเปิด
// ----------------------------------------------------------------
// แอดมินตั้งได้ว่า "จะปิดเมื่อไหร่" (closeAt — วันที่/เวลาจริง) + ข้อความถึงผู้เล่น (message) + "คาดว่าจะเปิดเมื่อไหร่" (reopenAt — วันที่/เวลาจริง)
//   ระหว่างรอถึงเวลาปิด: เซิร์ฟเวอร์ยังเปิด เล่นได้ตามปกติ แต่ทุกเครื่องเห็นแถบเตือน "จะปิดใน mm:ss" (socket server_closing + /api/config
//   closingInMs — เครื่องที่ไม่ได้ต่อ socket เช่นหน้าแรก จะเห็นจากการโพล /api/config) ถึงเวลา → ปิดจริง (performServerClose)
//   ยกเลิกได้ก่อนถึงเวลา (server_closing_cancelled) · ตั้งใหม่ซ้ำระหว่างรอ = แทนที่ของเดิม (ปรับเวลาปิดไวขึ้น/ถอยออกได้) · เปิดคืนระหว่างรอ = ยกเลิก
const MAX_NOTICE_LEN = 200;
// วันที่/เวลาที่แอดมินเลือกเป็นแบบ "เวลาจริง" (absolute) ไม่ใช่ "อีกกี่วิ/นาที" (relative) อีกต่อไป
// MAX_CLOSE_AHEAD_MS: เพดานปลอดภัยของ "ปิดล่วงหน้าได้ไกลแค่ไหน" — ต้องต่ำกว่าขีดจำกัด setTimeout ของ Node
//   (ค่าดีเลย์เกิน 2^31-1 ms ~24.855 วัน จะโดนตัดกลายเป็นยิงทันทีแบบเงียบๆ) 14 วันเผื่อระยะปลอดภัยไว้มาก
const MAX_CLOSE_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;   // 14 วัน
// MAX_REOPEN_AHEAD_MS: "เวลาที่คาดว่าจะเปิด" เป็นแค่ข้อความโชว์ให้ผู้เล่นเห็น ไม่ได้ผูกกับตัวจับเวลาจริง เพดานนี้กันพิมพ์ผิดเป็นปีหน้าเท่านั้น
const MAX_REOPEN_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;  // 60 วัน
// เวลาปิดที่เลือกไว้ใกล้ "ตอนนี้" กว่านี้ (รวมถึงเว้นว่าง/เป็นอดีต) ถือว่า "ปิดทันที"
const CLOSE_IMMEDIATE_THRESHOLD_MS = 1500;

// รับได้ทั้ง epoch ms (number) และสตริงวันที่ (เช่นจาก <input type="datetime-local"> ที่ client แปลงเป็น ISO local แล้ว)
function parseEpochMs(v) {
    if (v === undefined || v === null || v === "") return 0;
    const n = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function parseCloseNotice(body) {
    body = body || {};
    const message = typeof body.message === "string"
        ? body.message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NOTICE_LEN)
        : "";
    const now = Date.now();

    let reopenAt = parseEpochMs(body.reopenAt);
    if (reopenAt && reopenAt - now > MAX_REOPEN_AHEAD_MS) reopenAt = now + MAX_REOPEN_AHEAD_MS;
    if (reopenAt && reopenAt <= now) reopenAt = 0; // เผื่อพลาดเลือกเวลาที่เป็นอดีตไปแล้ว ถือว่าไม่ระบุ แทนที่จะ error

    let closeAt = parseEpochMs(body.closeAt);
    if (closeAt && closeAt - now > MAX_CLOSE_AHEAD_MS) closeAt = now + MAX_CLOSE_AHEAD_MS;
    const immediate = !closeAt || (closeAt - now) <= CLOSE_IMMEDIATE_THRESHOLD_MS;

    return { message, reopenAt, closeAt: immediate ? 0 : closeAt, immediate };
}

function clearClosingPlan() {
    if (closingPlan) {
        clearTimeout(closingPlan.timer);
        closingPlan = null;
    }
}

// ตั้ง/แทนที่แผนนับถอยหลังปิด — ใช้ทั้งตอนแอดมินกดตั้งเวลา (หรือปรับเวลาใหม่ระหว่างนับถอยหลังอยู่)
// และตอนบูตแล้วพบว่ามีกำหนดการที่บันทึกไว้ก่อนรีสตาร์ท/deploy (ดู initServerState ด้านล่าง)
function armClosingPlan(closeAt, message, reopenAt) {
    clearClosingPlan();
    const plan = { closeAt, message: message || "", reopenAt: reopenAt || 0, timer: null };
    plan.timer = setTimeout(() => {
        if (closingPlan !== plan) return; // ถูกยกเลิก/แทนที่ไปแล้ว
        performServerClose({ message: plan.message, reopenAt: plan.reopenAt })
            .then((r) => console.log(`[server-control] ถึงเวลาที่ตั้งไว้ → ปิดเซิร์ฟเวอร์ (ตัดการเชื่อมต่อ ${r.kicked} เครื่อง, ปิดห้อง ${r.closedRooms} ห้อง, บันทึก DB ${r.persisted ? "สำเร็จ" : "ไม่สำเร็จ"})`))
            .catch((e) => console.error("[server-control] ปิดเซิร์ฟเวอร์ตอนถึงเวลาที่ตั้งไว้ล้มเหลว:", e));
    }, Math.max(0, closeAt - Date.now()));
    closingPlan = plan;
    return plan;
}

// แจ้งทุกเครื่องที่ออนไลน์ว่า "กำลังจะปิด" (เวลาที่เหลือ + ข้อความ + เวลาที่คาดว่าจะเปิด) — คืนจำนวนเครื่องที่แจ้ง
function broadcastClosingNotice() {
    if (!closingPlan) return 0;
    const payload = {
        inMs: Math.max(1, closingPlan.closeAt - Date.now()),
        message: closingPlan.message,
        reopenAt: closingPlan.reopenAt,
        now: Date.now(),
    };
    // ห้องผู้ทดสอบไม่ได้รับผลจากการปิดเซิร์ฟเวอร์ → ไม่ต้องขึ้นแถบเตือน "ทุกห้องจะถูกปิด" ให้เขาเห็น
    const targets = playerSockets().filter((s) => !isProtectedSocket(s));
    targets.forEach((s) => { try { s.emit("server_closing", payload); } catch (_) { /* ไม่เป็นไร */ } });
    return targets.length;
}

// ยกเลิกการนับถอยหลัง (ถ้ามี) แล้วบอกทุกเครื่องให้ซ่อนแถบเตือน — คืน true ถ้ามีการนับอยู่จริง
function cancelClosingPlan() {
    if (!closingPlan) return false;
    clearClosingPlan();
    playerSockets().forEach((s) => { try { s.emit("server_closing_cancelled", {}); } catch (_) { /* ไม่เป็นไร */ } });
    return true;
}

// ปิดจริง — ใช้ทั้งตอนกด "ปิดทันที" และตอนนับถอยหลังครบ
// ลำดับสำคัญ (เหตุผลเดียวกับ closeAllRoomsSilently): ตั้งข้อความ → ส่ง server_closed → ปิดทุกห้องทันที (ก่อน socket ถูกตัดที่ 0.8 วิ)
// → เปลี่ยน epoch (ให้ทุกเครื่องกลับหน้าแรกตอนเปิดคืน) → บันทึกสถานะลง DB
async function performServerClose({ message, reopenAt }) {
    serverOpenTouchedByAdmin = true;
    clearClosingPlan();
    closedMessage = message || "";
    closedReopenAt = reopenAt || 0;
    const kicked = closeServerNow();
    const closedRooms = await closeAllRoomsSilently();
    startNewSessionEpoch("session");
    let persisted = true;
    try {
        await saveServerState();
    } catch (e) {
        persisted = false;
        console.error("[server-control] บันทึกสถานะเปิด/ปิดลง DynamoDB ไม่สำเร็จ:", e.name, e.message);
    }
    if (persisted) serverOpenTouchedByAdmin = false;
    return { kicked, closedRooms, persisted };
}

app.post("/api/admin/server-open", express.json({ limit: "4kb" }), async (req, res) => {
    if (!checkAdminPassword(req, res)) return;
    const wantOpen = req.body && req.body.open;
    if (typeof wantOpen !== "boolean") return res.status(400).json({ error: "open_required" });

    await serverStateReady;
    serverOpenTouchedByAdmin = true;

    const notice = parseCloseNotice(req.body);

    // ---------- เปิด ----------
    if (wantOpen) {
        // "สถานะเปลี่ยนจริง" = ปิด→เปิด เท่านั้น — กดเปิดซ้ำตอนเปิดอยู่แล้ว (เช่น หน้า admin ค้างเก่า) ต้องไม่ไปปิดห้อง/ไล่ทุกคนกลับหน้าแรก
        // (แต่ถ้ากำลังนับถอยหลังปิดอยู่ ถือเป็นการยกเลิกการปิด)
        const cancelledClosing = cancelClosingPlan();
        const stateChanged = serverClosed;
        let closedRooms = 0;
        if (stateChanged) {
            serverClosed = false;
            closedMessage = "";
            closedReopenAt = 0;
            // ปิด/เปิดเซิร์ฟเวอร์ = จบเซสชันเดิมทั้งหมด (ไม่กลับเข้าห้องเดิมเมื่อเปิดคืน) — เปลี่ยน epoch ทั้งตอน "ปิด" และตอน "เปิด"
            // เพราะระหว่างปิดอาจมี deploy/รีสตาร์คั่น (รีสตาร์ท = เลขในหน่วยความจำหาย ต้องมีเลขใหม่ตอนเปิดเพื่อให้เครื่องที่ค้างรู้ตัว)
            closedRooms = await closeAllRoomsSilently();
            startNewSessionEpoch("session");
        }
        let persisted = true;
        try {
            await saveServerState();
        } catch (e) {
            persisted = false;
            console.error("[server-control] บันทึกสถานะเปิด/ปิดลง DynamoDB ไม่สำเร็จ:", e.name, e.message);
        }
        if (persisted) serverOpenTouchedByAdmin = false;
        console.log(`[server-control] เปิดเซิร์ฟเวอร์ (เปลี่ยนสถานะ ${stateChanged}, ยกเลิกนับถอยหลัง ${cancelledClosing}, ปิดห้อง ${closedRooms} ห้อง, บันทึก DB ${persisted ? "สำเร็จ" : "ไม่สำเร็จ"})`);
        return res.json({ ok: true, open: !serverClosed, kicked: 0, closedRooms, keptTesterRooms: countTesterRooms(), changed: stateChanged, cancelledClosing, persisted });
    }

    // ---------- ปิดอยู่แล้ว: แก้ข้อความ/เวลาที่คาดว่าจะเปิดอย่างเดียว ----------
    if (serverClosed) {
        closedMessage = notice.message;
        closedReopenAt = notice.reopenAt; // มาเป็น epoch ms ตรงๆ จากช่องเลือกวันที่/เวลาของแอดมินแล้ว
        let persisted = true;
        try {
            await saveServerState();
        } catch (e) {
            persisted = false;
            console.error("[server-control] บันทึกข้อความประกาศลง DynamoDB ไม่สำเร็จ:", e.name, e.message);
        }
        if (persisted) serverOpenTouchedByAdmin = false;
        console.log(`[server-control] แก้ข้อความ/เวลาที่คาดว่าจะเปิด (ปิดอยู่แล้ว) บันทึก DB ${persisted ? "สำเร็จ" : "ไม่สำเร็จ"}`);
        return res.json({ ok: true, open: false, kicked: 0, closedRooms: 0, changed: false, noticeUpdated: true, reopenAt: closedReopenAt, persisted });
    }

    // ---------- เปิด→ปิด แบบตั้งวันที่/เวลาไว้ล่วงหน้า (นับถอยหลังอยู่ระหว่างรอ) ----------
    // ตั้งใหม่ซ้ำระหว่างนับถอยหลังอยู่ = แทนที่ของเดิม (ปรับเวลาปิดให้ไวขึ้น/ถอยออกได้ตรงนี้ — ไม่ส่ง cancelled ให้เครื่องกะพริบ, server_closing ตัวใหม่ทับเอง)
    if (!notice.immediate) {
        const plan = armClosingPlan(notice.closeAt, notice.message, notice.reopenAt);
        const notified = broadcastClosingNotice();
        let persisted = true;
        try {
            await saveServerState(); // บันทึกกำหนดการลง DB ด้วย กันหายถ้าเซิร์ฟเวอร์รีสตาร์ท/deploy ระหว่างรอ (ดู initServerState)
        } catch (e) {
            persisted = false;
            console.error("[server-control] บันทึกกำหนดการปิดลง DynamoDB ไม่สำเร็จ:", e.name, e.message);
        }
        if (persisted) serverOpenTouchedByAdmin = false;
        console.log(`[server-control] ตั้งเวลาปิดเซิร์ฟเวอร์ไว้ ${new Date(plan.closeAt).toISOString()} (แจ้ง ${notified} เครื่อง)`);
        return res.json({
            ok: true, open: true, scheduled: true,
            closeAt: plan.closeAt, reopenAt: plan.reopenAt,
            closeInSec: Math.max(0, Math.round((plan.closeAt - Date.now()) / 1000)),
            notified, kicked: 0, closedRooms: 0, changed: false, persisted,
        });
    }

    // ---------- เปิด→ปิด ทันที ----------
    const r = await performServerClose({
        message: notice.message,
        reopenAt: notice.reopenAt,
    });
    console.log(`[server-control] ปิดเซิร์ฟเวอร์ (ตัดการเชื่อมต่อ ${r.kicked} เครื่อง, ปิดห้อง ${r.closedRooms} ห้อง, บันทึก DB ${r.persisted ? "สำเร็จ" : "ไม่สำเร็จ"})`);
    res.json({ ok: true, open: !serverClosed, kicked: r.kicked, closedRooms: r.closedRooms, keptTesterRooms: countTesterRooms(), changed: true, persisted: r.persisted });
});

app.post("/api/admin/server-close-cancel", express.json({ limit: "2kb" }), async (req, res) => {
    if (!checkAdminPassword(req, res)) return;
    const cancelled = cancelClosingPlan();
    let persisted = true;
    if (cancelled) {
        try {
            await saveServerState(); // ล้างกำหนดการที่บันทึกไว้ใน DB ด้วย ไม่งั้นถ้ารีสตาร์ทก่อนแอดมินสั่งอย่างอื่น จะฟื้นกำหนดการเดิมกลับมาอีก
        } catch (e) {
            persisted = false;
            console.error("[server-control] ล้างกำหนดการปิดใน DynamoDB ไม่สำเร็จ:", e.name, e.message);
        }
    }
    console.log(`[server-control] ยกเลิกการปิดเซิร์ฟเวอร์ที่ตั้งเวลาไว้ (${cancelled ? "มีกำหนดการอยู่" : "ไม่มีกำหนดการอยู่"})`);
    res.json({ ok: true, cancelled, persisted });
});

// บังคับรีโหลด — ทำงานเป็นขั้นตอน: (1) เปลี่ยน epoch/imageEpoch ก่อน (2) ค่อยยิง event ให้ทุกเครื่องที่ออนไลน์
// เครื่องที่ไม่ได้ต่อ socket อยู่ (หน้าแรก/แท็บที่หลับ/ออฟไลน์ตอนนั้น) จะเจอเลขใหม่เองจากการเช็ค /api/config
// (ทุก ~20 วิ + ตอนกลับมาเปิดแท็บ) จึงรีโหลดตามภายหลังได้ ไม่ต้องเก็บ event ไว้ส่งซ้ำ
// ขอบัตรผ่านผู้ทดสอบ (หน้า admin.html การ์ด "เข้าในฐานะผู้ทดสอบ") — ดูหัวข้อ "บัตรผ่านผู้ทดสอบ" ด้านบนสุดของไฟล์
app.post("/api/admin/tester-pass", express.json({ limit: "2kb" }), async (req, res) => {
    if (!checkAdminPassword(req, res)) return;
    try {
        await ensureTesterPassSecretPersistent();
        res.json({ ok: true, token: issueTesterPass(), ttlMs: TESTER_PASS_TTL_MS });
    } catch (e) {
        console.error("[tester-pass] ไม่สามารถยืนยัน secret แบบ shared ได้:", e.name || "Error", e.message || e);
        res.status(503).json({ ok: false, error: "tester_pass_unavailable", code: "TESTER_PASS_UNAVAILABLE" });
    }
});

// ประกาศ "มีรุ่นใหม่" โดยไม่แตะห้อง/ผู้เล่นเลย (publish update ≠ force reload/terminate rooms)
// - ไม่เรียก closeAllRoomsSilently / ไม่เปลี่ยน reloadEpoch / ไม่ยิง force_reload / ไม่ตัด socket ใคร
// - แค่เปลี่ยนเลขรุ่นรูป (imageEpoch) → version ที่ /api/config เปลี่ยน → หน้า index ของทุกเครื่องเห็นโอเวอร์เลย "มีอัปเดตเกมใหม่" ตอนที่ผู้เล่น "กลับมาหน้า index เอง"
//   (ใช้เป็น server-side asset version signal สำหรับ force-reload; ไฟล์ใน public/images/ ถูกตรวจ hash ได้เองตอน deploy)
app.post("/api/admin/publish-update", express.json({ limit: "2kb" }), async (req, res) => {
    if (!checkAdminPassword(req, res)) return;
    await serverStateReady;
    const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    imageEpoch = epoch;
    imageEpochTouchedByAdmin = true;
    let persisted = true;
    try {
        await saveServerState();
    } catch (e) {
        persisted = false;
        console.error("[server-control] บันทึก imageEpoch ลง DynamoDB ไม่สำเร็จ:", e.name, e.message);
    }
    console.log(`[server-control] ประกาศรุ่นใหม่ (ไม่กระทบห้อง) imageEpoch=${epoch}`);
    res.json({ ok: true, version: computeServerVersion(), imageEpoch: currentImageVersion(), closedRooms: 0, notified: 0, persisted });
});

app.post("/api/admin/tester-update", express.json({ limit: "2kb" }), async (req, res) => {
    if (!checkAdminPassword(req, res)) return;
    const kind = req.body && req.body.kind;
    if (kind !== "files" && kind !== "images" && kind !== "both") {
        return res.status(400).json({ error: "kind_required", code: "TESTER_UPDATE_KIND_REQUIRED" });
    }

    await serverStateReady;
    const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    testerReloadEpoch = epoch;
    if (kind === "images" || kind === "both") {
        imageEpoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        imageEpochTouchedByAdmin = true;
    }

    let persisted = true;
    try {
        await saveServerState();
    } catch (e) {
        persisted = false;
        console.error("[server-control] บันทึก tester-update state ลง DynamoDB ไม่สำเร็จ:", e.name, e.message);
    }

    const targets = [...io.sockets.sockets.values()].filter((s) => {
        if (s.data && s.data.isAdmin) return false;
        return !!(s.data && (s.data.testerToken || s.data.roomTesterAuth || socketRoomKind(s) === "tester"));
    });
    const payload = {
        testerUpdate: true,
        epoch,
        kind,
        clientHash: computeClientHash(),
        version: computeServerVersion(),
        imageEpoch: currentImageVersion(),
    };
    targets.forEach((sock) => { try { sock.emit("force_reload", payload); } catch (_) {} });

    const testerRooms = countTesterRooms();
    console.log(`[server-control] สั่งอัปเดต Tester (${kind}) epoch=${epoch} แจ้ง ${targets.length} เครื่อง, เก็บห้องผู้ทดสอบ ${testerRooms} ห้อง, ปิดห้องปกติ=0`);
    res.json({ ok: true, kind, epoch, notified: targets.length, testerRooms, closedRooms: 0, persisted, version: payload.version, clientHash: payload.clientHash, imageEpoch: payload.imageEpoch });
});

app.post("/api/admin/force-reload", express.json({ limit: "2kb" }), async (req, res) => {
    if (!checkAdminPassword(req, res)) return;
    const kind = req.body && req.body.kind;
    if (kind !== "files" && kind !== "images" && kind !== "both") {
        return res.status(400).json({ error: "kind_required" });
    }

    await serverStateReady;

    const epoch = startNewSessionEpoch(kind);
    reloadEpochTouchedByAdmin = true;

    if (kind === "images" || kind === "both") {
        imageEpoch = epoch;
        imageEpochTouchedByAdmin = true;
    }

    // อย่ารอ DynamoDB ก่อนแจ้งผู้เล่น — notification ต้องเร็วและคงที่แม้ DB หรือจำนวนห้องจะช้า
    // state write ทำต่อแบบ asynchronous; instance นี้เห็น epoch ใหม่จาก RAM ทันที และ instance อื่น
    // จะใช้ค่าที่ persist แล้วในการ sync ตามกลไก state recovery.
    let persisted = true;
    const stateSavePromise = saveServerState().catch((e) => {
        persisted = false;
        console.error("[server-control] บันทึก force-reload state ลง DynamoDB ไม่สำเร็จ:", e.name, e.message);
        return false;
    });

    // เลือกผู้รับและล้างห้องจาก RAM ทันที; snapshot/index จะถูกลบเบื้องหลังโดยไม่ขวาง event
    const targets = playerSockets().filter((s) => !isProtectedSocket(s));
    const closedRooms = await closeAllRoomsSilently({ fast: true });
    const keptTesterRooms = countTesterRooms();

    const payloadImageEpoch = currentImageVersion();
    const notificationStartedAt = Date.now();
    targets.forEach((s) => { try { s.emit("force_reload", { epoch, kind, imageEpoch: payloadImageEpoch }); } catch (_) { /* ไม่เป็นไร */ } });
    const dispatchMs = Date.now() - notificationStartedAt;

    // รอเฉพาะ state persistence เพื่อให้ผลที่แอดมินเห็นสะท้อนสถานะจริง แต่ไม่เคยบล็อกการส่งให้ผู้เล่น
    await stateSavePromise;

    console.log(`[server-control] สั่งรีโหลด (${kind}) epoch=${epoch} แจ้ง ${targets.length} เครื่อง, ปิดห้อง ${closedRooms} ห้อง, เก็บห้องผู้ทดสอบไว้ ${keptTesterRooms} ห้อง, notification=fast, dispatch=${dispatchMs}ms`);
    res.json({ ok: true, kind, epoch, notified: targets.length, closedRooms, keptTesterRooms, persisted, dispatchMs, serverOpen: !serverClosed });
});

// ============================================================
// START ROOM RECOVERY BEFORE ACCEPTING SOCKET EVENTS
// ============================================================
startRoomPersistence();

// ============================================================
// BROWSER EXIT SIGNALS (keepalive/beacon)
// ============================================================
function browserExitOriginAllowed(req) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return true;
    const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0].trim().toLowerCase();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHost = String(req.get('host') || '').trim();
    const configuredBase = String(process.env.PUBLIC_WEB_ORIGIN || '').trim().replace(/\/+$/, '');
    const expected = new Set();
    if (/^https?$/i.test(forwardedProto)) {
        if (requestHost) expected.add(`${forwardedProto}://${requestHost}`);
        if (forwardedHost) expected.add(`${forwardedProto}://${forwardedHost}`);
    }
    if (configuredBase && /^https?:\/\//i.test(configuredBase)) {
        try { expected.add(new URL(configuredBase).origin); } catch (_) {}
    }
    if (expected.has(origin)) return true;
    // CloudFront/ALB setups sometimes do not preserve the viewer Host as x-forwarded-host.
    // The exit endpoint still requires a per-room/player secret in the body, so an unverified
    // Origin must not make the core safety feature silently fail in production. Strict mode is
    // available when the deployment has explicitly configured every public origin.
    if (String(process.env.BROWSER_EXIT_STRICT_ORIGIN || '').toLowerCase() === 'true') return false;
    addDiagnosticBreadcrumb({ source:'server', type:'security', label:'browser_exit.origin_unverified', page:'server', detail:{ origin:origin.slice(0,180), candidateCount:expected.size, strict:false } });
    return true;
}

function stripBrowserExitPlayerMaps(room, playerId) {
    const cleanMap = (map) => {
        if (!map) return;
        Object.keys(map).forEach((sid) => { if (map[sid] === playerId) delete map[sid]; });
        delete map[playerId];
    };
    cleanMap(room.selectedTargets);
    cleanMap(room.shieldTargets);
    cleanMap(room.curseTargets);
    cleanMap(room.votes);
    cleanMap(room.wolfKillVotes);
    cleanMap(room.banditKillVotes);
}

async function applyVoluntaryPlayerExit(roomId, tok, reason, pendingMeta = {}) {
    const room = rooms[roomId];
    if (!room) return { ok:true, code:'ROOM_NOT_FOUND' };
    const pendingMembershipId = String(pendingMeta.membershipId || '').trim();
    const player = (pendingMembershipId
        ? room.players.find((p) => p && !p.isHost && String(p.membershipId || '').trim() === pendingMembershipId)
        : null)
        || room.players.find((p) => p && !p.isHost && p.token === tok);
    if (!player) return { ok:true, code:'PLAYER_NOT_FOUND' };

    if (!room.started || room.gameOver) {
        if (!room.started && !room.gameOver) {
            if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
            if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token]); delete pendingIndicators[player.token]; }
            stripBrowserExitPlayerMaps(room, player.id);
            room.players = room.players.filter((p) => p !== player && p.token !== tok);
            emitRoomUpdateToRoom(roomId, room);
            schedulePersistRoom(roomId, true);
            broadcastSuggestedRoom();
        }
        return { ok:true, code:room.gameOver ? 'ROOM_ALREADY_ENDED' : 'LEFT_LOBBY', recorded:false };
    }

    const roundId = getRoomGameRoundId(room);
    player.leftGameRoundId = roundId;
    player.leaveReason = String(reason || player.leaveReason || 'browser_tab_closed').slice(0,64);
    player.leaveRecordedAt = player.leaveRecordedAt || Date.now();
    player.disconnected = true;
    player.offline = true;

    let announced = false;
    if (player.alive) {
        player.alive = false;
        cleanupAfterVoluntaryLeaveDeath(room, player);
        const leaveMsg = {
            name:'เกม', text:`🚪 ${player.name || 'ผู้เล่น'} ออกจากเกม`, type:'global',
            isSystem:true, isDeath:true, isGameLeave:true,
        };
        pushGlobalChat(room, leaveMsg);
        io.to(roomId).emit('chat_message', leaveMsg);
        announced = true;
    }

    if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
    if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token]); delete pendingIndicators[player.token]; }
    checkGameEndGeneral(room, roomId);
    schedulePersistRoom(roomId, true);
    broadcastRoomUpdate(roomId, room);
    broadcastSuggestedRoom();
    return { ok:true, code:'LEFT_GAME', recorded:true, announced };
}

app.post('/api/room/browser-exit-player', express.json({limit:'32kb'}), async (req, res) => {
    const ctx = currentDiagnosticContext();
    const traceId = String(req.body?.traceId || ctx.traceId || '');
    const sessionId = String(req.body?.sessionId || ctx.sessionId || '');
    const id = String(req.body?.roomId || '').trim().toUpperCase();
    const tok = String(req.body?.token || '');
    const requestMembershipId = String(req.body?.membershipId || '').trim();
    const requestSocketId = String(req.body?.socketId || '');
    const requestDeviceId = normalizeDeviceId(req.body?.deviceId || '');
    const signalEvent = recordDiagnostic({
        source:'client', kind:'browser_exit_signal', page:'player', message:'Player pagehide exit signal reached the server',
        traceId, sessionId, requestId:String(ctx.requestId || ''), roomId:id, endpoint:'/api/room/browser-exit-player',
        context:{ source:String(req.body?.source || 'pagehide'), socketIdPresent:!!requestSocketId, viewport:req.body?.viewport || null, pendingOperations:req.body?.pendingOperations || [], started:!!req.body?.started },
        causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_SIGNAL', confidence:'high' },
    });
    if (!id || !tok) return res.status(400).json({ ok:false, code:'BROWSER_EXIT_INVALID_PAYLOAD' });
    let room = rooms[id];
    if (!room) {
        try { room = await recoverPersistedRoomById(id, { reason: 'browser_exit_player' }); } catch (_) { return res.json({ ok:false, code:'SERVER_ERROR' }); }
    }
    if (!room) return res.json({ ok:true, code:'ROOM_NOT_FOUND' });
    const player = (requestMembershipId
        ? room.players.find((p) => p && !p.isHost && String(p.membershipId || '').trim() === requestMembershipId && p.token === tok)
        : null)
        || room.players.find((p) => p && !p.isHost && p.token === tok);
    if (!player) return res.json({ ok:true, code:'PLAYER_NOT_FOUND' });

    const priorDisconnect = recentSocketDisconnect('player', id, tok, requestSocketId);
    if (priorDisconnect) {
        const duplicateEvent = recordDiagnostic({
            source:'server', kind:'browser_exit_duplicate_ignored', page:'player',
            message:'Late player pagehide signal ignored because the same socket already disconnected',
            traceId, sessionId, requestId:String(ctx.requestId || ''), roomId:id,
            context:{ source:String(req.body?.source || 'pagehide'), socketId:requestSocketId, priorDisconnectAt:new Date(priorDisconnect.time).toISOString() },
            causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_DUPLICATE_IGNORED', confidence:'high' },
        });
        return res.json({ ok:true, code:'BROWSER_EXIT_DUPLICATE_IGNORED', recorded:true, diagnosticId:duplicateEvent?.id || '' });
    }

    armPendingBrowserExit('player', id, tok, async (pending) => {
        const liveRoom = rooms[id];
        if (!liveRoom) return;
        const livePlayer = (pending.membershipId
            ? liveRoom.players.find((p) => p && !p.isHost && String(p.membershipId || '').trim() === pending.membershipId && p.token === pending.token)
            : null)
            || liveRoom.players.find((p) => p && !p.isHost && p.token === pending.token);
        if (!livePlayer) return;
        if (isPlayerCurrentlyConnected(livePlayer)) {
            const reconnectedEvent = recordDiagnostic({
                source:'server', kind:'browser_exit_cancelled', page:'player',
                message:'Player reconnected during browser-exit grace; no leave/death was applied', traceId:pending.traceId, sessionId:pending.sessionId, roomId:id,
                context:{ outcome:'reconnected', source:pending.source },
                causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_RECONNECTED', confidence:'high', upstreamEventIds:pending.armDiagnosticId ? [pending.armDiagnosticId] : [] }
            });
            if (pending.armDiagnosticId && reconnectedEvent?.id) linkDiagnosticEvents(pending.armDiagnosticId, reconnectedEvent.id, 'causes');
            return;
        }
        pending.membershipId = pending.membershipId || String(livePlayer.membershipId || '');
        const result = await applyVoluntaryPlayerExit(id, pending.token, 'browser_tab_closed', pending);
        const appliedEvent = recordDiagnostic({ source:'server', kind:'browser_exit_applied', page:'player', message:'Player browser exit passed reconnect grace and was applied to room/game state', traceId:pending.traceId, sessionId:pending.sessionId, roomId:id, context:{ result:result || {}, source:pending.source }, causalHint:{ failureStage:'room.lifecycle', causeCode:String(result?.code || 'BROWSER_EXIT_APPLIED'), confidence:'high', upstreamEventIds:pending.armDiagnosticId ? [pending.armDiagnosticId] : [] } });
        if (pending.armDiagnosticId && appliedEvent?.id) linkDiagnosticEvents(pending.armDiagnosticId, appliedEvent.id, 'causes');
    }, { page:'player', traceId, sessionId, source:String(req.body?.source || 'pagehide'), socketId:requestSocketId, membershipId:requestMembershipId || String(player.membershipId || ''), deviceId:requestDeviceId, signalDiagnosticId:String(signalEvent?.id || '') }, BROWSER_EXIT_PLAYER_GRACE_MS);

    res.setHeader('Cache-Control','no-store');
    return res.json({ ok:true, code:'BROWSER_EXIT_ARMED' });
});

// ============================================================
// SOCKET EVENTS
// ============================================================

io.on("connection", (socket) => {

    // ============================================================
    // แก้ความเสี่ยงที่บันทึกไว้ที่หัวไฟล์ (บรรทัด ~11): ทั้งไฟล์นี้แทบไม่มี try/catch เลย
    // สักจุดใน socket handler หลายสิบตัว — เดิมถ้า handler ไหน throw ขึ้นมากลางทาง
    // (เข้า process.on("uncaughtException") ที่หัวไฟล์พอดี) จะมี 2 ปัญหาซ้อนกัน แม้ process
    // จะไม่ล่มทั้งตัวแล้วก็ตาม:
    //   1) ถ้ามี callback (cb) ส่งมาด้วย แต่ throw เกิดขึ้น "ก่อน" ถึงบรรทัดที่เรียก cb() —
    //      ฝั่ง client ที่รอ callback (เช่น await ก่อนเปลี่ยนหน้า/ปิด spinner) จะค้างเงียบๆ
    //      ไปตลอด ไม่มีทาง resolve/reject เลย
    //   2) exception กลางฟังก์ชันอาจทำให้ state ของห้อง (room.xxx) ถูกแก้ไปครึ่งเดียวก่อนจะ throw
    //      (เช่น เซ็ต flag ไปแล้วแต่ยังไม่ทัน emit room_update) ทำให้ห้องค้างอยู่ในสถานะกลางๆ
    //      ที่ไม่ตรงกับที่ผู้เล่นเห็นบนจอ
    // จุดนี้ห่อ socket.on ของ socket นี้ทุกตัว (ใครมาลงทะเบียนทีหลังใน scope นี้ก็โดนห่อด้วย
    // อัตโนมัติ ไม่ต้องแก้ทีละ handler ทั้ง 50+ จุด) ให้ทุก error (ทั้ง throw ตรงๆ และ Promise
    // ที่ reject จาก handler async) ถูกจับไว้ที่นี่: log ไว้ debug + เรียก cb({error}) ให้ client
    // ได้รับคำตอบแน่ๆ แทนที่จะค้างเงียบ — ไม่เปลี่ยนพฤติกรรมตอนไม่มี error เลยแม้แต่นิดเดียว
    const _rawSocketOn = socket.on.bind(socket);
    socket.on = (event, handler) => {
        return _rawSocketOn(event, (...args) => {
            const maybeCb = args[args.length - 1];
            const hasCb = typeof maybeCb === "function";
            if (String(event).startsWith("admin_") && (!socket.data.isAdmin || !isAdminSocket(socket))) {
                if (hasCb) { try { maybeCb({ error:"admin_auth_required", code:"ADMIN_AUTH_REQUIRED" }); } catch (_) {} }
                return;
            }
            if (serverClosed && !SOCKET_INTERNAL_EVENTS.has(event)) {
                if (socket.data.isAdmin) {
                    if (!String(event).startsWith("admin_")) return;
                } else if (!isTesterPassValid(socket.data.testerToken) && !socket.data.roomTesterAuth && socketRoomKind(socket) !== "tester") {
                    return;
                }
            }
            if (resetInProgress && !SOCKET_INTERNAL_EVENTS.has(event)) {
                if (hasCb) { try { maybeCb({ error:"reset_in_progress", code:"RESET_IN_PROGRESS" }); } catch (_) {} }
                return;
            }
            let ackSent = false;
            if (hasCb) {
                args[args.length - 1] = (...ackArgs) => {
                    if (ackSent) return maybeCb(...ackArgs);
                    ackSent = true;
                    try { return maybeCb(...ackArgs); } catch (err) { console.error(`[socket:${event}] ack callback error`, err); }
                };
            }
            try {
                const result = handler(...args);
                if (result && typeof result.then === "function") {
                    result.catch((err) => {
                        console.error(`[socket:${event}] unhandled async error`, err);
                        recordDiagnostic({kind:"socket_handler_failed",page:"server",message:String(event)+": "+err.message,stack:err.stack,roomId:socket.data.roomId});
                        if (hasCb && !ackSent) { try { args[args.length - 1]({ error:"internal_error", code:"SERVER_ERROR" }); } catch (_) {} }
                    });
                }
            } catch (err) {
                console.error(`[socket:${event}] error`, err);
                recordDiagnostic({kind:"socket_handler_failed",page:"server",message:String(event)+": "+err.message,stack:err.stack,roomId:socket.data.roomId});
                if (hasCb && !ackSent) { try { args[args.length - 1]({ error:"internal_error", code:"SERVER_ERROR" }); } catch (_) {} }
            }
        });
    };

    // ส่ง Running version จริงของ Elastic Beanstalk ให้ client ทันทีหลังเชื่อมต่อ
    // client ใช้ค่าจาก event นี้เป็นแหล่งแสดงผลหลัก; ถ้า AWS ยังตอบไม่ทันจะได้ fallback จาก /api/config
    getAppVersion().then((version) => {
        try { socket.emit("serverInfo", { version, buildVersion: computeServerVersion(), clientHash: computeClientHash(), adminHash: computeAdminHash(), deploymentState: getCachedAppEnvironmentState().deploymentState, environmentStatus: getCachedAppEnvironmentState().status }); } catch (_) {}
    }).catch((err) => {
        console.error("[serverInfo] failed to get app version:", err);
        try { socket.emit("serverInfo", { version: "unknown", buildVersion: computeServerVersion(), clientHash: computeClientHash(), adminHash: computeAdminHash(), deploymentState: getCachedAppEnvironmentState().deploymentState, environmentStatus: getCachedAppEnvironmentState().status }); } catch (_) {}
    });

    // ส่งข้อมูล roles และห้องแนะนำทันทีที่ client เชื่อมต่อ
    socket.emit("roles_data", buildRolesData());
    socket.emit("suggested_room", getLatestOpenRoom());

    // ----------------------------------------------------------------
    // TESTER SLOT ALLOCATOR — เลขชื่อที่มาจากสถานะห้อง/ผู้เล่นจริงใน memory เท่านั้น
    // ไม่ใช่ counter ที่เพิ่มไปเรื่อยๆ จึงคืนเลขต่ำสุดที่ว่างทันทีเมื่อห้อง/ผู้เล่นหายไป
    // ----------------------------------------------------------------
    function nextTesterHostSlot() {
        const used = new Set();
        Object.values(rooms).forEach((r) => {
            if (!isTesterRoom(r) || r.isClosing) return;
            const n = Number(r.testerHostSlot);
            if (Number.isInteger(n) && n > 0) used.add(n);
        });
        let n = 1;
        while (used.has(n)) n++;
        return n;
    }

    function nextTesterPlayerSlot(excludePlayer = null) {
        const used = new Set();
        Object.values(rooms).forEach((r) => {
            if (r.isClosing) return;
            (r.players || []).forEach((p) => {
            if (!p || p === excludePlayer || p.isHost || p.isBot || !p.isTester) return;
            const n = Number(p.testerPlayerSlot);
            if (Number.isInteger(n) && n > 0) used.add(n);
            });
        });
        let n = 1;
        while (used.has(n)) n++;
        return n;
    }

    // ----------------------------------------------------------------
    // CREATE ROOM
    // ----------------------------------------------------------------
    socket.on("create_room", async ({ name, token, isTester, testerSessionId, settings } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        // isTester จาก client เป็นแค่ "คำขอ" — server ตัดสินเองจากบัตรผ่านที่ผูกกับ socket นี้
        // ไม่มีบัตรที่ใช้ได้ = ไม่อนุญาตให้ปลอมสร้างห้องผู้ทดสอบ
        const testerGranted = resolveTesterFlag(socket, isTester);
        if (isTester === true && !testerGranted) {
            if (socket.data.testerPassBootstrapError) {
                return cb({ error: "tester pass temporarily unavailable", code: "TESTER_PASS_UNAVAILABLE" });
            }
            if (!socket.data.testerPassPresented) {
                return cb({ error: "tester pass required", code: "TESTER_PASS_REQUIRED" });
            }
            return cb({ error: "tester pass invalid or expired", code: "TESTER_PASS_INVALID" });
        }
        // settings = ค่าที่โฮสต์ตั้งไว้ในหน้า "ตั้งค่าห้องก่อนสร้าง" (ดู sanitizeRoomSettings) — ไม่ส่งมา = ค่าเริ่มต้นเดิมทุกอย่าง
        const st = sanitizeRoomSettings(settings);
        // บั๊ก: เดิม genId() เรียกครั้งเดียวแล้วใช้เลย ไม่เช็คว่าห้องรหัสนี้มีอยู่แล้วหรือไม่
        // genId() สุ่ม 5 ตัวอักษรจาก [0-9a-z] มีค่าที่เป็นไปได้ ~36^5 ≈ 60 ล้านแบบ แต่ถ้าเกิดชนกัน
        // พอดี (แม้โอกาสต่ำ) โค้ดเดิมจะ "rooms[id] = {...}" ทับห้องเดิมที่มีคนเล่นอยู่ทันที
        // ทำให้เกมที่กำลังเล่นอยู่ในห้องนั้นหายไปทั้งห้องแบบไม่มีการแจ้งเตือนใดๆ เลย — แก้ให้วนสุ่มใหม่
        // จนกว่าจะได้รหัสที่ยังไม่มีใครใช้
        let id = genId();
        while (rooms[id]) id = genId();
        // ผูกห้องใหม่เข้ากับ diagnostic context ตั้งแต่ได้รหัส เพื่อให้ snapshot/index ที่ทำต่อด้วย timer
        // ยังระบุสถานที่เกิดเหตุได้ แม้ create_room payload จาก client จะยังไม่มี roomId ก่อนสร้าง
        socket.data.diagnosticRoomId = String(id).toUpperCase().slice(0, 12);
        const hostToken = normalizeRoomToken(token) || (genId() + genId());
        const testerHostSlot = testerGranted ? nextTesterHostSlot() : 0;
        const hostMembershipId = generateMembershipId();
        if (testerGranted) name = `โฮสต์${testerHostSlot}`;
        else name = sanitizeName(name, "โฮสต์");

        rooms[id] = {
            id,
            stateVersion: 1,
            stateChangedAt: Date.now(),
            timelineSeq: 0,
            timeline: [],
            // ห้องผู้ทดสอบ: server ตัดสินตอนสร้างห้องเท่านั้น (client แก้ทีหลังไม่ได้ — ไม่มี event ไหนรับค่านี้จาก client) → ไม่ถูกปิดโดยการปิดเซิร์ฟเวอร์/บังคับรีโหลด
            isTesterRoom: testerGranted,
            testerHostSlot,
            testerSessionId: testerGranted ? String(testerSessionId || "").slice(0, 128) : "",
            host: socket.id,
            hostIds: [socket.id],
                        hostMembershipId,
            roomLeaseEpoch: 0,
            // รหัสผ่านห้อง (แยกจาก HOST_PASSWORD ทั่วไปฝั่ง index.html ที่กันแค่คนเข้าโหมดโฮสต์ได้)
            // ค่าว่าง "" = ไม่ได้ตั้งรหัส ใครมีสิทธิ์เข้าโหมดโฮสต์อยู่แล้วก็เลือกคุมห้องนี้ได้เลย
            // จากกริด "ห้องที่ยังเปิดอยู่" — ตั้งรหัสนี้ไว้ (ผ่านปุ่ม "⚙️ ตั้งค่าห้อง") เพื่อกันจอ/แอดมิน
            // คนอื่นแย่งคุมห้องนี้โดยไม่ได้รับอนุญาต ต้องใส่รหัสห้องนี้ให้ถูกก่อนถึงจะ host_login เข้ามาได้
            hostPassword: st.hostPassword,
            // รหัสห้องฝั่งผู้เล่น (แยกจาก hostPassword ด้านบน ซึ่งกันแค่คนแย่งคุมห้องในโหมดโฮสต์)
            // ค่าว่าง "" = ไม่ต้องใช้รหัส ใครรู้โค้ดห้อง (roomId) ก็เข้าร่วมเป็นผู้เล่นได้เลย
            // ถ้าตั้งไว้ ผู้เล่น "ใหม่" (ไม่ใช่ reconnect ด้วย token เดิม) ต้องกรอกรหัสนี้ให้ตรงก่อน
            // ถึงจะ join_room สำเร็จ — ดูการเช็คใน socket.on("join_room")
            joinCode: st.joinCode,
            // จำนวนผู้เล่นสูงสุดที่รับเข้าห้องได้ (ไม่นับโฮสต์) — 0 หรือไม่ตั้ง = ไม่จำกัด
            maxPlayers: st.maxPlayers,
            config: st.config,
            // ตั้งได้เฉพาะก่อนเริ่มเกม: true = ตายแล้วเปิดบทในกริดทุกคน, false = ตายแล้วไม่เปิดบท
            revealDeadRole: st.revealDeadRole,
            started: false,
            gameRoundId: null,
            selectedTargets: {},
            shieldTargets: {},
            curseTargets: {},
            wolfChatHistory: [],
            globalChatHistory: [],
            nightCount: 0,
            dayCount: 0,
            isNight: false,
            voteMode: false,
            votes: {},
            wolfKillVotes: {},
            banditKillVotes: {},
            testerConditions: st.testerConditions,
            voteTimerEnabled: st.voteTimerEnabled, // โหมดผู้ทดสอบ: ปิดได้เพื่อไม่ให้โหวตหมดเวลาอัตโนมัติ (ค่าเริ่มต้นเปิดไว้เหมือนเกมปกติ)
            gameOver: false,
            gameResult: null,
            continueReady: {},
            players: [{
                id: socket.id,
                roomId: id,
                token: hostToken,
                membershipId: hostMembershipId,
                name,
                isHost: true,
                role: null,
                displayRole: null,
                alive: true,
                protected: false,
                killed: false,
                // เข้ามาผ่านโหมดผู้ทดสอบ (admin.html → ?tester=1) — ใช้โชว์ป้าย "ชั่วคราว" ในหน้า admin.html
                // ค่านี้มาจากการตัดสินของ server (บัตรผ่านที่ใช้ได้) ไม่ใช่ค่าที่ client ส่งมาตรงๆ
                isTester: testerGranted,
            }],
        };

        if (!testerGranted && ROOM_PERSISTENCE_ENABLED) {
            try {
                const lease = await acquireRoomLease(id);
                if (!lease.ok) {
                    delete rooms[id];
                    return cb({ error: "room failover is still settling", code: lease.code || "ROOM_FAILOVER_WAIT", retryAfterMs: lease.retryAfterMs || ROOM_FAILOVER_RETRY_MS });
                }
                rooms[id].roomLeaseEpoch = lease.leaseEpoch;
                scheduleRoomLeaseRenewal(id);
            } catch (e) {
                delete rooms[id];
                console.error(`[room-lease] create ${id} failed:`, e?.name || "Error", e?.message || e);
                return cb({ error: "room coordination temporarily unavailable", code: "SERVER_ERROR" });
            }
        }

        socket.data.deviceId = normalizeDeviceId(socket.data.deviceId || "");
        socket.data.tabId = normalizeTabId(socket.data.tabId || "");
        socket.data.roomId = id;
        socket.data.membershipId = hostMembershipId;
        socket.data.isHost = true;
        socket.join(id);
        socket.join(hostRoomName(id));
        hostSocketRooms[socket.id] = id;
        // บันทึก snapshot + register index ก่อนส่ง room_update/ack เพื่อให้ "สร้างห้องสำเร็จ"
        // หมายถึงห้องมีสำเนาถาวรอยู่แล้ว (ถ้า DynamoDB ชั่วคราวล่มยัง fail-open ต่อเกมได้)
        touchRoomActivity(rooms[id]);
        try { await persistRoomSnapshot(rooms[id], { register: true }); }
        catch (e) { console.error(`[room-persist] สร้าง snapshot ห้อง ${id} ไม่สำเร็จ:`, e.name, e.message); }
        broadcastRoomUpdate(id, rooms[id], { timelineType: "room_created", source: "room" });
        broadcastSuggestedRoom();
        // ส่งรหัสที่ตั้งไว้กลับไปด้วย (เฉพาะ ack ให้โฮสต์ที่สร้างห้อง ไม่ผ่าน room_update ที่ broadcast ให้ทุกคน) —
        // client จำไว้ในเครื่องเหมือนตอนตั้งผ่าน "⚙️ ตั้งค่าห้อง" จะได้ host_login ซ้ำ/โชว์ในช่องตั้งค่าได้
        cb({ ok: true, roomId: id, token: hostToken, hostPassword: st.hostPassword, joinCode: st.joinCode, testerHostSlot, membershipId: hostMembershipId });
    });

    // ----------------------------------------------------------------
    // LIST OPEN ROOMS
    // ----------------------------------------------------------------
    socket.on("list_open_rooms", (request, cb) => {
        // Preserve the callback-only contract for existing clients.
        if (typeof request === "function") { cb = request; request = {}; }
        if (typeof cb !== "function") return;
        const ownerToken = normalizeRoomToken(request?.token);
        cb(getOpenRoomsList().map((entry) => ({
            ...entry,
            canResumeHost: !!ownerToken && ownerToken === normalizeRoomToken(
                rooms[entry.roomId]?.players.find((p) => p.isHost)?.token
            ),
        })));
    });

    // ----------------------------------------------------------------
    // LIST OPEN ROOMS (ฝั่งผู้เล่น — ดู getOpenRoomsListForPlayers ด้านบนสำหรับฟิลด์ที่ตัดออก)
    // ----------------------------------------------------------------
    socket.on("list_open_rooms_players", (cb) => {
        if (typeof cb !== "function") cb = () => {};
        cb(getOpenRoomsListForPlayers());
    });

    // ----------------------------------------------------------------
    // HOST LOGIN — เจ้าของกลับเข้าห้องด้วย token เดิม
    // ----------------------------------------------------------------
    socket.on("host_login", async ({ roomId, token, password } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        if (!roomId || (typeof roomId !== "string" && typeof roomId !== "number")) {
            return cb({ error: "room not found", code: "ROOM_NOT_FOUND" });
        }
        roomId = String(roomId).trim().toUpperCase();
        let room = rooms[roomId];
        if (!room) {
            if (deploymentHandoffInProgress()) {
                return cb({ error: "room handoff is in progress", code: "ROOM_FAILOVER_WAIT", retryAfterMs: ROOM_FAILOVER_RETRY_MS });
            }
            // Multi-instance / cold-start fallback: the room may exist in DynamoDB even though this
            // particular EB instance has not loaded it into RAM yet. Do not treat that as a closed room.
            try {
                room = await recoverPersistedRoomById(roomId, { reason: "host_login" });
            } catch (e) {
                console.error(`[room-recovery] host_login กู้คืนห้อง ${roomId} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
                if (["ROOM_FAILOVER_WAIT", "ROOM_LEASE_UNAVAILABLE"].includes(String(e?.code || ""))) {
                    return cb({ error: "room handoff is still settling", code: String(e.code), retryAfterMs: Number(e.retryAfterMs) || ROOM_FAILOVER_RETRY_MS });
                }
                return cb({ error: "room recovery temporarily unavailable", code: "SERVER_ERROR" });
            }
        }
        if (!room || room.isClosing || roomIdleExpired(room, io.sockets.sockets)) {
            if (room && !room.isClosing) closeRoomNow(roomId, "idle_timeout").catch(console.error);
            return cb({ error: "room not found", code: "ROOM_NOT_FOUND" });
        }

        // Room ownership survives socket changes and disconnections. A public room
        // code or player join code must never grant the host's permissions.
        const returningHost = room.players.find((p) => p.isHost);
        const ownerToken = normalizeRoomToken(returningHost?.token);
        if (!ownerToken || normalizeRoomToken(token) !== ownerToken) {
            return cb({ error: "host_owner_required", code: "HOST_OWNER_REQUIRED" });
        }

        const hostPlayer = room.players.find((p) => p.isHost);
        if (!hostPlayer) return cb({ error: "host slot missing", code: "ROOM_NOT_FOUND" });
        if (isTesterRoom(room) && token) hostPlayer.token = String(token).trim().slice(0, 256);
        if (isTesterRoom(room)) {
            hostPlayer.isTester = true;
            if (!room.testerHostSlot) room.testerHostSlot = nextTesterHostSlot();
            hostPlayer.name = `โฮสต์${room.testerHostSlot}`;
        } else {
            hostPlayer.isTester = false;
            hostPlayer.name = sanitizeName(hostPlayer.name, "โฮสต์");
        }
        if (!hostPlayer.membershipId) hostPlayer.membershipId = room.hostMembershipId || generateMembershipId();
        room.hostMembershipId = hostPlayer.membershipId;
        delete room.ownerAccountId;
        touchRoomActivity(room);
        hostPlayer.disconnected = false;
        hostPlayer.id = socket.id; // transient connection handle; membershipId remains stable
        socket.data.roomId = roomId;
        socket.data.membershipId = hostPlayer.membershipId || room.hostMembershipId || "";
        socket.data.isHost = true;
        clearPendingBrowserExit('host', roomId, hostPlayer.token, { source:'host_login', traceId:socket.data?.diagnosticTraceId || '', sessionId:socket.data?.diagnosticSessionId || '' });

        // เคลียร์ timer รอลบ + timer รอโชว์สถานะหลุดของ token นี้
        // (เผื่อจอนี้เพิ่งหลุดไปแล้วกำลังเชื่อมกลับ)
        if (pendingRemovals[hostPlayer.token]) {
            clearTimeout(pendingRemovals[hostPlayer.token].timer);
            delete pendingRemovals[hostPlayer.token];
        }
        if (pendingIndicators[hostPlayer.token]) {
            clearTimeout(pendingIndicators[hostPlayer.token]);
            delete pendingIndicators[hostPlayer.token];
        }

        // เพิ่ม "จอนี้" เข้าไปในชุดจอโฮสต์ที่คุมห้องได้พร้อมกัน — ไม่ไล่จอเก่าที่ยังเปิดอยู่ออก
        // (แก้บั๊ก: เดิมจอที่สอง login ปุ๊บจะ "แย่ง" สิทธิ์จอแรกไปทันที กดปุ่มอะไรไม่ได้อีกเลย
        //  ต้องกดล็อกอินซ้ำสองจอ อัปเดตไม่พร้อมกัน)
        addHostSocket(room, roomId, socket);

        broadcastRoomUpdate(roomId, room);
        if (!hostPlayer.isTester) socket.emit("name_updated_by_host", { name: hostPlayer.name });
        broadcastSuggestedRoom();

        if (room.wolfChatHistory?.length)   socket.emit("wolf_chat_history",   room.wolfChatHistory);

        // ส่ง "แชทรวม" + "ข้อความ [โฮสต์เท่านั้น]" รวมเป็นไทม์ไลน์เดียว เรียงตาม seq จริง (ดู
        // mergedGlobalAndPrivateHistory) แทนที่จะส่งแยก 2 event แล้วให้ client ต่อท้ายกันเอง —
        // แก้บั๊กลำดับแชทสลับตอนจอโฮสต์ล็อกอินใหม่/reconnect
        {
            const merged = mergedGlobalAndPrivateHistory(room, room.hostPrivateChatLog);
            if (merged.length) socket.emit("global_chat_history", merged);
        }

        schedulePersistRoom(roomId, true);
        cb({ ok: true, roomData: room, token: hostPlayer.token });
    });

    // ----------------------------------------------------------------
    // ROOM SETTINGS (ปุ่ม "⚙️ ตั้งค่าห้อง" ฝั่งโฮสต์)
    // ----------------------------------------------------------------
    // ตั้ง/เปลี่ยน/ลบ รหัสห้อง (กันแอดมินคนอื่นแย่งคุมห้อง), รหัสห้องฝั่งผู้เล่น, จำนวนผู้เล่นสูงสุด
    // และ "แสดงบทคนตาย" เฉพาะตอนที่เกมยังไม่เริ่ม
    // hostPassword/joinCode/maxPlayers คงพฤติกรรมเดิม เพื่อไม่ทำลายระบบห้องเดิม
    socket.on("update_room_settings", ({ roomId, hostPassword, joinCode, maxPlayers, revealDeadRole, stateVersion } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { host: true, member: false, stateVersion });
        if (!validation.ok) return cb({ ...validation, error: validation.code === "NOT_HOST" ? "not host" : validation.code === "ROOM_NOT_FOUND" ? "room not found" : validation.code });

        // กฎความปลอดภัย: "แสดงบทคนตาย" เปลี่ยนได้เฉพาะตอนห้องยังไม่เริ่มเกมเท่านั้น
        // ต้องเช็คจาก server เพราะ client ปิดปุ่มอย่างเดียวไม่พอ และกันการยิง Socket event ตรงหลังเริ่มเกม
        if (revealDeadRole !== undefined) {
            if (room.started) return cb({ error: "room_started", code: "ROOM_STARTED", field: "revealDeadRole" });
            if (typeof revealDeadRole !== "boolean") return cb({ error: "invalid_reveal_dead_role", code: "INVALID_REVEAL_DEAD_ROLE" });
            room.revealDeadRole = revealDeadRole;
        }


        // joinCode: รหัสห้องฝั่งผู้เล่น (แยกจาก hostPassword ด้านบน) — ไม่ส่งมา = ไม่แก้,
        // ส่งมาเป็น "" = ลบรหัส (ใครรู้โค้ดห้องก็เข้าร่วมได้เลย), ส่งค่าอื่น = ตั้งรหัสใหม่
        if (typeof joinCode === "string") {
            room.joinCode = joinCode.trim().slice(0, 20);
        }

        // maxPlayers: จำนวนผู้เล่นสูงสุด (ไม่นับโฮสต์) — ไม่ส่งมา = ไม่แก้, 0/ค่าว่าง/ไม่ใช่ตัวเลข = ไม่จำกัด
        if (maxPlayers !== undefined) {
            const n = parseInt(maxPlayers, 10);
            room.maxPlayers = (Number.isFinite(n) && n > 0) ? Math.min(n, 999) : 0;
        }

        broadcastRoomUpdate(roomId, room);
        schedulePersistRoom(roomId, true);
        broadcastSuggestedRoom();
        cb({ ok: true, hostPassword: room.hostPassword, joinCode: room.joinCode, maxPlayers: room.maxPlayers, revealDeadRole: room.revealDeadRole !== false, stateVersion: room.stateVersion });
    });

    // ----------------------------------------------------------------
    // PREVIOUS ROOM STATUS — ตรวจห้องเดิมของผู้เล่นก่อน auto-join ตอนเปิดหน้าใหม่
    // ----------------------------------------------------------------
    socket.on("player_resume_status", async ({ roomId, token, membershipId } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const id = String(roomId || "").trim().toUpperCase();
        const tok = String(token || "");
        const requestedMembershipId = String(membershipId || socket.data?.membershipId || "").trim();
        if (!id || !tok) return cb({ ok: true, roomExists: false, playerFound: false });
        let room = rooms[id];
        if (!room) {
            try { room = await recoverPersistedRoomById(id, { reason: "player_resume_status" }); }
            catch (e) { return cb({ error: "server error", code: "SERVER_ERROR" }); }
        }
        if (!room) return cb({ ok: true, roomExists: false, playerFound: false });
        const player = (requestedMembershipId
            ? room.players.find((p) => p && !p.isHost && p.token === tok && String(p.membershipId || "").trim() === requestedMembershipId)
            : null)
            || room.players.find((p) => p && !p.isHost && p.token === tok);
        if (!player) return cb({ ok: true, roomExists: true, playerFound: false, roomId: id });
        const hostPlayer = room.players.find((p) => p.isHost);
        const roundId = getRoomGameRoundId(room);
        const alreadyLeft = !!(room.started && !room.gameOver && player.leftGameRoundId === roundId);
        return cb({ ok:true, roomExists:true, playerFound:true, roomId:id, hostName:hostPlayer?.name || "", playerCount:room.players.filter((p) => !p.isHost).length, maxPlayers:room.maxPlayers || 0, started:!!room.started, gameOver:!!room.gameOver, isTesterRoom:!!room.isTesterRoom, isNight:!!room.isNight, alreadyLeft });
    });

    // ----------------------------------------------------------------
    // ABANDON GAME — ผู้เล่นเลือก "หาห้องใหม่" ระหว่างเกมที่ยังไม่จบ
    // บันทึก leave ทันที และล็อก token ไม่ให้ join กลับเข้ารอบเดิมอีก
    // ----------------------------------------------------------------
    socket.on("abandon_game", async ({ roomId, token, membershipId, reason } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const id = String(roomId || "").trim().toUpperCase();
        const tok = String(token || "");
        const requestedMembershipId = String(membershipId || socket.data?.membershipId || "").trim();
        if (!id || !tok) return cb({ ok:false, code:"ROOM_NOT_FOUND" });
        let room = rooms[id];
        if (!room) {
            try { room = await recoverPersistedRoomById(id, { reason:"abandon_game" }); }
            catch (e) { return cb({ ok:false, code:"SERVER_ERROR" }); }
        }
        if (!room) return cb({ ok:true, code:"ROOM_NOT_FOUND" });
        const player = (requestedMembershipId
            ? room.players.find((p) => p && !p.isHost && p.token === tok && String(p.membershipId || "").trim() === requestedMembershipId)
            : null)
            || room.players.find((p) => p && !p.isHost && p.token === tok);
        if (!player) return cb({ ok:true, code:"ROOM_NOT_FOUND" });
        clearPendingBrowserExit('player', id, player.token, { source:'abandon_game' });
        if (!room.started || room.gameOver) {
            if (!room.started && !room.gameOver) {
                if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
                if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token]); delete pendingIndicators[player.token]; }
                stripBrowserExitPlayerMaps(room, player.id);
                room.players = room.players.filter((p) => p !== player && p.token !== tok);
                broadcastRoomUpdate(id, room);
                schedulePersistRoom(id, true);
                broadcastSuggestedRoom();
            }
            socket.leave(id);
            return cb({ ok:true, code:room.gameOver ? "ROOM_ALREADY_ENDED" : "LEFT_LOBBY", recorded:false });
        }
        player.leftGameRoundId = getRoomGameRoundId(room);
        player.leaveReason = String(reason || "new_room").slice(0,64);
        player.leaveRecordedAt = player.leaveRecordedAt || Date.now();
        player.disconnected = true;
        player.offline = true;
        if (player.alive) {
            player.alive = false;
            cleanupAfterVoluntaryLeaveDeath(room, player);
            const leaveMsg = { name:"เกม", text:`🚪 ${player.name || "ผู้เล่น"} ออกจากเกม`, type:"global", isSystem:true, isDeath:true, isGameLeave:true };
            pushGlobalChat(room, leaveMsg);
            io.to(id).emit("chat_message", leaveMsg);
        }
        if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
        if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token]); delete pendingIndicators[player.token]; }
        checkGameEndGeneral(room, id);
        socket.leave(id);
        broadcastRoomUpdate(id, room);
        schedulePersistRoom(id, true);
        return cb({ ok:true, recorded:true, roomId:id, markedDead:true });
    });

    // ----------------------------------------------------------------
    // JOIN ROOM
    // ----------------------------------------------------------------
    socket.on("join_room", async ({ roomId, name, token, code, membershipId, isTester, testerSessionId } = {}, cb) => {
        // บั๊ก: เดิม roomId.toUpperCase() ไม่มีการเช็คชนิด/ค่าก่อนเรียก — ถ้า client ส่ง roomId
        // เป็น null/undefined/เลข มา (payload ผิดรูป, บั๊กฝั่ง client, หรือส่ง event ตรงๆ)
        // จะ throw TypeError ขึ้นมาใน handler นี้ทันที และเพราะไม่มี try/catch ห่อ socket
        // handler ไว้เลยทั้งไฟล์ (ไม่มี process.on("uncaughtException") ด้วย) จะทำให้ Node process
        // ทั้งตัว "ล่มทั้งเซิร์ฟเวอร์" ตัดการเชื่อมต่อทุกห้อง/ทุกเกมที่กำลังเล่นอยู่พร้อมกัน
        // จุดอื่นๆ ที่ทำแบบเดียวกัน (request_sync, release_bot) มีการ String(roomId) ป้องกันไว้แล้ว
        // จุดนี้จุดเดียวที่ตกหล่น — แก้ให้ปลอดภัยเหมือนกันทุกจุด
        if (typeof cb !== "function") cb = () => {};
        if (!roomId || typeof roomId !== "string") return cb({ error: "room not found", code: "ROOM_NOT_FOUND" });
        roomId = roomId.toUpperCase();
        roomId = String(roomId).trim().toUpperCase();
        let room = rooms[roomId];
        if (!room) {
            if (deploymentHandoffInProgress()) {
                return cb && cb({ error: "room handoff is in progress", code: "ROOM_FAILOVER_WAIT", retryAfterMs: ROOM_FAILOVER_RETRY_MS });
            }
            try {
                room = await recoverPersistedRoomById(roomId, { reason: "join_room" });
            } catch (e) {
                console.error(`[room-recovery] join_room กู้คืนห้อง ${roomId} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
                if (["ROOM_FAILOVER_WAIT", "ROOM_LEASE_UNAVAILABLE"].includes(String(e?.code || ""))) {
                    return cb({ error: "room handoff is still settling", code: String(e.code), retryAfterMs: Number(e.retryAfterMs) || ROOM_FAILOVER_RETRY_MS });
                }
                return cb({ error: "room recovery temporarily unavailable", code: "SERVER_ERROR" });
            }
        }
        if (!room || room.isClosing || roomIdleExpired(room, io.sockets.sockets)) {
            if (room && !room.isClosing) closeRoomNow(roomId, "idle_timeout").catch(console.error);
            return cb({ error: "room not found", code: "ROOM_NOT_FOUND" });
        }
        if (name !== undefined) name = sanitizeName(name);
        const testerGranted = resolveTesterFlag(socket, isTester);
        socket.data.deviceId = normalizeDeviceId(socket.data?.deviceId || "");
        socket.data.tabId = normalizeTabId(socket.data?.tabId || "");
        const tokenPlayer = token ? room.players.find((p) => p.token === String(token)) : null;
        // Room token is the primary guest reconnect identity. MembershipId remains available to
        // status/recovery handlers as a secondary stable identifier, but token-only reconnect
        // stays supported for older clients.
        let player = tokenPlayer;
        const existingPlayerIsBot = !!player?.isBot;
        const isReconnect = !!player;
        // Bot possession is a tester-only reconnect path. Bots have no player profile identity;
        // their room token + membershipId are the only durable identifiers.
        if (existingPlayerIsBot) {
            if (!room.isTesterRoom) {
                return cb({ error: "tester room required", code: "TESTER_ROOM_REQUIRED" });
            }
            // A possessed bot arrives with its room+bot token. When the protected handshake has
            // already validated that exact membership, allow reconnect even if the tester pass
            // itself has expired after the Host tab was opened. Otherwise require a valid pass.
            const botTesterAuthorized = testerGranted || socket.data.roomTesterAuth === true;
            if (!botTesterAuthorized) {
                if (socket.data.testerPassBootstrapError) {
                    return cb({ error: "tester pass temporarily unavailable", code: "TESTER_PASS_UNAVAILABLE" });
                }
                if (!socket.data.testerPassPresented) {
                    return cb({ error: "tester pass required", code: "TESTER_PASS_REQUIRED" });
                }
                return cb({ error: "tester pass invalid or expired", code: "TESTER_PASS_INVALID" });
            }
        }
        if (isTester === true && !isReconnect && socket.data.testerPassBootstrapError) {
            return cb({ error: "tester pass temporarily unavailable", code: "TESTER_PASS_UNAVAILABLE" });
        }
        if (isTester === true && !isReconnect && socket.data.testerPassPresented && !socket.data.testerPassValid) {
            return cb({ error: "tester pass invalid or expired", code: "TESTER_PASS_INVALID" });
        }
        if (isTester === true && !isReconnect && !socket.data.testerPassPresented) {
            return cb({ error: "tester pass required", code: "TESTER_PASS_REQUIRED" });
        }
        if (player && room.started && !room.gameOver && player.leftGameRoundId === getRoomGameRoundId(room)) {
            return cb({ error: "player already left game", code: "PLAYER_LEFT_GAME" });
        }
        // ผู้เล่นใหม่ต้องมีชื่อที่ผู้ใช้ยืนยันจากหน้า index ก่อนสร้างผู้เล่น
        // ส่วน reconnect ใช้ชื่อที่เก็บอยู่ใน server ได้ จึงไม่บังคับ payload name ซ้ำ
        if (!testerGranted && !isReconnect && (!name || sanitizeName(name, "ผู้เล่น") === "ผู้เล่น")) {
            return cb({ error: "missing_display_name", code: "MISSING_DISPLAY_NAME" });
        }
        if (testerGranted && !room.isTesterRoom && !isReconnect) {
            return cb({ error: "tester room required", code: "TESTER_ROOM_REQUIRED" });
        }
        if (player) {
            if (!player.membershipId) player.membershipId = generateMembershipId();
            clearPendingBrowserExit('player', roomId, player.token, { source:'join_room' });
            if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
            if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token]); delete pendingIndicators[player.token]; }
            player.disconnected = false;
            player.offline = false;
            player.id = socket.id;
            player.roomId = roomId;
            delete player.accountId;
            delete player.accountToken;
            delete player.activeDeviceId;
            delete player.activeTabId;
            if (player.isTester) {
                player.isTester = testerGranted || room.isTesterRoom;
                if (!player.testerPlayerSlot) player.testerPlayerSlot = nextTesterPlayerSlot(player);
            }
            socket.data.roomId = roomId;
            socket.data.membershipId = player.membershipId;
            socket.data.isHost = false;
        } else {
            if (room.joinCode && code !== room.joinCode) {
                const attemptKey = `join:${roomId}`;
                if (!isLoginAttemptAllowed(attemptKey)) return cb({ error:"too_many_attempts", code:"TOO_MANY_ATTEMPTS" });
                recordFailedLoginAttempt(attemptKey);
                return cb({ error:"wrong_room_code", code:"ROOM_CODE_REQUIRED" });
            }
            if (!testerGranted && (!name || sanitizeName(name, "ผู้เล่น") === "ผู้เล่น")) {
                return cb({ error:"missing_display_name", code:"MISSING_DISPLAY_NAME" });
            }
            if (testerGranted && !room.isTesterRoom) return cb({ error:"tester room required", code:"TESTER_ROOM_REQUIRED" });
            if (room.maxPlayers > 0 && room.players.filter((p) => !p.isHost).length >= room.maxPlayers) return cb({ error:"room_full", code:"ROOM_FULL" });
            const finalToken = testerGranted ? (String(token || '').trim().slice(0,256) || genId()) : (String(token || '').trim().slice(0,256) || genId());
            const newMembershipId = generateMembershipId();
            clearPendingBrowserExit('player', roomId, finalToken, { source:'join_room' });
            const testerPlayerSlot = testerGranted ? nextTesterPlayerSlot() : 0;
            const finalName = testerGranted ? `ผู้เล่น${testerPlayerSlot}` : sanitizeName(name, "ผู้เล่น");
            player = {
                id: socket.id, roomId, token: finalToken, membershipId:newMembershipId, name:finalName, isHost:false,
                role:null, displayRole:null, alive:true, protected:false, killed:false,
                isTester:testerGranted, testerPlayerSlot:testerGranted ? testerPlayerSlot : 0,
                testerSessionId:testerGranted ? String(testerSessionId || "").slice(0,128) : "",
            };
            room.players.push(player);
            socket.data.roomId = roomId;
            socket.data.membershipId = newMembershipId;
            socket.data.isHost = false;
        }

        socket.join(roomId);
        resumeRecoveredRoomRuntimeTransitions(room, roomId);
        broadcastRoomUpdate(roomId, room, isReconnect
            ? { timelineType: "state_changed", source: "reconnect", reason: "player_reconnected" }
            : { timelineType: "player_joined", source: "player" });

        // ส่งประวัติแชทรวม + private เฉพาะคนนี้ กลับไปให้จอนี้เสมอ (คนเข้าใหม่/หลุดแล้วกลับมา)
        // รวมเป็นไทม์ไลน์เดียวเรียงตาม seq จริง (ดู mergedGlobalAndPrivateHistory) แทนที่จะส่งแยก 2
        // event แล้วให้ client ต่อท้ายกันเอง — แก้บั๊ก: เดิมข้อความ private (เช่น "เมื่อคืนคุณถูกโจมตี
        // โดย...", "คุณตกหลุมรักกับ...") ที่จริงๆ เกิดขึ้น "แทรกกลาง" ระหว่างข้อความรวมตอนเล่นสด กลับถูก
        // ส่งไปต่อท้ายกล่องแชทเสมอทุกครั้งที่ reconnect/sync ทำให้ลำดับที่เห็นไม่ตรงกับตอนเล่นสดครั้งแรก
        {
            const merged = mergedGlobalAndPrivateHistory(room, room.privateChatLog?.[player.token]);
            if (merged.length) {
                socket.emit("global_chat_history", merged);
            }
        }

        // กลับมา reconnect ระหว่างเกม → ส่งบทเดิมกลับไปทันที (silent: กันอนิเมชันซ้ำ)
        if (isReconnect && room.started && player.role) {
            socket.emit("your_role", buildYourRolePayload(player, { silent: true }, room));

            if (WOLF_ROLES.has(player.role) && room.wolfChatHistory?.length) {
                socket.emit("wolf_chat_history", room.wolfChatHistory);
            }
            if (player.instigatorGroupId && room.instigatorChatHistory?.[player.instigatorGroupId]?.length) {
                socket.emit("instigator_chat_history", room.instigatorChatHistory[player.instigatorGroupId]);
            }
            const cultGroupIdReconnect = cultGroupIdOf(player);
            if (cultGroupIdReconnect && room.cultChatHistory?.[cultGroupIdReconnect]?.length) {
                socket.emit("cult_chat_history", room.cultChatHistory[cultGroupIdReconnect]);
            }
            const banditGroupIdReconnect = banditGroupIdOf(player);
            if (banditGroupIdReconnect && room.banditChatHistory?.[banditGroupIdReconnect]?.length) {
                socket.emit("bandit_chat_history", room.banditChatHistory[banditGroupIdReconnect]);
            }
        }

        if (!player.isBot) touchRoomActivity(room);
        schedulePersistRoom(roomId, true);
        cb({ ok: true, roomData: roomViewForSocket(room, socket), token: player.token, membershipId: player.membershipId || "", testerPlayerSlot: player.testerPlayerSlot || 0 });
    });

    // ----------------------------------------------------------------
    // REQUEST SYNC — ให้ client ขอ "สถานะล่าสุดทั้งหมดจากเซิร์ฟเวอร์" ได้ตรงๆ ทุกเมื่อ
    // ----------------------------------------------------------------
    // ใช้ตอนสลับกลับมาที่แท็บ/แอป (visibilitychange) แม้ socket จะยังไม่หลุดการเชื่อมต่อเลย
    // ก็ตาม (กรณีนี้ join_room จะไม่ถูกเรียกซ้ำ เพราะ event "connect" ไม่ทำงาน — socket ไม่เคย
    // disconnect ตั้งแต่ต้น) เพื่อแก้บั๊ก "เข้ามาใหม่/สลับจอกลับมาแล้วไม่เห็นอาชีพ/ข้อมูลเกม"
    // โดยให้เซิร์ฟเวอร์เป็นผู้ตัดสิน "ความจริง" เสมอ (single source of truth) ไม่ใช่พึ่ง state
    // ที่ client จำไว้เองซึ่งอาจหลุด/ไม่ครบ — ส่งกลับให้ครบทุกอย่างเหมือนตอน reconnect ทุกประการ:
    // room_update (ตำแหน่ง/สถานะผู้เล่นทุกคนล่าสุด), your_role (บทของตัวเอง), และประวัติแชททั้งหมด
    socket.on("request_sync", ({ roomId, token } = {}) => {
        if (!roomId) return;
        roomId = String(roomId).toUpperCase();
        const room = rooms[roomId];
        if (!room) return;
        resumeRecoveredRoomRuntimeTransitions(room, roomId);

        // หา player จาก socket.id ปัจจุบันก่อน (กรณีปกติ ไม่หลุดการเชื่อมต่อ) แล้วค่อย fallback
        // ไปหาโดย token (เผื่อ id เพิ่งเปลี่ยนจาก reconnect แต่ยังไม่ทัน sync กับ client ฝั่งนี้)
        // จอโฮสต์ (isHostSocket) ใช้คนละ log กับผู้เล่นปกติ (hostPrivateChatLog แทน
        // privateChatLog ต่อ token) และไม่มี "บทบาท" ของตัวเอง — แยกเส้นทางให้ชัดเจน
        if (isHostSocket(room, socket.id)) {
            socket.emit("room_update", publicRoomView(room));
            if (room.wolfChatHistory?.length) socket.emit("wolf_chat_history", room.wolfChatHistory);
            // รวม "แชทรวม" + "ข้อความ [โฮสต์เท่านั้น]" เรียงตาม seq จริง (ดู mergedGlobalAndPrivateHistory)
            const hostMerged = mergedGlobalAndPrivateHistory(room, room.hostPrivateChatLog);
            if (hostMerged.length) socket.emit("global_chat_history", hostMerged);
            return;
        }

        const socketMembershipId = String(socket.data?.membershipId || "").trim();
        let player = socketMembershipId
            ? room.players.find((p) => !p.isHost && String(p.membershipId || "").trim() === socketMembershipId) || null
            : null;
        if (!player) player = room.players.find((p) => p.id === socket.id && !p.isHost) || null;
        if (!player && token) player = room.players.find((p) => !p.isHost && p.token === String(token)) || null;
        if (!player) return;

        socket.emit("room_update", roomViewForSocket(room, socket));

        // รวม "แชทรวม" + "private เฉพาะคนนี้" เรียงตาม seq จริง (ดู mergedGlobalAndPrivateHistory —
        // แก้บั๊กลำดับแชทสลับตอน sync ซ้ำ เช่น สลับแอป/ล็อกจอมือถือ)
        {
            const merged = mergedGlobalAndPrivateHistory(room, room.privateChatLog?.[player.token]);
            if (merged.length) {
                socket.emit("global_chat_history", merged);
            }
        }

        if (room.started && player.role) {
            socket.emit("your_role", buildYourRolePayload(player, { silent: true }, room));

            if (WOLF_ROLES.has(player.role) && room.wolfChatHistory?.length) {
                socket.emit("wolf_chat_history", room.wolfChatHistory);
            }
            if (player.instigatorGroupId && room.instigatorChatHistory?.[player.instigatorGroupId]?.length) {
                socket.emit("instigator_chat_history", room.instigatorChatHistory[player.instigatorGroupId]);
            }
            const cultGroupIdReconnect2 = cultGroupIdOf(player);
            if (cultGroupIdReconnect2 && room.cultChatHistory?.[cultGroupIdReconnect2]?.length) {
                socket.emit("cult_chat_history", room.cultChatHistory[cultGroupIdReconnect2]);
            }
            const banditGroupIdReconnect2 = banditGroupIdOf(player);
            if (banditGroupIdReconnect2 && room.banditChatHistory?.[banditGroupIdReconnect2]?.length) {
                socket.emit("bandit_chat_history", room.banditChatHistory[banditGroupIdReconnect2]);
            }
        }
    });

    // ----------------------------------------------------------------
    // UPDATE CONFIG
    // ----------------------------------------------------------------
    socket.on("update_config", ({ roomId, config, stateVersion } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { host: true, member: false, notStarted: true, stateVersion });
        if (!validation.ok) return cb(validation);
        if (!config || typeof config !== "object" || Array.isArray(config)) {
            return cb(roomActionError("INVALID_CONFIG"));
        }
        const nextConfig = {};
        Object.entries(config).forEach(([role, count]) => {
            const n = Math.max(0, Math.min(999, parseInt(count, 10) || 0));
            if (n > 0) nextConfig[String(role).slice(0, 80)] = n;
        });
        NON_SELECTABLE_ROLES.forEach((role) => { delete nextConfig[role]; });
        room.config = nextConfig;
        broadcastRoomUpdate(roomId, room, { timelineType: "settings_changed", source: "host" });
        cb({ ok: true, stateVersion: room.stateVersion });
    });

    // ----------------------------------------------------------------
    // START GAME
    // ----------------------------------------------------------------
    socket.on("start_game", (payload, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const roomId = typeof payload === "object" ? payload?.roomId : payload;
        const requestedStateVersion = typeof payload === "object" ? payload?.stateVersion : undefined;
        const room = rooms[roomId];
        if (!room) return cb(roomActionError("ROOM_NOT_FOUND"));
        const validation = validateRoomAction(socket, room, { host: true, member: false, notStarted: false, stateVersion: requestedStateVersion });
        if (!validation.ok) return cb(validation);

        const realPlayers = room.players.filter((p) => !p.isHost);

        // กันไว้อีกชั้น (นอกจากกรองไม่ให้ติ๊กได้ตั้งแต่ฝั่ง client แล้ว): ห้าม config มีอาชีพที่ "ได้มาจาก
        // การเปลี่ยนบทบาทกลางเกมเท่านั้น" ปนอยู่เด็ดขาด (เช่น ผู้สมรู้ร่วมคิด — เกิดจากโจรเปลี่ยนบทบาท
        // ผู้เล่นคนอื่นให้เท่านั้น) เผื่อมีการแก้ config ตรงๆ ผ่านช่องทางอื่นที่ไม่ผ่าน UI ปกติ
        NON_SELECTABLE_ROLES.forEach((r) => { delete room.config[r]; });

        // ถ้าเกมจบไปแล้ว ต้องรอให้ผู้เล่นทุกคนกด "ดำเนินการต่อ" ครบก่อน
        if (room.gameOver) {
            const ready = room.continueReady || {};
            if (!realPlayers.every((p) => ready[p.id])) {
                const error = roomActionError("PLAYERS_NOT_READY");
                io.to(hostRoomName(roomId)).emit(
                    "host_error",
                    "ต้องรอให้ผู้เล่นกด \"ดำเนินการต่อ\" ให้ครบทุกคนก่อน ถึงจะเริ่มเกมใหม่ได้"
                );
                return cb(error);
            }
        }

        // ล้างสถานะรอบเก่าทั้งหมด
        clearGameOverTimer(roomId);
        clearVoteTimer(roomId);
        realPlayers.forEach(resetPlayerRoundState);
        const nextGameRoundId = `${Date.now().toString(36)}-${genId()}`;
        Object.assign(room, {
            gameRoundId: nextGameRoundId,
            votes: {},
            selectedTargets: {},
            shieldTargets: {},
            curseTargets: {},
            wolfKillVotes: {},
            banditKillVotes: {},
            murdererKillVote: null,
            instigatorKillVote: null,
            instigatorChatHistory: {},
            wolfChatHistory: [],
            globalChatHistory: [],
            // แก้บั๊ก: เดิมจุดนี้ล้างแค่ globalChatHistory/wolfChatHistory/instigatorChatHistory
            // แต่ "ลืม" ล้าง privateChatLog (ข้อความ private ต่อผู้เล่น เช่น "คุณตกหลุมรักกับ...",
            // "คุณถูกผู้ยุยงจับคู่ไว้กับ...", ข้อความแม่มด/หมอ/บอดี้การ์ด ฯลฯ) และ hostPrivateChatLog
            // (ข้อความ [โฮสต์เท่านั้น]) ทิ้งไปด้วย — ผลคือแม้เริ่มเกมใหม่แล้ว พอมีใคร reconnect/สลับแอป/
            // request_sync ครั้งถัดไป mergedGlobalAndPrivateHistory() จะไปดึงข้อความ private ของ
            // "เกมที่แล้ว" ที่ยังค้างอยู่ใน object นี้กลับมาปนกับแชทของเกมใหม่ทันที ต้องล้างทิ้งให้หมดตรงนี้ด้วย
            privateChatLog: {},
            hostPrivateChatLog: [],
            chatSeq: 0, // รีเซ็ตเลขลำดับแชทให้เริ่มนับใหม่ทุกเกม (กันเลขวิ่งไม่มีที่สิ้นสุดข้ามเกม)
            nightCount: 0,
            dayCount: 0,
            isNight: false,
            voteMode: false,
            murdererKillVote: null, // { voterId, targetId }
            gameOver: false,
            gameResult: null,
            continueReady: {},
            // เฟส 5: เคลียร์หน่วยความจำบอทของเกมเก่าทิ้งด้วย ไม่งั้นเกมใหม่จะเห็นข้อมูลเกมก่อนหน้าค้างอยู่
            publiclyProtectedIds: [], // เฟส 6: คนที่ถูกเปิดเผยว่าเป็น "คนบ้า" ในแชท — กันบอทชาวบ้านโหวตประหารเข้า
        });

        // กลุ่มสุ่ม (random groups)
        const randomGroups = {
            "สุ่มชาวบ้าน":          ["ชาวบ้าน", "หมอ", "บอดี้การ์ด"],
            "สุ่มชาวบ้านสนับสนุน": ["ศาลเตี้ย", "แม่มด", "นักบวช"],
            "สุ่มหมาป่า":           ["หมาป่า", "ลูกหมาป่า", "หมาป่าดื้อรั้น"],
            "สุ่มหมาป่าสนับสนุน":  ["หมาป่าผู้พิทักษ์", "หมาป่านักเวท"],
            "สุ่มบทบาทการโหวต":    ["คนบ้า", "นักล่าหัว"],
        };

        // สร้างใบ role cards
        const roleCards = [];
        Object.keys(room.config).forEach((roleName) => {
            const count = room.config[roleName];
            for (let i = 0; i < count; i++) {
                if (randomGroups[roleName]) {
                    const pool = randomGroups[roleName];
                    const realRole = pool[Math.floor(Math.random() * pool.length)];
                    roleCards.push({ role: realRole, displayRole: `${roleName}/${realRole}` });
                } else {
                    roleCards.push({ role: roleName, displayRole: roleName });
                }
            }
        });

        if (roleCards.length !== realPlayers.length) {
            io.to(hostRoomName(roomId)).emit(
                "host_error",
                `จำนวน role (${roleCards.length}) ไม่เท่ากับจำนวนผู้เล่น (${realPlayers.length})`
            );
            return;
        }

        shuffle(roleCards);

        // แจกบท
        realPlayers.forEach((p, i) => {
            const card = roleCards[i];
            p.role = card.role;
            p.originalRole = card.role; // เก็บบทเริ่มต้นไว้ตลอดเกม ไม่เปลี่ยนตามการกลายร่างระหว่างเกม
            // (ใช้แสดงรายชื่ออาชีพในห้อง/สถิติที่ผู้เล่นทุกคนเห็นได้ — ถ้าใช้ p.role ตรงๆ
            // พอมีคนกลายร่าง เช่น ผู้ถูกสาปโดนกัดกลายเป็นหมาป่า, รายชื่อนี้จะเปลี่ยนตาม
            // ทำให้ทุกคนรู้ทันทีว่ามีการกลายร่างเกิดขึ้นในตานี้ ทั้งที่ควรเป็นความลับ)
            p.displayRole = card.displayRole;
            p.huntTarget = null;
            p.huntTargetId = null;
            p.guardianShieldAvailable = GUARDIAN_ROLES.has(card.role) ? 1 : 0;
            p.sheriffBullets = card.role === "ศาลเตี้ย" ? 1 : 0;
            p.sheriffPeeks = card.role === "ศาลเตี้ย" ? 1 : 0;
            p.sheriffUsedToday = false;
            p.scoutedThisNight = false;
            p.detectiveScoutedThisNight = false;
            p.witchProtectPotions = card.role === "แม่มด" ? 1 : 0;
            p.witchPoisonPotions = card.role === "แม่มด" ? 1 : 0;
            p.witchPoisonPending = false;
            p.priestHolyWaterPotions = card.role === "นักบวช" ? 1 : 0;
            p.mayorAvailable = card.role === "นายก" ? 1 : 0; // สิทธิ์เปิดเผยตัว 1 ครั้งตลอดเกม
            p.mayorRevealed = false;
            p.illusionTargetIds = []; // นักเล่นกล: รายชื่อผู้เล่นที่ปลอมบทไว้ สะสมได้จากหลายคืน ใช้ตอนกด 🔥 ฆ่ารวดเดียว
            p.illusionDisguised = false;
            p.illusionDeathReveal = false;
        });

        // นักล่าหัว: สุ่มเป้าหมาย (ไม่ใช่ wolf/solo/ศาลเตี้ย/ผู้ถูกสาป/อันธพาล/นายก)
        const cannotBeHuntedTeams = new Set(["wolf", "solo"]);
        // ศาลเตี้ย: มีกระสุนยิงได้เอง ไม่ควรเป็นเป้าล่าหัวซ้ำ
        // ผู้ถูกสาป: จะกลายร่างเป็นหมาป่าได้เองอัตโนมัติ ล่าไปก็เสี่ยงเป้าเปลี่ยนทีมกลางเกม
        // อันธพาล: ป้องกันตัวเองอัตโนมัติจากการโจมตี ทำให้นักล่าหัวยิงไม่ตายจริงอยู่ดี
        // นายก: มีค่าต่อทีมชาวบ้านสูง (โหวต 2 เสียง) ไม่ควรเสี่ยงเป็นเป้าล่าหัวตั้งแต่ต้น
        const cannotBeHuntedRoles = new Set(["ศาลเตี้ย", "ผู้ถูกสาป", "อันธพาล", "นายก"]);

        realPlayers.forEach((p) => {
            if (p.role !== "นักล่าหัว") return;
            const targets = realPlayers.filter((x) => {
                if (x.id === p.id) return false;
                const rd = roles[x.role] || {};
                return !cannotBeHuntedTeams.has(rd.team) && !cannotBeHuntedRoles.has(x.role);
            });
            if (targets.length === 0) return;
            const t = targets[Math.floor(Math.random() * targets.length)];
            p.huntTargetId = t.id;
            p.huntTarget = t.name;
        });

        // ============================================================
        // ผู้ยุยง: จับคู่ "ผู้ศรัทธา" อัตโนมัติทันทีที่เริ่มเกม ตามคำอธิบายบทบาท ("เมื่อเริ่มเกม
        // ผู้เล่นสองคนจะเข้าร่วมทีมคุณ...") — ต่างจากกามเทพตรงที่ผู้ยุยง "ไม่ได้เลือกเอง" ตอนกลางคืนอีก
        // ต่อไป แต่ระบบสุ่มจับคู่ให้ตั้งแต่ตอนนี้เลย: 1 คนจากทีมชาวบ้าน + 1 คนจากทีมหมาป่า หรือทีมเดี่ยว
        // (solo) ที่มี "ความสามารถฆ่า" จริงๆ เท่านั้น (ดู SOLO_KILLER_ROLES — กันคนบ้า/นักล่าหัวที่ไม่มี
        // สกิลฆ่าเลยหลุดเข้ามา) ไม่ใช่ผู้ยุยงคนอื่น (เผื่อห้องมีผู้ยุยงมากกว่า 1 คน) ผูกวิญญาณเข้าด้วยกัน
        // ทันที เหมือน applyInstigatorPair ตอนสรุปผลกลางคืนทุกประการ (ดู performInstigatorPair/
        // resolve_night — เก็บกลไกนั้นไว้เป็น fallback เผื่อห้องเล็กเกินไปจนจับคู่ตามเงื่อนไขทีมไม่ได้
        // ตอนเริ่มเกม เช่นไม่มีทีมหมาป่า/โซโล่ที่ฆ่าได้เลย ในกรณีนั้นผู้ยุยงจะยังเลือกเองได้ตอนกลางคืนเหมือนเดิม)
        // ============================================================
        realPlayers
            .filter((p) => p.role === "ผู้ยุยง" && !p.instigatorPaired)
            .forEach((selector) => {
                const villagerPool = realPlayers.filter((x) => {
                    if (x.id === selector.id || x.instigatorLinkId) return false;
                    return (roles[x.role] || {}).team === "villager";
                });
                // แก้บั๊ก: เดิมรับ team "solo" ทั้งหมด (คนบ้า/นักล่าหัว/ฆาตกรต่อเนื่อง) ทั้งที่มีแค่
                // "ฆาตกรต่อเนื่อง" เท่านั้นที่มีความสามารถฆ่าจริง — ทีมหมาป่ายังคงรับได้ทุกยศเหมือนเดิม
                // (ทุกยศหมาป่าฆ่าได้อยู่แล้วไม่ว่าจะเป็นตัวหลักหรือแค่ร่วมโหวตฆ่า) แต่ฝั่งโซโล่ต้องกรองเฉพาะ
                // SOLO_KILLER_ROLES เท่านั้น กันคนบ้า/นักล่าหัวที่ไม่มีสกิลฆ่าเลยหลุดเข้ามาถูกจับคู่ได้
                const wolfOrSoloPool = realPlayers.filter((x) => {
                    if (x.id === selector.id || x.instigatorLinkId || x.role === "ผู้ยุยง") return false;
                    const t = (roles[x.role] || {}).team;
                    if (t === "wolf") return true;
                    if (t === "solo") return SOLO_KILLER_ROLES.has(x.role);
                    return false;
                });
                if (villagerPool.length === 0 || wolfOrSoloPool.length === 0) return; // ไม่ครบเงื่อนไข ข้ามไปก่อน (มี fallback ที่ resolve_night)

                const targetA = villagerPool[Math.floor(Math.random() * villagerPool.length)];
                const targetB = wolfOrSoloPool[Math.floor(Math.random() * wolfOrSoloPool.length)];

                targetA.instigatorLinkId = targetB.id;
                targetB.instigatorLinkId = targetA.id;
                revealRoleMutual(targetA, targetB);
                selector.instigatorPaired = true;

                // กลุ่มเดียวกันสำหรับผลส่องของนักสืบ: ตัวผู้ยุยงเอง + คู่ที่ถูกจับทั้งสอง (ดู performDetectiveScout)
                selector.instigatorGroupId = selector.id;
                targetA.instigatorGroupId = selector.id;
                targetB.instigatorGroupId = selector.id;

                // เปิดเผยบทบาทที่แท้จริงของผู้ยุยงให้ทั้งคู่เห็นด้วย (ทางเดียว)
                selector.roleRevealMutualWith = selector.roleRevealMutualWith || [];
                if (!selector.roleRevealMutualWith.includes(targetA.id)) selector.roleRevealMutualWith.push(targetA.id);
                if (!selector.roleRevealMutualWith.includes(targetB.id)) selector.roleRevealMutualWith.push(targetB.id);

                selector.lastInstigatorPairText = `${targetA.name} × ${targetB.name}`;
                selector.instigatorPairTargetIds = [targetA.id, targetB.id];
            });

        // ส่งบทให้ผู้เล่น
        realPlayers.forEach((p) => {
            io.to(p.id).emit("your_role", buildYourRolePayload(p, {}, room));
        });

        // แจ้งผู้ยุยง + ผู้ศรัทธาที่ถูกจับคู่อัตโนมัติไว้ (ถ้ามี) เป็นข้อความส่วนตัวให้รู้ทันที
        realPlayers
            .filter((p) => p.role === "ผู้ยุยง" && p.instigatorPaired && Array.isArray(p.instigatorPairTargetIds))
            .forEach((selector) => {
                const [aId, bId] = selector.instigatorPairTargetIds;
                const targetA = realPlayers.find((x) => x.id === aId);
                const targetB = realPlayers.find((x) => x.id === bId);
                if (!targetA || !targetB) return;

                sendPrivateChat(room, selector.id, {
                    name: "เกม",
                    text: `🎭 ${targetA.name} และ ${targetB.name} เข้าร่วมทีมของคุณในฐานะ "ผู้ศรัทธา" ตั้งแต่เริ่มเกม! คุณสามารถส่งข้อความส่วนตัวให้ทั้งคู่ได้ (แชท 🎭 ทีมยุยง) — หากผู้ศรัทธาทั้งสองตาย คุณจะฆ่าผู้เล่นคนอื่นด้วยตัวเองได้ 1 คนต่อคืน`,
                    type: "private",
                    isSystem: true,
                });
                const linkMsg = {
                    name: "เกม",
                    text: `🎭 คุณถูกผู้ยุยงจับคู่ไว้กับ ${"__PARTNER__"} ตั้งแต่เริ่มเกม! ทั้งคู่เห็นบทบาทที่แท้จริงของกันและกันแล้ว รวมถึงเห็นตัวตนที่แท้จริงของผู้ยุยงด้วย หากฝ่ายใดฝ่ายหนึ่งตาย อีกฝ่ายจะตายตามไปด้วยทันที และทั้งคู่จะชนะร่วมกับ "ทีมผู้ยุยง" เท่านั้น ไม่ชนะร่วมกับทีมเดิมของตัวเองอีกต่อไป — คุยกับผู้ยุยงได้ในแชท 🎭 ทีมยุยง`,
                    type: "private",
                    isSystem: true,
                };
                sendPrivateChat(room, targetA.id, { ...linkMsg, text: linkMsg.text.replace("__PARTNER__", targetB.name) });
                sendPrivateChat(room, targetB.id, { ...linkMsg, text: linkMsg.text.replace("__PARTNER__", targetA.name) });
            });

        room.started = true;
        room.justStarted = true;
        // จุดเริ่มนับเวลาทั้งตา — ใช้เทียบสัดส่วนเวลาออฟไลน์สะสมของแต่ละคนตอนจบเกม (ดู didLeaveGame)
        // (ตัวนับออฟไลน์ของผู้เล่นแต่ละคนถูกรีเซ็ตเป็น 0 ไปแล้วโดย resetPlayerRoundState ด้านบน)
        room.startedAt = Date.now();
        broadcastRoomUpdate(roomId, room, { timelineType: "game_started", source: "game" });
        room.justStarted = false; // ล้างทันทีหลังส่ง ไม่ให้ update ถัดไปล้างแชทซ้ำ

        // เริ่มคืนแรกอัตโนมัติทันทีหลังแจกบทเสร็จ — โฮสต์ไม่ต้องกด "เริ่มคืน" เองอีกครั้ง
        beginNight(room, roomId);

        // socket.on("start_night") ที่มี) ทำให้บอทไม่ทำ action เลยตั้งแต่ "คืนแรก" ของทุกเกม
        // เพราะคืนแรกเข้ามาทางนี้เสมอ (ไม่ได้ผ่าน start_night handler) — เพิ่มให้ตรงนี้เหมือนกัน
        if (!room.gameOver) {
        }
        cb({ ok: true, stateVersion: room.stateVersion, gameRoundId: room.gameRoundId || null });
    });

    // ----------------------------------------------------------------
    // TOGGLE STATE (alive/protected/killed/silenced)
    // ----------------------------------------------------------------
    socket.on("toggle_state", ({ roomId, playerId, key, value }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find((p) => p.id === playerId);
        if (!player) return;

        player[key] = value;

        if (key === "alive" && value === false) {
            const cascadeDeaths = cleanupAfterDeath(room, player);
            announceCascadeDeaths(room, roomId, cascadeDeaths);
            checkGameEndGeneral(room, roomId);
        }

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // HOST AIM KILL — โฮสต์ติ๊กช่อง "เล็งฆ่า" เอง (แทนที่จะบังคับ player.killed=true ตรงๆ
    // เหมือนเดิม ซึ่งข้ามระบบโหวตฆ่าปกติไปเลย ทำให้ไม่ขึ้นไฮไลต์เรียลไทม์และ killedBy ไม่ถูกเซ็ต)
    // ให้ "ทีมที่ฆ่าได้จริง" (หมาป่า/ฆาตกรต่อเนื่อง) โหวตเล็งเป้าคนนี้แทน เพื่อให้ resolve_night ประมวลผล
    // เหมือนกับหมาป่า/ฆาตกรต่อเนื่องเลือกเป้าเองทุกประการ — team ที่ client เลือกส่งมาคือ "wolf"/"murderer"
    // ถ้า client ส่ง team ไม่ตรงเงื่อนไข (เช่นไม่มีทีมนั้นมีชีวิตอยู่จริง) จะไม่ทำอะไรเลย (no-op ปลอดภัย)
    // ----------------------------------------------------------------
    socket.on("host_aim_kill", ({ roomId, targetId, team }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;

        const target = room.players.find((p) => p.id === targetId);
        if (!target || !target.alive || target.isHost) return;

        if (team === "wolf") {
            const aliveWolfVoters = room.players.filter(
                (p) => p.alive && WOLF_ROLES.has(p.role) && p.role !== "หมาป่าหยั่งรู้"
            );
            if (aliveWolfVoters.length === 0) return;
            room.wolfKillVotes = room.wolfKillVotes || {};
            aliveWolfVoters.forEach((w) => { room.wolfKillVotes[w.id] = targetId; });
        } else if (team === "murderer") {
            const murderer = room.players.find((p) => p.alive && p.role === "ฆาตกรต่อเนื่อง");
            if (!murderer) return;
            room.murdererKillVote = { voterId: murderer.id, targetId };
        } else {
            // ไม่มีทีมไหนที่ฆ่าได้จริงในเกมนี้เลย (ไม่มีหมาป่า/ฆาตกรต่อเนื่องที่ยังมีชีวิต) —
            // fallback กลับไปบังคับ killed ตรงๆ เหมือนพฤติกรรมเดิม กันโฮสต์ใช้ปุ่มนี้ไม่ได้เลย
            target.killed = true;
        }

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // HOST CLEAR KILL TARGET — โฮสต์ยกเลิกติ๊กช่อง "เล็งฆ่า" ที่ตั้งไว้ (ทั้งจากปุ่มติ๊กเอง
    // และจาก wolfKillVotes/murdererKillVote ที่ชี้มาที่คนนี้) ล้างทั้งหมดให้ตรงกัน
    // ----------------------------------------------------------------
    socket.on("host_clear_kill_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;

        if (room.wolfKillVotes) {
            Object.keys(room.wolfKillVotes).forEach((voterId) => {
                if (room.wolfKillVotes[voterId] === targetId) delete room.wolfKillVotes[voterId];
            });
        }
        if (room.murdererKillVote && room.murdererKillVote.targetId === targetId) {
            room.murdererKillVote = null;
        }
        const target = room.players.find((p) => p.id === targetId);
        if (target) target.killed = false;

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // TOGGLE VOTE MODE
    // ----------------------------------------------------------------
    socket.on("toggle_vote_mode", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;

        // เปิดโหมดโหวตได้เฉพาะตอนกลางวัน (แต่ปิดโหมดที่เปิดค้างได้เสมอ)
        if (!room.voteMode && room.isNight) return;

        if (room.voteMode) {
            // โฮสต์กดปิดโหวตเอง (ก่อนหมดเวลา) — ปิดแล้วนับคะแนน + เข้าคืนอัตโนมัติเหมือนหมดเวลาเป๊ะๆ
            closeVoteRound(room, roomId);
        } else {
            room.voteMode = true;
            // หมายเหตุ: ไม่เคลียร์ room.shieldTargets ตรงนี้อีกต่อไป — หมาป่าผู้พิทักษ์อาจวางโล่
            // ไว้ล่วงหน้าตั้งแต่ตอนกลางวันก่อนโฮสต์เปิดโหมดโหวต ต้องให้ค่าคงอยู่ต่อ ไม่ถูกรีทิ้ง
            // (shieldTargets จะถูกเคลียร์จริงตอนปิดรอบโหวต/เข้าคืนใหม่ใน closeVoteRound แทน)

            clearVoteTimer(roomId);

            // โหมดผู้ทดสอบ: ถ้าปิดการนับเวลาไว้ (voteTimerEnabled === false) ก็เปิดโหวตแบบไม่มี
            // deadline/timer เลย — โฮสต์ต้องกดปิดโหวตเองเท่านั้น ไม่หมดเวลาอัตโนมัติ
            if (room.voteTimerEnabled === false) {
                room.voteDeadline = null;
            } else {
                // ตั้งเวลานับถอยหลังของรอบโหวตนี้ — หมดเวลาปิดโหมดโหวตอัตโนมัติแล้วเข้าคืนต่อเลย
                room.voteDeadline = Date.now() + VOTE_ROUND_MS;
                voteTimers[roomId] = setTimeout(() => {
                    delete voteTimers[roomId];
                    const r = rooms[roomId];
                    if (!r || !r.voteMode) return; // ถูกปิดไปก่อนหน้านี้แล้ว (กันซ้ำซ้อน)
                    if (r.voteTimerEnabled === false) return; // ถูกปิดนับเวลาไปหลังจากตั้ง timer นี้ (กันบั๊ก race condition)
                    closeVoteRound(r, roomId);
                }, VOTE_ROUND_MS);
            }

            broadcastRoomUpdate(roomId, room, { timelineType: "vote_started", source: "host" });

        }
    });

    // ----------------------------------------------------------------
    // TOGGLE VOTE TIMER (โหมดผู้ทดสอบ) — เปิด/ปิดการนับเวลาถอยหลังของโหมดโหวต
    // เปลี่ยนได้ทั้งตอนยังไม่เปิดโหวต และตอนเปิดโหวตอยู่ (ไม่ทำให้เกมค้าง/บั๊ก):
    //   - ปิดระหว่างโหวตอยู่ → เคลียร์ timer ที่ตั้งไว้ทันที + ล้าง voteDeadline (โหวตยังเปิดต่อ ไม่หมดเวลาเอง)
    //   - เปิดกลับระหว่างโหวตอยู่ → ตั้งรอบนับเวลาใหม่ VOTE_ROUND_MS ให้ (นับใหม่จากตอนที่กดเปิด)
    //   - ถ้ายังไม่ได้เปิดโหวต → แค่จำค่าไว้ ใช้ตอนโฮสต์กดเปิดโหวตครั้งถัดไป
    // ----------------------------------------------------------------
    socket.on("toggle_vote_timer", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;

        const wasEnabled = room.voteTimerEnabled !== false;
        room.voteTimerEnabled = !wasEnabled;

        if (room.voteMode) {
            clearVoteTimer(roomId);
            if (room.voteTimerEnabled) {
                room.voteDeadline = Date.now() + VOTE_ROUND_MS;
                voteTimers[roomId] = setTimeout(() => {
                    delete voteTimers[roomId];
                    const r = rooms[roomId];
                    if (!r || !r.voteMode) return;
                    if (r.voteTimerEnabled === false) return;
                    closeVoteRound(r, roomId);
                }, VOTE_ROUND_MS);
            } else {
                room.voteDeadline = null;
            }
        }

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // CAST VOTE
    // ----------------------------------------------------------------
    // แยก logic การโหวตออกจาก socket.id เพื่อให้ใช้ซ้ำได้อย่างปลอดภัย
    function performCastVote(room, roomId, voterId, targetId) {
        if (!room.voteMode) return;

        const voter = room.players.find((p) => p.id === voterId);
        if (!voter || !voter.alive || voter.isHost) return;

        room.votes = room.votes || {};

        if (!targetId) {
            delete room.votes[voterId];
        } else {
            if (targetId === voterId) return;
            const target = room.players.find((p) => p.id === targetId);
            // แก้บั๊ก: เดิมจุดนี้ไม่เช็ค target.isHost (ต่างจาก handler เลือกเป้าอื่นๆ ในไฟล์นี้แทบ
            // ทุกจุดที่เช็คครบ) ทำให้โหวตประหารโฮสต์/แอดมินได้ทั้งที่ไม่ควรมีสิทธิ์ถูกโหวตเลย
            if (!target || target.isHost || !target.alive) return;
            room.votes[voterId] = targetId;
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("cast_vote", ({ roomId, targetId, stateVersion } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { member: true, alive: true, started: true, phases: ["day_vote"], stateVersion });
        if (!validation.ok) return cb(validation);
        const before = room.stateVersion;
        performCastVote(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
        return cb(room.stateVersion !== before ? { ok: true, stateVersion: room.stateVersion } : roomActionError("ACTION_REJECTED", { stateVersion: room.stateVersion }));
    });

    // ----------------------------------------------------------------
    // FORCE VOTE ALL (โหมดผู้ทดสอบเท่านั้น — ปุ่มฝั่ง client ถูกซ่อนไว้นอกโหมดผู้ทดสอบ เหมือน
    // toggle_win_condition/toggle_vote_timer ด้านบนที่ไม่ได้เช็คฝั่งเซิร์ฟเวอร์ว่าเป็นห้องผู้ทดสอบ
    // จริงหรือเปล่าเหมือนกัน — ยึดรูปแบบเดิมของไฟล์นี้)
    // แอดมิน/โฮสต์เลือกเป้า 1 คนจากป๊อปอัปโหวต แล้วบังคับให้ผู้เล่นที่ยังมีชีวิตทุกคน (ยกเว้นเป้าหมายเอง
    // — โหวตตัวเองไม่ได้เหมือน performCastVote ปกติ) โหวตเป้านั้นทันทีทั้งหมด เพื่อเร่งทดสอบเงื่อนไข
    // ประหาร/เงื่อนไขจบเกมโดยไม่ต้องรอผู้เล่นจริงโหวตทีละคน — ใช้ตรรกะเดียวกับ performCastVote (เช็ค
    // เป้าหมายมีชีวิต ไม่ใช่โฮสต์) แค่วนใส่ทุกคนแทนคนเดียว
    // ----------------------------------------------------------------
    socket.on("force_vote_all", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;
        if (!room.voteMode) return;
        if (!targetId) return;

        const target = room.players.find((p) => p.id === targetId);
        if (!target || target.isHost || !target.alive) return;

        room.votes = room.votes || {};
        room.players.forEach((p) => {
            if (p.isHost || !p.alive) return;
            if (p.id === targetId) return; // โหวตตัวเองไม่ได้ — ปล่อยเป้าหมายเองไว้ตามเดิม ไม่บังคับ
            room.votes[p.id] = targetId;
        });

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // CAST WOLF KILL
    // หมาป่า/ฆาตกรต่อเนื่องเลือกเป้าเองได้เลยตอนกลางคืน ไม่ต้องรอโฮสต์เปิด "โหมดฆ่า" อีกต่อไป
    // (เดิมต้องรอโฮสต์กดเปิดโหมดก่อนถึงจะเลือกได้ — ตอนนี้เช็คแค่ room.isNight เหมือนความสามารถ
    // กลางคืนอื่นๆ ทั้งหมด เช่น select_target/scout_target) การสรุปผล (ใครโดนฆ่าจริง) ไปเกิดตอน
    // resolve_night แทน ดูบล็อก "สรุปผลหมาป่า/ฆาตกรต่อเนื่องเลือกฆ่า" ด้านล่างในนั้น
    // ----------------------------------------------------------------
    // เฟส 1: แยกเป็น performWolfKill(room, roomId, voterId, targetId) เหมือน performCastVote ด้านบน
    function performWolfKill(room, roomId, voterId, targetId) {
        if (!room.isNight) return;

        const voter = room.players.find((p) => p.id === voterId);
        if (!voter || !voter.alive || voter.isHost) return;
        if (!WOLF_ROLES.has(voter.role)) return;
        if (voter.role === "หมาป่าหยั่งรู้") return; // หมาป่าหยั่งรู้ไม่ร่วมล่า ใช้ scout_target แทน

        room.wolfKillVotes = room.wolfKillVotes || {};

        if (!targetId) {
            delete room.wolfKillVotes[voterId];
        } else {
            if (targetId === voterId) return;
            const target = room.players.find((p) => p.id === targetId);
            // แก้บั๊กเดียวกับ performCastVote ด้านบน: เดิมไม่เช็ค target.isHost ทำให้หมาป่าเลือก
            // กัดโฮสต์/แอดมินได้ ทั้งที่บทบาทกลางคืนอื่นทุกตัว (select_target/scout_target/ฯลฯ)
            // กันโฮสต์ออกจากเป้าหมายไว้หมดแล้ว มีแค่ cast_wolf_kill/cast_vote สองจุดนี้ที่หลุด
            if (!target || target.isHost || !target.alive) return;
            if (WOLF_ROLES.has(target.role)) return; // ห้ามหมาป่าเลือกฆ่ากันเอง
            // หมาป่าฆ่าฆาตกรต่อเนื่องได้ (แต่ไม่มีผลจริง — จะถูก block ตอน resolve)
            room.wolfKillVotes[voterId] = targetId;
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("cast_wolf_kill", ({ roomId, targetId, stateVersion } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { member: true, alive: true, started: true, phases: ["night"], stateVersion });
        if (!validation.ok) return cb(validation);
        const before = room.stateVersion;
        performWolfKill(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
        return cb(room.stateVersion !== before ? { ok: true, stateVersion: room.stateVersion } : roomActionError("ACTION_REJECTED", { stateVersion: room.stateVersion }));
    });

    // ----------------------------------------------------------------
    // CAST MURDERER KILL
    // เช็คแค่ room.isNight เหมือน cast_wolf_kill ด้านบน — เลือกเป้าเองได้เลยตอนกลางคืน
    // ----------------------------------------------------------------
    socket.on("cast_murderer_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.isNight) return;

        const voter = getRoomPlayerForSocket(room, socket);
        if (!voter || !voter.alive || voter.isHost) return;
        if (voter.role !== "ฆาตกรต่อเนื่อง") return;

        if (!targetId) {
            room.murdererKillVote = null;
        } else {
            if (targetId && voter && targetId === voter.id) return;
            const target = room.players.find((p) => p.id === targetId);
            // แก้บั๊กเดียวกับ performCastVote/performWolfKill ด้านบน: เดิมไม่เช็ค target.isHost
            if (!target || target.isHost || !target.alive) return;
            room.murdererKillVote = { voterId: voter.id, targetId };
        }

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // CAST INSTIGATOR KILL (ความสามารถผู้ยุยง: หลังผู้ศรัทธาทั้งสองตายแล้วเท่านั้น สามารถฆ่า
    // ผู้เล่นคนอื่นด้วยตัวเองได้ 1 คนต่อคืน — ทำงานแบบเดียวกับ cast_murderer_kill เป๊ะๆ ต่างกันแค่
    // เงื่อนไขปลดล็อก (เช็คจาก instigatorBelieversBothDead) ดูคำอธิบายบทบาทผู้ยุยง
    // ----------------------------------------------------------------
    socket.on("cast_instigator_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.isNight) return;

        const voter = getRoomPlayerForSocket(room, socket);
        if (!voter || !voter.alive || voter.isHost) return;
        if (voter.role !== "ผู้ยุยง") return;
        if (!instigatorBelieversBothDead(room, voter)) return; // ยังไม่ปลดล็อกสิทธิ์นี้

        if (!targetId) {
            room.instigatorKillVote = null;
        } else {
            if (targetId && voter && targetId === voter.id) return;
            const target = room.players.find((p) => p.id === targetId);
            if (!target || target.isHost || !target.alive) return;
            room.instigatorKillVote = { voterId: voter.id, targetId };
        }

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // CAST BANDIT KILL (ความสามารถโจร: "คุณและผู้สมรู้ร่วมคิดสามารถฆ่าผู้เล่นหนึ่งคนในแต่ละคืนได้")
    // ใช้ได้เฉพาะคืนที่ "มีผู้สมรู้ร่วมคิดอยู่แล้ว" เท่านั้น (คืนที่ไม่มี ให้ใช้ bandit_action โหมด
    // "recruit" แทน) ทำงานแบบเดียวกับ cast_wolf_kill: หัวโจร+ผู้สมรู้ร่วมคิดต่างเลือกเป้าเองได้อิสระ
    // เก็บไว้ใน room.banditKillVotes (voterId -> targetId) แล้วไปสรุปผลตอน resolve_night (ถ้าเลือก
    // คนละเป้ากัน จะสุ่ม 1 เป้าเหมือนกลไกหมาป่า — ตามที่ผู้ใช้ระบุไว้)
    // ----------------------------------------------------------------
    function performBanditKill(room, roomId, voterId, targetId) {
        if (!room.isNight) return;

        const voter = room.players.find((p) => p.id === voterId);
        if (!voter || !voter.alive || voter.isHost) return;
        if (!BANDIT_ROLES.has(voter.role)) return;

        // ต้องมีกลุ่มโจรที่ยังมีทั้งหัวโจร+ผู้สมรู้ร่วมคิดอยู่จริง ถึงจะฆ่าร่วมกันได้ (คืนที่ยังไม่มี
        // ผู้สมรู้ร่วมคิด หัวโจรใช้ bandit_action โหมด "recruit" แทน ไม่ใช่ทางนี้)
        const leaderId = banditGroupIdOf(voter);
        if (!leaderId) return;
        if (aliveBanditAccomplicesOf(room, leaderId).length === 0) return;

        room.banditKillVotes = room.banditKillVotes || {};

        if (!targetId) {
            delete room.banditKillVotes[voterId];
        } else {
            if (targetId === voterId) return;
            const target = room.players.find((p) => p.id === targetId);
            if (!target || target.isHost || !target.alive) return;
            if (BANDIT_ROLES.has(target.role)) return; // ห้ามเลือกฆ่ากันเองในทีมโจร
            room.banditKillVotes[voterId] = targetId;
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("cast_bandit_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performBanditKill(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
    });

    // ----------------------------------------------------------------
    // RESOLVE NIGHT — สรุปผลกลางคืน
    // ----------------------------------------------------------------
    socket.on("resolve_night", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;

        // ============================================================
        // สรุปผลหมาป่า/ฆาตกรต่อเนื่องเลือกฆ่า — ย้ายมาจากเดิมที่เคยสรุปตอนโฮสต์กด "ปิดโหมดเลือกฆ่า"
        // ตอนนี้หมาป่า/ฆาตกรต่อเนื่องเลือกเป้าเองได้เลยตลอดคืน (เช็คแค่ room.isNight ใน cast_wolf_kill/
        // cast_murderer_kill) ไม่มีโหมดให้โฮสต์เปิด-ปิดอีกแล้ว พอกด "สรุปผลรอบนี้" ตรงนี้จะอ่าน
        // ค่าที่เลือกไว้ล่าสุดมาสรุปผลทันที (ถ้าหมาป่าเลือกกันคนละเป้า จะสุ่ม 1 เป้าเหมือนเดิม)
        // แล้วเคลียร์ทิ้ง (รีทิ้ง) ทันทีหลังอ่านค่า ก่อนจะเข้าลูปประมวลผลการตายด้านล่าง
        // ============================================================
        {
            const votesBeforeClear = room.wolfKillVotes;
            const murdererVoteBeforeClear = room.murdererKillVote;
            const instigatorVoteBeforeClear = room.instigatorKillVote;
            const banditVotesBeforeClear = room.banditKillVotes;

            room.wolfKillVotes = {};
            room.murdererKillVote = null;
            room.instigatorKillVote = null;
            room.banditKillVotes = {};

            // หาเป้าหมายที่หมาป่าโหวต (ไม่รวมทีมหมาป่า)
            // หมายเหตุ: "ฆาตกรต่อเนื่อง" ไม่ถูกกรองออกตรงนี้แล้ว — ต้องปล่อยให้ไหลเข้า killResults ตามปกติ
            // (ขึ้นสถานะ "เล็งฆ่า" เหมือนเป้าหมายทั่วไปทุกประการ) แล้วให้ block ด้านล่าง
            // (killer === "wolf" && target.role === "ฆาตกรต่อเนื่อง") เป็นตัวจัดการ block การตายจริง
            const wolfChosenTargets = [...new Set(
                Object.values(votesBeforeClear || {}).filter((tid) => {
                    const t = room.players.find((p) => p.id === tid);
                    return t && !WOLF_ROLES.has(t.role);
                })
            )];

            // ฆาตกรต่อเนื่องเลือกฆ่าใคร (ถ้ามี)
            const murdererVote = murdererVoteBeforeClear; // { voterId, targetId }
            // ผู้ยุยง (ปลดล็อกแล้วหลังผู้ศรัทธาทั้งสองตาย) เลือกฆ่าใคร (ถ้ามี)
            const instigatorVote = instigatorVoteBeforeClear; // { voterId, targetId }

            // รายการผู้ถูกเลือกฆ่า พร้อม killer type
            // ถ้าหมาป่ากับฆาตกรต่อเนื่อง/ผู้ยุยงเลือกคนเดียวกัน → ฆาตกรต่อเนื่อง/ผู้ยุยงเป็นคนฆ่า
            const killResults = {}; // targetId → "wolf" | "murderer" | "instigator"

            if (wolfChosenTargets.length > 0) {
                // เลือก 1 เป้าจากหมาป่า (ถ้าเสมอกัน random)
                const wolfFinalId = wolfChosenTargets.length === 1
                    ? wolfChosenTargets[0]
                    : wolfChosenTargets[Math.floor(Math.random() * wolfChosenTargets.length)];
                killResults[wolfFinalId] = "wolf";
            }

            if (murdererVote) {
                const mtarget = room.players.find((p) => p.id === murdererVote.targetId);
                if (mtarget && mtarget.alive) {
                    // ฆาตกรต่อเนื่องเลือกคนเดียวกับหมาป่า → ฆาตกรต่อเนื่องชนะ (override)
                    // ฆาตกรต่อเนื่องเลือกหมาป่า → ฆ่าได้ปกติ
                    killResults[murdererVote.targetId] = "murderer";
                }
            }

            if (instigatorVote) {
                const itarget = room.players.find((p) => p.id === instigatorVote.targetId);
                if (itarget && itarget.alive) {
                    // ผู้ยุยงเลือกคนเดียวกับหมาป่า/ฆาตกรต่อเนื่อง → ผู้ยุยงเป็นคนฆ่า (override เหมือนกัน)
                    killResults[instigatorVote.targetId] = "instigator";
                }
            }

            // โจร: หัวโจร+ผู้สมรู้ร่วมคิดต่างเลือกเป้าเองได้อิสระ (ดู cast_bandit_kill) — ถ้าเลือก
            // คนละเป้ากัน สุ่ม 1 เป้าเหมือนกลไกหมาป่า ทับเป้าของหมาป่า/ฆาตกรต่อเนื่อง/ผู้ยุยงได้เช่นกัน
            // ถ้าบังเอิญเลือกเป้าเดียวกัน (ลำดับความสำคัญเดียวกับผู้ยุยง/ฆาตกรต่อเนื่อง)
            const banditChosenTargets = [...new Set(Object.values(banditVotesBeforeClear || {}).filter(Boolean))];
            let banditFinalId = null;
            if (banditChosenTargets.length > 0) {
                banditFinalId = banditChosenTargets.length === 1
                    ? banditChosenTargets[0]
                    : banditChosenTargets[Math.floor(Math.random() * banditChosenTargets.length)];
                const btarget = room.players.find((p) => p.id === banditFinalId);
                if (btarget && btarget.alive) {
                    killResults[banditFinalId] = "bandit";
                }
            }

            // ตรวจว่าหมาป่าเลือกฆาตกรต่อเนื่อง → หมาป่าฆ่าฆาตกรต่อเนื่องไม่ตาย ส่ง wolf chat แจ้ง
            Object.entries(killResults).forEach(([targetId, killer]) => {
                const target = room.players.find((p) => p.id === targetId);
                if (!target) return;

                if (killer === "wolf" && target.role === "ฆาตกรต่อเนื่อง") {
                    // หมาป่าฆ่าฆาตกรต่อเนื่องไม่ตาย
                    const failMsg = {
                        name: "เกม",
                        text: `ไม่สามารถโจมตี ${target.name} ได้`,
                        type: "wolf",
                        isSystem: true,
                    };
                    room.wolfChatHistory = room.wolfChatHistory || [];
                    room.wolfChatHistory.push(failMsg);
                    room.players.forEach((p) => {
                        if (WOLF_ROLES.has(p.role)) {
                            io.to(p.id).emit("chat_message", failMsg);
                        }
                    });
                    io.to(hostRoomName(roomId)).emit("chat_message", failMsg); // ส่งให้ทุกจอโฮสต์
                    return;
                }

                // ติ๊ก killed พร้อมเก็บ killerType ไว้แสดงตอน resolve (ลูปด้านล่างจะอ่านค่านี้ต่อ)
                target.killed = true;
                target.killedBy = killer; // "wolf" หรือ "murderer" หรือ "instigator"
                // เก็บ id ของฆาตกรต่อเนื่อง/ผู้ยุยงตัวจริงที่ลงมือ (ไม่ใช่แค่ role) — กันเคสห้องเดียวมี
                // ฆาตกรต่อเนื่อง/ผู้ยุยงได้มากกว่า 1 คน ใช้ตอนแจ้งส่วนตัวว่า "โจมตีไม่สำเร็จ" ให้ถูกคนที่ลงมือจริง
                if (killer === "murderer" && murdererVote) {
                    target.killedByPlayerId = murdererVote.voterId;
                } else if (killer === "instigator" && instigatorVote) {
                    target.killedByPlayerId = instigatorVote.voterId;
                } else if (killer === "bandit") {
                    // ระบุ "ผู้ลงมือจริง" จากรายชื่อที่โหวตเป้านี้ (ถ้าทั้งหัวโจรและผู้สมรู้ร่วมคิด
                    // เลือกเป้าเดียวกัน จะได้คนใดคนหนึ่งไปแบบสุ่มลำดับ — ไม่สำคัญว่าใคร เพราะเป็นการ
                    // ฆ่าร่วมกันของทั้งกลุ่มอยู่แล้ว)
                    const voterEntry = Object.entries(banditVotesBeforeClear || {}).find(([, tid]) => tid === targetId);
                    target.killedByPlayerId = voterEntry ? voterEntry[0] : null;
                }
            });
        }


        const protectRoles = new Set(["หมอ", "บอดี้การ์ด", "แม่มด"]);
        const silenceRoles = new Set(["ยายขี้โมโห"]);

        function findProtectorsOf(targetId) {
            if (!room.selectedTargets) return [];
            return Object.keys(room.selectedTargets)
                .filter((sid) => room.selectedTargets[sid] === targetId)
                .map((sid) => room.players.find((p) => p.id === sid))
                .filter((s) => s && protectRoles.has(s.role));
        }

        // อันธพาล: นอกจากปกป้องตัวเองอัตโนมัติแล้ว (ดู branch p.role === "อันธพาล" ด้านล่าง)
        // ยังเลือก "อีก 1 คน" ต่อคืนเพื่อปกป้องเพิ่มได้ด้วย ผ่าน select_target ธรรมดา (เก็บไว้ใน
        // room.selectedTargets เหมือนบทอื่นๆ แต่ไม่ใช้กลไก .protected แบบหมอ/บอดี้การ์ด/แม่มด
        // เพราะผลลัพธ์ไม่ใช่ "รอดเฉยๆ ไม่มีใครรู้" — คนที่ถูกปกป้องไว้จะรอด แต่ตัวอันธพาลเองจะถูก
        // เปิดเผยตัวให้ผู้โจมตีเห็นแทน และเสียชีวิตทีหลังเหมือนกรณีปกป้องตัวเอง (ดูคอมเมนต์ที่
        // branch ด้านล่าง) — เลือกได้แค่คนเดียวต่อคืน ไม่ใช่ตัวเอง (ตัวเองปกป้องอัตโนมัติอยู่แล้ว)
        function findThugGuardOf(targetId) {
            if (!room.selectedTargets) return [];
            return Object.keys(room.selectedTargets)
                .map((sid) => room.players.find((p) => p.id === sid))
                .filter((s) => s && s.alive && s.role === "อันธพาล" && !s.musclemanExposed)
                .filter((s) => room.selectedTargets[s.id] === targetId);
        }

        // ============================================================
        // ผู้นำลัทธิ: สรุปผลการ "ชักชวนเข้าลัทธิ" หรือ "สังเวยสมาชิกลัทธิเพื่อฆ่า" ที่เลือกไว้เมื่อคืนนี้
        // (room.cultActions[leaderId] — ดู performCultAction) ทำหลัง killResults ของหมาป่า/ฆาตกร/ผู้ยุยง
        // เสร็จแล้ว เพื่อให้การสังเวยของลัทธิ "แทนที่" การเลือกเป้าของหมาป่าได้ถ้าบังเอิญเลือกคนเดียวกัน
        // (สอดคล้องกับลำดับความสำคัญเดิม: ฆาตกรต่อเนื่อง/ผู้ยุยง ก็ทับหมาป่าได้เหมือนกัน)
        // การสังเวยสมาชิกลัทธิเองข้ามระบบป้องกันทั้งหมด (หมอ/บอดี้การ์ด/แม่มด) เพราะไม่ใช่การถูกโจมตี
        // จากภายนอก แต่เป้าหมายที่ถูกลัทธิ "ฆ่า" ยังคงเข้าสู่ pipeline .killed ปกติ ให้ระบบป้องกัน
        // ทำงานตามปกติกับเป้านั้น (คนละคนกับสมาชิกที่ถูกสังเวย)
        const cultPending = room.cultActions || {};
        room.cultActions = {};
        const cultDeferredMessages = []; // จะ push เข้า nightMessages ทีหลัง (ยังไม่ได้ประกาศตัวแปรนั้น ณ จุดนี้)
        const cultDeferredCascades = []; // จะ push เข้า allCascadeDeaths ทีหลังเช่นกัน

        Object.entries(cultPending).forEach(([leaderId, action]) => {
            const leader = room.players.find((p) => p.id === leaderId);
            if (!leader || !leader.alive || leader.role !== "ผู้นำลัทธิ" || !action) return;

            if (action.mode === "recruit") {
                const target = room.players.find((p) => p.id === action.targetId);

                // เช็คว่าชวนได้ไหม — ถ้าไม่ได้ แจ้งผู้นำลัทธิแบบกลางๆ เฉยๆ ว่า "ชวนไม่ได้" ตอนเช้า
                // (ไม่บอกเหตุผลละเอียด เพราะจะแอบเผยบทจริงของเป้าหมายไปด้วย เช่นบอกว่า "เป็นหมาป่า"
                // ก็เท่ากับบอกอ้อมๆ ว่าเป้าหมายเป็นหมาป่า ซึ่งไม่ควรรู้ได้จากการชวนไม่สำเร็จ)
                // alreadyMember = กรณีพิเศษที่ "ไม่ใช่ความล้มเหลว" (เป็นสมาชิกของเราอยู่แล้ว) เลยไม่ต้องแจ้งอะไร
                let failed = false;
                let alreadyMember = false;
                let redirectThug = null; // อันธพาลที่เข้าปกป้องเป้าหมายไว้ จะเข้าลัทธิ "แทน" เป้าหมายเดิม
                let bodyguardSelfBlocked = false; // บอดี้การ์ดป้องกันตัวเองจากการชวนได้ (ครั้งแรก, บาดเจ็บ)
                let thugSelfBlocked = false; // อันธพาลป้องกันตัวเองจากการชวนได้ (ครั้งแรก, เปิดเผยสถานะป้องกัน)

                if (!target || target.isHost) {
                    // เป้าหมายหลุดออกจากห้องไปแล้ว ไม่ควรเกิดขึ้นได้จริง — ข้ามเงียบๆ
                } else if (!target.alive) {
                    failed = true;
                } else if (WOLF_ROLES.has(target.role)) {
                    failed = true;
                } else if (SOLO_KILLER_ROLES.has(target.role)) {
                    failed = true;
                } else if (target.role === "ผู้นำลัทธิ") {
                    failed = true;
                } else if (CULT_RECRUIT_IMMUNE_ROLES.has(target.role)) {
                    failed = true;
                } else if (target.cultLeaderId === leader.id) {
                    alreadyMember = true;
                } else if (target.cultLeaderId) {
                    failed = true;
                } else if (aliveCultMembersOf(room, leader.id).length >= CULT_MAX_MEMBERS) {
                    failed = true;
                } else if (findThugGuardOf(target.id)[0]) {
                    // มีอันธพาล (ที่ยังไม่ถูกเปิดเผย) เข้าปกป้องเป้าหมายนี้ไว้เมื่อคืน — เหมือนกรณีโดนโจมตี
                    // (ดู branch findThugGuardOf ในการสรุปผลโจมตีด้านล่าง) แต่ผลลัพธ์ต่างกัน: แทนที่จะ
                    // เปิดเผยตัว+ตายทีหลัง อันธพาลจะถูกชักชวนเข้าลัทธิ "แทน" เป้าหมายเดิมไปเลย เป้าหมาย
                    // เดิมรอด ไม่รู้ตัวว่ามีใครพยายามชวนหรือใครปกป้องไว้ (รักษาความลับเหมือนเดิม)
                    redirectThug = findThugGuardOf(target.id)[0];
                } else if (target.role === "บอดี้การ์ด" && !target.bodyguardInjured) {
                    // เป้าหมายเป็นบอดี้การ์ดที่ยังไม่บาดเจ็บ — ป้องกันตัวเองจากการถูกชวนได้ครั้งแรก
                    // เหมือนโดนโจมตี (ใช้ flag bodyguardInjured ร่วมกับระบบโจมตีปกติ) ครั้งต่อไปจะไม่มี
                    // การป้องกันเหลือแล้ว ถ้าถูกชวนอีกจะเข้าลัทธิจริง
                    target.bodyguardInjured = true;
                    failed = true;
                    bodyguardSelfBlocked = true;
                } else if (target.role === "อันธพาล" && !target.musclemanExposed) {
                    // เป้าหมายเป็นอันธพาลที่ยังไม่ถูกเปิดเผย — ป้องกันตัวเองจากการถูกชวนได้ครั้งแรกเช่นกัน
                    // (ใช้ flag musclemanExposed ร่วมกับระบบโจมตีปกติ) แต่ไม่เปิดเผยตัวตนให้ผู้นำลัทธิเห็น
                    // และไม่ตายทีหลัง (musclemanPendingDeath) เพราะการชวนไม่ใช่การโจมตี — แค่เสียการ
                    // ป้องกันตัวเองสำหรับครั้งต่อไป ถ้าถูกชวนอีกจะเข้าลัทธิจริง
                    target.musclemanExposed = true;
                    failed = true;
                    thugSelfBlocked = true;
                } else if (findProtectorsOf(target.id).length > 0) {
                    // มีคนป้องกันเป้าหมายไว้คืนนี้ (หมอ/แม่มด) — ชวนเข้าลัทธิไม่ได้เหมือนกัน
                    failed = true;
                }

                if (redirectThug) {
                    // อันธพาลที่เข้าปกป้องเข้าลัทธิแทนเป้าหมายเดิม
                    redirectThug.cultLeaderId = leader.id;
                    sendPrivateChat(room, redirectThug.id, {
                        name: "เกม",
                        text: `🔯 เมื่อคืนคุณเข้าปกป้อง ${target.name} ไว้ และถูกชักชวนเข้าลัทธิแทนเขา! หัวหน้าลัทธิของคุณคือ ${leader.name}`,
                        type: "private",
                        isSystem: true,
                    });
                    sendPrivateChat(room, leader.id, {
                        name: "เกม",
                        text: `🔯 ${redirectThug.name} เข้าร่วมลัทธิของคุณแล้ว`,
                        type: "private",
                        isSystem: true,
                    });
                    broadcastCultRoster(room, leader.id);
                    return;
                }

                if (failed) {
                    // ใส่ชื่อเป้าหมายในข้อความได้อย่างปลอดภัย (ไม่รั่วบทจริง) เพราะผู้นำลัทธิเป็นคนเลือกเป้าเองอยู่แล้ว
                    // รู้อยู่แล้วว่าชวนใคร แค่ยังไม่รู้ว่า "ทำไม" ถึงไม่สำเร็จเท่านั้น (เหตุผลยังคงไม่บอกตามคอมเมนต์ด้านบน)
                    sendPrivateChat(room, leader.id, {
                        name: "เกม",
                        text: `🔯 ไม่สามารถนำ ${target.name} เข้าลัทธิได้`,
                        type: "private",
                        isSystem: true,
                    });
                    if (bodyguardSelfBlocked) {
                        sendPrivateChat(room, target.id, {
                            name: "เกม",
                            text: `💂 เมื่อคืนมีคนพยายามชักชวนคุณเข้าลัทธิ แต่คุณป้องกันตัวเองได้ (บาดเจ็บ) หากถูกชวนอีกครั้งคุณจะเข้าร่วมจริง`,
                            type: "private",
                            isSystem: true,
                        });
                    } else if (thugSelfBlocked) {
                        sendPrivateChat(room, target.id, {
                            name: "เกม",
                            text: `💪 เมื่อคืนมีคนพยายามชักชวนคุณเข้าลัทธิ แต่คุณป้องกันตัวเองได้ หากถูกชวนอีกครั้งคุณจะเข้าร่วมจริง`,
                            type: "private",
                            isSystem: true,
                        });
                    }
                    return;
                }
                if (!target || alreadyMember) return; // ไม่มีอะไรต้องทำต่อ ไม่ใช่ความล้มเหลว ไม่ต้องแจ้ง

                target.cultLeaderId = leader.id;

                sendPrivateChat(room, target.id, {
                    name: "เกม",
                    text: `🔯 คุณถูกชักชวนเข้าร่วมลัทธิแล้ว! หัวหน้าลัทธิของคุณคือ ${leader.name}`,
                    type: "private",
                    isSystem: true,
                });
                sendPrivateChat(room, leader.id, {
                    name: "เกม",
                    text: `🔯 ${target.name} เข้าร่วมลัทธิของคุณแล้ว`,
                    type: "private",
                    isSystem: true,
                });
                broadcastCultRoster(room, leader.id);
            } else if (action.mode === "sacrifice") {
                const member = room.players.find((p) => p.id === action.sacrificeId);
                const target = room.players.find((p) => p.id === action.targetId);
                if (!member || !member.alive || member.cultLeaderId !== leader.id) return;
                if (!target || !target.alive || target.isHost) return;

                member.alive = false;
                cultDeferredCascades.push(...cleanupAfterDeath(room, member));
                cultDeferredMessages.push({
                    name: "เกม",
                    text: `🕯️ ลัทธิได้สังเวยสมาชิกของตน (${member.name}) เพื่อทำพิธี`,
                    type: "global",
                    isSystem: true,
                    isDeath: true,
                });

                if (target.alive) {
                    target.killed = true;
                    target.killedBy = "cult";
                    target.killedByPlayerId = leader.id;
                }
                broadcastCultRoster(room, leader.id);
            }
        });

        // ============================================================
        // โจร: สรุปผลการ "เปลี่ยนบทบาทเป็นผู้สมรู้ร่วมคิด" ที่เลือกไว้เมื่อคืนนี้ (room.banditActions[leaderId]
        // — ดู performBanditAction) ทำหลัง killResults ของหมาป่า/ฆาตกร/ผู้ยุยง/โจร (ฆ่า) เสร็จแล้ว
        // ใช้ได้เฉพาะคืนที่ยังไม่มีผู้สมรู้ร่วมคิดเท่านั้น (เช็คซ้ำอีกครั้งตรงนี้ กันเคส action ค้างจาก
        // คืนก่อนหน้าที่บังเอิญมีผู้สมรู้ร่วมคิดเกิดขึ้นแล้วระหว่างทาง) ถ้าเป้าหมายเป็นมนุษย์หมาป่า จะถูก
        // ฆ่าทันทีแทนการเปลี่ยนบทบาท (เข้า pipeline .killed ปกติ ให้ระบบป้องกันทำงานตามปกติเหมือนกัน)
        // ============================================================
        const banditPending = room.banditActions || {};
        room.banditActions = {};

        Object.entries(banditPending).forEach(([leaderId, action]) => {
            const leader = room.players.find((p) => p.id === leaderId);
            if (!leader || !leader.alive || leader.role !== "โจร" || !action) return;
            if (aliveBanditAccomplicesOf(room, leader.id).length > 0) return; // มีผู้สมรู้ร่วมคิดอยู่แล้ว เปลี่ยนซ้ำไม่ได้

            const target = room.players.find((p) => p.id === action.targetId);
            if (!target || target.isHost) return;

            if (!target.alive) {
                sendPrivateChat(room, leader.id, {
                    name: "เกม",
                    text: `🗡️ ไม่สามารถเปลี่ยนบทบาท ${target.name} ได้`,
                    type: "private",
                    isSystem: true,
                });
                return;
            }

            if (WOLF_ROLES.has(target.role)) {
                // เป้าหมายเป็นมนุษย์หมาป่า → ฆ่าทันทีแทนการเปลี่ยนบทบาท (ยังคงเข้า pipeline การป้องกัน
                // ปกติ — หมอ/บอดี้การ์ด/แม่มด ยังช่วยได้ตามปกติเหมือนการโจมตีอื่นๆ ทุกประการ)
                target.killed = true;
                target.killedBy = "bandit";
                target.killedByPlayerId = leader.id;
                return;
            }

            let failed = false;
            if (BANDIT_ROLES.has(target.role)) {
                failed = true; // เป็นโจร/ผู้สมรู้ร่วมคิดอยู่แล้ว (ของกลุ่มตัวเองหรือกลุ่มอื่น) เปลี่ยนซ้ำไม่ได้
            } else if (BANDIT_RECRUIT_IMMUNE_ROLES.has(target.role)) {
                failed = true; // ผู้ถูกสาป — ห้ามถูกเปลี่ยนบทบาทจากภายนอกเด็ดขาด
            } else if (SOLO_KILLER_ROLES.has(target.role)) {
                failed = true; // นักฆ่าเดี่ยว (ฆาตกรต่อเนื่อง/นักเล่นกล) — เปลี่ยนไม่ได้เหมือนลัทธิ
            } else if (findProtectorsOf(target.id).length > 0) {
                failed = true; // มีคนป้องกันเป้าหมายไว้คืนนี้ (หมอ/บอดี้การ์ด/แม่มด) — เปลี่ยนบทบาทไม่ได้
            }

            if (failed) {
                // ไม่บอกเหตุผลละเอียด (จะแอบเผยบทจริงของเป้าหมายไปด้วยโดยไม่ตั้งใจ) — หลักการเดียวกับลัทธิ
                sendPrivateChat(room, leader.id, {
                    name: "เกม",
                    text: `🗡️ ไม่สามารถเปลี่ยนบทบาท ${target.name} ได้`,
                    type: "private",
                    isSystem: true,
                });
                return;
            }

            // สำเร็จ: เปลี่ยนบทบาทของเป้าหมายจริงๆ เป็น "ผู้สมรู้ร่วมคิด"
            const originalRole = target.role;
            target.role = "ผู้สมรู้ร่วมคิด";
            target.displayRole = `ผู้สมรู้ร่วมคิด (เดิม: ${originalRole})`;
            target.banditLeaderId = leader.id;

            io.to(target.id).emit("your_role", buildYourRolePayload(target, { silent: true, extended: false }, room));
            sendPrivateChat(room, target.id, {
                name: "เกม",
                text: `🗡️ คุณถูกโจรเปลี่ยนบทบาทเป็นผู้สมรู้ร่วมคิดแล้ว! หัวโจรของคุณคือ ${leader.name}`,
                type: "private",
                isSystem: true,
            });
            sendPrivateChat(room, leader.id, {
                name: "เกม",
                text: `🗡️ ${target.name} กลายเป็นผู้สมรู้ร่วมคิดของคุณแล้ว`,
                type: "private",
                isSystem: true,
            });

            if (room.banditChatHistory?.[leader.id]?.length) {
                io.to(target.id).emit("bandit_chat_history", room.banditChatHistory[leader.id]);
            }
        });

        const nightMessages = [];
        const wolfChatMessages = [];
        const privateProtectMessages = []; // { playerId, text }
        const privateBiteMessages = []; // { playerId, text } — ส่งตรงถึงคนเดียว ไม่เข้า wolf chat/history ที่ทีมหมาป่าทั้งหมดเห็น
        const allCascadeDeaths = [];

        // คู่กามเทพที่เพิ่ง "กลายเป็นคู่จริง" ในการสรุปผลรอบนี้เอง (เติมค่าจาก applyCupidPair ด้านล่าง)
        // ส่งต่อให้ cleanupAfterDeath ใช้เช็คว่าคู่นี้เพิ่งจับกันคืนนี้หรือเปล่า — ถ้าใช่และมีฝ่ายใดตาย
        // คืนเดียวกันนี้ จะสุ่มจับคู่ใหม่ให้ฝ่ายที่รอดแทนการตายตามกัน (ดูคอมเมนต์ที่ reassignFreshLoverPair)
        const freshCupidPairsThisResolve = [];

        // เอาผลลัพธ์ของผู้นำลัทธิที่คำนวณไว้ก่อนหน้านี้ (ก่อนตัวแปรพวกนี้จะถูกประกาศ) มารวมเข้าลิสต์จริง
        nightMessages.push(...cultDeferredMessages);
        allCascadeDeaths.push(...cultDeferredCascades);

        // ============================================================
        // สรุปคู่ที่กามเทพ/ผู้ยุยง "เลือกไว้" เมื่อคืนนี้ (room.pendingLoverPair/pendingInstigatorPair
        // — ดู performCupidPair/performInstigatorPair) ให้กลายเป็นคู่จริงตอนเช้านี้ ทำก่อนประมวลผล
        // การตายทั้งหมดด้านล่าง (แม่มด/ป้องกัน/คลี่คลายการตาย) เพื่อให้ระบบรู้ทันว่าคืนนี้เพิ่งมีคู่ไหน
        // เกิดขึ้นใหม่บ้าง (เก็บไว้ใน freshCupidPairsThisResolve) — ฝั่งผู้ยุยงยังตายตามกันทันทีเหมือนเดิม
        // ทุกกรณี ส่วนฝั่งกามเทพ ถ้าคู่ที่เพิ่งจับ "คืนนี้เอง" มีฝ่ายใดตายไปก่อนในการสรุปผลรอบเดียวกันนี้
        // จะไม่ตายตามกัน แต่สุ่มจับคู่ใหม่ให้ฝ่ายที่รอดแทน (ดู cleanupAfterDeath/reassignFreshLoverPair —
        // ปรับพฤติกรรมตามคำขอผู้ใช้: ไม่ให้ตายตามกันตั้งแต่คืนแรกที่เพิ่งถูกจับคู่)
        //
        // แก้บั๊ก/ปรับพฤติกรรม: เดิมกามเทพ/ผู้ยุยงถูก "ล็อกสิทธิ์ทันที" ตั้งแต่ตอนเลือกครบ 2 คน
        // (เช็คจาก p.cupidPaired/p.instigatorPaired ใน performCupidPair/performInstigatorPair)
        // ทำให้เปลี่ยนใจไม่ได้เลยแม้ยังไม่เช้า ตอนนี้เอาการ "ล็อกสิทธิ์ถาวร" มาไว้ที่นี่แทน (ตอนเช้า
        // จริงๆ) — ระหว่างคืนเลือกใหม่ทับ/ยกเลิกกี่รอบก็ได้ผ่าน performCupidPair/performInstigatorPair
        // (ดูคอมเมนต์ที่นิยามฟังก์ชันทั้งสอง) ไม่มีทางเช็คว่าคู่ที่เลือกไปทับซ้อนกับที่อีกฝ่าย (กามเทพ/
        // ผู้ยุยง) เลือกไว้หรือเปล่าอีกต่อไป (ตั้งใจไม่เช็ค ยอมให้ทับซ้อนกันได้ เพื่อความเรียบง่าย)
        //
        // ถ้าคืนนี้ไม่มีใครเลือกไว้เลย ให้ใช้ fallback ที่กำหนดไว้เพื่อให้สถานะการจับคู่ไม่ค้าง

        function applyCupidPair(selector, targetA, targetB) {
            targetA.loverId = targetB.id;
            targetB.loverId = targetA.id;
            revealRoleMutual(targetA, targetB);
            selector.cupidPaired = true; // ล็อกสิทธิ์ถาวร "ตอนนี้" เท่านั้น ตอนคู่กลายเป็นคู่จริงแล้ว
            selector.lastCupidPairText = `${targetA.name} × ${targetB.name}`;
            // เก็บ id คู่ที่จับไว้ให้กามเทพเห็นไอคอน 💘 บนการ์ดคู่นั้นด้วย (เหมือนที่คู่รักเห็นกันเอง)
            // แต่กามเทพไม่เห็นว่าผู้ยุยงจับคู่ใครไว้ — คนละ field คนละกลไกกันคนละสิ้นเชิง
            selector.cupidPairTargetIds = [targetA.id, targetB.id];
            // จำไว้ว่าคู่นี้ "เพิ่งจับกันคืนนี้เอง" — ให้ cleanupAfterDeath ด้านล่างเช็คได้ (ดูคอมเมนต์บน
            // freshCupidPairsThisResolve/reassignFreshLoverPair)
            freshCupidPairsThisResolve.push({ selectorId: selector.id, aId: targetA.id, bId: targetB.id });

            sendPrivateChat(room, selector.id, {
                name: "เกม",
                text: `💖 ${targetA.name} และ ${targetB.name} กลายเป็นคู่รักกันแล้วเมื่อคืนนี้!`,
                type: "private",
                isSystem: true,
            });
            const loveMsg = {
                name: "เกม",
                text: `💘กามเทพได้จับคู่คุณกับ ${"__PARTNER__"} คุณจะต้องช่วยกันเพื่อให้ชนะทีมคู่รัก หากอีกฝ่ายตายคุณจะตายด้วย`,
                type: "private",
                isSystem: true,
            };
            sendPrivateChat(room, targetA.id, { ...loveMsg, text: loveMsg.text.replace("__PARTNER__", targetB.name) });
            sendPrivateChat(room, targetB.id, { ...loveMsg, text: loveMsg.text.replace("__PARTNER__", targetA.name) });
        }

        function applyInstigatorPair(selector, targetA, targetB) {
            targetA.instigatorLinkId = targetB.id;
            targetB.instigatorLinkId = targetA.id;
            revealRoleMutual(targetA, targetB);
            selector.instigatorPaired = true; // ล็อกสิทธิ์ถาวร "ตอนนี้" เท่านั้น ตอนคู่กลายเป็นคู่จริงแล้ว

            // กลุ่มเดียวกันสำหรับผลส่องของนักสืบ: ตัวผู้ยุยงเอง + คู่ที่ถูกจับทั้งสอง
            // ให้ถูกมองว่า "ทีมเดียวกัน" เสมอเวลาส่องคู่กันเอง (ดู performDetectiveScout)
            selector.instigatorGroupId = selector.id;
            targetA.instigatorGroupId = selector.id;
            targetB.instigatorGroupId = selector.id;

            // เปิดเผยบทบาทที่แท้จริงของผู้ยุยงให้ทั้งคู่เห็นด้วย (ทางเดียว)
            selector.roleRevealMutualWith = selector.roleRevealMutualWith || [];
            if (!selector.roleRevealMutualWith.includes(targetA.id)) selector.roleRevealMutualWith.push(targetA.id);
            if (!selector.roleRevealMutualWith.includes(targetB.id)) selector.roleRevealMutualWith.push(targetB.id);

            selector.lastInstigatorPairText = `${targetA.name} × ${targetB.name}`;
            // เก็บ id คู่ที่จับไว้ให้ผู้ยุยงเห็นไอคอนรูปผู้ยุยงบนการ์ดคู่นั้นด้วย (เหมือนที่คู่ที่ถูกจับเห็นกันเอง)
            // แต่ผู้ยุยงไม่เห็นว่ากามเทพจับคู่ใครไว้ — คนละ field คนละกลไกกันคนละสิ้นเชิง
            selector.instigatorPairTargetIds = [targetA.id, targetB.id];

            sendPrivateChat(room, selector.id, {
                name: "เกม",
                text: `🎭 ${targetA.name} และ ${targetB.name} ถูกจับคู่กันแล้วเมื่อคืนนี้!`,
                type: "private",
                isSystem: true,
            });
            const linkMsg = {
                name: "เกม",
                text: `🎭 คุณถูกผู้ยุยงจับคู่ไว้กับ ${"__PARTNER__"} แบบไม่ทราบสาเหตุตั้งแต่เมื่อคืนนี้! ทั้งคู่เห็นบทบาทที่แท้จริงของกันและกันแล้ว รวมถึงเห็นตัวตนที่แท้จริงของผู้ยุยงด้วย หากฝ่ายใดฝ่ายหนึ่งตาย อีกฝ่ายจะตายตามไปด้วยทันที และทั้งคู่จะชนะร่วมกับ "ทีมผู้ยุยง" เท่านั้น ไม่ชนะร่วมกับทีมเดิมของตัวเองอีกต่อไป`,
                type: "private",
                isSystem: true,
            };
            sendPrivateChat(room, targetA.id, { ...linkMsg, text: linkMsg.text.replace("__PARTNER__", targetB.name) });
            sendPrivateChat(room, targetB.id, { ...linkMsg, text: linkMsg.text.replace("__PARTNER__", targetA.name) });
        }

        // สุ่ม 2 คน (ไม่ใช่ตัวผู้จับคู่เอง ไม่ต้องเช็คว่าถูกจับคู่ไปแล้วหรือยัง — ดูคอมเมนต์ด้านบน)
        // จากผู้เล่นที่ยังไม่ตายและไม่ใช่โฮสต์ ให้ selector คนหนึ่ง คืน null ถ้าผู้เล่นไม่พอ (<2 คน)
        function pickRandomPairFor(selectorId) {
            const pool = room.players.filter((p) => p.alive && !p.isHost && p.id !== selectorId);
            if (pool.length < 2) return null;
            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            return [shuffled[0], shuffled[1]];
        }

        // เหมือน pickRandomPairFor เป๊ะๆ แต่ตัด "ผู้ถูกสาป" ออกจากกลุ่มที่สุ่มได้ — ใช้เฉพาะ fallback
        // สุ่มจับคู่อัตโนมัติของผู้ยุยง (เช่นตอนบอทได้รับบทผู้ยุยง) ให้สอดคล้องกับกฎห้ามจับคู่ผู้ถูกสาป
        // ที่ performInstigatorPair เช็คไว้แล้วตอนเลือกเองผ่าน UI (ดูคอมเมนต์ตรงนั้น)
        function pickRandomPairForInstigator(selectorId) {
            const pool = room.players.filter((p) => p.alive && !p.isHost && p.id !== selectorId && p.role !== "ผู้ถูกสาป");
            if (pool.length < 2) return null;
            const shuffled = [...pool].sort(() => Math.random() - 0.5);
            return [shuffled[0], shuffled[1]];
        }

        if (room.pendingLoverPair) {
            const pending = room.pendingLoverPair;
            room.pendingLoverPair = null;
            const selector = room.players.find((p) => p.id === pending.selectorId);
            const targetA = room.players.find((p) => p.id === pending.targetAId);
            const targetB = room.players.find((p) => p.id === pending.targetBId);
            if (selector && targetA && targetB) applyCupidPair(selector, targetA, targetB);
        } else {
            // ไม่มีใครเลือกไว้คืนนี้ — สุ่มจับคู่ให้กามเทพที่ยังไม่เคยจับคู่มาก่อนทุกคน (ปกติมีคนเดียว)
            room.players
                .filter((p) => p.alive && !p.isHost && p.role === "กามเทพ" && !p.cupidPaired)
                .forEach((selector) => {
                    const pair = pickRandomPairFor(selector.id);
                    if (pair) applyCupidPair(selector, pair[0], pair[1]);
                });
        }

        if (room.pendingInstigatorPair) {
            const pending = room.pendingInstigatorPair;
            room.pendingInstigatorPair = null;
            const selector = room.players.find((p) => p.id === pending.selectorId);
            const targetA = room.players.find((p) => p.id === pending.targetAId);
            const targetB = room.players.find((p) => p.id === pending.targetBId);
            if (selector && targetA && targetB) applyInstigatorPair(selector, targetA, targetB);
        } else {
            room.players
                .filter((p) => p.alive && !p.isHost && p.role === "ผู้ยุยง" && !p.instigatorPaired)
                .forEach((selector) => {
                    const pair = pickRandomPairForInstigator(selector.id);
                    if (pair) applyInstigatorPair(selector, pair[0], pair[1]);
                });
        }

        // แจ้ง "โจมตีไม่สำเร็จ" ให้ถูกช่องทาง — ถ้าคนลงมือเป็นฆาตกรต่อเนื่อง (ทีม solo ไม่ใช่ทีมหมาป่า)
        // ให้แจ้งฆาตกรต่อเนื่องตัวจริงเป็นการส่วนตัว ไม่เข้าแชทหมาป่า (กันหมาป่าทั้งทีมเห็นข้อความที่ไม่เกี่ยวกับ
        // เป้าที่ตัวเองเลือก) ส่วนกรณีอื่นถือว่าเป็นหมาป่าลงมือ แจ้งเข้าแชทหมาตามปกติ — ใช้ร่วมกันระหว่าง
        // branch p.protected และ branch bodyguard/muscleman ด้านล่าง ที่ต้องเช็คเงื่อนไขเดียวกันเป๊ะ
        function notifyFailedAttack(p) {
            const killerType = p.killedBy || "wolf";
            if (PERSONAL_ATTACKER_KILL_TYPES.has(killerType)) {
                const soloAttacker = p.killedByPlayerId
                    ? room.players.find((mp) => mp.id === p.killedByPlayerId)
                    : null;
                if (soloAttacker) {
                    privateBiteMessages.push({
                        playerId: soloAttacker.id,
                        text: `ไม่สามารถโจมตี ${p.name} ได้`,
                    });
                }
            } else {
                wolfChatMessages.push({
                    name: "เกม",
                    text: `ไม่สามารถฆ่า ${p.name} ได้`,
                    type: "wolf",
                    isSystem: true,
                });
            }
        }

        // ============================================================
        // แม่มด — ยาพิษ (ปาแล้วตายทันที ไม่มีทางป้องกันได้ ไม่เข้า pipeline killed/protected ปกติ)
        // ประมวลผลก่อนลูปหลัก เพื่อให้ถ้าหมาป่าเลือกฆ่าคนเดียวกันไว้ด้วย ลูปหลักจะข้ามไปเอง (p.alive เป็น false แล้ว)
        // ไม่เปิดเผยว่าใครคือแม่มด และไม่เปิดเผยบทบาทของผู้ตาย — ประกาศแค่ชื่อเฉยๆ
        // ============================================================
        room.players.forEach((p) => {
            if (!p.witchPoisonPending) return;
            p.witchPoisonPending = false;
            if (!p.alive) return; // ตายไปแล้วก่อนหน้านี้ในลูปนี้ (ไม่ควรเกิด แต่กันไว้)

            if (p.role === "หมาป่าดื้อรั้น" && !p.stubbornInjured) {
                // หมาป่าดื้อรั้นมี 2 ชีวิต — นับรวมยาพิษแม่มดด้วย โดนครั้งแรกรอด (บาดเจ็บ) ไม่ตาย
                p.stubbornInjured = true;
                sendPrivateChat(room, p.id, {
            name: "เกม",
                    text: "คุณได้รับบาดเจ็บ หากถูกโจมตีอีกครั้งคุณจะตาย",
                    type: "private",
                    isSystem: true,
                });
                // แจ้งแม่มด "ตัวจริง" ที่ปาไว้เป็นการส่วนตัวว่าโจมตีไม่สำเร็จ (แม่มดมีขวดเดียวตลอดเกม — เสียเปล่าไปแล้วด้วย)
                // ใช้ p.witchPoisonCasterId ที่บันทึกไว้ตอนปายา ไม่ใช่หา role "แม่มด" คนไหนก็ได้ที่ยังไม่ตาย
                // เพราะห้องอาจมีแม่มดมากกว่า 1 คน และคนอื่นที่ไม่ได้ปาไม่ควรได้รับข้อความนี้
                const witchCaster = p.witchPoisonCasterId
                    ? room.players.find((wp) => wp.id === p.witchPoisonCasterId)
                    : null;
                if (witchCaster) {
                    sendPrivateChat(room, witchCaster.id, {
            name: "เกม",
                        text: `ไม่สามารถโจมตี ${p.name} ได้`,
                        type: "private",
                        isSystem: true,
                    });
                }
                // ประกาศต่อทั้งห้อง (แชทรวม) ว่าหมาป่าดื้อรั้นถูกโจมตีและรอดแบบบาดเจ็บ — ไม่ว่าจะถูกโจมตีด้วยวิธีใดก็ตาม (นับรวมยาพิษด้วย)
                // ไม่ระบุชื่อผู้เล่น — บอกแค่ว่ามีหมาป่าดื้อรั้นโดนโจมตีเท่านั้น
                nightMessages.push({
                    name: "เกม",
                    text: `🐺💢 หมาป่าดื้อรั้นถูกโจมตีและได้รับบาดเจ็บ`,
                    type: "global",
                    isSystem: true,
                });
                return;
            }

            p.alive = false;
            allCascadeDeaths.push(...cleanupAfterDeath(room, p, freshCupidPairsThisResolve));
            nightMessages.push({
                name: "เกม",
                text: `🧪 แม่มดได้ปายาใส่ ${p.name}`,
                type: "global",
                isSystem: true,
                isDeath: true,
            });
        });

        room.players.forEach((p) => {
            if (!p.killed) return;
            if (!p.alive) return; // ตายไปแล้วก่อนในลูปเดียวกัน → ข้าม

            if (p.protected) {
                // รอด
                findProtectorsOf(p.id).forEach((protector) => {
                    // แม่มด: ยาป้องกันมีแค่ขวดเดียว เสียก็ต่อเมื่อมีการโจมตีคนที่ปกป้องไว้จริงๆ (ตรงนี้แหละ)
                    if (protector.role === "แม่มด") protector.witchProtectPotions = 0;
                    privateProtectMessages.push({
                        playerId: protector.id,
                        text: protector.role === "บอดี้การ์ด"
                            ? "เมื่อคืนคุณถูกโจมตี การโจมตีอีกครั้งจะทำให้คุณตาย !"
                            : `การป้องกันของคุณได้ช่วย ${p.name} ไว้`,
                    });
                });
                // แก้บั๊ก: เดิมส่งเข้าแชทหมาป่าเสมอไม่ว่าใครเป็นคนโจมตี ทำให้กรณี "ฆาตกรต่อเนื่อง" (ทีม solo
                // ไม่ใช่ทีมหมาป่า) เป็นคนลงมือ แต่หมาป่าทั้งทีมกลับเห็นข้อความ "ไม่สามารถฆ่าได้" ทั้งที่
                // ตัวเองไม่ได้เลือกเป้านี้เลย — เช็ค killerType ก่อนเหมือน branch อันธพาล/หมาป่าดื้อรั้น
                // ด้านล่าง: เป็นหมาป่าจริงๆ เท่านั้นถึงแจ้งเข้าแชทหมา ถ้าเป็นฆาตกรต่อเนื่องให้แจ้งฆาตกรต่อเนื่องตัวที่ลงมือ
                // เป็นการส่วนตัวแทน ไม่เข้าแชทหมา
                notifyFailedAttack(p);
            } else if (findThugGuardOf(p.id)[0]) {
                // มีอันธพาล (ที่ยังไม่ถูกเปิดเผย) เลือกปกป้องคนนี้ไว้เมื่อคืน — ผู้ถูกโจมตีรอด
                // แต่อันธพาลจะถูกเปิดเผยตัวให้ผู้โจมตีเห็นแทน และจะเสียชีวิตทีหลัง (เหมือนกรณี
                // ปกป้องตัวเองทุกประการ ดู branch "อันธพาล" ด้านล่าง) — ไม่บอกฝ่ายที่รอดว่าใคร
                // ปกป้องไว้ และไม่ประกาศต่อสาธารณะ เพื่อรักษาความลับเหมือนกรณีปกป้องตัวเอง
                const thug = findThugGuardOf(p.id)[0];
                thug.musclemanExposed = true;
                thug.musclemanPendingDeath = true;
                const isPersonalAttack = PERSONAL_ATTACKER_KILL_TYPES.has(p.killedBy);

                const attacker = isPersonalAttack
                    ? (p.killedByPlayerId ? room.players.find((mp) => mp.id === p.killedByPlayerId) : null)
                    : pickBiter(room);
                const attackerLabel = attackerLabelFor(p.killedBy);

                if (attacker) {
                    revealRoleMutual(thug, attacker);

                    sendPrivateChat(room, thug.id, {
            name: "เกม",
                        text: `เมื่อคืนคุณเข้าปกป้อง ${p.name} ไว้ และถูกโจมตีโดย ${attacker.name} เขาคือ ${attacker.role}`,
                        type: "private",
                        isSystem: true,
                    });

                    privateBiteMessages.push({
                        playerId: attacker.id,
                        text: `คุณได้โจมตี ${p.name} แต่ ${thug.name} เข้าปกป้องไว้ และเขาได้เห็นบทบาทของคุณแล้ว`,
                    });
                    privateBiteMessages.push({
                        playerId: hostRoomName(roomId),
                        text: `[โฮสต์เท่านั้น] ${thug.name} คืออันธพาล เข้าปกป้อง ${p.name} รอดจากการโจมตีของ${attackerLabel} (${attacker.name})`,
                    });
                    if (!isPersonalAttack) {
                        wolfChatMessages.push({
                            name: "เกม",
                            text: `ไม่สามารถโจมตี ${p.name} ได้`,
                            type: "wolf",
                            isSystem: true,
                        });
                    }
                }
                // หมายเหตุ: ไม่มีการ push เข้า nightMessages/globalChat ใดๆ ในกรณีนี้ เหมือนกรณี
                // อันธพาลปกป้องตัวเอง เพื่อไม่ให้คนอื่นในหมู่บ้านรู้ว่ามีการโจมตีเกิดขึ้นหรือใครรอด
            } else if (p.role === "ผู้ถูกสาป" && (p.killedBy || "wolf") === "wolf") {
                // ผู้ถูกสาปโดนหมาป่ากัด → กลายเป็นหมาป่าอัตโนมัติ ไม่ตาย
                // แจ้งผู้เล่นเองทันที ไม่ต้องรอโฮสต์กดส่งข้อความกลายร่าง
                p.role = "หมาป่า";
                p.displayRole = "หมาป่า (ผู้ถูกสาป)";
                p.transformed = true;

                io.to(p.id).emit("your_role", buildYourRolePayload(p, { silent: true, extended: false }, room));
                sendPrivateChat(room, p.id, {
            name: "เกม",
                    text: "คุณถูกหมาป่ากัดจนกลายเป็นหมาป่าแล้ว! ตอนนี้คุณอยู่ทีมหมาป่า",
                    type: "private",
                    isSystem: true,
                });

                if (room.wolfChatHistory?.length) {
                    io.to(p.id).emit("wolf_chat_history", room.wolfChatHistory);
                }

                // แจ้งฝั่งหมาป่า+โฮสต์ว่ามีสมาชิกใหม่เข้าร่วม (ไม่ประกาศให้หมู่บ้านรู้)
                wolfChatMessages.push({
                    name: "เกม",
                    text: `🧟🐺 ${p.name} (ผู้ถูกสาป) ถูกกัดจนกลายเป็นหมาป่าตัวใหม่แล้ว!`,
                    type: "wolf",
                    isSystem: true,
                });
            } else if (p.role === "บอดี้การ์ด" && !p.bodyguardInjured) {
                // บอดี้การ์ดปกป้องตัวเองอัตโนมัติ ครั้งแรกรอด (บาดเจ็บ) ครั้งถัดไปตายจริง
                p.bodyguardInjured = true;
                sendPrivateChat(room, p.id, {
            name: "เกม",
                    text: "เมื่อคืนคุณถูกโจมตี หากถูกอีกครั้งจะตาย",
                    type: "private",
                    isSystem: true,
                });
                // แก้บั๊กเดียวกับ branch p.protected ด้านบน — เช็ค killerType ก่อนแจ้งแชทหมา
                // ถ้าเป็นฆาตกรต่อเนื่องลงมือ ให้แจ้งฆาตกรต่อเนื่องตัวจริงเป็นการส่วนตัวแทน ไม่เข้าแชทหมา
                notifyFailedAttack(p);
            } else if (p.role === "หมาป่าดื้อรั้น" && !p.stubbornInjured) {
                // หมาป่าดื้อรั้นมี 2 ชีวิต — โดนโจมตี ครั้งแรกรอด (บาดเจ็บ) ครั้งถัดไปตายจริง
                // นับรวมทุกทาง ทั้งถูกฆ่าตอนกลางคืนและถูกโหวตประหารตอนกลางวัน ไม่ใช่แค่การประหารเท่านั้น
                //
                // หมายเหตุ: หมาป่าดื้อรั้นเองก็อยู่ใน WOLF_ROLES ดังนั้น wolfChosenTargets (ด้านบน)
                // กรองทีมหมาป่าออกจากเป้าหมายที่หมาป่าเลือกฆ่าได้อยู่แล้ว → ทีมหมาป่าฆ่ากันเองไม่ได้
                // ผู้โจมตีที่ทำให้ p.killed=true กับ role นี้จึงมีได้สองทาง: "ฆาตกรต่อเนื่อง" (ตัวเดียว
                // ลงมือ แจ้งส่วนตัว) หรือ "โจร" (คืนที่มีทั้งหัวโจร+ผู้สมรู้ร่วมคิด เลือกเป้าอิสระ — ต้อง
                // แจ้งทั้งกลุ่มผ่านแชทโจร ไม่ใช่แค่คนที่เลือกเป้านี้จริงๆ เพราะทั้งคู่รอผลร่วมกัน)
                // ไม่ว่าทางไหนก็ไม่ส่งเข้า wolf chat เพราะไม่ใช่ทีมหมาป่าเป็นคนลงมือ
                p.stubbornInjured = true;
                sendPrivateChat(room, p.id, {
            name: "เกม",
                    text: "คุณได้รับบาดเจ็บ หากถูกโจมตีอีกครั้งคุณจะตาย",
                    type: "private",
                    isSystem: true,
                });
                if (p.killedBy === "bandit") {
                    // โจร: แจ้ง "ทั้งกลุ่ม" (หัวโจร+ผู้สมรู้ร่วมคิด) ผ่านแชทโจรว่าโจมตีไม่สำเร็จ — ใช้
                    // p.killedByPlayerId (ผู้ลงมือจริงที่เลือกเป้านี้) หา banditGroupIdOf เพื่อกันเคสห้อง
                    // เดียวกันมีหัวโจรมากกว่า 1 กลุ่ม เหมือนกับ send_chat (type "bandit")
                    const banditAttacker = p.killedByPlayerId
                        ? room.players.find((bp) => bp.id === p.killedByPlayerId)
                        : null;
                    const banditGroupLeaderId = banditGroupIdOf(banditAttacker);
                    if (banditGroupLeaderId) {
                        const banditFailMsg = {
                            name: "เกม",
                            text: `ไม่สามารถโจมตี ${p.name} ได้`,
                            type: "bandit",
                            isSystem: true,
                        };
                        room.banditChatHistory = room.banditChatHistory || {};
                        room.banditChatHistory[banditGroupLeaderId] = room.banditChatHistory[banditGroupLeaderId] || [];
                        room.banditChatHistory[banditGroupLeaderId].push(banditFailMsg);
                        room.players.forEach((bp) => {
                            if (banditGroupIdOf(bp) === banditGroupLeaderId) {
                                io.to(bp.id).emit("chat_message", banditFailMsg);
                            }
                        });
                        io.to(hostRoomName(roomId)).emit("chat_message", banditFailMsg); // ส่งให้ทุกจอโฮสต์
                    }
                } else {
                    // แจ้งฆาตกรต่อเนื่อง "ตัวจริง" ที่ลงมือ (ใช้ p.killedByPlayerId ที่บันทึกไว้ตอนสรุปผลโหมดเลือกฆ่า)
                    // ไม่ใช่หา role "ฆาตกรต่อเนื่อง" คนไหนก็ได้ที่ยังไม่ตาย เพราะห้องอาจมีฆาตกรต่อเนื่องมากกว่า 1 คน
                    // และคนอื่นที่ไม่ได้ลงมือไม่ควรได้รับข้อความนี้
                    const murdererAttacker = p.killedByPlayerId
                        ? room.players.find((mp) => mp.id === p.killedByPlayerId)
                        : null;
                    if (murdererAttacker) {
                        privateBiteMessages.push({
                            playerId: murdererAttacker.id,
                            text: `ไม่สามารถโจมตี ${p.name} ได้`,
                        });
                        privateBiteMessages.push({
                            playerId: hostRoomName(roomId),
                            text: `[โฮสต์เท่านั้น] ${p.name} (หมาป่าดื้อรั้น) รอดจากการโจมตีของ${attackerLabelFor(p.killedBy)} (${murdererAttacker.name})`,
                        });
                    }
                }
                // ประกาศต่อทั้งห้อง (แชทรวม) ว่าหมาป่าดื้อรั้นถูกโจมตีและรอดแบบบาดเจ็บ
                // ไม่ระบุชื่อผู้เล่น — และช่วยกันปัญหา nightMessages ว่างเปล่า
                // (ถ้าไม่ push อะไรเลย จะขึ้น "คืนนี้ผ่านไปอย่างสงบ" ทั้งที่จริงมีการโจมตีเกิดขึ้น)
                nightMessages.push({
                    name: "เกม",
                    text: `🐺💢 หมาป่าดื้อรั้นถูกโจมตีและได้รับบาดเจ็บ`,
                    type: "global",
                    isSystem: true,
                });
            } else if (p.role === "อันธพาล" && !p.musclemanExposed) {
                // อันธพาลปกป้องตัวเองอัตโนมัติ รอดคืนนี้ แต่เปิดเผยตัวให้ "คนกัด"/ฆาตกรต่อเนื่อง เห็นแบบส่วนตัว
                // และจะเสียชีวิตหลังจบการประชุมนี้ (ก่อนเริ่มคืนถัดไป)
                // การเปิดเผยนี้รู้กันแค่ 3 ฝ่าย — อันธพาล, ผู้โจมตีที่ถูกเลือก, และโฮสต์ (ดูได้ทุกอย่างเสมอ)
                // ไม่เข้า wolf chat ทีม ไม่ให้ทีมหมาป่าคนอื่นเห็น
                // และห้ามประกาศต่อสาธารณะโดยเด็ดขาด — คนอื่นในหมู่บ้านต้องไม่รู้อะไรเลยเกี่ยวกับเรื่องนี้
                p.musclemanExposed = true;
                p.musclemanPendingDeath = true;
                const isPersonalAttack = PERSONAL_ATTACKER_KILL_TYPES.has(p.killedBy);

                // หาตัวผู้โจมตีจริง: ฆาตกรต่อเนื่อง/ผู้ยุยง/ลัทธิ ตัวที่ลงมือจริง (จาก killedByPlayerId)
                // หรือ "คนกัด" ที่ถูกเลือกตามลำดับชั้นหมาป่า
                const attacker = isPersonalAttack
                    ? (p.killedByPlayerId ? room.players.find((mp) => mp.id === p.killedByPlayerId) : null)
                    : pickBiter(room);
                const attackerLabel = attackerLabelFor(p.killedBy);

                if (attacker) {
                    // อันธพาลกับผู้โจมตีเห็นไอคอนอาชีพของกันและกันในกริด (รู้กันแค่ 2 คนนี้)
                    revealRoleMutual(p, attacker);

                    // แจ้งอันธพาล (ส่วนตัวเท่านั้น) ว่าใครโจมตีและบทบาทของผู้โจมตีคือใคร
                    sendPrivateChat(room, p.id, {
            name: "เกม",
                        text: `เมื่อคืนคุณถูกโจมตีโดย ${attacker.name} เขาคือ ${attacker.role}`,
                        type: "private",
                        isSystem: true,
                    });

                    // แจ้งผู้โจมตี (ส่วนตัวเท่านั้น) ว่าเป้าหมายคืออันธพาล และบทบาทของตนถูกเปิดเผยแล้ว
                    privateBiteMessages.push({
                        playerId: attacker.id,
                        text: `คุณได้โจมตี ${p.name} ซึ่งคืออันธพาล และเขาได้เห็นบทบาทของคุณแล้ว`,
                    });
                    // ส่งเข้า "ห้องโฮสต์" (ทุกจอที่ล็อกอินเป็นโฮสต์อยู่จะได้รับพร้อมกัน)
                    // io.to() รับชื่อ room ได้เหมือน socket id เดี่ยว จึงใช้ playerId ช่องเดิมได้เลย
                    privateBiteMessages.push({
                        playerId: hostRoomName(roomId),
                        text: `[โฮสต์เท่านั้น] ${p.name} คืออันธพาล รอดจากการโจมตีของ${attackerLabel} (${attacker.name})`,
                    });
                    // แจ้งหมาป่าทุกตัวในแชทหมาเหมือนกรณีฆ่าไม่สำเร็จอื่นๆ ตามปกติ — ไม่ระบุว่าเป็นอันธพาล
                    // หรือใครเป็นคนกัด (ผู้โจมตีที่ถูกเปิดเผยได้รับรายละเอียดเต็มแยกไปแล้วข้างบน)
                    // แต่ถ้าเป็น "ฆาตกรต่อเนื่อง"/"ผู้ยุยง" ลงมือ (ทีม solo ไม่ใช่ทีมหมาป่า) ห้ามส่งเข้าแชทหมาเด็ดขาด
                    // เพราะไม่ใช่สมาชิกทีมหมาป่า และหมาป่าไม่ควรถูกแจ้งเรื่องที่ตัวเองไม่ได้ทำเลย
                    // (ผู้โจมตีตัวจริงได้รับแจ้งส่วนตัวไปแล้วผ่าน privateBiteMessages ด้านบน)
                    if (!isPersonalAttack) {
                        wolfChatMessages.push({
                            name: "เกม",
                            text: `ไม่สามารถโจมตี ${p.name} ได้`,
                            type: "wolf",
                            isSystem: true,
                        });
                    }
                }
                // หมายเหตุ: ไม่มีการ push เข้า nightMessages/globalChat ใดๆ ในกรณีนี้
                // เพื่อไม่ให้คนอื่นในหมู่บ้านรู้ว่ามีการโจมตีเกิดขึ้นหรือใครรอด
            } else {
                // ตาย
                p.alive = false;
                allCascadeDeaths.push(...cleanupAfterDeath(room, p, freshCupidPairsThisResolve));
                const killerType = p.killedBy || "wolf";
                const killText = killerType === "murderer"
                    ? `ฆาตกรต่อเนื่องได้ฆ่า...${p.name}`
                    : killerType === "cult"
                    ? `🔯 ลัทธิได้สังเวยชีวิตเพื่อฆ่า ${p.name}`
                    : killerType === "bandit"
                    ? `🗡️ กองโจรได้รุมทำร้าย ${p.name}`
                    : `เหล่ามนุษย์หมาป่าได้ฆ่า ${p.name}`;
                nightMessages.push({
                    name: "เกม",
                    text: killText,
                    type: "global",
                    isSystem: true,
                    isDeath: true,
                });
            }
        });

        // ล้าง selectedTargets ของ special roles
        if (room.selectedTargets) {
            Object.keys(room.selectedTargets).forEach((selectorId) => {
                const selector = room.players.find((p) => p.id === selectorId);
                if (!selector) return;
                // อันธพาล: เป้าที่เลือกปกป้องไว้เพิ่ม (นอกจากตัวเอง) ต้องถูกล้างทุกเช้าเหมือนกัน
                // (เลือกใหม่ได้ทุกคืน ไม่ใช่ค้างข้ามคืน) แต่ไม่ต้องแตะ .protected เพราะไม่เคยตั้งไว้
                if (selector.role === "อันธพาล") { delete room.selectedTargets[selectorId]; return; }
                // นักเล่นกล: เป้าที่เลือกไว้เมื่อคืนนี้ (ผ่าน select_target ธรรมดาเหมือนหมอ/บอดี้การ์ด)
                // จะถูก "ปลอมบท" ให้ทันทีตอนสรุปผลเช้านี้ — ต่างจากหมาป่านักเวทตรงที่ผลนี้ "สะสม" ไม่หายไป
                // เมื่อเข้าคืนถัดไป (ไม่ต้องเลือกเป้าเดิมซ้ำทุกวัน) เพื่อรอกดปุ่ม 🔥 ฆ่ารวดเดียวตอนกลางวันทีหลัง
                if (selector.role === "นักเล่นกล") {
                    const disguiseTargetId = room.selectedTargets[selectorId];
                    const disguiseTarget = room.players.find((p) => p.id === disguiseTargetId);
                    if (disguiseTarget && disguiseTarget.alive) {
                        disguiseTarget.illusionDisguised = true;
                        selector.illusionTargetIds = selector.illusionTargetIds || [];
                        if (!selector.illusionTargetIds.includes(disguiseTarget.id)) {
                            selector.illusionTargetIds.push(disguiseTarget.id);
                        }
                        sendPrivateChat(room, selector.id, {
                            name: "เกม",
                            text: `🎭 คุณปลอมบทบาทของ ${disguiseTarget.name} ไว้แล้ว (ผู้หยั่งรู้ที่ส่องเขาจะเห็นเป็นนักเล่นกล)`,
                            type: "private",
                            isSystem: true,
                        });
                    }
                    delete room.selectedTargets[selectorId];
                    return;
                }
                if (!protectRoles.has(selector.role) && !silenceRoles.has(selector.role)) return;

                const targetId = room.selectedTargets[selectorId];
                const target = room.players.find((p) => p.id === targetId);
                if (target && protectRoles.has(selector.role)) target.protected = false;
                // ยายขี้โมโห: ผลของการใบ้ (silenced = true) ถูก "เปิดใช้งานจริง" ตรงนี้เท่านั้น — ตอนสรุปผล
                // กลางคืน/เข้าสู่เช้า ไม่ใช่ตอนเลือกเป้าตอนกลางคืนอีกต่อไป (ดูคอมเมนต์ที่ select_target
                // ประกอบ) เพื่อไม่ให้เป้าหมายเห็นข้อความ "ถูกใบ้" ทันทีตั้งแต่ตอนกลางคืนก่อนผลจะเกิดขึ้นจริง
                if (target && target.alive && silenceRoles.has(selector.role)) target.silenced = true;
                // silenced: ไม่ล้างตรงนี้ — จะล้างตอน start_night
                delete room.selectedTargets[selectorId];
            });
        }

        // ล้าง killed/protected ทุกคน (silenced คงไว้จนกว่าจะกด start_night)
        room.players.forEach((p) => {
            p.killed = false;
            p.killedBy = null;
            p.killedByPlayerId = null;
            p.protected = false;
        });
        room.murdererKillVote = null;

        room.dayCount = (room.dayCount || 0) + 1;
        room.isNight = false;

        // พอเข้าสู่เช้าแล้ว ให้เคลียร์ "รูปไอคอนบทที่ส่องเจอ" ของฝั่งส่องกลางคืน (หมาป่าหยั่งรู้/ผู้หยั่งรู้/
        // ผู้มีลาง) บนการ์ดผู้เล่นทิ้ง เหลือไว้แค่ข้อความในแชทที่ส่งไปแล้วเท่านั้น — ผลส่องมีอายุแค่คืนนั้น
        // คืนถัดไปเจ้าของสิทธิ์ต้องส่องใหม่เอง (ส่วนของศาลเตี้ยดูบทตอนกลางวัน จะไปเคลียร์ตอนเริ่มคืนถัดไป
        // แทน เพราะผลของศาลเตี้ยควรอยู่ตลอดกลางวันนั้น ไม่ใช่หายทันทีตอนเช้า — ดู beginNight)
        room.players.forEach((p) => {
            p.wolfSeerRevealed = false;
            p.wolfSeerRevealedRole = null;
            p.trueSeerRevealedTo = [];
            p.trueSeerRevealedRoleBy = {};
            p.auraRevealedTo = {};
            p.detectiveRevealedTo = {};
        });

        // เริ่มวันใหม่ → รีเซ็ตสิทธิ์ "1 ความสามารถต่อวัน" ของศาลเตี้ย (ยิง/ดูบท ใช้ได้ใหม่อีกครั้ง ถ้ายังมีของเหลือ)
        room.players.forEach((p) => { p.sheriffUsedToday = false; });

        // หมาป่านักเวท: คำสาปมีผลแค่ 1 วัน (เลือกเป้าตอนกลางวัน มีผลต่อเนื่องจนถึงคืนนั้น)
        // พอเข้าสู่เช้าวันใหม่ คำสาปเดิมจะหายไปทันที ไม่มีการต่อเป้าเดิมให้อัตโนมัติ
        // ถ้าหมาป่านักเวทอยากร่ายเป้าเดิมต่อ ต้องกดเลือกเป้านั้นเองใหม่ทุกวัน
        room.curseTargets = {};
        room.players.forEach((p) => { p.wizardCursed = false; });

        room.globalChatHistory = room.globalChatHistory || [];

        // ข้อความ "เริ่มการประชุมวันที่ X" กับ "คืนนี้ผ่านไปอย่างสงบ" (กรณีไม่มีใครตาย) ให้รวมเป็น
        // ข้อความเดียวกัน ไม่ต้องแยกส่งสองข้อความติดกัน — ถ้าคืนนั้นมีเหตุการณ์เกิดขึ้นจริง (nightMessages
        // ไม่ว่างเปล่า) จะยังคงส่งข้อความ "เริ่มการประชุม" แยกก่อน แล้วตามด้วยรายละเอียดเหตุการณ์ตามปกติ
        const dayAnnounceMsg = {
            name: "เกม",
            text: nightMessages.length === 0
                ? `☀️ เริ่มการประชุมวันที่ ${room.dayCount} คืนนี้ผ่านไปอย่างสงบ ไม่มีใครเสียชีวิต`
                : `☀️ เริ่มการประชุมวันที่ ${room.dayCount}`,
            type: "global",
            isSystem: true,
        };
        pushGlobalChat(room, dayAnnounceMsg);
        io.to(roomId).emit("chat_message", dayAnnounceMsg);

        // ประกาศคนที่ถูกใบ้
        room.players
            .filter((p) => !p.isHost && p.silenced)
            .forEach((p) => {
                const msg = {
                    name: "เกม",
                    text: `🤐 ${p.name} ถูกใบ้ ทำให้เขาไม่สามารถพูดได้ในการประชุมนี้`,
                    type: "global",
                    isSystem: true,
                };
                pushGlobalChat(room, msg);
                io.to(roomId).emit("chat_message", msg);
            });

        // ผลกลางคืน — กรณีไม่มีเหตุการณ์เลย ข้อความ "คืนนี้ผ่านไปอย่างสงบ" ถูกรวมเข้ากับ
        // dayAnnounceMsg ด้านบนไปแล้ว จึงไม่ต้องส่งซ้ำอีกรอบตรงนี้
        nightMessages.forEach((msg) => {
            pushGlobalChat(room, msg);
            io.to(roomId).emit("chat_message", msg);
        });

        // แจ้งหมาป่าว่าฆ่าไม่สำเร็จ
        if (wolfChatMessages.length > 0) {
            room.wolfChatHistory = room.wolfChatHistory || [];
            wolfChatMessages.forEach((msg) => {
                room.wolfChatHistory.push(msg);
                room.players.forEach((p) => {
                    if (WOLF_ROLES.has(p.role)) {
                        io.to(p.id).emit("chat_message", msg);
                    }
                });
                io.to(hostRoomName(roomId)).emit("chat_message", msg); // ส่งให้ทุกจอโฮสต์
            });
        }

        // แจ้งผู้ปกป้องส่วนตัว
        privateProtectMessages.forEach(({ playerId, text }) => {
            sendPrivateChat(room, playerId, {
            name: "เกม",
                text,
                type: "private",
                isSystem: true,
            });
        });

        // แจ้ง "คนกัด" ที่ถูกอันธพาลเปิดเผยตัว — ส่งตรงถึงคนเดียว + โฮสต์เท่านั้น ไม่เข้า wolf chat/history
        // ทีม ไม่ให้หมาป่าตัวอื่นเห็น (รู้กันแค่อันธพาล, คนกัด, และโฮสต์)
        privateBiteMessages.forEach(({ playerId, text }) => {
            sendPrivateChat(room, playerId, {
            name: "เกม",
                text,
                type: "private",
                isSystem: true,
            });
        });

        announceCascadeDeaths(room, roomId, allCascadeDeaths);
        checkGameEndGeneral(room, roomId);

        broadcastRoomUpdate(roomId, room);

    });

    // ----------------------------------------------------------------
    // START NIGHT
    // ----------------------------------------------------------------
    socket.on("start_night", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;

        // กันเคสโฮสต์กดข้ามเข้าคืนเองระหว่างที่โหมดโหวตยังค้างอยู่ (ปกติจะถูกปิด+เข้าคืนอัตโนมัติไปแล้ว)
        if (room.voteMode) {
            clearVoteTimer(roomId);
            room.voteMode = false;
            room.voteDeadline = null;
        }

        beginNight(room, roomId);

        // บอทไม่มีการตัดสินใจอัตโนมัติ — Host เป็นผู้ควบคุมผ่านแท็บทดสอบเท่านั้น
    });

    // ----------------------------------------------------------------
    // SELECT TARGET (ความสามารถกลางคืน: หมอ/บอดี้การ์ด/ยายขี้โมโห/ลูกหมาป่า/แม่มด(ยาป้องกัน))
    // ----------------------------------------------------------------
    // เฟส 1: แยกเป็น performSelectTarget(room, roomId, playerId, targetId) — ใช้ร่วมกันหลายบท
    function performSelectTarget(room, roomId, playerId, targetId) {
        room.selectedTargets = room.selectedTargets || {};

        const protectRoles = new Set(["หมอ", "บอดี้การ์ด", "แม่มด"]);
        const silenceRoles = new Set(["ยายขี้โมโห"]);
        const selector = room.players.find((p) => p.id === playerId);
        if (!selector) return;
        if (!selector.alive) return;

        // ลูกหมาป่า: ต่างจากความสามารถกลางคืนอื่นๆ ในกลุ่มนี้ — "จองเป้าที่จะลากตายด้วย" ได้
        // ตลอดเวลา ทั้งกลางวันและกลางคืน (กดปุ่ม 🐾 เข้าโหมดแล้วแตะเลือกได้ทันที) เพราะเป็นการ
        // เลือกไว้ล่วงหน้าเฉยๆ ไม่ใช่การกระทำที่ต้องปิดบังจนกว่าจะถึงเช้าเหมือนหมอ/บอดี้การ์ด/
        // ยายขี้โมโห/แม่มด — ผลจริง (ลากตายตาม) จะเกิดก็ต่อเมื่อลูกหมาป่าตัวนี้ตายเท่านั้น
        // (ดู cleanupAfterDeath) ไม่เกี่ยวกับช่วงเวลาที่เลือกไว้เลย
        const isWolfCub = selector.role === "ลูกหมาป่า";
        // เด็กขี้โวยวาย: เลือกเป้าได้ตลอดเวลาเหมือนลูกหมาป่า (ทั้งกลางวัน/กลางคืน) แต่ห้ามใช้สกิลใน "คืนแรก" ของเกมเท่านั้น
        // (ตามคำขอผู้ใช้) — บั๊กเดิม: เช็คแค่ room.nightCount <= 1 เฉยๆ โดยไม่ดูว่าเป็นกลางวันหรือกลางคืน
        // ทำให้ nightCount ที่ยังค้างอยู่ที่ 1 ตลอดทั้ง "วันแรก" (หลังคืนแรกจบ ก่อนคืนที่สองเริ่ม) ไปบล็อกวันแรกด้วย
        // ทั้งที่ควรใช้ได้แล้วตั้งแต่เช้าวันแรก จึงต้องเช็ค room.isNight ควบคู่ไปด้วย — บล็อกเฉพาะตอนกำลังอยู่ในคืนแรกจริงๆ เท่านั้น
        const isLoudmouth = selector.role === "เด็กขี้โวยวาย";
        if (!isWolfCub && !isLoudmouth && !room.isNight) return; // บทบาทอื่นๆ ยังคงเป็นความสามารถกลางคืน ใช้ได้เฉพาะตอนกลางคืนเท่านั้น
        if (isLoudmouth && targetId && room.isNight && (room.nightCount || 0) <= 1) return; // ห้ามเลือกเป้าตอนกำลังอยู่ในคืนแรกของเกม (ตามคำขอผู้ใช้)
        // ยายขี้โมโห: แก้บั๊ก — คำอธิบายบทบาทระบุไว้ชัดว่าใช้ได้ "หลังจากคืนแรก" เท่านั้น แต่เดิมไม่มีจุดไหน
        // บังคับใช้ข้อจำกัดนี้เลยสักที่ (ทั้งฝั่งเซิร์ฟเวอร์และ UI) ทำให้ใบ้คนอื่นได้ตั้งแต่คืนแรกทั้งที่ไม่ควร
        // เช็คแบบเดียวกับผู้ยุยง/แม่มดข้างบน — บล็อกเฉพาะตอนกำลังอยู่ในคืนแรกจริงๆ (isNight ถูก guard ไว้แล้วด้านบนอยู่แล้วสำหรับบทนี้ แต่ใส่ไว้ให้ชัดเจน)
        if (silenceRoles.has(selector.role) && targetId && room.isNight && (room.nightCount || 0) <= 1) return;

        // แม่มด: ยาป้องกันมีแค่ขวดเดียว ถ้าใช้ไปแล้ว (เสียเพราะเคยกันการโจมตีสำเร็จ) เลือกเป้าใหม่ไม่ได้อีก
        if (selector.role === "แม่มด" && targetId && !(selector.witchProtectPotions > 0)) return;
        // แม่มด: ยาป้องกันใช้ได้ตั้งแต่คืนแรกเลย (ตามคำขอผู้ใช้ — ต่างจากยาพิษที่ยังห้ามใช้คืนแรกอยู่
        // ดู performWitchPoison ด้านล่าง) เดิมบล็อกยาป้องกันไว้ในคืนแรกด้วยเหมือนยาพิษ ตอนนี้เอาออกแล้ว

        const isProtector = protectRoles.has(selector.role);

        if (!targetId) {
            // ยกเลิกการเลือก
            const prevTargetId = room.selectedTargets[playerId];
            if (prevTargetId) {
                const prevTarget = room.players.find((p) => p.id === prevTargetId);
                if (prevTarget) {
                    if (isProtector) prevTarget.protected = false;
                    // ยายขี้โมโห: ไม่มี .silenced ให้ล้างตรงนี้แล้ว เพราะตอนเลือกไม่ได้ตั้งค่าไว้ทันที
                    // อีกต่อไป (ดูคอมเมนต์ที่ตั้งค่า targetPlayer ด้านล่าง) — การยกเลิก/เปลี่ยนเป้า
                    // ระหว่างคืนจึงแค่แก้ room.selectedTargets เฉยๆ ไม่ต้องแตะ flag ใดๆ ของผู้เล่น
                }
            }
            delete room.selectedTargets[playerId];
        } else {
            if (targetId === playerId) return;
            // แก้บั๊กเดียวกับ scout_target/detective_scout: เดิมไม่เช็ค isHost ทำให้หมอ/บอดี้การ์ด/
            // แม่มด(ยาป้องกัน)/ลูกหมาป่า/ยายขี้โมโห/เด็กขี้โวยวาย เลือกโฮสต์เป็นเป้าได้ (เช่นป้องกัน/ใบ้/
            // จองลากตายโฮสต์ ทั้งที่โฮสต์ไม่ใช่ผู้เล่นในเกมจริง)
            const targetPlayer = findTargetablePlayer(room, targetId);
            if (!targetPlayer) return;

            // ลูกหมาป่าห้ามเลือกหมาป่าด้วยกัน
            if (selector.role === "ลูกหมาป่า" && WOLF_ROLES.has(targetPlayer.role)) return;

            // ถอด flag จาก target เดิมก่อนเปลี่ยน
            const prevTargetId = room.selectedTargets[playerId];
            if (prevTargetId && prevTargetId !== targetId) {
                const prevTarget = room.players.find((p) => p.id === prevTargetId);
                if (prevTarget) {
                    if (isProtector) prevTarget.protected = false;
                }
            }

            if (isProtector) targetPlayer.protected = true;
            // ยายขี้โมโห: แก้บั๊ก — เดิมตั้ง targetPlayer.silenced = true ทันทีตอนเลือกเป้าตอนกลางคืน
            // ทำให้หน้าจอของเป้าหมายขึ้นข้อความ "🤐 ถูกใบ้" ทันทีระหว่างคืน (ก่อนที่ผลจะเกิดขึ้นจริง
            // ตอนเช้า) เผยว่าตัวเองถูกเลือกทั้งที่ยังไม่ควรรู้ — ตอนนี้แค่ "เลือก" เป้าไว้เฉยๆ
            // (เก็บใน room.selectedTargets เหมือนเดิม ใช้ตัดสินใจตอนสรุปผลกลางคืน) ไม่ตั้ง
            // .silenced ที่นี่อีกต่อไป ผลจริง (silenced = true + แจ้งในแชท) จะถูกนำไปใช้ตอน
            // resolve_night (เช้า) เท่านั้น ดู isSilencer ประกอบใน resolve_night
            room.selectedTargets[playerId] = targetId;
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("select_target", ({ roomId, targetId, stateVersion } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { member: true, alive: true, started: true, stateVersion });
        if (!validation.ok) return cb(validation);
        const before = room.stateVersion;
        performSelectTarget(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
        return cb(room.stateVersion !== before ? { ok: true, stateVersion: room.stateVersion } : roomActionError("ACTION_REJECTED", { stateVersion: room.stateVersion }));
    });

    // ----------------------------------------------------------------
    // CAST WITCH POISON (แม่มด — ยาพิษ มีขวดเดียวตลอดเกม ใช้แล้วตายทันที
    // ไม่มีทางป้องกันได้ (ไม่ผ่าน pipeline killed/protected ปกติ) และย้อนกลับไม่ได้
    // ผลจริง (การตาย + ประกาศ) จะถูกดีเลย์ไปจนกว่าโฮสต์จะกด "สรุปผลกลางคืน" (resolve_night)
    // เหมือนกับผลของหมาป่ากัด เพื่อไม่ให้หลุดข้อมูลก่อนเช้า — ที่นี่แค่ mark ไว้ว่า "จะตาย"
    // ไม่เปิดเผยว่าใครคือแม่มด หรือบทบาทของผู้ตายแต่อย่างใด
    // ห้ามใช้ยาพิษในคืนแรกของเกม (ตามคำขอผู้ใช้) — ยาป้องกันไม่ติดข้อจำกัดนี้แล้ว ใช้ได้ตั้งแต่คืนแรก
    // (ดู performSelectTarget ด้านบน)
    // ----------------------------------------------------------------
    // เฟส 1: แยกเป็น performWitchPoison(room, roomId, playerId, targetId)
    function performWitchPoison(room, roomId, playerId, targetId) {
        if (!room.isNight) return; // ใช้ได้เฉพาะตอนกลางคืนเท่านั้น

        const witch = room.players.find((p) => p.id === playerId);
        if (!witch || witch.isHost) return;
        if (!witch.alive) return;
        if (witch.role !== "แม่มด") return;
        if (!(witch.witchPoisonPotions > 0)) return;
        if ((room.nightCount || 0) <= 1) return; // ห้ามใช้ยาพิษในคืนแรกของเกม (ตามคำขอผู้ใช้)

        if (!targetId || targetId === playerId) return;
        const target = room.players.find((p) => p.id === targetId);
        if (!target || target.isHost || !target.alive) return;
        if (target.witchPoisonPending) return; // เลือกไปแล้ว กดซ้ำไม่ได้ (มีขวดเดียว)

        witch.witchPoisonPotions = 0;
        target.witchPoisonPending = true;
        target.witchPoisonCasterId = witch.id; // เก็บ id แม่มดตัวจริงที่ปาไว้ — กันเคสห้องเดียวมีแม่มดได้มากกว่า 1 คน

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("cast_witch_poison", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performWitchPoison(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
    });

    // ----------------------------------------------------------------
    // SCOUT TARGET (ความสามารถ "ส่อง" กลางคืน: หมาป่าหยั่งรู้ / ผู้มีลาง / ผู้หยั่งรู้)
    // ต่างจาก select_target ตรงที่เปิดเผยผลทันทีที่เลือก (ย้อนกลับไม่ได้) ไม่ต้องรอโฮสต์ปิดโหมด/สรุปผล
    // ส่องได้คนละ 1 ครั้งต่อคืน (เช็คจาก p.scoutedThisNight ที่ถูกรีเซ็ตทุกครั้งที่เริ่มคืนใหม่ใน beginNight)
    //   - หมาป่าหยั่งรู้: เลือกได้เฉพาะคนที่ไม่ใช่หมาป่า → เปิดเผยบทบาทจริงให้ "ทั้งทีมหมาป่า" เห็น
    //     (ไอคอนอาชีพใหญ่กลางการ์ดในกริดของหมาป่าทุกตัว + ข้อความในแชททีมหมาป่า)
    //   - ผู้หยั่งรู้: เลือกใครก็ได้ (ไม่รวมหมาป่าป้องกันไว้ก็ได้ — เห็นบทบาทจริงเหมือนกัน) → เปิดเผยบทบาทจริง
    //     ให้เห็นเฉพาะตัวเอง (self-only)
    //   - ผู้มีลาง: เลือกใครก็ได้ → เห็นแค่ผล "ลาง" (ดี/ร้าย/ไม่ทราบ) ตามตารางที่กำหนดไว้ต่อบทบาท
    //     เฉพาะตัวเอง (self-only) ไม่เห็นบทบาทจริง
    // ----------------------------------------------------------------
    // เฟส 1: แยกเป็น performScoutTarget(room, roomId, playerId, targetId)
    function performScoutTarget(room, roomId, playerId, targetId) {
        if (!room.isNight) return; // ส่องได้เฉพาะตอนกลางคืนเท่านั้น

        const SCOUT_ROLES = new Set(["หมาป่าหยั่งรู้", "ผู้มีลาง", "ผู้หยั่งรู้"]);
        const selector = room.players.find((p) => p.id === playerId);
        if (!selector || !selector.alive || selector.isHost) return;
        if (!SCOUT_ROLES.has(selector.role)) return;
        if (selector.scoutedThisNight) return; // ใช้สิทธิ์ของคืนนี้ไปแล้ว

        if (!targetId || targetId === playerId) return;
        // แก้บั๊ก: เดิมจุดนี้ไม่เช็ค isHost เลย (ต่างจาก handler เลือกเป้าอื่นๆ ในไฟล์นี้แทบทุกจุด)
        // ทำให้หมาป่าหยั่งรู้/ผู้มีลาง/ผู้หยั่งรู้เลือก "โฮสต์" เป็นเป้าส่องได้ ทั้งที่โฮสต์ไม่ใช่ผู้เล่นในเกมจริง
        const target = findTargetablePlayer(room, targetId);
        if (!target) return;

        if (selector.role === "หมาป่าหยั่งรู้" && WOLF_ROLES.has(target.role)) return; // ส่องหมาป่าด้วยกันเองไม่ได้

        selector.scoutedThisNight = true;
        selector.lastScoutTargetName = target.name;
        selector.lastScoutTargetId = target.id; // เฟส 5: เก็บ id ไว้ให้บอทหาตัว target ได้ตรงๆ ตอนพิจารณาเผยข้อมูลในแชทวันถัดไป

        // หมาป่านักเวทร่ายเวทไว้ (target.wizardCursed) → ทุกอาชีพที่ "ส่อง" บทบาทจริงจะเห็น
        // เป็น "หมาป่า" ธรรมดาแทนบทจริง (ไม่เปิดเผยบทจริงออกไปเลย)
        // นักเล่นกลปลอมบทไว้ (target.illusionDisguised) → เห็นเป็น "นักเล่นกล" แทนบทจริงเช่นกัน
        // เช็คก่อน wizardCursed เพราะเป็นการปลอมบทที่ตั้งใจบังบทบาทจริงไว้เหมือนกัน (ไม่ควรเกิดพร้อมกัน
        // ในทางปฏิบัติ แต่ให้ความสำคัญกับนักเล่นกลก่อนถ้าบังเอิญซ้อนกัน)
        const scoutDisplayRole = target.illusionDisguised ? "นักเล่นกล" : target.wizardCursed ? "หมาป่า" : target.role;

        if (selector.role === "หมาป่าหยั่งรู้") {
            // เปิดเผยบทบาทจริงให้ทั้งทีมหมาป่าเห็น (กริด + แชททีมหมาป่า)
            target.wolfSeerRevealed = true;
            // เก็บ "บทที่เห็นตอนส่อง" แบบ snapshot ไว้ต่างหาก ไม่ให้ไอคอนบนการ์ดอ้างอิง target.role
            // สดๆ ตรงๆ อีกต่อไป — กันปัญหาบทเป้าหมายเปลี่ยนภายหลัง (เช่น ผู้ถูกสาปโดนกัดกลายเป็น
            // หมาป่าอัตโนมัติตอน resolve_night) แล้วผลส่องเก่าเปลี่ยนตามหน้าจอไปด้วยทั้งที่ไม่ควร
            target.wolfSeerRevealedRole = scoutDisplayRole;

            const msg = {
                name: "เกม",
                text: `🔮 ${target.name}... ${scoutDisplayRole}`,
                type: "wolf",
                isSystem: true,
            };
            room.wolfChatHistory = room.wolfChatHistory || [];
            room.wolfChatHistory.push(msg);
            room.players.forEach((p) => {
                if (WOLF_ROLES.has(p.role)) io.to(p.id).emit("chat_message", msg);
            });
            io.to(hostRoomName(roomId)).emit("chat_message", msg); // ส่งให้ทุกจอโฮสต์
        } else if (selector.role === "ผู้หยั่งรู้") {
            // เปิดเผยบทบาทจริงให้เห็นเฉพาะตัวเอง
            target.trueSeerRevealedTo = target.trueSeerRevealedTo || [];
            if (!target.trueSeerRevealedTo.includes(selector.id)) target.trueSeerRevealedTo.push(selector.id);
            // snapshot บทที่เห็น ณ ตอนส่อง แยกเก็บต่อ "ผู้ส่อง" คนนั้นๆ (คนละคนอาจส่องคนละช่วงเวลา
            // ผลที่เห็นไปแล้วไม่ควรเปลี่ยนตามบทจริงที่อัปเดตทีหลัง)
            target.trueSeerRevealedRoleBy = target.trueSeerRevealedRoleBy || {};
            target.trueSeerRevealedRoleBy[selector.id] = scoutDisplayRole;

            sendPrivateChat(room, selector.id, {
            name: "เกม",
                text: `🔮✨ ${target.name}... ${scoutDisplayRole}`,
                type: "private",
                isSystem: true,
            });
        } else if (selector.role === "ผู้มีลาง") {
            // เห็นแค่ผลลาง (ดี/ร้าย/ไม่ทราบ) เฉพาะตัวเอง — คนที่ถูกร่ายเวทจะเห็นเป็น "ร้าย" เสมอ
            // คนที่ถูกนักเล่นกลปลอมบทไว้จะเห็นเป็น "ไม่ทราบ" เสมอ (ลางของนักเล่นกลเองคือ "ไม่ทราบ")
            const aura = target.illusionDisguised ? "ไม่ทราบ" : target.wizardCursed ? "ร้าย" : getAuraResult(target);
            target.auraRevealedTo = target.auraRevealedTo || {};
            target.auraRevealedTo[selector.id] = aura;

            const auraText = aura === "ดี" ? "คนนี้เป็นฝ่ายดี" : aura === "ร้าย" ? "คนนี้เป็นฝ่ายร้าย" : "ไม่ทราบฝ่าย";
            sendPrivateChat(room, selector.id, {
            name: "เกม",
                text: `🔮 ${target.name}: ${auraText}`,
                type: "private",
                isSystem: true,
            });
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("scout_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performScoutTarget(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
    });

    // ----------------------------------------------------------------
    // DETECTIVE SCOUT (ความสามารถ "นักสืบ": เลือก 2 คนพร้อมกันต่อคืน เพื่อดูว่าอยู่ทีมเดียวกันหรือไม่)
    // ต่างจาก scout_target (ส่องบทเดี่ยว) ตรงที่ต้องระบุเป้าหมาย 2 คนมาพร้อมกันในการกระทำเดียว
    // (ฝั่ง client ให้ผู้เล่นแตะเลือกทีละคน พอครบ 2 คนแล้วค่อยยิง event นี้ครั้งเดียว)
    // ผลลัพธ์เป็นสัญลักษณ์ = (ทีมเดียวกัน) หรือ ≠ (คนละทีม) แสดงใหญ่ๆ ที่การ์ดทั้งสองคน เห็นเฉพาะนักสืบเอง
    // (เหมือน player-scout-reveal/player-scout-aura ของฝั่งส่องบทอื่นๆ) ส่องได้คนละ 1 ครั้งต่อคืน
    // เช็คจาก p.detectiveScoutedThisNight (รีเซ็ตทุกครั้งที่เริ่มคืนใหม่ใน beginNight)
    //
    // กติกาพิเศษ: บทบาทฝั่งโซโล (คนบ้า/นักล่าหัว/ฆาตกรต่อเนื่อง) ถือเป็น "ทีมเดี่ยวของตัวเอง" เสมอ ไม่มีทาง
    // อยู่ทีมเดียวกับใครได้เลย แม้จะเทียบกับโซโลอีกตัวที่ teamOf(...) คืนค่า "solo" เหมือนกันก็ตาม
    // จึงต้องเช็คแยกพิเศษ ไม่ใช่แค่เทียบ teamOf(a) === teamOf(b) เฉยๆ (ไม่งั้นโซโล 2 ตัวจะโดนนับว่า
    // "ทีมเดียวกัน" อย่างผิดๆ ทั้งที่แต่ละตัวเล่นเดี่ยว ไม่ได้เป็นพันธมิตรกัน)
    // ----------------------------------------------------------------
    function performDetectiveScout(room, roomId, playerId, targetAId, targetBId) {
        if (!room.isNight) return; // ส่องได้เฉพาะตอนกลางคืนเท่านั้น

        const selector = room.players.find((p) => p.id === playerId);
        if (!selector || !selector.alive || selector.isHost) return;
        if (selector.role !== "นักสืบ") return;
        if (selector.detectiveScoutedThisNight) return; // ใช้สิทธิ์ของคืนนี้ไปแล้ว

        if (!targetAId || !targetBId || targetAId === targetBId) return;
        if (targetAId === playerId || targetBId === playerId) return; // ส่องตัวเองไม่ได้

        // แก้บั๊กเดียวกับ performScoutTarget: เดิมไม่เช็ค isHost ทำให้นักสืบเลือกโฮสต์เป็นหนึ่งใน
        // สองเป้าหมายได้ (โฮสต์ไม่มีบทบาทจริง teamOf(null) จะให้ผลเปรียบเทียบทีมผิดเพี้ยนไปด้วย)
        const targetA = findTargetablePlayer(room, targetAId);
        const targetB = findTargetablePlayer(room, targetBId);
        if (!targetA || !targetB) return;

        // คู่ที่ผู้ยุยงจับไว้ (รวมถึงตัวผู้ยุยงเอง) ถือเป็น "ทีมเดียวกัน" เสมอเวลาถูกส่องคู่กันเอง
        // แม้บทจริงของแต่ละคนจะอยู่คนละทีมก็ตาม เช็คจาก p.instigatorGroupId (ตั้งค่าตอนสรุปผลคู่
        // ผู้ยุยงตอนเช้าใน resolve_night) — ถ้าไม่ได้อยู่กลุ่มเดียวกัน ใช้การเทียบทีมจริงตามปกติ
        // (ส่องคู่ที่คนละทีมจริง ก็ยังคือคนละทีมตามปกติ)
        const groupA = targetA.instigatorGroupId;
        const groupB = targetB.instigatorGroupId;
        // ทีมลัทธิ (ผู้นำลัทธิ + สมาชิกที่ถูกชักชวน): ถือเป็น "ทีมเดียวกัน" ก็ต่อเมื่อเป็นลัทธิเดียวกัน
        // จริงๆ เท่านั้น (กันเคสห้องมีผู้นำลัทธิมากกว่า 1 คน ไม่ให้ปนกันเป็นทีมเดียวกันทั้งหมด)
        const cultGroupA = cultGroupIdOf(targetA);
        const cultGroupB = cultGroupIdOf(targetB);
        let sameTeam;
        if (groupA && groupB && groupA === groupB) {
            sameTeam = true;
        } else if (cultGroupA && cultGroupB && cultGroupA === cultGroupB) {
            sameTeam = true;
        } else if (groupA || groupB) {
            // แก้บั๊ก: คนที่ถูกยุยงแล้ว (มี instigatorGroupId ติดตัว ไม่ว่าจะถูกยุยงตั้งแต่คืนแรกหรือ
            // คืนไหนก็ตาม) ต้องไม่ถูกนับว่ายังอยู่ \"ทีมเดิม\" ของบทบาทจริงอีกต่อไปเด็ดขาด — กลายเป็น
            // ทีมยุยงทันทีที่ถูกจับคู่สำเร็จ เดิมโค้ดตกไปเทียบ teamOf(role) ที่ else ด้านล่าง ทำให้ส่อง
            // คู่ \"คนที่ถูกยุยง\" กับ \"ชาวบ้านทีมเดิมจริงๆ\" (หรือหมาป่า) ที่บังเอิญมีทีมเดิมตรงกัน
            // กลับขึ้นผลว่า \"อยู่ทีมเดียวกัน (=)\" ทั้งที่ไม่ใช่แล้ว — ถ้าฝ่ายใดฝ่ายหนึ่งอยู่กลุ่มยุยง
            // (ไม่ว่าจะกลุ่มเดียวกันหรือคนละกลุ่ม) แต่ไม่ตรงเงื่อนไข groupA===groupB ด้านบน ถือว่า
            // คนละทีมกันเสมอ ไม่ต้องเทียบทีมเดิมอีก
            sameTeam = false;
        } else if (cultGroupA || cultGroupB) {
            // แก้บั๊กเดียวกับผู้ยุยงด้านบนเป๊ะๆ แต่สำหรับลัทธิ: คนที่เข้าลัทธิแล้ว (หัวหน้าหรือสมาชิกที่
            // ถูกชักชวน มี cultGroupIdOf ติดตัว) role เดิมไม่เปลี่ยน (แค่ effectiveTeam เปลี่ยน) เดิมโค้ด
            // ตกไปเทียบ teamOf(role) ที่ else ด้านล่างซึ่งใช้บทเดิมก่อนเข้าลัทธิ ทำให้ส่องคู่ \"สมาชิกลัทธิ\"
            // กับ \"ชาวบ้านทีมเดิมจริงๆ\" ที่บังเอิญมีทีมเดิมตรงกัน ขึ้นผลผิดว่า \"อยู่ทีมเดียวกัน (=)\"
            // ทั้งที่ไม่ใช่แล้ว — ถ้าฝ่ายใดฝ่ายหนึ่งอยู่ในลัทธิ (ไม่ว่าจะลัทธิเดียวกันหรือคนละลัทธิ) แต่ไม่ตรง
            // เงื่อนไข cultGroupA===cultGroupB ด้านบน ถือว่าคนละทีมกันเสมอ (คนนอกลัทธิ/คนละลัทธิ ก็คือ ≠ ทั้งคู่)
            sameTeam = false;
        } else {
            // นักเล่นกลปลอมบทไว้ (illusionDisguised) → ถือว่ากลายเป็นบท "นักเล่นกล" (ทีมเดี่ยว) ไปเลย
            // สำหรับการเทียบทีมของนักสืบด้วย ไม่ใช่แค่ตอนส่องบทเดี่ยว (performScoutTarget) — เพราะคือ
            // "การปลอมแปลงบท" จริงๆ ไม่ใช่แค่หน้ากากที่ผู้หยั่งรู้เห็นเฉยๆ ดังนั้นทีมที่นักสืบเทียบได้ต้อง
            // เปลี่ยนไปเป็นทีมเดี่ยวตามบทปลอมด้วย (โซโลไม่มีทางอยู่ทีมเดียวกับใครเลย ดูคอมเมนต์ด้านล่าง)
            const teamA = targetA.illusionDisguised ? "solo" : teamOf(targetA.role);
            const teamB = targetB.illusionDisguised ? "solo" : teamOf(targetB.role);
            // โซโลไม่มีทางอยู่ทีมเดียวกับใครเลย (รวมถึงโซโลด้วยกันเอง) — ทุกคนคือทีมเดี่ยวของตัวเอง
            sameTeam = !!teamA && !!teamB && teamA === teamB && teamA !== "solo";
        }

        selector.detectiveScoutedThisNight = true;
        selector.lastDetectiveScoutText = `${targetA.name} × ${targetB.name}`;

        targetA.detectiveRevealedTo = targetA.detectiveRevealedTo || {};
        targetA.detectiveRevealedTo[selector.id] = { withId: targetB.id, withName: targetB.name, same: sameTeam };
        targetB.detectiveRevealedTo = targetB.detectiveRevealedTo || {};
        targetB.detectiveRevealedTo[selector.id] = { withId: targetA.id, withName: targetA.name, same: sameTeam };

        const resultText = sameTeam ? "อยู่ทีมเดียวกัน (=)" : "อยู่คนละทีมกัน (≠)";
        sendPrivateChat(room, selector.id, {
            name: "เกม",
            text: `🕵️ ${targetA.name} และ ${targetB.name}: ${resultText}`,
            type: "private",
            isSystem: true,
        });

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("detective_scout", ({ roomId, targetAId, targetBId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performDetectiveScout(room, roomId, getRoomPlayerIdForSocket(room, socket), targetAId, targetBId);
    });

    // ----------------------------------------------------------------
    // CUPID PAIR (ความสามารถ "กามเทพ": เลือก 2 คนพร้อมกันเพื่อจับคู่เป็นคู่รัก)
    // การเลือกเป้าหมายทำแบบเดียวกับนักสืบเป๊ะๆ (แตะเลือกทีละคนที่ฝั่ง client แล้วยิง event นี้ครั้งเดียว
    // ตอนครบ 2 คน) แต่ต่างจากนักสืบตรงที่ใช้ได้แค่ "ครั้งเดียวตลอดเกม" (ไม่รีเซ็ตรายคืนเหมือน
    // detectiveScoutedThisNight) เช็คจาก p.cupidPaired แทน — และผลของการจับคู่ไม่ใช่แค่ข้อมูล
    // ที่กามเทพเห็นคนเดียวเหมือนนักสืบ แต่มีผลจริงกับสองคนที่ถูกจับคู่:
    //   - เห็นบทบาทที่แท้จริงของกันและกันทันที (ใช้ revealRoleMutual แบบเดียวกับอันธพาล<->ผู้โจมตี)
    //   - ถูกตั้งเป็นคู่รักกันแบบ cross-reference ผ่าน p.loverId (ให้ client โชว์ 💘 ที่มุมการ์ด
    //     เห็นเฉพาะสองคนนี้เท่านั้น — ดู renderPlayerGrid ฝั่ง player.main.js) แต่ไม่รู้ว่าใครคือกามเทพ
    //   - ผูกชะตากรรมกัน (ตายตามกัน) และมีเงื่อนไขชนะพิเศษร่วมกัน — ดู cleanupAfterDeath/checkLoversWinAlone/isWinner
    // ----------------------------------------------------------------
    function performCupidPair(room, roomId, playerId, targetAId, targetBId) {
        if (!room.isNight) return; // เลือกคู่ได้เฉพาะตอนกลางคืนเท่านั้น (เหมือนนักสืบ)

        const selector = room.players.find((p) => p.id === playerId);
        if (!selector || !selector.alive || selector.isHost) return;
        if (selector.role !== "กามเทพ") return;
        if (selector.cupidPaired) return; // จับคู่จริงไปแล้วตลอดเกม (สรุปผลตอนเช้าแล้ว) แก้ไขไม่ได้อีก

        // แก้บั๊ก: เดิมพอเลือกครบ 2 คนจะ "ล็อกสิทธิ์ทันที" (selector.cupidPaired = true ที่นี่เลย)
        // ทำให้เปลี่ยนใจไม่ได้อีกแม้ยังเป็นกลางคืนอยู่ ตอนนี้แค่ "เลือกไว้" (pending) เท่านั้น เรียก
        // event นี้ซ้ำกี่ครั้งก็ได้ตลอดคืนเพื่อเปลี่ยนตัวเลือก — ยังไม่ล็อกอะไรจนกว่าจะถึงเช้าจริง
        // (ดู resolve_night ที่ applyCupidPair) รองรับส่ง targetAId/targetBId มาไม่ครบ 2 คน (null ได้)
        // เพื่อรองรับ "ยกเลิกคนใดคนหนึ่งแล้วรอเลือกใหม่" จากฝั่ง client ด้วย
        const targetA = targetAId ? findTargetablePlayer(room, targetAId) : null;
        const targetB = targetBId ? findTargetablePlayer(room, targetBId) : null;
        if (targetAId && !targetA) return; // ส่ง id มาแต่หาตัวไม่เจอ (ข้อมูลเพี้ยน) — ไม่ใช่กรณีตั้งใจเคลียร์
        if (targetBId && !targetB) return;
        if (targetA && targetA.id === playerId) return; // จับคู่ตัวเองไม่ได้
        if (targetB && targetB.id === playerId) return;
        if (targetA && targetB && targetA.id === targetB.id) return; // เลือกคนเดียวกันซ้ำสองช่องไม่ได้

        // หมายเหตุ: ไม่เช็คแล้วว่าเป้าหมายถูกผู้ยุยงเลือกไว้ทับซ้อนอยู่หรือเปล่า (เดิมเช็คไขว้กับ
        // room.pendingInstigatorPair ตรงนี้) — ตั้งใจปล่อยให้ทับซ้อนกันได้เพื่อความเรียบง่าย
        if (targetA && targetB) {
            room.pendingLoverPair = { selectorId: selector.id, targetAId: targetA.id, targetBId: targetB.id };
            // ไม่ต้องแจ้งเตือนอะไรในแชทของกามเทพตอนจับคู่กลางคืน (ตามที่ระบุ)
        } else if (room.pendingLoverPair && room.pendingLoverPair.selectorId === selector.id) {
            // เลือกไม่ครบ 2 คน (เพิ่งยกเลิกคนใดคนหนึ่งไป) → เคลียร์ pending pair เดิมทิ้งก่อน รอเลือกใหม่ให้ครบ
            room.pendingLoverPair = null;
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("cupid_pair", ({ roomId, targetAId, targetBId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performCupidPair(room, roomId, getRoomPlayerIdForSocket(room, socket), targetAId, targetBId);
    });

    // ----------------------------------------------------------------
    // INSTIGATOR PAIR (ความสามารถ "ผู้ยุยง": เลือก 2 คนพร้อมกันเพื่อจับคู่กัน)
    // ทำงานแบบเดียวกับ performCupidPair เป๊ะๆ (เลือกทีละคนที่ฝั่ง client แล้วยิง event นี้ครั้งเดียว
    // ตอนครบ 2 คน ใช้ได้แค่ "ครั้งเดียวตลอดเกม" เช็คจาก p.instigatorPaired) ต่างกันแค่ 2 จุด:
    //   1) นอกจาก revealRoleMutual(targetA, targetB) ให้ทั้งสองเห็นบทบาทกันและกันแล้ว ยังเปิดเผยบทบาท
    //      ที่แท้จริงของ "ผู้ยุยง" เองให้ทั้งสองเห็นด้วย (แบบทางเดียว — ผู้ยุยงไม่ได้เห็นบทบาทของเป้าหมาย
    //      กลับ) ผ่านการ push targetA/targetB เข้า selector.roleRevealMutualWith ตรงๆ
    //   2) ใช้ p.instigatorLinkId แยกจาก p.loverId เพื่อไม่ให้ชนกับกามเทพถ้าห้องมีทั้งสองบทบาท
    // ----------------------------------------------------------------
    function performInstigatorPair(room, roomId, playerId, targetAId, targetBId) {
        if (!room.isNight) return; // เลือกคู่ได้เฉพาะตอนกลางคืนเท่านั้น (เหมือนผู้ยุยง/กามเทพ)

        const selector = room.players.find((p) => p.id === playerId);
        if (!selector || !selector.alive || selector.isHost) return;
        if (selector.role !== "ผู้ยุยง") return;
        if (selector.instigatorPaired) return; // จับคู่จริงไปแล้วตลอดเกม (สรุปผลตอนเช้าแล้ว) แก้ไขไม่ได้อีก

        // ทำงานแบบเดียวกับ performCupidPair เป๊ะๆ — แค่ "เลือกไว้" (pending) เปลี่ยนใจได้ตลอดคืน
        // ไม่ล็อกอะไรจนกว่าจะถึงเช้าจริง (ดู resolve_night ที่ applyInstigatorPair) รองรับส่ง
        // targetAId/targetBId มาไม่ครบ 2 คน (null ได้) เพื่อรองรับ "ยกเลิกคนใดคนหนึ่ง" จาก client
        const targetA = targetAId ? findTargetablePlayer(room, targetAId) : null;
        const targetB = targetBId ? findTargetablePlayer(room, targetBId) : null;
        if (targetAId && !targetA) return;
        if (targetBId && !targetB) return;
        if (targetA && targetA.id === playerId) return; // จับคู่ตัวเองไม่ได้
        if (targetB && targetB.id === playerId) return;
        if (targetA && targetB && targetA.id === targetB.id) return;
        // ผู้ยุยงห้ามจับคู่ "ผู้ถูกสาป" กับใครเด็ดขาด ไม่ว่าจะเป็นช่องที่ 1 หรือ 2 — ผู้ถูกสาปมีชะตากรรมผูกกับ
        // การถูกหมาป่ากัด (กลายเป็นหมาป่า) อยู่แล้ว ไม่ควรมาผูกซ้อนกับระบบตายตามคู่ของผู้ยุยงอีกชั้น
        if (targetA && targetA.role === "ผู้ถูกสาป") return;
        if (targetB && targetB.role === "ผู้ถูกสาป") return;

        // หมายเหตุ: ไม่เช็คแล้วว่าเป้าหมายถูกกามเทพเลือกไว้ทับซ้อนอยู่หรือเปล่า — ตั้งใจปล่อยให้
        // ทับซ้อนกันได้เพื่อความเรียบง่าย (เหมือน performCupidPair)
        if (targetA && targetB) {
            room.pendingInstigatorPair = { selectorId: selector.id, targetAId: targetA.id, targetBId: targetB.id };
            sendPrivateChat(room, selector.id, {
                name: "เกม",
                text: `🎭 คุณเลือกจับคู่ ${targetA.name} และ ${targetB.name} ไว้ (ยังเปลี่ยนใจได้จนกว่าจะถึงเช้า) — จะกลายเป็นคู่จริงตอนเช้า`,
                type: "private",
                isSystem: true,
            });
        } else if (room.pendingInstigatorPair && room.pendingInstigatorPair.selectorId === selector.id) {
            room.pendingInstigatorPair = null;
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("instigator_pair", ({ roomId, targetAId, targetBId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performInstigatorPair(room, roomId, getRoomPlayerIdForSocket(room, socket), targetAId, targetBId);
    });

    // ----------------------------------------------------------------
    // GIVE UP ORACLE SENSE (หมาป่าหยั่งรู้กด "สละลางสังหรณ์" กลายเป็นหมาป่าธรรมดาโดยสมัครใจ
    // เพื่อร่วมล่าได้แทนการส่อง — ย้อนกลับไม่ได้ ใช้ pattern เดียวกับกลายร่างอัตโนมัติตอนเหลือตัวเดียว)
    // ----------------------------------------------------------------
    socket.on("give_up_oracle_sense", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        // เดิมใช้ได้เฉพาะตอนกลางคืนเท่านั้น ตอนนี้เปิดให้กดได้ทั้งวันทั้งคืนแล้ว (สละพลังล้วน ๆ ไม่ใช่การกระทำต่อเป้าหมาย)

        const p = getRoomPlayerForSocket(room, socket);
        if (!p || !p.alive || p.isHost) return;
        if (p.role !== "หมาป่าหยั่งรู้") return;

        transformOracleWolfToNormal(room, roomId, p, "manual");

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // REVEAL MAYOR (นายกกดปุ่ม 🤠 เปิดเผยตัวเอง — ใช้ได้ครั้งเดียวตลอดเกม ย้อนกลับไม่ได้
    // ใช้ได้ทั้งวันและกลางคืน เหมือน give_up_oracle_sense เพราะเป็นการสละความลับล้วน ๆ
    // ไม่ใช่การกระทำต่อเป้าหมาย) เมื่อกดแล้ว: เปิดเผยบทบาทให้ทุกคนเห็นในกริดถาวร + ประกาศในแชทกลาง
    // ว่าใครเป็นนายก + ตั้งค่า mayorRevealed = true ให้โหวตของเขานับเป็น 2 เสียงไปตลอดเกม
    // (ดู getVoteWeight ที่ใช้ตอนนับคะแนนใน closeVoteRound)
    //
    // ข้อยกเว้น: ห้ามเปิดตัวใน "คืนแรก" ของเกม (ตามคำขอผู้ใช้) — ต้องรอถึงกลางวันแรกก่อนถึงจะกดได้
    // เช็คแบบเดียวกับยายขี้โมโห/เด็กขี้โวยวายด้านบน (performSelectTarget): บล็อกเฉพาะตอนกำลังอยู่ใน
    // คืนแรกจริงๆ เท่านั้น (room.isNight && nightCount<=1) ไม่ใช่แค่เช็ค nightCount เฉยๆ เพราะ nightCount
    // จะค้างอยู่ที่ 1 ตลอดทั้ง "วันแรก" ด้วย (หลังคืนแรกจบ ก่อนคืนที่สองเริ่ม) ซึ่งควรเปิดตัวได้แล้ว
    // ----------------------------------------------------------------
    socket.on("reveal_mayor", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.gameOver) return;

        const player = getRoomPlayerForSocket(room, socket);
        if (!player || !player.alive || player.isHost) return;
        if (player.role !== "นายก") return;
        if (player.mayorRevealed || !(player.mayorAvailable > 0)) return; // ใช้ไปแล้ว/ไม่มีสิทธิ์
        if (room.isNight && (room.nightCount || 0) <= 1) return; // ห้ามเปิดตัวตอนกำลังอยู่ในคืนแรกของเกม (ตามคำขอผู้ใช้)

        player.mayorAvailable = 0;
        player.mayorRevealed = true;
        revealRolePublic(player);

        room.globalChatHistory = room.globalChatHistory || [];
        const msg = {
            name: "เกม",
            text: `${player.name} ได้เปิดตัวว่าเป็น นายก🤠 ทำให้คะแนนโหวตของเขาจะเป็น2เสียง`,
            type: "global",
            isSystem: true,
            isMayor: true, // สีทอง แยกจากข้อความระบบทั่วไป (เขียว) — ดู .msgMayor ใน player.css
        };
        pushGlobalChat(room, msg);
        io.to(roomId).emit("chat_message", msg);

        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // SELECT SHIELD (หมาป่าผู้พิทักษ์ — วางโล่ป้องกันการประหาร)
    // ----------------------------------------------------------------
    // เฟส 1: แยกเป็น performSelectShield(room, roomId, playerId, targetId)
    function performSelectShield(room, roomId, playerId, targetId) {
        // เดิมใช้ได้เฉพาะตอน room.voteMode เปิดอยู่เท่านั้น — ตอนนี้ให้กดวางโล่ล่วงหน้าได้
        // ทั้งวัน (ไม่ต้องรอโฮสต์เปิดโหมดโหวตก่อน) ห้ามใช้แค่ตอนกลางคืนเท่านั้น
        if (room.isNight) return;

        const selector = room.players.find((p) => p.id === playerId);
        if (!selector || !selector.alive || selector.isHost) return;
        if (!GUARDIAN_ROLES.has(selector.role)) return;
        if (!(selector.guardianShieldAvailable > 0)) return;

        room.shieldTargets = room.shieldTargets || {};

        if (!targetId) {
            delete room.shieldTargets[playerId];
        } else {
            // ตรวจสอบเป้าหมาย (ยกเว้นตัวเอง ซึ่งรู้อยู่แล้วว่ามีชีวิต)
            if (targetId !== playerId) {
                const targetPlayer = room.players.find((p) => p.id === targetId);
                if (!targetPlayer || !targetPlayer.alive) return;
            }

            // กดคนเดิมซ้ำ = ยกเลิก
            if (room.shieldTargets[playerId] === targetId) {
                delete room.shieldTargets[playerId];
            } else {
                room.shieldTargets[playerId] = targetId;
            }
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("select_shield", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performSelectShield(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
    });

    // ----------------------------------------------------------------
    // CULT ACTION (ผู้นำลัทธิ — เลือกได้ 2 แบบต่อคืน อย่างใดอย่างหนึ่งเท่านั้น: ชักชวนเข้าลัทธิ
    // หรือสังเวยสมาชิกลัทธิเพื่อฆ่าผู้เล่นอื่น) เก็บไว้เป็น "เลือกไว้ก่อน" ใน room.cultActions[leaderId]
    // แล้วค่อยสรุปผลจริงตอน resolve_night (แบบเดียวกับหมาป่า/แม่มด/บทบาทกลางคืนอื่นๆ ทั้งหมด)
    // targetId/sacrificeId ที่ส่งมาเป็น null/undefined = ยกเลิกการเลือกของคืนนี้
    // ----------------------------------------------------------------
    function performCultAction(room, roomId, playerId, { mode, targetId, sacrificeId } = {}) {
        if (!room.isNight) return; // ใช้ได้เฉพาะตอนกลางคืนเท่านั้น

        const leader = room.players.find((p) => p.id === playerId);
        if (!leader || !leader.alive || leader.isHost) return;
        if (leader.role !== "ผู้นำลัทธิ") return;

        room.cultActions = room.cultActions || {};

        if (!mode) {
            delete room.cultActions[playerId];
            broadcastRoomUpdate(roomId, room);
            return;
        }

        if (mode === "recruit") {
            if (!targetId || targetId === playerId) return;
            const target = findTargetablePlayer(room, targetId);
            if (!target) return;
            // หมายเหตุ: ตั้งใจไม่เช็คเงื่อนไข "ชวนไม่ได้" (หมาป่า/นักฆ่าเดี่ยว/ผู้ถูกสาป/เต็มโควต้า/อยู่ลัทธิอื่นแล้ว)
            // ที่ตรงนี้ เพราะผู้นำลัทธิไม่รู้บทจริงของเป้าหมายที่แตะเลือก (เป็นข้อมูลลับ) — ให้แตะเลือกติดค้างไว้ได้
            // ปกติเหมือนเลือกใครก็ได้ก่อน แล้วค่อยไปเช็คเงื่อนไขจริงตอนสรุปผล resolve_night พร้อมแจ้งเตือนส่วนตัว
            // ให้ผู้นำลัทธิทราบตอนเช้าถ้าชวนไม่สำเร็จ (ดู resolve_night ด้านล่าง) — สมจริงกว่าเดิมที่บล็อกทันที
            // ตั้งแต่ตอนแตะเงียบๆ (ซึ่งจะแอบเผยว่าเป้าหมายเป็นหมาป่า/นักฆ่าเดี่ยวโดยไม่ตั้งใจ)
            room.cultActions[playerId] = { mode: "recruit", targetId };
        } else if (mode === "sacrifice") {
            if (!sacrificeId || !targetId || sacrificeId === targetId) return;
            if (targetId === playerId) return; // ผู้นำลัทธิสังเวยตัวเองไม่ได้
            const member = room.players.find((p) => p.id === sacrificeId);
            if (!member || !member.alive || member.cultLeaderId !== playerId) return; // ต้องเป็นสมาชิกลัทธิของตัวเอง ที่ยังมีชีวิตอยู่
            const target = findTargetablePlayer(room, targetId);
            if (!target) return;
            room.cultActions[playerId] = { mode: "sacrifice", targetId, sacrificeId };
        } else {
            return;
        }

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("cult_action", ({ roomId, mode, targetId, sacrificeId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performCultAction(room, roomId, getRoomPlayerIdForSocket(room, socket), { mode, targetId, sacrificeId });
    });

    // ----------------------------------------------------------------
    // BANDIT ACTION (โจร — เปลี่ยนบทบาทผู้เล่นคนอื่นให้เป็นผู้สมรู้ร่วมคิด) ใช้ได้เฉพาะคืนที่ยังไม่มี
    // ผู้สมรู้ร่วมคิดเท่านั้น (คืนที่มีแล้วให้ใช้ cast_bandit_kill แทน) เก็บไว้เป็น "เลือกไว้ก่อน" ใน
    // room.banditActions[leaderId] แล้วค่อยสรุปผลจริงตอน resolve_night (แบบเดียวกับ cult_action)
    // targetId ที่ส่งมาเป็น null/undefined = ยกเลิกการเลือกของคืนนี้
    // ----------------------------------------------------------------
    function performBanditAction(room, roomId, playerId, { targetId } = {}) {
        if (!room.isNight) return; // ใช้ได้เฉพาะตอนกลางคืนเท่านั้น

        const leader = room.players.find((p) => p.id === playerId);
        if (!leader || !leader.alive || leader.isHost) return;
        if (leader.role !== "โจร") return;
        if (aliveBanditAccomplicesOf(room, leader.id).length > 0) return; // มีผู้สมรู้ร่วมคิดอยู่แล้ว ใช้ cast_bandit_kill แทน

        room.banditActions = room.banditActions || {};

        if (!targetId) {
            delete room.banditActions[playerId];
            broadcastRoomUpdate(roomId, room);
            return;
        }

        if (targetId === playerId) return;
        const target = findTargetablePlayer(room, targetId);
        if (!target) return;
        // ตั้งใจไม่เช็คเงื่อนไข "เปลี่ยนไม่ได้" ตรงนี้ (เหตุผลเดียวกับ performCultAction — หัวโจรไม่รู้
        // บทจริงของเป้าหมายที่แตะเลือก) ให้แตะเลือกติดค้างไว้ได้ปกติก่อน แล้วค่อยเช็คจริงตอน resolve_night
        room.banditActions[playerId] = { targetId };

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("bandit_action", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performBanditAction(room, roomId, getRoomPlayerIdForSocket(room, socket), { targetId });
    });

    // ----------------------------------------------------------------
    // SELECT CURSE TARGET (หมาป่านักเวท — เลือกเป้าร่ายเวทตอนกลางวัน เปลี่ยนใจ/เปลี่ยนเป้าได้
    // ไม่จำกัดจำนวนครั้งระหว่างวัน แต่คำสาปยังไม่มีผลใดๆ ในตอนที่เลือก — จะเริ่มมีผลจริงก็ต่อเมื่อ
    // เข้าสู่ตอนกลางคืนแล้วเท่านั้น (คำนวณ wizardCursed ตอน beginNight) ไม่ต้องสนบทบาทอื่นที่ส่อง
    // ได้ตอนกลางวัน (เช่น ศาลเตี้ย) — เอาแค่ตรรกะของบทนี้เอง คำสาปมีผลแค่คืนนั้นคืนเดียว พอเข้าสู่
    // เช้าวันถัดไปจะถูกล้างทิ้งอัตโนมัติ (ดู resolve_night) หมาป่านักเวทต้องเลือกเป้าใหม่เองทุกวัน
    // ไม่มีการต่อเป้าเดิมให้อัตโนมัติ แม้จะอยากร่ายคนเดิมซ้ำก็ต้องกดเลือกเองใหม่
    // ----------------------------------------------------------------
    // เฟส 1: แยกเป็น performSelectCurseTarget(room, roomId, playerId, targetId)
    function performSelectCurseTarget(room, roomId, playerId, targetId) {
        if (room.isNight) return; // เลือกเป้าได้เฉพาะตอนกลางวันเท่านั้น
        if (room.gameOver) return;

        const selector = room.players.find((p) => p.id === playerId);
        if (!selector || !selector.alive || selector.isHost) return;
        if (selector.role !== "หมาป่านักเวท") return;

        room.curseTargets = room.curseTargets || {};

        if (!targetId) {
            delete room.curseTargets[playerId];
        } else {
            if (targetId === playerId) return; // ร่ายใส่ตัวเองไม่ได้
            const target = room.players.find((p) => p.id === targetId);
            if (!target || target.isHost || !target.alive) return;

            // กดคนเดิมซ้ำ = ยกเลิกเป้าที่เลือกไว้
            if (room.curseTargets[playerId] === targetId) {
                delete room.curseTargets[playerId];
            } else {
                room.curseTargets[playerId] = targetId;
            }
        }

        // ยังไม่คำนวณ wizardCursed ที่นี่ — เก็บแค่ "เป้าที่เลือกไว้" (room.curseTargets)
        // ตอนกลางวัน คำสาปจะยังไม่มีผลจนกว่าจะเข้าสู่กลางคืน (ดู beginNight)
        broadcastRoomUpdate(roomId, room);
    }
    socket.on("select_curse_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performSelectCurseTarget(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
    });

    // ----------------------------------------------------------------
    // FIRE SHERIFF GUN — ศาลเตี้ยใช้กระสุนนัดเดียวยิงตอนกลางวัน (ใช้ได้ทันทีที่เข้าสู่กลางวัน
    // ไม่ต้องรอเปิดโหมดโหวต) เลือกยิงได้ 1 คน ตายทันที ยกเว้นเป้าหมายคือ "อันธพาล" ที่ยังไม่เคย
    // ถูกเปิดเผย ซึ่งจะป้องกันตัวเองได้เหมือนโดนฆ่าตอนกลางคืน (ไม่ตายทันที ตายหลังจบการประชุมนี้
    // และเปิดเผยกันแบบส่วนตัวระหว่างอันธพาลกับศาลเตี้ยเท่านั้น) เมื่อยิงแล้ว บทศาลเตี้ยจะถูกเปิดเผย
    // ให้ทุกคนเห็นทันทีไม่ว่าผลจะเป็นอย่างไร และกระสุนจะหมดลง (มีแค่ 1 นัดต่อเกม)
    // ----------------------------------------------------------------
    socket.on("fire_sheriff_gun", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (room.isNight) return; // ใช้ได้เฉพาะตอนกลางวัน
        if (room.gameOver) return;

        const shooter = getRoomPlayerForSocket(room, socket);
        if (!shooter || shooter.isHost) return;
        if (!shooter.alive) return;
        if (shooter.role !== "ศาลเตี้ย") return;
        if (!(shooter.sheriffBullets > 0)) return;
        if (shooter.sheriffUsedToday) return; // ใช้ความสามารถวันนี้ไปแล้ว (ยิงหรือดูบท อย่างใดอย่างหนึ่งต่อวัน)

        if (!targetId || (shooter && targetId === shooter.id)) return;
        const target = room.players.find((p) => p.id === targetId);
        if (!target || target.isHost || !target.alive) return;

        shooter.sheriffBullets = 0;
        shooter.sheriffUsedToday = true;

        room.globalChatHistory = room.globalChatHistory || [];

        // หาผลลัพธ์ล่วงหน้าก่อนสร้างข้อความ revealMsg (ยิงโดนแต่รอด vs ตายจริง) เพื่อให้แจ้ง
        // client ได้ถูกต้องว่าข้อความนี้ควรแสดงเป็น "มีคนตาย" (สีแดง) หรือไม่ — เงื่อนไขเดียวกัน
        // กับ 2 branch ด้านล่าง (อันธพาล/หมาป่าดื้อรั้นที่ยังไม่เคยรอดมาก่อน = ไม่ตายจริงตอนนี้)
        const targetWillSurvive =
            (target.role === "อันธพาล" && !target.musclemanExposed) ||
            (target.role === "หมาป่าดื้อรั้น" && !target.stubbornInjured);

        // เปิดเผยบทศาลเตี้ยให้ทุกคนเห็นทันทีที่ยิง (ไม่ว่าผลจะเป็นอย่างไร)
        // ข้อความนี้ครอบคลุมทั้ง "เปิดเผยตัว" และ "ยิงใคร" ในตัวเดียวอยู่แล้ว — กรณียิงตายทันที
        // (ปกติ ไม่ใช่อันธพาล/หมาป่าดื้อรั้น) จะไม่ส่งข้อความ "ถูกยิงเสียชีวิต" แยกซ้ำอีกรอบด้านล่าง
        const revealMsg = {
            name: "เกม",
            text: `🔫 ${shooter.name} เป็นศาลเตี้ยและได้ยิง ${target.name}`,
            type: "global",
            isSystem: true,
            isDeath: !targetWillSurvive,
        };
        pushGlobalChat(room, revealMsg);
        io.to(roomId).emit("chat_message", revealMsg);

        // ศาลเตี้ยเปิดเผยตัวต่อสาธารณะทันทีที่ยิง (ไม่ว่าผลจะเป็นอย่างไร) — ทุกคนเห็นไอคอนอาชีพในกริดเลย
        revealRolePublic(shooter);

        if (target.role === "อันธพาล" && !target.musclemanExposed) {
            // อันธพาลป้องกันตัวเองได้เหมือนโดนฆ่าตอนกลางคืน — ไม่ตายทันที เปิดเผยกันแบบส่วนตัว
            target.musclemanExposed = true;
            target.musclemanPendingDeath = true;
            // ศาลเตี้ยกับอันธพาลเห็นไอคอนอาชีพของกันและกันในกริด (รู้กันแค่ 2 คนนี้ นอกเหนือจากที่ทั้งห้องเห็นศาลเตี้ยอยู่แล้ว)
            revealRoleMutual(target, shooter);

            sendPrivateChat(room, target.id, {
            name: "เกม",
                text: `คุณถูกศาลเตี้ยยิง แต่ป้องกันตัวเองไว้ได้ — ศาลเตี้ยคือ ${shooter.name}`,
                type: "private",
                isSystem: true,
            });
            sendPrivateChat(room, shooter.id, {
            name: "เกม",
                text: `กระสุนของคุณยิงไม่เข้า ${target.name} ป้องกันตัวเองไว้ได้ (เขาคืออันธพาล) — จะเสียชีวิตหลังการประชุมนี้จบลง`,
                type: "private",
                isSystem: true,
            });

            const anonMsg = {
                name: "เกม",
                text: `❓ ${target.name} ถูกยิงแต่รอดชีวิตมาได้อย่างน่าประหลาดใจ`,
                type: "global",
                isSystem: true,
            };
            pushGlobalChat(room, anonMsg);
            io.to(roomId).emit("chat_message", anonMsg);
        } else if (target.role === "หมาป่าดื้อรั้น" && !target.stubbornInjured) {
            // หมาป่าดื้อรั้นมี 2 ชีวิต — โดนยิงครั้งแรกรอด (บาดเจ็บ) ไม่ตาย นับรวมกับที่โดนฆ่า/ประหารด้วย
            target.stubbornInjured = true;

            sendPrivateChat(room, target.id, {
            name: "เกม",
                text: "คุณได้รับบาดเจ็บ หากถูกโจมตีอีกครั้งคุณจะตาย",
                type: "private",
                isSystem: true,
            });

            // แจ้งศาลเตี้ย (ผู้ยิง) เป็นการส่วนตัวว่ายิงไม่สำเร็จ
            sendPrivateChat(room, shooter.id, {
            name: "เกม",
                text: `ไม่สามารถโจมตี ${target.name} ได้`,
                type: "private",
                isSystem: true,
            });

            const anonMsg = {
                name: "เกม",
                text: `🐺💢 หมาป่าดื้อรั้นถูกโจมตีและได้รับบาดเจ็บ`,
                type: "global",
                isSystem: true,
            };
            pushGlobalChat(room, anonMsg);
            io.to(roomId).emit("chat_message", anonMsg);
        } else {
            target.alive = false;
            const cascadeDeaths = cleanupAfterDeath(room, target);

            // ไม่ต้องส่งข้อความ "ถูกยิงเสียชีวิต" แยกอีกรอบ — ข้อความ revealMsg ด้านบน
            // ("... เป็นศาลเตี้ยและได้ยิง ...") สื่อผลลัพธ์ครบอยู่แล้วในตัวเดียว
            announceCascadeDeaths(room, roomId, cascadeDeaths);
        }

        checkGameEndGeneral(room, roomId);
        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // SHERIFF PEEK ROLE — ศาลเตี้ยใช้ "ดูบทบาท" คล้ายผู้หยั่งรู้ (เห็นบทบาทจริงเฉพาะตัวเอง)
    // ใช้ได้ตอนกลางวันเท่านั้น (เหมือนปืน) และมีสิทธิ์ 1 ครั้งตลอดเกม (มีนัดเดียวเหมือนปืน)
    // วันหนึ่งใช้ได้แค่ 1 ความสามารถ (ยิงหรือดูบท เลือกได้อย่างเดียว ใช้ทั้งคู่ในวันเดียวกันไม่ได้ —
    // เช็คร่วมกับ sheriffUsedToday ซึ่งถูกตั้งจากทั้งปืนและดูบท และรีเซ็ตทุกครั้งที่เริ่มวันใหม่)
    // เป้าหมายจะได้รับแจ้งว่า "ศาลเตี้ยได้ทราบบทบาทของคุณแล้ว" แบบไม่ระบุตัวตนศาลเตี้ย
    // (ต่างจากปืนที่เปิดเผยตัวศาลเตี้ยต่อสาธารณะทันที — ดูบทไม่เปิดเผยตัวศาลเตี้ยเลย)
    //
    // แยก logic การดูบทของศาลเตี้ยออกมาเป็นฟังก์ชันกลาง เพื่อให้ handler เรียกใช้ได้อย่างสม่ำเสมอ
    // ----------------------------------------------------------------
    function performSheriffPeek(room, roomId, selectorId, targetId) {
        if (room.isNight) return; // ใช้ได้เฉพาะตอนกลางวัน
        if (room.gameOver) return;

        const selector = room.players.find((p) => p.id === selectorId);
        if (!selector || selector.isHost) return;
        if (!selector.alive) return;
        if (selector.role !== "ศาลเตี้ย") return;
        if (!(selector.sheriffPeeks > 0)) return;
        if (selector.sheriffUsedToday) return; // ใช้ความสามารถวันนี้ไปแล้ว (ยิงหรือดูบท อย่างใดอย่างหนึ่งต่อวัน)

        if (!targetId || targetId === selectorId) return;
        const target = room.players.find((p) => p.id === targetId);
        if (!target || target.isHost || !target.alive) return;

        selector.sheriffPeeks = 0;
        selector.sheriffUsedToday = true;

        // เปิดเผยบทบาทจริงให้เห็นเฉพาะศาลเตี้ยเท่านั้น (ใช้ pattern เดียวกับ "ผู้หยั่งรู้" แต่แยกฟิลด์ต่างหาก
        // เพราะศาลเตี้ยดูบทตอนกลางวัน ต้องเคลียร์ตอน "เริ่มคืนถัดไป" ไม่ใช่ตอนเช้าเหมือนของฝั่งส่องกลางคืน)
        // คนที่ถูกหมาป่านักเวทร่ายเวทไว้ จะเห็นเป็น "หมาป่า" แทนบทจริง
        target.sheriffRevealedTo = target.sheriffRevealedTo || [];
        if (!target.sheriffRevealedTo.includes(selector.id)) target.sheriffRevealedTo.push(selector.id);

        const scoutDisplayRole = target.wizardCursed ? "หมาป่า" : target.role;
        // snapshot บทที่เห็น ณ ตอนดูบท เหมือน pattern ของ "ผู้หยั่งรู้" — กันบทจริงเปลี่ยนทีหลังแล้วผลเก่าเปลี่ยนตาม
        target.sheriffRevealedRoleBy = target.sheriffRevealedRoleBy || {};
        target.sheriffRevealedRoleBy[selector.id] = scoutDisplayRole;
        sendPrivateChat(room, selector.id, {
            name: "เกม",
            text: `📣 ${target.name}... ${scoutDisplayRole}`,
            type: "private",
            isSystem: true,
        });

        // แจ้งเป้าหมาย (ส่วนตัว) ว่าศาลเตี้ยได้ทราบบทบาทของตนแล้ว — ไม่เปิดเผยว่าใครคือศาลเตี้ย
        sendPrivateChat(room, target.id, {
            name: "เกม",
            text: `📣 ศาลเตี้ยได้ทราบบทบาทของคุณแล้ว`,
            type: "private",
            isSystem: true,
        });

        broadcastRoomUpdate(roomId, room);
    }
    socket.on("sheriff_peek_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performSheriffPeek(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
    });

    // ----------------------------------------------------------------
    // PRIEST HOLY WATER — นักบวช 🫙 มีน้ำมนต์ 1 ขวดตลอดเกม ปาได้เฉพาะตอนกลางวัน (เหมือนปืนศาลเตี้ย)
    // ผลลัพธ์: ถ้าเป้าเป็นหมาป่า (WOLF_ROLES) เป้าจะตาย (หมาป่าดื้อรั้นยังมี 2 ชีวิตเหมือนโดนยิง/กัดปกติ)
    // แต่ถ้าเป้าไม่ใช่หมาป่า น้ำมนต์จะย้อนเข้าตัว นักบวชเองตายแทนทันที (เป้าไม่เป็นอะไรเลย)
    // ไม่ว่าผลจะเป็นอย่างไร บทนักบวชจะถูกเปิดเผยต่อสาธารณะทันทีที่ปา (revealRolePublic) — ใช้ได้แค่ครั้งเดียวตลอดเกม
    // ----------------------------------------------------------------
    function performPriestHolyWater(room, roomId, casterId, targetId) {
        if (room.isNight) return; // ปาได้เฉพาะตอนกลางวัน
        if (room.gameOver) return;

        const caster = room.players.find((p) => p.id === casterId);
        if (!caster || caster.isHost) return;
        if (!caster.alive) return;
        if (caster.role !== "นักบวช") return;
        if (!(caster.priestHolyWaterPotions > 0)) return;

        if (!targetId || targetId === casterId) return;
        const target = room.players.find((p) => p.id === targetId);
        if (!target || target.isHost || !target.alive) return;

        caster.priestHolyWaterPotions = 0; // ขวดเดียวตลอดเกม ใช้แล้วหมดทันทีไม่ว่าผลจะเป็นอย่างไร

        room.globalChatHistory = room.globalChatHistory || [];

        // เปิดเผยบทนักบวชให้ทุกคนเห็นทันทีที่ปา ไม่ว่าผลจะเป็นอย่างไร (เหมือนศาลเตี้ยยิงปืน)
        revealRolePublic(caster);

        const targetIsWolf = WOLF_ROLES.has(target.role);

        if (targetIsWolf) {
            // หมาป่าดื้อรั้นมี 2 ชีวิต — โดนน้ำมนต์ครั้งแรกรอด (บาดเจ็บ) เหมือนโดนยิง/กัดปกติ
            const targetWillSurvive = target.role === "หมาป่าดื้อรั้น" && !target.stubbornInjured;

            const revealMsg = {
                name: "เกม",
                text: `🫙✨ ${caster.name} เป็นนักบวชและได้ปาน้ำมนต์ใส่ ${target.name} — ${target.name} คือหมาป่าตัวจริง!`,
                type: "global",
                isSystem: true,
                isDeath: !targetWillSurvive,
            };
            pushGlobalChat(room, revealMsg);
            io.to(roomId).emit("chat_message", revealMsg);

            if (targetWillSurvive) {
                target.stubbornInjured = true;
                sendPrivateChat(room, target.id, {
                    name: "เกม",
                    text: "คุณได้รับบาดเจ็บจากน้ำมนต์ หากถูกโจมตีอีกครั้งคุณจะตาย",
                    type: "private",
                    isSystem: true,
                });
                const anonMsg = {
                    name: "เกม",
                    text: "🐺💢 หมาป่าดื้อรั้นถูกน้ำมนต์และได้รับบาดเจ็บ",
                    type: "global",
                    isSystem: true,
                };
                pushGlobalChat(room, anonMsg);
                io.to(roomId).emit("chat_message", anonMsg);
            } else {
                target.alive = false;
                const cascadeDeaths = cleanupAfterDeath(room, target);
                announceCascadeDeaths(room, roomId, cascadeDeaths);
            }
        } else {
            // เป้าไม่ใช่หมาป่า — น้ำมนต์ย้อนเข้าตัว นักบวชตายเองแทนทันที เป้าไม่เป็นอะไรเลย
            const revealMsg = {
                name: "เกม",
                text: `🫙💥 ${caster.name} เป็นนักบวชได้ปาน้ำมนต์ใส่ ${target.name} ซึ่งไม่ใช่หมาป่า ทำให้เขาตายเอง`,
                type: "global",
                isSystem: true,
                isDeath: true,
            };
            pushGlobalChat(room, revealMsg);
            io.to(roomId).emit("chat_message", revealMsg);

            caster.alive = false;
            const cascadeDeaths = cleanupAfterDeath(room, caster);
            announceCascadeDeaths(room, roomId, cascadeDeaths);
        }

        checkGameEndGeneral(room, roomId);
        broadcastRoomUpdate(roomId, room);
    }
    socket.on("cast_priest_holy_water", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performPriestHolyWater(room, roomId, getRoomPlayerIdForSocket(room, socket), targetId);
    });

    // ----------------------------------------------------------------
    // ILLUSION KILL DISGUISED — นักเล่นกล 🔥 กดฆ่าผู้เล่นทุกคนที่ถูกปลอมบทไว้ (สะสมจากหลายคืน)
    // พร้อมกันได้ในช่วงกลางวัน (ช่วงประชุม) ไม่ต้องเลือกเป้า — ฆ่าทุกคนใน illusionTargetIds ที่ยังมีชีวิตอยู่
    // ผู้เล่นที่ถูกฆ่าด้วยวิธีนี้จะถูกเปิดเผยต่อสาธารณะเป็น "นักเล่นกล" แทนบทจริง (ดู illusionDeathReveal
    // ที่ใช้แทน p.role ตอนแสดงไอคอนบทที่เปิดเผยฝั่ง client) ไม่เปิดเผยตัวตนของนักเล่นกลเอง
    // ----------------------------------------------------------------
    function performIllusionKillDisguised(room, roomId, casterId) {
        if (room.isNight) return; // ฆ่ารวดเดียวได้เฉพาะตอนกลางวัน (ช่วงประชุม) เท่านั้น
        if (room.voteMode) return; // แก้บั๊ก: ห้ามใช้หลังโฮสต์เปิดโหมดโหวตประหารแล้ว — ใช้ได้แค่ช่วงกลางวันก่อนเข้าโหวตเท่านั้น
        if (room.gameOver) return;

        const caster = room.players.find((p) => p.id === casterId);
        if (!caster || caster.isHost) return;
        if (!caster.alive) return;
        if (caster.role !== "นักเล่นกล") return;

        const targetIds = Array.isArray(caster.illusionTargetIds) ? caster.illusionTargetIds : [];
        const victims = targetIds
            .map((tid) => room.players.find((p) => p.id === tid))
            .filter((p) => p && p.alive);

        if (victims.length === 0) return; // ไม่มีใครถูกปลอมบทไว้ที่ยังมีชีวิตอยู่ ไม่มีอะไรให้ฆ่า

        // เคลียร์รายชื่อสะสมทิ้งทันที (ใช้ไปแล้ว) — ปลอมบทใหม่ในคืนถัดไปได้ตามปกติ
        caster.illusionTargetIds = [];

        room.globalChatHistory = room.globalChatHistory || [];
        let allCascadeDeaths = [];
        const killedVictims = [];

        // แก้บั๊ก: เดิมโค้ดตรงนี้ตั้ง victim.alive = false ตรงๆ ทุกคน ข้าม pipeline ป้องกันตัวเองของ
        // อันธพาล/บอดี้การ์ด/หมาป่าดื้อรั้นไปเลย ทั้งที่การฆ่ารวดของนักเล่นกลก็ถือเป็น "การโจมตี/การฆ่า"
        // เหมือนกัน (เทียบเท่ากับการยิงของศาลเตี้ย — ดู fire_sheriff_gun) บทป้องกันตัวเองของ 3 อาชีพนี้
        // จึงต้องทำงานเช่นกัน: รอดครั้งแรก (บาดเจ็บ/เปิดเผยตัว) แล้วค่อยตายจริงถ้าโดนอีกครั้งในอนาคต
        victims.forEach((victim) => {
            if (victim.role === "อันธพาล" && !victim.musclemanExposed) {
                // อันธพาลป้องกันตัวเองได้เหมือนโดนฆ่าตอนกลางคืน — ไม่ตายทันที เปิดเผยกันแบบส่วนตัว
                // กับนักเล่นกล (ผู้โจมตี) เท่านั้น แล้วจะตายจริงหลังจบการประชุมนี้ (musclemanPendingDeath)
                victim.musclemanExposed = true;
                victim.musclemanPendingDeath = true;
                revealRoleMutual(victim, caster);

                sendPrivateChat(room, victim.id, {
                    name: "เกม",
                    text: `คุณถูกฆ่า แต่ป้องกันตัวเองไว้ได้ — ผู้ที่ฆ่าคือ ${caster.name}`,
                    type: "private",
                    isSystem: true,
                });
                sendPrivateChat(room, caster.id, {
                    name: "เกม",
                    text: `${victim.name} ป้องกันตัวเองไว้ได้ (เขาคืออันธพาล) — จะเสียชีวิตหลังการประชุมนี้จบลง`,
                    type: "private",
                    isSystem: true,
                });

                const anonMsg = {
                    name: "เกม",
                    text: `❓ ${victim.name} ถูกฆ่าแต่รอดชีวิตมาได้อย่างน่าประหลาดใจ`,
                    type: "global",
                    isSystem: true,
                };
                pushGlobalChat(room, anonMsg);
                io.to(roomId).emit("chat_message", anonMsg);
                return;
            }

            if (victim.role === "บอดี้การ์ด" && !victim.bodyguardInjured) {
                // บอดี้การ์ดปกป้องตัวเองอัตโนมัติ ครั้งแรกรอด (บาดเจ็บ) ครั้งถัดไปตายจริง
                victim.bodyguardInjured = true;

                sendPrivateChat(room, victim.id, {
                    name: "เกม",
                    text: "คุณถูกโจมตี หากถูกอีกครั้งจะตาย",
                    type: "private",
                    isSystem: true,
                });
                sendPrivateChat(room, caster.id, {
                    name: "เกม",
                    text: `ไม่สามารถฆ่า ${victim.name} ได้`,
                    type: "private",
                    isSystem: true,
                });

                const anonMsg = {
                    name: "เกม",
                    text: `❓ ${victim.name} ถูกฆ่าแต่รอดชีวิตมาได้อย่างน่าประหลาดใจ`,
                    type: "global",
                    isSystem: true,
                };
                pushGlobalChat(room, anonMsg);
                io.to(roomId).emit("chat_message", anonMsg);
                return;
            }

            if (victim.role === "หมาป่าดื้อรั้น" && !victim.stubbornInjured) {
                // หมาป่าดื้อรั้นมี 2 ชีวิต — โดนฆ่าครั้งแรกรอด (บาดเจ็บ) ไม่ตาย
                victim.stubbornInjured = true;

                sendPrivateChat(room, victim.id, {
                    name: "เกม",
                    text: "คุณได้รับบาดเจ็บ หากถูกโจมตีอีกครั้งคุณจะตาย",
                    type: "private",
                    isSystem: true,
                });
                sendPrivateChat(room, caster.id, {
                    name: "เกม",
                    text: `ไม่สามารถฆ่า ${victim.name} ได้`,
                    type: "private",
                    isSystem: true,
                });

                const anonMsg = {
                    name: "เกม",
                    text: `🐺💢 หมาป่าดื้อรั้นถูกโจมตีและได้รับบาดเจ็บ`,
                    type: "global",
                    isSystem: true,
                };
                pushGlobalChat(room, anonMsg);
                io.to(roomId).emit("chat_message", anonMsg);
                return;
            }

            // ทำเครื่องหมายว่าตายด้วยนักเล่นกล เพื่อให้ถ้าห้องเปิดการแสดงบทคนตาย
            // ไอคอนที่มุมขวาล่างจะแสดงเป็น "นักเล่นกล" แทนบทจริง; ถ้าห้องปิด จะไม่แสดงไอคอนบทให้คนอื่น
            victim.illusionDeathReveal = true;
            victim.alive = false;
            allCascadeDeaths.push(...cleanupAfterDeath(room, victim));
            killedVictims.push(victim);
        });

        if (killedVictims.length > 0) {
            const namesText = killedVictims.map((v) => v.name).join(", ");
            const revealMsg = {
                name: "เกม",
                text: killedVictims.length === 1
                    ? `🎭 ${namesText} ติดอยู่ในโลกมายาและเสียชีวิต`
                    : `🎭 ${namesText} ติดอยู่ในโลกมายาและเสียชีวิตพร้อมกัน`,
                type: "global",
                isSystem: true,
                isDeath: true,
            };
            pushGlobalChat(room, revealMsg);
            io.to(roomId).emit("chat_message", revealMsg);
        }

        announceCascadeDeaths(room, roomId, allCascadeDeaths);
        checkGameEndGeneral(room, roomId);
        broadcastRoomUpdate(roomId, room);
    }
    socket.on("illusion_kill_disguised", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performIllusionKillDisguised(room, roomId, getRoomPlayerIdForSocket(room, socket));
    });

    // ----------------------------------------------------------------
    // SEND CHAT
    // ----------------------------------------------------------------
    // SEND CHAT
    // ----------------------------------------------------------------
    socket.on("send_chat", ({ roomId, text, type }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = getRoomPlayerForSocket(room, socket);
        if (!player || !player.alive) return;
        if (typeof text !== "string") return;

        const msg = text.trim();
        if (msg.length === 0 || msg.length > 200) return;

        // WOLF CHAT
        if (type === "wolf") {
            if (!WOLF_ROLES.has(player.role)) return;

            const wolfMsg = { name: player.name, text: msg, type: "wolf" };
            room.wolfChatHistory = room.wolfChatHistory || [];
            room.wolfChatHistory.push(wolfMsg);

            room.players.forEach((p) => {
                if (WOLF_ROLES.has(p.role)) {
                    io.to(p.id).emit("chat_message", wolfMsg);
                }
            });
            io.to(hostRoomName(roomId)).emit("chat_message", wolfMsg); // ส่งให้ทุกจอโฮสต์
            return;
        }

        // INSTIGATOR TEAM CHAT (ความสามารถผู้ยุยง: "ส่งข้อความส่วนตัวให้กับทีมของคุณได้" — ทำงานคล้าย
        // แชทหมาป่า แต่ขอบเขตแคบกว่า จำกัดแค่ผู้ยุยง + ผู้ศรัทธา 2 คนที่ถูกจับคู่ไว้ด้วยกัน (กลุ่มเดียวกัน
        // เช็คจาก p.instigatorGroupId — ตั้งค่าตอนจับคู่ที่เริ่มเกม ดู start_game) เก็บประวัติแยกเป็นราย
        // กลุ่ม (room.instigatorChatHistory[groupId]) เผื่อห้องมีผู้ยุยงมากกว่า 1 คน แต่ละกลุ่มไม่เห็นกัน
        if (type === "instigator") {
            const groupId = player.instigatorGroupId;
            if (!groupId) return; // ไม่ได้อยู่ทีมผู้ยุยงกลุ่มไหนเลย

            const teamMsg = { name: player.name, text: msg, type: "instigator" };
            room.instigatorChatHistory = room.instigatorChatHistory || {};
            room.instigatorChatHistory[groupId] = room.instigatorChatHistory[groupId] || [];
            room.instigatorChatHistory[groupId].push(teamMsg);

            room.players.forEach((p) => {
                if (p.instigatorGroupId === groupId) {
                    io.to(p.id).emit("chat_message", teamMsg);
                }
            });
            io.to(hostRoomName(roomId)).emit("chat_message", teamMsg); // ส่งให้ทุกจอโฮสต์
            return;
        }

        // CULT TEAM CHAT (ความสามารถผู้นำลัทธิ: "ส่งข้อความส่วนตัวถึงสมาชิกลัทธิของคุณได้ในตอนกลางวัน")
        // ต่างจากแชทผู้ยุยงตรงที่ "ใช้ได้เฉพาะตอนกลางวันเท่านั้น" ตามคำอธิบายบทบาทที่ระบุไว้ชัดเจน
        // ขอบเขตกลุ่ม: ผู้นำลัทธิ + สมาชิกทุกคนที่ถูกชักชวนเข้าร่วม (เช็คจาก cultGroupIdOf — ดูด้านบน)
        // เก็บประวัติแยกรายกลุ่ม (room.cultChatHistory[leaderId]) เผื่อห้องมีผู้นำลัทธิมากกว่า 1 คน
        if (type === "cult") {
            if (room.isNight) return; // ใช้ได้เฉพาะตอนกลางวันเท่านั้น
            const groupId = cultGroupIdOf(player);
            if (!groupId) return; // ไม่ได้เป็นผู้นำลัทธิ/สมาชิกลัทธิใดเลย

            const cultMsg = { name: player.name, text: msg, type: "cult" };
            room.cultChatHistory = room.cultChatHistory || {};
            room.cultChatHistory[groupId] = room.cultChatHistory[groupId] || [];
            room.cultChatHistory[groupId].push(cultMsg);

            room.players.forEach((p) => {
                if (cultGroupIdOf(p) === groupId) {
                    io.to(p.id).emit("chat_message", cultMsg);
                }
            });
            io.to(hostRoomName(roomId)).emit("chat_message", cultMsg); // ส่งให้ทุกจอโฮสต์
            return;
        }

        // BANDIT TEAM CHAT (ความสามารถโจร: "ส่งข้อความส่วนตัวถึงผู้สมรู้ร่วมคิดของคุณได้") ต่างจากแชท
        // ลัทธิตรงที่ "พิมพ์ได้เฉพาะหัวโจรเท่านั้น" — ผู้สมรู้ร่วมคิดอยู่ในกลุ่มแชทนี้ได้ (อ่านได้) แต่ห้าม
        // ส่งข้อความเอง (เช็คฝั่งเซิร์ฟเวอร์ตรงนี้ ไม่ใช่แค่ซ่อนปุ่มพิมพ์ฝั่ง client) ใช้ได้ทั้งกลางวัน/
        // กลางคืน (ไม่จำกัดแค่กลางวันเหมือนลัทธิ เพราะคำอธิบายบทบาทไม่ได้ระบุข้อจำกัดนี้ไว้)
        if (type === "bandit") {
            if (player.role !== "โจร") return; // มีแค่หัวโจรเท่านั้นที่พิมพ์ได้ (ผู้สมรู้ร่วมคิดอ่านได้อย่างเดียว)
            const groupId = banditGroupIdOf(player);
            if (!groupId) return;

            const banditMsg = { name: player.name, text: msg, type: "bandit" };
            room.banditChatHistory = room.banditChatHistory || {};
            room.banditChatHistory[groupId] = room.banditChatHistory[groupId] || [];
            room.banditChatHistory[groupId].push(banditMsg);

            room.players.forEach((p) => {
                if (banditGroupIdOf(p) === groupId) {
                    io.to(p.id).emit("chat_message", banditMsg);
                }
            });
            io.to(hostRoomName(roomId)).emit("chat_message", banditMsg); // ส่งให้ทุกจอโฮสต์
            return;
        }

        // GLOBAL CHAT
        if (room.isNight) return;   // กลางคืน: ห้ามส่งแชทรวม
        if (player.silenced) return; // โดนใบ้: ห้ามส่ง

        const globalMsg = { name: player.name, text: msg, type: "global" };
        room.globalChatHistory = room.globalChatHistory || [];
        pushGlobalChat(room, globalMsg);
        io.to(roomId).emit("chat_message", globalMsg);

    });

    // ----------------------------------------------------------------
    // HOST CHAT
    // ----------------------------------------------------------------
    socket.on("host_chat", ({ roomId, text, type }) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;
        if (typeof text !== "string") return;

        const msg = text.trim();
        if (!msg) return;

        if (type === "wolf") {
            const wolfMsg = { name: "HOST", text: msg, type: "wolf", isHost: true };
            room.wolfChatHistory = room.wolfChatHistory || [];
            room.wolfChatHistory.push(wolfMsg);
            room.players.forEach((p) => {
                if (WOLF_ROLES.has(p.role)) {
                    io.to(p.id).emit("chat_message", wolfMsg);
                }
            });
            io.to(hostRoomName(roomId)).emit("chat_message", wolfMsg); // ส่งให้ทุกจอโฮสต์
            return;
        }

        const globalMsg = { name: "HOST", text: msg, type: "global", isHost: true };
        room.globalChatHistory = room.globalChatHistory || [];
        pushGlobalChat(room, globalMsg);
        io.to(roomId).emit("chat_message", globalMsg);
    });

    // ----------------------------------------------------------------
    // TOGGLE WIN CONDITION (โหมดผู้ทดสอบ)
    // ----------------------------------------------------------------
    socket.on("toggle_win_condition", ({ roomId, condition }) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;
        if (!WIN_CONDITIONS.includes(condition)) return;

        room.testerConditions = room.testerConditions ||
            Object.fromEntries(WIN_CONDITIONS.map((k) => [k, true]));
        room.testerConditions[condition] = !room.testerConditions[condition];
        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // SET ALL WIN CONDITIONS (โหมดผู้ทดสอบ) — ปุ่ม "ปิดเงื่อนไขการชนะทั้งหมด" ทีเดียว
    // แทนที่จะต้องไล่กดปิดทีละข้อ 5 ครั้ง — enabled: false = ปิดทุกข้อ, true = เปิดทุกข้อกลับ
    // ----------------------------------------------------------------
    socket.on("set_all_win_conditions", ({ roomId, enabled }) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;

        room.testerConditions = Object.fromEntries(WIN_CONDITIONS.map((k) => [k, !!enabled]));
        broadcastRoomUpdate(roomId, room);
    });

    // ----------------------------------------------------------------
    // CONFIRM CONTINUE — ผู้เล่นกด "ดำเนินการต่อ" หลังเกมจบ
    // ----------------------------------------------------------------
    socket.on("confirm_continue", ({ roomId, stateVersion } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { member: true, alive: false, stateVersion });
        if (!validation.ok) return cb(validation);
        if (!room.gameOver) return cb(roomActionError("GAME_NOT_OVER"));

        const player = getRoomPlayerForSocket(room, socket);
        if (!player || player.isHost) return cb(roomActionError("NOT_IN_ROOM"));

        room.continueReady = room.continueReady || {};
        room.continueReady[socket.id] = true;
        broadcastRoomUpdate(roomId, room, { timelineType: "continue_confirmed", source: "player" });
        cb({ ok: true, stateVersion: room.stateVersion, membershipId: String(player.membershipId || "") });
    });

    // ----------------------------------------------------------------
    // ADMIN ROOM INSPECTOR — snapshot สำหรับแอดมินเท่านั้น
    // รายการห้องใช้ข้อมูล summary สำหรับการ์ด/ตัวกรอง แต่ Inspector ต้องเห็นบริบทเกมจริง
    // โดยไม่ใช้ room object ตรง ๆ เพราะข้างในมี password, token, socket id และ private state
    // ที่ไม่ควรส่งออกทั้งหมด แม้ผู้เรียกจะเป็นแอดมินก็ตาม
    function buildAdminRoomDetail(room) {
        const roomPlayers = Array.isArray(room?.players) ? room.players : [];
        const host = roomPlayers.find((p) => p?.isHost) || null;
        const slotBySocketId = new Map(roomPlayers.map((p, index) => [String(p?.id || ""), index + 1]));
        const resolveTarget = (targetId) => {
            const id = String(targetId || "");
            if (!id) return null;
            const player = roomPlayers.find((p) => String(p?.id || "") === id);
            if (!player) return null;
            return { slot: slotBySocketId.get(id) || 0, name: String(player.name || "-"), isBot: !!player.isBot, isHost: !!player.isHost };
        };
        const selectedTargets = room.selectedTargets && typeof room.selectedTargets === "object" ? room.selectedTargets : {};
        const votes = room.votes && typeof room.votes === "object" ? room.votes : {};
        const shieldTargets = room.shieldTargets && typeof room.shieldTargets === "object" ? room.shieldTargets : {};
        const wolfKillVotes = room.wolfKillVotes && typeof room.wolfKillVotes === "object" ? room.wolfKillVotes : {};
        const banditKillVotes = room.banditKillVotes && typeof room.banditKillVotes === "object" ? room.banditKillVotes : {};
        const safePlayers = roomPlayers.map((p, index) => ({
            slot: index + 1,
            name: String(p?.name || "-"),
            isHost: !!p?.isHost,
            isBot: !!p?.isBot,
            isTester: !!p?.isTester,
            
            alive: p?.alive !== false,
            killed: !!p?.killed,
            protected: !!p?.protected,
            connected: !!p?.isHost ? (Array.isArray(room.hostIds) && room.hostIds.some((id) => !!io.sockets.sockets.get(id)?.connected)) : isPlayerCurrentlyConnected(p),
            disconnected: !!p?.disconnected,
            role: room.started && !p?.isHost ? String(p?.role || "") : "",
            displayRole: room.started && !p?.isHost ? String(p?.displayRole || p?.role || "") : "",
            originalRole: room.started && !p?.isHost ? String(p?.originalRole || p?.role || "") : "",
            selectedTarget: resolveTarget(selectedTargets[String(p?.id || "")]),
            voteTarget: resolveTarget(votes[String(p?.id || "")]),
            shieldTarget: resolveTarget(shieldTargets[String(p?.id || "")]),
            wolfKillTarget: resolveTarget(wolfKillVotes[String(p?.id || "")]),
            banditKillTarget: resolveTarget(banditKillVotes[String(p?.id || "")]),
        }));

        const alivePlayers = safePlayers.filter((p) => !p.isHost && p.alive);
        const realPlayers = safePlayers.filter((p) => !p.isHost && !p.isBot);
        const bots = safePlayers.filter((p) => p.isBot);
        const phase = room.gameOver ? "game_over" : !room.started ? "waiting" : room.isNight ? "night" : (room.voteMode ? "day_vote" : "day");
        const rawResult = room.gameResult && typeof room.gameResult === "object" ? room.gameResult : null;
        const winnerIds = Array.isArray(rawResult?.winners) ? rawResult.winners.map((x) => String(x?.id || "")) : [];
        const result = rawResult ? {
            team: rawResult.team ? String(rawResult.team) : "",
            label: rawResult.label ? String(rawResult.label) : "",
            title: rawResult.title ? String(rawResult.title) : "",
            winners: winnerIds.map((id) => resolveTarget(id)).filter(Boolean),
        } : null;

        ensureRoomRuntimeState(room);
        return {
            roomId: String(room.id || "").toUpperCase(),
            stateVersion: room.stateVersion,
            stateChangedAt: room.stateChangedAt,
            timeline: publicTimeline(room, 60),
            isTesterRoom: !!room.isTesterRoom,
            testerHostSlot: Number(room.testerHostSlot || 0),
            isClosing: !!room.isClosing,
            createdAt: room.createdAt || null,
            startedAt: room.startedAt || null,
            gameRoundId: room.gameRoundId || null,
            started: !!room.started,
            gameOver: !!room.gameOver,
            phase,
            nightCount: Number(room.nightCount || 0),
            dayCount: Number(room.dayCount || 0),
            isNight: !!room.isNight,
            voteMode: !!room.voteMode,
            voteDeadline: room.voteDeadline || null,
            host: host ? { slot: slotBySocketId.get(String(host.id || "")) || 1, name: String(host.name || "-"), connected: Array.isArray(room.hostIds) && room.hostIds.some((id) => !!io.sockets.sockets.get(id)?.connected) } : null,
            counts: { players: realPlayers.length, totalPlayers: alivePlayers.length, bots: bots.length, connected: safePlayers.filter((p) => !p.isHost && p.connected).length, alive: alivePlayers.length, maxPlayers: Number(room.maxPlayers || 0) },
            settings: {
                hasHostPassword: !!room.hostPassword,
                hasJoinCode: !!room.joinCode,
                maxPlayers: Number(room.maxPlayers || 0),
                revealDeadRole: room.revealDeadRole !== false,
                voteTimerEnabled: room.voteTimerEnabled !== false,
                testerConditions: room.isTesterRoom && room.testerConditions && typeof room.testerConditions === "object" ? { ...room.testerConditions } : {},
                roleConfig: room.config && typeof room.config === "object" ? { ...room.config } : {},
            },
            gameResult: result,
            players: safePlayers,
            serverTime: new Date().toISOString(),
        };
    }

    socket.on("admin_list_rooms", (cb) => {
        if (typeof cb !== "function") cb=()=>{};
        const list=Object.values(rooms).map((r)=>{
            ensureRoomRuntimeState(r);
            const players = Array.isArray(r.players) ? r.players : [];
            const realPlayers = players.filter((p) => !p?.isHost && !p?.isBot);
            const bots = players.filter((p) => !!p?.isBot);
            const connectedRealPlayers = realPlayers.filter((p) => isPlayerCurrentlyConnected(p));
            return {
                roomId:r.id,
                isTester:!!r.isTesterRoom,
                started:!!r.started,
                gameOver:!!r.gameOver,
                hostName:players.find(p=>p?.isHost)?.name||"-",
                hostSlot:r.testerHostSlot||0,
                players:players.filter(p=>!p?.isHost).length,
                totalPlayers:realPlayers.length,
                connectedPlayers:connectedRealPlayers.length,
                bots:bots.length,
                connectedBots:bots.filter((p) => isPlayerCurrentlyConnected(p)).length,
                maxPlayers:r.maxPlayers||0,
                createdAt:r.createdAt||null,
                startedAt:r.startedAt||null,
                phase:r.gameOver ? "game_over" : !r.started ? "waiting" : r.isNight ? "night" : (r.voteMode ? "day_vote" : "day"),
                livePlayers:realPlayers.map((p)=>({
                    name:String(p?.name||"ผู้เล่น"),
                    connected:isPlayerCurrentlyConnected(p),
                    alive:p?.alive !== false,
                    isTester:!!p?.isTester,
                })),
            };
        });
        list.sort((a,b)=>String(a.roomId).localeCompare(String(b.roomId)));
        const livePlayers = list.flatMap((room) => room.livePlayers.map((player) => ({ ...player, roomId: room.roomId, started: room.started, phase: room.phase })));
        const humansConnected = livePlayers.filter((p) => p.connected && !p.isTester).length;
        const humansPlaying = livePlayers.filter((p) => !p.isTester).length;
        const activeRooms = list.filter((r) => !r.gameOver);
        const playingRooms = activeRooms.filter((r) => r.started);
        cb({
            ok:true,
            rooms:list,
            presence:{
                openRooms:activeRooms.length,
                playingRooms:playingRooms.length,
                humansPlaying,
                humansConnected,
                updatedAt:Date.now(),
                players:livePlayers.filter((p) => !p.isTester),
            },
        });
    });

    socket.on("admin_get_room_detail", async ({ roomId } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const id = String(roomId || "").trim().toUpperCase();
        if (!id) return cb({ ok:false, code:"ROOM_NOT_FOUND", error:"room_not_found" });
        let room = rooms[id];
        if (!room) {
            try {
                room = await recoverPersistedRoomById(id, { reason: "admin_room_inspector" });
            } catch (e) {
                recordDiagnostic({ source:"server", kind:"admin_room_detail_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", context:{ roomId:id, code:"SERVER_ERROR" } });
                return cb({ ok:false, code:"SERVER_ERROR", error:"room_detail_unavailable" });
            }
        }
        if (!room) return cb({ ok:false, code:"ROOM_NOT_FOUND", error:"room_not_found" });
        try {
            cb({ ok:true, room:buildAdminRoomDetail(room) });
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_room_detail_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", context:{ roomId:id, code:"SERIALIZE_FAILED" } });
            cb({ ok:false, code:"SERVER_ERROR", error:"room_detail_unavailable" });
        }
    });

    socket.on("admin_close_room", async ({roomId}={}, cb) => {
        if (typeof cb !== "function") cb=()=>{};
        const id=String(roomId||"").toUpperCase();
        if(!rooms[id]) return cb({error:"room_not_found",code:"ROOM_NOT_FOUND"});
        try { await closeRoomNow(id,"admin_closed"); cb({ok:true,roomId:id}); }
        catch(e){ recordDiagnostic({source:"server",kind:"admin_close_room_failed",page:"admin",message:e?.message||String(e),stack:e?.stack||""}); cb({error:e.message||"close_failed",code:"CLOSE_FAILED"}); }
    });

    // ----------------------------------------------------------------
    // ADD BOT (โหมดผู้ทดสอบ) — เพิ่มผู้เล่นปลอมเข้าห้องเพื่อให้แจกบทได้ครบตามจำนวน
    // บอทเป็น "ผู้เล่นจริง" ในสายตา server ทุกจุด (นับใน realPlayers, รับบทได้ปกติ)
    // เพียงแต่ยังไม่มี socket จริงผูกอยู่จนกว่าโฮสต์จะกด "เข้าสิง" (ดู client: ป๊อปอัป
    // iframe ของ player.html ที่ join_room ด้วย token ของบอทนี้ → กลายเป็น reconnect ปกติ
    // ทุกอย่างจึงใช้ path เดิมของผู้เล่นจริงหมด ไม่ต้องเขียน proxy การกระทำแยกเลย)
    // ----------------------------------------------------------------
    socket.on("host_add_bot", (payload, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const roomId = typeof payload === "object" ? payload?.roomId : payload;
        const requestedStateVersion = typeof payload === "object" ? payload?.stateVersion : undefined;
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { host: true, member: false, notStarted: true, stateVersion: requestedStateVersion });
        if (!validation.ok) return cb({ ...validation, error: validation.code === "NOT_HOST" ? "not host" : validation.code });

        // กันเพิ่มบอทหลังเกมเริ่มไปแล้ว — start_game แจกบทบาทให้ realPlayers ทุกคนแค่ครั้งเดียว
        // ตอนกดเริ่มเกมเท่านั้น บอทที่เพิ่งถูกเพิ่มเข้ามาทีหลังจะค้าง role: null ไปตลอดเกม ทำให้
        // checkGameEndGeneral (teamOf(null)) ไม่นับบอทตัวนี้เป็นทั้งหมาป่า/ชาวบ้าน/โซโล่เลย
        // เงื่อนไขจบเกมคลาดเคลื่อนได้ และการ์ดของบอทจะไม่มีบทบาทค้างอยู่ในกริดตลอดเกม
        if (room.started) return cb && cb({ error: "started", code: "ROOM_STARTED" });

        // ใช้ "จำนวนบอทที่เหลืออยู่ตอนนี้ + 1" เป็นเลขบอทใหม่ — ปลอดภัยจากเลขซ้ำได้แล้ว เพราะ
        // ตอนเตะบอทตัวไหนออก จะมีการเรียงเลขบอทที่เหลือใหม่ให้ไม่มีช่องว่างเสมอ (ดู renumberBots
        // ที่เรียกใน kick_player) ต่างจากเดิมที่ใช้ตัวนับเพิ่มขึ้นเรื่อยๆ ไม่ยอมลด เพราะตอนนั้นบอท
        // ที่เหลือหลังเตะยังมีช่องว่างค้างอยู่ ถ้านับจากจำนวนที่เหลือตรงๆ จะซ้ำกับบอทตัวที่ยังอยู่
        const botNumber = room.players.filter((p) => p.isBot).length + 1;
        if (!room.isTesterRoom) return cb && cb({ error: "tester room required", code: "TESTER_ROOM_REQUIRED" });

        const bot = {
            id: genId(),
            token: genId() + genId(),
            name: `🤖 บอท ${botNumber}`,
            isHost: false,
            isBot: true,
            isTester: true,
            testerPlayerSlot: 0,
            testerSessionId: "",
            role: null,
            displayRole: null,
            alive: true,
            protected: false,
            killed: false,
        };
        room.players.push(bot);

        broadcastRoomUpdate(roomId, room);
        cb && cb({ ok: true, id: bot.id, token: bot.token, name: bot.name });
    });

    // RELEASE BOT — โฮสต์กด "กลับหน้าโฮสต์"    // RELEASE BOT — โฮสต์กด "กลับหน้าโฮสต์" จากในจอที่กำลังสิงบอทอยู่ เพื่อคืนสถานะให้บอท
    // กลับไป "ว่าง" ทันที แทนที่จะปล่อยให้เข้า flow หลุดการเชื่อมต่อปกติซึ่งมี grace period
    // ยาว (5-10 นาที) กว่าจะเปลี่ยนสถานะ — ตัวนี้เคลียร์ทันทีไม่ต้องรอ ปลอดภัยเพราะเช็คว่า
    // ต้องเป็น isBot เท่านั้นถึงจะยอมให้ปล่อยแบบนี้ (กันผู้เล่นจริงเผลอเรียก event นี้)
    // ----------------------------------------------------------------
    socket.on("release_bot", ({ roomId, token } = {}, cb) => {
        const reply = (payload) => {
            if (typeof cb === "function") {
                try { cb(payload); } catch (e) {}
            }
        };

        if (!roomId || !token) {
            reply({ ok: false, error: "invalid_request" });
            return;
        }
        roomId = String(roomId).toUpperCase();
        const room = rooms[roomId];
        if (!room) {
            // ห้องปิดไปแล้วก็ถือว่า session นี้จบเรียบร้อย — client ปิดแท็บได้
            reply({ ok: true, alreadyClosed: true });
            return;
        }

        // ต้องเป็น socket ปัจจุบันที่ถือ token ของบอทตัวนั้นอยู่จริงเท่านั้น
        // token เดียวกันเป็น credential สำหรับ reconnect แต่ไม่อนุญาตให้ socket อื่นในห้อง
        // เรียก release แทนผู้เข้าสิงคนปัจจุบัน
        const bot = room.players.find((p) => p.token === token && p.isBot);
        if (!bot) {
            reply({ ok: true, alreadyReleased: true });
            return;
        }
        if (bot.id !== socket.id) {
            reply({ ok: false, error: "not_bot_controller" });
            return;
        }

        // เคลียร์ timer ค้างของ token นี้ (ถ้ามี) กันซ้อนกับ flow disconnect ปกติที่กำลังจะตามมา
        if (pendingIndicators[bot.token]) {
            clearTimeout(pendingIndicators[bot.token]);
            delete pendingIndicators[bot.token];
        }
        if (pendingRemovals[bot.token]) {
            clearTimeout(pendingRemovals[bot.token].timer);
            delete pendingRemovals[bot.token];
        }

        bot.disconnected = false;
        bot.offline = true; // "ว่าง พร้อมให้เข้าสิงใหม่" — ไม่ใช่สถานะ error/หลุดจริง
        releasedBotSockets.add(socket.id);

        socket.leave(roomId);
        broadcastRoomUpdate(roomId, room);
        schedulePersistRoom(roomId);
        broadcastSuggestedRoom();
        reply({ ok: true });
    });

    // ----------------------------------------------------------------
    // KICK PLAYER
    // ----------------------------------------------------------------
    socket.on("kick_player", async ({ roomId, playerId }) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;

        const player = room.players.find((p) => p.id === playerId);
        if (!player) return;

        io.to(playerId).emit("kicked");

        // ยกเลิก pending removal / pending indicator ที่มีอยู่
        if (pendingRemovals[player.token]) {
            clearTimeout(pendingRemovals[player.token].timer);
            delete pendingRemovals[player.token];
        }
        if (pendingIndicators[player.token]) {
            clearTimeout(pendingIndicators[player.token]);
            delete pendingIndicators[player.token];
        }

        // ล้าง targets/votes/shield ที่เกี่ยวกับผู้เล่นนี้
        const cleanMap = (map) => {
            if (!map) return;
            Object.keys(map).forEach((sid) => {
                if (map[sid] === playerId) delete map[sid];
            });
            delete map[playerId];
        };
        cleanMap(room.selectedTargets);
        cleanMap(room.shieldTargets);
        cleanMap(room.curseTargets);
        cleanMap(room.votes);
        cleanMap(room.wolfKillVotes);
        cleanMap(room.banditKillVotes);

        // ล้าง banditActions (การเลือกของหัวโจรที่ "เลือกไว้ก่อน" — ดู performBanditAction) ที่เกี่ยวกับผู้เล่นนี้
        if (room.banditActions) {
            delete room.banditActions[playerId];
            Object.entries(room.banditActions).forEach(([leaderId, action]) => {
                if (action && action.targetId === playerId) delete room.banditActions[leaderId];
            });
        }

        // ล้าง murdererKillVote ถ้าเกี่ยวกับผู้เล่นนี้
        if (room.murdererKillVote &&
            (room.murdererKillVote.voterId === playerId || room.murdererKillVote.targetId === playerId)) {
            room.murdererKillVote = null;
        }

        // ถอด protected ถ้า player นี้เป็น protector
        const protectRoles = new Set(["หมอ", "บอดี้การ์ด"]);
        if (protectRoles.has(player.role) && room.selectedTargets) {
            const prevTargetId = room.selectedTargets[playerId];
            if (prevTargetId) {
                const prevTarget = room.players.find((p) => p.id === prevTargetId);
                if (prevTarget) prevTarget.protected = false;
            }
        }

        room.players = room.players.filter((p) => p.id !== playerId);

        if (room.players.length === 0) {
            if (ROOM_PERSISTENCE_ENABLED) { try { await deletePersistedRoom(roomId); } catch (e) { console.error(`[room-persist] ลบ snapshot ห้อง ${roomId} ไม่สำเร็จ:`, e.name, e.message); } }
            delete rooms[roomId];
            clearGameOverTimer(roomId);
            clearVoteTimer(roomId);
        } else {
            renumberBots(room); // ปิดช่องว่างเลขบอท เผื่อตัวที่เตะไปเป็นบอท (ดูฟังก์ชันด้านบน)
            checkGameEndGeneral(room, roomId);
            broadcastRoomUpdate(roomId, room);
        }

        broadcastSuggestedRoom();
    });

    // ----------------------------------------------------------------
    // LEAVE ROOM (ผู้เล่นกดย้อนกลับเบราว์เซอร์แล้วยืนยันออกจากห้องเอง ระหว่างที่เกมยังไม่เริ่ม
    // — ดู leaveRoomViaBack()/popstate handler ฝั่ง player.main.js) ต่างจาก kick_player ตรงที่ผู้เล่น
    // เป็นคนสั่งออกเอง ไม่ใช่โฮสต์เตะ จึงหา player จาก socket.id+token ของผู้ส่งเอง ไม่รับ playerId
    // จาก client เพื่อกันผู้เล่นสั่งเตะคนอื่นออกแทนตัวเอง จำกัดไว้แค่ตอนห้องยังไม่เริ่มเกมเท่านั้น
    // (ตรงกับขอบเขตของฟีเจอร์ฝั่ง client — ถ้าเกมเริ่มไปแล้ว client จะไม่ยิง event นี้มาอยู่แล้ว
    // แต่เช็คซ้ำไว้ฝั่งเซิร์ฟเวอร์ด้วยกันกรณี client bug/แก้โค้ดฝั่งหน้าเว็บเอง)
    socket.on("leave_room", async ({ roomId, token } = {}, cb) => {
        const room = rooms[roomId];
        if (!room) return cb && cb({ ok: true });
        if (room.started) return cb && cb({ error: "started", code: "ROOM_STARTED" });

        const roomMembershipId = String(socket.data?.membershipId || "").trim();
        const suppliedToken = String(token || "");
        const player = (roomMembershipId
            ? room.players.find((p) => p && !p.isHost && String(p.membershipId || "").trim() === roomMembershipId && (!suppliedToken || p.token === suppliedToken))
            : null)
            || room.players.find((p) => p && !p.isHost && p.id === socket.id && (!suppliedToken || p.token === suppliedToken));
        if (!player || player.isHost) return cb && cb({ ok: true });

        // ยกเลิก pending removal / pending indicator ที่มีอยู่ (เหมือน kick_player)
        if (pendingRemovals[player.token]) {
            clearTimeout(pendingRemovals[player.token].timer);
            delete pendingRemovals[player.token];
        }
        if (pendingIndicators[player.token]) {
            clearTimeout(pendingIndicators[player.token]);
            delete pendingIndicators[player.token];
        }

        // ล้าง targets/votes ที่อาจเกี่ยวกับผู้เล่นนี้ (ปกติยังไม่มีเพราะเกมยังไม่เริ่ม แต่กันไว้เผื่อไว้)
        const cleanMap = (map) => {
            if (!map) return;
            Object.keys(map).forEach((sid) => {
                if (map[sid] === player.id) delete map[sid];
            });
            delete map[player.id];
        };
        cleanMap(room.selectedTargets);
        cleanMap(room.shieldTargets);
        cleanMap(room.curseTargets);
        cleanMap(room.votes);
        cleanMap(room.wolfKillVotes);
        cleanMap(room.banditKillVotes);

        room.players = room.players.filter((p) => p !== player && String(p.membershipId || "") !== String(player.membershipId || ""));

        if (room.players.length === 0) {
            if (ROOM_PERSISTENCE_ENABLED) { try { await deletePersistedRoom(roomId); } catch (e) { console.error(`[room-persist] ลบ snapshot ห้อง ${roomId} ไม่สำเร็จ:`, e.name, e.message); } }
            delete rooms[roomId];
            clearGameOverTimer(roomId);
            clearVoteTimer(roomId);
        } else {
            renumberBots(room);
            broadcastRoomUpdate(roomId, room, { timelineType: "player_left", source: "player" });
            schedulePersistRoom(roomId, true);
        }

        broadcastSuggestedRoom();
        cb && cb({ ok: true });
    });

    // ----------------------------------------------------------------
    // RESTART ROOM (โฮสต์กดปุ่ม "🔄 เริ่มต้นใหม่" — ยกเลิกเกมปัจจุบันทั้งหมด
    // แล้วเรียกบท/สถานะทุกอย่างคืนจากผู้เล่นทันที ไม่ต้องรอเกมจบเองหรือรอ
    // "ดำเนินการต่อ" ครบทุกคนก่อนเหมือน start_game — ใช้ได้ทุกเมื่อแม้เกมกำลังเล่นอยู่
    // จากนั้นห้องจะกลับไปอยู่สถานะ "รอโฮสต์ตั้งค่าบทบาทแล้วกดเริ่มเกม" เหมือนตอนสร้างห้องใหม่
    // ----------------------------------------------------------------
    socket.on("restart_room", (payload, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const roomId = typeof payload === "object" ? payload?.roomId : payload;
        const requestedStateVersion = typeof payload === "object" ? payload?.stateVersion : undefined;
        const room = rooms[roomId];
        const validation = validateRoomAction(socket, room, { host: true, member: false, stateVersion: requestedStateVersion });
        if (!validation.ok) return cb(validation);

        clearGameOverTimer(roomId);
        clearVoteTimer(roomId);

        const realPlayers = room.players.filter((p) => !p.isHost);

        // เรียกบทคืนจากผู้เล่นทุกคน + ล้างสถานะรอบเก่าทั้งหมด (เหมือนใน start_game)
        realPlayers.forEach(resetPlayerRoundState);

        Object.assign(room, {
            started: false,
            gameRoundId: null,
            votes: {},
            selectedTargets: {},
            shieldTargets: {},
            curseTargets: {},
            wolfKillVotes: {},
            banditKillVotes: {},
            murdererKillVote: null,
            wolfChatHistory: [],
            globalChatHistory: [],
            // แก้บั๊กเดียวกับใน start_game: จุดนี้เดิมล้างแค่ wolfChatHistory/globalChatHistory
            // ไม่ได้ล้าง instigatorChatHistory (แชททีมยุยงของเกมก่อน) และไม่ได้ล้าง privateChatLog /
            // hostPrivateChatLog (ข้อความ private ต่อผู้เล่น/โฮสต์ เช่น "คุณตกหลุมรักกับ...") เลย
            // ทำให้กด "🔄 เริ่มต้นใหม่" แล้วข้อความ private ของเกมที่แล้วยังไม่หายไปจริง จะโผล่กลับมา
            // ปนกับเกมใหม่ทันทีที่มีใคร reconnect/request_sync ครั้งถัดไป (ดูคอมเมนต์ pushGlobalChat/
            // mergedGlobalAndPrivateHistory ด้านบน) — ล้างให้ครบเหมือน start_game ทุกจุด
            instigatorChatHistory: {},
            privateChatLog: {},
            hostPrivateChatLog: [],
            chatSeq: 0,
            nightCount: 0,
            dayCount: 0,
            isNight: false,
            voteMode: false,
            gameOver: false,
            gameResult: null,
            continueReady: {},
        });

        // แจ้งผู้เล่นแต่ละคนให้เคลียร์บทของตัวเองทันที (เผื่อ client บางจอไม่ได้ดักจาก
        // room_update อย่างเดียว) — ส่ง role เป็น null ชัดเจนแทนไม่ส่งอะไรเลย (p ผ่าน
        // resetPlayerRoundState() มาแล้วด้านบน จึงเป็นค่าว่าง/0 ครบทุก field อยู่แล้ว)
        realPlayers.forEach((p) => {
            io.to(p.id).emit("your_role", buildYourRolePayload(p, { silent: true }, room));
        });

        const msg = {
            name: "เกม",
            text: "🔄 โฮสต์เริ่มห้องใหม่ทั้งหมด — บทเก่าถูกเรียกคืนแล้ว รอโฮสต์ตั้งค่าบทบาทและกด \"เริ่มเกม\" รอบใหม่",
            type: "global",
            isSystem: true,
        };
        pushGlobalChat(room, msg);
        io.to(roomId).emit("chat_message", msg);

        // ติดธง justReset ชั่วคราวแนบไปกับ room_update รอบนี้รอบเดียว (เหมือนแพทเทิร์น justStarted
        // ใน start_game) เพื่อให้ client "ทุกจอที่กำลังเปิดอยู่ตอนนี้" (ผู้เล่นทุกคน + จอโฮสต์ทุกจอ ไม่ใช่
        // แค่จอที่กดปุ่ม) เคลียร์กล่องแชทเก่าที่ค้าง render อยู่ในหน้าจอทิ้งทันที ไม่ต้องรอ reconnect/
        // request_sync รอบถัดไปถึงจะเห็นกล่องแชทว่างจริงๆ — แก้บั๊ก: เดิมข้อความเกมที่แล้วยังค้างโชว์อยู่
        // ในกล่องแชทที่เปิดค้างไว้ แม้ข้อมูลฝั่งเซิร์ฟเวอร์จะถูกล้างไปแล้วก็ตาม
        room.justReset = true;
        broadcastRoomUpdate(roomId, room, { timelineType: "room_reset", source: "host" });
        room.justReset = false; // ล้างทันทีหลังส่ง ไม่ให้ room_update รอบถัดไปเคลียร์กล่องแชทซ้ำ

        broadcastSuggestedRoom();
        cb({ ok: true, stateVersion: room.stateVersion });
    });

    // ----------------------------------------------------------------
    // CLOSE ROOM (โฮสต์กดปุ่มปิดห้องเอง)
    // ----------------------------------------------------------------
    socket.on("close_room", async (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;
        await closeRoomNow(roomId, "host_closed");
    });

    // ----------------------------------------------------------------
    // DISCONNECT
    // ----------------------------------------------------------------
    socket.on("disconnect", async () => {
        // ----- จอโฮสต์ (รองรับหลายจอพร้อมกัน) -----
        // เอา socket ที่หลุดออกจากชุดจอโฮสต์ของห้องนั้น แล้วค่อยเช็คว่ายังเหลือ
        // จอโฮสต์อื่นเชื่อมต่ออยู่ไหม — ถ้ายังมีอย่างน้อย 1 จอ ไม่ต้องขึ้นสถานะ "หลุด"
        // เลย เพราะโฮสต์ยังคุมห้องได้ปกติจากจอที่เหลือ (แก้บั๊กเดิมที่จอสองหลุด/reload
        // แล้วห้องขึ้นสถานะโฮสต์ออฟไลน์ทั้งที่จออีกจอยังใช้งานได้อยู่)
        const hostRoomId = hostSocketRooms[socket.id];
        if (hostRoomId) {
            const room = rooms[hostRoomId];
            const hostPlayerForDisconnect = room?.players?.find((p) => p && p.isHost && p.id === socket.id);
            if (hostPlayerForDisconnect) rememberSocketDisconnect('host', hostRoomId, hostPlayerForDisconnect.token, socket.id);
            const stillHasHostScreen = removeHostSocket(room, socket.id);
            if (room) {
                touchRoomActivity(room);
                const hostPlayer = room.players.find((p) => p.isHost);
                if (hostPlayer && !stillHasHostScreen) {
                    hostPlayer.disconnected = true;
                }
                broadcastRoomUpdate(hostRoomId, room);
                schedulePersistRoom(hostRoomId);
            }
            broadcastSuggestedRoom();
        }

        for (const id in rooms) {
            const room = rooms[id];
            const player = getRoomPlayerForSocket(room, socket);
            if (!player || player.isHost) continue; // โฮสต์ถูกจัดการไปแล้วด้านบน
            if (!player.isBot) touchRoomActivity(room);
            rememberSocketDisconnect('player', id, player.token, socket.id);
            // Tester player เป็น session ชั่วคราว: ถ้ายังไม่เริ่มเกมและแท็บถูกปิดจริง ให้เอาออกจากห้องทันที
            // เพื่อคืนเลข Player ที่ว่าง ไม่ปล่อยชื่อ 1/2/3 ค้างเพราะ RECONNECT_GRACE ของผู้เล่นปกติ
            if (player.isTester && !player.isBot && !room.started) {
                if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
                if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token]); delete pendingIndicators[player.token]; }
                room.players = room.players.filter((p) => p.id !== player.id);
                broadcastRoomUpdate(id, room);
                if (room.players.length > 0) schedulePersistRoom(id, true);
                if (room.players.length === 0 && room.isTesterRoom) {
                    if (ROOM_PERSISTENCE_ENABLED) { try { await deletePersistedRoom(id); } catch (e) { console.error(`[room-persist] ลบ snapshot ห้อง ${id} ไม่สำเร็จ:`, e?.name || "Error", e?.message || e); } }
                    delete rooms[id];
                }
                broadcastSuggestedRoom();
                continue;
            }

            // release_bot ตั้งใจตัด socket เองหลัง ACK แล้ว — อย่าเอา flow disconnect ปกติ
            // มาทับสถานะ "บอทว่าง" ด้วย timer 5/10 นาทีอีกครั้ง
            if (player.isBot && releasedBotSockets.has(socket.id)) {
                releasedBotSockets.delete(socket.id);
                player.disconnected = false;
                player.offline = true;
                continue;
            }

            // ผู้เล่นทั่วไป: อย่าเพิ่งขึ้นสถานะ "🟡 กำลังเชื่อมต่อ..." ทันที
            // รอเงียบๆ ก่อนสักพัก (DISCONNECT_INDICATOR_DELAY_MS) เผื่อแค่ปิดจอประหยัดแบต/
            // สลับแอปแป๊บเดียวแล้วต่อกลับเองไว — ถ้าต่อกลับทันจะไม่มีใครเห็นสถานะหลุดเลยแม้แต่แวบเดียว
            if (pendingIndicators[player.token]) {
                clearTimeout(pendingIndicators[player.token]);
            }
            pendingIndicators[player.token] = setTimeout(() => {
                delete pendingIndicators[player.token];

                const stillRoom = rooms[id];
                if (!stillRoom) return;

                const stillPlayer = stillRoom.players.find((p) => p.token === player.token);
                if (!stillPlayer || isPlayerCurrentlyConnected(stillPlayer)) return; // ต่อกลับไปแล้วจริง

                stillPlayer.disconnected = true;
                broadcastRoomUpdate(id, stillRoom);
                schedulePersistRoom(id);
                broadcastSuggestedRoom();
            }, DISCONNECT_INDICATOR_DELAY_MS);

            // แล้วค่อยรอต่ออีกยาวๆ (RECONNECT_GRACE_MS รวมทั้งหมด) ก่อนเปลี่ยนเป็น
            // "⚫ ออฟไลน์" (ไม่ลบกริด แค่เปลี่ยนสถานะที่โชว์)
            if (pendingRemovals[player.token]) {
                clearTimeout(pendingRemovals[player.token].timer);
            }

            pendingRemovals[player.token] = {
                roomId: id,
                timer: setTimeout(() => {
                    delete pendingRemovals[player.token];

                    const stillRoom = rooms[id];
                    if (!stillRoom) return;

                    const stillPlayer = stillRoom.players.find((p) => p.token === player.token);
                    if (!stillPlayer || isPlayerCurrentlyConnected(stillPlayer)) return; // ต่อกลับไปแล้วจริง

                    stillPlayer.disconnected = false;
                    stillPlayer.offline = true;
                    broadcastRoomUpdate(id, stillRoom);
                    broadcastSuggestedRoom();
                }, RECONNECT_GRACE_MS),
            };
        }

        broadcastSuggestedRoom();
    });
});

// A single server sweep owns room expiry. Never refresh from a game/bot timer.
const roomIdleSweepTimer = setInterval(() => {
    if (!appBootReady || appDraining || resetInProgress) return;
    const now = Date.now();
    for (const [id, room] of Object.entries(rooms)) {
        if (!room || room.isClosing) continue;
        if (ROOM_PERSISTENCE_ENABLED && !isTesterRoom(room) && !roomLeaseOwnedLocally(id)) continue;
        initializeRoomActivity(room, now);
        if (hasLiveRoomMember(room, io.sockets.sockets)) {
            if (now - room.lastRoomActivityAt >= ROOM_PRESENCE_REFRESH_MS) {
                touchRoomActivity(room, now);
                // Advance the durable revision without filling the gameplay timeline with heartbeats.
                ensureRoomRuntimeState(room);
                room.stateVersion += 1;
                room.heartbeatStateVersion = room.stateVersion;
                emitRoomUpdateToRoom(id, room);
            }
        } else if (roomIdleExpired(room, io.sockets.sockets, now)) {
            closeRoomNow(id, "idle_timeout").catch((err) => console.error("[room-idle] close failed", id, err?.message));
        }
    }
}, 5_000);
roomIdleSweepTimer.unref?.();

// ============================================================
// HTTP_ERROR_MIDDLEWARE_V15: จับ exception ที่หลุดจาก Express route ให้มี trace/request/location ก่อนตอบ 500
app.use(function HTTP_ERROR_MIDDLEWARE_V15(err, req, res, next) {
    if (res.headersSent) return next(err);
    const ctx = {}; 
    const isEntityTooLarge = err?.type === "entity.too.large" || err?.status === 413 || err?.statusCode === 413;
    const status = isEntityTooLarge ? 413 : 500;
    const code = isEntityTooLarge ? "REQUEST_ENTITY_TOO_LARGE" : "INTERNAL_SERVER_ERROR";

    res.status(status).json({
            error: isEntityTooLarge ? "request_entity_too_large" : "internal_server_error",
            code,
            requestId: ctx.requestId || ""
    });


});



const HTTP_PORT = Number(process.env.PORT) || 3000;
const SHUTDOWN_GRACE_MS = Math.max(10_000, Number(process.env.SHUTDOWN_GRACE_MS) || 30_000);
const SHUTDOWN_ROOM_PERSIST_TIMEOUT_MS = Math.max(1_000, Math.min(20_000, Number(process.env.SHUTDOWN_ROOM_PERSIST_TIMEOUT_MS) || 10_000));
const SHUTDOWN_ROOM_PERSIST_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.SHUTDOWN_ROOM_PERSIST_CONCURRENCY) || 2));
let shutdownStarted = false;

async function waitForSocketDrain(maxMs = 2_500) {
    const startedAt = Date.now();
    while (io?.sockets?.sockets?.size > 0) {
        if (Date.now() - startedAt >= maxMs) return false;
        await sleepMs(25);
    }
    return true;
}

async function flushRoomPersistenceForShutdown(reason = "shutdown") {
    if (!ROOM_PERSISTENCE_ENABLED) return { attempted: 0, persisted: 0, failed: 0, skipped: 0 };

    // A normal persistence scan can race the final shutdown flush. Stop it and cancel
    // debounce timers first so the final pass is the only writer started by shutdown.
    if (roomPersistenceScanTimer) {
        clearInterval(roomPersistenceScanTimer);
        roomPersistenceScanTimer = null;
    }
    for (const timer of roomPersistenceTimers.values()) clearTimeout(timer);
    roomPersistenceTimers.clear();

    const ids = Object.keys(rooms).filter((id) => !!rooms[id]);
    const deadline = Date.now() + SHUTDOWN_ROOM_PERSIST_TIMEOUT_MS;
    let cursor = 0;
    let attempted = 0;
    let persisted = 0;
    let failed = 0;
    let skipped = 0;

    async function worker() {
        while (true) {
            if (Date.now() >= deadline) return;
            const index = cursor++;
            if (index >= ids.length) return;
            const id = ids[index];
            const room = rooms[id];
            if (!room) {
                skipped++;
                continue;
            }
            attempted++;
            try {
                const ok = await persistRoomSnapshot(room, { register: !roomPersistenceKnownIds.has(id) });
                if (ok) persisted++;
                else skipped++;
            } catch (e) {
                failed++;
                console.error(`[shutdown] บันทึก snapshot ห้อง ${id} ไม่สำเร็จ (${reason}):`, e?.name || "Error", e?.message || e);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(SHUTDOWN_ROOM_PERSIST_CONCURRENCY, ids.length || 1) }, () => worker()));
    const processed = attempted + skipped;
    const remaining = Math.max(0, ids.length - processed);
    const result = { attempted, persisted, failed, skipped: skipped + remaining };
    console.log(`[shutdown] room snapshot flush (${reason}): attempted=${result.attempted} persisted=${result.persisted} failed=${result.failed} skipped=${result.skipped}`);
    return result;
}

async function gracefulShutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    appDraining = true;
    console.log(`[shutdown] ${signal} received — marking instance draining before closing WebSocket connections`);

    const forceExit = setTimeout(() => {
        console.error(`[shutdown] grace period ${SHUTDOWN_GRACE_MS}ms exceeded — forcing exit`);
        process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref?.();

    try {
        // Stop new realtime handshakes first. Existing HTTP requests are allowed to finish,
        // while /ready immediately returns 503 so Elastic Beanstalk/ALB can deregister this
        // instance before the process actually exits.
        try {
            io.emit("server_draining", {
                now: Date.now(),
                retryAfterMs: Math.min(10_000, SHUTDOWN_ROOM_PERSIST_TIMEOUT_MS),
            });
        } catch (_) {}

        try { io.close(); } catch (e) { console.error("[shutdown] Socket.IO close failed:", e?.message || e); }

        // Socket.IO disconnect handlers mutate room membership/connection flags. Wait for the
        // namespace to become empty so the final durable snapshot reflects the post-disconnect
        // room state, rather than racing a handler that runs immediately after io.close().
        const socketDrained = await waitForSocketDrain();
        if (!socketDrained) console.warn(`[shutdown] Socket.IO ยังมี connection ค้างก่อน snapshot (>${2_500}ms)`);

        // Give Socket.IO disconnect handlers a short chance to finish their in-memory cleanup
        // before the final durable snapshot pass. Any writes already in flight are drained first.
        await waitForGameDataWritesDrain(Math.min(5_000, SHUTDOWN_ROOM_PERSIST_TIMEOUT_MS));
        await flushRoomPersistenceForShutdown("final");
        await waitForGameDataWritesDrain(Math.min(5_000, SHUTDOWN_ROOM_PERSIST_TIMEOUT_MS));
        // The final snapshot is now durable. Release leases only after the snapshot/write drain so
        // a replacement Immutable instance cannot acquire the room and read an older snapshot.
        await releaseAllLocalRoomLeases(`shutdown:${signal}`);

        if (roomRecoveryDeferredTimer) { clearInterval(roomRecoveryDeferredTimer); roomRecoveryDeferredTimer = null; }
        for (const timer of roomLeaseTimers.values()) clearInterval(timer);
        roomLeaseTimers.clear();

        await new Promise((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            try {
                server.close((err) => {
                    if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
                        console.error("[shutdown] HTTP server close failed:", err.message || err);
                    }
                    done();
                });
            } catch (e) {
                if (e?.code !== "ERR_SERVER_NOT_RUNNING") console.error("[shutdown] HTTP server close threw:", e?.message || e);
                done();
            }
        });
        console.log("[shutdown] HTTP/WebSocket drain complete; durable room snapshots flushed where possible");
        clearTimeout(forceExit);
        process.exit(0);
    } catch (e) {
        console.error("[shutdown] graceful shutdown failed:", e?.stack || e);
        clearTimeout(forceExit);
        process.exit(1);
    }
}

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

server.on("error", (err) => {
    // Examples: EADDRINUSE/EACCES or another low-level listener failure. These are
    // fatal for this instance; log the exact cause and let EB replace the process.
    console.error("[server] HTTP listener error:", err?.code || err?.name || "Error", err?.message || err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 100).unref?.();
});

server.listen(HTTP_PORT, () => {
    console.log("server running on port", HTTP_PORT);
});
