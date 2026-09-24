const express = require("express");
const http = require("http");
const https = require("https");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const os = require("os");
const compression = require("compression");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { getAppVersion, getCachedAppVersion, startAppVersionRefresh } = require("./utils/getAppVersion");
const { listBugReplayScenarios, getBugReplayScenario, runBugReplayScenario, createRuntimeAudit } = require("./utils/bug-replay-runner");

// ============================================================
// DIAGNOSTICS CENTER — เก็บข้อผิดพลาดจาก server + browser เพื่อให้ Admin ดูได้
// ระบบนี้ตั้งใจแยกจาก game state และไม่ทำให้หน้า Admin พึ่ง client game JS
// เพื่อให้แม้ index/host/player มีบั๊ก หน้า Admin ยังเปิดและดูอาการได้
// ============================================================
const DIAGNOSTIC_MAX_EVENTS = 700;
const DIAGNOSTIC_MAX_TEXT = 12000;
const diagnosticEvents = [];
const diagnosticPermissionCounts = new Map();
const diagnosticClientRate = new Map();
const diagnosticServerBreadcrumbs = [];
const DIAGNOSTIC_MAX_BREADCRUMBS = 2500;
const diagnosticAsyncContext = new AsyncLocalStorage();
let diagnosticSequence = 0;
const DIAGNOSTIC_REDACT_KEYS = /token|secret|password|authorization|cookie|session/i;

// Public diagnostic shares are capability URLs: anyone holding the random token can read
// the selected diagnostic snapshot until it expires. Reports are persisted in the existing
// DynamoDB table so a CloudFront/Elastic Beanstalk request can land on another instance.
const DIAGNOSTIC_SHARE_VERSION = 3;
const DIAGNOSTIC_SHARE_TTL_MS = Math.max(15 * 60_000, Math.min(7 * 24 * 60 * 60_000, Number(process.env.DIAGNOSTIC_SHARE_TTL_MS) || 3 * 24 * 60 * 60_000));
const DIAGNOSTIC_SHARE_MAX_MEMORY = 160;
const DIAGNOSTIC_SHARE_MAX_BYTES = 320 * 1024;
const DIAGNOSTIC_SHARE_PARTITION_KEY = "__DIAGNOSTIC_SHARE__";
const DIAGNOSTIC_SHARE_STAT_PREFIX = "SHARE#";
const DIAGNOSTIC_INCIDENT_INDEX_PREFIX = "INCIDENT#";
const DIAGNOSTIC_INCIDENT_REUSE_WINDOW_MS = 15 * 60 * 1000;
const DIAGNOSTIC_SHARE_TOKEN_BYTES = 18;
const DIAGNOSTIC_CAUSAL_MAX_NODES = 36;
const DIAGNOSTIC_CAUSAL_MAX_EDGES = 72;
const DIAGNOSTIC_CAUSAL_WINDOW_MS = 3 * 60 * 1000;
const DIAGNOSTIC_CAUSAL_STRONG_WINDOW_MS = 15 * 60 * 1000;
const diagnosticShares = new Map();

// ============================================================
// ADMIN BUG REPLAY / SIMULATION RUNNER
// ============================================================
// รันชุดจำลองแบบ allow-list; โหมด all หยุดที่ failure แรก ส่วน deep จะเดินต่อเพื่อเก็บ failure หลายจุดใน run เดียว
// จำกัดจำนวน failure ที่เก็บเผยแพร่เพื่อไม่ให้ Diagnostics/หน้า Admin โตไม่จำกัด
const BUG_REPLAY_MAX_JOBS = 8;
const BUG_REPLAY_MAX_FAILURES = 12;
const BUG_REPLAY_JOB_TTL_MS = 30 * 60 * 1000;
const bugReplayJobs = new Map();
let bugReplayActiveRunId = "";

function makeDiagnosticId(prefix = "id") {
    const body = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex");
    return `${prefix}-${body}`;
}

function sanitizeDiagnosticPath(value) {
    const raw = String(value || "");
    try {
        if (/^https?:\/\//i.test(raw)) {
            const u = new URL(raw);
            return `${u.origin}${u.pathname}`.slice(0, 600);
        }
    } catch (_) {}
    return raw.split(/[?#]/, 1)[0].slice(0, 600);
}

function safeDiagnosticValue(value, depth = 0) {
    if (depth > 3 || value === null || value === undefined) return value == null ? "" : String(value);
    if (typeof value === "string") return value.slice(0, 500);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 12).map((v) => safeDiagnosticValue(v, depth + 1));
    if (typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).slice(0, 24)) {
            if (DIAGNOSTIC_REDACT_KEYS.test(key)) continue;
            out[String(key).slice(0, 80)] = safeDiagnosticValue(value[key], depth + 1);
        }
        return out;
    }
    return String(value).slice(0, 500);
}

function inferDiagnosticRoomId(text) {
    const raw = String(text || "");
    const m1 = raw.match(/\b(?:room|ห้อง)\s*[:#]?\s*([A-Z0-9]{3,12})\b/i);
    if (m1) return String(m1[1]).toUpperCase().slice(0, 12);
    return "";
}

function inferDiagnosticAction(text) {
    const raw = String(text || "");
    const socket = raw.match(/\[socket:([^\]]+)\]/i);
    if (socket) return `socket:${socket[1]}`.slice(0, 120);
    const api = raw.match(/\b(POST|PUT|PATCH|DELETE|GET)\s+(\/api\/[^\s]+)/i);
    if (api) return `${api[1]} ${sanitizeDiagnosticPath(api[2])}`.slice(0, 120);
    return "";
}

function nextDiagnosticSequence() {
    diagnosticSequence += 1;
    if (diagnosticSequence > 2147483647) diagnosticSequence = 1;
    return diagnosticSequence;
}

function diagnosticFingerprint(parts) {
    const raw = Array.isArray(parts) ? parts.filter((x) => x !== undefined && x !== null).map(String).join("|") : String(parts || "");
    return crypto.createHash("sha1").update(raw.slice(0, 4000)).digest("hex").slice(0, 16);
}

function diagnosticAckCode(value) {
    return String(value?.code || value?.errorCode || value?.ackCode || value?.serverCode || "").trim().toUpperCase();
}

function isSuccessfulDiagnosticAck(eventName, payload) {
    // Legacy room-list events intentionally return a raw array, not { ok:true }.
    if (Array.isArray(payload) && /^(list_open_rooms|list_open_rooms_players)$/.test(String(eventName || ""))) return true;
    if (payload && typeof payload === "object" && payload.ok === true) return true;
    return false;
}

function diagnosticEventCode(event = {}) {
    const context = event.context || {};
    const detail = event.detail || {};
    const authBootstrapError = detail.authObservation?.testerPassBootstrapError || detail.authPresence?.testerPassBootstrapError || "";
    return String(
        context.ackCode || context.serverCode || context.code || context.errorCode ||
        detail.ackCode || detail.serverCode || detail.code || detail.errorCode ||
        authBootstrapError || event.causalHint?.causeCode || ""
    ).trim().toUpperCase();
}

function classifyDiagnosticCause({ kind = "", message = "", status = 0, context = {}, permission = null, causalHint = null } = {}) {
    const code = String(context?.ackCode || context?.serverCode || context?.code || context?.errorCode || causalHint?.causeCode || "").toUpperCase();
    const text = String(message || "");
    if (permission?.accessDenied || /AccessDenied|not authorized|UnauthorizedOperation/i.test(text)) {
        return { code: "IAM_ACCESS_DENIED", stage: "server.persistence", confidence: "high", explanation: "AWS ปฏิเสธสิทธิ์ของ operation ที่ระบบกำลังทำ" };
    }
    if (code) {
        if (/^(ACCOUNT_DELETED|ACCOUNT_SESSION_EXPIRED|ACCOUNT_NOT_FOUND|ACCOUNT_RECREATE_REQUIRED|ACCOUNT_TOKEN_REQUIRED|GOOGLE_REAUTH_REQUIRED|ACCOUNT_AUTH_FAILED|ACCOUNT_EXPIRED)$/.test(code)) {
            return { code, stage: "account.authentication", confidence: "high", explanation: "เซิร์ฟเวอร์ปฏิเสธตัวตนหรือสถานะบัญชีด้วยรหัสที่ระบุโดยตรง" };
        }
        if (/^(TESTER_PASS_REQUIRED|TESTER_PASS_INVALID|TESTER_PASS_UNAVAILABLE|TESTER_AUTH_FAILED|TESTER_SHARED_SECRET_MISSING|TESTER_SHARED_SECRET_MISMATCH)$/.test(code)) {
            return { code, stage: "tester.authentication", confidence: "high", explanation: "การยืนยันสิทธิ์โหมดผู้ทดสอบไม่ผ่านก่อนเข้าสู่ event หลัก" };
        }
        if (/^(ROOM_NOT_FOUND|ROOM_CLOSED|ROOM_FULL|PLAYER_LEFT_GAME)$/.test(code)) {
            return { code, stage: "room.authorization", confidence: "high", explanation: "เซิร์ฟเวอร์ปฏิเสธการเข้าถึงห้องตามสถานะหรือสิทธิ์ของผู้เล่น" };
        }
        if (/^(SERVER_ERROR|INTERNAL_ERROR|ACCOUNT_BOOTSTRAP_FAILED|ACCOUNT_DB_UNAVAILABLE|ACCOUNT_PERSISTENCE_UNAVAILABLE|DB_ERROR|PERSISTENCE_ERROR)$/.test(code)) {
            return { code, stage: "server.handler", confidence: "high", explanation: "คำขอเข้าถึงเซิร์ฟเวอร์แล้ว แต่ handler หรือ persistence ทำงานไม่สำเร็จ" };
        }
        if (code === "ACK_TIMEOUT") return { code, stage: "socket.ack", confidence: "high", explanation: "ส่ง Socket.IO event แล้วไม่ได้รับ ACK ภายในเวลาที่กำหนด" };
        if (/^(SOCKET_CONNECT_ERROR|SOCKET_EMIT_ERROR|SOCKET_ERROR)$/.test(code)) return { code, stage: "socket.transport", confidence: "high", explanation: "การส่งหรือเชื่อมต่อ Socket.IO มีความผิดพลาดก่อนงานปลายทางเสร็จ" };
        if (/^HTTP_\d+$/.test(code)) return { code, stage: Number(status) >= 500 ? "http.server" : "http.response", confidence: Number(status) >= 500 ? "high" : "medium", explanation: Number(status) >= 500 ? "HTTP 5xx ยืนยันว่าคำขอล้มเหลวที่ต้นทาง/เซิร์ฟเวอร์" : "HTTP response ไม่สำเร็จและมีรหัสสถานะระบุไว้" };
        return { code, stage: causalHint?.failureStage || "server.response", confidence: causalHint?.confidence === "high" ? "high" : "medium", explanation: "ตรวจพบรหัสผิดพลาดจากชั้นปลายทางที่สัมพันธ์กับเหตุการณ์นี้" };
    }
    if (Number(status) >= 500) return { code: `HTTP_${Number(status)}`, stage: "http.server", confidence: "high", explanation: "HTTP 5xx ยืนยันว่าคำขอล้มเหลวที่ฝั่งเซิร์ฟเวอร์/ต้นทาง" };
    if (kind === "socket_ack_timeout") return { code: "ACK_TIMEOUT", stage: "socket.ack", confidence: "high", explanation: "ไม่พบ ACK กลับจาก event ที่ส่งไป" };
    if (kind === "socket_connect_error") return { code: "SOCKET_CONNECT_ERROR", stage: "socket.connect", confidence: "high", explanation: "สร้าง/เชื่อมต่อ Socket.IO ไม่สำเร็จ" };
    if (kind === "network_error" || kind === "fetch_aborted") return { code: kind === "fetch_aborted" ? "FETCH_ABORTED" : "NETWORK_ERROR", stage: "browser.transport", confidence: "medium", explanation: "เบราว์เซอร์รายงานปัญหาระหว่างส่งหรือรับข้อมูล" };
    return { code: "UNCLASSIFIED", stage: "unknown", confidence: "low", explanation: "ยังไม่มีหลักฐานพอจะระบุชั้นต้นเหตุแบบฟันธง" };
}

function diagnosticIsBenignLifecycleEvent(item = {}) {
    const kind = String(item.kind || item.type || "").toLowerCase();
    const code = diagnosticEventCode(item);
    return /^(browser_exit_signal|browser_exit_armed|browser_exit_cancelled|browser_exit_applied|room_closed_after_browser_exit)$/.test(kind)
        || /^(BROWSER_EXIT_SIGNAL|BROWSER_EXIT_ARMED|BROWSER_EXIT_CANCELLED|BROWSER_EXIT_RECONNECTED|BROWSER_EXIT_KEPT_ROOM_OPEN|BROWSER_EXIT_APPLIED|BROWSER_EXIT_CLOSE_ROOM|ROOM_CLOSED)$/.test(code);
}

function diagnosticIsFailureEvent(item = {}) {
    if (diagnosticIsBenignLifecycleEvent(item)) return false;
    const kind = String(item.kind || item.type || "").toLowerCase();
    const code = diagnosticEventCode(item);
    const message = String(item.message || item.label || "");
    if (item.permission?.accessDenied) return true;
    if (Number(item.status) >= 400) return true;
    if (code && !/^(OK|SUCCESS)$/.test(code)) return true;
    if (/error|fail|exception|denied|timeout|reject|disconnect|close|aborted|invalid|unavailable|ล้มเหลว|ไม่สำเร็จ|ปฏิเสธ/i.test(kind + " " + message)) return true;
    if (String(item.type || "") === "socket" && /^ack:/.test(String(item.label || "")) && item.detail?.ok === false) return true;
    return false;
}

function diagnosticStageForItem(item = {}) {
    const kind = String(item.kind || "").toLowerCase();
    const type = String(item.type || "").toLowerCase();
    const label = String(item.label || "").toLowerCase();
    const code = diagnosticEventCode(item);
    if (item.permission?.accessDenied || /accessdenied|not authorized|iam_access_denied/.test(String(item.message || "").toLowerCase())) return "server.persistence";
    if (/^tester_/.test(kind) || /^tester[_\.]/.test(code.toLowerCase())) return "tester.authentication";
    if (/account_/.test(kind) || /account\./.test(code.toLowerCase())) return "account.authentication";
    if (code === "ACK_TIMEOUT" || label.indexOf("ack.timeout") === 0) return "socket.ack";
    if (type === "socket" || kind.indexOf("socket_") === 0) {
        if (label.indexOf("emit:") === 0 || label.indexOf("emit.sent:") === 0) return "socket.client_send";
        if (label.indexOf("handler.start:") === 0 || label.indexOf("handler.resolve:") === 0 || label.indexOf("handler.return:") === 0) return "socket.server_handler";
        if (label.indexOf("ack:") === 0) return "socket.server_response";
        return "socket.transport";
    }
    if (/dynamodb|persistence|aws/.test(type + " " + kind + " " + label)) return "server.persistence";
    if (/http|fetch|network/.test(type + " " + kind + " " + label)) return "browser.transport";
    if (/browser_exit|pagehide|beforeunload|lifecycle/.test(kind + " " + label + " " + type)) return "browser.lifecycle";
    if (/resource|javascript|unhandled|window_open/.test(kind)) return "browser.runtime";
    if (Number(item.status) >= 500) return "http.server";
    return "unknown";
}

function diagnosticAuthObservation(item = {}) {
    if (!item) return null;
    const detail = item.detail || item.context || {};
    const observation = detail.authObservation || detail.authPresence || detail.auth || detail.authState || {};
    if (!observation || typeof observation !== "object") return null;
    const out = {};
    for (const key of ["requestedTester","testerPassPresented","testerPassValid","testerGranted","testerPassBootstrapError","hasAccountToken","hasAccountId","hasAdminIntent","isAdmin","hasDiagSession","hasRoomIdentity"]) {
        if (Object.prototype.hasOwnProperty.call(observation, key)) out[key] = observation[key];
    }
    return Object.keys(out).length ? out : null;
}


function diagnosticHumanLabel(item = {}) {
    const stage = diagnosticStageForItem(item);
    const code = diagnosticEventCode(item);
    const kind = String(item.kind || item.type || "event");
    const label = String(item.label || item.message || kind).slice(0, 180);
    return code ? `${stage} · ${code} · ${label}` : `${stage} · ${label}`;
}

function buildDiagnosticTimeline(related = []) {
    const seen = new Set();
    const items = (Array.isArray(related) ? related : []).map((item, idx) => ({
        ...item,
        __timelineId: item.id || `${item.time || ""}|${item.kind || item.type || ""}|${item.label || item.message || ""}|${idx}`,
    })).sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
    return items.filter((item) => {
        if (seen.has(item.__timelineId)) return false;
        seen.add(item.__timelineId);
        return true;
    }).slice(0, 160).map((item) => ({
        time: String(item.time || ""),
        source: String(item.source || "server").slice(0, 32),
        kind: String(item.kind || item.type || "event").slice(0, 64),
        label: String(item.label || item.message || "").slice(0, 180),
        stage: diagnosticStageForItem(item),
        code: diagnosticEventCode(item),
        ok: item.detail?.ok === true || item.ok === true,
        operationId: String(item.operationId || item.detail?.operationId || "").slice(0, 120),
        requestId: String(item.requestId || item.detail?.requestId || "").slice(0, 120),
        evidence: safeDiagnosticValue(item.detail || item.context || {}),
    }));
}


function diagnosticTimeMs(item = {}) {
    const value = Date.parse(String(item.time || ""));
    return Number.isFinite(value) ? value : 0;
}

function diagnosticEventName(item = {}) {
    const ctx = item.context || item.detail || {};
    if (ctx.eventName) return String(ctx.eventName);
    const label = String(item.label || "");
    const m = label.match(/^(?:ack|handler\.(?:start|resolve|return)):(.+)$/i);
    return m ? String(m[1]) : "";
}

function diagnosticSameCorrelation(a = {}, b = {}) {
    const pairs = [
        ["operationId", "operation"],
        ["requestId", "request"],
        ["clientRequestId", "clientRequest"],
        ["traceId", "trace"],
        ["sessionId", "session"],
        ["roomId", "room"],
    ];
    const out = [];
    for (const [key, label] of pairs) {
        const av = String(a[key] || a.context?.[key] || a.detail?.[key] || "").trim();
        const bv = String(b[key] || b.context?.[key] || b.detail?.[key] || "").trim();
        if (av && bv && av === bv) out.push({ key, label, value: av });
    }
    return out;
}

function diagnosticExplicitCausalDirection(before = {}, after = {}) {
    const list = (value) => Array.isArray(value) ? value.map((x) => String(x || "")).filter(Boolean) : [];
    const beforeDownstream = [
        ...list(before.causalHint?.downstreamEventIds),
        ...list(before.causalHint?.causesEventIds),
        ...list(before.context?.downstreamEventIds),
        ...list(before.context?.causesEventIds),
    ];
    const afterUpstream = [
        ...list(after.causalHint?.upstreamEventIds),
        ...list(after.causalHint?.causedByEventIds),
        ...list(after.context?.upstreamEventIds),
        ...list(after.context?.causedByEventIds),
    ];
    if (beforeDownstream.includes(String(after.id || "")) || afterUpstream.includes(String(before.id || ""))) {
        return { matched: true, direction: "before_to_after", score: 180, confidence: "high", reasons: ["explicit event-to-event causal link recorded by the system"] };
    }
    return { matched: false, direction: "", score: 0, confidence: "low", reasons: [] };
}

function refreshDiagnosticEventAnalysis(event) {
    if (!event || !event.id) return;
    try {
        const related = relatedDiagnosticEventsFor(event);
        const serverBreadcrumbs = event.serverBreadcrumbs?.length ? event.serverBreadcrumbs : relatedServerBreadcrumbs({ traceId:event.traceId, sessionId:event.sessionId, limit:160 });
        const allForAnalysis = related.concat(serverBreadcrumbs.map((b) => ({ source:"server", kind:b.type, type:b.type, time:b.time, label:b.label, message:b.label, detail:b.detail, context:b.detail })));
        event.analysis = buildDiagnosticAnalysis(event, allForAnalysis);
    } catch (_) {}
}

function linkDiagnosticEvents(upstreamId, downstreamId, relation = "causes") {
    const from = diagnosticEvents.find((e) => String(e?.id || "") === String(upstreamId || ""));
    const to = diagnosticEvents.find((e) => String(e?.id || "") === String(downstreamId || ""));
    if (!from || !to || from.id === to.id) return false;
    from.causalHint = (from.causalHint && typeof from.causalHint === "object") ? from.causalHint : {};
    to.causalHint = (to.causalHint && typeof to.causalHint === "object") ? to.causalHint : {};
    const add = (obj, key, value) => {
        obj[key] = Array.isArray(obj[key]) ? obj[key] : [];
        if (!obj[key].includes(String(value))) obj[key].push(String(value));
        obj[key] = obj[key].slice(0, 24);
    };
    if (relation === "causes") {
        add(from.causalHint, "downstreamEventIds", to.id);
        add(to.causalHint, "upstreamEventIds", from.id);
    } else {
        add(from.causalHint, "relatedEventIds", to.id);
        add(to.causalHint, "relatedEventIds", from.id);
    }
    // The Admin live feed returns cached analysis. Refresh both endpoints so the relationship
    // is visible immediately, not only when a share snapshot is created later.
    refreshDiagnosticEventAnalysis(from);
    refreshDiagnosticEventAnalysis(to);
    return true;
}

function diagnosticSemanticCausalSignal(before = {}, after = {}) {
    const bk = String(before.kind || before.type || "").toLowerCase();
    const ak = String(after.kind || after.type || "").toLowerCase();
    const bl = String(before.label || before.message || "").toLowerCase();
    const al = String(after.label || after.message || "").toLowerCase();
    const beforeEvent = diagnosticEventName(before).toLowerCase();
    const afterEvent = diagnosticEventName(after).toLowerCase();
    const reasons = [];
    let score = 0;
    const add = (points, reason) => { score += points; reasons.push(reason); };

    if (bk === "socket" && bl.startsWith("emit:") && ak === "socket_ack_timeout") add(92, "client emitted Socket.IO event, then the same operation timed out waiting for ACK");
    if (bk === "socket_breadcrumb" && bl.startsWith("handler.start:") && ak === "socket_ack_error") add(78, "server handler started before client received a rejected ACK");
    if (bk === "socket_handler_error" && ak === "socket_ack_error") add(90, "server handler error preceded client/server ACK rejection");
    if (/dynamodb|database/.test(bk + " " + bl) && (ak === "socket_handler_error" || ak === "http_error" || ak === "socket_ack_error")) add(88, "database failure preceded a higher-level server failure");
    if (before.permission?.accessDenied && (ak === "socket_handler_error" || ak === "http_error" || ak === "socket_ack_error")) add(96, "IAM denial preceded the higher-level operation failure");
    if (bk === "socket" && bl.startsWith("ack:") && ak === "socket_ack_error") add(100, "server ACK rejection surfaced as the matching client ACK error");
    if (bk === "socket_ack_error" && ak === "unhandled_rejection") add(86, "socket ACK error preceded an unhandled rejection in the same client flow");
    if ((bk === "socket_ack_error" || bk === "socket_handler_error") && (ak.includes("disconnect") || al.includes("disconnect"))) add(74, "error preceded Socket.IO disconnect");
    if ((bk === "network_error" || bk === "http_error" || bk === "fetch_aborted") && /retry/.test(ak + " " + al)) add(78, "transport failure preceded the retry failure");
    if (/request\.retry\.failed/.test(bl) && ak === "unhandled_rejection") add(70, "failed retry preceded an unhandled rejection");
    if (diagnosticIsFailureEvent(before) && /navigation|window_open|pagehide/.test(ak + " " + al)) add(68, "failure preceded navigation/lifecycle side effect");
    if (beforeEvent && afterEvent && beforeEvent === afterEvent && bk === "socket" && bl.startsWith("handler.start:")) add(80, "same Socket.IO event passed from handler start to later event");
    if (bk === "socket" && bl.startsWith("handler.start:") && ak === "socket" && al.startsWith("ack:") && (!beforeEvent || beforeEvent === afterEvent)) add(84, "same Socket.IO event progressed from handler start to ACK");
    if ((bk === "socket_connect_error" || /connect_error/.test(bl)) && ak === "socket_ack_timeout") add(82, "Socket connection failure preceded ACK timeout");
    if ((bk === "socket_ack_timeout" || bk === "socket_connect_error") && (ak === "disconnect" || /disconnect/.test(al))) add(66, "Socket transport failure preceded disconnect");

    return { score: Math.min(100, score), reasons };
}

function diagnosticCausalPair(before = {}, after = {}) {
    if (!before || !after || before.id === after.id) return null;
    const bt = diagnosticTimeMs(before);
    const at = diagnosticTimeMs(after);
    if (!bt || !at || at <= bt) return null;
    const dt = at - bt;
    const explicit = diagnosticExplicitCausalDirection(before, after);
    if (explicit.matched && !(diagnosticIsBenignLifecycleEvent(before) || diagnosticIsBenignLifecycleEvent(after))) {
        return {
            from: String(before.id || ""),
            to: String(after.id || ""),
            score: explicit.score,
            confidence: explicit.confidence,
            relation: "probable_cause",
            timeDeltaMs: dt,
            reasons: explicit.reasons.slice(0, 8),
            semanticScore: 100,
            correlationStrength: 120,
            explicit: true,
        };
    }
    if (diagnosticIsBenignLifecycleEvent(before) || diagnosticIsBenignLifecycleEvent(after)) return null;
    const correlations = diagnosticSameCorrelation(before, after);
    if (!correlations.length) return null;
    const strongestCorrelation = correlations.some(x => x.key === "operationId") ? 100
        : correlations.some(x => x.key === "requestId" || x.key === "clientRequestId") ? 95
        : correlations.some(x => x.key === "traceId") ? 80
        : correlations.some(x => x.key === "sessionId") ? 58
        : correlations.some(x => x.key === "roomId") ? 36 : 0;
    const semantic = diagnosticSemanticCausalSignal(before, after);
    const allowedWindow = strongestCorrelation >= 95 ? DIAGNOSTIC_CAUSAL_STRONG_WINDOW_MS : DIAGNOSTIC_CAUSAL_WINDOW_MS;
    if (dt > allowedWindow) return null;

    let score = strongestCorrelation;
    const reasons = correlations.slice(0, 3).map(x => `same ${x.label}=${x.value}`);
    if (semantic.score) {
        score += Math.round(semantic.score * (strongestCorrelation >= 58 ? 0.58 : 0.42));
        reasons.push(...semantic.reasons.slice(0, 3));
    }
    if (dt <= 5_000) { score += 10; reasons.push(`time gap ${dt}ms`); }
    else if (dt <= 30_000) { score += 6; reasons.push(`time gap ${dt}ms`); }
    else if (dt <= 120_000) { score += 3; reasons.push(`time gap ${dt}ms`); }

    const beforeFailure = diagnosticIsFailureEvent(before);
    const afterFailure = diagnosticIsFailureEvent(after);
    const hasSemantic = semantic.score >= 55;
    const explicitOperation = correlations.some(x => x.key === "operationId");
    const explicitRequest = correlations.some(x => x.key === "requestId" || x.key === "clientRequestId");
    const sameRoomOnly = strongestCorrelation === 36 && correlations.every(x => x.key === "roomId");
    const roomCausalEvidence = !sameRoomOnly || (semantic.score >= 78 && dt <= 10_000);
    const probableCausal = hasSemantic && roomCausalEvidence && (strongestCorrelation >= 36 || explicitOperation || explicitRequest) && score >= 68;
    if (sameRoomOnly && !roomCausalEvidence) return null;
    const confidence = score >= 115 ? "high" : score >= 88 ? "medium" : "low";
    let relation = "correlated_event";
    if (probableCausal && beforeFailure && afterFailure) relation = "probable_cause";
    else if (probableCausal && afterFailure) relation = "causal_context";
    else if (probableCausal) relation = "downstream_effect";
    if (beforeFailure && afterFailure && !probableCausal && strongestCorrelation < 58) return null;

    return {
        from: String(before.id || ""),
        to: String(after.id || ""),
        score: Math.min(180, Math.round(score)),
        confidence,
        relation,
        timeDeltaMs: dt,
        reasons: reasons.slice(0, 8),
        semanticScore: semantic.score,
        correlationStrength: strongestCorrelation,
    };
}

function diagnosticCausalClusterForEvent(event, maxNodes = DIAGNOSTIC_CAUSAL_MAX_NODES) {
    const all = Array.isArray(diagnosticEvents) ? diagnosticEvents.slice() : [];
    const selected = new Map([[String(event.id || ""), event]]);
    const frontier = [event];
    const pairBest = new Map();
    for (let depth = 0; depth < 2 && frontier.length; depth++) {
        const next = [];
        for (const current of frontier) {
            const scored = [];
            for (const other of all) {
                if (!other || other.id === current.id) continue;
                const pair = current.time && other.time
                    ? (diagnosticTimeMs(other) < diagnosticTimeMs(current) ? diagnosticCausalPair(other, current) : diagnosticCausalPair(current, other))
                    : null;
                if (!pair) continue;
                const neighborId = pair.from === current.id ? pair.to : pair.from;
                const threshold = pair.relation === "correlated_event" ? 82 : 62;
                if (pair.score < threshold) continue;
                const existing = pairBest.get(neighborId);
                if (!existing || pair.score > existing.score) pairBest.set(neighborId, pair);
                if (!selected.has(neighborId)) scored.push({ other, pair });
            }
            scored.sort((a,b) => b.pair.score - a.pair.score);
            for (const item of scored.slice(0, 18)) {
                const id = String(item.other.id || "");
                if (!id || selected.has(id)) continue;
                selected.set(id, item.other);
                next.push(item.other);
                if (selected.size >= maxNodes) break;
            }
            if (selected.size >= maxNodes) break;
        }
        frontier.splice(0, frontier.length, ...next);
        if (selected.size >= maxNodes) break;
    }
    const list = Array.from(selected.values());
    list.sort((a,b) => diagnosticTimeMs(a) - diagnosticTimeMs(b));
    return list.slice(0, maxNodes);
}

function diagnosticCausalNodeSummary(item = {}, primaryId = "") {
    return {
        id: String(item.id || "").slice(0, 120),
        time: String(item.time || ""),
        source: String(item.source || "").slice(0, 32),
        kind: String(item.kind || item.type || "event").slice(0, 64),
        page: String(item.page || "").slice(0, 48),
        code: diagnosticEventCode(item),
        stage: diagnosticStageForItem(item),
        message: publicDiagnosticText(item.message || item.label || "").slice(0, 420),
        fingerprint: String(item.fingerprint || "").slice(0, 80),
        primary: String(item.id || "") === String(primaryId || ""),
    };
}

function buildDiagnosticCausalGraph(primary = {}, related = []) {
    const pool = [];
    const seen = new Set();
    for (const item of [primary, ...(Array.isArray(related) ? related : [])]) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        pool.push(item);
    }
    pool.sort((a,b) => diagnosticTimeMs(a) - diagnosticTimeMs(b));
    const nodes = pool.slice(0, DIAGNOSTIC_CAUSAL_MAX_NODES).map(x => diagnosticCausalNodeSummary(x, primary.id));
    const edgeByKey = new Map();
    for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
            const pair = diagnosticCausalPair(pool[i], pool[j]);
            if (!pair) continue;
            const key = `${pair.from}->${pair.to}`;
            if (!edgeByKey.has(key) || pair.score > edgeByKey.get(key).score) edgeByKey.set(key, pair);
        }
    }
    const edges = Array.from(edgeByKey.values()).sort((a,b) => b.score - a.score || a.timeDeltaMs - b.timeDeltaMs).slice(0, DIAGNOSTIC_CAUSAL_MAX_EDGES);
    const nodeNeighbors = new Map(nodes.map((n) => [n.id, { upstream:[], downstream:[], correlated:[] }]));
    for (const edge of edges) {
        const from = nodeNeighbors.get(edge.from);
        const to = nodeNeighbors.get(edge.to);
        const compactEdge = {
            eventId: edge.from, targetEventId: edge.to, relation: edge.relation,
            confidence: edge.confidence, score: edge.score, timeDeltaMs: edge.timeDeltaMs,
            reasons: Array.isArray(edge.reasons) ? edge.reasons.slice(0, 6) : [],
        };
        if (edge.relation === "correlated_event") {
            if (from) from.correlated.push({ ...compactEdge, targetEventId: edge.to });
            if (to) to.correlated.push({ ...compactEdge, eventId: edge.from, targetEventId: edge.to });
        } else {
            if (from) from.downstream.push({ ...compactEdge, targetEventId: edge.to });
            if (to) to.upstream.push({ ...compactEdge, eventId: edge.from, targetEventId: edge.to });
        }
    }
    const enrichedNodes = nodes.map((n) => ({
        ...n,
        neighborhood: nodeNeighbors.get(n.id) || { upstream:[], downstream:[], correlated:[] },
    }));
    const primaryId = String(primary.id || "");
    const upstream = edges.filter(e => e.to === primaryId && e.relation === "probable_cause").sort((a,b) => b.score-a.score);
    const downstream = edges.filter(e => e.from === primaryId && (e.relation === "probable_cause" || e.relation === "downstream_effect" || e.relation === "causal_context")).sort((a,b) => b.score-a.score);
    const contextual = edges.filter(e => (e.to === primaryId || e.from === primaryId) && e.relation === "correlated_event").sort((a,b) => b.score-a.score);

    const rootPath = [];
    const visited = new Set([primaryId]);
    let cursor = primaryId;
    for (let hops = 0; hops < 8; hops++) {
        const edge = edges.filter(e => e.to === cursor && e.relation === "probable_cause" && !visited.has(e.from)).sort((a,b) => b.score-a.score)[0];
        if (!edge) break;
        rootPath.unshift(edge.from);
        visited.add(edge.from);
        cursor = edge.from;
    }

    const nodeById = new Map(enrichedNodes.map(n => [n.id, n]));
    const incomingCausal = new Map();
    const outgoingCausal = new Map();
    for (const edge of edges) {
        if (!['probable_cause','causal_context','downstream_effect'].includes(edge.relation)) continue;
        incomingCausal.set(edge.to, (incomingCausal.get(edge.to) || 0) + 1);
        outgoingCausal.set(edge.from, (outgoingCausal.get(edge.from) || 0) + 1);
    }
    const rootCandidates = enrichedNodes.filter(n => {
        const raw = pool.find(x => x.id === n.id) || n;
        return diagnosticIsFailureEvent(raw) && !incomingCausal.has(n.id);
    }).map(n => {
        const outgoing = edges.filter(e => e.from === n.id && ['probable_cause','causal_context','downstream_effect'].includes(e.relation)).sort((a,b) => b.score-a.score);
        return { ...n, downstreamCount: outgoing.length, strongestDownstreamScore: outgoing[0]?.score || 0, evidence: outgoing[0]?.reasons?.slice(0, 4) || [] };
    }).sort((a,b) => (b.strongestDownstreamScore - a.strongestDownstreamScore) || (b.downstreamCount - a.downstreamCount)).slice(0, 8);
    const terminalEffects = enrichedNodes.filter(n => diagnosticTimeMs(pool.find(x => x.id === n.id) || n) >= diagnosticTimeMs(primary) && !outgoingCausal.has(n.id)).slice(0, 12);
    return {
        version: 2,
        primaryId,
        nodeCount: enrichedNodes.length,
        edgeCount: edges.length,
        nodes: enrichedNodes,
        edges,
        upstreamCauseIds: upstream.map(e => e.from).slice(0, 8),
        downstreamEffectIds: downstream.map(e => e.to).slice(0, 12),
        correlatedEventIds: contextual.map(e => e.from === primaryId ? e.to : e.from).slice(0, 12),
        rootPath: rootPath.slice(0, 8).map(id => nodeById.get(id)).filter(Boolean),
        rootCauseCandidates: rootCandidates,
        terminalEffects,
        impact: {
            causedAnotherLog: downstream.length > 0,
            downstreamCount: downstream.length,
            upstreamCount: upstream.length,
            correlatedCount: contextual.length,
            downstreamEventIds: downstream.map(e => e.to).slice(0, 12),
            upstreamEventIds: upstream.map(e => e.from).slice(0, 8),
            statement: downstream.length
                ? `เหตุการณ์นี้มีหลักฐานความสัมพันธ์เชิงเหตุ→ผลกับ log ปลายทาง ${downstream.length} รายการใน snapshot`
                : upstream.length
                    ? "เหตุการณ์นี้มีหลักฐานต้นน้ำ แต่ยังไม่พบ log ปลายทางที่อธิบายได้ชัดใน snapshot"
                    : "ยังไม่พบหลักฐานเพียงพอว่าเหตุการณ์นี้ทำให้เกิด log อื่นโดยตรง",
        },
    };
}

function compactDiagnosticAnalysisForShare(analysis = {}, causalGraph = null, eventId = "") {
    const graph = causalGraph || {};
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const upstream = edges.filter(e => e.to === eventId && e.relation === "probable_cause").slice(0, 8).map(e => ({ ...e, urlReady: true }));
    const downstream = edges.filter(e => e.from === eventId && (e.relation === "probable_cause" || e.relation === "downstream_effect" || e.relation === "causal_context")).slice(0, 12).map(e => ({ ...e, urlReady: true }));
    return publicDiagnosticValue({
        rootCause: analysis.rootCause || "ยังระบุไม่ได้",
        causeCode: analysis.causeCode || "UNCLASSIFIED",
        failureStage: analysis.failureStage || "unknown",
        rootCauseSource: analysis.rootCauseSource || "unknown",
        confidence: analysis.confidence || "low",
        firstFailureAt: analysis.firstFailureAt || "",
        rootCauseAt: analysis.rootCauseAt || "",
        lastSeenAt: analysis.lastSeenAt || "",
        evidence: Array.isArray(analysis.evidence) ? analysis.evidence.slice(0, 12) : [],
        authEvidence: analysis.authEvidence || {},
        blockingEvent: analysis.blockingEvent || {},
        correlation: analysis.correlation || {},
        nextStep: analysis.nextStep || "",
        causalImpact: graph.impact || { causedAnotherLog: false, downstreamCount: 0, upstreamCount: 0 },
        upstreamEdges: upstream,
        downstreamEdges: downstream,
        rootCauseCandidates: graph.rootCauseCandidates || [],
        terminalEffects: graph.terminalEffects || [],
    });
}

function buildDiagnosticAnalysis(event, related = []) {
    const relatedEvents = Array.isArray(related) ? related.slice() : [];
    const breadcrumbEvidence = [];
    for (const owner of [event, ...relatedEvents]) {
        const crumbs = Array.isArray(owner?.breadcrumbs) ? owner.breadcrumbs : [];
        for (let i = 0; i < crumbs.length; i++) {
            const crumb = crumbs[i];
            if (!crumb || typeof crumb !== "object") continue;
            breadcrumbEvidence.push({
                source: "client", type: crumb.type || "breadcrumb", kind: "client_breadcrumb",
                label: crumb.label || "", message: crumb.label || "", time: crumb.time || owner.time || "",
                detail: crumb.detail || {}, traceId: crumb.traceId || owner.traceId || "", sessionId: crumb.sessionId || owner.sessionId || "",
                operationId: crumb.detail?.operationId || owner.operationId || "", requestId: crumb.detail?.requestId || owner.requestId || "",
                __breadcrumbOwnerId: owner.id || "", __breadcrumbIndex: i,
            });
        }
    }
    const evidencePool = relatedEvents.concat(breadcrumbEvidence);
    const ordered = evidencePool.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
    const timeline = buildDiagnosticTimeline(ordered);
    const eventCode = diagnosticEventCode(event);
    const cause = classifyDiagnosticCause({ kind:event.kind, message:event.message, status:event.status, context:event.context, permission:event.permission, causalHint:event.causalHint });
    const causalGraph = buildDiagnosticCausalGraph(event, relatedEvents);

    const candidates = ordered.filter(diagnosticIsFailureEvent).map((item, index) => {
        const code = diagnosticEventCode(item);
        const stage = diagnosticStageForItem(item);
        let score = 20;
        if (item.permission?.accessDenied) score += 60;
        if (code && !/^(SOCKET_ACK_ERROR|SOCKET_ERROR|NETWORK_ERROR|UNCLASSIFIED)$/.test(code)) score += 45;
        if (item.source === "server") score += 25;
        if (Number(item.status) >= 500) score += 25;
        if (item.type === "socket" && /^ack:/.test(String(item.label || "")) && item.detail?.ok === false) score += 35;
        if (String(item.kind || "").includes("handler_error")) score += 30;
        if (String(item.kind || "").includes("unhandled_rejection")) score -= 20;
        if (item === event) score += 35;
        score -= Math.min(20, index * 0.5);
        return { item, score, stage, code };
    }).sort((a,b) => b.score - a.score);

    const strongest = candidates[0]?.item || event;
    const strongestCause = strongest === event ? cause : classifyDiagnosticCause({
        kind: strongest.kind,
        message: strongest.message || strongest.label,
        status: strongest.status,
        context: strongest.context || strongest.detail || {},
        permission: strongest.permission,
        causalHint: strongest.causalHint,
    });
    const effective = strongestCause.code !== "UNCLASSIFIED" ? strongestCause : cause;

    const firstFailure = ordered.find(diagnosticIsFailureEvent) || event;
    const rootCauseAt = strongest.time || event.time || "";
    const firstFailureAt = firstFailure.time || event.time || "";
    const lastSeenAt = ordered.length ? ordered[ordered.length - 1].time : event.time || "";

    const eventName = String(event.context?.eventName || "").trim();
    const opId = String(event.operationId || event.context?.operationId || "").trim();
    const reqId = String(event.requestId || event.context?.requestId || event.context?.serverRequestId || "").trim();
    const sessionId = String(event.sessionId || "").trim();
    const traceId = String(event.traceId || "").trim();

    const evidence = [];
    if (eventName) evidence.push(`socket:${eventName}`);
    if (eventCode) evidence.push(`ack:${eventCode}`);
    if (opId) evidence.push(`operation:${opId}`);
    if (reqId) evidence.push(`request:${reqId}`);
    if (strongest !== event) evidence.push(`root-event:${strongest.kind || strongest.type || "event"}`);
    if (strongest.permission?.accessDenied) evidence.push(`iam:${strongest.permission.action || "AccessDenied"}`);
    if (strongest.source) evidence.push(`source:${strongest.source}`);

    const chain = [];
    if (eventName) chain.push({ stage:"socket.client_send", status:"observed", evidence:`ส่ง event ${eventName}${opId ? ` (${opId})` : ""}` });
    const handlerStart = ordered.find((x) => x.type === "socket" && String(x.label || "").startsWith(`handler.start:${eventName}`));
    if (handlerStart) chain.push({ stage:"socket.server_handler", status:"started", evidence:"server รับ event เข้า handler แล้ว" });
    const authObservation = diagnosticAuthObservation(handlerStart);
    if (eventName && authObservation && authObservation.requestedTester === true && (Object.prototype.hasOwnProperty.call(authObservation, "testerPassPresented") || Object.prototype.hasOwnProperty.call(authObservation, "testerGranted"))) {
        const passState = authObservation.testerGranted
            ? "server granted tester auth"
            : (authObservation.testerPassPresented
                ? (authObservation.testerPassValid ? "server received a tester pass but tester grant was not active" : "server received an invalid tester pass")
                : "server did not receive a tester pass");
        chain.push({ stage:"tester.authentication", status:authObservation.testerGranted ? "granted" : "mismatch", evidence:`auth observation: requestedTester=true; ${passState}` });
    }
    const persistenceFailure = ordered.find((x) => x.source === "server" && (x.permission?.accessDenied || /dynamodb|persistence/i.test(String(x.type || "") + " " + String(x.kind || ""))) && diagnosticIsFailureEvent(x));
    if (persistenceFailure) chain.push({ stage:"server.persistence", status:"failed", evidence:diagnosticHumanLabel(persistenceFailure) });
    const ackFailure = ordered.find((x) => x.type === "socket" && String(x.label || "").startsWith("ack:") && x.detail?.ok === false);
    if (ackFailure) chain.push({ stage:"socket.server_response", status:"rejected", evidence:diagnosticHumanLabel(ackFailure) });
    if (diagnosticIsFailureEvent(event) && event !== ackFailure) chain.push({ stage:cause.stage, status:"reported", evidence:`client event ${event.kind}` });
    const disconnect = ordered.find((x) => x.type === "socket" && /disconnect|ack\.timeout/i.test(String(x.label || "")));
    if (disconnect) chain.push({ stage:diagnosticStageForItem(disconnect), status:"downstream", evidence:diagnosticHumanLabel(disconnect) });

    const downstreamEffects = [];
    const downstreamItems = ordered.filter((x) => String(x.time || "") > String(rootCauseAt || ""));
    for (const item of downstreamItems.slice(0, 20)) {
        const kind = String(item.kind || item.type || "");
        const label = String(item.label || item.message || "");
        if (/disconnect|ack\.timeout|navigation|window\.open|pagehide|visibility|request\.failed|request\.retry\.failed|unhandled_rejection/i.test(kind + " " + label)) {
            downstreamEffects.push({ time:item.time, stage:diagnosticStageForItem(item), evidence:diagnosticHumanLabel(item) });
        }
    }

    const serverHandshakeEvent = ordered.find((x) => x.type === "socket" && String(x.label || "") === "auth.handshake");
    const clientConnectEvent = ordered.find((x) => x.source === "client" && x.type === "socket" && String(x.label || "") === "connect" && x.detail?.authPresence);
    const authEvidence = {
        clientConnect: diagnosticAuthObservation(clientConnectEvent),
        serverHandshake: diagnosticAuthObservation(serverHandshakeEvent),
        serverHandler: diagnosticAuthObservation(handlerStart),
    };

    const correlation = {
        traceId: traceId || "",
        sessionId: sessionId || "",
        operationId: opId || "",
        requestId: reqId || "",
        clientRequestId: String(event.clientRequestId || event.context?.clientRequestId || "").slice(0, 120),
        roomId: String(event.roomId || event.context?.roomId || "").slice(0, 32),
    };

    let confidence = effective.confidence;
    if (strongest?.source === "server" && diagnosticEventCode(strongest) && strongest.source !== event.source) confidence = "high";
    if (effective.code === "UNCLASSIFIED" && candidates.length === 0) confidence = "low";

    let rootCause = strongest === event ? effective.explanation : `${effective.explanation} หลักฐานต้นเหตุที่สัมพันธ์ที่สุดคือ ${diagnosticHumanLabel(strongest)}`;
    const serverHandlerAuth = authEvidence.serverHandler;
    if (effective.code === "ACCOUNT_TOKEN_REQUIRED" && eventName === "join_room" && serverHandlerAuth?.requestedTester === true && serverHandlerAuth.testerGranted !== true) {
        const passState = serverHandlerAuth.testerPassPresented
            ? (serverHandlerAuth.testerPassValid ? "server ได้รับ tester pass แต่ไม่ได้ grant สิทธิ์ tester" : "server ได้รับ tester pass แต่ตรวจแล้วไม่ผ่าน")
            : "server ไม่ได้รับ tester pass ใน Socket.IO handshake";
        rootCause = `คำขอ join_room ถูกขอเป็นโหมดผู้ทดสอบ แต่ ${passState}; จากนั้น ACK ฝั่ง server ตอบ ${effective.code} จึงตกลงไปที่ account authentication path และถูกปฏิเสธ`;
    } else if (effective.code === "TESTER_PASS_INVALID" && eventName === "join_room" && serverHandlerAuth?.requestedTester === true) {
        rootCause = `server รับคำขอ join_room แบบ tester แต่ tester pass ไม่ผ่านการยืนยัน ทำให้การอนุญาตโหมดผู้ทดสอบถูกปฏิเสธ (${effective.code})`;
    }
    const nextStep = effective.code === "UNCLASSIFIED"
        ? "ไล่จาก timeline ตาม correlation ID โดยตรวจเหตุการณ์แรกที่เปลี่ยนสถานะจากสำเร็จเป็นผิดพลาด; ยังไม่ควรสรุปจากข้อความ generic เพียงอย่างเดียว"
        : (effective.code === "IAM_ACCESS_DENIED"
            ? "แก้ IAM action/resource ตามหลักฐาน AWS แล้วทดสอบ operation เดิมซ้ำจาก client เดิม"
            : "ใช้ Root Cause + Causal Chain + Correlation IDs ในรายงานนี้ตรวจต้นเหตุที่ event ต้นน้ำ ก่อนแก้ผลลัพธ์ปลายทาง");

    return {
        rootCause,
        causeCode: effective.code,
        failureStage: effective.stage,
        rootCauseSource: strongest.source || event.source || "unknown",
        confidence,
        firstFailureAt,
        rootCauseAt,
        lastSeenAt,
        evidence,
        relatedEventCount: relatedEvents.length,
        evidenceItemCount: ordered.length,
        correlation,
        authEvidence,
        blockingEvent: {
            id: String(strongest.id || ""),
            kind: String(strongest.kind || strongest.type || ""),
            source: String(strongest.source || ""),
            message: String(strongest.message || strongest.label || "").slice(0, 1000),
            code: diagnosticEventCode(strongest),
            stage: diagnosticStageForItem(strongest),
            time: String(strongest.time || ""),
        },
        causalChain: chain.slice(0, 10),
        downstreamEffects: downstreamEffects.slice(0, 10),
        timeline,
        competingSignals: candidates.slice(0, 4).map((c) => ({ kind:c.item.kind || c.item.type || "event", source:c.item.source || "", code:c.code, stage:c.stage, score:Math.round(c.score) })),
        causalImpact: causalGraph.impact,
        upstreamCauseIds: causalGraph.upstreamCauseIds,
        downstreamEffectIds: causalGraph.downstreamEffectIds,
        causalRootPath: causalGraph.rootPath,
        rootCauseCandidates: causalGraph.rootCauseCandidates || [],
        terminalEffects: causalGraph.terminalEffects || [],
        explicitCausalLinks: {
            upstream: causalGraph.upstreamCauseIds.slice(0, 12),
            downstream: causalGraph.downstreamEffectIds.slice(0, 12),
        },
        nextStep,
    };
}

function currentDiagnosticContext() {
    try { return diagnosticAsyncContext.getStore() || {}; } catch (_) { return {}; }
}

function addDiagnosticBreadcrumb({ source = "server", type = "server", label = "", traceId = "", sessionId = "", page = "server", detail = {} } = {}) {
    const event = {
        time: new Date().toISOString(),
        source: String(source).slice(0, 24),
        type: String(type).slice(0, 32),
        label: String(label).slice(0, 160),
        traceId: String(traceId || "").slice(0, 120),
        sessionId: String(sessionId || "").slice(0, 120),
        page: String(page || "server").slice(0, 48),
        detail: safeDiagnosticValue(detail),
    };
    diagnosticServerBreadcrumbs.push(event);
    if (diagnosticServerBreadcrumbs.length > DIAGNOSTIC_MAX_BREADCRUMBS) diagnosticServerBreadcrumbs.splice(0, diagnosticServerBreadcrumbs.length - DIAGNOSTIC_MAX_BREADCRUMBS);
    return event;
}

function relatedServerBreadcrumbs({ traceId = "", sessionId = "", limit = 60 } = {}) {
    if (!traceId && !sessionId) return [];
    const out = [];
    for (let i = diagnosticServerBreadcrumbs.length - 1; i >= 0 && out.length < limit; i--) {
        const b = diagnosticServerBreadcrumbs[i];
        if ((traceId && b.traceId === traceId) || (sessionId && b.sessionId === sessionId)) out.push(b);
    }
    return out.reverse();
}

const DIAGNOSTIC_EXPECTED_PERMISSIONS = [
    { action: "dynamodb:GetItem", reason: "อ่านข้อมูลบัญชี/สถานะระบบ" },
    { action: "dynamodb:PutItem", reason: "สร้าง/บันทึกข้อมูลระบบบางส่วน" },
    { action: "dynamodb:UpdateItem", reason: "แก้ชื่อ/สถิติ/สถานะบัญชี และ snapshot" },
    { action: "dynamodb:DeleteItem", reason: "ลบข้อมูลบัญชี/ข้อมูลเดิม" },
    { action: "dynamodb:BatchWriteItem", reason: "ล้าง/ลบข้อมูลหลายรายการ" },
    { action: "dynamodb:Query", reason: "อ่านบัญชี/สถิติ/ประวัติ" },
    { action: "dynamodb:Scan", reason: "ค้นหารายการทั้งหมดและล้างข้อมูล" },
    { action: "elasticbeanstalk:DescribeEnvironments", reason: "อ่าน Running version ของ Elastic Beanstalk (ถ้าตั้ง EB_ENVIRONMENT_NAME)" },
];

function trimDiagnosticText(value, max = DIAGNOSTIC_MAX_TEXT) {
    const text = value instanceof Error ? (value.stack || value.message || String(value)) : String(value ?? "");
    return text.slice(0, max);
}

function extractAwsPermissionFailure(text) {
    const raw = String(text || "");
    const actionMatch = raw.match(/(?:perform|action)[^\n]*?\b([a-z0-9-]+:[A-Za-z0-9]+)\b/);
    const action = actionMatch ? actionMatch[1] : "";
    const arnMatch = raw.match(/\bresource\s*[:=]?\s*(arn:[^\s"']+)/i);
    const resource = arnMatch ? arnMatch[1] : "";
    if (!action && !/AccessDenied|not authorized|UnauthorizedOperation/i.test(raw)) return null;
    return { action, resource, accessDenied: true };
}

function recordDiagnostic({ source = "server", kind = "error", page = "server", message = "", stack = "", file = "", line = 0, column = 0, status = 0, endpoint = "", data = "", context = null, state = null, breadcrumbs = null, traceId = "", sessionId = "", action = "", operation = "", roomId = "", requestId = "", clientRequestId = "", durationMs = 0, operationId = "", causalHint = null, fingerprint = "" } = {}) {
    const asyncCtx = currentDiagnosticContext();
    const fullText = trimDiagnosticText([message, stack, typeof data === "string" ? data : JSON.stringify(data || {})].filter(Boolean).join("\n"));
    const iam = extractAwsPermissionFailure(fullText);
    const eventTraceId = String(traceId || asyncCtx.traceId || makeDiagnosticId("tr")).slice(0, 120);
    const eventSessionId = String(sessionId || asyncCtx.sessionId || "").slice(0, 120);
    const eventAction = String(action || asyncCtx.action || inferDiagnosticAction(message)).slice(0, 120);
    const eventRoomId = String(roomId || asyncCtx.roomId || inferDiagnosticRoomId(fullText)).toUpperCase().slice(0, 12);
    const event = {
        id: makeDiagnosticId("err"),
        sequence: nextDiagnosticSequence(),
        time: new Date().toISOString(),
        source: String(source).slice(0, 32),
        kind: String(kind).slice(0, 48),
        page: String(page).slice(0, 48),
        message: trimDiagnosticText(message, 4000),
        stack: trimDiagnosticText(stack, 10000),
        file: sanitizeDiagnosticPath(file).slice(0, 500),
        line: Number(line) || 0,
        column: Number(column) || 0,
        status: Number(status) || 0,
        endpoint: sanitizeDiagnosticPath(endpoint).slice(0, 500),
        data: trimDiagnosticText(typeof data === "string" ? data : JSON.stringify(safeDiagnosticValue(data || {})), 4000),
        context: safeDiagnosticValue(context || {}),
        state: safeDiagnosticValue(state || {}),
        breadcrumbs: Array.isArray(breadcrumbs) ? breadcrumbs.slice(-80).map(safeDiagnosticValue) : [],
        serverBreadcrumbs: relatedServerBreadcrumbs({ traceId: eventTraceId, sessionId: eventSessionId, limit: 80 }),
        traceId: eventTraceId,
        sessionId: eventSessionId,
        action: eventAction,
        operation: String(operation || "").slice(0, 80),
        roomId: eventRoomId,
        requestId: String(requestId || asyncCtx.requestId || "").slice(0, 120),
        clientRequestId: String(clientRequestId || asyncCtx.clientRequestId || "").slice(0, 120),
        durationMs: Number(durationMs) || 0,
        operationId: String(operationId || context?.operationId || "").slice(0, 120),
        causalHint: safeDiagnosticValue(causalHint || {}),
        fingerprint: String(fingerprint || diagnosticFingerprint([kind, message, endpoint, status, diagnosticEventCode({ context })])).slice(0, 80),
        permission: iam ? { action: iam.action, resource: iam.resource, accessDenied: true } : null,
        serverInstance: { hostname: os.hostname(), pid: process.pid, uptimeSec: Math.round(process.uptime()), appVersion: getCachedAppVersion() },
    };
    event.analysis = buildDiagnosticAnalysis(event, [event]);
    diagnosticEvents.unshift(event);
    if (diagnosticEvents.length > DIAGNOSTIC_MAX_EVENTS) diagnosticEvents.length = DIAGNOSTIC_MAX_EVENTS;
    if (iam && iam.action) {
        const key = `${iam.action}|${iam.resource}`;
        const prev = diagnosticPermissionCounts.get(key) || { action: iam.action, resource: iam.resource, count: 0, firstSeen: event.time, lastSeen: event.time };
        prev.count += 1;
        prev.lastSeen = event.time;
        diagnosticPermissionCounts.set(key, prev);
    }
    return event;
}

function sanitizeBugReplayText(value, max = 12000) {
    return String(value ?? "").slice(-max);
}

function cleanupBugReplayJobs() {
    const cutoff = Date.now() - BUG_REPLAY_JOB_TTL_MS;
    for (const [id, job] of bugReplayJobs.entries()) {
        if (job.finishedAt && job.finishedAt < cutoff) bugReplayJobs.delete(id);
    }
    while (bugReplayJobs.size > BUG_REPLAY_MAX_JOBS) {
        const oldest = [...bugReplayJobs.entries()].sort((a,b) => (a[1].createdAtEpoch || 0) - (b[1].createdAtEpoch || 0))[0];
        if (!oldest) break;
        bugReplayJobs.delete(oldest[0]);
    }
}

function publicBugReplayJob(job) {
    if (!job) return null;
    return {
        runId: job.runId,
        status: job.status,
        mode: job.mode,
        continueOnFailure: !!job.continueOnFailure,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || null,
        currentScenarioIndex: Number.isInteger(job.currentScenarioIndex) ? job.currentScenarioIndex : -1,
        currentScenarioId: job.currentScenarioId || "",
        currentScenarioTitle: job.currentScenarioTitle || "",
        currentAction: job.currentAction || "",
        currentStepIndex: Number.isInteger(job.currentStepIndex) ? job.currentStepIndex : -1,
        currentTestPath: job.currentTestPath || "",
        completedScenarios: job.completedScenarios || 0,
        totalScenarios: job.totalScenarios || 0,
        completedSteps: job.completedSteps || 0,
        passedSteps: job.passedSteps || 0,
        failedSteps: job.failedSteps || 0,
        slowSteps: job.slowSteps || 0,
        totalSteps: job.totalSteps || 0,
        remainingSteps: job.remainingSteps || 0,
        failureCount: Number(job.totalFailureCount) || (Array.isArray(job.failures) ? job.failures.length : (job.failure ? 1 : 0)),
        failuresTruncated: (Number(job.totalFailureCount) || 0) > BUG_REPLAY_MAX_FAILURES,
        auditSummary: job.audit ? job.audit.summary() : null,
        phase2Reports: Array.isArray(job.phase2Reports) ? job.phase2Reports.slice(-12) : [],
        failures: Array.isArray(job.failures) ? job.failures.slice(0, BUG_REPLAY_MAX_FAILURES).map((failure) => ({
            eventId: failure.eventId || "",
            scenarioIndex: failure.scenarioIndex,
            scenarioId: failure.scenarioId,
            scenarioTitle: failure.scenarioTitle,
            action: failure.action,
            testPath: failure.testPath,
            stepIndex: failure.stepIndex,
            exitCode: failure.exitCode,
            signal: failure.signal,
            timedOut: !!failure.timedOut,
            durationMs: failure.durationMs,
        })) : [],
        stoppedByAdmin: !!job.stoppedByAdmin,
        failedScenario: job.failedScenario ? {
            index: job.failedScenario.index,
            id: job.failedScenario.id,
            title: job.failedScenario.title,
            action: job.failedScenario.action,
            description: job.failedScenario.description,
        } : null,
        failure: job.failure ? {
            eventId: job.failure.eventId || "",
            scenarioIndex: job.failure.scenarioIndex,
            scenarioId: job.failure.scenarioId,
            scenarioTitle: job.failure.scenarioTitle,
            action: job.failure.action,
            testPath: job.failure.testPath,
            stepIndex: job.failure.stepIndex,
            exitCode: job.failure.exitCode,
            signal: job.failure.signal,
            timedOut: !!job.failure.timedOut,
            durationMs: job.failure.durationMs,
            stdout: sanitizeBugReplayText(job.failure.stdout, 3000),
            stderr: sanitizeBugReplayText(job.failure.stderr, 5000),
        } : null,
        lastOutput: sanitizeBugReplayText(job.lastOutput, 3000),
    };
}

function recordBugReplayFailure({ runId, scenarioIndex, summary, failure, job }) {
    const diagnostic = recordDiagnostic({
        source: "server",
        kind: "bug_replay_failure",
        page: "admin",
        action: `bug-replay:${summary.id}`,
        operation: `bug_replay:${runId}`,
        operationId: runId,
        message: `Bug Replay พบความผิดปกติในขั้นตอน: ${summary.action} → ${failure.testPath || "unknown test"}`,
        stack: sanitizeBugReplayText([failure.stderr, failure.stdout].filter(Boolean).join("\n"), 10000),
        data: {
            runner: "admin-bug-replay",
            runId,
            scenarioIndex,
            scenarioId: summary.id,
            scenarioTitle: summary.title,
            action: summary.action,
            description: summary.description,
            stepIndex: failure.stepIndex,
            testPath: failure.testPath,
            exitCode: failure.exitCode,
            signal: failure.signal,
            timedOut: !!failure.timedOut,
            durationMs: failure.durationMs,
            stdout: sanitizeBugReplayText(failure.stdout, 5000),
            stderr: sanitizeBugReplayText(failure.stderr, 8000),
            mode: job.mode,
            completedScenarios: job.completedScenarios,
            completedSteps: job.completedSteps,
            failedSteps: job.failedSteps,
        },
        context: {
            code: "BUG_REPLAY_FAILED",
            failureStage: "bug_replay.scenario",
            scenarioId: summary.id,
            scenarioIndex,
            action: summary.action,
            testPath: failure.testPath || "",
            stepIndex: failure.stepIndex,
            runId,
            mode: job.mode,
        },
        causalHint: { failureStage:"bug_replay.scenario", causeCode:"BUG_REPLAY_FAILED", confidence:"high" },
        fingerprint: diagnosticFingerprint(["BUG_REPLAY_FAILED", summary.id, failure.testPath, failure.stderr || failure.stdout]),
    });
    return { ...failure, eventId: diagnostic.id, scenarioIndex, scenarioId: summary.id, scenarioTitle: summary.title, action: summary.action };
}

async function startBugReplayJob(mode = "all") {
    cleanupBugReplayJobs();
    if (bugReplayActiveRunId) {
        const active = bugReplayJobs.get(bugReplayActiveRunId);
        if (active && active.status === "running") return { ok:false, code:"BUG_REPLAY_ALREADY_RUNNING", job:publicBugReplayJob(active) };
        bugReplayActiveRunId = "";
    }
    const safeMode = mode === "deep" ? "deep" : (mode === "phase2" ? "phase2" : "all");
    const scenarios = listBugReplayScenarios(safeMode);
    const runId = makeDiagnosticId("replay");
    const job = {
        runId,
        createdAtEpoch: Date.now(),
        startedAt: new Date().toISOString(),
        status: "running",
        mode: safeMode,
        continueOnFailure: safeMode === "deep",
        totalScenarios: scenarios.length,
        currentScenarioIndex: -1,
        currentScenarioId: "",
        currentScenarioTitle: "",
        currentAction: "",
        currentStepIndex: -1,
        currentTestPath: "",
        completedScenarios: 0,
        completedSteps: 0,
        passedSteps: 0,
        failedSteps: 0,
        totalFailureCount: 0,
        slowSteps: 0,
        totalSteps: scenarios.reduce((n, s) => n + Number(s.testCount || 0), 0),
        remainingSteps: scenarios.reduce((n, s) => n + Number(s.testCount || 0), 0),
        stoppedByAdmin: false,
        failure: null,
        failures: [],
        failedScenario: null,
        lastOutput: "",
        cancelRequested: false,
        activeChild: null,
        phase2Reports: [],
        audit: createRuntimeAudit({ source:"bug-replay", runId, mode:safeMode, page:"admin" }),
    };
    bugReplayJobs.set(runId, job);
    bugReplayActiveRunId = runId;
    job.audit.record('runner', 'run.start', { runId, mode:safeMode, totalScenarios:job.totalScenarios, totalSteps:job.totalSteps });

    (async () => {
        try {
            for (let i = 0; i < scenarios.length; i += 1) {
                if (job.cancelRequested) {
                    job.status = "stopped";
                    job.stoppedByAdmin = true;
                    break;
                }
                const summary = scenarios[i];
                const scenario = getBugReplayScenario(summary.id);
                if (!scenario) throw new Error(`BUG_REPLAY_SCENARIO_NOT_FOUND:${summary.id}`);
                job.currentScenarioIndex = i;
                job.currentScenarioId = summary.id;
                job.currentScenarioTitle = summary.title;
                job.currentAction = summary.action;
                job.currentStepIndex = -1;
                job.audit.record('scenario', 'scenario.start', { index:i, id:summary.id, title:summary.title, action:summary.action, testCount:summary.testCount });
                job.currentTestPath = "";
                job.remainingSteps = scenarios.slice(i).reduce((n, s) => n + Number(s.testCount || 0), 0);

                const result = await runBugReplayScenario(scenario, {
                    timeoutMs: safeMode === "phase2" ? 60_000 : 25_000,
                    continueOnFailure: job.continueOnFailure,
                    shouldStop: () => !!job.cancelRequested,
                    audit: job.audit,
                    onTestStart: ({ child, testPath, stepIndex, totalSteps }) => {
                        job.activeChild = child;
                        job.audit.record('runner', 'child.spawn', { scenarioId:summary.id, testPath, stepIndex, totalSteps });
                        job.currentStepIndex = stepIndex;
                        job.currentTestPath = testPath;
                        job.lastOutput = `กำลังจำลอง: ${summary.title} → ${testPath} (${stepIndex + 1}/${totalSteps})`;
                    },
                    onOutput: ({ text, stream, testPath }) => {
                        const outputText = String(text || '');
                        if (safeMode === "phase2") {
                            const matches = outputText.match(/^PHASE2_RESULT:(\{.*\})$/gm) || [];
                            for (const line of matches.slice(-4)) {
                                try {
                                    const parsed = JSON.parse(line.slice('PHASE2_RESULT:'.length));
                                    job.phase2Reports.push({ testPath, result: parsed });
                                    if (job.phase2Reports.length > 12) job.phase2Reports.splice(0, job.phase2Reports.length - 12);
                                } catch (_) {}
                            }
                        }
                        job.lastOutput = `[${stream}] ${testPath}\n${sanitizeBugReplayText(outputText, 2500)}`;
                    },
                    onStep: (step) => {
                        job.completedSteps += 1;
                        if (step.ok) job.passedSteps += 1;
                        else job.failedSteps += 1;
                        if (Number(step.durationMs) >= 20_000) job.slowSteps += 1;
                        job.currentStepIndex = step.index;
                        job.currentTestPath = step.testPath;
                        job.remainingSteps = Math.max(0, job.totalSteps - job.completedSteps);
                        if (step.skipped) job.lastOutput = `⏭️ ข้ามตามข้อกำหนด: ${step.testPath}`;
                        else if (step.ok) job.lastOutput = `✅ ${step.testPath}`;
                    },
                });
                job.activeChild = null;
                job.audit.record('scenario', 'scenario.complete', { index:i, id:summary.id, ok:!!result.ok, stopped:!!result.stopped, stepCount:Array.isArray(result.steps) ? result.steps.length : 0, failures:Array.isArray(result.failures) ? result.failures.length : (result.failure ? 1 : 0) });

                const failures = Array.isArray(result.failures) ? result.failures : (result.failure ? [result.failure] : []);
                if (failures.length) {
                    for (const failure of failures) {
                        job.totalFailureCount += 1;
                        const failureWithDiagnostic = recordBugReplayFailure({ runId, scenarioIndex:i, summary, failure, job });
                        job.audit.addFinding('test', 'BUG_REPLAY_FAILURE', `Bug Replay failure: ${summary.id} / ${failure.testPath || 'unknown'}`, { scenarioId:summary.id, scenarioIndex:i, testPath:failure.testPath || '', stepIndex:failure.stepIndex, exitCode:failure.exitCode, signal:failure.signal, timedOut:!!failure.timedOut, eventId:failureWithDiagnostic.eventId }, 'error', 'bug-replay');
                        if (job.failures.length < BUG_REPLAY_MAX_FAILURES) job.failures.push(failureWithDiagnostic);
                        if (!job.failure) job.failure = failureWithDiagnostic;
                    }
                    job.failedScenario = summary;
                    job.lastOutput = `❌ พบ ${failures.length} ปัญหาใน scenario: ${summary.title}`;
                }

                if (!result.ok && result.stopped) {
                    job.status = "stopped";
                    job.stoppedByAdmin = true;
                    break;
                }
                if (!result.ok && !job.continueOnFailure) {
                    job.status = "failed";
                    break;
                }

                job.completedScenarios += 1;
                job.remainingSteps = Math.max(0, job.totalSteps - job.completedSteps);
                if (failures.length) {
                    job.lastOutput = job.continueOnFailure
                        ? `⚠️ ผ่านไปต่อหลังพบ ${failures.length} ปัญหาใน ${summary.title}`
                        : `❌ หยุดที่ ${summary.title}`;
                } else {
                    job.lastOutput = `✅ ผ่าน scenario: ${summary.title}`;
                }
            }
            if (job.status === "running") {
                job.status = job.cancelRequested ? "stopped" : (job.failedSteps > 0 ? "failed" : "passed");
                if (job.cancelRequested) job.stoppedByAdmin = true;
            }
            job.remainingSteps = Math.max(0, job.totalSteps - job.completedSteps);
            job.audit.record('runner', 'run.complete', { status:job.status, completedScenarios:job.completedScenarios, completedSteps:job.completedSteps, passedSteps:job.passedSteps, failedSteps:job.failedSteps, slowSteps:job.slowSteps });
            job.finishedAt = new Date().toISOString();
        } catch (err) {
            job.audit.addFinding('runner', 'BUG_REPLAY_RUNNER_ERROR', err?.message || String(err), { scenarioId:job.currentScenarioId, stepIndex:job.currentStepIndex }, 'critical', 'bug-replay');
            const diagnostic = recordDiagnostic({
                source:"server", kind:"bug_replay_runner_error", page:"admin",
                action:"bug-replay:runner", operation:`bug_replay:${runId}`, operationId:runId,
                message: err?.message || String(err), stack:err?.stack || "",
                context:{ code:"BUG_REPLAY_RUNNER_ERROR", failureStage:"bug_replay.runner", runId, mode:job.mode },
            });
            job.failure = { eventId:diagnostic.id, scenarioIndex:job.currentScenarioIndex, scenarioId:job.currentScenarioId, scenarioTitle:job.currentScenarioTitle, action:job.currentAction, testPath:job.currentTestPath, stepIndex:job.currentStepIndex, exitCode:null, signal:null, timedOut:false, durationMs:0, stdout:"", stderr:err?.stack || err?.message || String(err) };
            job.failedSteps += 1;
            job.status = "failed";
            job.finishedAt = new Date().toISOString();
        } finally {
            job.activeChild = null;
            if (bugReplayActiveRunId === runId) bugReplayActiveRunId = "";
            cleanupBugReplayJobs();
        }
    })();

    return { ok:true, job:publicBugReplayJob(job), scenarios };
}

function stopBugReplayJob(runId = "") {
    const id = String(runId || bugReplayActiveRunId || "");
    const job = bugReplayJobs.get(id);
    if (!job || job.status !== "running") return { ok:false, code:"BUG_REPLAY_NOT_RUNNING", job:publicBugReplayJob(job) };
    job.cancelRequested = true;
    if (job.activeChild) {
        try { job.activeChild.kill("SIGTERM"); } catch (_) {}
    }
    return { ok:true, job:publicBugReplayJob(job) };
}

function diagnosticRequestAllowed(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = forwarded || req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const old = diagnosticClientRate.get(ip);
    if (!old || now - old.at >= 60_000) {
        diagnosticClientRate.set(ip, { at: now, count: 1 });
        return true;
    }
    if (old.count >= 20) return false;
    old.count += 1;
    return true;
}

function permissionChecklist() {
    const missing = Array.from(diagnosticPermissionCounts.values()).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
    return { expected: DIAGNOSTIC_EXPECTED_PERMISSIONS, observedFailures: missing };
}

// Existing server.js already logs most caught exceptions with console.error(). Mirror those
// messages into Diagnostics too, so individual handlers do not all need manual instrumentation.
const __wwOriginalConsoleError = console.error.bind(console);
let __wwReportingConsoleError = false;
console.error = (...args) => {
    __wwOriginalConsoleError(...args);
    if (__wwReportingConsoleError) return;
    const joined = args.map((x) => x instanceof Error ? (x.stack || x.message) : String(x ?? "")).join(" ");
    if (!/(AccessDenied|Unauthorized|Exception|\berror\b|failed|ล้มเหลว|ไม่สำเร็จ|ขาดสิทธิ์)/i.test(joined)) return;
    try {
        __wwReportingConsoleError = true;
        recordDiagnostic({ source:"server", kind:"server_log_error", page:"server", message:joined });
    } finally {
        __wwReportingConsoleError = false;
    }
};

// เฟส 0 (bot-autonomous-ai-phases.md): เอนจินให้บอทเล่นเองอัตโนมัติ — ตอนนี้ยังเป็น no-op
// (ดูรายละเอียดใน botEngine.js) เตรียม require ไว้ก่อนให้เฟสถัดไปเรียก runBotsFor(...) ได้เลย
const { runBotsFor } = require("./botEngine");

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
    });
});

app.get("/ready", (req, res) => {
    const baseReady = appBootReady && !appDraining && roomRecoveryHealthy;
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

const MAINTENANCE_FALLBACK_HTML = '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>เซิร์ฟเวอร์ปิดอยู่</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f19;color:#fff;font-family:sans-serif;text-align:center"><div><div style="font-size:48px">🔧</div><h1>เซิร์ฟเวอร์กำลังปิด</h1><p>กรุณารอสักครู่</p></div><script>setInterval(function(){fetch("/api/config",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){if(d&&d.serverOpen===true){try{["ww_joinedRoom","ww_lastRoom","ww_token","ww_host_room","ww_host_token","ww_bot_tokens"].forEach(function(k){localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch(e){}location.replace("/")}}).catch(function(){})},4000)</script></body></html>';
let maintenanceHtmlCache = null;
function getMaintenanceHtml() {
    if (maintenanceHtmlCache === null) {
        try {
            maintenanceHtmlCache = fs.readFileSync(path.join(__dirname, "public", "maintenance.html"), "utf8");
        } catch (e) {
            console.error("[server-control] อ่าน public/maintenance.html ไม่ได้ ใช้หน้าสำรองแทน:", e.message);
            maintenanceHtmlCache = MAINTENANCE_FALLBACK_HTML;
        }
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
        provider: String(meta.provider || "password"),
        googleSub: String(meta.googleSub || "").slice(0, 256),
        email: String(meta.email || "").trim().toLowerCase().slice(0, 320),
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
    if (ADMIN_TAB_AUTH_ENFORCED) return null;
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
function normalizeAdminEmail(value) { return String(value || "").trim().toLowerCase(); }
function isAllowedAdminGoogleClaims(claims) {
    const email = normalizeAdminEmail(claims?.email);
    const verified = claims?.email_verified === true || String(claims?.email_verified || "").toLowerCase() === "true";
    return !!email && verified && ADMIN_GOOGLE_EMAILS.includes(email);
}

// Generic request tracing: correlate browser -> HTTP -> server -> database without changing game payloads.
app.use((req, res, next) => {
    const traceId = String(req.headers["x-ww-diagnostic-trace-id"] || makeDiagnosticId("tr")).slice(0, 120);
    const sessionId = String(req.headers["x-ww-client-session-id"] || "").slice(0, 120);
    const clientRequestId = String(req.headers["x-ww-client-request-id"] || "").slice(0, 120);
    const action = String(req.headers["x-ww-diagnostic-action"] || "").slice(0, 120);
    const requestId = makeDiagnosticId("srvreq");
    const startedAt = Date.now();
    req.__wwDiagnostic = { traceId, sessionId, clientRequestId, action, requestId, startedAt };
    if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) {
        res.setHeader("X-WW-Diagnostic-Trace-Id", traceId);
        res.setHeader("X-WW-Server-Request-Id", requestId);
        res.setHeader("X-WW-Server-Instance", `${os.hostname()}:${process.pid}`);
        if (clientRequestId) res.setHeader("X-WW-Client-Request-Id", clientRequestId);
        addDiagnosticBreadcrumb({ source: "server", type: "http", label: `request.start ${req.method} ${sanitizeDiagnosticPath(req.path)}`, traceId, sessionId, page: "server", detail: { method: req.method, endpoint: sanitizeDiagnosticPath(req.path), requestId, clientRequestId } });
        res.once("finish", () => addDiagnosticBreadcrumb({ source: "server", type: "http", label: `request.end ${req.method} ${sanitizeDiagnosticPath(req.path)} ${res.statusCode}`, traceId, sessionId, page: "server", detail: { status: res.statusCode, durationMs: Date.now() - startedAt, requestId } }));
        res.once("close", () => {
            if (res.writableFinished) return;
            addDiagnosticBreadcrumb({ source: "server", type: "http", label: `request.close ${req.method} ${sanitizeDiagnosticPath(req.path)}`, traceId, sessionId, page: "server", detail: { durationMs: Date.now() - startedAt, requestId } });
        });
    }
    diagnosticAsyncContext.run({ traceId, sessionId, clientRequestId, action, requestId, roomId: inferDiagnosticRoomId(req.path) }, next);
});

app.use("/api/admin", (req, res, next) => {
    if (req.path === "/login" || req.path === "/session" || req.path === "/logout" || req.path === "/session/exchange") return next();
    if (!adminAuthRequired()) return res.status(503).json({ error: "admin_auth_not_configured", code: "ADMIN_AUTH_NOT_CONFIGURED" });
    if (isAdminSessionValid(req)) return next();
    return res.status(401).json({ error: "admin_auth_required", code: "ADMIN_AUTH_REQUIRED" });
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

    if (!serverClosed) return next();
    if (isTesterPassValid(testerTokenFromCookie(req.headers))) return next();

    const p = req.path;
    if (p === "/api/config" || p.startsWith("/api/admin/") || p.startsWith("/api/diagnostics/") || p.startsWith("/socket.io/") || p.startsWith("/diagnostics/share/") || CLOSED_ALLOWED_PATHS.has(p)) {
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
    // บัตรผ่านผู้ทดสอบสำหรับ Socket.IO ต้องผูกกับ "แท็บที่เปิดโหมดทดสอบ" เท่านั้น
    // ห้ามอ่าน ww_tp จาก cookie มาเลื่อนสิทธิ์ให้ socket ปกติ เพราะ HttpOnly cookie
    // เป็น cookie ระดับ origin เดียวกันทั้งเบราว์เซอร์: ถ้าแอดมินเปิดแท็บ Tester แล้ว
    // แท็บ index ปกติใน iPad/Chrome ใช้ origin เดียวกัน มันจะส่ง cookie ใบเดียวกันมาด้วย
    // และ socket ปกติจะถูกตีความเป็น tester → account_bootstrap/presence_hello ได้ IGNORED
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
        // แบบสุ่ม → join_room ไหลไป account auth เป็น ACCOUNT_TOKEN_REQUIRED
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
    addDiagnosticBreadcrumb({ source:"server", type:"socket", label:"auth.handshake", traceId:String(socket.data.diagnosticTraceId || ""), sessionId:String(socket.data.diagnosticSessionId || ""), page:"server", detail:{
        authObservation:{
            testerPassPresented,
            testerPassValid,
            testerPassBootstrapError:String(socket.data.testerPassBootstrapError || ""),
            hasAdminIntent:socket.handshake?.auth?.admin === true,
            hasDiagSession:!!socket.handshake?.auth?.wwDiagSessionId,
        },
    } });
    if (testerPassValid) socket.data.testerToken = authTpToken;
    // สมาชิกห้องผู้ทดสอบที่ไม่ได้ถือบัตร tp cookie (ดูคอมเมนต์ที่ isProtectedHandshake ด้านบน) — ถือว่าผ่านด่านปิด
    // เหมือนกับถือบัตรเลย (roomTesterAuth) ให้ครอบคลุมทั้ง handshake นี้และ event ต่างๆ ที่จะตามมา (ดู socket.on wrapper ด้านล่าง)
    if (isProtectedHandshake(socket)) socket.data.roomTesterAuth = true;
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
//   serverHash : server.js + botEngine.js + llmBotEngine.js (โค้ดบอท/กติกาเกมที่ผู้เล่นรู้สึกได้)
//   imageEpoch : เลขรุ่นรูปที่แอดมินกด (รูปที่อยู่บน S3/CDN อ่านเนื้อหาจาก server ไม่ได้ ต้องพึ่งเลขนี้)
// หน้าที่ของ version มีอย่างเดียว: "บอกว่ามีรุ่นใหม่" ให้หน้า index เอาไปเทียบ — ไม่ได้สั่ง reload อะไรทั้งสิ้น
const PUBLIC_DIR = path.join(__dirname, "public");
const CLIENT_CODE_EXTS = new Set([".html", ".htm", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest", ".txt", ".xml"]);
const CLIENT_ASSET_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".ogg", ".wav", ".m4a"]);
const CLIENT_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"]);
const VERSION_SKIP_FILES = new Set([path.join(PUBLIC_DIR, "admin.html"), path.join(PUBLIC_DIR, "maintenance.html")]);
const SERVER_CODE_FILES = ["server.js", "botEngine.js", "llmBotEngine.js"].map((f) => path.join(__dirname, f));
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

// hash ของหน้า Admin โดยเฉพาะ — admin.html เป็น inline JS/HTML จึงแยกจาก clientHash ของเกม
function computeAdminHash() {
    try { return crypto.createHash("sha1").update(fs.readFileSync(path.join(PUBLIC_DIR, "admin.html"))).digest("hex").slice(0, 12); } catch (_) { return "0"; }
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
        return crypto.createHash("sha1").update(`${p.client}|${p.assets}|${p.server}|${imageEpoch || ""}`).digest("hex").slice(0, 12);
    } catch (e) {
        return "0";
    }
}

// เลขรุ่นรูปที่ต่อท้าย URL รูปทุกใบ (?v=) = เลขที่แอดมินกด + hash ของรูปใน public/ (ถ้ามี) → เปลี่ยนรูปแล้ว URL เปลี่ยนเอง ไม่ต้องรอแอดมินกด
// (รูปบน S3/CDN ที่ server อ่านไม่ได้ ยังพึ่งเลขที่แอดมินกดเหมือนเดิม)
function currentImageVersion() {
    let assetsHash = "";
    try { assetsHash = refreshVersionParts().assets; } catch (e) { /* ไม่เป็นไร */ }
    // ไม่มีไฟล์ asset เลย (เช่น รูปทั้งหมดอยู่บน S3) hash ของกลุ่มว่างจะคงที่ — ตัดออกไม่ให้ URL มี ?v= โดยไม่จำเป็น
    const emptyAssetsHash = crypto.createHash("sha1").digest("hex").slice(0, 12);
    const parts = [imageEpoch || "", assetsHash && assetsHash !== emptyAssetsHash ? assetsHash : ""].filter(Boolean);
    return parts.join("-");
}

// IMAGE_BASE_URL: ต้นทางรูปภาพภายนอกของเกม (S3 หรือ CloudFront หน้า S3)
// โปรเจคนี้ตั้งใจให้รูปภาพทั้งหมดอยู่นอก deploy zip; เมื่อ IMAGE_BASE_URL ถูกตั้งแล้ว
// imgUrl()/wwImg() จะสร้าง URL แบบเต็มไปยัง S3/CDN และจะไม่มีการ fallback กลับไปหาไฟล์รูปใน public/
const IMAGE_BASE_URL = (process.env.IMAGE_BASE_URL || "").replace(/\/+$/, "");
if (!IMAGE_BASE_URL) {
    console.warn("IMAGE_BASE_URL is not configured; external S3/CDN images will not resolve until the Elastic Beanstalk environment variable is set.");
}

// imgUrl: ประกอบ URL รูปภาพจาก S3/CDN เท่านั้น = IMAGE_BASE_URL + path + (?v=<imageEpoch>)
// ถ้ายังไม่ได้ตั้ง IMAGE_BASE_URL จะคืนค่าว่างแทนการสร้าง /images/... เพื่อกัน client ไปดึงรูปจาก origin
function imgUrl(imgPath) {
    if (!IMAGE_BASE_URL) return "";
    const v = currentImageVersion();
    return `${IMAGE_BASE_URL}${imgPath}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
}

// ============================================================
// PLAYER STATS (อัตราชนะต่อผู้เล่น — เก็บบน DynamoDB)
// ============================================================
// ทำไมใช้ DynamoDB แทนไฟล์ในเครื่อง/S3:
//   - เกมนี้มีหลายห้องเล่นพร้อมกันได้ ถ้าเกมจบพร้อมกันหลายห้อง (หรือขยายไปหลาย EC2 instance ใน
//     อนาคต) การ "อ่านไฟล์/S3 object ทั้งก้อน -> แก้ -> เขียนทับ" มีโอกาส race กันได้ (อัปเดตของ
//     อีกฝั่งหายเพราะเขียนทับกัน) DynamoDB UpdateItem รองรับ "บวกเพิ่มทีละ 1" แบบ atomic ในตัว
//     (SET games = if_not_exists(games,:zero) + :one) ไม่มีทางชนกันได้เลยไม่ว่าจะยิงพร้อมกันกี่ครั้ง
//   - serverless/pay-per-request ไม่ต้องดูแลเซิร์ฟเวอร์ฐานข้อมูลเอง เหมาะกับ workload แบบนี้
//     (เขียนแค่ตอนจบเกม อ่านแค่ตอนเปิดป็อปอัป — ความถี่ต่ำมาก)
//
// เก็บด้วยคีย์ = "ชื่อที่แสดง" ของผู้เล่น (ชื่อเดียวกับที่ตั้งครั้งแรกในหน้า index.html/แก้ได้ทีหลัง
// ผ่าน admin.html เท่านั้น) โดยสิทธิ์ admin แยกจาก Game Account และต้องผ่าน HttpOnly admin session — ข้อจำกัดที่รู้อยู่แล้ว: เปลี่ยน
// ชื่อ = เริ่มสถิติใหม่ภายใต้ชื่อนั้น (ไม่ merge ของเก่าให้อัตโนมัติ), ชื่อซ้ำกันระหว่างคนละคนจะ
// "ใช้สถิติร่วมกัน" — ยอมรับ trade-off นี้เพราะไม่ใช้ระบบ account
//
// ต้องสร้างตารางเองครั้งเดียวบน AWS ก่อนใช้งาน (ดูขั้นตอนละเอียดใน README หัวข้อ "สถิติผู้เล่น"):
//   ชื่อตาราง: ตั้งเองได้ ใส่ไว้ที่ env var DYNAMODB_STATS_TABLE (ค่าเริ่มต้น "WerewolfPlayerStats")
//   Partition key: "playerName" (String)
//   Sort key:      "statKey"    (String) — เก็บ 2 แบบต่อผู้เล่นในตารางเดียวกัน:
//                    - "TOTAL"        แถวสรุปรวมทุกเกม (games/wins รวม)
//                    - "ROLE#<role>"  แถวแยกต่ออาชีพ 1 แถว (games/wins เฉพาะตอนเล่นอาชีพนั้น)
//                  แยกเป็นคนละแถวแบน ๆ แทนซ้อน map เดียวกัน เพราะ atomic increment ทำกับแถวแบน ๆ
//                  ตรงไปตรงมาที่สุด ไม่ต้องกังวลว่า map ยังไม่ถูกสร้างตอน increment ครั้งแรก แล้วดึง
//                  สถิติผู้เล่น 1 คนกลับมาทีเดียวด้วย Query ตาม playerName (partition key) ได้เลย
//   Billing mode: On-demand (pay-per-request) พอสำหรับ workload นี้ ไม่ต้องตั้ง provisioned capacity
//   IAM: instance role ของ Elastic Beanstalk environment ต้องมีสิทธิ์ dynamodb:UpdateItem,
//        dynamodb:Query บน ARN ของตารางนี้ (แบบเดียวกับที่ต้องเพิ่ม elasticbeanstalk:DescribeEnvironments
//        ให้ตอนตั้งค่า EB_ENVIRONMENT_NAME ด้านล่าง)
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand, QueryCommand, PutCommand, ScanCommand, GetCommand, BatchWriteCommand, DeleteCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

const STATS_TABLE_NAME = process.env.DYNAMODB_STATS_TABLE || "WerewolfPlayerStats";
const EB_ENVIRONMENT_NAME = String(process.env.EB_ENVIRONMENT_NAME || "").trim();

const rooms = {};

// ============================================================
// DURABLE ROOM SNAPSHOTS / RECOVERY
// ============================================================
// rooms ยังคงอยู่ใน RAM เพื่อความเร็ว แต่ snapshot ของห้องที่ยัง active จะถูกเก็บใน DynamoDB
// เป็นระยะ และถูกโหลดกลับก่อนรับ socket หลัง Node restart/deploy โดยใช้ token ของผู้เล่น/โฮสต์
// เป็นตัวตนถาวรแทน socket.id ซึ่งเปลี่ยนทุกครั้งที่ reconnect
//
// ใช้ตารางเดิมเป็นค่าเริ่มต้นเพื่อไม่ต้องเพิ่ม IAM/table ใหม่ทันที:
//   DYNAMODB_ROOMS_TABLE -> ตารางสำหรับห้องโดยเฉพาะ (แนะนำเมื่อระบบโต)
//   ถ้าไม่ตั้ง -> ใช้ DYNAMODB_STATS_TABLE เดิมที่โปรเจกต์มีอยู่แล้ว
// ปิดชั่วคราวได้ด้วย ROOM_PERSISTENCE_ENABLED=false (เหมาะเฉพาะ local dev)
const ROOM_PERSISTENCE_ENABLED = process.env.ROOM_PERSISTENCE_ENABLED !== "false";
const ROOM_PERSISTENCE_TABLE = process.env.DYNAMODB_ROOMS_TABLE || STATS_TABLE_NAME;
const ROOM_SNAPSHOT_STAT_KEY = "ROOM_SNAPSHOT";
const ROOM_INDEX_STAT_KEY = "ROOM_INDEX";
const ROOM_KEY_PREFIX = "__ROOM__:";
const ROOM_SNAPSHOT_SCHEMA = 1;
const ROOM_PERSISTENCE_DEBOUNCE_MS = Math.max(250, Number(process.env.ROOM_PERSISTENCE_DEBOUNCE_MS) || 750);
const ROOM_PERSISTENCE_SCAN_MS = Math.max(750, Number(process.env.ROOM_PERSISTENCE_SCAN_MS) || 1500);
const ROOM_RECOVERY_TIMEOUT_MS = Math.max(2000, Number(process.env.ROOM_RECOVERY_TIMEOUT_MS) || 8000);
const ROOM_RECOVERY_TTL_MS = Math.max(60 * 60_000, Number(process.env.ROOM_RECOVERY_TTL_MS) || 7 * 24 * 60 * 60_000);
const ROOM_SNAPSHOT_MAX_BYTES = Math.min(380 * 1024, Math.max(100 * 1024, Number(process.env.ROOM_SNAPSHOT_MAX_BYTES) || 350 * 1024));

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
// REAL ACCOUNT IDENTITY — PHASE 1/2
// ============================================================
// Game Account แยกออกจาก room token อย่างชัดเจน:
//   - accountId    = ตัวตนถาวรของ Game Account
//   - accountToken = credential ของ Login Identity ฝั่ง client
//   - room token   = credential สำหรับ reconnect ผู้เล่น/โฮสต์ในห้องนั้น (แยกจากบัญชี)
//
// Temporary Account:
//   - accountType = temporary
//   - activity ต้องผ่าน server ก่อนจึงจะต่ออายุได้
//   - temporaryExpiresAt = last server-confirmed activity + 15 วัน
//   - หมดอายุแล้วลบข้อมูล account/stat/event ทั้งหมด; การกลับมาใหม่ได้ accountId ใหม่
//
// Phase 1/2 รองรับ Temporary Account + Google identity; Game Account ยังยึด accountId เป็นหลัก.
const ACCOUNTS_PARTITION_KEY = "__ACCOUNTS__";
const ACCOUNT_PROFILE_PREFIX = "ACCOUNT#";
const ACCOUNT_TOTAL_SUFFIX = "#TOTAL";
const ACCOUNT_ROLE_PREFIX = "#ROLE#";
const ACCOUNT_EVENT_PREFIX = "#EVENT#";
const ACCOUNT_IDENTITY_PREFIX = "IDENTITY#";
const ACCOUNT_IDENTITY_HASH_FIELD = "loginTokenHash";
const ACCOUNT_TYPE_TEMPORARY = "temporary";
const ACCOUNT_TEMPORARY_TTL_MS = 15 * 24 * 60 * 60 * 1000;
const ACCOUNT_ACTIVITY_PERSIST_MIN_MS = 5 * 60 * 1000;
const ACCOUNT_NAME_CHANGE_COOLDOWN_MS = 60 * 1000;
const ACCOUNT_GOOGLE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCOUNT_GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_GOOGLE_HANDOFF_TTL_MS = 90 * 1000;
const ACCOUNT_GOOGLE_IDENTITY_PREFIX = "IDENTITY#GOOGLE#";
const ACCOUNT_SESSION_PREFIX = "SESSION#";
const ACCOUNT_SESSION_BY_ACCOUNT_PREFIX = "ACCOUNT_SESSION#";
const ACCOUNT_MIGRATION_PREFIX = "MIGRATION#LEGACY#";
const GOOGLE_STATE_COOKIE = "ww_google_state";
const GOOGLE_HANDOFF_COOKIE = "ww_google_handoff";

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_CALLBACK_URL = String(process.env.GOOGLE_CALLBACK_URL || "").trim();
const GOOGLE_SCOPES = String(process.env.GOOGLE_SCOPES || "openid profile email").trim() || "openid profile email";
const AUTH_STATE_SECRET_ENV = process.env.AUTH_STATE_SECRET || "";
const AUTH_STATE_SECRET = AUTH_STATE_SECRET_ENV || crypto.createHash("sha256").update(`werewolf-auth-state:${process.env.AWS_REGION || "local"}:${process.pid}`).digest("hex");

const ADMIN_PANEL_PASSWORD = String(process.env.ADMIN_PANEL_PASSWORD || process.env.ADMIN_RESET_PASSWORD || "").trim();
const ADMIN_GOOGLE_EMAILS = String(process.env.ADMIN_GOOGLE_EMAILS || process.env.ADMIN_GOOGLE_EMAIL || "")
    .split(/[\s,;]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
const ADMIN_AUTH_CONFIGURED = !!ADMIN_PANEL_PASSWORD || ADMIN_GOOGLE_EMAILS.length > 0;
const ADMIN_TAB_AUTH_ENFORCED = ADMIN_GOOGLE_EMAILS.length > 0;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.createHash("sha256")
    .update(`werewolf-admin-session:${ADMIN_PANEL_PASSWORD}:${ADMIN_GOOGLE_EMAILS.join(",")}:${AUTH_STATE_SECRET}`)
    .digest("hex");
const ADMIN_SESSION_COOKIE = "ww_admin";
const ADMIN_GOOGLE_STATE_COOKIE = "ww_admin_google_state";
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_TAB_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_TAB_HANDOFF_TTL_MS = 5 * 60 * 1000;
const ADMIN_TAB_HANDOFF_PARTITION_KEY = "__ADMIN_TAB_HANDOFF__";
const adminTabHandoffMemory = new Map();
const adminTabSessionRevoked = new Map();
function adminGoogleStateCookieName(tabId) {
    const safe = sanitizeAdminTabId(tabId);
    if (!safe) return ADMIN_GOOGLE_STATE_COOKIE;
    const suffix = crypto.createHash("sha256").update(safe).digest("hex").slice(0, 24);
    return `${ADMIN_GOOGLE_STATE_COOKIE}_${suffix}`;
}
const accountProfileCache = new Map();
const accountActivityDbAt = new Map();
const accountRenameAt = new Map();
let accountDbWarnedAt = 0;

// GLOBAL PAGE PRESENCE — ผู้เล่นถือว่าออนไลน์ถ้ายังเปิดหน้าเกมไว้และหน้าอยู่เบื้องหน้า
const accountPresence = new Map(); // accountId -> Map(socketId, { page, visible, lastPing, roomId, isHost })
const PRESENCE_STALE_MS = 70_000;

function setAccountPresenceSocket(accountId, socketId, data = {}) {
    const id = normalizeAccountId(accountId);
    if (!id || !socketId) return;
    let set = accountPresence.get(id);
    if (!set) { set = new Map(); accountPresence.set(id, set); }
    set.set(socketId, {
        page: String(data.page || "unknown").slice(0, 24),
        name: sanitizeName(data.name, ""),
        visible: data.visible !== false,
        lastPing: Date.now(),
        roomId: String(data.roomId || "").toUpperCase(),
        isHost: !!data.isHost,
    });
}
function updateAccountPresenceSocket(socketId, data = {}) {
    for (const [accountId, set] of accountPresence) {
        if (!set.has(socketId)) continue;
        const old = set.get(socketId) || {};
        set.set(socketId, { ...old, ...data, name: data.name !== undefined ? sanitizeName(data.name, old.name || "") : (old.name || ""), lastPing: Date.now() });
        return accountId;
    }
    return "";
}
function removeAccountPresenceSocket(socketId) {
    for (const [accountId, set] of accountPresence) {
        if (!set.delete(socketId)) continue;
        if (!set.size) accountPresence.delete(accountId);
        return accountId;
    }
    return "";
}
function getVisibleAccountPresence(accountId) {
    const id = normalizeAccountId(accountId);
    const set = accountPresence.get(id);
    if (!set) return [];
    const now = Date.now();
    const out = [];
    for (const [socketId, entry] of set) {
        if (now - Number(entry.lastPing || 0) > PRESENCE_STALE_MS) {
            set.delete(socketId);
            continue;
        }
        if (!entry.visible) continue;
        out.push({ socketId, page: entry.page || "unknown", name: entry.name || "", roomId: entry.roomId || "", isHost: !!entry.isHost, connected: true });
    }
    if (!set.size) accountPresence.delete(id);
    return out;
}

function normalizeAccountId(accountId) {
    const value = String(accountId || "").trim();
    if (!value || value.length > 128) return "";
    return value.replace(/[^A-Za-z0-9._:-]/g, "_");
}
function normalizeAccountToken(accountToken) {
    const value = String(accountToken || "").trim();
    if (!value || value.length > 256) return "";
    return value;
}

// OAuth return target must remain a local path. Never accept an absolute URL or protocol-relative
// target here, otherwise a signed OAuth state could be turned into an open redirect.
function normalizeReturnTo(value = "/") {
    const raw = String(value || "/").trim();
    if (!raw || raw.length > 1024 || raw[0] !== "/" || raw.startsWith("//") || raw.includes("\\")) return "/";
    try {
        const u = new URL(raw, "https://werewolf.local");
        if (u.origin !== "https://werewolf.local" || u.username || u.password) return "/";
        return `${u.pathname || "/"}${u.search || ""}`;
    } catch (_) {
        return "/";
    }
}
function hashAccountToken(accountToken) {
    const token = normalizeAccountToken(accountToken);
    return token ? crypto.createHash("sha256").update(token).digest("hex") : "";
}
function generateAccountId() {
    return crypto.randomUUID ? crypto.randomUUID() : `${genId()}-${genId()}-${genId()}`;
}

const TEMPORARY_NAME_LEFT = [
    "หมาป่าจันทรา", "หมาป่าดาวตก", "หมาป่าเมฆา", "หมาป่าพราย", "หมาป่าคราม",
    "นักล่าเงา", "ผู้เฝ้าราตรี", "ผู้เดินทาง", "ผู้พิทักษ์ป่า", "นักพเนจร",
    "จิ้งจอกเงิน", "อีกาดำ", "กวางดาว", "แมวดาว", "เหยี่ยวราตรี",
];
const TEMPORARY_NAME_RIGHT = ["อรุณ", "จันทรา", "สายหมอก", "เงา", "ประกาย", "สายลม", "พายุ", "ดาวเหนือ", "คืนวัน", "แสงดาว"];
function randomTemporaryDisplayName() {
    const left = TEMPORARY_NAME_LEFT[Math.floor(Math.random() * TEMPORARY_NAME_LEFT.length)];
    const right = TEMPORARY_NAME_RIGHT[Math.floor(Math.random() * TEMPORARY_NAME_RIGHT.length)];
    const suffix = Math.floor(1000 + Math.random() * 9000);
    return sanitizeName(`${left}${right}#${suffix}`, "ผู้เล่น");
}
function accountProfileKey(accountId) {
    const id = normalizeAccountId(accountId);
    return id ? `${ACCOUNT_PROFILE_PREFIX}${id}` : "";
}
function accountIdentityKey(tokenHash) {
    const hash = String(tokenHash || "").trim();
    return hash ? `${ACCOUNT_IDENTITY_PREFIX}${hash}` : "";
}
function logAccountDbWarning(e) {
    const now = Date.now();
    if (now - accountDbWarnedAt < 30_000) return;
    accountDbWarnedAt = now;
    console.error("[accounts] บัญชีใช้ DynamoDB ไม่ได้:", e?.name, e?.message);
}
function buildTemporaryExpiry(nowMs = Date.now()) {
    return new Date(nowMs + ACCOUNT_TEMPORARY_TTL_MS).toISOString();
}
function isTemporaryExpired(profile, nowMs = Date.now()) {
    if (!profile || profile.accountType !== ACCOUNT_TYPE_TEMPORARY) return false;
    const expires = Date.parse(profile.temporaryExpiresAt || "");
    return Number.isFinite(expires) && expires <= nowMs;
}
function accountPublicProfile(profile) {
    if (!profile) return null;
    const type = profile.accountType || ACCOUNT_TYPE_TEMPORARY;
    return {
        accountId: normalizeAccountId(profile.accountId || String(profile.statKey || "").replace(/^ACCOUNT#/, "")),
        displayName: sanitizeName(profile.currentName || "ผู้เล่น", "ผู้เล่น"),
        accountType: type,
        provider: profile.provider || (type === "google" ? "google" : "temporary"),
        googleLinked: type === "google" || profile.provider === "google",
        status: profile.status || "active",
        createdAt: profile.createdAt || profile.firstSeen || null,
        lastSeenAt: profile.lastSeen || null,
        temporaryExpiresAt: type === ACCOUNT_TYPE_TEMPORARY ? (profile.temporaryExpiresAt || null) : null,
    };
}

function hmacState(payloadPart, secret = AUTH_STATE_SECRET) {
    return b64urlEncode(crypto.createHmac("sha256", secret).update(payloadPart).digest());
}

function createSignedState(payload, secret = AUTH_STATE_SECRET) {
    const body = b64urlEncode(JSON.stringify(payload));
    return `v1.${body}.${hmacState(body, secret)}`;
}

function verifySignedState(token, secret = AUTH_STATE_SECRET) {
    if (typeof token !== "string" || !token) return null;
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

function setHttpOnlyCookie(res, name, value, maxAgeMs, secure, pathValue = "/") {
    const parts = [
        `${name}=${encodeURIComponent(String(value || ""))}`,
        `Path=${pathValue}`,
        `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
        "HttpOnly",
        "SameSite=Lax",
    ];
    if (secure) parts.push("Secure");
    appendSetCookie(res, parts.join("; "));
}

function clearHttpOnlyCookie(res, name, secure, pathValue = "/") {
    const parts = [`${name}=`, `Path=${pathValue}`, "Max-Age=0", "HttpOnly", "SameSite=Lax"];
    if (secure) parts.push("Secure");
    appendSetCookie(res, parts.join("; "));
}

function googleCallbackUrlIsAllowed() {
    if (!GOOGLE_CALLBACK_URL) return false;
    try {
        const u = new URL(GOOGLE_CALLBACK_URL);
        if (u.protocol === "https:") return true;
        return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
    } catch (_) {
        return false;
    }
}

function googleIsConfigured() {
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CALLBACK_URL && AUTH_STATE_SECRET_ENV && googleCallbackUrlIsAllowed());
}

function googleJwksUrl() {
    return "https://www.googleapis.com/oauth2/v3/certs";
}

// Small, bounded HTTPS JSON/form client used only for direct Google OAuth/OIDC calls.
// Do not use a third-party auth proxy/intermediary here. A finite timeout is important on
// Elastic Beanstalk/CloudFront so an upstream Google/network stall cannot leave the callback
// hanging until the CDN returns a generic 504.
function requestJsonHttps(targetUrl, { method = "GET", headers = {}, form = null, body = null, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(String(targetUrl)); }
        catch (_) { reject(Object.assign(new Error("invalid upstream URL"), { code: "GOOGLE_UPSTREAM_INVALID_URL" })); return; }
        if (u.protocol !== "https:") {
            reject(Object.assign(new Error("upstream must use HTTPS"), { code: "GOOGLE_UPSTREAM_HTTPS_REQUIRED" }));
            return;
        }

        let payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
        if (form && typeof form === "object") {
            payload = Buffer.from(new URLSearchParams(Object.entries(form).map(([k, v]) => [String(k), String(v ?? "")])).toString(), "utf8");
        }

        const requestHeaders = {
            Accept: "application/json",
            "User-Agent": "Werewolf-Online-TH/GoogleOAuth",
            ...headers,
        };
        if (payload) {
            if (!requestHeaders["Content-Type"] && !requestHeaders["content-type"]) {
                requestHeaders["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
            }
            requestHeaders["Content-Length"] = payload.length;
        }

        let settled = false;
        let overallTimer = null;
        const finishResolve = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(overallTimer);
            resolve(value);
        };
        const finishReject = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(overallTimer);
            reject(err);
        };

        const req = https.request({
            protocol: u.protocol, hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`,
            method: String(method || "GET").toUpperCase(), headers: requestHeaders,
        }, (res) => {
            const chunks = [];
            let total = 0;
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                total += Buffer.byteLength(chunk, "utf8");
                if (total <= maxBytes) chunks.push(chunk);
                else {
                    const err = Object.assign(new Error("upstream response too large"), { code: "GOOGLE_UPSTREAM_RESPONSE_TOO_LARGE" });
                    finishReject(err);
                    try { req.destroy(err); } catch (_) {}
                }
            });
            res.on("end", () => {
                if (settled) return;
                const raw = chunks.join("");
                let data = null;
                try { data = raw ? JSON.parse(raw) : {}; }
                catch (_) {
                    finishReject(Object.assign(new Error("upstream returned invalid JSON"), { code: "GOOGLE_UPSTREAM_INVALID_JSON", status: res.statusCode || 0 }));
                    return;
                }
                if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                    const upstreamCode = String(data?.error || data?.error_description || "").slice(0, 120);
                    finishReject(Object.assign(new Error(`Google upstream HTTP ${res.statusCode}`), {
                        code: "GOOGLE_UPSTREAM_HTTP_ERROR", status: res.statusCode || 0, upstreamCode,
                    }));
                    return;
                }
                finishResolve(data);
            });
        });

        overallTimer = setTimeout(() => {
            const err = Object.assign(new Error("Google upstream request timed out"), { code: "GOOGLE_UPSTREAM_TIMEOUT" });
            try { req.destroy(err); } catch (_) {}
            finishReject(err);
        }, Math.max(1000, Number(timeoutMs) || 15000));

        req.setTimeout(Math.max(1000, Number(timeoutMs) || 15000), () => {
            const err = Object.assign(new Error("Google upstream socket timed out"), { code: "GOOGLE_UPSTREAM_TIMEOUT" });
            try { req.destroy(err); } catch (_) {}
            finishReject(err);
        });
        req.on("error", (err) => {
            finishReject(Object.assign(new Error("Google upstream request failed"), { code: err?.code === "GOOGLE_UPSTREAM_TIMEOUT" ? "GOOGLE_UPSTREAM_TIMEOUT" : "GOOGLE_UPSTREAM_NETWORK_ERROR" }));
        });
        if (payload) req.write(payload);
        req.end();
    });
}

function normalizeGoogleIssuer(value) {
    const issuer = String(value || "").replace(/\/$/, "");
    return issuer === "https://accounts.google.com" || issuer === "accounts.google.com" ? issuer : "";
}

function normalizeGoogleAudience(value) {
    if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
    return [String(value || "").trim()].filter(Boolean);
}

const googleJwksCache = new Map();
async function fetchGoogleJwk(kid, { forceRefresh = false } = {}) {
    const cached = !forceRefresh ? googleJwksCache.get(kid) : null;
    if (cached && cached.expiresAt > Date.now()) return cached.jwk;
    const data = await requestJsonHttps(googleJwksUrl());
    const keys = Array.isArray(data?.keys) ? data.keys : [];
    // Google rotates signing keys. Cache for a bounded period and refresh on a kid miss.
    const expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    keys.forEach((jwk) => { if (jwk?.kid) googleJwksCache.set(jwk.kid, { jwk, expiresAt }); });
    return keys.find((jwk) => jwk?.kid === kid) || null;
}

async function verifyGoogleIdToken(idToken, expectedNonce = "") {
    if (!googleIsConfigured()) throw Object.assign(new Error("Google is not configured"), { code: "GOOGLE_NOT_CONFIGURED" });
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) throw Object.assign(new Error("invalid Google token"), { code: "GOOGLE_TOKEN_INVALID" });
    let header, claims;
    try {
        header = JSON.parse(b64urlDecode(parts[0]));
        claims = JSON.parse(b64urlDecode(parts[1]));
    } catch (_) {
        throw Object.assign(new Error("invalid Google token"), { code: "GOOGLE_TOKEN_INVALID" });
    }
    if (header?.alg !== "RS256" || !header?.kid) throw Object.assign(new Error("unsupported Google token"), { code: "GOOGLE_TOKEN_INVALID" });
    let jwk = await fetchGoogleJwk(header.kid);
    if (!jwk) jwk = await fetchGoogleJwk(header.kid, { forceRefresh: true });
    if (!jwk) throw Object.assign(new Error("Google signing key not found"), { code: "GOOGLE_KEY_NOT_FOUND" });
    let publicKey;
    try {
        publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
        const verifier = crypto.createVerify("RSA-SHA256");
        verifier.update(`${parts[0]}.${parts[1]}`);
        verifier.end();
        const signature = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (!verifier.verify(publicKey, signature)) throw new Error("signature invalid");
    } catch (_) {
        throw Object.assign(new Error("Google token signature invalid"), { code: "GOOGLE_TOKEN_INVALID" });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = Number(claims.exp);
    const iat = Number(claims.iat);
    const audiences = normalizeGoogleAudience(claims.aud);
    const issuer = normalizeGoogleIssuer(claims.iss);
    const clientId = String(GOOGLE_CLIENT_ID);
    const sub = String(claims.sub || "").trim();
    const azpValid = !Array.isArray(claims.aud) || String(claims.azp || "") === clientId;
    if (!issuer || !audiences.includes(clientId) || !azpValid || !Number.isFinite(exp) || exp <= nowSec || !Number.isFinite(iat) || iat > nowSec + 60 || (expectedNonce && String(claims.nonce || "") !== String(expectedNonce))) {
        throw Object.assign(new Error("Google token claims invalid"), { code: "GOOGLE_TOKEN_INVALID" });
    }
    if (!sub) throw Object.assign(new Error("Google subject missing"), { code: "GOOGLE_SUBJECT_MISSING" });
    return { claims, providerSubject: sub };
}

function googleIdentitySubjectHash(providerSubject) {
    return crypto.createHash("sha256").update(String(providerSubject)).digest("hex");
}
function googleIdentityKey(providerSubject) {
    return `${ACCOUNT_GOOGLE_IDENTITY_PREFIX}${googleIdentitySubjectHash(providerSubject)}`;
}
function accountSessionKey(tokenHash) {
    return `${ACCOUNT_SESSION_PREFIX}${String(tokenHash || "")}`;
}
function accountSessionByAccountKey(accountId, tokenHash) {
    return `${ACCOUNT_SESSION_BY_ACCOUNT_PREFIX}${normalizeAccountId(accountId)}#${String(tokenHash || "")}`;
}
function accountLegacyMigrationKey(name) {
    const source = sanitizeName(name, "ผู้เล่น");
    const hash = crypto.createHash("sha256").update(source).digest("hex");
    return `${ACCOUNT_MIGRATION_PREFIX}${hash}`;
}

async function issueGoogleAccountSession(accountId) {
    const id = normalizeAccountId(accountId);
    if (!id) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    const doc = await getDynamoDocClient();
    for (let attempt = 0; attempt < 3; attempt++) {
        const raw = crypto.randomBytes(48).toString("base64url");
        const hash = hashAccountToken(raw);
        const now = new Date();
        const iso = now.toISOString();
        const expires = new Date(now.getTime() + ACCOUNT_GOOGLE_SESSION_TTL_MS).toISOString();
        const lookup = { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionKey(hash), accountId: id, tokenHash: hash, provider: "google", createdAt: iso, expiresAt: expires, updatedAt: iso };
        const marker = { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionByAccountKey(id, hash), accountId: id, tokenHash: hash, provider: "google", createdAt: iso, expiresAt: expires };
        try {
            await doc.send(new TransactWriteCommand({ TransactItems: [
                { Put: { TableName: STATS_TABLE_NAME, Item: lookup, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
                { Put: { TableName: STATS_TABLE_NAME, Item: marker, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
            ] }));
            return { token: raw, tokenHash: hash, expiresAt: expires };
        } catch (e) {
            if (e?.name !== "TransactionCanceledException" && e?.name !== "ConditionalCheckFailedException") throw e;
        }
    }
    throw Object.assign(new Error("cannot create account session"), { code: "ACCOUNT_SESSION_CREATE_FAILED" });
}

async function revokeAccountSession(accountId, accountToken) {
    const id = normalizeAccountId(accountId);
    const hash = hashAccountToken(accountToken);
    if (!id || !hash) return false;
    const doc = await getDynamoDocClient();
    await Promise.allSettled([
        doc.send(new DeleteCommand({ TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionKey(hash) } })),
        doc.send(new DeleteCommand({ TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionByAccountKey(id, hash) } })),
    ]);
    return true;
}

async function getAccountSessionByHash(tokenHash) {
    const hash = String(tokenHash || "");
    if (!hash) return null;
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({ TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionKey(hash) } }));
    return out.Item || null;
}

async function queryAccountSessionMarkers(accountId) {
    const id = normalizeAccountId(accountId);
    if (!id) return [];
    const doc = await getDynamoDocClient();
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
            ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": `${ACCOUNT_SESSION_BY_ACCOUNT_PREFIX}${id}#` },
            ExclusiveStartKey,
        }));
        items.push(...(out.Items || []));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

async function queryAccountGoogleIdentityItems(accountId) {
    const id = normalizeAccountId(accountId);
    if (!id) return [];
    const doc = await getDynamoDocClient();
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
            FilterExpression: "accountId = :accountId",
            ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": ACCOUNT_GOOGLE_IDENTITY_PREFIX, ":accountId": id },
            ExclusiveStartKey,
        }));
        items.push(...(out.Items || []));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

async function getAccountLegacyMigration(accountId, legacyName) {
    const source = sanitizeName(legacyName, "");
    if (!source) return null;
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountLegacyMigrationKey(source) },
    }));
    const item = out.Item || null;
    if (item && normalizeAccountId(item.accountId) !== normalizeAccountId(accountId)) return { ...item, conflict: true };
    return item;
}

async function queryAccountLegacyMigrationItems(accountId) {
    const id = normalizeAccountId(accountId);
    if (!id) return [];
    const doc = await getDynamoDocClient();
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
            ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": ACCOUNT_MIGRATION_PREFIX },
            FilterExpression: "accountId = :accountId",
            ExclusiveStartKey,
        }));
        items.push(...(out.Items || []));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

async function migrateLegacyPlayerToAccount(legacyName, accountId) {
    if (!beginGameDataWrite()) throw Object.assign(new Error("กำลังล้างข้อมูลเกม"), { code: "RESET_IN_PROGRESS" });
    try {
        const sourceName = sanitizeName(legacyName, "");
        const targetId = normalizeAccountId(accountId);
        if (!sourceName) throw Object.assign(new Error("missing legacy name"), { code: "LEGACY_NOT_FOUND" });
        if (!targetId) throw Object.assign(new Error("missing accountId"), { code: "ACCOUNT_NOT_FOUND" });

        const [sourceItems, targetProfile, migration] = await Promise.all([
            queryLegacyPlayerByName(sourceName),
            getAccountProfile(targetId, { forceFresh: true }),
            getAccountLegacyMigration(targetId, sourceName),
        ]);
        if (!sourceItems.length) throw Object.assign(new Error("legacy player not found"), { code: "LEGACY_NOT_FOUND" });
        if (!targetProfile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
        if (targetProfile.status === "deleted") throw Object.assign(new Error("account deleted"), { code: "ACCOUNT_DELETED" });
        if (migration?.conflict) throw Object.assign(new Error("legacy data already migrated to another account"), { code: "LEGACY_ALREADY_MIGRATED" });
        if (migration?.status === "done") {
            return { ok: true, changed: false, resumed: false, legacyName: sourceName, accountId: targetId, status: "done", events: migration.eventsCopied || 0 };
        }

        const reg = sourceItems.find((it) => String(it.statKey || "") === "REG") || {};
        const legacyTotal = sourceItems.find((it) => String(it.statKey || "") === "TOTAL");
        const legacyEvents = sourceItems.filter((it) => String(it.statKey || "").startsWith("EVENT#") && it.isTester !== true);
        const totalGames = Number.isFinite(Number(legacyTotal?.games)) ? Number(legacyTotal.games) : legacyEvents.filter((it) => it.type === "game_end").length;
        const totalWins = Number.isFinite(Number(legacyTotal?.wins)) ? Number(legacyTotal.wins) : legacyEvents.filter((it) => it.type === "game_end" && it.won === true).length;
        const totalLeaves = Number.isFinite(Number(legacyTotal?.leaves)) ? Number(legacyTotal.leaves) : legacyEvents.filter((it) => it.type === "game_end" && it.left === true).length;
        const roleRows = sourceItems.filter((it) => String(it.statKey || "").startsWith("ROLE#"));
        const migrationKey = accountLegacyMigrationKey(sourceName);
        const now = new Date().toISOString();

        if (!migration) {
            const tx = [
                { Put: {
                    TableName: STATS_TABLE_NAME,
                    Item: { playerName: ACCOUNTS_PARTITION_KEY, statKey: migrationKey, accountId: targetId, legacyName: sourceName, status: "pending", createdAt: now, updatedAt: now, eventsCopied: 0 },
                    ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)",
                }},
                { Update: {
                    TableName: STATS_TABLE_NAME,
                    Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: `${ACCOUNT_PROFILE_PREFIX}${targetId}${ACCOUNT_TOTAL_SUFFIX}` },
                    UpdateExpression: "ADD games :games, wins :wins, leaves :leaves",
                    ExpressionAttributeValues: { ":games": totalGames, ":wins": totalWins, ":leaves": totalLeaves },
                }},
                { Update: {
                    TableName: STATS_TABLE_NAME,
                    Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(targetId) },
                    UpdateExpression: "SET legacyMigratedAt = :now, legacyMigratedFrom = :source, legacyFirstSeen = :firstSeen, legacyLastSeen = :lastSeen, legacyJoinCount = :joinCount",
                    ExpressionAttributeValues: {
                        ":now": now,
                        ":source": sourceName,
                        ":firstSeen": reg.firstSeen || null,
                        ":lastSeen": reg.lastSeen || null,
                        ":joinCount": Number(reg.joinCount || 0),
                    },
                }},
            ];
            for (const role of roleRows) {
                const roleName = String(role.statKey || "").slice("ROLE#".length);
                if (!roleName) continue;
                tx.push({ Update: {
                    TableName: STATS_TABLE_NAME,
                    Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: `${ACCOUNT_PROFILE_PREFIX}${targetId}${ACCOUNT_ROLE_PREFIX}${roleName}` },
                    UpdateExpression: "ADD games :games, wins :wins, leaves :leaves",
                    ExpressionAttributeValues: { ":games": Number(role.games || 0), ":wins": Number(role.wins || 0), ":leaves": Number(role.leaves || 0) },
                }});
            }
            try {
                await getDynamoDocClient().then((doc) => doc.send(new TransactWriteCommand({ TransactItems: tx })));
            } catch (e) {
                if (e?.name === "TransactionCanceledException" || e?.name === "ConditionalCheckFailedException") {
                    const winner = await getAccountLegacyMigration(targetId, sourceName).catch(() => null);
                    if (!winner) throw e;
                    if (winner.conflict || normalizeAccountId(winner.accountId) !== targetId) throw Object.assign(new Error("legacy data already migrated to another account"), { code: "LEGACY_ALREADY_MIGRATED" });
                } else throw e;
            }
        }

        const doc = await getDynamoDocClient();
        const eventItems = legacyEvents.map((event) => {
            const sourceKey = String(event.statKey || "");
            const eventHash = crypto.createHash("sha256").update(`${sourceName}\n${sourceKey}`).digest("hex").slice(0, 40);
            return {
                playerName: ACCOUNTS_PARTITION_KEY,
                statKey: `${ACCOUNT_PROFILE_PREFIX}${targetId}${ACCOUNT_EVENT_PREFIX}LEGACY#${eventHash}`,
                accountId: targetId,
                type: event.type || "legacy_event",
                eventKind: event.eventKind || (event.left ? "game_leave" : (event.type === "game_end" ? "game_end" : "room_join")),
                displayName: sourceName,
                leaveReason: event.leaveReason || null,
                roomId: event.roomId || "",
                role: event.role || null,
                team: event.team || null,
                won: typeof event.won === "boolean" ? event.won : null,
                left: !!event.left,
                time: event.time || null,
                migratedFrom: sourceName,
                migratedSourceKey: sourceKey,
            };
        });
        await putItemsWithFallback(doc, eventItems);
        await doc.send(new UpdateCommand({
            TableName: STATS_TABLE_NAME,
            Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: migrationKey },
            UpdateExpression: "SET #status = :done, updatedAt = :now, eventsCopied = :events",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":done": "done", ":now": new Date().toISOString(), ":events": eventItems.length },
        }));
        accountProfileCache.delete(targetId);
        return { ok: true, changed: true, resumed: !!migration, legacyName: sourceName, accountId: targetId, status: "done", events: eventItems.length };
    } finally {
        endGameDataWrite();
    }
}

async function getAccountByGoogleIdentity(providerSubject) {
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({ TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: googleIdentityKey(providerSubject) } }));
    return out.Item || null;
}

async function getAccountProfile(accountId, { forceFresh = false } = {}) {
    const id = normalizeAccountId(accountId);
    if (!id) return null;
    if (!forceFresh && accountProfileCache.has(id)) return accountProfileCache.get(id);
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
    }));
    const item = out.Item || null;
    if (item) accountProfileCache.set(id, item);
    else accountProfileCache.delete(id);
    return item;
}

async function deleteAccountData(accountId, { reason = "expired", notify = true } = {}) {
    const id = normalizeAccountId(accountId);
    if (!id) return { ok: false, deletedRows: 0 };
    const doc = await getDynamoDocClient();
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
            ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": `${ACCOUNT_PROFILE_PREFIX}${id}` },
            ExclusiveStartKey,
        }));
        items.push(...(out.Items || []));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const profile = items.find((it) => it.statKey === accountProfileKey(id));
    const tokenHash = String(profile?.[ACCOUNT_IDENTITY_HASH_FIELD] || "");
    const profileKeys = items.map((it) => ({ playerName: ACCOUNTS_PARTITION_KEY, statKey: it.statKey }));
    const extraDeletes = [];
    if (tokenHash) extraDeletes.push({ playerName: ACCOUNTS_PARTITION_KEY, statKey: accountIdentityKey(tokenHash) });

    // สำรวจ identity/session/migration ให้ครบก่อนเริ่มลบจริง เพื่อถ้าการ query ส่วนใดล้มเหลว
    // จะไม่เกิดสถานะ "ลบ profile ไปแล้ว แต่ credential/identity ยังตกค้าง" จากการ cleanup ครึ่งทาง
    try {
        const [sessionMarkers, googleIdentityItems, migrationItems] = await Promise.all([
            queryAccountSessionMarkers(id),
            queryAccountGoogleIdentityItems(id),
            queryAccountLegacyMigrationItems(id),
        ]);
        sessionMarkers.forEach((it) => {
            if (it.tokenHash) extraDeletes.push({ playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionKey(it.tokenHash) });
            extraDeletes.push({ playerName: ACCOUNTS_PARTITION_KEY, statKey: it.statKey });
        });
        googleIdentityItems.forEach((it) => extraDeletes.push({ playerName: ACCOUNTS_PARTITION_KEY, statKey: it.statKey }));
        migrationItems.forEach((it) => extraDeletes.push({ playerName: ACCOUNTS_PARTITION_KEY, statKey: it.statKey }));
    } catch (e) {
        logAccountDbWarning(e);
        throw Object.assign(new Error("account related identity cleanup failed"), { code: "ACCOUNT_CLEANUP_FAILED" });
    }

    const allKeys = [...profileKeys, ...extraDeletes];
    if (allKeys.length) await deleteItemsWithFallback(doc, allKeys);
    accountProfileCache.delete(id);
    accountActivityDbAt.delete(id);
    accountRenameAt.delete(id);
    const presence = accountPresence.get(id);
    if (presence && notify) {
        for (const [sid] of presence) {
            const sock = io.sockets.sockets.get(sid);
            try { if (sock?.connected) sock.emit("account_deleted", { reason, expired: reason === "expired" }); } catch (_) {}
            setTimeout(() => { try { sock?.disconnect(true); } catch (_) {} }, 20);
        }
        accountPresence.delete(id);
    }
    return { ok: true, deletedRows: allKeys.length };
}

async function createTemporaryAccount(accountToken, name = "") {
    const tokenHash = hashAccountToken(accountToken);
    if (!tokenHash) throw Object.assign(new Error("missing account token"), { code: "ACCOUNT_TOKEN_REQUIRED" });
    const doc = await getDynamoDocClient();
    const identityKey = accountIdentityKey(tokenHash);

    const id = generateAccountId();
    const displayName = sanitizeName(name, "") || randomTemporaryDisplayName();
    const now = new Date();
    const iso = now.toISOString();
    const expiry = new Date(now.getTime() + ACCOUNT_TEMPORARY_TTL_MS).toISOString();
    const item = {
        playerName: ACCOUNTS_PARTITION_KEY,
        statKey: accountProfileKey(id),
        accountId: id,
        accountType: ACCOUNT_TYPE_TEMPORARY,
        provider: "temporary",
        [ACCOUNT_IDENTITY_HASH_FIELD]: tokenHash,
        currentName: displayName,
        aliases: [],
        status: "active",
        firstSeen: iso,
        createdAt: iso,
        lastSeen: iso,
        lastActivityAt: iso,
        temporaryExpiresAt: expiry,
        updatedAt: iso,
        joinCount: 0,
        games: 0,
        wins: 0,
        leaves: 0,
        isTester: false,
        loginIdentityKey: identityKey,
    };
    const identityItem = {
        playerName: ACCOUNTS_PARTITION_KEY,
        statKey: identityKey,
        accountId: id,
        provider: "temporary",
        createdAt: iso,
        updatedAt: iso,
    };

    try {
        await doc.send(new TransactWriteCommand({
            TransactItems: [
                { Put: { TableName: STATS_TABLE_NAME, Item: identityItem, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
                { Put: { TableName: STATS_TABLE_NAME, Item: item, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
            ],
        }));
    } catch (e) {
        // Concurrent first-open: another tab/instance won the same token mapping.
        // Read the winner rather than creating a second Game Account.
        let winnerId = "";
        try {
            const winner = await doc.send(new GetCommand({
                TableName: STATS_TABLE_NAME,
                Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: identityKey },
            }));
            winnerId = normalizeAccountId(winner.Item?.accountId || "");
        } catch (_) {}
        if (winnerId) {
            const winnerProfile = await getAccountProfile(winnerId, { forceFresh: true });
            if (winnerProfile) return winnerProfile;
        }
        throw e;
    }

    accountProfileCache.set(id, item);
    accountActivityDbAt.set(id, now.getTime());
    return item;
}

async function verifyAccountLogin(accountId, accountToken) {
    let id = normalizeAccountId(accountId);
    const token = normalizeAccountToken(accountToken);
    if (!token) return { ok: false, code: "ACCOUNT_TOKEN_REQUIRED", profile: null, accountId: id };
    const tokenHash = hashAccountToken(token);
    const doc = await getDynamoDocClient();
    let session = null;

    if (!id) {
        const linked = await doc.send(new GetCommand({
            TableName: STATS_TABLE_NAME,
            Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountIdentityKey(tokenHash) },
        }));
        id = normalizeAccountId(linked.Item?.accountId || "");
        if (!id) {
            session = await getAccountSessionByHash(tokenHash);
            id = normalizeAccountId(session?.accountId || "");
        }
    }

    let profile = id ? await getAccountProfile(id, { forceFresh: true }) : null;
    if (!profile) return { ok: true, code: "ACCOUNT_NOT_FOUND", profile: null, accountId: "" };
    if (profile.status === "deleted") return { ok: false, code: "ACCOUNT_DELETED", profile, accountId: id };
    if (isTemporaryExpired(profile)) return { ok: false, code: "ACCOUNT_EXPIRED", profile, accountId: id };

    const storedHash = String(profile[ACCOUNT_IDENTITY_HASH_FIELD] || "");
    let authenticated = false;
    if (storedHash && storedHash.length === tokenHash.length) {
        try { authenticated = crypto.timingSafeEqual(Buffer.from(storedHash), Buffer.from(tokenHash)); } catch (_) { authenticated = false; }
    }
    if (!authenticated) {
        session = session || await getAccountSessionByHash(tokenHash);
        if (session && normalizeAccountId(session.accountId) === id && session.provider === "google") {
            const exp = Date.parse(session.expiresAt || "");
            if (!Number.isFinite(exp) || exp <= Date.now()) {
                await revokeAccountSession(id, token).catch(() => {});
                return { ok: false, code: "ACCOUNT_SESSION_EXPIRED", profile, accountId: id };
            }
            authenticated = true;
        }
    }
    if (!authenticated) {
        // บัญชีเก่าที่ไม่มี credential: รองรับ migration ครั้งเดียว แต่ต้องล็อก identity index ด้วยเงื่อนไข
        if (!storedHash && (profile.accountType || ACCOUNT_TYPE_TEMPORARY) === ACCOUNT_TYPE_TEMPORARY) {
            const identityKey = accountIdentityKey(tokenHash);
            try {
                await doc.send(new TransactWriteCommand({ TransactItems: [
                    { Put: { TableName: STATS_TABLE_NAME, Item: { playerName: ACCOUNTS_PARTITION_KEY, statKey: identityKey, accountId: id, provider: "temporary", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
                    { Update: { TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) }, UpdateExpression: "SET loginTokenHash = :hash, loginIdentityKey = :identityKey, accountType = if_not_exists(accountType, :temporary), provider = if_not_exists(provider, :provider), lastActivityAt = :now, lastSeen = :now, updatedAt = :now, temporaryExpiresAt = if_not_exists(temporaryExpiresAt, :expiry)", ExpressionAttributeValues: { ":hash": tokenHash, ":identityKey": identityKey, ":temporary": ACCOUNT_TYPE_TEMPORARY, ":provider": "temporary", ":now": new Date().toISOString(), ":expiry": buildTemporaryExpiry() } } },
                ] }));
                authenticated = true;
                profile = await getAccountProfile(id, { forceFresh: true });
            } catch (e) {
                if (e?.name !== "TransactionCanceledException" && e?.name !== "ConditionalCheckFailedException") throw e;
            }
        }
    }
    if (!authenticated) return { ok: false, code: "ACCOUNT_AUTH_FAILED", profile, accountId: id };
    accountProfileCache.set(id, profile);
    return { ok: true, code: "OK", profile, accountId: id, session: session || null };
}

async function docOrDynamo(existing, fn) {
    return fn(existing || await getDynamoDocClient());
}

async function touchOrCreateAccount(accountId, name, { accountToken = "", roomId = "", isHost = false, join = false } = {}) {
    if (!beginGameDataWrite()) throw Object.assign(new Error("กำลังล้างข้อมูลเกม"), { code: "RESET_IN_PROGRESS" });
    try {
        const token = normalizeAccountToken(accountToken);
        if (!token) return { ok: false, code: "ACCOUNT_TOKEN_REQUIRED", accountId: normalizeAccountId(accountId), currentName: sanitizeName(name, ""), profile: null };
        const requestedAccountId = normalizeAccountId(accountId || "");
        let identity = await verifyAccountLogin(requestedAccountId, token);
        if (identity.ok === false) {
            // Temporary Account ที่หมดอายุแล้วสามารถ cleanup แล้วออกบัญชีใหม่ได้ตามนโยบายเดิม
            if (identity.code === "ACCOUNT_EXPIRED" && identity.profile?.accountType === ACCOUNT_TYPE_TEMPORARY) {
                try {
                    await deleteAccountData(identity.accountId, { reason: "expired", notify: false });
                    identity = { ok: true, code: "ACCOUNT_EXPIRED_REPLACED", profile: null, accountId: "" };
                } catch (e) {
                    return { ok: false, code: "ACCOUNT_EXPIRY_CLEANUP_FAILED", accountId: identity.accountId, currentName: sanitizeName(identity.profile?.currentName || name, ""), profile: identity.profile };
                }
            } else {
                return { ...identity, currentName: sanitizeName(identity.profile?.currentName || name, "") };
            }
        }
        // accountId ที่ caller ส่งมาเป็นตัวตนเดิมของบัญชีแล้ว แต่ profile หายไปจากฐานข้อมูล
        // ห้ามตีความว่าเป็น first-open แล้ว createTemporaryAccount() ซ้ำด้วย credential เดิม
        // มิฉะนั้นการลบบัญชีจริงจะกลายเป็นการรีสร้างบัญชีเงียบ ๆ ทันทีเมื่อเปิดหน้าเกมใหม่
        if (!identity.profile && requestedAccountId) {
            return { ok: false, code: identity.code || "ACCOUNT_NOT_FOUND", accountId: requestedAccountId, currentName: sanitizeName(name, ""), profile: null };
        }
        let createdNow = false;
        if (!identity.profile) {
            identity.profile = await createTemporaryAccount(token, name);
            identity.accountId = identity.profile.accountId;
            createdNow = true;
        }
        const id = identity.accountId;
        const existing = identity.profile || {};
        if (existing.status === "suspended") return { ok: false, code: "ACCOUNT_SUSPENDED", accountId: id, currentName: existing.currentName || "", profile: existing };
        if (isTemporaryExpired(existing)) return { ok: false, code: "ACCOUNT_EXPIRED", accountId: id, currentName: existing.currentName || "", profile: existing };

        const existingName = sanitizeName(existing.currentName || "", "");
        const requestedName = sanitizeName(name, "");
        const effectiveName = existingName && existingName !== "ผู้เล่น" ? existingName : (requestedName || existingName || randomTemporaryDisplayName());
        const nowMs = Date.now();
        // createTemporaryAccount() already wrote a complete profile + identity index atomically.
        // On the very first bootstrap, do not immediately perform a second UpdateItem just to
        // refresh timestamps/name. That extra write used to turn a successful account creation
        // into ACCOUNT_PERSISTENCE_UNAVAILABLE when DynamoDB had a transient write problem,
        // leaving the client with no Account ID even though the account record already existed.
        const shouldPersistActivity = !createdNow && (!accountActivityDbAt.has(id) || nowMs - accountActivityDbAt.get(id) >= ACCOUNT_ACTIVITY_PERSIST_MIN_MS || join);
        if (shouldPersistActivity) {
            const doc = await getDynamoDocClient();
            const now = new Date(nowMs).toISOString();
            const accountType = existing.accountType || ACCOUNT_TYPE_TEMPORARY;
            const provider = existing.provider || (accountType === "google" ? "google" : "temporary");
            const values = {
                ":now": now, ":name": effectiveName, ":active": "active", ":emptyAliases": [],
                ":zero": 0, ":room": roomId || "", ":host": !!isHost, ":tester": false,
                ":temporary": ACCOUNT_TYPE_TEMPORARY, ":provider": provider,
            };
            // บัญชีเก่าบางรายการอาจมีชื่อ fallback จากระบบเดิมเป็น "ผู้เล่น"
            // อนุญาตให้ bootstrap ครั้งแรกแทนที่ fallback ได้ แต่ห้ามทับชื่อจริงที่ผู้เล่น/Admin ตั้งไว้แล้ว
            const nameAssignment = (!existingName || existingName === "ผู้เล่น") && requestedName && requestedName !== "ผู้เล่น"
                ? "currentName = :name"
                : "currentName = if_not_exists(currentName, :name)";
            let updateExpression =
                "SET firstSeen = if_not_exists(firstSeen, :now), createdAt = if_not_exists(createdAt, :now), " +
                nameAssignment + ", lastSeen = :now, lastActivityAt = :now, updatedAt = :now, " +
                "#status = if_not_exists(#status, :active), accountType = if_not_exists(accountType, :temporary), " +
                "provider = if_not_exists(provider, :provider), " +
                "aliases = if_not_exists(aliases, :emptyAliases), lastRoomId = :room, lastRoleType = :host, " +
                "isTester = if_not_exists(isTester, :tester), games = if_not_exists(games, :zero), wins = if_not_exists(wins, :zero), leaves = if_not_exists(leaves, :zero)";
            if (accountType === ACCOUNT_TYPE_TEMPORARY) updateExpression += ", temporaryExpiresAt = :expiry";
            if (accountType === ACCOUNT_TYPE_TEMPORARY) values[":expiry"] = buildTemporaryExpiry(nowMs);
            // DynamoDB rejects unused ExpressionAttributeValues. On the index/background bootstrap
            // path `join` is false, so do not send :one unless the UpdateExpression actually uses it.
            if (join) {
                values[":one"] = 1;
                updateExpression += " ADD joinCount :one";
            }
            const out = await doc.send(new UpdateCommand({
                TableName: STATS_TABLE_NAME,
                Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
                UpdateExpression: updateExpression,
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: values,
                ReturnValues: "ALL_NEW",
            }));
            identity.profile = out.Attributes || identity.profile;
            accountProfileCache.set(id, identity.profile);
            accountActivityDbAt.set(id, nowMs);
        }
        return { ok: true, accountId: id, currentName: sanitizeName(identity.profile?.currentName || effectiveName, effectiveName), profile: identity.profile };
    } finally {
        endGameDataWrite();
    }
}

async function ensureNormalAccountIdentity(accountId, name, meta = {}) {
    if (resetInProgress) return { ok: false, code: "RESET_IN_PROGRESS", accountId: normalizeAccountId(accountId), name: sanitizeName(name, "ผู้เล่น"), profile: null };
    if (meta && meta.isTester === true) return { ok: true, accountId: "", name: sanitizeName(name, "ผู้เล่น"), profile: null, testerIgnored: true };
    const token = normalizeAccountToken(meta.accountToken || "");
    if (!token) return { ok: false, code: "ACCOUNT_TOKEN_REQUIRED", accountId: normalizeAccountId(accountId), name: sanitizeName(name, "ผู้เล่น"), profile: null };
    try {
        const result = await touchOrCreateAccount(accountId, name, { ...meta, accountToken: token });
        if (!result.ok) return { ok: false, code: result.code, accountId: result.accountId, name: result.currentName || sanitizeName(name, "ผู้เล่น"), profile: result.profile };
        return { ok: true, accountId: result.accountId, name: result.currentName, profile: result.profile };
    } catch (e) {
        logAccountDbWarning(e);
        return { ok: false, code: "ACCOUNT_PERSISTENCE_UNAVAILABLE", accountId: normalizeAccountId(accountId), name: sanitizeName(name, "ผู้เล่น"), profile: null };
    }
}

async function renameOwnAccount(accountId, accountToken, newName) {
    const id = normalizeAccountId(accountId);
    const token = normalizeAccountToken(accountToken);
    if (!id || !token) throw Object.assign(new Error("account authentication required"), { code: "ACCOUNT_AUTH_FAILED" });
    const verification = await verifyAccountLogin(id, token);
    if (!verification.profile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    if (verification.ok === false) throw Object.assign(new Error("account unavailable"), { code: verification.code });
    if (verification.profile.status !== "active") throw Object.assign(new Error("account unavailable"), { code: "ACCOUNT_SUSPENDED" });
    const last = accountRenameAt.get(id) || 0;
    const remain = ACCOUNT_NAME_CHANGE_COOLDOWN_MS - (Date.now() - last);
    if (remain > 0) throw Object.assign(new Error(`กรุณารอ ${Math.ceil(remain / 1000)} วินาทีก่อนเปลี่ยนชื่ออีกครั้ง`), { code: "NAME_COOLDOWN", retryAfterMs: remain });
    const oldName = sanitizeName(verification.profile.currentName || "ผู้เล่น", "ผู้เล่น");
    const trimmed = sanitizeName(newName, "");
    if (!trimmed || trimmed === "ผู้เล่น") throw Object.assign(new Error("ชื่อไม่ถูกต้อง"), { code: "BAD_NAME" });
    if (trimmed === oldName) return { ok: true, accountId: id, name: oldName, changed: false, profile: verification.profile };
    await assertAccountNameAvailable(trimmed, id);
    const aliases = Array.isArray(verification.profile.aliases) ? verification.profile.aliases.slice(-30) : [];
    if (!aliases.includes(oldName)) aliases.push(oldName);
    const doc = await getDynamoDocClient();
    const now = new Date();
    const iso = now.toISOString();
    const isTemporary = (verification.profile.accountType || ACCOUNT_TYPE_TEMPORARY) === ACCOUNT_TYPE_TEMPORARY;
    const exprValues = { ":name": trimmed, ":aliases": aliases, ":now": iso };
    let updateExpression = "SET currentName = :name, aliases = :aliases, lastSeen = :now, lastActivityAt = :now, updatedAt = :now";
    if (isTemporary) { updateExpression += ", temporaryExpiresAt = :expiry"; exprValues[":expiry"] = buildTemporaryExpiry(now.getTime()); }
    const out = await doc.send(new UpdateCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
    }));
    const next = out.Attributes || { ...verification.profile, currentName: trimmed, aliases, lastSeen: iso, lastActivityAt: iso, ...(isTemporary ? { temporaryExpiresAt: buildTemporaryExpiry(now.getTime()) } : {}), updatedAt: iso };
    accountProfileCache.set(id, next);
    accountActivityDbAt.set(id, now.getTime());
    accountRenameAt.set(id, now.getTime());
    updateLiveAccountNames(id, trimmed);
    emitAccountEventToSockets(id, "name_updated_by_host", { name: trimmed, accountId: id });
    return { ok: true, accountId: id, name: trimmed, changed: true, profile: next };
}

async function touchAccountPresence(accountId, { roomId = "", name = "", isHost = false } = {}) {
    if (!beginGameDataWrite()) return;
    const id = normalizeAccountId(accountId);
    if (!id) { endGameDataWrite(); return; }
    try {
        const cached = accountProfileCache.get(id);
        if (cached?.status === "suspended" || cached?.status === "deleted") return;
        const nowMs = Date.now();
        const shouldPersist = !accountActivityDbAt.has(id) || nowMs - accountActivityDbAt.get(id) >= ACCOUNT_ACTIVITY_PERSIST_MIN_MS;
        if (!shouldPersist) return;
        const doc = await getDynamoDocClient();
        const now = new Date(nowMs).toISOString();
        const currentType = cached?.accountType || ACCOUNT_TYPE_TEMPORARY;
        const exprValues = { ":now": now, ":room": roomId || "", ":host": !!isHost };
        let updateExpression = "SET lastSeen = :now, lastActivityAt = :now, updatedAt = :now, lastRoomId = :room, lastRoleType = :host";
        if (currentType === ACCOUNT_TYPE_TEMPORARY) { updateExpression += ", temporaryExpiresAt = :expiry"; exprValues[":expiry"] = buildTemporaryExpiry(nowMs); }
        const out = await doc.send(new UpdateCommand({
            TableName: STATS_TABLE_NAME,
            Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: exprValues,
            ReturnValues: "ALL_NEW",
        }));
        accountActivityDbAt.set(id, nowMs);
        if (out.Attributes) accountProfileCache.set(id, out.Attributes);
    } catch (e) {
        logAccountDbWarning(e);
    } finally {
        endGameDataWrite();
    }
}

async function bumpAccountStatsRow(doc, accountId, suffix, { won, left } = {}) {
    if (resetInProgress) return;
    const id = normalizeAccountId(accountId);
    if (!id) return;
    let updateExpression = "SET games = if_not_exists(games, :zero) + :one";
    if (left) updateExpression += ", leaves = if_not_exists(leaves, :zero) + :one";
    else if (won) updateExpression += ", wins = if_not_exists(wins, :zero) + :one";
    await doc.send(new UpdateCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: `${ACCOUNT_PROFILE_PREFIX}${id}${suffix}` },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
    }));
}

async function recordAccountGameStats(room, resultTeam) {
    if (!beginGameDataWrite()) return;
    try {
        const players = (room?.players || []).filter((p) => p && !p.isHost && !p.isBot && !p.isTester && (p.name || "").trim() && p.role && !hasImmediateLeaveRecorded(p, room));
        if (!players.length) return;
        try {
            const doc = await getDynamoDocClient();
            const nowMs = Date.now();
            const now = new Date(nowMs).toISOString();
            for (const p of players) {
                if (resetInProgress) return;
                const accountId = normalizeAccountId(p.accountId || "");
                if (!accountId) continue;
                const roleSuffix = `${ACCOUNT_ROLE_PREFIX}${p.role}`;
                const left = didLeaveGame(p, room);
                const won = !left && isWinner(p, resultTeam, room);
                await Promise.all([
                    bumpAccountStatsRow(doc, accountId, ACCOUNT_TOTAL_SUFFIX, { won, left }),
                    bumpAccountStatsRow(doc, accountId, roleSuffix, { won, left }),
                    (() => {
                        const profile = accountProfileCache.get(accountId);
                        const isTemporary = (profile?.accountType || ACCOUNT_TYPE_TEMPORARY) === ACCOUNT_TYPE_TEMPORARY;
                        const exprValues = { ":zero": 0, ":one": 1, ":win": won ? 1 : 0, ":leave": left ? 1 : 0, ":now": now };
                        let updateExpression = "SET games = if_not_exists(games, :zero) + :one, wins = if_not_exists(wins, :zero) + :win, leaves = if_not_exists(leaves, :zero) + :leave, lastPlayedAt = :now, lastSeen = :now, lastActivityAt = :now, updatedAt = :now";
                        if (isTemporary) { updateExpression += ", temporaryExpiresAt = :expiry"; exprValues[":expiry"] = buildTemporaryExpiry(nowMs); }
                        return doc.send(new UpdateCommand({ TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(accountId) }, UpdateExpression: updateExpression, ExpressionAttributeValues: exprValues }));
                    })(),
                    doc.send(new PutCommand({
                        TableName: STATS_TABLE_NAME,
                        Item: {
                            playerName: ACCOUNTS_PARTITION_KEY,
                            statKey: `${ACCOUNT_PROFILE_PREFIX}${accountId}${ACCOUNT_EVENT_PREFIX}${now}#${genId()}`,
                            accountId, type: "game_end", eventKind: "game_end", displayName: p.name.trim(), roomId: room.id || "",
                            role: p.role, team: teamOf(p.role), won, left, leaveReason: left ? "offline_threshold" : null, time: now,
                        },
                    })),
                ]);
            }
        } catch (e) {
            if (!resetInProgress) logAccountDbWarning(e);
        }
    } finally {
        endGameDataWrite();
    }
}

async function queryAllAccountProfiles() {
    const doc = await getDynamoDocClient();
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
            ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": ACCOUNT_PROFILE_PREFIX },
            ExclusiveStartKey,
        }));
        items.push(...(out.Items || []).filter((it) => {
            const sk = String(it.statKey || "");
            return sk.startsWith(ACCOUNT_PROFILE_PREFIX) && !sk.includes(ACCOUNT_EVENT_PREFIX) && !sk.endsWith(ACCOUNT_TOTAL_SUFFIX) && !sk.includes(ACCOUNT_ROLE_PREFIX);
        }));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    items.forEach((it) => accountProfileCache.set(String(it.accountId || it.statKey || "").replace(/^ACCOUNT#/, ""), it));
    return items;
}

async function queryLegacyPlayerByName(name) {
    const playerName = sanitizeName(name, "ผู้เล่น");
    const doc = await getDynamoDocClient();
    const out = await doc.send(new QueryCommand({
        TableName: STATS_TABLE_NAME,
        KeyConditionExpression: "playerName = :name",
        ExpressionAttributeValues: { ":name": playerName },
    }));
    return out.Items || [];
}

async function deleteTableItemsWithFallback(doc, tableName, keys) {
    if (!tableName || !keys.length) return;
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
        return;
    } catch (e) {
        const denied = /AccessDenied|not authorized|UnauthorizedOperation/i.test(String(e?.message || e));
        if (!denied) throw e;
        // บาง IAM policy อนุญาต DeleteItem แต่ไม่ได้อนุญาต BatchWriteItem.
        for (const key of keys) await doc.send(new DeleteCommand({ TableName: tableName, Key: key }));
    }
}

async function deleteItemsWithFallback(doc, keys) {
    return deleteTableItemsWithFallback(doc, STATS_TABLE_NAME, keys);
}

async function putItemsWithFallback(doc, items) {
    if (!items.length) return;
    try {
        await batchWriteWithRetry(doc, items.map((Item) => ({ PutRequest: { Item } })));
        return;
    } catch (e) {
        const denied = /AccessDenied|not authorized|UnauthorizedOperation/i.test(String(e?.message || e));
        if (!denied) throw e;
        for (const Item of items) await doc.send(new PutCommand({ TableName: STATS_TABLE_NAME, Item }));
    }
}

async function batchWriteWithRetry(doc, requests) {
    let pending = requests.slice();
    for (let i = 0; i < pending.length; i += 25) {
        let batch = pending.slice(i, i + 25);
        for (let attempt = 0; attempt < 7 && batch.length; attempt++) {
            const out = await doc.send(new BatchWriteCommand({ RequestItems: { [STATS_TABLE_NAME]: batch } }));
            batch = (out.UnprocessedItems && out.UnprocessedItems[STATS_TABLE_NAME]) || [];
            if (batch.length) await sleepMs(100 * 2 ** attempt);
        }
        if (batch.length) throw new Error("DynamoDB ยังประมวลผลรายการไม่ครบ");
    }
}

async function renameLegacyPlayer(oldName, newName) {
    if (!beginGameDataWrite()) throw Object.assign(new Error("กำลังล้างข้อมูลเกม"), { code: "RESET_IN_PROGRESS" });
    try {
    const from = String(oldName || "").trim();
    const to = sanitizeName(newName, from);
    if (!from) throw Object.assign(new Error("missing old name"), { code: "LEGACY_NOT_FOUND" });
    if (!to || from === to) return { changed: false, oldName: from, newName: to };
    const oldItems = await queryLegacyPlayerByName(from);
    if (!oldItems.length) throw Object.assign(new Error("legacy player not found"), { code: "LEGACY_NOT_FOUND" });
    const newItems = await queryLegacyPlayerByName(to);
    if (newItems.length) throw Object.assign(new Error("ชื่อใหม่นี้มีข้อมูลอยู่แล้ว"), { code: "NAME_IN_USE" });
    const modern = await queryAllAccountProfiles();
    if (modern.some((it) => String(it.currentName || "") === to)) throw Object.assign(new Error("ชื่อใหม่นี้มีบัญชีจริงอยู่แล้ว"), { code: "NAME_IN_USE" });
    const doc = await getDynamoDocClient();
    const puts = oldItems.map((item) => ({ PutRequest: { Item: { ...item, playerName: to } } }));
    await putItemsWithFallback(doc, puts.map((x) => x.PutRequest.Item));
    const deletes = oldItems.map((item) => ({ DeleteRequest: { Key: { playerName: from, statKey: item.statKey } } }));
    try {
        await deleteItemsWithFallback(doc, deletes.map((x) => x.DeleteRequest.Key));
    } catch (e) {
        console.error("[legacy-rename] คัดลอกแล้วแต่ลบข้อมูลชื่อเดิมไม่สำเร็จ:", e.name, e.message);
        throw Object.assign(new Error("คัดลอกข้อมูลไปชื่อใหม่แล้ว แต่ลบชื่อเดิมไม่สำเร็จ — ห้ามกดซ้ำจนกว่าจะตรวจฐานข้อมูล"), { code: "LEGACY_RENAME_PARTIAL" });
    }
    return { changed: true, oldName: from, newName: to, moved: oldItems.length };
    } finally {
        endGameDataWrite();
    }
}

async function deleteLegacyPlayer(name) {
    if (!beginGameDataWrite()) throw Object.assign(new Error("กำลังล้างข้อมูลเกม"), { code: "RESET_IN_PROGRESS" });
    try {
    const playerName = String(name || "").trim();
    if (!playerName) throw Object.assign(new Error("missing name"), { code: "LEGACY_NOT_FOUND" });
    const items = await queryLegacyPlayerByName(playerName);
    if (!items.length) throw Object.assign(new Error("legacy player not found"), { code: "LEGACY_NOT_FOUND" });
    const doc = await getDynamoDocClient();
    const deletes = items.map((item) => ({ DeleteRequest: { Key: { playerName, statKey: item.statKey } } }));
    await deleteItemsWithFallback(doc, deletes.map((x) => x.DeleteRequest.Key));
    return { deleted: true, name: playerName, count: items.length };
    } finally {
        endGameDataWrite();
    }
}

async function queryAccountDetails(accountId) {
    const id = normalizeAccountId(accountId);
    if (!id) return null;
    const doc = await getDynamoDocClient();
    const items = [];
    let ExclusiveStartKey;
    do {
        const out = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
            ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": `${ACCOUNT_PROFILE_PREFIX}${id}` },
            ExclusiveStartKey,
        }));
        items.push(...(out.Items || []));
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const profile = items.find((it) => it.statKey === accountProfileKey(id)) || null;
    if (!profile) return null;
    const total = items.find((it) => it.statKey === `${ACCOUNT_PROFILE_PREFIX}${id}${ACCOUNT_TOTAL_SUFFIX}`) || { games: 0, wins: 0, leaves: 0 };
    const roles = items.filter((it) => String(it.statKey || "").includes(ACCOUNT_ROLE_PREFIX)).map((it) => {
        const sk = String(it.statKey || "");
        const role = sk.split(ACCOUNT_ROLE_PREFIX)[1] || "";
        return { role, team: teamOf(role), teamLabel: roleTeamLabels[teamOf(role)] || "", ...rateBreakdown(it) };
    }).sort((a,b) => b.games - a.games);
    const events = items.filter((it) => String(it.statKey || "").includes(ACCOUNT_EVENT_PREFIX)).map((it) => ({
        type: it.type,
        eventKind: it.eventKind || (it.left ? "game_leave" : (it.type === "game_end" ? "game_end" : "room_join")),
        roomId: it.roomId || "",
        time: it.time,
        displayName: it.displayName || profile.currentName || "",
        leaveReason: it.leaveReason || null,
        isHost: false,
        isTester: false,
        role: it.role || null,
        team: it.team || null,
        teamLabel: it.team ? (roleTeamLabels[it.team] || "") : null,
        won: typeof it.won === "boolean" ? it.won : null,
        left: !!it.left,
    })).sort((a,b) => String(b.time).localeCompare(String(a.time)));
    const live = getLiveSessionsForAccount(id);
    return {
        accountId: id,
        name: profile.currentName || "",
        aliases: Array.isArray(profile.aliases) ? Array.from(new Set(profile.aliases.filter(Boolean))) : [],
        status: profile.status || "active",
        accountType: profile.accountType || ACCOUNT_TYPE_TEMPORARY,
        provider: profile.provider || "temporary",
        temporaryExpiresAt: profile.temporaryExpiresAt || null,
        firstSeen: profile.firstSeen || null,
        lastSeen: profile.lastSeen || null,
        createdAt: profile.createdAt || null,
        lastPlayedAt: profile.lastPlayedAt || null,
        joinCount: profile.joinCount || 0,
        ...rateBreakdown(total),
        roles,
        events,
        live,
    };
}

function getLiveSessionsForAccount(accountId) {
    const id = normalizeAccountId(accountId);
    if (!id) return [];
    const out = [];
    for (const roomId in rooms) {
        const room = rooms[roomId];
        (room.players || []).forEach((p) => {
            if (!p || p.isBot || p.isTester || normalizeAccountId(p.accountId || "") !== id) return;
            if (p.isHost) {
                const ids = (room.hostIds || []).filter((sid) => io.sockets.sockets.get(sid)?.connected);
                ids.forEach((sid) => out.push({ roomId, socketId: sid, isHost: true, connected: true }));
            } else if (isPlayerCurrentlyConnected(p)) {
                out.push({ roomId, socketId: p.id, isHost: false, connected: true });
            }
        });
    }
    // รวม presence จากหน้า index ด้วย — ผู้เล่นยังไม่เข้าห้องก็ถือว่าออนไลน์ได้
    const presence = getVisibleAccountPresence(id);
    const seen = new Set(out.map((x) => x.socketId));
    presence.forEach((x) => {
        if (seen.has(x.socketId)) return;
        out.push(x);
        seen.add(x.socketId);
    });
    return out;
}

function emitAccountEventToSockets(accountId, event, payload) {
    const id = normalizeAccountId(accountId);
    if (!id) return;
    const sent = new Set();
    for (const roomId in rooms) {
        const room = rooms[roomId];
        (room.players || []).forEach((p) => {
            if (!p || p.isBot || p.isTester || normalizeAccountId(p.accountId || "") !== id) return;
            const ids = p.isHost ? (room.hostIds || []) : [p.id];
            ids.forEach((sid) => {
                if (sent.has(sid)) return;
                const sock = io.sockets.sockets.get(sid);
                if (sock?.connected) {
                    sock.emit(event, payload);
                    sent.add(sid);
                }
            });
        });
    }
}

function updateLiveAccountNames(accountId, newName) {
    const id = normalizeAccountId(accountId);
    if (!id) return 0;
    let changed = 0;
    for (const roomId in rooms) {
        const room = rooms[roomId];
        let touched = false;
        (room.players || []).forEach((p) => {
            if (!p || p.isBot || p.isTester || normalizeAccountId(p.accountId || "") !== id) return;
            p.accountId = id;
            if (p.name !== newName) {
                p.name = newName;
                changed++;
                touched = true;
            }
        });
        if (touched) io.to(roomId).emit("room_update", publicRoomView(room));
        if (touched) schedulePersistRoom(roomId, true);
    }
    return changed;
}

async function assertAccountNameAvailable(newName, excludeAccountId = "") {
    const target = sanitizeName(newName, "ผู้เล่น");
    const exclude = normalizeAccountId(excludeAccountId);
    const modern = await queryAllAccountProfiles();
    const modernHit = modern.find((it) => normalizeAccountId(it.accountId || String(it.statKey || "").replace(/^ACCOUNT#/, "")) !== exclude && String(it.currentName || "") === target);
    if (modernHit) throw Object.assign(new Error("ชื่อใหม่นี้มีบัญชีอยู่แล้ว"), { code: "NAME_IN_USE" });
    const legacy = await queryLegacyPlayerByName(target);
    if (legacy.length) throw Object.assign(new Error("ชื่อใหม่นี้มีข้อมูลผู้เล่นเดิมอยู่แล้ว"), { code: "NAME_IN_USE" });
    return target;
}

async function updateAccountName(accountId, newName) {
    if (!beginGameDataWrite()) throw Object.assign(new Error("กำลังล้างข้อมูลเกม"), { code: "RESET_IN_PROGRESS" });
    try {
    const id = normalizeAccountId(accountId);
    if (!id) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    const profile = await getAccountProfile(id, { forceFresh: true });
    if (!profile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    if (profile.status === "deleted") throw Object.assign(new Error("account deleted"), { code: "ACCOUNT_DELETED" });
    const oldName = sanitizeName(profile.currentName || "ผู้เล่น", "ผู้เล่น");
    const trimmed = sanitizeName(newName, oldName);
    if (trimmed === oldName) return { profile, name: oldName, changed: false };
    await assertAccountNameAvailable(trimmed, id);
    const aliases = Array.isArray(profile.aliases) ? profile.aliases.slice(-30) : [];
    if (!aliases.includes(oldName)) aliases.push(oldName);
    const doc = await getDynamoDocClient();
    const now = new Date().toISOString();
    const out = await doc.send(new UpdateCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
        UpdateExpression: "SET currentName = :name, aliases = :aliases, updatedAt = :now",
        ExpressionAttributeValues: { ":name": trimmed, ":aliases": aliases, ":now": now },
        ReturnValues: "ALL_NEW",
    }));
    const nextProfile = out.Attributes || { ...profile, currentName: trimmed, aliases, updatedAt: now };
    accountProfileCache.set(id, nextProfile);
    updateLiveAccountNames(id, trimmed);
    emitAccountEventToSockets(id, "name_updated_by_host", { name: trimmed, accountId: id });
    return { profile: nextProfile, name: trimmed, changed: true };
    } finally {
        endGameDataWrite();
    }
}

async function setAccountStatus(accountId, status) {
    if (!beginGameDataWrite()) throw Object.assign(new Error("กำลังล้างข้อมูลเกม"), { code: "RESET_IN_PROGRESS" });
    try {
    const id = normalizeAccountId(accountId);
    if (!id || !["active", "suspended", "deleted"].includes(status)) throw Object.assign(new Error("bad account status"), { code: "BAD_STATUS" });
    const profile = await getAccountProfile(id, { forceFresh: true });
    if (!profile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    // deleted เป็นสถานะจบแล้ว ไม่อนุญาตให้เปลี่ยนกลับเป็น active ผ่าน Admin
    if (profile.status === "deleted" && status === "active") {
        throw Object.assign(new Error("deleted account cannot be restored"), { code: "ACCOUNT_DELETED_FINAL" });
    }
    if (status === "deleted") {
        await deleteAccountData(id, { reason: "admin_deleted" });
        return { accountId: id, status: "deleted", deleted: true };
    }
    const now = new Date().toISOString();
    const doc = await getDynamoDocClient();
    const out = await doc.send(new UpdateCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
        UpdateExpression: "SET #status = :status, updatedAt = :now, statusAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status, ":now": now },
        ReturnValues: "ALL_NEW",
    }));
    const next = out.Attributes || { ...profile, status, updatedAt: now, statusAt: now };
    accountProfileCache.set(id, next);
    return next;
    } finally {
        endGameDataWrite();
    }
}


async function resetAccountStats(accountId) {
    if (!beginGameDataWrite()) throw Object.assign(new Error("กำลังล้างข้อมูลเกม"), { code: "RESET_IN_PROGRESS" });
    try {
    const id = normalizeAccountId(accountId);
    if (!id) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    const doc = await getDynamoDocClient();
    const out = await doc.send(new QueryCommand({
        TableName: STATS_TABLE_NAME,
        KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
        ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": `${ACCOUNT_PROFILE_PREFIX}${id}` },
    }));
    const items = out.Items || [];
    const profile = items.find((it) => it.statKey === accountProfileKey(id));
    if (!profile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    const deletes = items
        .filter((it) => it.statKey !== accountProfileKey(id) && !String(it.statKey || "").includes(ACCOUNT_EVENT_PREFIX))
        .map((it) => ({ DeleteRequest: { Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: it.statKey } } }));
    if (deletes.length) await batchWriteWithRetry(doc, deletes);
    const now = new Date().toISOString();
    const update = await doc.send(new UpdateCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
        UpdateExpression: "SET games = :zero, wins = :zero, leaves = :zero, updatedAt = :now",
        ExpressionAttributeValues: { ":zero": 0, ":now": now },
        ReturnValues: "ALL_NEW",
    }));
    accountProfileCache.set(id, update.Attributes || { ...profile, games: 0, wins: 0, leaves: 0, updatedAt: now });
    return { ok: true, accountId: id, deletedStatRows: deletes.length };
    } finally {
        endGameDataWrite();
    }
}

function disconnectAccountSessions(accountId, eventName, reason) {
    const id = normalizeAccountId(accountId);
    if (!id) return 0;
    let count = 0;
    const sent = new Set();
    const presence = accountPresence.get(id);
    if (presence) {
        for (const [sid] of presence) {
            if (sent.has(sid)) continue;
            const sock = io.sockets.sockets.get(sid);
            if (sock?.connected) {
                try { sock.emit(eventName, { reason: reason || "admin" }); } catch (_) {}
                sent.add(sid);
                count++;
                setTimeout(() => { try { sock.disconnect(true); } catch (_) {} }, 50);
            }
        }
        accountPresence.delete(id);
    }
    for (const roomId in rooms) {
        const room = rooms[roomId];
        (room.players || []).forEach((p) => {
            if (!p || p.isBot || p.isTester || normalizeAccountId(p.accountId || "") !== id) return;
            const ids = p.isHost ? (room.hostIds || []) : [p.id];
            ids.forEach((sid) => {
                if (sent.has(sid)) return;
                const sock = io.sockets.sockets.get(sid);
                if (sock?.connected) {
                    sock.emit(eventName, { reason: reason || "admin" });
                    sent.add(sid);
                    count++;
                    setTimeout(() => { try { sock.disconnect(true); } catch (_) {} }, 50);
                }
            });
        });
    }
    return count;
}

// สร้าง client แค่ครั้งเดียว (lazy) — resolve region สำหรับ AWS SDK โดยตรง
// ใช้ env AWS_REGION ก่อน และ fallback ไป EC2 instance metadata เมื่อรันบน Elastic Beanstalk
let dynamoDocClientPromise = null;
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
                    recordDiagnostic({
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

// บวกเพิ่ม 1 เกม ให้แถวใดแถวหนึ่งแบบ atomic — ใช้ทั้งกับแถว TOTAL และแถว ROLE#
// เกมนึงลงได้แค่ 1 ใน 2 ช่องเท่านั้นเสมอ (ไม่ใช่ทั้งคู่): "wins" ถ้าชนะแล้วไม่ได้ "ออก" กลางเกม,
// หรือ "leaves" ถ้า "ออก" กลางเกม (ดู didLeaveGame ด้านล่าง) — ถ้า won=false และ left=false ก็แปลว่า
// "แพ้ปกติ" ซึ่งไม่ต้องมีช่องเก็บแยก เพราะคำนวณย้อนกลับได้เสมอจาก games - wins - leaves (ดู
// /api/player-stats, /api/admin/player-history ด้านล่าง)
async function bumpStatsRow(doc, playerName, statKey, { won, left } = {}) {
    let updateExpression = "SET games = if_not_exists(games, :zero) + :one";
    if (left) {
        updateExpression += ", leaves = if_not_exists(leaves, :zero) + :one";
    } else if (won) {
        updateExpression += ", wins = if_not_exists(wins, :zero) + :one";
    }
    await doc.send(new UpdateCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName, statKey },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
    }));
}

// สัดส่วนเวลาที่ผู้เล่น "ออฟไลน์สะสม" ระหว่างเกม (เทียบกับเวลาที่เกมเล่นทั้งตาจนจบ) ที่ต้องเกิน
// ถึงจะนับว่า "ออกเกม" แทนที่จะนับแพ้/ชนะตามผลจริง — กันกรณีกดย้อนกลับ/ปิดแอปทิ้งกลางเกมแล้วโผล่มา
// รับผลชนะ (หรือโดนนับแพ้ทั้งที่ไม่ได้เล่นจริง) ทั้งที่ตัวเองไม่ได้อยู่เล่นจนจบเกมจริงๆ
const LEAVE_OFFLINE_RATIO = 0.2; // 20%

function getRoomGameRoundId(room) {
    if (!room) return "";
    if (room.gameRoundId) return String(room.gameRoundId);
    if (room.startedAt) return `legacy-${room.startedAt}`;
    return `lobby-${room.createdAt || room.id || "unknown"}`;
}

function hasImmediateLeaveRecorded(player, room) {
    const roundId = getRoomGameRoundId(room);
    return !!(player && roundId && player.leaveStatsRecordedRoundId === roundId);
}

// บันทึกการ "หนีออกเกม" แบบ explicit ทันที เมื่อผู้เล่นกด "หาห้องใหม่" ระหว่างเกมที่ยังไม่จบ
// ใช้ transaction + deterministic event keys เพื่อให้ retry ปลอดภัยและไม่บวกสถิติซ้ำ
// แม้ request เดิมจะ timeout หลัง DynamoDB บันทึกสำเร็จแล้วก็ตาม
async function recordImmediateGameLeaveStats(room, player, reason = "new_room") {
    if (!room || !player || player.isHost || !room.started || room.gameOver) {
        if (player && room && room.started) player.leaveStatsRecordedRoundId = getRoomGameRoundId(room);
        return { ok: true, skipped: true };
    }

    const roundId = getRoomGameRoundId(room);
    if (!roundId) return { ok: false, code: "SERVER_ERROR" };
    if (player.leaveStatsRecordedRoundId === roundId) return { ok: true, alreadyRecorded: true };

    player.leftGameRoundId = roundId;
    player.leaveReason = String(reason || "new_room").slice(0, 64);
    player.leaveRecordedAt = Date.now();

    // Bot/tester ไม่ถือเป็นสถิติผู้เล่นจริง แต่ต้อง lock round state เหมือนกันเพื่อกัน reconnect กลับเข้า
    if (player.isBot || player.isTester) {
        player.leaveStatsRecordedRoundId = roundId;
        return { ok: true, skipped: true };
    }

    if (!beginGameDataWrite()) return { ok: false, code: "SERVER_ERROR" };
    try {
        const doc = await getDynamoDocClient();
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const name = String(player.name || "").trim();
        const accountId = normalizeAccountId(player.accountId || "");
        const role = String(player.role || "");
        if (!name || !accountId || !role) {
            player.leaveStatsRecordedRoundId = roundId;
            return { ok: true, skipped: true };
        }

        // ไม่เพิ่ม IAM action ใหม่: ใช้ UpdateItem/PutItem ที่ role ปัจจุบันมีอยู่แล้ว
        // และใส่ round guard ในแต่ละ counter row เพื่อให้ retry หลัง timeout ไม่บวกซ้ำ
        const leaveKey = crypto.createHash("sha256")
            .update(`${String(room.id || "")}|${roundId}|${String(player.token || "")}`)
            .digest("hex")
            .slice(0, 32);
        const legacyEventKey = `GAME_LEAVE#${leaveKey}`;
        const accountEventKey = `${ACCOUNT_PROFILE_PREFIX}${accountId}${ACCOUNT_EVENT_PREFIX}GAME_LEAVE#${leaveKey}`;
        const roleStatKey = `ROLE#${role}`;
        const accountTotalKey = `${ACCOUNT_PROFILE_PREFIX}${accountId}${ACCOUNT_TOTAL_SUFFIX}`;
        const accountRoleKey = `${ACCOUNT_PROFILE_PREFIX}${accountId}${ACCOUNT_ROLE_PREFIX}${role}`;
        const roundSet = new Set([roundId]);

        async function bumpLeaveStatOnce(key, updateExpression, extraValues = {}) {
            try {
                await doc.send(new UpdateCommand({
                    TableName: STATS_TABLE_NAME,
                    Key: key,
                    UpdateExpression: `${updateExpression} ADD leaveRounds :roundSet`,
                    ConditionExpression: "attribute_not_exists(leaveRounds) OR NOT contains(leaveRounds, :roundId)",
                    ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":roundId": roundId, ":roundSet": roundSet, ...extraValues },
                }));
                return { recorded: true };
            } catch (e) {
                if (e?.name === "ConditionalCheckFailedException") return { alreadyRecorded: true };
                throw e;
            }
        }

        async function putLeaveEventOnce(item) {
            try {
                await doc.send(new PutCommand({
                    TableName: STATS_TABLE_NAME,
                    Item: item,
                    ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)",
                }));
                return { recorded: true };
            } catch (e) {
                if (e?.name === "ConditionalCheckFailedException") return { alreadyRecorded: true };
                throw e;
            }
        }

        const profile = accountProfileCache.get(accountId);
        const isTemporary = (profile?.accountType || ACCOUNT_TYPE_TEMPORARY) === ACCOUNT_TYPE_TEMPORARY;
        const profileValues = { ":zero": 0, ":one": 1, ":win": 0, ":leave": 1, ":now": now, ":roundId": roundId, ":roundSet": roundSet };
        let profileUpdate = "SET games = if_not_exists(games, :zero) + :one, wins = if_not_exists(wins, :zero) + :win, leaves = if_not_exists(leaves, :zero) + :leave, lastPlayedAt = :now, lastSeen = :now, lastActivityAt = :now, updatedAt = :now";
        if (isTemporary) {
            profileUpdate += ", temporaryExpiresAt = :expiry";
            profileValues[":expiry"] = buildTemporaryExpiry(nowMs);
        }

        await Promise.all([
            bumpLeaveStatOnce({ playerName: name, statKey: "TOTAL" }, "SET games = if_not_exists(games, :zero) + :one, leaves = if_not_exists(leaves, :zero) + :one"),
            bumpLeaveStatOnce({ playerName: name, statKey: roleStatKey }, "SET games = if_not_exists(games, :zero) + :one, leaves = if_not_exists(leaves, :zero) + :one"),
            bumpLeaveStatOnce({ playerName: ACCOUNTS_PARTITION_KEY, statKey: accountTotalKey }, "SET games = if_not_exists(games, :zero) + :one, leaves = if_not_exists(leaves, :zero) + :one"),
            bumpLeaveStatOnce({ playerName: ACCOUNTS_PARTITION_KEY, statKey: accountRoleKey }, "SET games = if_not_exists(games, :zero) + :one, leaves = if_not_exists(leaves, :zero) + :one"),
            bumpLeaveStatOnce({ playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(accountId) }, profileUpdate, profileValues),
            putLeaveEventOnce({
                playerName: name,
                statKey: legacyEventKey,
                type: "game_end",
                eventKind: "game_leave",
                roomId: room.id || "",
                roundId,
                role,
                team: teamOf(role),
                won: false,
                left: true,
                leaveReason: player.leaveReason,
                time: now,
            }),
            putLeaveEventOnce({
                playerName: ACCOUNTS_PARTITION_KEY,
                statKey: accountEventKey,
                accountId,
                type: "game_end",
                eventKind: "game_leave",
                displayName: name,
                leaveReason: player.leaveReason,
                roomId: room.id || "",
                roundId,
                role,
                team: teamOf(role),
                won: false,
                left: true,
                leaveReason: player.leaveReason,
                time: now,
            }),
        ]);

        player.leaveStatsRecordedRoundId = roundId;
        return { ok: true, recorded: true };
    } finally {
        endGameDataWrite();
    }
}

// เช็คว่าผู้เล่นคนนี้ "ออกเกม" ตานี้หรือไม่ — สะสมเวลาออฟไลน์ทั้งหมดระหว่างเกม (ดู
// markPlayerOfflineStart / flushPlayerOfflineTime ด้านล่าง) รวมช่วงที่ "ยังออฟไลน์อยู่ตอนจบเกม"
// (นับต่อมาถึง ณ ตอนนี้ด้วย ไม่งั้นคนที่หลุดค้างไปจนจบเกมเลยจะไม่ถูกนับเวลาออฟไลน์ช่วงสุดท้ายเลย)
// แล้วเทียบเป็นสัดส่วนกับเวลาที่เกมเล่นทั้งตาจนจบ (room.startedAt ถึงตอนนี้)
function didLeaveGame(player, room) {
    if (!player || !room || !room.startedAt) return false;
    if (player.leftGameRoundId && player.leftGameRoundId === getRoomGameRoundId(room)) return true;
    let offlineMs = player.gameOfflineMs || 0;
    if (player.gameOfflineSince != null) {
        offlineMs += Date.now() - player.gameOfflineSince;
    }
    const gameDurationMs = Date.now() - room.startedAt;
    if (gameDurationMs <= 0) return false;
    return offlineMs / gameDurationMs >= LEAVE_OFFLINE_RATIO;
}

// เรียกตอนจบเกมเท่านั้น (ดู endGame ด้านล่าง) — resultTeam คือทีมที่ชนะเกมจริง ๆ ของห้องนี้
// นับสถิติ "ชนะ" ต่อผู้เล่นตามผลจริงของแต่ละคน (ผ่าน isWinner) ไม่ใช่แค่ "อยู่ทีมที่ชนะภาพรวม"
// เพราะมีบทบาทที่ชนะแยกเงื่อนไขของตัวเอง (เช่นคนบ้า/นักล่าหัว/ผู้ยุยง) ตรงกับที่ isWinner ตัดสินอยู่แล้ว
// ไม่นับโฮสต์ (ไม่ใช่ผู้เล่น) และไม่นับบอท (ไม่ใช่คนจริง อัตราชนะของบอทไม่มีประโยชน์จะดู)
//
// ผู้เล่นที่ "ออกเกม" (ออฟไลน์เกิน LEAVE_OFFLINE_RATIO ของเวลาทั้งตา ดู didLeaveGame) จะไม่ถูกนับ
// แพ้/ชนะให้เลยไม่ว่าผลจริงจะออกมาทางไหน — นับเป็นสถิติ "ออกเกม" แทน (เพื่อไม่ให้อัตราชนะพองหรือ
// ลีบผิดจากคนที่ไม่ได้อยู่เล่นจริงจนจบตา)
//
// จงใจไม่ await ตอนเรียกจาก endGame() (ดูด้านล่าง) เพราะไม่อยากให้การแจ้งผลจบเกมไปช้าเพราะรอเขียน
// DynamoDB — ยิงทิ้งไว้เบื้องหลัง (fire-and-forget) ดัก error ไว้ในนี้แค่ log กันไม่ให้ process ล่ม
async function recordGameStats(room, resultTeam) {
    if (!beginGameDataWrite()) return;
    try {
    const players = room.players.filter((p) => p && !p.isHost && !p.isBot && !p.isTester && (p.name || "").trim() && p.role && !hasImmediateLeaveRecorded(p, room));
    if (!players.length) return;

    try {
        const doc = await getDynamoDocClient();
        const now = new Date().toISOString();
        await Promise.all(players.flatMap((p) => {
            const name = p.name.trim();
            const left = didLeaveGame(p, room);
            const won = !left && isWinner(p, resultTeam, room);
            return [
                bumpStatsRow(doc, name, "TOTAL", { won, left }),
                bumpStatsRow(doc, name, `ROLE#${p.role}`, { won, left }),
                // แถวประวัติ 1 แถวต่อคนต่อเกม (ดูคอมเมนต์ PLAYER REGISTRY ด้านบน) — ให้หน้า admin
                // โชว์ "จบเกมนี้ ได้บท X ผลชนะ/แพ้/ออก" แทรกในไทม์ไลน์เดียวกับตอนเข้าห้อง
                doc.send(new PutCommand({
                    TableName: STATS_TABLE_NAME,
                    Item: {
                        playerName: name,
                        statKey: genEventKey(),
                        type: "game_end",
                        eventKind: "game_end",
                        roomId: room.id || "",
                        role: p.role,
                        team: teamOf(p.role),
                        won,
                        left,
                        leaveReason: left ? "offline_threshold" : null,
                        time: now,
                    },
                })),
            ];
        }));
    } catch (e) {
        console.error("[stats] บันทึกสถิติลง DynamoDB ล้มเหลว:", e.message);
    }
    // สถิติแบบ accountId ทำแยก fire-and-forget เพื่อให้ rename แล้วสถิติใหม่ยังอยู่บัญชีเดิม
    if (!resetInProgress) recordAccountGameStats(room, resultTeam).catch((e) => logAccountDbWarning(e));
    } finally {
        endGameDataWrite();
    }
}


async function cleanupExpiredTemporaryAccounts() {
    if (resetInProgress) return { checked: 0, deleted: 0 };
    let checked = 0;
    let deleted = 0;
    try {
        const profiles = await queryAllAccountProfiles();
        for (const profile of profiles) {
            if (profile.accountType !== ACCOUNT_TYPE_TEMPORARY || !isTemporaryExpired(profile)) continue;
            checked++;
            const id = normalizeAccountId(profile.accountId || String(profile.statKey || "").replace(/^ACCOUNT#/, ""));
            if (!id) continue;
            try {
                const result = await deleteAccountData(id, { reason: "expired" });
                if (result.ok) deleted++;
            } catch (e) {
                logAccountDbWarning(e);
            }
        }
    } catch (e) {
        logAccountDbWarning(e);
    }
    if (deleted) console.log(`[accounts] ล้าง Temporary Account หมดอายุ ${deleted}/${checked} บัญชี`);
    return { checked, deleted };
}

async function cleanupExpiredAccountSessions() {
    if (resetInProgress) return 0;
    try {
        const doc = await getDynamoDocClient();
        const items = [];
        let ExclusiveStartKey;
        const nowMs = Date.now();
        do {
            const out = await doc.send(new QueryCommand({
                TableName: STATS_TABLE_NAME,
                KeyConditionExpression: "playerName = :pk AND begins_with(statKey, :prefix)",
                ExpressionAttributeValues: { ":pk": ACCOUNTS_PARTITION_KEY, ":prefix": ACCOUNT_SESSION_PREFIX },
                ExclusiveStartKey,
            }));
            items.push(...(out.Items || []));
            ExclusiveStartKey = out.LastEvaluatedKey;
        } while (ExclusiveStartKey);
        const expired = items.map((it) => {
            const exp = Date.parse(it.expiresAt || "");
            const hash = String(it.tokenHash || String(it.statKey || "").slice(ACCOUNT_SESSION_PREFIX.length)).trim();
            return { item: it, hash, expired: Number.isFinite(exp) && exp <= nowMs && /^[a-f0-9]{64}$/i.test(hash) };
        }).filter((x) => x.expired);
        if (!expired.length) return 0;
        const deletes = expired.map((x) => ({ playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionKey(x.hash) }));
        const markers = expired.filter((x) => x.item?.accountId).map((x) => ({
            playerName: ACCOUNTS_PARTITION_KEY,
            statKey: accountSessionByAccountKey(x.item.accountId, x.hash),
        }));
        await deleteItemsWithFallback(doc, [...deletes, ...markers]);
        console.log(`[accounts] ล้าง Google session หมดอายุ ${expired.length} session`);
        return expired.length;
    } catch (e) {
        logAccountDbWarning(e);
        return 0;
    }
}

const ACCOUNT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let accountCleanupTimer = null;
function startAccountCleanupJob() {
    if (accountCleanupTimer) return;
    accountCleanupTimer = setInterval(() => {
        cleanupExpiredTemporaryAccounts().catch(logAccountDbWarning);
        cleanupExpiredAccountSessions().catch(logAccountDbWarning);
    }, ACCOUNT_CLEANUP_INTERVAL_MS);
    if (typeof accountCleanupTimer.unref === "function") accountCleanupTimer.unref();
    setTimeout(() => {
        cleanupExpiredTemporaryAccounts().catch(logAccountDbWarning);
        cleanupExpiredAccountSessions().catch(logAccountDbWarning);
    }, 15_000);
}

// เริ่ม job หลัง process โหลดฟังก์ชันแล้ว — ถ้า DynamoDB ใช้ไม่ได้จะ retry รอบถัดไปและไม่ทำให้เกมล่ม
startAccountCleanupJob();

// ============================================================
// PLAYER REGISTRY (รายชื่อ "ทุกคน" ที่เคยตั้งชื่อเข้าเล่น — ไม่ใช่แค่คนที่เชื่อมต่ออยู่ตอนนี้)
// ============================================================
// ใช้ตาราง DynamoDB เดียวกับสถิติผู้เล่นด้านบน (STATS_TABLE_NAME) เพิ่ม statKey อีก 2 แบบ:
//   - "REG"          แถวสรุปต่อชื่อ 1 แถว: firstSeen / lastSeen / joinCount (นับเข้าใหม่ทุกครั้ง
//                     ที่ตั้งชื่อ "ครั้งแรก" ในห้องนั้น — reconnect ด้วย token เดิมไม่นับซ้ำ)
//                     ใช้ Scan ทั้งตาราง กรองเฉพาะแถวนี้ เพื่อดึง "รายชื่อทุกคนที่เคยลงทะเบียน"
//                     มาโชว์ในหน้า admin (แท็บ "ผู้เล่นทั้งหมด") — Scan ทั้งตารางยอมรับได้เพราะ
//                     ตารางนี้เล็ก (เขียนไม่บ่อย, ใช้แค่หน้า admin ที่ไม่มีใครเปิดพร้อมกันหลายคน)
//   - "EVENT#<ISO>"  แถวประวัติ 1 แถวต่อ 1 เหตุการณ์ (เข้าห้อง / จบเกม) เรียงตามเวลาได้เพราะ ISO
//                     timestamp เรียง lexicographic ตรงกับเรียงเวลาอยู่แล้ว — ใช้ Query ตาม
//                     playerName (partition key) ดึงประวัติทั้งหมดของคนคนนั้นมาโชว์ในหน้า admin
const genEventKey = () => `EVENT#${new Date().toISOString()}#${genId()}`;

// เรียกตอน "ตั้งชื่อเข้าห้องครั้งแรก" เท่านั้น (create_room และ join_room ฝั่งผู้เล่นใหม่) —
// ไม่เรียกตอน reconnect ด้วย token เดิม เพราะไม่ใช่การลงทะเบียนใหม่ ไม่งั้น joinCount จะพองเกินจริง
// จงใจไม่ await ตอนเรียกจาก handler (fire-and-forget เหมือน recordGameStats ด้านบน) กันไม่ให้
// การเข้าห้องช้าเพราะรอเขียน DynamoDB
async function recordPlayerRegistration(name, { roomId, isHost, isTester } = {}) {
    // Tester คือเครื่องแอดมินชั่วคราว ห้ามสร้าง registry/ประวัติบัญชีจริงเด็ดขาด
    if (isTester) return;
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    if (!beginGameDataWrite()) return;

    try {
        const doc = await getDynamoDocClient();
        const now = new Date().toISOString();
        await Promise.all([
            doc.send(new UpdateCommand({
                TableName: STATS_TABLE_NAME,
                Key: { playerName: trimmed, statKey: "REG" },
                UpdateExpression:
                    "SET firstSeen = if_not_exists(firstSeen, :now), lastSeen = :now" +
                    " ADD joinCount :one",
                ExpressionAttributeValues: { ":now": now, ":one": 1 },
            })),
            doc.send(new PutCommand({
                TableName: STATS_TABLE_NAME,
                Item: {
                    playerName: trimmed,
                    statKey: genEventKey(),
                    type: "join",
                    eventKind: "room_join",
                    roomId: roomId || "",
                    isHost: !!isHost,
                    isTester: !!isTester,
                    time: now,
                },
            })),
        ]);
    } catch (e) {
        if (!resetInProgress) console.error("[registry] บันทึกการลงทะเบียนผู้เล่นล้มเหลว:", e.name, e.message);
    } finally {
        endGameDataWrite();
    }
}

// ทีมของแต่ละ role (field "team" ใน roles ด้านล่าง) มีค่าไม่กี่แบบ (wolf/villager/solo/cult/bandit)
// ไว้ใช้จัดกลุ่มใน popup อัตราชนะฝั่ง client (ระดับกลาง: รวมทุก role ในทีมเดียวกัน ก่อนจะกางย่อยเป็น
// รายอาชีพอีกที) แปลเป็นภาษาไทยไว้ให้ตรงกับชื่อที่ใช้แสดงผลจุดอื่น ๆ ในเกมนี้
const roleTeamLabels = {
    wolf: "หมาป่า",
    villager: "ชาวบ้าน",
    solo: "สายเดี่ยว",
    cult: "ลัทธิ",
    bandit: "โจร",
};

// แปลงแถวสถิติดิบจาก DynamoDB (games/wins/leaves) ให้เป็น "3 ช่อง" ชนะ/แพ้/ออก ครบทั้งจำนวนและ %
// — losses ไม่ได้เก็บเป็นคอลัมน์แยกใน DynamoDB (ดูคอมเมนต์ bumpStatsRow ด้านบน) คำนวณย้อนกลับจาก
// games - wins - leaves เอาตรงนี้จุดเดียว ให้ทุก endpoint ที่ต้องโชว์สถิติเรียกใช้ร่วมกันเสมอ
function rateBreakdown(row) {
    const games = row?.games || 0;
    const wins = row?.wins || 0;
    const leaves = row?.leaves || 0;
    const losses = Math.max(0, games - wins - leaves);
    const pct = (n) => (games ? Math.round((n / games) * 1000) / 10 : 0);
    return {
        games, wins, losses, leaves,
        winRate: pct(wins), lossRate: pct(losses), leaveRate: pct(leaves),
    };
}

// ============================================================
// DIRECT GOOGLE OIDC AUTHENTICATION
// ============================================================
function parseGoogleContextCookie(req) {
    return verifySignedState(readCookie(req.headers?.cookie, GOOGLE_STATE_COOKIE), AUTH_STATE_SECRET);
}

function createPkcePair() {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

function issueGoogleContext(req, res, payload) {
    const signed = createSignedState({ v: 1, exp: Date.now() + ACCOUNT_GOOGLE_STATE_TTL_MS, n: crypto.randomBytes(18).toString("hex"), ...payload });
    setHttpOnlyCookie(res, GOOGLE_STATE_COOKIE, signed, ACCOUNT_GOOGLE_STATE_TTL_MS, authCookieSecure(req));
}

function googleAuthorizeUrl(state, codeChallenge, nonce = "") {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    u.searchParams.set("redirect_uri", GOOGLE_CALLBACK_URL);
    u.searchParams.set("scope", GOOGLE_SCOPES);
    u.searchParams.set("state", state);
    u.searchParams.set("prompt", "select_account");
    if (nonce) u.searchParams.set("nonce", nonce);
    if (codeChallenge) {
        u.searchParams.set("code_challenge_method", "S256");
        u.searchParams.set("code_challenge", codeChallenge);
    }
    return u.toString();
}

async function linkGoogleIdentityToAccount(accountId, providerSubject, claims, displayNameHint) {
    const id = normalizeAccountId(accountId);
    const identityKey = googleIdentityKey(providerSubject);
    const existing = await getAccountByGoogleIdentity(providerSubject);
    if (existing && normalizeAccountId(existing.accountId) !== id) {
        throw Object.assign(new Error("Google บัญชีนี้เชื่อมกับ Game Account อื่นอยู่แล้ว"), { code: "GOOGLE_ALREADY_LINKED" });
    }
    const profile = await getAccountProfile(id, { forceFresh: true });
    if (!profile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
    if (profile.status === "deleted") throw Object.assign(new Error("account deleted"), { code: "ACCOUNT_DELETED" });
    if (profile.status === "suspended") throw Object.assign(new Error("account suspended"), { code: "ACCOUNT_SUSPENDED" });
    if (isTemporaryExpired(profile)) throw Object.assign(new Error("temporary account expired"), { code: "ACCOUNT_EXPIRED" });
    if (profile.accountType === "google" && profile.provider === "google" && !existing) {
        // profile looks linked but provider index is missing: the transaction below repairs the index.
    }
    const now = new Date().toISOString();
    const googleName = sanitizeName(displayNameHint || claims?.name || claims?.given_name || profile.currentName || randomTemporaryDisplayName(), profile.currentName || "ผู้เล่น");
    const oldTempHash = String(profile[ACCOUNT_IDENTITY_HASH_FIELD] || "");
    const rawSession = crypto.randomBytes(48).toString("base64url");
    const sessionHash = hashAccountToken(rawSession);
    const sessionExpires = new Date(Date.now() + ACCOUNT_GOOGLE_SESSION_TTL_MS).toISOString();
    const identityItem = { playerName: ACCOUNTS_PARTITION_KEY, statKey: identityKey, accountId: id, provider: "google", providerSubjectHash: googleIdentitySubjectHash(providerSubject), googleSub: String(claims?.sub || ""), createdAt: existing?.createdAt || now, updatedAt: now };
    const sessionLookup = { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionKey(sessionHash), accountId: id, tokenHash: sessionHash, provider: "google", createdAt: now, expiresAt: sessionExpires, updatedAt: now };
    const sessionMarker = { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionByAccountKey(id, sessionHash), accountId: id, tokenHash: sessionHash, provider: "google", createdAt: now, expiresAt: sessionExpires };
    const deleteTempIdentity = oldTempHash ? { Delete: { TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountIdentityKey(oldTempHash) } } } : null;
    const identityPut = existing
        ? { Put: { TableName: STATS_TABLE_NAME, Item: identityItem, ConditionExpression: "attribute_exists(playerName) AND accountId = :accountId", ExpressionAttributeValues: { ":accountId": id } } }
        : { Put: { TableName: STATS_TABLE_NAME, Item: identityItem, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } };
    const tx = [
        identityPut,
        { Update: { TableName: STATS_TABLE_NAME, Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) }, UpdateExpression: "SET accountType = :google, provider = :google, currentName = if_not_exists(currentName, :name), lastSeen = :now, lastActivityAt = :now, updatedAt = :now REMOVE loginTokenHash, loginIdentityKey, temporaryExpiresAt", ExpressionAttributeValues: { ":google": "google", ":name": googleName, ":now": now } } },
        { Put: { TableName: STATS_TABLE_NAME, Item: sessionLookup, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
        { Put: { TableName: STATS_TABLE_NAME, Item: sessionMarker, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
    ];
    if (deleteTempIdentity) tx.push(deleteTempIdentity);
    try {
        await getDynamoDocClient().then((doc) => doc.send(new TransactWriteCommand({ TransactItems: tx })));
    } catch (e) {
        if (e?.name === "TransactionCanceledException" || e?.name === "ConditionalCheckFailedException") {
            const winner = await getAccountByGoogleIdentity(providerSubject).catch(() => null);
            if (winner && normalizeAccountId(winner.accountId) !== id) {
                throw Object.assign(new Error("Google บัญชีนี้เชื่อมกับ Game Account อื่นอยู่แล้ว"), { code: "GOOGLE_ALREADY_LINKED" });
            }
            // Same-account concurrent callback: do not attempt a second linking transaction;
            // instead issue a normal Google session for the already-linked account.
            if (winner && normalizeAccountId(winner.accountId) === id) {
                const current = await getAccountProfile(id, { forceFresh: true });
                if (current?.accountType === "google" && current.provider === "google") {
                    const session = await issueGoogleAccountSession(id);
                    return { accountId: id, token: session.token, expiresAt: session.expiresAt, profile: current };
                }
            }
        }
        throw e;
    }
    const next = { ...profile, accountType: "google", provider: "google", currentName: profile.currentName || googleName, updatedAt: now };
    delete next.loginTokenHash;
    delete next.loginIdentityKey;
    delete next.temporaryExpiresAt;
    accountProfileCache.set(id, next);
    accountActivityDbAt.delete(id);
    return { accountId: id, token: rawSession, expiresAt: sessionExpires, profile: next };
}

async function createGoogleGameAccount(providerSubject, claims) {
    const existing = await getAccountByGoogleIdentity(providerSubject);
    if (existing?.accountId) {
        const profile = await getAccountProfile(existing.accountId, { forceFresh: true });
        if (!profile) throw Object.assign(new Error("linked account not found"), { code: "GOOGLE_ACCOUNT_BROKEN" });
        if (profile.status === "deleted") throw Object.assign(new Error("linked account deleted"), { code: "ACCOUNT_DELETED" });
        if (profile.status === "suspended") throw Object.assign(new Error("linked account suspended"), { code: "ACCOUNT_SUSPENDED" });
        const session = await issueGoogleAccountSession(existing.accountId);
        return { accountId: existing.accountId, token: session.token, expiresAt: session.expiresAt, profile };
    }
    let displayName = sanitizeName(claims?.name || claims?.given_name || "", "");
    if (!displayName || displayName === "ผู้เล่น") displayName = randomTemporaryDisplayName();
    try { displayName = await assertAccountNameAvailable(displayName, ""); }
    catch (_) { displayName = randomTemporaryDisplayName(); }
    const id = generateAccountId();
    const now = new Date();
    const iso = now.toISOString();
    const rawSession = crypto.randomBytes(48).toString("base64url");
    const sessionHash = hashAccountToken(rawSession);
    const sessionExpires = new Date(now.getTime() + ACCOUNT_GOOGLE_SESSION_TTL_MS).toISOString();
    const googleIdentityItem = { playerName: ACCOUNTS_PARTITION_KEY, statKey: googleIdentityKey(providerSubject), accountId: id, provider: "google", providerSubjectHash: googleIdentitySubjectHash(providerSubject), googleSub: String(claims?.sub || ""), createdAt: iso, updatedAt: iso };
    const profile = { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id), accountId: id, accountType: "google", provider: "google", currentName: displayName, aliases: [], status: "active", firstSeen: iso, createdAt: iso, lastSeen: iso, lastActivityAt: iso, updatedAt: iso, joinCount: 0, games: 0, wins: 0, leaves: 0, isTester: false };
    const sessionLookup = { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionKey(sessionHash), accountId: id, tokenHash: sessionHash, provider: "google", createdAt: iso, expiresAt: sessionExpires, updatedAt: iso };
    const sessionMarker = { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountSessionByAccountKey(id, sessionHash), accountId: id, tokenHash: sessionHash, provider: "google", createdAt: iso, expiresAt: sessionExpires };
    const tx = { TransactItems: [
        { Put: { TableName: STATS_TABLE_NAME, Item: googleIdentityItem, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
        { Put: { TableName: STATS_TABLE_NAME, Item: profile, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
        { Put: { TableName: STATS_TABLE_NAME, Item: sessionLookup, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
        { Put: { TableName: STATS_TABLE_NAME, Item: sessionMarker, ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" } },
    ] };
    try {
        await getDynamoDocClient().then((doc) => doc.send(new TransactWriteCommand(tx)));
    } catch (e) {
        if (e?.name === "TransactionCanceledException" || e?.name === "ConditionalCheckFailedException") {
            // Another instance may have won the same Google identity between the initial read and the transaction.
            const winner = await getAccountByGoogleIdentity(providerSubject).catch(() => null);
            if (winner?.accountId) {
                const winnerProfile = await getAccountProfile(winner.accountId, { forceFresh: true });
                if (!winnerProfile) throw Object.assign(new Error("linked account not found"), { code: "GOOGLE_ACCOUNT_BROKEN" });
                if (winnerProfile.status === "deleted") throw Object.assign(new Error("linked account deleted"), { code: "ACCOUNT_DELETED" });
                if (winnerProfile.status === "suspended") throw Object.assign(new Error("linked account suspended"), { code: "ACCOUNT_SUSPENDED" });
                const session = await issueGoogleAccountSession(winner.accountId);
                return { accountId: winner.accountId, token: session.token, expiresAt: session.expiresAt, profile: winnerProfile };
            }
        }
        throw e;
    }
    accountProfileCache.set(id, profile);
    accountActivityDbAt.delete(id);
    return { accountId: id, token: rawSession, expiresAt: sessionExpires, profile };
}

app.get("/api/auth/config", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const required = [
        ["GOOGLE_CLIENT_ID", GOOGLE_CLIENT_ID],
        ["GOOGLE_CALLBACK_URL", GOOGLE_CALLBACK_URL],
        ["AUTH_STATE_SECRET", AUTH_STATE_SECRET_ENV],
    ];
    const missing = required.filter(([, value]) => !String(value || "").trim()).map(([key]) => key);
    if (GOOGLE_CALLBACK_URL && !googleCallbackUrlIsAllowed()) missing.push("GOOGLE_CALLBACK_URL_HTTPS");
    res.json({
        ok: true,
        googleConfigured: missing.length === 0,
        googleLoginEnabled: missing.length === 0,
        missing,
        accountSessionTtlMs: ACCOUNT_GOOGLE_SESSION_TTL_MS,
    });
});

async function prepareGoogleLoginStart(req, res, { mode = "login", accountId = "", accountToken = "", reauth = false, returnTo = "/" } = {}) {
    if (!googleIsConfigured()) throw Object.assign(new Error("Google is not configured"), { code: "GOOGLE_NOT_CONFIGURED" });
    const safeMode = mode === "link" ? "link" : "login";
    const safeAccountId = normalizeAccountId(accountId);
    const safeAccountToken = normalizeAccountToken(accountToken);
    const safeReauth = safeMode === "login" && reauth === true && !!safeAccountId;

    // Link operations authenticate the existing Game Account before any Google redirect is created.
    if (safeMode === "link") {
        if (!safeAccountId || !safeAccountToken) throw Object.assign(new Error("account authentication required"), { code: "ACCOUNT_AUTH_REQUIRED" });
        const verified = await withTimeout(
            verifyAccountLogin(safeAccountId, safeAccountToken),
            10000,
            "ACCOUNT_AUTH_TIMEOUT",
            "account verification timed out"
        );
        if (!verified.profile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
        if (verified.ok === false) throw Object.assign(new Error("account authentication failed"), { code: verified.code || "ACCOUNT_AUTH_FAILED" });
        if (verified.profile.accountType === "google" && verified.profile.provider === "google") throw Object.assign(new Error("Google already linked"), { code: "GOOGLE_ALREADY_LINKED" });
    }

    const pkce = createPkcePair();
    const statePayload = {
        v: 1, exp: Date.now() + ACCOUNT_GOOGLE_STATE_TTL_MS,
        n: crypto.randomBytes(18).toString("hex"), mode: safeMode, reauth: safeReauth,
        returnTo: normalizeReturnTo(returnTo || "/"),
    };
    const state = createSignedState(statePayload);
    issueGoogleContext(req, res, {
        stateNonce: statePayload.n, mode: safeMode, reauth: safeReauth,
        accountId: safeMode === "link" ? safeAccountId : (safeReauth ? safeAccountId : ""),
        accountTokenHash: safeMode === "link" ? hashAccountToken(safeAccountToken) : "",
        returnTo: statePayload.returnTo, codeVerifier: pkce.verifier,
    });
    return { state, url: googleAuthorizeUrl(state, pkce.challenge, statePayload.n), mode: safeMode, reauth: safeReauth };
}

async function prepareAdminGoogleLoginStart(req, res) {
    if (!ADMIN_GOOGLE_EMAILS.length) throw Object.assign(new Error("Google admin login is not configured"), { code: "ADMIN_GOOGLE_ADMIN_NOT_CONFIGURED" });
    if (!googleIsConfigured()) throw Object.assign(new Error("Google is not configured"), { code: "GOOGLE_NOT_CONFIGURED" });
    const tabId = sanitizeAdminTabId(req.query?.tabId);
    if (!tabId) throw Object.assign(new Error("Admin tab id is required"), { code: "ADMIN_TAB_ID_REQUIRED" });
    const pkce = createPkcePair();
    const statePayload = {
        v: 1,
        exp: Date.now() + ACCOUNT_GOOGLE_STATE_TTL_MS,
        n: crypto.randomBytes(18).toString("hex"),
        mode: "admin",
        tabId,
        returnTo: "/admin.html",
    };
    const state = createSignedState(statePayload);
    setHttpOnlyCookie(res, adminGoogleStateCookieName(tabId), createSignedState({
        v: 1, exp: statePayload.exp, stateNonce: statePayload.n, mode: "admin", tabId, codeVerifier: pkce.verifier,
    }), ACCOUNT_GOOGLE_STATE_TTL_MS, authCookieSecure(req));
    return { state, url: googleAuthorizeUrl(state, pkce.challenge, statePayload.n) };
}

app.get("/auth/google/admin-start", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    try {
        const result = await prepareAdminGoogleLoginStart(req, res);
        return res.redirect(302, result.url);
    } catch (e) {
        const code = String(e?.code || "ADMIN_GOOGLE_LOGIN_FAILED");
        return res.redirect(`/admin.html?admin_error=${encodeURIComponent(code)}`);
    }
});

// Browser navigation endpoint for login/re-authentication.
// It intentionally uses GET because login start carries no credential and CloudFront deployments
// commonly allow GET on the default behavior while a custom /api/* behavior may not forward POST.
// This stays same-origin and still goes directly from the browser to Google's authorization endpoint.
app.get("/auth/google/start", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Pragma", "no-cache");
    const accountId = normalizeAccountId(req.query.accountId || "");
    const reauth = String(req.query.reauth || "") === "1" && !!accountId;
    try {
        const result = await prepareGoogleLoginStart(req, res, { mode: "login", accountId, reauth, returnTo: req.query.returnTo || "/" });
        return res.redirect(302, result.url);
    } catch (e) {
        const code = String(e?.code || "GOOGLE_AUTH_FAILED");
        return res.redirect(`/auth/google/complete?error=${encodeURIComponent(code)}`);
    }
});

// JSON start endpoint remains for account-linking, where the existing account credential must be
// authenticated server-side before redirecting to Google. Login/re-auth clients should use the GET endpoint above.
app.post("/api/auth/google/start", express.json({ limit: "6kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    try {
        const body = req.body || {};
        const result = await prepareGoogleLoginStart(req, res, {
            mode: body.mode === "link" ? "link" : "login",
            accountId: body.accountId || "", accountToken: body.accountToken || "",
            reauth: body.reauth === true, returnTo: body.returnTo || "/",
        });
        return res.json({ ok: true, url: result.url });
    } catch (e) {
        const code = String(e?.code || "GOOGLE_AUTH_FAILED");
        const statusByCode = {
            GOOGLE_NOT_CONFIGURED: 503, ACCOUNT_AUTH_REQUIRED: 401, ACCOUNT_NOT_FOUND: 404,
            ACCOUNT_AUTH_FAILED: 403, GOOGLE_ALREADY_LINKED: 409, ACCOUNT_SUSPENDED: 403, ACCOUNT_DELETED: 403,
            ACCOUNT_EXPIRED: 403, ACCOUNT_AUTH_TIMEOUT: 503,
        };
        return res.status(statusByCode[code] || 500).json({ ok: false, code });
    }
});

function googleFriendlyError(code) {
    const messages = {
        GOOGLE_NOT_CONFIGURED: "ระบบเข้าสู่ระบบ Google ยังตั้งค่าไม่ครบ",
        GOOGLE_TOKEN_INVALID: "ยืนยันตัวตนกับ Google ไม่สำเร็จ",
        GOOGLE_KEY_NOT_FOUND: "ไม่พบกุญแจยืนยันตัวตนของ Google กรุณาลองใหม่",
        GOOGLE_SUBJECT_MISSING: "ไม่พบข้อมูลบัญชี Google ที่จำเป็น",
        GOOGLE_ALREADY_LINKED: "บัญชี Google นี้เชื่อมกับ Game Account อื่นอยู่แล้ว",
        ACCOUNT_DELETED: "บัญชีเกมนี้ถูกลบแล้ว",
        ACCOUNT_SUSPENDED: "บัญชีเกมนี้ถูกพักอยู่",
        ACCOUNT_EXPIRED: "บัญชีชั่วคราวหมดอายุแล้ว",
        ACCOUNT_AUTH_FAILED: "การยืนยันบัญชีไม่ผ่าน",
        GOOGLE_STATE_INVALID: "เซสชันการเข้าสู่ระบบหมดอายุ กรุณาเริ่ม Google Login ใหม่",
        GOOGLE_HANDOFF_EXPIRED: "การเข้าสู่ระบบหมดอายุ กรุณาลองใหม่อีกครั้ง",
    };
    return messages[String(code || "")] || "ไม่สามารถเข้าสู่ระบบด้วย Google ได้ กรุณาลองใหม่อีกครั้ง";
}

function googleCompleteHtml() {
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Google Login — Werewolf Online TH</title><style>
html,body{margin:0;min-height:100%;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 50% 10%,#51306e 0,#1a1726 46%,#0d0d13 100%);color:#fff}body{display:grid;place-items:center;padding:24px}.box{width:min(92vw,460px);box-sizing:border-box;padding:30px 26px;border:1px solid rgba(255,255,255,.13);border-radius:22px;background:rgba(23,20,34,.9);box-shadow:0 18px 60px rgba(0,0,0,.35);text-align:center}.icon{font-size:42px;line-height:1;margin-bottom:14px}.title{font-size:24px;font-weight:800;margin:0 0 8px}.msg{margin:0 0 20px;color:#d7d0e2;line-height:1.6;white-space:pre-wrap}.actions{display:flex;justify-content:center}.btn{display:inline-flex;align-items:center;justify-content:center;min-width:190px;padding:12px 18px;border-radius:14px;text-decoration:none;background:#19b7a5;color:#071b19;font-weight:800;box-shadow:0 8px 24px rgba(0,0,0,.25)}.sub{margin-top:12px;color:#9d93ab;font-size:12px}.hidden{display:none}
</style></head><body><div class="box"><div class="icon" id="icon">🔐</div><h1 class="title" id="title">กำลังเข้าสู่บัญชี...</h1><p class="msg" id="msg">กำลังยืนยันข้อมูลกับ Google และเซิร์ฟเวอร์เกม</p><div class="actions"><a class="btn hidden" id="back" href="/">กลับหน้าเกม</a></div><div class="sub" id="sub">Werewolf Online TH</div></div><script>
(async()=>{const title=document.getElementById('title'),msg=document.getElementById('msg'),icon=document.getElementById('icon'),back=document.getElementById('back');const q=new URLSearchParams(location.search);const code=q.get('error')||'';const friendly={GOOGLE_STATE_INVALID:'เซสชันการเข้าสู่ระบบหมดอายุ กรุณากลับหน้าเกมแล้วเริ่มใหม่',GOOGLE_TOKEN_INVALID:'ยืนยันตัวตนกับ Google ไม่สำเร็จ',GOOGLE_KEY_NOT_FOUND:'ไม่พบกุญแจยืนยันตัวตนของ Google กรุณาลองใหม่',GOOGLE_SUBJECT_MISSING:'ไม่พบข้อมูลบัญชี Google ที่จำเป็น',GOOGLE_ALREADY_LINKED:'บัญชี Google นี้เชื่อมกับ Game Account อื่นอยู่แล้ว',ACCOUNT_DELETED:'บัญชีเกมนี้ถูกลบแล้ว',ACCOUNT_SUSPENDED:'บัญชีเกมนี้ถูกพักอยู่',ACCOUNT_EXPIRED:'บัญชีชั่วคราวหมดอายุแล้ว',ACCOUNT_AUTH_FAILED:'การยืนยันบัญชีไม่ผ่าน',GOOGLE_HANDOFF_EXPIRED:'การเข้าสู่ระบบหมดอายุ กรุณาลองใหม่อีกครั้ง'};if(code){icon.textContent='⚠️';title.textContent='เข้าสู่ระบบ Google ไม่สำเร็จ';msg.textContent=friendly[code]||'ไม่สามารถเข้าสู่ระบบด้วย Google ได้ กรุณาลองใหม่อีกครั้ง';back.classList.remove('hidden');return;}try{const r=await fetch('/api/auth/google/handoff',{cache:'no-store',credentials:'same-origin'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.code||'GOOGLE_HANDOFF_EXPIRED');if(d.mode==='login'&&!d.reauth){try{['ww_joinedRoom','ww_lastRoom','ww_token','ww_host_room','ww_host_token','ww_bot_tokens'].forEach(k=>{localStorage.removeItem(k);sessionStorage.removeItem(k)})}catch(_){}}localStorage.setItem('ww_account_id',d.accountId);localStorage.setItem('ww_account_token',d.accountToken);localStorage.setItem('ww_account_type',d.accountType||'google');if(d.displayName)localStorage.setItem('ww_account_name',d.displayName);localStorage.removeItem('ww_account_expires');icon.textContent='✅';title.textContent='เข้าสู่ระบบสำเร็จ';msg.textContent='กำลังกลับเข้าเกม...';location.replace(d.returnTo||'/');}catch(_){icon.textContent='⚠️';title.textContent='เข้าสู่ระบบ Google ไม่สำเร็จ';msg.textContent='การเชื่อมต่อกลับเข้าเกมหมดอายุ กรุณากลับหน้าเกมแล้วลองใหม่อีกครั้ง';back.classList.remove('hidden');}})();
</script></body></html>`;
}

app.get("/auth/google/callback", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!googleIsConfigured()) return res.redirect("/auth/google/complete?error=GOOGLE_NOT_CONFIGURED");
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const error = String(req.query.error || "");
    const statePayload = verifySignedState(state);
    if (error) {
        if (statePayload?.mode === "admin") {
            const tabId = sanitizeAdminTabId(statePayload.tabId);
            if (tabId) clearHttpOnlyCookie(res, adminGoogleStateCookieName(tabId), authCookieSecure(req));
            return res.redirect(`/admin.html?admin_error=${encodeURIComponent("ADMIN_GOOGLE_CANCELLED")}`);
        }
        clearHttpOnlyCookie(res, GOOGLE_STATE_COOKIE, authCookieSecure(req));
        return res.redirect(`/auth/google/complete?error=${encodeURIComponent("GOOGLE_AUTH_CANCELLED")}`);
    }
    if (statePayload?.mode === "admin") {
        const tabId = sanitizeAdminTabId(statePayload.tabId);
        const adminContext = verifySignedState(readCookie(req.headers?.cookie, adminGoogleStateCookieName(tabId)));
        const verifiedTabId = sanitizeAdminTabId(statePayload.tabId || adminContext?.tabId);
        if (!code || !adminContext || adminContext.mode !== "admin" || statePayload.n !== adminContext.stateNonce || !adminContext.codeVerifier || !verifiedTabId || adminContext.tabId !== verifiedTabId) {
            clearHttpOnlyCookie(res, adminGoogleStateCookieName(verifiedTabId || tabId), authCookieSecure(req));
            return res.redirect(`/admin.html?admin_error=${encodeURIComponent("ADMIN_GOOGLE_STATE_INVALID")}`);
        }
        if (!ADMIN_GOOGLE_EMAILS.length) {
            clearHttpOnlyCookie(res, adminGoogleStateCookieName(verifiedTabId || tabId), authCookieSecure(req));
            return res.redirect(`/admin.html?admin_error=${encodeURIComponent("ADMIN_GOOGLE_NOT_CONFIGURED")}`);
        }
        try {
            const form = { grant_type: "authorization_code", client_id: GOOGLE_CLIENT_ID, code, redirect_uri: GOOGLE_CALLBACK_URL, code_verifier: String(adminContext.codeVerifier) };
            if (GOOGLE_CLIENT_SECRET) form.client_secret = GOOGLE_CLIENT_SECRET;
            const tokens = await requestJsonHttps("https://oauth2.googleapis.com/token", { method: "POST", form });
            const verified = await verifyGoogleIdToken(tokens?.id_token || "", adminContext.stateNonce);
            const email = normalizeAdminEmail(verified.claims?.email);
            if (!isAllowedAdminGoogleClaims(verified.claims)) {
                clearHttpOnlyCookie(res, adminGoogleStateCookieName(verifiedTabId || tabId), authCookieSecure(req));
                return res.redirect(`/admin.html?admin_error=${encodeURIComponent("ADMIN_GOOGLE_NOT_ALLOWED")}`);
            }
            const ticket = createSignedState({
                v: 1, type: "admin_tab_handoff", admin: true, tabId,
                provider: "google", googleSub: verified.providerSubject, email,
                exp: Date.now() + ADMIN_TAB_HANDOFF_TTL_MS, n: crypto.randomBytes(24).toString("hex"),
            }, ADMIN_SESSION_SECRET);
            clearHttpOnlyCookie(res, adminGoogleStateCookieName(verifiedTabId || tabId), authCookieSecure(req));
            return res.redirect(`/admin.html#admin_ticket=${encodeURIComponent(ticket)}`);
        } catch (e) {
            console.error("[admin-google-auth] callback failed:", e?.name, e?.code || "", e?.message || "");
            clearHttpOnlyCookie(res, adminGoogleStateCookieName(verifiedTabId || tabId), authCookieSecure(req));
            return res.redirect(`/admin.html?admin_error=${encodeURIComponent(String(e?.code || "ADMIN_GOOGLE_LOGIN_FAILED"))}`);
        }
    }
    const context = parseGoogleContextCookie(req);
    if (!code || !statePayload || !context || statePayload.n !== context.stateNonce) {
        clearHttpOnlyCookie(res, GOOGLE_STATE_COOKIE, authCookieSecure(req));
        return res.redirect("/auth/google/complete?error=GOOGLE_STATE_INVALID");
    }
    if (statePayload.mode !== context.mode || !!statePayload.reauth !== !!context.reauth || !context.codeVerifier) {
        clearHttpOnlyCookie(res, GOOGLE_STATE_COOKIE, authCookieSecure(req));
        return res.redirect("/auth/google/complete?error=GOOGLE_STATE_INVALID");
    }
    try {
        const form = { grant_type: "authorization_code", client_id: GOOGLE_CLIENT_ID, code, redirect_uri: GOOGLE_CALLBACK_URL, code_verifier: String(context.codeVerifier) };
        if (GOOGLE_CLIENT_SECRET) form.client_secret = GOOGLE_CLIENT_SECRET;
        const tokens = await requestJsonHttps("https://oauth2.googleapis.com/token", { method: "POST", form });
        const verified = await verifyGoogleIdToken(tokens?.id_token || "", context.stateNonce);
        let result;
        if (context.mode === "link") {
            const profile = await getAccountProfile(context.accountId, { forceFresh: true });
            if (!profile) throw Object.assign(new Error("account not found"), { code: "ACCOUNT_NOT_FOUND" });
            if (profile.status === "deleted") throw Object.assign(new Error("account deleted"), { code: "ACCOUNT_DELETED" });
            if (profile.status === "suspended") throw Object.assign(new Error("account suspended"), { code: "ACCOUNT_SUSPENDED" });
            if (isTemporaryExpired(profile)) throw Object.assign(new Error("temporary account expired"), { code: "ACCOUNT_EXPIRED" });
            const storedHash = String(profile[ACCOUNT_IDENTITY_HASH_FIELD] || "");
            if (!storedHash || storedHash !== context.accountTokenHash) throw Object.assign(new Error("account link credential is invalid"), { code: "ACCOUNT_AUTH_FAILED" });
            result = await linkGoogleIdentityToAccount(context.accountId, verified.providerSubject, verified.claims, verified.claims?.name || "");
        } else {
            result = await createGoogleGameAccount(verified.providerSubject, verified.claims);
        }
        const sameAccountReauth = context.mode === "login" && !!context.reauth && normalizeAccountId(context.accountId || "") === normalizeAccountId(result.accountId || "");
        const handoff = createSignedState({ v: 1, exp: Date.now() + ACCOUNT_GOOGLE_HANDOFF_TTL_MS, n: crypto.randomBytes(18).toString("hex"), mode: context.mode, reauth: sameAccountReauth, accountId: result.accountId, accountToken: result.token, accountType: result.profile?.accountType || "google", displayName: result.profile?.currentName || "", returnTo: normalizeReturnTo(context.returnTo || "/") });
        setHttpOnlyCookie(res, GOOGLE_HANDOFF_COOKIE, handoff, ACCOUNT_GOOGLE_HANDOFF_TTL_MS, authCookieSecure(req));
        clearHttpOnlyCookie(res, GOOGLE_STATE_COOKIE, authCookieSecure(req));
        return res.redirect("/auth/google/complete");
    } catch (e) {
        console.error("[google-auth] callback failed:", e?.name, e?.code || "", e?.message || "");
        clearHttpOnlyCookie(res, GOOGLE_STATE_COOKIE, authCookieSecure(req));
        return res.redirect(`/auth/google/complete?error=${encodeURIComponent(String(e?.code || "GOOGLE_AUTH_FAILED"))}`);
    }
});

app.get("/auth/google/complete", (req, res) => { res.setHeader("Cache-Control", "no-store"); res.type("html").send(googleCompleteHtml()); });

app.get("/api/auth/google/handoff", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const payload = verifySignedState(readCookie(req.headers?.cookie, GOOGLE_HANDOFF_COOKIE));
    clearHttpOnlyCookie(res, GOOGLE_HANDOFF_COOKIE, authCookieSecure(req));
    if (!payload?.accountId || !payload?.accountToken) return res.status(401).json({ ok: false, code: "GOOGLE_HANDOFF_EXPIRED" });
    res.json({ ok: true, accountId: payload.accountId, accountToken: payload.accountToken, accountType: payload.accountType || "google", displayName: sanitizeName(payload.displayName || "", ""), mode: payload.mode || "login", reauth: !!payload.reauth, returnTo: normalizeReturnTo(payload.returnTo || "/") });
});

app.post("/api/account/logout", express.json({ limit: "4kb" }), async (req, res) => {
    const accountId = normalizeAccountId(req.body?.accountId || "");
    const accountToken = normalizeAccountToken(req.body?.accountToken || "");
    if (!accountId || !accountToken) return res.status(400).json({ ok: false, code: "ACCOUNT_AUTH_REQUIRED" });
    try {
        const verified = await verifyAccountLogin(accountId, accountToken);
        if (!verified.profile) return res.status(404).json({ ok: false, code: "ACCOUNT_NOT_FOUND" });
        if (verified.ok === false) return res.status(403).json({ ok: false, code: verified.code });
        if (verified.session?.provider === "google") await revokeAccountSession(accountId, accountToken);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, code: "ACCOUNT_LOGOUT_FAILED" }); }
});

// endpoint ให้หน้า lobby (index.html) ดึงสถิติของผู้เล่นคนเดียวไปโชว์ในป็อปอัป — ไม่ต้องใช้ socket
// เพราะหน้านี้ไม่ได้เชื่อม socket.io อยู่แล้ว (ดู index.main.js) ขอแค่ query param name= พอ
app.get("/api/player-stats", async (req, res) => {
    const accountId = normalizeAccountId(req.query.accountId);
    const accountToken = normalizeAccountToken(req.headers["x-ww-account-token"] || "");
    const name = String(req.query.name || "").trim();
    if (!accountId && !name) return res.status(400).json({ error: "missing name or accountId" });

    try {
        // บัญชีใหม่: ต้องพิสูจน์ accountToken ก่อนอ่านข้อมูลของ accountId
        if (accountId) {
            if (!accountToken) return res.status(401).json({ error: "account authentication required", code: "ACCOUNT_AUTH_REQUIRED" });
            const verified = await verifyAccountLogin(accountId, accountToken);
            if (!verified.profile) return res.status(404).json({ error: "account not found", code: "ACCOUNT_NOT_FOUND" });
            if (verified.ok === false) return res.status(403).json({ error: verified.code.toLowerCase(), code: verified.code });
            const data = await queryAccountDetails(accountId);
            if (data) return res.json({ name: data.name || name, accountId, ...rateBreakdown(data), roles: data.roles || [], account: accountPublicProfile(verified.profile) });
        }
        const doc = await getDynamoDocClient();
        const result = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :name",
            ExpressionAttributeValues: { ":name": name },
        }));

        const items = result.Items || [];
        const totalRow = items.find((it) => it.statKey === "TOTAL") || { games: 0, wins: 0, leaves: 0 };
        const roles = items
            .filter((it) => it.statKey.startsWith("ROLE#"))
            .map((it) => {
                const role = it.statKey.slice("ROLE#".length);
                return { role, team: teamOf(role), teamLabel: roleTeamLabels[teamOf(role)] || "", ...rateBreakdown(it) };
            })
            .sort((a, b) => b.games - a.games);

        res.json({ name, ...rateBreakdown(totalRow), roles });
    } catch (e) {
        // ยังไม่ได้สร้างตาราง/ยังไม่ได้ให้สิทธิ์ IAM/DynamoDB มีปัญหาชั่วคราว — ไม่พังทั้งหน้า lobby
        // แค่โชว์ป็อปอัปว่าดึงสถิติไม่ได้ (ดู index.main.js) เกมส่วนอื่นเล่นต่อได้ปกติไม่กระทบ
        console.error("[stats] ดึงสถิติจาก DynamoDB ล้มเหลว:", e.message);
        res.status(500).json({ error: "stats unavailable" });
    }
});

// ============================================================
// ADMIN — รายชื่อผู้เล่นทั้งหมดที่เคยลงทะเบียน + ประวัติรายคน (ดู PLAYER REGISTRY ด้านบน)
// ทุก /api/admin/* ผ่าน middleware ยืนยัน Admin session ก่อนถึง handler
// ============================================================

// ADMIN PLAYER DIRECTORY — บัญชีจริง + ผู้เล่น legacy เก่า (ไม่มี accountId)
// บัญชีใหม่ใช้ accountId เป็นตัวตน; ชื่อเป็นเพียง displayName และเปลี่ยนจาก Admin ได้แม้ออฟไลน์
app.get("/api/admin/players", async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    try {
        const modern = await queryAllAccountProfiles();
        const modernNames = new Set();
        const players = modern.filter((it) => it.isTester !== true).map((it) => {
            const accountId = normalizeAccountId(it.accountId || String(it.statKey || "").replace(/^ACCOUNT#/, ""));
            const aliases = Array.isArray(it.aliases) ? Array.from(new Set(it.aliases.filter(Boolean))) : [];
            if (it.currentName) modernNames.add(String(it.currentName));
            aliases.forEach((a) => modernNames.add(String(a)));
            const total = { games: it.games || 0, wins: it.wins || 0, leaves: it.leaves || 0 };
            const live = getLiveSessionsForAccount(accountId);
            return {accountId,name:it.currentName||"ผู้เล่น",aliases,firstSeen:it.firstSeen||null,lastSeen:it.lastSeen||null,joinCount:it.joinCount||0,status:it.status||"active",accountType:it.accountType||ACCOUNT_TYPE_TEMPORARY,provider:it.provider||"temporary",temporaryExpiresAt:it.temporaryExpiresAt||null,online:live.length>0,roomIds:Array.from(new Set(live.map(x=>x.roomId))),legacy:false,...rateBreakdown(total)};
        });
        const doc=await getDynamoDocClient(); const legacyItems=[]; let ExclusiveStartKey;
        do { const out=await doc.send(new ScanCommand({TableName:STATS_TABLE_NAME,FilterExpression:"statKey = :reg",ExpressionAttributeValues:{":reg":"REG"},ExclusiveStartKey})); legacyItems.push(...(out.Items||[])); ExclusiveStartKey=out.LastEvaluatedKey; } while(ExclusiveStartKey);
        for(const it of legacyItems){
            const name=String(it.playerName||"");
            if(!name||modernNames.has(name)) continue;
            // Legacy tester records from older builds had EVENT rows marked isTester=true.
            // Hide those from the real-player directory without deleting user data blindly.
            let testerOnly = false;
            try {
                const ev = await doc.send(new QueryCommand({TableName:STATS_TABLE_NAME,KeyConditionExpression:"playerName = :name",ExpressionAttributeValues:{":name":name}}));
                const events=(ev.Items||[]).filter(x=>String(x.statKey||"").startsWith("EVENT#"));
                testerOnly = events.length > 0 && events.every(x=>x.isTester === true);
            } catch (_) {}
            if(testerOnly) continue;
            players.push({accountId:"",name,aliases:[],firstSeen:it.firstSeen||null,lastSeen:it.lastSeen||null,joinCount:it.joinCount||0,status:"legacy",online:false,roomIds:[],legacy:true,games:0,wins:0,losses:0,leaves:0,winRate:0,lossRate:0,leaveRate:0});
        }
        const filtered=q?players.filter(x=>String(x.name).toLowerCase().includes(q)||(x.aliases||[]).some(a=>String(a).toLowerCase().includes(q))):players;
        filtered.sort((a,b)=>String(b.lastSeen||"").localeCompare(String(a.lastSeen||"")));
        res.json({ok:true,players:filtered});
    } catch(e){ res.status(500).json({error:"registry unavailable",detail:`${e.name}: ${e.message}`}); }
});

app.get("/api/admin/player-account", async (req, res) => {
    const accountId = normalizeAccountId(req.query.accountId);
    if (!accountId) return res.status(400).json({ error: "missing accountId" });
    try {
        const account = await queryAccountDetails(accountId);
        if (!account) return res.status(404).json({ error: "account not found" });
        res.json({ ok: true, account });
    } catch (e) {
        console.error("[admin] player account failed:", e.name, e.message);
        res.status(500).json({ error: "account unavailable", detail: `${e.name}: ${e.message}` });
    }
});

app.get("/api/admin/player-history", async (req, res) => {
    const accountId = normalizeAccountId(req.query.accountId);
    const name = String(req.query.name || "").trim();
    try {
        if (accountId) {
            const data = await queryAccountDetails(accountId);
            if (!data) return res.status(404).json({ error: "account not found" });
            return res.json(data);
        }
        if (!name) return res.status(400).json({ error: "missing name" });
        const doc = await getDynamoDocClient();
        const result = await doc.send(new QueryCommand({
            TableName: STATS_TABLE_NAME,
            KeyConditionExpression: "playerName = :name",
            ExpressionAttributeValues: { ":name": name },
        }));
        const items = result.Items || [];
        const regRow = items.find((it) => it.statKey === "REG") || {};
        const totalRow = items.find((it) => it.statKey === "TOTAL") || { games: 0, wins: 0, leaves: 0 };
        const events = items.filter((it) => String(it.statKey || "").startsWith("EVENT#")).map((it) => ({
            type: it.type, eventKind: it.eventKind || (it.left ? "game_leave" : (it.type === "game_end" ? "game_end" : "room_join")),
            roomId: it.roomId || "", time: it.time, isHost: !!it.isHost, isTester: !!it.isTester,
            role: it.role || null, team: it.team || null, teamLabel: it.team ? (roleTeamLabels[it.team] || "") : null,
            won: typeof it.won === "boolean" ? it.won : null, left: !!it.left, leaveReason: it.leaveReason || null,
        })).sort((a,b) => String(b.time).localeCompare(String(a.time)));
        return res.json({ name, legacy: true, status: "legacy", firstSeen: regRow.firstSeen || null, lastSeen: regRow.lastSeen || null, joinCount: regRow.joinCount || 0, ...rateBreakdown(totalRow), events });
    } catch (e) {
        console.error("[admin] player history failed:", e.name, e.message);
        res.status(500).json({ error: "history unavailable", detail: `${e.name}: ${e.message}` });
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
app.post("/api/diagnostics/client-error", express.json({ limit: "24kb" }), (req, res) => {
    if (!diagnosticRequestAllowed(req)) return res.status(429).json({ ok: false, error: "rate_limited" });
    const b = req.body || {};
    recordDiagnostic({
        source: "client",
        kind: b.kind || "client_error",
        page: b.page || "unknown",
        message: b.message || "",
        stack: b.stack || "",
        file: b.file || "",
        line: b.line,
        column: b.column,
        status: b.status,
        endpoint: b.endpoint,
        data: b.context || b.data,
        context: b.context || {},
        state: b.state || {},
        breadcrumbs: b.breadcrumbs || [],
        traceId: b.traceId || "",
        sessionId: b.sessionId || "",
        action: b.action || "",
        roomId: b.roomId || "",
        requestId: b.requestId || "",
        clientRequestId: req.headers["x-ww-client-request-id"] || "",
        operationId: b.operationId || "",
        causalHint: b.causalHint || null,
        fingerprint: b.fingerprint || "",
    });
    res.json({ ok: true });
});


function publicDiagnosticText(value) {
    return String(value ?? "")
        .slice(0, 12000)
        .replace(/([?&](?:token|accountToken|testerPass|tp|ts|jr|ac|authorization|cookie|secret|password)=)[^&\s)]+/gi, "$1[REDACTED]")
        .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "[REDACTED_CREDENTIAL]")
        .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}

function publicDiagnosticValue(value, depth = 0) {
    if (depth > 3 || value === null || value === undefined) return value == null ? "" : String(value);
    if (typeof value === "string") return value.slice(0, 1200);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 24).map((v) => publicDiagnosticValue(v, depth + 1));
    if (typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).slice(0, 40)) {
            if (/token|secret|password|authorization|cookie|accountToken|googleSub|email|ipAddress|remoteAddress|hostname/i.test(key)) continue;
            out[String(key).slice(0, 100)] = publicDiagnosticValue(value[key], depth + 1);
        }
        return out;
    }
    return String(value).slice(0, 1200);
}

function publicDiagnosticResource(resource) {
    const raw = String(resource || "");
    if (!raw) return "";
    return raw.replace(/arn:aws:([^:]+):([^:]*):([0-9]{12}):/, "arn:aws:$1:$2:***:");
}


function publicDiagnosticEventForShare(event = {}, keepAnalysis = false) {
    const out = publicDiagnosticEvent(event);
    // Share snapshots are intentionally slimmer than the Admin live feed to leave room for graph links.
    const crumbLimit = keepAnalysis ? 20 : 8;
    const serverCrumbLimit = keepAnalysis ? 40 : 16;
    out.breadcrumbs = Array.isArray(out.breadcrumbs) ? out.breadcrumbs.slice(-crumbLimit) : [];
    out.serverBreadcrumbs = Array.isArray(out.serverBreadcrumbs) ? out.serverBreadcrumbs.slice(-serverCrumbLimit) : [];
    out.stack = publicDiagnosticText(out.stack).slice(0, keepAnalysis ? 5000 : 3000);
    out.context = publicDiagnosticValue(out.context || {});
    out.state = publicDiagnosticValue(out.state || {});
    if (!keepAnalysis) delete out.analysis;
    return out;
}

function publicDiagnosticEvent(event = {}) {
    const out = {
        id: String(event.id || "").slice(0, 120),
        sequence: Number(event.sequence) || 0,
        time: String(event.time || ""),
        source: String(event.source || "").slice(0, 32),
        kind: String(event.kind || "").slice(0, 64),
        page: String(event.page || "").slice(0, 48),
        message: publicDiagnosticText(event.message),
        stack: publicDiagnosticText(event.stack),
        file: String(event.file || "").slice(0, 600),
        line: Number(event.line) || 0,
        column: Number(event.column) || 0,
        status: Number(event.status) || 0,
        endpoint: String(event.endpoint || "").slice(0, 600),
        data: publicDiagnosticValue(event.data || ""),
        context: publicDiagnosticValue(event.context || {}),
        state: publicDiagnosticValue(event.state || {}),
        breadcrumbs: Array.isArray(event.breadcrumbs) ? event.breadcrumbs.slice(-80).map(publicDiagnosticValue) : [],
        serverBreadcrumbs: Array.isArray(event.serverBreadcrumbs) ? event.serverBreadcrumbs.slice(-120).map(publicDiagnosticValue) : [],
        traceId: String(event.traceId || "").slice(0, 120),
        sessionId: String(event.sessionId || "").slice(0, 120),
        action: String(event.action || "").slice(0, 120),
        operation: String(event.operation || "").slice(0, 120),
        roomId: String(event.roomId || "").slice(0, 32),
        requestId: String(event.requestId || "").slice(0, 120),
        clientRequestId: String(event.clientRequestId || "").slice(0, 120),
        durationMs: Number(event.durationMs) || 0,
        operationId: String(event.operationId || "").slice(0, 120),
        causalHint: publicDiagnosticValue(event.causalHint || {}),
        fingerprint: String(event.fingerprint || "").slice(0, 80),
        permission: event.permission ? { action:String(event.permission.action || "").slice(0, 120), resource:publicDiagnosticResource(event.permission.resource), accessDenied:!!event.permission.accessDenied } : null,
        serverInstance: event.serverInstance ? { appVersion:String(event.serverInstance.appVersion || "").slice(0, 120), uptimeSec:Number(event.serverInstance.uptimeSec) || 0 } : null,
    };
    out.analysis = publicDiagnosticValue(event.analysis || {});
    return out;
}

function relatedDiagnosticEventsFor(event) {
    const exact = diagnosticEvents.filter((x) =>
        (event.traceId && x.traceId === event.traceId) ||
        (event.sessionId && x.sessionId === event.sessionId) ||
        (event.operationId && x.operationId === event.operationId) ||
        (event.requestId && (x.requestId === event.requestId || x.clientRequestId === event.requestId)) ||
        (event.clientRequestId && (x.clientRequestId === event.clientRequestId || x.requestId === event.clientRequestId))
    );
    const cluster = diagnosticCausalClusterForEvent(event, DIAGNOSTIC_CAUSAL_MAX_NODES);
    const map = new Map();
    for (const x of [...exact, ...cluster]) if (x?.id) map.set(x.id, x);
    return Array.from(map.values()).sort((a,b) => diagnosticTimeMs(b) - diagnosticTimeMs(a));
}

function diagnosticShareToken() {
    return crypto.randomBytes(DIAGNOSTIC_SHARE_TOKEN_BYTES).toString("base64url");
}

function diagnosticShareStatKey(token) {
    return `${DIAGNOSTIC_SHARE_STAT_PREFIX}${token}`;
}

function diagnosticIncidentIdentity(event = {}) {
    const operationId = String(event.operationId || event.context?.operationId || event.detail?.operationId || "").trim();
    const requestId = String(event.requestId || event.context?.requestId || event.detail?.requestId || event.clientRequestId || "").trim();
    const traceId = String(event.traceId || "").trim();
    const sessionId = String(event.sessionId || "").trim();
    const roomId = String(event.roomId || "").trim().toUpperCase();
    // Prefer identifiers that represent one concrete attempt. A bare roomId is never enough.
    if (operationId) return `operation:${operationId}`;
    if (requestId) return `request:${requestId}`;
    if (traceId) return `trace:${traceId}${sessionId ? `|session:${sessionId}` : ""}${roomId ? `|room:${roomId}` : ""}`;
    if (sessionId) return `session:${sessionId}${roomId ? `|room:${roomId}` : ""}`;
    return "";
}

function diagnosticIncidentIndexKey(incidentKey) {
    const digest = crypto.createHash("sha256").update(String(incidentKey || "")).digest("hex").slice(0, 40);
    return `${DIAGNOSTIC_INCIDENT_INDEX_PREFIX}${digest}`;
}

function validDiagnosticShareToken(token) {
    return /^[A-Za-z0-9_-]{20,80}$/.test(String(token || ""));
}

function diagnosticSharePublicBaseUrl(req) {
    const configured = String(process.env.DIAGNOSTIC_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.secure ? "https" : "http");
    const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const host = forwardedHost || req.get("host");
    return `${/^https?$/i.test(forwardedProto) ? forwardedProto : "https"}://${host}`;
}

function diagnosticShareEventUrl(bundle, token, eventId, json = false) {
    const base = String(bundle?.shareBaseUrl || "").replace(/\/+$/, "");
    if (!base || !token || !eventId) return "";
    const suffix = `/event/${encodeURIComponent(String(eventId))}`;
    return `${base}/diagnostics/share/${encodeURIComponent(String(token))}${suffix}${json ? ".json" : ""}`;
}

function diagnosticShareFocusedBundle(bundle, eventId) {
    const id = String(eventId || "");
    if (!id) return null;
    const event = Array.isArray(bundle?.relatedEvents) ? bundle.relatedEvents.find(x => String(x.id || "") === id) : null;
    if (!event) return null;
    const nodeReport = Array.isArray(bundle?.nodeReports) ? bundle.nodeReports.find(x => String(x.eventId || "") === id) : null;
    return {
        ...bundle,
        focusEventId: id,
        focusNotice: `รายงานนี้โฟกัสที่ event ${id} ภายใน incident snapshot เดียวกัน`,
        primary: event,
        analysis: nodeReport?.analysis || event.analysis || bundle.analysis || {},
    };
}

function diagnosticShareEdgeLines(bundle, token, graph, focusId) {
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const nodes = new Map((Array.isArray(graph?.nodes) ? graph.nodes : []).map(n => [n.id, n]));
    const upstream = edges.filter(e => e.to === focusId && e.relation === "probable_cause").sort((a,b) => b.score-a.score).slice(0, 10);
    const downstream = edges.filter(e => e.from === focusId && ["probable_cause","downstream_effect","causal_context"].includes(e.relation)).sort((a,b) => b.score-a.score).slice(0, 12);
    const correlated = edges.filter(e => (e.to === focusId || e.from === focusId) && e.relation === "correlated_event").sort((a,b) => b.score-a.score).slice(0, 10);
    const lineFor = (e) => {
        const otherId = e.from === focusId ? e.to : e.from;
        const n = nodes.get(otherId) || {};
        const url = diagnosticShareEventUrl(bundle, token, otherId, false);
        const jsonUrl = diagnosticShareEventUrl(bundle, token, otherId, true);
        return `${otherId} | ${n.kind || "event"} | ${n.code || "-"} | ${n.stage || "unknown"} | confidence=${e.confidence} | score=${e.score} | Δ=${e.timeDeltaMs}ms\n  reason: ${(e.reasons || []).join("; ")}\n  REPORT: ${url || "-"}\n  JSON: ${jsonUrl || "-"}`;
    };
    return { upstream, downstream, correlated, lineFor };
}

function diagnosticShareText(bundle, token = "", focusEventId = "") {
    const a = bundle.analysis || {};
    const focusId = String(focusEventId || bundle.focusEventId || bundle.primary?.id || "");
    const graph = bundle.causalGraph || {};
    const edgeLines = diagnosticShareEdgeLines(bundle, token, graph, focusId);
    const focusUrl = diagnosticShareEventUrl(bundle, token, focusId, false) || "";
    const focusJsonUrl = diagnosticShareEventUrl(bundle, token, focusId, true) || "";
    const isFocused = !!bundle.focusEventId;
    const lines = [
        "WEREWOLF DIAGNOSTIC SHARE REPORT v3",
        "====================================",
        `ชนิดรายงาน: ${isFocused ? "FOCUSED NODE / INCIDENT SNAPSHOT" : "INCIDENT ROOT"}`,
        `สร้างเมื่อ: ${bundle.createdAt}`,
        `หมดอายุ: ${bundle.expiresAt}`,
        `Report ID: ${bundle.reportId}`,
        `โฟกัส Event ID: ${focusId || "-"}`,
        bundle.focusNotice ? `หมายเหตุ: ${bundle.focusNotice}` : "",
        focusUrl ? `FOCUSED REPORT URL: ${focusUrl}` : "",
        focusJsonUrl ? `FOCUSED JSON URL: ${focusJsonUrl}` : "",
        `ROOT REPORT URL: ${bundle.shareBaseUrl && token ? `${bundle.shareBaseUrl.replace(/\/+$/, "")}/diagnostics/share/${encodeURIComponent(String(token))}` : "-"}`,
        `ชนิด Error: ${bundle.primary?.kind || "error"}`,
        `แหล่งที่มา: ${bundle.primary?.source || "-"}`,
        `หน้า: ${bundle.primary?.page || "-"}`,
        `Trace ID: ${bundle.primary?.traceId || "-"}`,
        `Session ID: ${bundle.primary?.sessionId || "-"}`,
        `Operation ID: ${bundle.primary?.operationId || "-"}`,
        `Request ID: ${bundle.primary?.requestId || "-"}`,
        `ห้อง: ${bundle.primary?.roomId || "-"}`,
        `Fingerprint: ${bundle.primary?.fingerprint || "-"}`,
        "",
        "INCIDENT GROUPING / REPORT CONSOLIDATION",
        `INCIDENT KEY HASH: ${bundle.incident?.incidentKeyHash || "-"}`,
        `SHARE REUSED FROM SAME INCIDENT: ${bundle.incident?.reusedExistingShare ? "YES" : "NO / NEW INCIDENT"}`,
        `INCIDENT REUSE WINDOW: ${bundle.incident?.reuseWindowMs ? `${Math.round(Number(bundle.incident.reuseWindowMs) / 60000)} minutes` : "-"}`,
        `INCIDENT STATEMENT: ${bundle.incident?.statement || "-"}`,
        `INCIDENT MASTER URL: ${bundle.shareUrls?.incident || bundle.shareUrls?.html || "-"}`,
        "หมายเหตุ: หากพบลิงก์หลายใบจากความพยายามเดียวกัน ให้ใช้ INCIDENT MASTER URL เป็นจุดเริ่มต้น และไล่ upstream/downstream จาก graph แทนการสรุปจาก log ใบเดียว",
        "",
        "ROOT CAUSE",
        `สรุป: ${a.rootCause || "ยังระบุไม่ได้"}`,
        `CAUSE CODE: ${a.causeCode || "UNCLASSIFIED"}`,
        `FAILURE STAGE: ${a.failureStage || "unknown"}`,
        `ROOT SOURCE: ${a.rootCauseSource || "unknown"}`,
        `CONFIDENCE: ${a.confidence || "low"}`,
        `FIRST FAILURE: ${a.firstFailureAt || "-"}`,
        `ROOT CAUSE AT: ${a.rootCauseAt || "-"}`,
        `LAST SEEN: ${a.lastSeenAt || "-"}`,
        `RELATED EVENTS: ${a.relatedEventCount || 0}`,
        `EVIDENCE ITEMS: ${a.evidenceItemCount || 0}`,
        a.evidence?.length ? `EVIDENCE: ${a.evidence.join(" | ")}` : "EVIDENCE: -",
        "",
        "CAUSAL IMPACT / CROSS-LOG RELATIONSHIPS",
        `THIS LOG CAUSED ANOTHER LOG?: ${edgeLines.downstream.length ? "YES — มี downstream ที่ระบบให้เหตุผลเชิงเหตุ→ผล" : "NO DIRECT EVIDENCE IN SNAPSHOT"}`,
        `UPSTREAM CAUSE LOGS: ${edgeLines.upstream.length}`,
        `DOWNSTREAM EFFECT LOGS: ${edgeLines.downstream.length}`,
        `CORRELATED LOGS (ยังไม่ฟันธงเหตุ→ผล): ${edgeLines.correlated.length}`,
        `GRAPH NODES: ${graph.nodeCount || 0}`,
        `GRAPH EDGES: ${graph.edgeCount || 0}`,
        graph.impact?.statement ? `IMPACT STATEMENT: ${graph.impact.statement}` : "",
        "",
        "UPSTREAM CAUSES (ย้อนกลับไปหาต้นเหตุ)",
        ...(edgeLines.upstream.length ? edgeLines.upstream.map(edgeLines.lineFor) : ["(ไม่พบ upstream ที่เข้าเกณฑ์ causal)"]),
        "",
        "DOWNSTREAM EFFECTS (log ที่เกิดตามหลังและสัมพันธ์กับเหตุการณ์นี้)",
        ...(edgeLines.downstream.length ? edgeLines.downstream.map(edgeLines.lineFor) : ["(ไม่พบ downstream ที่เข้าเกณฑ์ causal)"]),
        "",
        "CORRELATED / AMBIGUOUS EVENTS",
        ...(edgeLines.correlated.length ? edgeLines.correlated.map(edgeLines.lineFor) : ["(ไม่มี)"]),
        "",
        "ROOT CAUSE CANDIDATES (ผู้ต้องสงสัยต้นเหตุที่มีหลักฐานเชื่อม downstream)",
        ...(Array.isArray(graph.rootCauseCandidates) && graph.rootCauseCandidates.length ? graph.rootCauseCandidates.map((n, i) => {
            const url = diagnosticShareEventUrl(bundle, token, n.id, false);
            return `${i + 1}. ${n.id} | ${n.kind} | ${n.code || "-"} | ${n.stage} | downstream=${n.downstreamCount} | score=${n.strongestDownstreamScore}\n   REPORT: ${url || "-"}\n   EVIDENCE: ${(n.evidence || []).join(" | ") || "-"}`;
        }) : ["(ยังไม่พบ root candidate ที่แยกจาก event ปัจจุบันได้)"]),
        "",
        "TERMINAL EFFECTS (ปลายทางของ causal chain)",
        ...(Array.isArray(graph.terminalEffects) && graph.terminalEffects.length ? graph.terminalEffects.map((n, i) => {
            const url = diagnosticShareEventUrl(bundle, token, n.id, false);
            return `${i + 1}. ${n.id} | ${n.kind} | ${n.code || "-"} | ${n.stage} | REPORT: ${url || "-"}`;
        }) : ["(ยังไม่พบ terminal effect)"]),
        "",
        "CAUSAL ROOT PATH",
        ...(Array.isArray(graph.rootPath) && graph.rootPath.length ? graph.rootPath.map((n, i) => {
            const url = diagnosticShareEventUrl(bundle, token, n.id, false);
            return `${i + 1}. ${n.id} | ${n.kind} | ${n.code || "-"} | ${n.stage} | ${n.message || ""}\n   REPORT: ${url || "-"}`;
        }) : ["(ยังสร้าง root path ไม่ได้)"]),
        "",
        "CAUSAL CHAIN (ต้นสาย → ปลายเหตุ)",
        ...(Array.isArray(graph.rootPath) && graph.rootPath.length ? graph.rootPath.map((n, i) => `${i + 1}. ${n.id} | ${n.stage} | ${n.code || "-"}`) : ["(ยังไม่มี causal chain ที่ชัดเจน)"]),
        "",
        "AUTH EVIDENCE (client → server)",
        JSON.stringify(a.authEvidence || {}, null, 2),
        "",
        "BLOCKING EVENT",
        JSON.stringify(a.blockingEvent || {}, null, 2),
        "",
        "CORRELATION",
        JSON.stringify(a.correlation || {}, null, 2),
        "",
        "NEXT STEP",
        a.nextStep || "-",
        "",
        "TIMELINE",
        ...(Array.isArray(a.timeline) && a.timeline.length ? a.timeline.map((x) => `${x.time} | ${x.stage} | ${x.kind} | ${x.code || "-"} | ${x.label}`) : ["(ไม่มี)"]),
        "",
        "PRIMARY / FOCUSED EVENT DETAIL",
        JSON.stringify(bundle.primary || {}, null, 2),
        "",
        "RELATED EVENT DETAILS",
        ...(Array.isArray(bundle.relatedEvents) && bundle.relatedEvents.length ? bundle.relatedEvents.map((x) => `--- ${x.time} | ${x.id} | ${x.kind} | ${x.source} ---\nREPORT: ${diagnosticShareEventUrl(bundle, token, x.id, false) || "-"}\nJSON: ${diagnosticShareEventUrl(bundle, token, x.id, true) || "-"}\n${JSON.stringify(x, null, 2)}`) : ["(ไม่มี)"]),
        "",
        "HOW TO TRACE FURTHER",
        "เปิด REPORT URL ของ upstream เพื่อย้อนหาต้นเหตุของ log นั้นต่อ และเปิด REPORT URL ของ downstream เพื่อดูผลกระทบ/สาเหตุของ log ปลายทางต่อไป; ทุกลิงก์เป็น snapshot incident เดียวกันและผูกกับ event ID ใน graph",
    ];
    return lines.filter((x, i) => x !== "" || lines[i-1] !== "").join("\n");
}

function escapeDiagnosticHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]));
}

function diagnosticShareHtml(bundle, token, focusEventId = "") {
    const text = diagnosticShareText(bundle, token, focusEventId);
    const cause = bundle.analysis?.causeCode || "UNCLASSIFIED";
    const jsonHref = token ? `./${encodeURIComponent(String(token))}.json` : "";
    const focusedHref = token && focusEventId ? `./${encodeURIComponent(String(token))}/event/${encodeURIComponent(String(focusEventId))}` : "";
    const focusedJsonHref = focusedHref ? `${focusedHref}.json` : "";
    const linkedText = escapeDiagnosticHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="description" content="Werewolf diagnostic report ${escapeDiagnosticHtml(cause)}"><meta http-equiv="Referrer-Policy" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"><title>Werewolf Diagnostic ${escapeDiagnosticHtml(cause)}</title><style>body{margin:0;background:#0a0d14;color:#e8edf8;font:14px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}main{width:min(1120px,calc(100% - 32px));margin:24px auto}header{margin-bottom:14px;padding:16px 18px;border:1px solid #222a3b;border-radius:14px;background:#101624}h1{font-size:18px;margin:0 0 5px}p{margin:0;color:#aab5ca}a{color:#aeb8ff}.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}.links a{padding:6px 9px;border:1px solid #303a51;border-radius:8px;text-decoration:none}pre{margin:0;padding:18px;white-space:pre-wrap;word-break:break-word;overflow:auto;border:1px solid #222a3b;border-radius:14px;background:#070a11;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}pre a{color:#9fb5ff;text-decoration:underline}code{font-family:inherit}</style></head><body><main><header><h1>🩺 Werewolf Diagnostic Share Report</h1><p>Cause: <b>${escapeDiagnosticHtml(cause)}</b> · หมดอายุ: ${escapeDiagnosticHtml(bundle.expiresAt)}</p><div class="links">${jsonHref ? `<a href="${jsonHref}">machine-readable JSON</a>` : ""}${focusedHref ? `<a href="${focusedHref}">focused event</a>` : ""}${focusedJsonHref ? `<a href="${focusedJsonHref}">focused JSON</a>` : ""}</div></header><pre>${linkedText}</pre></main></body></html>`;
}

async function persistDiagnosticShare(bundle, token, overwrite = false) {
    const doc = await getDynamoDocClient();
    const item = {
        playerName: DIAGNOSTIC_SHARE_PARTITION_KEY,
        statKey: diagnosticShareStatKey(token),
        entityType: "DIAGNOSTIC_SHARE",
        schemaVersion: DIAGNOSTIC_SHARE_VERSION,
        reportId: bundle.reportId,
        createdAt: bundle.createdAt,
        expiresAt: bundle.expiresAt,
        expiresAtEpoch: Math.floor(new Date(bundle.expiresAt).getTime() / 1000),
        bundle,
    };
    await doc.send(new PutCommand({
        TableName: STATS_TABLE_NAME,
        Item: item,
        ...(overwrite ? {} : { ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)" }),
    }));
}

async function getOrClaimDiagnosticIncidentShare(incidentKey, nowMs = Date.now()) {
    if (!incidentKey) return { token: "", reused: false };
    const doc = await getDynamoDocClient();
    const statKey = diagnosticIncidentIndexKey(incidentKey);
    const existing = await doc.send(new GetCommand({
        TableName: STATS_TABLE_NAME,
        Key: { playerName: DIAGNOSTIC_SHARE_PARTITION_KEY, statKey },
        ConsistentRead: true,
    }));
    const existingToken = String(existing.Item?.token || "");
    const existingExpires = Number(existing.Item?.expiresAtEpoch || 0) * 1000;
    if (validDiagnosticShareToken(existingToken) && existingExpires > nowMs) {
        return { token: existingToken, reused: true, incidentKey };
    }

    const token = diagnosticShareToken();
    const expiresAtEpoch = Math.floor((nowMs + Math.min(DIAGNOSTIC_SHARE_TTL_MS, DIAGNOSTIC_INCIDENT_REUSE_WINDOW_MS)) / 1000);
    try {
        await doc.send(new PutCommand({
            TableName: STATS_TABLE_NAME,
            Item: {
                playerName: DIAGNOSTIC_SHARE_PARTITION_KEY,
                statKey,
                entityType: "DIAGNOSTIC_INCIDENT_INDEX",
                schemaVersion: DIAGNOSTIC_SHARE_VERSION,
                incidentKeyHash: diagnosticIncidentIndexKey(incidentKey).slice(DIAGNOSTIC_INCIDENT_INDEX_PREFIX.length),
                token,
                createdAt: new Date(nowMs).toISOString(),
                expiresAtEpoch,
            },
            ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)",
        }));
        return { token, reused: false, incidentKey };
    } catch (e) {
        if (!/ConditionalCheckFailed/i.test(String(e?.name || e?.message || ""))) throw e;
        const winner = await doc.send(new GetCommand({
            TableName: STATS_TABLE_NAME,
            Key: { playerName: DIAGNOSTIC_SHARE_PARTITION_KEY, statKey },
            ConsistentRead: true,
        }));
        const winnerToken = String(winner.Item?.token || "");
        if (validDiagnosticShareToken(winnerToken)) return { token: winnerToken, reused: true, incidentKey };
        throw e;
    }
}

async function refreshDiagnosticIncidentShareIndex(incidentKey, token, expiresAt) {
    if (!incidentKey || !validDiagnosticShareToken(token)) return;
    try {
        const doc = await getDynamoDocClient();
        await doc.send(new PutCommand({
            TableName: STATS_TABLE_NAME,
            Item: {
                playerName: DIAGNOSTIC_SHARE_PARTITION_KEY,
                statKey: diagnosticIncidentIndexKey(incidentKey),
                entityType: "DIAGNOSTIC_INCIDENT_INDEX",
                schemaVersion: DIAGNOSTIC_SHARE_VERSION,
                incidentKeyHash: diagnosticIncidentIndexKey(incidentKey).slice(DIAGNOSTIC_INCIDENT_INDEX_PREFIX.length),
                token,
                createdAt: new Date().toISOString(),
                expiresAtEpoch: Math.floor(Math.min(new Date(expiresAt).getTime(), Date.now() + DIAGNOSTIC_INCIDENT_REUSE_WINDOW_MS) / 1000),
            },
        }));
    } catch (_) {}
}

async function readDiagnosticShare(token) {
    if (!validDiagnosticShareToken(token)) return null;
    const cached = diagnosticShares.get(token);
    const now = Date.now();
    if (cached) {
        if (cached.expiresAtEpoch * 1000 > now) return cached.bundle;
        diagnosticShares.delete(token);
    }
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({ TableName: STATS_TABLE_NAME, Key: { playerName: DIAGNOSTIC_SHARE_PARTITION_KEY, statKey: diagnosticShareStatKey(token) }, ConsistentRead: true }));
    const item = out.Item;
    if (!item || Number(item.expiresAtEpoch || 0) * 1000 <= now || !item.bundle) {
        if (item) { doc.send(new DeleteCommand({ TableName: STATS_TABLE_NAME, Key: { playerName: DIAGNOSTIC_SHARE_PARTITION_KEY, statKey: diagnosticShareStatKey(token) } })).catch(() => {}); }
        return null;
    }
    diagnosticShares.set(token, { expiresAtEpoch:Number(item.expiresAtEpoch), bundle:item.bundle });
    while (diagnosticShares.size > DIAGNOSTIC_SHARE_MAX_MEMORY) diagnosticShares.delete(diagnosticShares.keys().next().value);
    return item.bundle;
}

function rememberDiagnosticShare(token, bundle) {
    diagnosticShares.set(token, { expiresAtEpoch:Math.floor(new Date(bundle.expiresAt).getTime() / 1000), bundle });
    while (diagnosticShares.size > DIAGNOSTIC_SHARE_MAX_MEMORY) diagnosticShares.delete(diagnosticShares.keys().next().value);
}

// Admin-only Bug Replay control plane. All test cases are server-side allow-listed scenarios.
app.get("/api/admin/bug-replay/scenarios", (req, res) => {
    cleanupBugReplayJobs();
    const requestedMode = String(req.query?.mode || "all");
    const mode = requestedMode === "phase2" ? "phase2" : "all";
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok:true, mode, scenarios:listBugReplayScenarios(mode) });
});

app.post("/api/admin/bug-replay/start", async (req, res) => {
    try {
        const requestedMode = String(req.body?.mode || "all");
        const mode = requestedMode === "deep" ? "deep" : (requestedMode === "phase2" ? "phase2" : "all");
        const result = await startBugReplayJob(mode);
        res.setHeader("Cache-Control", "no-store");
        if (!result.ok) return res.status(409).json(result);
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok:false, error:"bug_replay_start_failed", code:"BUG_REPLAY_START_FAILED", message:publicDiagnosticText(e?.message || String(e)) });
    }
});

app.get("/api/admin/bug-replay/status", (req, res) => {
    cleanupBugReplayJobs();
    const runId = String(req.query.runId || bugReplayActiveRunId || "");
    const job = runId ? bugReplayJobs.get(runId) : null;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok:true, activeRunId:bugReplayActiveRunId || "", job:publicBugReplayJob(job) });
});

app.get("/api/admin/bug-replay/audit", (req, res) => {
    cleanupBugReplayJobs();
    const runId = String(req.query.runId || bugReplayActiveRunId || "");
    const job = runId ? bugReplayJobs.get(runId) : null;
    res.setHeader("Cache-Control", "no-store");
    if (!job) return res.status(404).json({ ok:false, error:"bug_replay_run_not_found", code:"BUG_REPLAY_RUN_NOT_FOUND" });
    res.json({ ok:true, runId, audit:job.audit ? job.audit.snapshot({ timelineLimit:220, findingLimit:100 }) : null });
});

app.post("/api/admin/bug-replay/stop", (req, res) => {
    const result = stopBugReplayJob(String(req.body?.runId || ""));
    res.setHeader("Cache-Control", "no-store");
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
});

// Admin-only diagnostics feed. Admin page does not depend on game JS/socket state to read this.
app.get("/api/admin/diagnostics", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
    const traceId = String(req.query.traceId || "").slice(0, 120);
    const sessionId = String(req.query.sessionId || "").slice(0, 120);
    const operationId = String(req.query.operationId || "").slice(0, 120);
    const requestId = String(req.query.requestId || "").slice(0, 120);
    const base = diagnosticEvents.filter((e) => {
        if (!(traceId || sessionId || operationId || requestId)) return true;
        return (traceId && e.traceId === traceId) || (sessionId && e.sessionId === sessionId) || (operationId && e.operationId === operationId) || (requestId && (e.requestId === requestId || e.clientRequestId === requestId));
    });
    const events = base.slice(0, limit).map((e) => {
        const related = relatedDiagnosticEventsFor(e);
        const serverBreadcrumbs = e.serverBreadcrumbs?.length ? e.serverBreadcrumbs : relatedServerBreadcrumbs({ traceId:e.traceId, sessionId:e.sessionId, limit:160 });
        const allForAnalysis = related.concat(serverBreadcrumbs.map((b) => ({ source:"server", kind:b.type, type:b.type, time:b.time, label:b.label, message:b.label, detail:b.detail, context:b.detail })));
        return { ...e, serverBreadcrumbs, analysis: buildDiagnosticAnalysis(e, allForAnalysis) };
    });
    const errors = events.filter((e) => e.kind !== "http_error" || e.status >= 500);
    res.json({
        ok: true,
        now: new Date().toISOString(),
        server: { uptimeSec: Math.round(process.uptime()), node: process.version, serverClosed: !!serverClosed, table: STATS_TABLE_NAME, ebEnvironmentConfigured: !!EB_ENVIRONMENT_NAME },
        summary: { stored: diagnosticEvents.length, shown: events.length, serious: errors.length, accessDenied: events.filter((e) => e.permission?.accessDenied).length },
        permissions: permissionChecklist(),
        events,
    });
});;


app.post("/api/admin/diagnostics/share", express.json({ limit: "12kb" }), async (req, res) => {
    try {
        const eventId = String(req.body?.eventId || "").slice(0, 120);
        if (!eventId) return res.status(400).json({ ok:false, error:"event_id_required", code:"DIAGNOSTIC_EVENT_REQUIRED" });
        const primary = diagnosticEvents.find((e) => e.id === eventId);
        if (!primary) return res.status(404).json({ ok:false, error:"diagnostic_event_not_found", code:"DIAGNOSTIC_EVENT_NOT_FOUND" });

        const related = relatedDiagnosticEventsFor(primary);
        const serverBreadcrumbs = primary.serverBreadcrumbs?.length ? primary.serverBreadcrumbs : relatedServerBreadcrumbs({ traceId:primary.traceId, sessionId:primary.sessionId, limit:160 });
        const allForAnalysis = related.concat(serverBreadcrumbs.map((b) => ({ source:"server", kind:b.type, type:b.type, time:b.time, label:b.label, message:b.label, detail:b.detail, context:b.detail })));
        const analysis = buildDiagnosticAnalysis(primary, allForAnalysis);
        const causalGraph = buildDiagnosticCausalGraph(primary, related);
        const incidentKey = diagnosticIncidentIdentity(primary);
        let token = "";
        let reusedIncident = false;
        let stored = false;
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + DIAGNOSTIC_SHARE_TTL_MS).toISOString();
        const baseUrl = diagnosticSharePublicBaseUrl(req);
        const graphIds = new Set((causalGraph.nodes || []).map(n => n.id));

        // Graph nodes get priority because these are exactly the logs that the report promises to link.
        const rankedRelated = related.slice().sort((a,b) => {
            const ag = graphIds.has(a.id) ? 1 : 0;
            const bg = graphIds.has(b.id) ? 1 : 0;
            if (ag !== bg) return bg - ag;
            const at = diagnosticTimeMs(a), bt = diagnosticTimeMs(b);
            return bt - at;
        });
        const publicRelated = rankedRelated.slice(0, 42).map((e) => publicDiagnosticEventForShare(e, e.id === primary.id));
        const publicPrimary = publicDiagnosticEventForShare(primary, true);

        const nodeReports = [];
        const nodeEvents = rankedRelated.filter(e => graphIds.has(e.id));
        for (const node of nodeEvents) {
            const nodeCrumbs = node.serverBreadcrumbs?.length ? node.serverBreadcrumbs : relatedServerBreadcrumbs({ traceId:node.traceId, sessionId:node.sessionId, limit:80 });
            const nodePool = related.concat(nodeCrumbs.map((b) => ({ source:"server", kind:b.type, type:b.type, time:b.time, label:b.label, message:b.label, detail:b.detail, context:b.detail })));
            const nodeAnalysis = buildDiagnosticAnalysis(node, nodePool);
            nodeReports.push({ eventId:String(node.id), analysis:compactDiagnosticAnalysisForShare(nodeAnalysis, causalGraph, node.id) });
        }

        let bundle = {
            schemaVersion: DIAGNOSTIC_SHARE_VERSION,
            reportId: primary.id,
            createdAt,
            expiresAt,
            shareBaseUrl: baseUrl,
            focusEventId: primary.id,
            primary: publicPrimary,
            relatedEvents: publicRelated,
            causalGraph: publicDiagnosticValue(causalGraph),
            nodeReports: publicDiagnosticValue(nodeReports),
            analysis: publicDiagnosticValue(analysis),
            incident: {
                incidentKeyHash: incidentKey ? diagnosticIncidentIndexKey(incidentKey).slice(DIAGNOSTIC_INCIDENT_INDEX_PREFIX.length) : "",
                reusedExistingShare: reusedIncident,
                reuseWindowMs: DIAGNOSTIC_INCIDENT_REUSE_WINDOW_MS,
                statement: incidentKey ? (reusedIncident ? "เหตุการณ์นี้อยู่ใน incident เดียวกับลิงก์ที่สร้างก่อนหน้า จึงใช้ลิงก์ incident เดิมเพื่อรวมต้นเหตุและผลกระทบไว้ในรายงานเดียว" : "incident นี้ได้รับลิงก์กลาง เพื่อให้ log หลายตัวจากความพยายามเดียวกันไม่แตกเป็นหลายรายงาน") : "ไม่มี correlation ID ที่ปลอดภัยพอสำหรับ incident grouping"
            },
            server: { node:process.version, appVersion:getCachedAppVersion(), serverClosed:!!serverClosed },
            generation: {
                requestedFromEventId: String(primary.id || ""),
                requestedFromKind: String(primary.kind || primary.type || ""),
                requestedAt: createdAt,
                sourceEventCount: related.length,
                serverBreadcrumbCount: serverBreadcrumbs.length,
                graphNodeCount: Number(causalGraph.nodes?.length || 0),
                graphEdgeCount: Number(causalGraph.edges?.length || 0),
                correlationMode: incidentKey ? (String(primary.operationId || primary.context?.operationId || "") ? "operationId" : (String(primary.requestId || primary.context?.requestId || primary.clientRequestId || "") ? "requestId/clientRequestId" : (String(primary.traceId || "") ? "trace/session/room" : "session/room"))) : "none",
                note: "event = log เดี่ยว, incident = กลุ่ม log ที่มี correlation และ causal evidence เชื่อมกัน; report นี้เก็บทั้งเหตุการณ์ก่อนหน้าและผลกระทบหลังเหตุการณ์เท่าที่พบใน snapshot",
            },
        };
        // Keep DynamoDB item comfortably below its 400 KB item limit and keep every graph node link valid.
        while (Buffer.byteLength(JSON.stringify(bundle), "utf8") > DIAGNOSTIC_SHARE_MAX_BYTES && bundle.relatedEvents.length > 12) {
            const graphEventIds = new Set((bundle.causalGraph?.nodes || []).map(n => n.id));
            const removable = [...bundle.relatedEvents].reverse().findIndex((x) => x.id !== primary.id && !graphEventIds.has(x.id));
            if (removable >= 0) bundle.relatedEvents.splice(bundle.relatedEvents.length - 1 - removable, 1);
            else bundle.relatedEvents.pop();
        }
        if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > DIAGNOSTIC_SHARE_MAX_BYTES) {
            return res.status(413).json({ ok:false, error:"diagnostic_report_too_large", code:"DIAGNOSTIC_SHARE_TOO_LARGE" });
        }

        if (incidentKey) {
            const claim = await getOrClaimDiagnosticIncidentShare(incidentKey, Date.now());
            token = claim.token;
            reusedIncident = !!claim.reused;
        }
        for (let attempt = 0; attempt < 3 && !stored; attempt++) {
            if (!token) token = diagnosticShareToken();
            const url = `${baseUrl}/diagnostics/share/${encodeURIComponent(token)}`;
            const jsonUrl = `${baseUrl}/diagnostics/share/${encodeURIComponent(token)}.json`;
            // Put recursive links directly into the JSON so an AI does not need to infer URLs from prose.
            bundle.shareUrls = { html:url, json:jsonUrl, focusedHtml:diagnosticShareEventUrl(bundle, token, primary.id, false), focusedJson:diagnosticShareEventUrl(bundle, token, primary.id, true) };
            if (bundle.causalGraph?.edges) {
                bundle.causalGraph.edges = bundle.causalGraph.edges.map((edge) => ({
                    ...edge,
                    reportUrl:diagnosticShareEventUrl(bundle, token, edge.to, false),
                    jsonReportUrl:diagnosticShareEventUrl(bundle, token, edge.to, true),
                    fromReportUrl:diagnosticShareEventUrl(bundle, token, edge.from, false),
                    fromJsonReportUrl:diagnosticShareEventUrl(bundle, token, edge.from, true),
                }));
            }
            if (Array.isArray(bundle.causalGraph?.nodes)) {
                bundle.causalGraph.nodes = bundle.causalGraph.nodes.map((node) => ({
                    ...node,
                    reportUrl:diagnosticShareEventUrl(bundle, token, node.id, false),
                    jsonReportUrl:diagnosticShareEventUrl(bundle, token, node.id, true),
                }));
            }
            bundle.relatedEvents = bundle.relatedEvents.map((event) => ({
                ...event,
                reportUrl:diagnosticShareEventUrl(bundle, token, event.id, false),
                jsonReportUrl:diagnosticShareEventUrl(bundle, token, event.id, true),
            }));
            bundle.nodeReports = bundle.nodeReports.map((node) => ({
                ...node,
                reportUrl:diagnosticShareEventUrl(bundle, token, node.eventId, false),
                jsonReportUrl:diagnosticShareEventUrl(bundle, token, node.eventId, true),
            }));
            // URL metadata is part of the persisted snapshot, so perform the byte-limit check again after adding it.
            while (Buffer.byteLength(JSON.stringify(bundle), "utf8") > DIAGNOSTIC_SHARE_MAX_BYTES && bundle.relatedEvents.length > 12) {
                const graphEventIds = new Set((bundle.causalGraph?.nodes || []).map(n => n.id));
                const removable = [...bundle.relatedEvents].reverse().findIndex((x) => x.id !== primary.id && !graphEventIds.has(x.id));
                if (removable < 0) break;
                bundle.relatedEvents.splice(bundle.relatedEvents.length - 1 - removable, 1);
            }
            if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > DIAGNOSTIC_SHARE_MAX_BYTES && bundle.nodeReports.length > 8) {
                bundle.nodeReports = bundle.nodeReports.slice(0, 8);
            }
            if (Buffer.byteLength(JSON.stringify(bundle), "utf8") > DIAGNOSTIC_SHARE_MAX_BYTES) {
                return res.status(413).json({ ok:false, error:"diagnostic_report_too_large", code:"DIAGNOSTIC_SHARE_TOO_LARGE" });
            }
            try {
                await persistDiagnosticShare(bundle, token, reusedIncident);
                stored = true;
            } catch (e) {
                if (/ConditionalCheckFailed/i.test(String(e?.name || e?.message || "")) && !incidentKey && attempt < 2) {
                    token = diagnosticShareToken();
                    continue;
                }
                if (!/ConditionalCheckFailed/i.test(String(e?.name || e?.message || "")) || attempt === 2) throw e;
            }
        }
        if (incidentKey) await refreshDiagnosticIncidentShareIndex(incidentKey, token, expiresAt);
        rememberDiagnosticShare(token, bundle);
        const url = `${baseUrl}/diagnostics/share/${encodeURIComponent(token)}`;
        const jsonUrl = `${baseUrl}/diagnostics/share/${encodeURIComponent(token)}.json`;
        bundle.shareUrls = { ...(bundle.shareUrls || {}), html:url, json:jsonUrl, focusedHtml:diagnosticShareEventUrl(bundle, token, primary.id, false), focusedJson:diagnosticShareEventUrl(bundle, token, primary.id, true), incident:url, incidentJson:jsonUrl };
        bundle.incident = {
            incidentKeyHash: incidentKey ? diagnosticIncidentIndexKey(incidentKey).slice(DIAGNOSTIC_INCIDENT_INDEX_PREFIX.length) : "",
            reusedExistingShare: reusedIncident,
            reuseWindowMs: DIAGNOSTIC_INCIDENT_REUSE_WINDOW_MS,
            statement: incidentKey ? (reusedIncident ? "เหตุการณ์นี้อยู่ใน incident เดียวกับลิงก์ที่สร้างก่อนหน้า จึงใช้ลิงก์ incident เดิมเพื่อไม่ให้เกิดรายงานแยกหลายใบ" : "สร้างลิงก์ incident กลางสำหรับเหตุการณ์ชุดนี้") : "เหตุการณ์นี้ไม่มี correlation ID ที่ปลอดภัยพอสำหรับการรวมเป็น incident เดียว"
        };
        addDiagnosticBreadcrumb({ source:"server", type:"diagnostic", label:"diagnostic.share.created", traceId:primary.traceId || "", sessionId:primary.sessionId || "", page:"admin", detail:{ reportId:primary.id, relatedEvents:related.length, graphNodes:causalGraph.nodes?.length || 0, graphEdges:causalGraph.edges?.length || 0, expiresAt, persisted:stored, incidentKeyHash:incidentKey ? diagnosticIncidentIndexKey(incidentKey).slice(DIAGNOSTIC_INCIDENT_INDEX_PREFIX.length) : "", reusedIncident } });
        res.setHeader("Cache-Control", "no-store");
        res.json({ ok:true, reportId:primary.id, token, url, jsonUrl, expiresAt, persisted:stored, reusedIncident, incidentKey:incidentKey ? diagnosticIncidentIndexKey(incidentKey).slice(DIAGNOSTIC_INCIDENT_INDEX_PREFIX.length) : "", relatedEvents:related.length, graphNodes:causalGraph.nodes?.length || 0, graphEdges:causalGraph.edges?.length || 0, sizeBytes:Buffer.byteLength(JSON.stringify(bundle), "utf8") });
    } catch (e) {
        const storageError = {
            code: String(e?.code || e?.name || "DIAGNOSTIC_SHARE_CREATE_ERROR").slice(0, 100),
            name: String(e?.name || "Error").slice(0, 100),
            message: publicDiagnosticText(e?.message || String(e)).slice(0, 600),
        };
        const bodyEventId = String(req.body?.eventId || "").slice(0, 120);
        const failedIncidentKey = bodyEventId ? (() => {
            const event = diagnosticEvents.find((x) => x.id === bodyEventId);
            return event ? diagnosticIncidentIdentity(event) : "";
        })() : "";
        const incidentKeyHash = failedIncidentKey ? diagnosticIncidentIndexKey(failedIncidentKey).slice(DIAGNOSTIC_INCIDENT_INDEX_PREFIX.length) : "";
        const requestId = makeDiagnosticId("diagshare");
        recordDiagnostic({
            source:"server", kind:"diagnostic_share_create_error", page:"admin",
            message:storageError.message, stack:e?.stack || "",
            requestId, operationId:bodyEventId ? `share:${bodyEventId}` : "",
            context:{
                code:"DIAGNOSTIC_SHARE_CREATE_FAILED",
                failureStage:"diagnostic.share.storage_or_generation",
                storageBackend:"dynamodb",
                eventId:bodyEventId, incidentKeyHash, requestId,
                storageError,
            },
        });
        res.status(503).json({
            ok:false, error:"diagnostic_share_storage_unavailable", code:"DIAGNOSTIC_SHARE_STORAGE_UNAVAILABLE",
            causeCode:storageError.code, causeName:storageError.name, causeMessage:storageError.message,
            failureStage:"diagnostic.share.storage_or_generation", requestId, eventId:bodyEventId, incidentKeyHash,
            diagnostic:"รายงานแชร์ล้มเหลวที่ขั้นตอนสร้าง/บันทึก snapshot ไม่ควรสรุปว่า DynamoDB เสียจากรหัสนี้เพียงอย่างเดียว; ตรวจ causeName/causeMessage และ requestId นี้ใน Diagnostics",
        });
    }
});

app.get("/diagnostics/share/:token.json", async (req, res) => {
    try {
        const bundle = await readDiagnosticShare(String(req.params.token || ""));
        res.setHeader("Cache-Control", "no-store, private");
        res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (!bundle) return res.status(404).json({ ok:false, error:"diagnostic_share_not_found", code:"DIAGNOSTIC_SHARE_NOT_FOUND" });
        res.json({ ok:true, ...bundle, reportText:diagnosticShareText(bundle) });
    } catch (e) {
        res.status(503).json({ ok:false, error:"diagnostic_share_unavailable", code:"DIAGNOSTIC_SHARE_UNAVAILABLE" });
    }
});


app.get("/diagnostics/share/:token/event/:eventId.json", async (req, res) => {
    try {
        const bundle = await readDiagnosticShare(String(req.params.token || ""));
        res.setHeader("Cache-Control", "no-store, private");
        res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (!bundle) return res.status(404).json({ ok:false, error:"diagnostic_share_not_found", code:"DIAGNOSTIC_SHARE_NOT_FOUND" });
        const token = String(req.params.token || "");
        const focused = diagnosticShareFocusedBundle(bundle, String(req.params.eventId || ""));
        if (!focused) return res.status(404).json({ ok:false, error:"diagnostic_share_event_not_found", code:"DIAGNOSTIC_SHARE_EVENT_NOT_FOUND" });
        focused.shareUrls = { ...(bundle.shareUrls || {}), focusedHtml:diagnosticShareEventUrl(bundle, token, focused.focusEventId, false), focusedJson:diagnosticShareEventUrl(bundle, token, focused.focusEventId, true) };
        res.json({ ok:true, ...focused, reportText:diagnosticShareText(focused, token, focused.focusEventId) });
    } catch (e) {
        res.status(503).json({ ok:false, error:"diagnostic_share_unavailable", code:"DIAGNOSTIC_SHARE_UNAVAILABLE" });
    }
});

app.get("/diagnostics/share/:token/event/:eventId", async (req, res) => {
    try {
        const bundle = await readDiagnosticShare(String(req.params.token || ""));
        res.setHeader("Cache-Control", "no-store, private");
        res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (!bundle) return res.status(404).type("html").send("<!doctype html><meta charset=\"utf-8\"><title>Diagnostic not found</title><p>Diagnostic report ไม่พบหรือหมดอายุแล้ว</p>");
        const focused = diagnosticShareFocusedBundle(bundle, String(req.params.eventId || ""));
        if (!focused) return res.status(404).type("html").send("<!doctype html><meta charset=\"utf-8\"><title>Diagnostic event not found</title><p>Event นี้ไม่มีอยู่ใน incident snapshot</p>");
        res.type("html").send(diagnosticShareHtml(focused, String(req.params.token || ""), focused.focusEventId));
    } catch (e) {
        res.status(503).type("html").send("<!doctype html><meta charset=\"utf-8\"><title>Diagnostic unavailable</title><p>ยังอ่านรายงานวินิจฉัยไม่ได้ชั่วคราว</p>");
    }
});
app.get("/diagnostics/share/:token", async (req, res) => {
    try {
        const bundle = await readDiagnosticShare(String(req.params.token || ""));
        res.setHeader("Cache-Control", "no-store, private");
        res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
        res.setHeader("Referrer-Policy", "no-referrer");
        if (!bundle) return res.status(404).type("html").send("<!doctype html><meta charset=\"utf-8\"><title>Diagnostic not found</title><p>Diagnostic report ไม่พบหรือหมดอายุแล้ว</p>");
        res.type("html").send(diagnosticShareHtml(bundle, String(req.params.token || "")));
    } catch (e) {
        res.status(503).type("html").send("<!doctype html><meta charset=\"utf-8\"><title>Diagnostic unavailable</title><p>ยังอ่านรายงานวินิจฉัยไม่ได้ชั่วคราว</p>");
    }
});

app.post("/api/admin/diagnostics/clear", (req, res) => {
    diagnosticEvents.length = 0;
    diagnosticPermissionCounts.clear();
    res.json({ ok: true });
});

app.get("/api/config", async (req, res) => {
    const startedAt = Date.now();
    const clientRequestId = String(req.headers["x-ww-client-request-id"] || "").slice(0, 120);
    const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex");
    let responseFinished = false;

    const traceId = String(req.headers["x-ww-diagnostic-trace-id"] || req.__wwDiagnostic?.traceId || makeDiagnosticId("tr")).slice(0, 120);
    const sessionId = String(req.headers["x-ww-client-session-id"] || req.__wwDiagnostic?.sessionId || "").slice(0, 120);
    res.setHeader("X-WW-Config-Request-Id", requestId);
    res.setHeader("X-WW-Diagnostic-Trace-Id", traceId);
    res.setHeader("X-WW-Server-Request-Id", requestId);
    if (clientRequestId) res.setHeader("X-WW-Client-Request-Id", clientRequestId);
    res.once("finish", () => {
        responseFinished = true;
        const durationMs = Date.now() - startedAt;
        // A normal config request is very small. Only store slow responses in Admin Diagnostics.
        if (durationMs >= 2000) {
            recordDiagnostic({
                source: "server",
                kind: "config_slow_response",
                page: "server",
                endpoint: "/api/config",
                message: `/api/config ใช้เวลา ${durationMs}ms`,
                data: { requestId, clientRequestId, traceId, sessionId, durationMs, statusCode: res.statusCode },
                traceId, sessionId, requestId, clientRequestId, durationMs,
            });
        }
    });
    res.once("close", () => {
        if (responseFinished) return;
        const durationMs = Date.now() - startedAt;
        // A fast /api/config close is commonly caused by page navigation/background lifecycle
        // (for example leaving index and returning). Keep it out of Admin Incidents; only retain
        // disconnects that stayed open long enough to indicate a potentially real upstream issue.
        if (durationMs < 2000) return;
        recordDiagnostic({
            source: "server",
            kind: "config_client_disconnect",
            page: "server",
            endpoint: "/api/config",
            message: `เบราว์เซอร์ตัดการเชื่อมต่อก่อน /api/config ตอบกลับ (${durationMs}ms)`,
            data: { requestId, clientRequestId, traceId, sessionId, durationMs },
            traceId, sessionId, requestId, clientRequestId, durationMs,
        });
    });

    try {
        // ใช้ Running Version เดียวกับ serverInfo แต่มี short timeout เพื่อไม่ให้ /api/config
        // ค้างเพราะ AWS control-plane; ถ้า AWS ช้าให้ตอบด้วย last-known-good ทันที
        const versionPromise = getAppVersion();
        const versionTimeout = new Promise((resolve) => {
            setTimeout(() => resolve(getCachedAppVersion()), 1_200);
        });
        const appVersion = await Promise.race([versionPromise, versionTimeout]);
        // resetEpoch: "รุ่นของการล้างข้อมูล" — เปลี่ยนทุกครั้งที่แอดมินกดล้างข้อมูลเกม (ดู /api/admin/reset)
        ensureResetEpochLoaded();
        // serverOpen / reloadEpoch / reloadKind / imageEpoch: ดูหัวข้อ "เปิด/ปิดเซิร์ฟเวอร์ + บังคับรีโหลด" ด้านบนสุดของไฟล์
        const shielded = req.query.real !== "1" && isProtectedRequest(req);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Vary", "Cookie, X-WW-Room, X-WW-Token, X-WW-Client-Request-Id");
        const versionParts = refreshVersionParts();
        res.json({
            version: computeServerVersion(),
            clientHash: versionParts.client,
            assetsHash: versionParts.assets,
            serverHash: versionParts.server,
            adminHash: computeAdminHash(),
            buildVersion: computeServerVersion(),
            imageBase: IMAGE_BASE_URL,
            appVersion,
            resetEpoch: resetEpoch || "",
            resetInProgress: !!resetInProgress,
            serverOpen: !serverClosed || shielded,
            testerShielded: !!shielded,
            reloadEpoch: shielded ? "" : reloadEpoch,
            reloadKind: shielded ? "" : reloadKind,
            testerReloadEpoch: shielded ? testerReloadEpoch : "",
            imageEpoch: currentImageVersion(),
            serverNow: Date.now(),
            closingInMs: !shielded && closingPlan ? Math.max(1, closingPlan.closeAt - Date.now()) : 0,
            noticeMessage: shielded ? "" : (closingPlan ? closingPlan.message : closedMessage),
            reopenAt: shielded ? 0 : (closingPlan ? closingPlan.reopenAt : closedReopenAt),
        });
    } catch (e) {
        recordDiagnostic({
            source: "server",
            kind: "config_handler_error",
            page: "server",
            endpoint: "/api/config",
            message: e?.message || String(e),
            stack: e?.stack || "",
            data: { requestId, clientRequestId, traceId, sessionId, durationMs: Date.now() - startedAt },
            traceId, sessionId, requestId, clientRequestId, durationMs: Date.now() - startedAt,
        });
        if (!res.headersSent) {
            res.status(500).json({ error: "config_unavailable", requestId });
        }
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
        imageBase: IMAGE_BASE_URL,
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
const _stampedCache = new Map(); // fileName -> { hash, mtime, html }
const STAMP_REF_RE = /(\b(?:src|href)=")((?:js|css)\/[^"?#]+\.(?:js|css))(")/g;

// SITE_ICON_REF_RE: favicon/apple-touch-icon/og:image (cover) ที่เป็น legacy path ใน source HTML
// จะถูกเปลี่ยนเป็น URL เต็มของ S3/CDN ตอน server ส่ง HTML ออกไป
// ใช้กับทุกหน้า (รวม admin.html/maintenance.html) และไม่มี local-file fallback
// เวอร์ชัน js/css ที่ตั้งใจไม่ให้ admin.html/maintenance.html โดนแตะ (ดู VERSION_SKIP_FILES)
const SITE_ICON_REF_RE = /(\b(?:href|content)=")__WW_IMAGE_BASE__(\/(?:favicon\.ico|favicon-32x32\.png|favicon-16x16\.png|apple-touch-icon\.png|cover-1200x630\.png))(")/g;
function applySiteIconBase(html) {
    return html.replace(SITE_ICON_REF_RE, (_m, pre, assetPath, post) => {
        if (!IMAGE_BASE_URL) return `${pre}about:blank${post}`;
        const v = currentImageVersion();
        return `${pre}${IMAGE_BASE_URL}${assetPath}${v ? `?v=${encodeURIComponent(v)}` : ""}${post}`;
    });
}

function getStampedHtml(fileName) {
    const file = path.join(PUBLIC_DIR, fileName);
    const hash = computeClientHash();
    let mtime = 0;
    try { mtime = Math.floor(fs.statSync(file).mtimeMs); } catch (e) { return null; }
    const cached = _stampedCache.get(fileName);
    if (cached && cached.hash === hash && cached.mtime === mtime && cached.imageBase === IMAGE_BASE_URL) return cached.html;
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return null; }
    let html = raw.replace(STAMP_REF_RE, (_m, pre, url, post) => `${pre}${url}?v=${hash}${post}`);
    html = applySiteIconBase(html);
    _stampedCache.set(fileName, { hash, mtime, html, imageBase: IMAGE_BASE_URL });
    return html;
}
app.get(Object.keys(STAMPED_PAGES), (req, res, next) => {
    const html = getStampedHtml(STAMPED_PAGES[req.path]);
    if (html === null) return next(); // อ่านไม่ได้ → ให้ express.static ตอบตามเดิม
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Vary", "Accept-Encoding");
    res.type("html").send(html);
});

// admin.html / maintenance.html: ไม่เข้าระบบ hash เวอร์ชัน js/css แต่ site/profile icons ต้องเป็น S3/CDN เท่านั้น
const ICON_ONLY_PAGES = { "/admin.html": "admin.html", "/maintenance.html": "maintenance.html" };
const _iconOnlyCache = new Map();
function getIconStampedHtml(fileName) {
    const file = path.join(PUBLIC_DIR, fileName);
    let mtime = 0;
    try { mtime = Math.floor(fs.statSync(file).mtimeMs); } catch (e) { return null; }
    const cached = _iconOnlyCache.get(fileName);
    if (cached && cached.mtime === mtime && cached.imageBase === IMAGE_BASE_URL) return cached.html;
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return null; }
    let html = raw;
    if (fileName === "admin.html") html = html.replace(/(<meta\s+name="ww-admin-release"\s+content=")__WW_ADMIN_RELEASE__("\s*\/?\s*>)/i, `$1${computeAdminHash()}$2`);
    html = applySiteIconBase(html);
    _iconOnlyCache.set(fileName, { mtime, html, imageBase: IMAGE_BASE_URL });
    return html;
}
app.get(Object.keys(ICON_ONLY_PAGES), (req, res, next) => {
    const html = getIconStampedHtml(ICON_ONLY_PAGES[req.path]);
    if (html === null) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(html);
});

// S3/CDN is the only source of game images. Any accidental request to the old local
// /images tree must never fall back to files bundled into the Elastic Beanstalk app.
app.use("/images", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ error: "image_assets_external_only" });
});

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
app.use(express.static("public", {
    maxAge: 0,
    etag: true,
    lastModified: true,
    setHeaders: (res) => {
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
    // Socket IDs are transient connection handles. Keep player.id inside the snapshot because
    // votes/targets can still reference it; reconnect remaps it using the player's stable token.
    // hostIds/host are only live socket bookkeeping and must never be restored as active sockets.
    cloned.host = "";
    cloned.hostIds = [];

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

async function persistRoomSnapshot(room, { register = false } = {}) {
    if (!beginGameDataWrite()) return false;
    try {
    if (!ROOM_PERSISTENCE_ENABLED || !room || !room.id) return false;
    const { serialized, truncated } = makeRoomSnapshotPayload(room);
    const now = Date.now();
    const doc = await getDynamoDocClient();
    await doc.send(new PutCommand({
        TableName: ROOM_PERSISTENCE_TABLE,
        Item: {
            playerName: roomStorageKey(room.id),
            statKey: ROOM_SNAPSHOT_STAT_KEY,
            roomId: String(room.id).toUpperCase(),
            isTesterRoom: room.isTesterRoom === true,
            schema: ROOM_SNAPSHOT_SCHEMA,
            snapshot: serialized,
            truncatedChat: truncated,
            persistedAt: now,
            expiresAt: now + ROOM_RECOVERY_TTL_MS,
        },
    }));
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
    try {
        await doc.send(new DeleteCommand({
            TableName: ROOM_PERSISTENCE_TABLE,
            Key: { playerName: roomStorageKey(id), statKey: ROOM_SNAPSHOT_STAT_KEY },
        }));
    } finally {
        try { await updatePersistedRoomIndex(id, { remove: true }); } catch (e) { console.error(`[room-persist] ลบห้อง ${id} จาก ROOM_INDEX ไม่สำเร็จ:`, e.name, e.message); }
        roomPersistenceKnownIds.delete(id);
        roomPersistenceSignatures.delete(id);
        const timer = roomPersistenceTimers.get(id);
        if (timer) clearTimeout(timer);
        roomPersistenceTimers.delete(id);
    }
    return true;
    } finally {
        endGameDataWrite();
    }
}

function schedulePersistRoom(roomId, immediate = false) {
    if (resetInProgress) return;
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
    if (resetInProgress) return;
    if (!ROOM_PERSISTENCE_ENABLED) return;
    for (const id of Object.keys(rooms)) {
        const room = rooms[id];
        if (!room) continue;
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
            if (sk === ROOM_SNAPSHOT_STAT_KEY && pk.startsWith(ROOM_KEY_PREFIX)) {
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
async function recoverPersistedRoomById(roomId, { reason = "on-demand" } = {}) {
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
        // `isTesterRoom` is duplicated at the top level of the durable record so recovery on a
        // different instance can restore the security-critical room classification even if an
        // older/partial snapshot omitted the field. The metadata is written only by server code.
        if (item.isTesterRoom === true) room.isTesterRoom = true;
        if (serverClosed && room.isTesterRoom !== true) return null;

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

async function recoverPersistedRooms() {
    if (!ROOM_PERSISTENCE_ENABLED) return { recovered: 0, skipped: 0 };
    const doc = await getDynamoDocClient();
    const indexOut = await doc.send(new GetCommand({
        TableName: ROOM_PERSISTENCE_TABLE,
        Key: { playerName: SYSTEM_PLAYER_KEY, statKey: ROOM_INDEX_STAT_KEY },
    }));
    const ids = roomIdsFromDynamoSet(indexOut.Item && indexOut.Item.activeRoomIds)
        .map((id) => id.toUpperCase())
        .filter(Boolean);
    if (!ids.length) return { recovered: 0, skipped: 0 };

    let recovered = 0;
    let skipped = 0;
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
                if (item.isTesterRoom === true) room.isTesterRoom = true;
                // Normal rooms must never resurrect while the server is intentionally closed.
                if (serverClosed && room.isTesterRoom !== true) { skipped++; continue; }
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
    // Recreate only server-side timers that are safe to resume after a restart.
    for (const id of Object.keys(rooms)) {
        const room = rooms[id];
        if (room.gameOver) scheduleAutoContinue(room, id);
        if (room.voteMode && room.voteTimerEnabled !== false) {
            // Do not invent remaining vote time; the game client/host can request the latest sync and close the vote manually.
            room.voteModeRecoveredAfterRestart = true;
        }
    }
    return { recovered, skipped };
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
            const out = await recoverPersistedRooms();
            roomRecoveryHealthy = true;
            console.log(`[room-recovery] กู้คืนห้องจาก DynamoDB สำเร็จ ${out.recovered} ห้อง, ข้าม ${out.skipped} รายการ`);
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
        }, ROOM_PERSISTENCE_SCAN_MS);
        roomPersistenceScanTimer.unref?.();
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
    // ส่งสถานะการเปิดบทผู้ตายให้ client ใช้ควบคุม UI/การแสดงผลเท่านั้น; ถ้าห้องเก่าขาดฟิลด์นี้ให้ถือว่าเปิด
    // เพื่อคงพฤติกรรมเดิม และไม่แก้ข้อมูลห้องเก่าทันทีเพียงเพราะส่ง room_update
    publicRoom.revealDeadRole = room.revealDeadRole !== false;
    // เฟส 0 (bot-autonomous-ai-phases.md): เพิ่ม field `connected` ต่อผู้เล่นแต่ละคน คำนวณสดทุกครั้ง
    // ที่ส่งออก (ไม่บันทึกถาวรลง room.players กัน state ค้างเวลา socket หลุด-ต่อใหม่เร็วกว่ารอบ
    // room_update ถัดไป) เตรียมไว้ให้ UI เฟส 4 ใช้แยกสถานะ "🎮 คนคุมอยู่" vs "🧠 AI คุมอยู่" ต่อบอท
    // แต่ละตัว — ยังไม่มีผลอะไรกับเกมตอนนี้ แค่เพิ่ม field เข้าไปเฉย ๆ
    publicRoom.players = (room.players || []).map((p) => {
        const { accountId, testerSessionId, testerPlayerSlot, ...safePlayer } = p;
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
const BROWSER_EXIT_HOST_GRACE_MS = 4_000;
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
        startedAt, socketId: String(meta.socketId || ''), source: String(meta.source || 'pagehide'),
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

function closeRoomNow(roomId, reason) {
    const room = rooms[roomId];
    if (!room || room.isClosing) return Promise.resolve(false);
    // กัน allocator แจก tester slot เดิมซ้ำระหว่างที่การลบ snapshot กำลัง await อยู่
    room.isClosing = true;

    io.to(roomId).emit('room_closed', { reason });

    room.players.forEach((p) => {
        io.sockets.sockets.get(p.id)?.leave(roomId);
        if (pendingRemovals[p.token]) {
            clearTimeout(pendingRemovals[p.token].timer);
            delete pendingRemovals[p.token];
        }
        if (pendingIndicators[p.token]) {
            clearTimeout(pendingIndicators[p.token].timer);
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

    if (ROOM_PERSISTENCE_ENABLED) {
        return deletePersistedRoom(roomId)
            .catch((e) => {
                console.error(`[room-persist] ลบ snapshot ห้อง ${roomId} ตอนปิดห้องไม่สำเร็จ:`, e.name, e.message);
            })
            .then(() => {
                delete rooms[roomId];
                clearGameOverTimer(roomId);
                clearVoteTimer(roomId);
                broadcastSuggestedRoom();
                return true;
            });
    }

    delete rooms[roomId];
    clearGameOverTimer(roomId);
    clearVoteTimer(roomId);
    broadcastSuggestedRoom();
    return Promise.resolve(true);
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
function isPlayerCurrentlyConnected(player) {
    if (!player) return false;
    const sock = io.sockets.sockets.get(player.id);
    return !!sock && sock.connected;
}

// ============================================================
// OFFLINE-TIME TRACKING ต่อผู้เล่นระหว่างเกม (ใช้ตัดสิน "ออกเกม" ตอนจบเกม — ดู didLeaveGame /
// recordGameStats ด้านบน) — เก็บสะสมเป็น ms บนตัว player เอง (gameOfflineMs) + จุดเริ่มออฟไลน์
// ล่าสุดที่ "ยังไม่ flush" (gameOfflineSince) แยกจากสถานะ disconnected/offline ที่ใช้โชว์ผล UI
// (จุดดำ/จุดเหลือง) เพราะจุดนั้นมีดีเลย์รอ (DISCONNECT_INDICATOR_DELAY_MS/RECONNECT_GRACE_MS) ก่อน
// จะขึ้นสถานะ ในขณะที่เวลาที่ใช้ตัดสิน "ออกเกม" ต้องนับจากวินาทีที่ socket หลุดจริง ๆ ไม่มีดีเลย์
// (เดิมพันผลแพ้/ชนะ ต้องแม่นกว่าแค่โชว์ไอคอนสถานะ)
// เริ่มนับออฟไลน์ — เรียกตอน socket "disconnect" จริงขณะเกมกำลังเล่นอยู่เท่านั้น (ดู handler ด้านล่าง)
function markPlayerOfflineStart(player) {
    if (!player) return;
    if (player.gameOfflineSince == null) {
        player.gameOfflineSince = Date.now();
    }
}

// ปิดช่วงออฟไลน์ที่ค้างอยู่ บวกเวลาที่หลุดไปจริงเข้ากับยอดสะสม — เรียกตอน reconnect สำเร็จ
function flushPlayerOfflineTime(player) {
    if (!player) return;
    if (player.gameOfflineSince != null) {
        player.gameOfflineMs = (player.gameOfflineMs || 0) + (Date.now() - player.gameOfflineSince);
        player.gameOfflineSince = null;
    }
}

// เหมือน isPlayerCurrentlyConnected แต่ใช้กับ "บัญชี" ในความหมายกว้างกว่า (หน้า admin.html) —
// โฮสต์คุมห้องได้พร้อมกันหลายจอ (room.hostIds) แต่ hostPlayer.id เก็บแค่ id ของจอล่าสุดที่
// login เท่านั้น (ดู host_login) ถ้าเช็คแค่ player.id เดี่ยวๆ เหมือน isPlayerCurrentlyConnected
// จอล่าสุดปิดไปแต่จอโฮสต์จออื่นยังคุมอยู่จริง จะโดนตัดสินผิดว่า "หลุดแล้ว" ทั้งที่ยังมีคนคุมห้องอยู่
// จึงต้องเช็คทุกจอใน hostIds แทนสำหรับผู้เล่นที่เป็นโฮสต์โดยเฉพาะ
function isAccountConnected(room, player) {
    if (!player) return false;
    if (player.isHost) {
        return (room?.hostIds || []).some((id) => {
            const sock = io.sockets.sockets.get(id);
            return !!sock && sock.connected;
        });
    }
    return isPlayerCurrentlyConnected(player);
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
}

function scheduleAutoContinue(room, roomId) {
    clearGameOverTimer(roomId);
    gameOverTimers[roomId] = setTimeout(() => {
        delete gameOverTimers[roomId];
        const r = rooms[roomId];
        if (!r || !r.gameOver) return;
        r.continueReady = r.continueReady || {};
        r.players.filter((p) => !p.isHost).forEach((p) => {
            r.continueReady[p.id] = true;
        });
        io.to(roomId).emit("room_update", publicRoomView(r));
    }, 5_000);
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

// เฟส 5 (bot-autonomous-ai-phases.md): พาร์สแชทกลางวันแบบหยาบๆ เพื่อจับ "การเปิดเผยตัวตน/ความสงสัย"
// ของบทบาทฝั่งหยั่งรู้จริง (ผู้หยั่งรู้/ผู้มีลาง เท่านั้น — ไม่รวมหมาป่าหยั่งรู้ซึ่งเป็นทีมหมาป่า) แล้วเก็บ
// ชื่อคนที่ถูกพาดพิงไว้ให้บอทชาวบ้านใช้ประกอบการโหวต (ดู runVotePhase ใน botEngine.js)
// คำเตือน: เป็นการจับคำแบบหยาบ (substring match ชื่อ + คำต้องสงสัย) ไม่ใช่ NLP จริง จับพลาด/จับเกินได้
// ยอมรับความเสี่ยงนี้ตามที่ผู้ใช้ขอให้ทำ (ทางเลือกที่ซับซ้อนกว่าที่เคยแจ้งไว้ว่าเสี่ยงบั๊ก)
const SCOUT_CHAT_ROLES = new Set(["ผู้หยั่งรู้", "ผู้มีลาง"]);
const SUSPICION_KEYWORDS = ["หมาป่า", "ฆาตกรต่อเนื่อง", "น่าสงสัย", "ชั่ว", "ไม่ใช่ชาวบ้าน"];

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

// แกะข้อความแชทกลางวันหาชื่อผู้เล่นที่ยังไม่ตาย (ไม่ใช่ผู้พูดเอง) ที่ถูกพาดพิงด้วยคำต้องสงสัยข้างบน
// คืนเป็น array ของ player.id (อาจว่างถ้าไม่เข้าเงื่อนไข/ไม่ใช่บทบาทที่เกี่ยวข้อง/ไม่มีคำต้องสงสัย)
function detectPubliclySuspectedIds(room, speaker, msg) {
    if (!SCOUT_CHAT_ROLES.has(speaker.role)) return [];
    if (!SUSPICION_KEYWORDS.some((kw) => msg.includes(kw))) return [];
    return room.players
        .filter((p) => p.alive && p.id !== speaker.id && p.name && msg.includes(p.name))
        .map((p) => p.id);
}

// ============================================================
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

const roleDescription = {
    "หมาป่า": {
        icon: "/images/werewolf.jpg",
        title: "🐺 หมาป่า",
        desc: "ร่วมกันเลือกเหยื่อในกลุ่มหมาป่า และล่าในตอนกลางคืน<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },
    "ลูกหมาป่า": {
        icon: "/images/juniorwerewolf.jpg",
        title: "🐺 ลูกหมาป่า",
        desc: "คุณคือลูกหมาป่า เพราะคุณน่ารักมาก คุณ สามารถเลือกผู้เล่นอีกคนให้ตายตามคุณได้เมื่อคุณตาย<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },
    "หมาป่าผู้พิทักษ์": {
        icon: "/images/guardianwolf.jpg",
        title: "🐺 หมาป่าผู้พิทักษ์",
        desc: "คุณเป็นมนุษย์หมาป่าที่สามารถปกป้องผู้เล่นจาก การถูกประหารได้หนึ่งคน คุณสามารถปกป้องได้ เพียงครั้งเดียวต่อเกมเท่านั้น<br><br>ทีม:หมาป่า    ลาง:ร้าย",
    },
    "หมาป่าดื้อรั้น": {
        icon: "/images/stubbornwolf.jpg",
        title: "🐺 หมาป่าดื้อรั้น",
        desc: "คุณเป็นมนุษย์หมาป่าธรรมดา แต่คุณแข็งแกร่ง กว่าปกติ เมื่อคุณถูกโจมตี คุณจะได้รับบาดเจ็บ และยังมีชีวิตอยู่ต่อได้ แต่การโจมตีครั้งต่อไปจะ ฆ่าคุณ<br><br>ทีม:หมาป่า    ลาง:ไม่ทราบ",
    },
    "หมาป่านักเวท": {
        icon: "/images/wizardwolf.jpg",
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
        icon: "/images/muscleman.jpg",
        title: "💪 อันธพาล",
        desc: "คุณสามารถเลือกที่จะปกป้องผู้เล่นหนึ่งคนในแต่ละคืนได้ ถ้าคุณหรือผู้เล่นที่คุณปกป้องถูกโจมตีคุณจะยังไม่ตาย คุณและผู้เล่นที่โจมตีสามารถมองเห็นบทบาทของกันและกันได้ คุณจะตายหลังจากจบวันนั้นเพราะทนพิษจากบาดแผลไม่ไหว<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "ผู้มีลาง": {
        icon: "/images/auraseer.jpg",
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
        icon: "/images/oldlady.jpg",
        title: "👵 ยายขี้โมโห",
        desc: "ในแต่ละคืนหลังจากคืนแรก คุณสามารถเลือกผู้ เล่นเพื่อปิดเสียงพวกเขาได้ และเขาจะไม่สามารถ พูดคุยหรือโหวตได้ในวันถัดไป คุณไม่สามารถปิด เสียงผู้เล่นคนเดิมสองครั้งติดต่อกันได้<br><br>ทีม:ชาวบ้าน    ลาง:ดี",
    },
    "แม่มด": {
        icon: "/images/witch.jpg",
        title: "🧙‍♀️ แม่มด",
        desc: "คุณมีน้ำยาสองขวด: ขวดแรกใช้ฆ่าผู้เล่นคน อื่น และอีกขวดหนึ่งใช้ป้องกันผู้เล่นคนอื่น น้ำยา ป้องกันจะถูกใช้งานก็ต่อเมื่อผู้เล่นคนนั้นถูกโจมตี คุณไม่สามารถใช้น้ำยาฆ่าผู้เล่นคนอื่นได้ในคืน แรก<br><br>ทีม:ชาวบ้าน    ลาง:ไม่ทราบ",
    },
    "ศาลเตี้ย": {
        icon: "/images/sheriff.jpg",
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
        icon: "/images/murderer.jpg",
        title: "🗡️ ฆาตกรต่อเนื่อง",
        desc: "ในแต่ละคืนคุณสามารถฆ่าผู้เล่นได้หนึ่งคน<br><br>ทีม:เดี่ยว    ลาง:ไม่ทราบ",
    },
    "นักเล่นกล": {
        icon: "/images/illusionist.jpg",
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

// role icon paths ในรายการด้านล่างเก็บเป็น logical path เท่านั้น และ getter จะเปลี่ยนเป็น URL S3/CDN สดทุกครั้งที่อ่าน
// ไม่อนุญาตให้ logical /images/... ถูกส่งไปเป็น URL ของ origin เพราะ imgUrl() fail-closed เมื่อไม่มี IMAGE_BASE_URL
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
function sanitizeName(name, fallback = "ผู้เล่น") {
    if (typeof name !== "string") return fallback;
    const trimmed = name.trim().slice(0, 24);
    return trimmed.length ? trimmed : fallback;
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
        hostPassword: code(s.hostPassword),
        joinCode: code(s.joinCode),
        maxPlayers,
        config,
        revealDeadRole,
        testerConditions,
        voteTimerEnabled: s.voteTimerEnabled !== false,
        botAIEnabled: s.botAIEnabled === true,
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
function getOpenRoomsList() {
    return Object.keys(rooms).map((id) => {
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
    return Object.keys(rooms).map((id) => {
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

    // บันทึกสถิติ ชนะ/แพ้ ต่อผู้เล่นแบบถาวร (ดู recordGameStats ด้านบน) — ทำตรงนี้เพราะเป็นจุดเดียว
    // ที่ยืนยันแน่นอนแล้วว่าเกมจบจริง ๆ (ผ่านเงื่อนไข conditionEnabled ด้านบนมาแล้ว ไม่ใช่แค่ทดสอบ)
    recordGameStats(room, resultTeam);

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
    io.to(roomId).emit("room_update", publicRoomView(room));
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
    // ตัวนับเวลาออฟไลน์สะสมระหว่างเกม (ดู didLeaveGame/markPlayerOfflineStart ด้านบน) — รีเซ็ตทุก
    // ครั้งที่เริ่มเกมใหม่ในห้องเดิม (rematch) กันเวลาออฟไลน์ของรอบก่อนติดค้างมานับซ้ำกับตาใหม่
    p.gameOfflineMs = 0;
    p.gameOfflineSince = null;
    // Explicitly leaving to choose a new room is recorded immediately and locked to this round.
    p.leftGameRoundId = null;
    p.leaveReason = null;
    p.leaveRecordedAt = null;
    p.leaveStatsRecordedRoundId = null;
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
// runBotsFor("wolfKill"/"nightSkill", ...) เหมือนที่ทำไว้ใน socket.on("start_night") handler
// เพราะ closeVoteRound() เป็นฟังก์ชันระดับบนสุดของไฟล์ (ประกาศก่อน io.on("connection", ...))
// จึงไม่เห็น performWolfKill/performSelectTarget/ฯลฯ ที่ถูกประกาศไว้ข้างในนั้น (คนละ scope กัน)
// ผลคือ: ทุกคืนที่เริ่มจากการปิดโหวต (คือแทบทุกคืนในเกมจริง ยกเว้นคืนที่โฮสต์กด "เริ่มคืน" เองตรงๆ
// ซึ่งไม่ค่อยเกิดในโฟลว์ปกติ) บอทหมาป่า/บอทบทบาทพิเศษจะไม่ทำ action ให้เลย ดูเหมือนบอท "ค้าง"
// ตั้งแต่คืนที่ 1-2 เป็นต้นไป — แก้โดยรับ deps เข้ามาเป็นพารามิเตอร์ที่ 3 (ตัวเรียกฝั่ง
// io.on("connection", ...) ส่งเข้ามาได้เพราะอยู่ scope เดียวกับ performWolfKill ฯลฯ) แล้วยิง
// runBotsFor เองท้ายฟังก์ชันนี้ ให้เหมือนกับที่ start_night handler ทำทุกประการ
function closeVoteRound(room, roomId, deps) {
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
        beginNight(room, roomId); // เรียก room_update ให้เองในตัว

        // แก้บั๊กบอทไม่ทำงานคืน 1-2 เป็นต้นไป (ดูคอมเมนต์ด้านบนหัวฟังก์ชัน): ยิง runBotsFor เอง
        // ที่นี่เหมือนที่ start_night handler ทำ — ต้องเช็ค deps ก่อนเพราะบางจุดเรียกไม่ได้ส่งมา
        // (กันเหนียว ไม่ควรเกิดถ้าแก้ครบทุก call site แล้ว)
        if (deps) {
            runBotsFor(room, roomId, "wolfKill", deps);
            runBotsFor(room, roomId, "nightSkill", deps);
        }
    } else {
        io.to(roomId).emit("room_update", publicRoomView(room));
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
            io.to(roomId).emit("room_update", publicRoomView(room));
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

    io.to(roomId).emit("room_update", publicRoomView(room));
}

// ============================================================
// ADMIN — ล้างข้อมูลเกมทั้งหมด (RESET EVERYTHING) — ปุ่มในหน้า admin.html
// ============================================================
// ทำอะไรบ้าง (ทำให้ "ทุกคนกลับเป็นผู้เล่นใหม่ ลงทะเบียนครั้งแรก"):
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
// ล็อกส่วน reset ทั้งชุด: กัน account/presence/room persistence เขียนข้อมูลกลับระหว่างกำลังล้าง
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
        TableName: STATS_TABLE_NAME,
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
async function wipeStatsTable() {
    const doc = await getDynamoDocClient();
    accountProfileCache.clear();
    let deleted = 0;
    let lastKey;
    do {
        const page = await doc.send(new ScanCommand({
            TableName: STATS_TABLE_NAME,
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
                await deleteItemsWithFallback(doc, batch.map((x) => x.DeleteRequest.Key));
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
// ห้ามเรียก endGame/recordGameStats ตรงนี้ → เกมที่ค้างอยู่ "ไม่นับเป็นเกมเลย" ไม่มีแพ้/ชนะ/ออกเกมเข้าประวัติของใคร
// ต้องเรียก "ก่อน" ที่ socket ถูกตัดเสมอ (ดู closeServerNow / force-reload) ไม่งั้น handler "disconnect" จะเห็นว่าห้องยังอยู่
// แล้วเริ่มนับเวลาออฟไลน์ (markPlayerOfflineStart) ให้ผู้เล่นทุกคน — ตัวที่ทำให้ถูกตัดสินว่า "ออกเกม" ตอนจบเกม
// ไม่ยิง room_closed ตั้งใจ: หน้าเกมจะขึ้นข้อความ "ห้องถูกปิด เนื่องจากผู้สร้างห้องออกจากเกม" ซึ่งไม่ตรงความจริง
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

async function consumeAdminTabHandoff(ticket, tabId) {
    const payload = verifySignedState(String(ticket || ""), ADMIN_SESSION_SECRET);
    const safeTabId = sanitizeAdminTabId(tabId);
    if (!payload || payload.type !== "admin_tab_handoff" || payload.admin !== true || payload.provider !== "google" || !payload.googleSub || !payload.email || !safeTabId || payload.tabId !== safeTabId) {
        return { ok:false, code:"ADMIN_TAB_TICKET_INVALID" };
    }
    const nonce = String(payload.n || "");
    const now = Date.now();
    for (const [key, exp] of adminTabHandoffMemory) {
        if (Number(exp || 0) <= now) adminTabHandoffMemory.delete(key);
    }
    if (adminTabHandoffMemory.has(nonce)) return { ok:false, code:"ADMIN_TAB_TICKET_USED" };
    try {
        const doc = await getDynamoDocClient();
        await doc.send(new PutCommand({
            TableName: STATS_TABLE_NAME,
            Item: { playerName: ADMIN_TAB_HANDOFF_PARTITION_KEY, statKey: `TICKET#${nonce}`, expiresAtEpoch: Math.floor(Number(payload.exp || 0) / 1000), createdAt: new Date().toISOString(), type:"admin_tab_handoff" },
            ConditionExpression: "attribute_not_exists(playerName) AND attribute_not_exists(statKey)",
        }));
    } catch (e) {
        // Local/dev environments may have no DynamoDB. Keep a bounded per-process replay guard there.
        const code = String(e?.name || e?.code || "");
        if (!/ConditionalCheckFailed/i.test(code)) {
            adminTabHandoffMemory.set(nonce, Number(payload.exp || now + ADMIN_TAB_HANDOFF_TTL_MS));
        } else {
            return { ok:false, code:"ADMIN_TAB_TICKET_USED" };
        }
    }
    adminTabHandoffMemory.set(nonce, Number(payload.exp || now + ADMIN_TAB_HANDOFF_TTL_MS));
    const token = createAdminSessionToken({ provider:"google", googleSub:payload.googleSub, email:payload.email, tabId:safeTabId });
    return { ok:!!token, code:token ? "" : "ADMIN_SESSION_CREATE_FAILED", token, expiresAt:Date.now() + ADMIN_TAB_SESSION_TTL_MS, email:payload.email, provider:"google", tabId:safeTabId };
}

app.post("/api/admin/session/exchange", express.json({ limit: "8kb" }), async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    try {
        const result = await consumeAdminTabHandoff(req.body?.ticket, req.body?.tabId);
        if (!result.ok) return res.status(401).json({ ok:false, error:"admin_tab_ticket_invalid", code:result.code });
        return res.json(result);
    } catch (e) {
        recordDiagnostic({ source:"server", kind:"admin_tab_session_exchange_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "" });
        return res.status(503).json({ ok:false, error:"admin_session_exchange_failed", code:"ADMIN_TAB_SESSION_EXCHANGE_FAILED" });
    }
});

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
            googleEnabled: ADMIN_GOOGLE_EMAILS.length > 0,
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
        googleEnabled: ADMIN_GOOGLE_EMAILS.length > 0,
        deploymentReady: adminAuthReadyForDeployment(),
    });
});

app.post("/api/admin/login", express.json({ limit: "2kb" }), (req, res) => {
    if (!ADMIN_AUTH_CONFIGURED) return res.status(503).json({ ok: false, error: "admin_auth_not_configured", code: "ADMIN_AUTH_NOT_CONFIGURED" });
    if (!ADMIN_PANEL_PASSWORD) return res.status(403).json({ ok: false, error: "google_login_required", code: "ADMIN_GOOGLE_LOGIN_REQUIRED" });
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
    const writesDrained = await waitForGameDataWritesDrain(15000);
    if (!writesDrained) {
        console.error(`[reset] ยังมีงานเขียนข้อมูลเกมค้าง ${activeGameDataWrites} งานเกินเวลารอ — ยกเลิก reset เพื่อไม่ให้ล้างครึ่งเดียว`);
        return res.status(503).json({ error: "game_data_write_drain_timeout", activeWrites: activeGameDataWrites });
    }
    // ตัด presence ทิ้งตั้งแต่ต้น เพื่อให้ Dashboard ไม่แสดงผู้เล่นจาก session รุ่นเก่าในระหว่าง reset
    accountPresence.clear();
    // ยกเลิก snapshot debounce ของทุกห้องตั้งแต่ต้น ไม่ให้ timer เก่ามีสิทธิ์เขียนกลับเข้าฐานข้อมูล
    for (const timer of roomPersistenceTimers.values()) clearTimeout(timer);
    roomPersistenceTimers.clear();
    roomPersistenceKnownIds.clear();
    roomPersistenceSignatures.clear();
    try {
        // 1) DynamoDB — ถ้าพังตรงนี้ หยุดทันที (ยังไม่แตะห้อง/เครื่องผู้เล่น) แก้สิทธิ์แล้วกดใหม่ได้
        let deletedRows;
        try {
            deletedRows = await wipeStatsTable();
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

        // 2.5) ล้าง Stats ซ้ำอีกครั้งหลัง room cleanup เพื่อจับ write ที่เริ่มก่อน lock แล้วกลับมาเสร็จระหว่างการล้างชุดแรก
        // เมื่อ resetInProgress=true แล้ว call site ใหม่จะไม่เริ่ม write เพิ่มอีก
        try {
            const deletedRowsFinal = await wipeStatsTable();
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
                TableName: STATS_TABLE_NAME,
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
        accountPresence.clear();
        wipeAllRoomsInMemory();
        let statePersisted = true;
        try { await saveServerState(); } catch (e) {
            statePersisted = false;
            console.error("[reset] บันทึกสถานะหลังล้างข้อมูลไม่สำเร็จ:", e.name, e.message);
        }
        // Admin ไม่ต้องถูก reset แต่ทุก socket เกม/ทดสอบต้องรับคำสั่งล้างพร้อมกัน
        io.sockets.sockets.forEach((s) => {
            if (s.data && s.data.isAdmin) return;
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
//      ใช้ตารางเดิม + สิทธิ์ GetItem/PutItem เดิมที่ resetEpoch ใช้อยู่แล้ว — ไม่ต้องเพิ่ม IAM
//      /api/admin/reset ไม่ลบแถว __SYSTEM__ (ดู wipeStatsTable) และหน้ารายชื่อผู้เล่นกรองแค่ statKey = REG จึงไม่ปนกัน
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

async function loadServerState() {
    const doc = await getDynamoDocClient();
    const out = await doc.send(new GetCommand({
        TableName: STATS_TABLE_NAME,
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
// ผลคือบัตร ?tp ที่ออกจาก instance A ใช้กับ instance B ไม่ได้ → tester join_room ไหลไป account auth
// และเกิด ACCOUNT_TOKEN_REQUIRED แบบใน Diagnostic v16.
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
                TableName: STATS_TABLE_NAME,
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
                TableName: STATS_TABLE_NAME,
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
        TableName: STATS_TABLE_NAME,
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
//   (ใช้กับรูปที่อยู่บน S3/CDN ที่ server มองไม่เห็นว่าเปลี่ยน — ไฟล์ใน public/ และโค้ด server ตรวจจับ version เองอยู่แล้วตอน deploy)
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
    const configuredBase = String(process.env.PUBLIC_WEB_ORIGIN || process.env.DIAGNOSTIC_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
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
    const player = room.players.find((p) => p && !p.isHost && p.token === tok);
    if (!player) return { ok:true, code:'PLAYER_NOT_FOUND' };

    if (!room.started || room.gameOver) {
        if (!room.started && !room.gameOver) {
            if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
            if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token].timer); delete pendingIndicators[player.token]; }
            stripBrowserExitPlayerMaps(room, player.id);
            room.players = room.players.filter((p) => p.token !== tok);
            io.to(roomId).emit('room_update', publicRoomView(room));
            schedulePersistRoom(roomId, true);
            broadcastSuggestedRoom();
        }
        return { ok:true, code:room.gameOver ? 'ROOM_ALREADY_ENDED' : 'LEFT_LOBBY', recorded:false };
    }

    const roundId = getRoomGameRoundId(room);
    if (player.leaveStatsRecordedRoundId !== roundId) {
        const result = await recordImmediateGameLeaveStats(room, player, reason || 'browser_tab_closed');
        if (!result.ok) return { ok:false, code:result.code || 'SERVER_ERROR' };
    } else {
        player.leftGameRoundId = roundId;
        player.leaveReason = String(reason || player.leaveReason || 'browser_tab_closed').slice(0,64);
        player.leaveRecordedAt = player.leaveRecordedAt || Date.now();
    }

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
    if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token].timer); delete pendingIndicators[player.token]; }
    io.sockets.sockets.get(player.id)?.leave(roomId);
    checkGameEndGeneral(room, roomId);
    io.to(roomId).emit('room_update', publicRoomView(room));
    schedulePersistRoom(roomId, true);
    broadcastSuggestedRoom();
    addDiagnosticBreadcrumb({ source:'server', type:'browser_exit', label:'browser_exit.player_applied', traceId:pendingMeta.traceId || '', sessionId:pendingMeta.sessionId || '', page:'player', detail:{ roomId, tokenSuffix:tok.slice(-6), reason:reason || 'browser_tab_closed', announced, aliveAfter:!!player.alive } });
    return { ok:true, code:'PLAYER_LEFT_GAME', recorded:true, markedDead:true };
}

app.post('/api/room/browser-exit-host', express.json({ limit:'4kb', type:['application/json','text/plain'] }), async (req, res) => {
    const ctx = req.__wwDiagnostic || {};
    if (!browserExitOriginAllowed(req)) return res.status(403).json({ ok:false, code:'BROWSER_EXIT_ORIGIN_REJECTED' });
    const bodyTraceId = String(req.body?.clientTraceId || '').slice(0, 120);
    const bodySessionId = String(req.body?.clientSessionId || '').slice(0, 120);
    const traceId = bodyTraceId || String(ctx.traceId || '');
    const sessionId = bodySessionId || String(ctx.sessionId || '');
    const id = String(req.body?.roomId || '').trim().toUpperCase();
    const tok = String(req.body?.token || '');
    const socketId = String(req.body?.socketId || '');
    const signalEvent = recordDiagnostic({
        source:'client', kind:'browser_exit_signal', page:'host', message:'Host pagehide exit signal reached the server',
        traceId, sessionId, requestId:String(ctx.requestId || ''), roomId:id, endpoint:'/api/room/browser-exit-host',
        context:{ source:String(req.body?.source || 'pagehide'), socketConnectedHint:!!socketId, userAgentPresent:!!String(req.body?.userAgent || ''), viewport:req.body?.viewport || null, clientPendingOperations:req.body?.pendingOperations || [] },
        causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_SIGNAL', confidence:'high' },
    });
    if (!id || !tok) return res.status(400).json({ ok:false, code:'BROWSER_EXIT_INVALID_PAYLOAD' });
    const room = rooms[id];
    if (!room) return res.json({ ok:true, code:'ROOM_NOT_FOUND' });
    const hostPlayer = room.players.find((p) => p && p.isHost && p.token === tok);
    if (!hostPlayer) return res.status(403).json({ ok:false, code:'HOST_TOKEN_INVALID' });

    const priorDisconnect = recentSocketDisconnect('host', id, tok, socketId);
    if (priorDisconnect) {
        const duplicateEvent = recordDiagnostic({
            source:'server', kind:'browser_exit_duplicate_ignored', page:'host',
            message:'Late host pagehide signal ignored because the same socket already disconnected',
            traceId, sessionId, requestId:String(ctx.requestId || ''), roomId:id,
            context:{ source:String(req.body?.source || 'pagehide'), socketId,
                priorDisconnectAt:new Date(priorDisconnect.time).toISOString() },
            causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_DUPLICATE_IGNORED', confidence:'high' },
        });
        return res.json({ ok:true, code:'BROWSER_EXIT_DUPLICATE_IGNORED', recorded:true, diagnosticId:duplicateEvent?.id || '' });
    }

    armPendingBrowserExit('host', id, tok, async (pending) => {
        const liveRoom = rooms[id];
        if (!liveRoom) return;
        const liveHost = liveRoom.players.find((p) => p && p.isHost && p.token === tok);
        if (!liveHost) return;
        // pagehide ไม่ได้แปลว่า socket หลุดเสมอไป (โดยเฉพาะ iPad/Safari, BFCache,
        // app switch และ navigation ที่ browser ยังรักษา Socket.IO connection ไว้ได้ชั่วคราว)
        // ห้ามลบ host socket จาก registry ก่อนตรวจสถานะจริง เพราะถ้าลบก่อน จะทำให้
        // activeHostIds กลายเป็น 0 และปิดห้องทั้งที่ Host ยังเชื่อมต่ออยู่จริง
        const pendingHostSocket = pending.socketId ? io.sockets.sockets.get(pending.socketId) : null;
        const pendingHostSocketConnected = !!pendingHostSocket?.connected;
        if (pendingHostSocketConnected) {
            clearPendingBrowserExit('host', id, tok, {
                source: 'host_socket_still_connected',
                traceId: pending.traceId,
                sessionId: pending.sessionId,
            });
            liveHost.disconnected = false;
            io.to(id).emit('room_update', publicRoomView(liveRoom));
            schedulePersistRoom(id);
            return;
        }
        if (pending.socketId && Array.isArray(liveRoom.hostIds) && liveRoom.hostIds.includes(pending.socketId)) {
            removeHostSocket(liveRoom, pending.socketId);
        }
        const activeHostIds = (liveRoom.hostIds || []).filter((hid) => io.sockets.sockets.get(hid)?.connected);
        if (activeHostIds.length > 0) {
            liveHost.disconnected = false;
            io.to(id).emit('room_update', publicRoomView(liveRoom));
            schedulePersistRoom(id);
            const keptEvent = recordDiagnostic({ source:'server', kind:'browser_exit_applied', page:'host', message:'Host browser exit resolved without closing the room because another host screen remains active', traceId:pending.traceId, sessionId:pending.sessionId, roomId:id, context:{ outcome:'kept_open', activeHostScreens:activeHostIds.length, source:pending.source }, causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_KEPT_ROOM_OPEN', confidence:'high', upstreamEventIds:pending.armDiagnosticId ? [pending.armDiagnosticId] : [] } });
            if (pending.armDiagnosticId && keptEvent?.id) linkDiagnosticEvents(pending.armDiagnosticId, keptEvent.id, 'causes');
            addDiagnosticBreadcrumb({ source:'server', type:'browser_exit', label:'browser_exit.host_kept_open', traceId:pending.traceId, sessionId:pending.sessionId, page:'host', detail:{ roomId:id, activeHostScreens:activeHostIds.length, diagnosticId:keptEvent?.id || '' } });
            return;
        }
        liveHost.disconnected = true;
        io.to(id).emit('room_update', publicRoomView(liveRoom));
        schedulePersistRoom(id, true);
        const closingEvent = recordDiagnostic({ source:'server', kind:'browser_exit_applied', page:'host', message:'All host screens disappeared after browser exit grace; room closure started', traceId:pending.traceId, sessionId:pending.sessionId, roomId:id, context:{ outcome:'closing_room', source:pending.source }, causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_CLOSE_ROOM', confidence:'high', upstreamEventIds:pending.armDiagnosticId ? [pending.armDiagnosticId] : [] } });
        if (pending.armDiagnosticId && closingEvent?.id) linkDiagnosticEvents(pending.armDiagnosticId, closingEvent.id, 'causes');
        addDiagnosticBreadcrumb({ source:'server', type:'browser_exit', label:'browser_exit.host_closing_room', traceId:pending.traceId, sessionId:pending.sessionId, page:'host', detail:{ roomId:id, source:pending.source, diagnosticId:closingEvent?.id || '' } });
        await closeRoomNow(id, 'host_browser_exit');
        const closedEvent = recordDiagnostic({ source:'server', kind:'room_closed_after_browser_exit', page:'host', message:'Room closed because the last host screen exited the browser', traceId:pending.traceId, sessionId:pending.sessionId, roomId:id, context:{ reason:'host_browser_exit' }, causalHint:{ failureStage:'room.lifecycle', causeCode:'ROOM_CLOSED', confidence:'high', upstreamEventIds:closingEvent?.id ? [closingEvent.id] : [] } });
        if (closingEvent?.id && closedEvent?.id) linkDiagnosticEvents(closingEvent.id, closedEvent.id, 'causes');
    }, { page:'host', traceId, sessionId, socketId, source:String(req.body?.source || 'pagehide'), signalDiagnosticId:String(signalEvent?.id || '') }, BROWSER_EXIT_HOST_GRACE_MS);

    res.setHeader('Cache-Control','no-store');
    return res.json({ ok:true, code:'BROWSER_EXIT_ARMED' });
});

app.post('/api/room/browser-exit-player', express.json({ limit:'4kb', type:['application/json','text/plain'] }), async (req, res) => {
    const ctx = req.__wwDiagnostic || {};
    if (!browserExitOriginAllowed(req)) return res.status(403).json({ ok:false, code:'BROWSER_EXIT_ORIGIN_REJECTED' });
    const bodyTraceId = String(req.body?.clientTraceId || '').slice(0, 120);
    const bodySessionId = String(req.body?.clientSessionId || '').slice(0, 120);
    const traceId = bodyTraceId || String(ctx.traceId || '');
    const sessionId = bodySessionId || String(ctx.sessionId || '');
    const id = String(req.body?.roomId || '').trim().toUpperCase();
    const tok = String(req.body?.token || '');
    const signalEvent = recordDiagnostic({
        source:'client', kind:'browser_exit_signal', page:'player', message:'Player pagehide exit signal reached the server',
        traceId, sessionId, requestId:String(ctx.requestId || ''), roomId:id, endpoint:'/api/room/browser-exit-player',
        context:{ source:String(req.body?.source || 'pagehide'), socketIdPresent:!!String(req.body?.socketId || ''), viewport:req.body?.viewport || null, pendingOperations:req.body?.pendingOperations || [], started:!!req.body?.started },
        causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_SIGNAL', confidence:'high' },
    });
    if (!id || !tok) return res.status(400).json({ ok:false, code:'BROWSER_EXIT_INVALID_PAYLOAD' });
    const room = rooms[id];
    if (!room) return res.json({ ok:true, code:'ROOM_NOT_FOUND' });
    const player = room.players.find((p) => p && !p.isHost && p.token === tok);
    if (!player) return res.json({ ok:true, code:'PLAYER_NOT_FOUND' });

    // If Socket.IO has already reported this exact socket as disconnected, the pagehide
    // beacon is a late duplicate lifecycle signal. The normal disconnect/reconnect-grace
    // path is already responsible for the player state; arming a second browser-exit
    // transaction here only creates duplicate LEFT_LOBBY/diagnostic events.
    const priorDisconnect = recentSocketDisconnect('player', id, tok, String(req.body?.socketId || ''));
    if (priorDisconnect) {
        const duplicateEvent = recordDiagnostic({
            source:'server', kind:'browser_exit_duplicate_ignored', page:'player',
            message:'Late player pagehide signal ignored because the same socket already disconnected',
            traceId, sessionId, requestId:String(ctx.requestId || ''), roomId:id,
            context:{ source:String(req.body?.source || 'pagehide'), socketId:String(req.body?.socketId || ''),
                priorDisconnectAt:new Date(priorDisconnect.time).toISOString() },
            causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_DUPLICATE_IGNORED', confidence:'high' },
        });
        return res.json({ ok:true, code:'BROWSER_EXIT_DUPLICATE_IGNORED', recorded:true, diagnosticId:duplicateEvent?.id || '' });
    }

    armPendingBrowserExit('player', id, tok, async (pending) => {
        const liveRoom = rooms[id];
        if (!liveRoom) return;
        const livePlayer = liveRoom.players.find((p) => p && !p.isHost && p.token === tok);
        if (!livePlayer) return;
        if (isPlayerCurrentlyConnected(livePlayer)) {
            const reconnectedEvent = recordDiagnostic({ source:'server', kind:'browser_exit_cancelled', page:'player', message:'Player reconnected during browser-exit grace; no leave/death was applied', traceId:pending.traceId, sessionId:pending.sessionId, roomId:id, context:{ outcome:'reconnected', source:pending.source }, causalHint:{ failureStage:'browser.lifecycle', causeCode:'BROWSER_EXIT_RECONNECTED', confidence:'high', upstreamEventIds:pending.armDiagnosticId ? [pending.armDiagnosticId] : [] } });
            if (pending.armDiagnosticId && reconnectedEvent?.id) linkDiagnosticEvents(pending.armDiagnosticId, reconnectedEvent.id, 'causes');
            addDiagnosticBreadcrumb({ source:'server', type:'browser_exit', label:'browser_exit.player_reconnected', traceId:pending.traceId, sessionId:pending.sessionId, page:'player', detail:{ roomId:id, diagnosticId:reconnectedEvent?.id || '' } });
            return;
        }
        const result = await applyVoluntaryPlayerExit(id, tok, 'browser_tab_closed', pending);
        const appliedEvent = recordDiagnostic({ source:'server', kind:'browser_exit_applied', page:'player', message:'Player browser exit passed reconnect grace and was applied to room/game state', traceId:pending.traceId, sessionId:pending.sessionId, roomId:id, context:{ result:result || {}, source:pending.source }, causalHint:{ failureStage:'room.lifecycle', causeCode:String(result?.code || 'BROWSER_EXIT_APPLIED'), confidence:'high', upstreamEventIds:pending.armDiagnosticId ? [pending.armDiagnosticId] : [] } });
        if (pending.armDiagnosticId && appliedEvent?.id) linkDiagnosticEvents(pending.armDiagnosticId, appliedEvent.id, 'causes');
    }, { page:'player', traceId, sessionId, source:String(req.body?.source || 'pagehide'), signalDiagnosticId:String(signalEvent?.id || '') }, BROWSER_EXIT_PLAYER_GRACE_MS);

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
    // แอดมิน (หน้า admin.html) ผ่านด่านตอนปิดเซิร์ฟเวอร์ได้ — ที่เหลือถูกบล็อกซ้ำตรงนี้ด้วย (ดู "เปิด/ปิดเซิร์ฟเวอร์" ด้านบนสุดของไฟล์)
    socket.data.isAdmin = isAdminSocket(socket);
    socket.data.diagnosticSessionId = String(socket.handshake?.auth?.wwDiagSessionId || "").slice(0, 120);
    socket.use((packet, next) => {
        try {
            const event = String(packet?.[0] || "event");
            const args = packet?.slice(1) || [];
            const roomCandidate = args.map((x) => x && typeof x === "object" ? (x.roomId || x.room || "") : "").find(Boolean);
            socket.data.diagnosticTraceId = makeDiagnosticId("sock");
            socket.data.diagnosticAction = `socket:${event}`.slice(0, 120);
            socket.data.diagnosticRoomId = String(roomCandidate || "").toUpperCase().slice(0, 12);
            addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`receive:${event}`, traceId:socket.data.diagnosticTraceId, sessionId:socket.data.diagnosticSessionId, page:"server", detail:{ socketId:socket.id, roomId:socket.data.diagnosticRoomId, args:args.map(safeDiagnosticValue) } });
        } catch (_) {}
        next();
    });
    const SOCKET_INTERNAL_EVENTS = new Set(["disconnect", "disconnecting", "error"]);
    socket.on = (event, handler) => {
        return _rawSocketOn(event, (...args) => {
            const maybeCb = args[args.length - 1];
            const hasCb = typeof maybeCb === "function";
            // ตอนปิดเซิร์ฟเวอร์: ทิ้ง event เกมทุกตัวจาก socket ที่ไม่ใช่แอดมิน (ครอบคลุมช่วง 0.8 วิก่อนถูกตัดการเชื่อมต่อ)
            // "ไม่ตอบ callback" ตั้งใจ — ถ้าตอบ {error} หน้าเกมจะเข้าใจว่าห้องหาย แล้วลบ ww_joinedRoom ที่จำห้องเดิมไว้ทิ้ง
            // ("disconnect" ต้องปล่อยผ่านเสมอ ไม่งั้นระบบนับผู้เล่นออฟไลน์/ล้างตัวจับเวลาหลุดไปด้วย)
            // ตอนปิดเซิร์ฟเวอร์ อนุญาตเฉพาะ: (1) socket แอดมิน → เฉพาะ event admin_* เท่านั้น (auth.admin เป็นค่าที่ client ส่งมาเอง — เดิมถือว่า
            // ผ่านทุก event ซึ่งเปิดช่องให้ใครก็ได้ต่อ socket ด้วย {auth:{admin:true}} แล้วเล่นเกมต่อตอนปิด), (2) ผู้ถือบัตรผ่านที่ server ออกให้,
            // (3) สมาชิกห้องผู้ทดสอบ (สถานะห้องบน server) — นอกนั้นทิ้งเงียบๆ
            if (String(event).startsWith("admin_") && !socket.data.isAdmin) {
                addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`blocked:${event}`, traceId:String(socket.data.diagnosticTraceId||""), sessionId:String(socket.data.diagnosticSessionId||""), page:"server", detail:{ socketId:socket.id, reason:"admin_auth_required", code:"ADMIN_AUTH_REQUIRED" } });
                if (hasCb) { try { maybeCb({ error: "admin_auth_required", code: "ADMIN_AUTH_REQUIRED" }); } catch (_) {} }
                return;
            }
            if (serverClosed && !SOCKET_INTERNAL_EVENTS.has(event)) {
                if (socket.data.isAdmin) {
                    if (!String(event).startsWith("admin_")) {
                        addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`blocked:${event}`, traceId:String(socket.data.diagnosticTraceId||""), sessionId:String(socket.data.diagnosticSessionId||""), page:"server", detail:{ socketId:socket.id, reason:"server_closed_admin_non_admin_event", code:"SERVER_CLOSED" } });
                        return;
                    }
                } else if (!isTesterPassValid(socket.data.testerToken) && !socket.data.roomTesterAuth && socketRoomKind(socket) !== "tester") {
                    addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`blocked:${event}`, traceId:String(socket.data.diagnosticTraceId||""), sessionId:String(socket.data.diagnosticSessionId||""), page:"server", detail:{ socketId:socket.id, reason:"server_closed", code:"SERVER_CLOSED" } });
                    return;
                }
            }
            if (resetInProgress && !SOCKET_INTERNAL_EVENTS.has(event)) {
                addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`blocked:${event}`, traceId:String(socket.data.diagnosticTraceId||""), sessionId:String(socket.data.diagnosticSessionId||""), page:"server", detail:{ socketId:socket.id, reason:"reset_in_progress", code:"RESET_IN_PROGRESS" } });
                if (hasCb) {
                    try { maybeCb({ error: "reset_in_progress", code: "RESET_IN_PROGRESS" }); } catch (_) {}
                }
                return;
            }
            const operationId = makeDiagnosticId("sockop");
            const startedAt = Date.now();
            const diagContext = {
                traceId: String(socket.data.diagnosticTraceId || makeDiagnosticId("sock")).slice(0, 120),
                sessionId: String(socket.data.diagnosticSessionId || "").slice(0, 120),
                action: String(socket.data.diagnosticAction || `socket:${event}`).slice(0, 120),
                roomId: String(socket.data.diagnosticRoomId || "").toUpperCase().slice(0, 12),
                operationId,
            };
            addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`handler.start:${event}`, traceId:diagContext.traceId, sessionId:diagContext.sessionId, page:"server", detail:{ socketId:socket.id, operationId, roomId:diagContext.roomId, hasAck:hasCb, args:safeDiagnosticValue(args.slice(0, Math.min(2, args.length)).map((x) => typeof x === "function" ? "[ack]" : x)), authObservation:{ requestedTester:args[0]?.isTester === true, testerPassPresented:!!socket.data.testerPassPresented, testerPassValid:!!socket.data.testerPassValid, testerGranted:!!socket.data.testerToken, testerPassBootstrapError:String(socket.data.testerPassBootstrapError || ""), hasAccountToken:!!args[0]?.accountToken, hasAccountId:!!args[0]?.accountId, isAdmin:!!socket.data.isAdmin } } });
            let ackSent = false;
            if (hasCb) {
                args[args.length - 1] = (...ackArgs) => {
                    const first = ackArgs[0];
                    if (ackSent) {
                        addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`ack.duplicate:${event}`, traceId:diagContext.traceId, sessionId:diagContext.sessionId, page:"server", detail:{ socketId:socket.id, operationId, elapsedMs:Date.now()-startedAt, ack:first } });
                        try { return maybeCb(...ackArgs); } catch (_) { return undefined; }
                    }
                    ackSent = true;
                    const ackOk = isSuccessfulDiagnosticAck(event, first);
                    addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`ack:${event}`, traceId:diagContext.traceId, sessionId:diagContext.sessionId, page:"server", detail:{ socketId:socket.id, operationId, eventName:event, elapsedMs:Date.now()-startedAt, ok:ackOk, code:ackOk ? "" : (first?.code || first?.errorCode || ""), error:ackOk ? "" : (first?.error || ""), ack:safeDiagnosticValue(first), ackType:Array.isArray(first) ? "array" : typeof first } });
                    try { return maybeCb(...ackArgs); } catch (err) { console.error(`[socket:${event}] ack callback error`, err); }
                };
            }
            try {
                const result = diagnosticAsyncContext.run(diagContext, () => handler(...args));
                if (result && typeof result.then === "function") {
                    result.then(() => {
                        addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`handler.resolve:${event}`, traceId:diagContext.traceId, sessionId:diagContext.sessionId, page:"server", detail:{ socketId:socket.id, operationId, elapsedMs:Date.now()-startedAt, ackSent } });
                    }).catch((err) => {
                        diagnosticAsyncContext.run(diagContext, () => {
                            console.error(`[socket:${event}] unhandled async error`, err);
                            recordDiagnostic({ source:"server", kind:"socket_handler_error", page:"server", message:err?.message || String(err), stack:err?.stack || "", context:{ eventName:event, operationId, code:"SERVER_ERROR", ackSent }, operationId });
                        });
                        if (hasCb && !ackSent) {
                            try { args[args.length - 1]({ error: "internal_error", code: "SERVER_ERROR" }); } catch (_) {}
                        }
                    });
                } else {
                    addDiagnosticBreadcrumb({ source:"server", type:"socket", label:`handler.return:${event}`, traceId:diagContext.traceId, sessionId:diagContext.sessionId, page:"server", detail:{ socketId:socket.id, operationId, elapsedMs:Date.now()-startedAt, ackSent } });
                }
            } catch (err) {
                diagnosticAsyncContext.run(diagContext, () => {
                    console.error(`[socket:${event}] error`, err);
                    recordDiagnostic({ source:"server", kind:"socket_handler_error", page:"server", message:err?.message || String(err), stack:err?.stack || "", context:{ eventName:event, operationId, code:"SERVER_ERROR", ackSent }, operationId });
                });
                if (hasCb && !ackSent) {
                    try { args[args.length - 1]({ error: "internal_error", code: "SERVER_ERROR" }); } catch (_) {}
                }
            }
        });
    };

    // เฟส 3-5 (bot-autonomous-ai-phases.md) + แก้บั๊กบอทไม่ทำงานคืน 1-2: deps ชุดเดียวกันที่ใช้ทุกจุด
    // ที่ต้องยิง runBotsFor("wolfKill"/"nightSkill", ...) ตอนเข้าคืนใหม่ — ฟังก์ชัน performX ทุกตัว
    // ที่อ้างในนี้เป็น function declaration ที่ hoisted อยู่ใน scope เดียวกัน (io.on("connection", ...))
    // จึงเรียกจากตรงนี้ได้แม้จะประกาศจริงอยู่หลังบรรทัดนี้ในไฟล์ — รวมไว้ที่เดียวกันเผื่อเรียกซ้ำ
    // จากหลายจุด (start_game / closeVoteRound / start_night) ไม่ต้องพิมพ์ object ซ้ำทุกที่แล้วเสี่ยงพิมพ์ตก
    function nightBotDeps() {
        return {
            rooms,
            performWolfKill,
            performSelectTarget,
            performScoutTarget,
            performDetectiveScout,
            performWitchPoison,
            isPlayerCurrentlyConnected,
            WOLF_ROLES,
        };
    }

    // ส่ง Running version จริงของ Elastic Beanstalk ให้ client ทันทีหลังเชื่อมต่อ
    // client ใช้ค่าจาก event นี้เป็นแหล่งแสดงผลหลัก; ถ้า AWS ยังตอบไม่ทันจะได้ fallback จาก /api/config
    getAppVersion().then((version) => {
        try { socket.emit("serverInfo", { version, buildVersion: computeServerVersion(), clientHash: computeClientHash(), adminHash: computeAdminHash() }); } catch (_) {}
    }).catch((err) => {
        console.error("[serverInfo] failed to get app version:", err);
        try { socket.emit("serverInfo", { version: "unknown", buildVersion: computeServerVersion(), clientHash: computeClientHash(), adminHash: computeAdminHash() }); } catch (_) {}
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
    socket.on("create_room", async ({ name, token, accountId, accountToken, isTester, testerSessionId, settings } = {}, cb) => {
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
        // บัญชีจริงใช้ accountId + accountToken; token ของห้องยังแยกเป็น room reconnect credential
        const requestedAccountId = testerGranted ? "" : normalizeAccountId(accountId || "");
        const accountIdentity = testerGranted
            ? { ok: true, accountId: "", name: sanitizeName(name, "โฮสต์"), profile: null }
            : await ensureNormalAccountIdentity(requestedAccountId, name, { accountToken, roomId: "", isHost: true, join: true });
        if (!accountIdentity.ok) return cb({ error: accountIdentity.code.toLowerCase(), code: accountIdentity.code });
        name = accountIdentity.name;
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
        const hostToken = normalizeAccountId(token || "") || (genId() + genId());
        const testerHostSlot = testerGranted ? nextTesterHostSlot() : 0;
        if (testerGranted) name = `โฮสต์${testerHostSlot}`;
        else name = sanitizeName(name, "โฮสต์");

        rooms[id] = {
            id,
            // ห้องผู้ทดสอบ: server ตัดสินตอนสร้างห้องเท่านั้น (client แก้ทีหลังไม่ได้ — ไม่มี event ไหนรับค่านี้จาก client) → ไม่ถูกปิดโดยการปิดเซิร์ฟเวอร์/บังคับรีโหลด
            isTesterRoom: testerGranted,
            testerHostSlot,
            testerSessionId: testerGranted ? String(testerSessionId || "").slice(0, 128) : "",
            host: socket.id,
            hostIds: [socket.id],
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
            // เฟส 0 (bot-autonomous-ai-phases.md): flag คุม AI บอทต่อห้อง — enabled คุมทั้งห้อง,
            // perBot คุมรายตัว ({ [botId]: false } = ปิดเฉพาะตัวนั้น) ตอนนี้ยังไม่มีอะไรอ่านค่านี้จริง
            // (เฟส 2 จะเริ่มเช็คก่อนให้ runBotsFor ทำงาน, เฟส 4 จะมี UI ให้โฮสต์สลับ toggle นี้)
            // llmBots: เฟส 5 / "แนวทาง B" — perBot[id] === true คือให้บอทตัวนั้นใช้ Claude ตัดสินใจ
            // แทนสุ่ม (ดู bot-autonomous-ai-approach-b-technical.md) ปิดเป็นค่าเริ่มต้นเสมอ
            //
            // แก้ตามคำขอ: สวิตช์ "บอทเล่นเองอัตโนมัติ (ทั้งห้อง)" เปลี่ยนจากเริ่มต้น "เปิด" เป็น
            // "ปิด" เสมอสำหรับห้องใหม่ทุกห้อง — โฮสต์ต้องกดเปิดเองถึงจะให้บอทเล่นเองอัตโนมัติได้
            // (ปิด default ไว้กันบอทสุ่ม action โดยไม่ตั้งใจก่อนโฮสต์พร้อม)
            botAI: { enabled: st.botAIEnabled, perBot: {}, llmBots: {} },
            players: [{
                id: socket.id,
                token: hostToken,
                accountId: testerGranted ? "" : (accountIdentity.accountId || hostToken),
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

        socket.join(id);
        socket.join(hostRoomName(id));
        hostSocketRooms[socket.id] = id;
        // บันทึก snapshot + register index ก่อนส่ง room_update/ack เพื่อให้ "สร้างห้องสำเร็จ"
        // หมายถึงห้องมีสำเนาถาวรอยู่แล้ว (ถ้า DynamoDB ชั่วคราวล่มยัง fail-open ต่อเกมได้)
        try { await persistRoomSnapshot(rooms[id], { register: true }); }
        catch (e) { console.error(`[room-persist] สร้าง snapshot ห้อง ${id} ไม่สำเร็จ:`, e.name, e.message); }
        io.to(id).emit("room_update", publicRoomView(rooms[id]));
        broadcastSuggestedRoom();
        // ลงทะเบียนชื่อ legacy เฉพาะผู้เล่นจริง; tester ไม่มีบัญชีจริงเด็ดขาด
        if (!testerGranted) {
            touchAccountPresence(accountIdentity.accountId || hostToken, { roomId: id, name, isHost: true });
        } else {
            // tester ไม่เขียน registry/account แต่ snapshot ยังเก็บ room สำหรับการทดสอบตามเดิม
        }
        // ส่งรหัสที่ตั้งไว้กลับไปด้วย (เฉพาะ ack ให้โฮสต์ที่สร้างห้อง ไม่ผ่าน room_update ที่ broadcast ให้ทุกคน) —
        // client จำไว้ในเครื่องเหมือนตอนตั้งผ่าน "⚙️ ตั้งค่าห้อง" จะได้ host_login ซ้ำ/โชว์ในช่องตั้งค่าได้
        cb({ ok: true, roomId: id, token: hostToken, hostPassword: st.hostPassword, joinCode: st.joinCode, testerHostSlot });
    });

    // ----------------------------------------------------------------
    // LIST OPEN ROOMS
    // ----------------------------------------------------------------
    socket.on("list_open_rooms", (cb) => {
        cb(getOpenRoomsList());
    });

    // ----------------------------------------------------------------
    // LIST OPEN ROOMS (ฝั่งผู้เล่น — ดู getOpenRoomsListForPlayers ด้านบนสำหรับฟิลด์ที่ตัดออก)
    // ----------------------------------------------------------------
    socket.on("list_open_rooms_players", (cb) => {
        if (typeof cb !== "function") cb = () => {};
        cb(getOpenRoomsListForPlayers());
    });

    // ----------------------------------------------------------------
    // HOST LOGIN — เข้าคุมห้องที่เลือกจากกริด (ไม่ต้องมี token เดิมตรงกัน)
    // ----------------------------------------------------------------
    socket.on("host_login", async ({ roomId, token, password, accountId, accountToken } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        if (!roomId || (typeof roomId !== "string" && typeof roomId !== "number")) {
            return cb({ error: "room not found", code: "ROOM_NOT_FOUND" });
        }
        roomId = String(roomId).trim().toUpperCase();
        let room = rooms[roomId];
        if (!room) {
            // Multi-instance / cold-start fallback: the room may exist in DynamoDB even though this
            // particular EB instance has not loaded it into RAM yet. Do not treat that as a closed room.
            try {
                room = await recoverPersistedRoomById(roomId, { reason: "host_login" });
            } catch (e) {
                console.error(`[room-recovery] host_login กู้คืนห้อง ${roomId} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
                return cb({ error: "room recovery temporarily unavailable", code: "SERVER_ERROR" });
            }
        }
        if (!room) return cb({ error: "room not found", code: "ROOM_NOT_FOUND" });

        // กันแอดมิน/จอคนอื่นแย่งคุมห้องที่ตั้งรหัสไว้ (ดูคอมเมนต์ตอนสร้างห้อง) — ต้องส่งรหัสห้อง
        // ที่ตรงกันมาด้วยถึงจะ login เข้าคุมห้องนี้ได้ ถ้าห้องนี้ไม่ได้ตั้งรหัสไว้ (hostPassword ว่าง)
        // ก็ข้ามการเช็คนี้ไปเหมือนเดิม (พฤติกรรมเดิมของห้องที่ไม่ได้ตั้งรหัส)
        if (room.hostPassword) {
            const attemptKey = `host:${roomId}`;
            if (!isLoginAttemptAllowed(attemptKey)) {
                return cb({ error: "too_many_attempts", code: "TOO_MANY_ATTEMPTS" });
            }
            if (password !== room.hostPassword) {
                recordFailedLoginAttempt(attemptKey);
                return cb({ error: "wrong_password", code: "AUTH_FAILED" });
            }
            clearFailedLoginAttempts(attemptKey);
        }

        const hostPlayer = room.players.find((p) => p.isHost);
        if (!hostPlayer) return cb({ error: "host slot missing", code: "ROOM_NOT_FOUND" });

        if (token) hostPlayer.token = token;
        if (isTesterRoom(room)) {
            hostPlayer.isTester = true;
            hostPlayer.accountId = "";
            if (!room.testerHostSlot) room.testerHostSlot = nextTesterHostSlot();
            hostPlayer.name = `โฮสต์${room.testerHostSlot}`;
        } else {
            const accountIdentity = await ensureNormalAccountIdentity(normalizeAccountId(accountId || hostPlayer.accountId || ""), hostPlayer.name, { accountToken, roomId, isHost: true, join: false });
            if (!accountIdentity.ok) return cb({ error: accountIdentity.code.toLowerCase(), code: accountIdentity.code });
            hostPlayer.accountId = accountIdentity.accountId;
            hostPlayer.name = accountIdentity.name;
            touchAccountPresence(hostPlayer.accountId, { roomId, name: hostPlayer.name, isHost: true });
        }
        hostPlayer.disconnected = false;
        hostPlayer.id = socket.id; // เก็บ id ของจอที่ login ล่าสุดไว้เผื่อโค้ดเก่าอ้างอิง
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

        io.to(roomId).emit("room_update", publicRoomView(room));
        if (!hostPlayer.isTester) socket.emit("name_updated_by_host", { name: hostPlayer.name, accountId: hostPlayer.accountId || "" });
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
    socket.on("update_room_settings", ({ roomId, hostPassword, joinCode, maxPlayers, revealDeadRole } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const room = rooms[roomId];
        if (!room) return cb({ error: "room not found" });
        if (!isHostSocket(room, socket.id)) return cb({ error: "not host" });

        // กฎความปลอดภัย: "แสดงบทคนตาย" เปลี่ยนได้เฉพาะตอนห้องยังไม่เริ่มเกมเท่านั้น
        // ต้องเช็คจาก server เพราะ client ปิดปุ่มอย่างเดียวไม่พอ และกันการยิง Socket event ตรงหลังเริ่มเกม
        if (revealDeadRole !== undefined) {
            if (room.started) return cb({ error: "room_started", code: "ROOM_STARTED", field: "revealDeadRole" });
            if (typeof revealDeadRole !== "boolean") return cb({ error: "invalid_reveal_dead_role", code: "INVALID_REVEAL_DEAD_ROLE" });
            room.revealDeadRole = revealDeadRole;
        }

        if (typeof hostPassword === "string") {
            room.hostPassword = hostPassword.trim().slice(0, 20);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
        schedulePersistRoom(roomId, true);
        broadcastSuggestedRoom();
        cb({ ok: true, hostPassword: room.hostPassword, joinCode: room.joinCode, maxPlayers: room.maxPlayers, revealDeadRole: room.revealDeadRole !== false });
    });

    // ----------------------------------------------------------------
    // PREVIOUS ROOM STATUS — ตรวจห้องเดิมของผู้เล่นก่อน auto-join ตอนเปิดหน้าใหม่
    // ----------------------------------------------------------------
    socket.on("player_resume_status", async ({ roomId, token } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const id = String(roomId || "").trim().toUpperCase();
        const tok = String(token || "");
        if (!id || !tok) return cb({ ok: true, roomExists: false, playerFound: false });
        let room = rooms[id];
        if (!room) {
            try { room = await recoverPersistedRoomById(id, { reason: "player_resume_status" }); }
            catch (e) {
                console.error(`[room-recovery] ตรวจห้องเดิม ${id} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
                return cb({ error: "server error", code: "SERVER_ERROR" });
            }
        }
        if (!room) return cb({ ok: true, roomExists: false, playerFound: false });
        const player = room.players.find((p) => p && !p.isHost && p.token === tok);
        if (!player) return cb({ ok: true, roomExists: true, playerFound: false, roomId: id });
        const hostPlayer = room.players.find((p) => p.isHost);
        const roundId = getRoomGameRoundId(room);
        const alreadyLeft = !!(room.started && !room.gameOver && player.leftGameRoundId === roundId);
        return cb({
            ok: true,
            roomExists: true,
            playerFound: true,
            roomId: id,
            hostName: hostPlayer?.name || "",
            playerCount: room.players.filter((p) => !p.isHost).length,
            maxPlayers: room.maxPlayers || 0,
            started: !!room.started,
            gameOver: !!room.gameOver,
            isTesterRoom: !!room.isTesterRoom,
            isNight: !!room.isNight,
            alreadyLeft,
        });
    });

    // ----------------------------------------------------------------
    // ABANDON GAME — ผู้เล่นเลือก "หาห้องใหม่" ระหว่างเกมที่ยังไม่จบ
    // บันทึก leave ทันที และล็อก token ไม่ให้ join กลับเข้ารอบเดิมอีก
    // ----------------------------------------------------------------
    socket.on("abandon_game", async ({ roomId, token, reason } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const id = String(roomId || "").trim().toUpperCase();
        const tok = String(token || "");
        if (!id || !tok) return cb({ ok: false, code: "ROOM_NOT_FOUND" });
        let room = rooms[id];
        if (!room) {
            try { room = await recoverPersistedRoomById(id, { reason: "abandon_game" }); }
            catch (e) {
                console.error(`[room-recovery] abandon_game กู้ห้อง ${id} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
                return cb({ ok: false, code: "SERVER_ERROR" });
            }
        }
        if (!room) return cb({ ok: true, code: "ROOM_NOT_FOUND" });
        const player = room.players.find((p) => p && !p.isHost && p.token === tok);
        if (!player) return cb({ ok: true, code: "ROOM_NOT_FOUND" });
        clearPendingBrowserExit('player', id, tok, { source:'abandon_game' });
        if (!room.started || room.gameOver) {
            // หน้าใหม่อาจยังไม่ได้ join socket เข้าห้องเดิม จึงต้องลบสมาชิกด้วย token ได้ด้วย
            // ไม่ใช่พึ่ง socket.id อย่างเดียวเหมือน leave_room ซึ่งตั้งใจใช้กับ back navigation
            // ของ socket ที่อยู่ในห้องอยู่แล้ว
            if (!room.started && !room.gameOver) {
                if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
                if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token].timer); delete pendingIndicators[player.token]; }
                const playerId = player.id;
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
                room.players = room.players.filter((p) => p.token !== tok);
                io.to(id).emit("room_update", publicRoomView(room));
                schedulePersistRoom(id, true);
                broadcastSuggestedRoom();
            }
            socket.leave(id);
            return cb({ ok: true, code: room.gameOver ? "ROOM_ALREADY_ENDED" : "LEFT_LOBBY", recorded: false });
        }
        const roundId = getRoomGameRoundId(room);
        if (player.leaveStatsRecordedRoundId === roundId) {
            player.leftGameRoundId = roundId;
            player.disconnected = true;
            player.offline = true;
            // การเลือก "หาห้องใหม่" ระหว่างเกมถือเป็นการตายทันทีในรอบเดิม
            // ถ้าสถิติถูกบันทึกไปแล้ว (เช่น client retry หลัง ACK หลุด) ต้องทำ game-state
            // transition ให้ครบด้วยเช่นกัน แต่ห้ามประกาศซ้ำหลายครั้ง
            if (player.alive) {
                player.alive = false;
                cleanupAfterVoluntaryLeaveDeath(room, player);
                const leaveMsg = {
                    name: "เกม",
                    text: `🚪 ${player.name || "ผู้เล่น"} ออกจากเกม`,
                    type: "global",
                    isSystem: true,
                    isDeath: true,
                    isGameLeave: true,
                };
                pushGlobalChat(room, leaveMsg);
                io.to(id).emit("chat_message", leaveMsg);
                checkGameEndGeneral(room, id);
            }
            socket.leave(id);
            io.to(id).emit("room_update", publicRoomView(room));
            schedulePersistRoom(id, true);
            return cb({ ok: true, alreadyRecorded: true, recorded: true });
        }

        try {
            const result = await recordImmediateGameLeaveStats(room, player, reason || "new_room");
            if (!result.ok) return cb({ ok: false, code: "SERVER_ERROR" });
        } catch (e) {
            console.error(`[leave] บันทึกผู้เล่นออกเกม ${id}/${tok.slice(0, 8)} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
            return cb({ ok: false, code: "SERVER_ERROR" });
        }

        player.disconnected = true;
        player.offline = true;

        // การหนีด้วย "หาห้องใหม่" ระหว่างเกม = ตายทันทีในเกมเดิม
        // ใช้ cleanupAfterDeath() เพื่อถอนเป้าหมาย/โหวต/การป้องกัน/ความสัมพันธ์ที่เกี่ยวข้อง
        // และถอนเฉพาะเอฟเฟกต์ของผู้ที่หนี โดยไม่เรียกกฎตายตาม (คู่รัก, คู่ยุยง, ลูกหมาป่า, ลัทธิ)
        // เพื่อให้การหนีไม่ส่งผลให้ผู้เล่นอื่นตาย/เปลี่ยนสถานะตาม
        if (player.alive) {
            player.alive = false;
            cleanupAfterVoluntaryLeaveDeath(room, player);

            const leaveMsg = {
                name: "เกม",
                text: `🚪 ${player.name || "ผู้เล่น"} ออกจากเกม`,
                type: "global",
                isSystem: true,
                isDeath: true,
                isGameLeave: true,
            };
            pushGlobalChat(room, leaveMsg);
            io.to(id).emit("chat_message", leaveMsg);
        }

        if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
        if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token].timer); delete pendingIndicators[player.token]; }
        socket.leave(id);
        io.to(id).emit("room_update", publicRoomView(room));
        checkGameEndGeneral(room, id);
        schedulePersistRoom(id, true);
        broadcastSuggestedRoom();
        cb({ ok: true, recorded: true, roomId: id, markedDead: true });
    });

    // ----------------------------------------------------------------
    // JOIN ROOM
    // ----------------------------------------------------------------
    socket.on("join_room", async ({ roomId, name, token, code, accountId, accountToken, isTester, testerSessionId } = {}, cb) => {
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
            try {
                room = await recoverPersistedRoomById(roomId, { reason: "join_room" });
            } catch (e) {
                console.error(`[room-recovery] join_room กู้คืนห้อง ${roomId} ไม่สำเร็จ:`, e.name || "Error", e.message || e);
                return cb({ error: "room recovery temporarily unavailable", code: "SERVER_ERROR" });
            }
        }
        if (!room) return cb({ error: "room not found", code: "ROOM_NOT_FOUND" });
        if (name !== undefined) name = sanitizeName(name);
        // ตรวจว่าเป็นการ reconnect (token ตรงกับผู้เล่นในห้อง)
        let player = token ? room.players.find((p) => p.token === token) : null;
        const isReconnect = !!player;
        const testerGranted = resolveTesterFlag(socket, isTester); // ดู create_room — client ขอได้แต่ server ตัดสิน
        const existingPlayerIsBot = !!(player && player.isBot);
        // Bot possession is a tester-only reconnect path. A bot has no Game Account identity, so
        // its stable room token must never fall through to ensureNormalAccountIdentity().
        // This also covers older persisted bot snapshots that were created before `isTester` was
        // stored on bot records; `isBot` is the authoritative discriminator for account auth.
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
        // ช่วยวินิจฉัยข้าม instance โดยตรง: ถ้า client ประกาศ tester และมีบัตรผ่าน/ตั้งใจเป็น tester
        // แต่ bootstrap secret ใช้งานไม่ได้ ให้รหัสเฉพาะแทนการไหลไปถึง account auth ซึ่งทำให้เห็นเป็น
        // ACCOUNT_TOKEN_REQUIRED แบบเก่า; ถ้ามีบัตรแต่ signature ไม่ตรง ให้ TESTER_PASS_INVALID
        if (isTester === true && !isReconnect && socket.data.testerPassBootstrapError) {
            recordDiagnostic({
                source: "server", kind: "tester_auth_rejected", page: "server",
                message: "ยังโหลด shared tester pass secret ไม่สำเร็จก่อน join_room",
                data: { roomId, requestedTester: true, testerPassPresented: !!socket.data.testerPassPresented,
                    testerPassValid: false, bootstrapError: socket.data.testerPassBootstrapError },
                traceId: String(socket.data.diagnosticTraceId || ""), sessionId: String(socket.data.diagnosticSessionId || ""),
            });
            return cb({ error: "tester pass temporarily unavailable", code: "TESTER_PASS_UNAVAILABLE" });
        }
        if (isTester === true && !isReconnect && socket.data.testerPassPresented && !socket.data.testerPassValid) {
            recordDiagnostic({
                source: "server", kind: "tester_auth_rejected", page: "server",
                message: "Tester pass ที่มากับ Socket.IO handshake ไม่ผ่านการตรวจ signature/expiry",
                data: { roomId, requestedTester: true, testerPassPresented: true, testerPassValid: false },
                traceId: String(socket.data.diagnosticTraceId || ""), sessionId: String(socket.data.diagnosticSessionId || ""),
            });
            return cb({ error: "tester pass invalid or expired", code: "TESTER_PASS_INVALID" });
        }
        if (isTester === true && !isReconnect && !socket.data.testerPassPresented) {
            return cb({ error: "tester pass required", code: "TESTER_PASS_REQUIRED" });
        }
        if (player && room.started && !room.gameOver && player.leftGameRoundId === getRoomGameRoundId(room)) {
            return cb({ error: "player already left game", code: "PLAYER_LEFT_GAME" });
        }
        // บัญชีจริงใหม่ต้องมีชื่อที่ผู้ใช้ยืนยันจากหน้า index ก่อนสร้าง profile/ผู้เล่น
        // ส่วน reconnect ใช้ชื่อที่เก็บอยู่ใน server ได้ จึงไม่บังคับ payload name ซ้ำ
        if (!testerGranted && !isReconnect && (!name || sanitizeName(name, "ผู้เล่น") === "ผู้เล่น")) {
            return cb({ error: "missing_display_name", code: "MISSING_DISPLAY_NAME" });
        }
        if (testerGranted && !room.isTesterRoom && !isReconnect) {
            return cb({ error: "tester room required", code: "TESTER_ROOM_REQUIRED" });
        }
        let accountIdentity = null;
        if (!room.isTesterRoom && !isReconnect && !existingPlayerIsBot) {
            accountIdentity = await ensureNormalAccountIdentity(normalizeAccountId(accountId || ""), name, { accountToken, roomId, isHost: false, join: true });
            if (!accountIdentity.ok) return cb && cb({ error: accountIdentity.code.toLowerCase(), code: accountIdentity.code });
        }

        if (player) {
            clearPendingBrowserExit('player', roomId, token, { source:'join_room_reconnect', traceId:socket.data?.diagnosticTraceId || '', sessionId:socket.data?.diagnosticSessionId || '' });
            const oldId = player.id;
            remapPlayerId(room, oldId, socket.id);
            player.id = socket.id;
            if (player.isBot || player.isTester) {
                player.accountId = "";
                // Bots are synthetic tester players; never mutate their bot identity into an account-backed player.
                if (player.isBot) {
                    player.isTester = true;
                    player.testerSessionId = String(testerSessionId || player.testerSessionId || "").slice(0, 128);
                } else {
                    if (!player.isHost && !player.testerPlayerSlot) player.testerPlayerSlot = nextTesterPlayerSlot(player);
                    if (!player.isHost && player.testerPlayerSlot) player.name = `ผู้เล่น${player.testerPlayerSlot}`;
                }
            } else {
                const reconnectAccountId = normalizeAccountId(player.accountId || "");
                const ensured = await ensureNormalAccountIdentity(reconnectAccountId, player.name, { accountToken, roomId, isHost: !!player.isHost, join: false });
                if (!ensured.ok) return cb && cb({ error: ensured.code.toLowerCase(), code: ensured.code });
                player.accountId = ensured.accountId;
                player.name = ensured.name;
                touchAccountPresence(player.accountId, { roomId, name: player.name, isHost: !!player.isHost });
            }
            // ชื่อตั้งได้ครั้งเดียวตอน "เข้าห้องครั้งแรก" เท่านั้น (ดู branch ผู้เล่นใหม่ด้านล่าง)
            // ตอน reconnect ด้วย token เดิม ห้ามรับชื่อจาก client มาทับอีกเด็ดขาด แม้ client จะส่งมา
            // ก็ตาม (เดิมมี `if (name) player.name = name;` ตรงนี้ ทำให้ผู้เล่นย้อนไปหน้าแรกแล้วแก้ชื่อ
            // ในเครื่องตัวเอง กลับมา rejoin ห้องเดิมด้วย token เดิม ก็เปลี่ยนชื่อในห้องได้เองอยู่ดี
            // ทั้งที่ตั้งใจให้แก้ได้ทางเดียวคือแอดมินเท่านั้น — ตัดออกเพื่อบังคับใช้จริงฝั่ง server)
            player.disconnected = false;
            player.offline = false;
            // ปิดช่วงออฟไลน์ที่ค้างอยู่ (ถ้ามี) บวกเวลาที่หลุดไปจริงเข้ายอดสะสม — ใช้ตัดสิน
            // "ออกเกม" ตอนจบเกม (ดู didLeaveGame/markPlayerOfflineStart ด้านบน)
            flushPlayerOfflineTime(player);

            if (pendingRemovals[token]) {
                clearTimeout(pendingRemovals[token].timer);
                delete pendingRemovals[token];
            }
            if (pendingIndicators[token]) {
                clearTimeout(pendingIndicators[token]);
                delete pendingIndicators[token];
            }
        } else {
            player = room.players.find((p) => p.id === socket.id);
            if (!player) {
                // กันคนใหม่ (ไม่ใช่ reconnect เพราะ token ไม่ตรงกับใครในห้องเลย) เข้าห้องหลังเกม
                // เริ่มไปแล้ว — เดิมไม่มีการเช็คนี้ ทำให้ผู้เล่นใหม่ที่เพิ่งเข้ามาได้ role: null
                // ค้างตลอดเกม (ไม่ได้รับบทเพราะ start_game แจกบทไปครั้งเดียวตอนกดเริ่มเท่านั้น)
                // กลายเป็นการ์ดค้างอยู่ในกริดที่ไม่มีบทบาท และ checkGameEndGeneral (teamOf(null))
                // จะไม่นับคนนี้เป็นทั้งหมาป่า/ชาวบ้าน/โซโล่เลย ทำให้เงื่อนไขจบเกมคลาดเคลื่อนได้
                // ผู้เล่นที่ token ตรงกับคนเดิมในห้อง (isReconnect) ยังกลับเข้าห้องระหว่างเกมได้ปกติ
                if (room.started) {
                    return cb && cb({ error: "started", code: "ROOM_STARTED" });
                }

                // รหัสห้องฝั่งผู้เล่น (ตั้งไว้ผ่าน "⚙️ ตั้งค่าห้อง" แยกจากรหัสควบคุมห้อง) — เช็คเฉพาะ
                // ผู้เล่น "ใหม่จริงๆ" เท่านั้น (ไม่ใช่ reconnect ด้วย token เดิม ซึ่งอยู่ในห้องแล้ว
                // ไม่ต้องกรอกซ้ำ) ถ้าห้องนี้ไม่ได้ตั้งรหัสไว้ (joinCode ว่าง) ก็ข้ามการเช็คนี้ไปเลย
                if (room.joinCode) {
                    const attemptKey = `join:${roomId}`;
                    if (!isLoginAttemptAllowed(attemptKey)) {
                        return cb && cb({ error: "too_many_attempts", code: "TOO_MANY_ATTEMPTS" });
                    }
                    if (code !== room.joinCode) {
                        recordFailedLoginAttempt(attemptKey);
                        return cb && cb({ error: "wrong_code", code: "AUTH_FAILED" });
                    }
                    clearFailedLoginAttempts(attemptKey);
                }

                // จำนวนผู้เล่นสูงสุด (ตั้งไว้ผ่าน "⚙️ ตั้งค่าห้อง") — 0 = ไม่จำกัด เช็คเฉพาะผู้เล่นใหม่
                // เหมือนกัน (คนที่อยู่ในห้อง/reconnect ได้เสมอ ไม่โดนเตะเพราะห้องเต็มทีหลัง)
                if (room.maxPlayers > 0) {
                    const nonHostCount = room.players.filter((p) => !p.isHost).length;
                    if (nonHostCount >= room.maxPlayers) {
                        return cb && cb({ error: "room_full", code: "ROOM_FULL" });
                    }
                }

                const finalToken = token || genId();
                // reload/reconnect ภายใน browser-exit grace ต้องยกเลิก pending exit ก่อนผูก player กลับเข้าห้อง
                clearPendingBrowserExit('player', roomId, finalToken, { source:'join_room' });
                const testerPlayerSlot = (testerGranted && !room.isTesterRoom) || testerGranted ? nextTesterPlayerSlot() : 0;
                const finalName = testerGranted ? `ผู้เล่น${testerPlayerSlot}` : (accountIdentity?.name || sanitizeName(name, "ผู้เล่น"));
                player = {
                    id: socket.id,
                    token: finalToken,
                    accountId: testerGranted ? "" : (accountIdentity?.accountId || ""),
                    name: finalName,
                    isHost: false,
                    role: null,
                    displayRole: null,
                    alive: true,
                    protected: false,
                    killed: false,
                    // เข้ามาผ่านโหมดผู้ทดสอบ (admin.html → ?tester=1) — ใช้โชว์ป้าย "ชั่วคราว" ในหน้า admin.html
                    // (ค่ามาจากการตัดสินของ server ไม่ใช่ที่ client ส่ง; ห้องจะเป็นห้องผู้ทดสอบหรือไม่ดูที่ room.isTesterRoom ตอนสร้างห้องเท่านั้น)
                    isTester: testerGranted,
                    testerPlayerSlot: testerGranted ? testerPlayerSlot : 0,
                    testerSessionId: testerGranted ? String(testerSessionId || "").slice(0, 128) : "",
                };
                room.players.push(player);
                // Tester ไม่บันทึกบัญชีจริง; ผู้เล่นจริงใช้ accountId/profile เป็นตัวตนเดียว
                if (!testerGranted) {
                    touchAccountPresence(player.accountId, { roomId, name: player.name, isHost: false });
                }
            }
        }

        socket.join(roomId);
        io.to(roomId).emit("room_update", publicRoomView(room));

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

        schedulePersistRoom(roomId, true);
        cb({ ok: true, roomData: room, token: player.token, accountId: player.accountId || "", testerPlayerSlot: player.testerPlayerSlot || 0 });
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

        let player = room.players.find((p) => p.id === socket.id);
        if (!player && token) player = room.players.find((p) => p.token === token);
        if (!player) return; // ไม่ใช่สมาชิกห้องนี้ (ยังไม่เคย join) — ปล่อยให้ join_room จัดการแทน

        socket.emit("room_update", publicRoomView(room));

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
    socket.on("update_config", ({ roomId, config }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.config = config;
        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // START GAME
    // ----------------------------------------------------------------
    socket.on("start_game", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;

        const realPlayers = room.players.filter((p) => !p.isHost);

        // กันไว้อีกชั้น (นอกจากกรองไม่ให้ติ๊กได้ตั้งแต่ฝั่ง client แล้ว): ห้าม config มีอาชีพที่ "ได้มาจาก
        // การเปลี่ยนบทบาทกลางเกมเท่านั้น" ปนอยู่เด็ดขาด (เช่น ผู้สมรู้ร่วมคิด — เกิดจากโจรเปลี่ยนบทบาท
        // ผู้เล่นคนอื่นให้เท่านั้น) เผื่อมีการแก้ config ตรงๆ ผ่านช่องทางอื่นที่ไม่ผ่าน UI ปกติ
        NON_SELECTABLE_ROLES.forEach((r) => { delete room.config[r]; });

        // ถ้าเกมจบไปแล้ว ต้องรอให้ผู้เล่นทุกคนกด "ดำเนินการต่อ" ครบก่อน
        if (room.gameOver) {
            const ready = room.continueReady || {};
            if (!realPlayers.every((p) => ready[p.id])) {
                io.to(hostRoomName(roomId)).emit(
                    "host_error",
                    "ต้องรอให้ผู้เล่นกด \"ดำเนินการต่อ\" ให้ครบทุกคนก่อน ถึงจะเริ่มเกมใหม่ได้"
                );
                return;
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
            wolfMemory: {},
            publiclySuspectedIds: [],
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
        io.to(roomId).emit("room_update", publicRoomView(room));
        room.justStarted = false; // ล้างทันทีหลังส่ง ไม่ให้ update ถัดไปล้างแชทซ้ำ

        // เริ่มคืนแรกอัตโนมัติทันทีหลังแจกบทเสร็จ — โฮสต์ไม่ต้องกด "เริ่มคืน" เองอีกครั้ง
        beginNight(room, roomId);

        // แก้บั๊ก: จุดนี้ขาด runBotsFor("wolfKill"/"nightSkill", ...) ไปเดิม (ต่างจาก
        // socket.on("start_night") ที่มี) ทำให้บอทไม่ทำ action เลยตั้งแต่ "คืนแรก" ของทุกเกม
        // เพราะคืนแรกเข้ามาทางนี้เสมอ (ไม่ได้ผ่าน start_night handler) — เพิ่มให้ตรงนี้เหมือนกัน
        if (!room.gameOver) {
            runBotsFor(room, roomId, "wolfKill", nightBotDeps());
            runBotsFor(room, roomId, "nightSkill", nightBotDeps());
        }
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

        io.to(roomId).emit("room_update", publicRoomView(room));
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

        io.to(roomId).emit("room_update", publicRoomView(room));
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

        io.to(roomId).emit("room_update", publicRoomView(room));
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
            closeVoteRound(room, roomId, nightBotDeps());
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
                    closeVoteRound(r, roomId, nightBotDeps());
                }, VOTE_ROUND_MS);
            }

            io.to(roomId).emit("room_update", publicRoomView(room));

            // เฟส 2 (bot-autonomous-ai-phases.md): ให้บอทที่ไม่มีคนเข้าสิงโหวตเองอัตโนมัติ
            // (deps ส่ง performCastVote/isPlayerCurrentlyConnected เข้าไปเพราะ botEngine.js
            // เข้าถึงฟังก์ชันในไฟล์นี้ตรง ๆ ไม่ได้ — กัน circular require)
            runBotsFor(room, roomId, "vote", {
                rooms,
                performCastVote,
                isPlayerCurrentlyConnected,
                WOLF_ROLES,
            });
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
                    closeVoteRound(r, roomId, nightBotDeps());
                }, VOTE_ROUND_MS);
            } else {
                room.voteDeadline = null;
            }
        }

        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // CAST VOTE
    // ----------------------------------------------------------------
    // เฟส 1 (bot-autonomous-ai-phases.md): แยก logic ออกจาก socket.id เป็น performCastVote(...,
    // voterId, ...) เรียกจาก playerId ตรง ๆ ได้ (เตรียมให้ botEngine.js เรียกแทนบอทได้ตั้งแต่เฟส 2)
    // handler ข้างล่างยังทำงานเหมือนเดิมทุกประการ แค่เป็น wrapper บาง ๆ ที่ห่อ performCastVote ไว้
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("cast_vote", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performCastVote(room, roomId, socket.id, targetId);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("cast_wolf_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performWolfKill(room, roomId, socket.id, targetId);
    });

    // ----------------------------------------------------------------
    // CAST MURDERER KILL
    // เช็คแค่ room.isNight เหมือน cast_wolf_kill ด้านบน — เลือกเป้าเองได้เลยตอนกลางคืน
    // ----------------------------------------------------------------
    socket.on("cast_murderer_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.isNight) return;

        const voter = room.players.find((p) => p.id === socket.id);
        if (!voter || !voter.alive || voter.isHost) return;
        if (voter.role !== "ฆาตกรต่อเนื่อง") return;

        if (!targetId) {
            room.murdererKillVote = null;
        } else {
            if (targetId === socket.id) return;
            const target = room.players.find((p) => p.id === targetId);
            // แก้บั๊กเดียวกับ performCastVote/performWolfKill ด้านบน: เดิมไม่เช็ค target.isHost
            if (!target || target.isHost || !target.alive) return;
            room.murdererKillVote = { voterId: socket.id, targetId };
        }

        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // CAST INSTIGATOR KILL (ความสามารถผู้ยุยง: หลังผู้ศรัทธาทั้งสองตายแล้วเท่านั้น สามารถฆ่า
    // ผู้เล่นคนอื่นด้วยตัวเองได้ 1 คนต่อคืน — ทำงานแบบเดียวกับ cast_murderer_kill เป๊ะๆ ต่างกันแค่
    // เงื่อนไขปลดล็อก (เช็คจาก instigatorBelieversBothDead) ดูคำอธิบายบทบาทผู้ยุยง
    // ----------------------------------------------------------------
    socket.on("cast_instigator_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room || !room.isNight) return;

        const voter = room.players.find((p) => p.id === socket.id);
        if (!voter || !voter.alive || voter.isHost) return;
        if (voter.role !== "ผู้ยุยง") return;
        if (!instigatorBelieversBothDead(room, voter)) return; // ยังไม่ปลดล็อกสิทธิ์นี้

        if (!targetId) {
            room.instigatorKillVote = null;
        } else {
            if (targetId === socket.id) return;
            const target = room.players.find((p) => p.id === targetId);
            if (!target || target.isHost || !target.alive) return;
            room.instigatorKillVote = { voterId: socket.id, targetId };
        }

        io.to(roomId).emit("room_update", publicRoomView(room));
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("cast_bandit_kill", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performBanditKill(room, roomId, socket.id, targetId);
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

        // เฟส 5 (bot-autonomous-ai-phases.md): เก็บรายชื่อคนที่ "ถูกป้องกันสำเร็จ" ในการสรุปผลรอบนี้
        // ไว้ให้ botEngine.js ใช้ลดโอกาสเลือกเป้าซ้ำคืนถัดไป (ดู room.wolfMemory ด้านล่าง)
        // เป็น array ใหม่ทุกครั้งที่ resolve_night ทำงาน → แทนที่ของคืนก่อนหน้าอัตโนมัติ (ไม่ต้องเคลียร์เอง)
        const recentlyProtectedIdsThisResolve = [];

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
        // ใหม่: ถ้าคืนนี้ไม่มีใครเลือกไว้เลย (ไม่มี pendingLoverPair/pendingInstigatorPair ค้างอยู่)
        // ให้ระบบสุ่มจับคู่ให้อัตโนมัติแทน — สำคัญมากตอนบอทได้รับบทกามเทพ/ผู้ยุยง เพราะบอทไม่มีตรรกะ
        // เลือกจับคู่เอง (ดู botEngine.js/llmBotEngine.js) ถ้าไม่มี fallback นี้เกมจะค้าง ไม่มีคู่เกิดขึ้นเลย

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
                recentlyProtectedIdsThisResolve.push(p.id); // เฟส 5: จำไว้ให้บอทหมาป่าลดโอกาสเลือกเป้าเดิมซ้ำคืนหน้า
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
                recentlyProtectedIdsThisResolve.push(p.id);
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

        // เฟส 5 (bot-autonomous-ai-phases.md): บันทึกผลของ "คืนนี้" ไว้ให้ botEngine.js อ่านตอน
        // เลือกเป้ากัดคืนถัดไป — เก็บแค่ 1 ชั้น (คืนล่าสุดเท่านั้น) เพราะแผนระบุแค่ "เมื่อคืนก่อน"
        // ไม่ต้องจำสะสมหลายคืนย้อนหลัง
        room.wolfMemory = room.wolfMemory || {};
        room.wolfMemory.recentlyProtectedIds = recentlyProtectedIdsThisResolve;

        io.to(roomId).emit("room_update", publicRoomView(room));

        // เฟส 3 (bot-autonomous-ai-phases.md): ให้บอทบทบาทพิเศษที่ใช้สกิล "ตอนกลางวัน"
        // (หมาป่าผู้พิทักษ์วางโล่ / หมาป่านักเวทเลือกเป้าร่ายเวท) ทำงานเองอัตโนมัติทันทีที่เข้าสู่วันใหม่
        // (ไม่รวมกับ trigger "vote" เพราะสองสกิลนี้ใช้ได้ตั้งแต่ต้นวัน ไม่ต้องรอโฮสต์เปิดโหมดโหวต)
        if (!room.gameOver) {
            runBotsFor(room, roomId, "daySkill", {
                rooms,
                performSelectShield,
                performSelectCurseTarget,
                performSheriffPeek,
                performBotChatMessage,
                isPlayerCurrentlyConnected,
                WOLF_ROLES,
            });
        }
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

        // เฟส 2 (bot-autonomous-ai-phases.md): ให้บอทหมาป่าที่ไม่มีคนเข้าสิงเลือกเป้ากัดเองอัตโนมัติ
        runBotsFor(room, roomId, "wolfKill", nightBotDeps());

        // เฟส 3 (bot-autonomous-ai-phases.md): ให้บอทบทบาทพิเศษที่ใช้สกิล "ตอนกลางคืน"
        // (หมอ/หมาป่าหยั่งรู้-ผู้มีลาง-ผู้หยั่งรู้/แม่มด/ยายขี้โมโห/ลูกหมาป่า) ทำงานเองอัตโนมัติด้วย
        runBotsFor(room, roomId, "nightSkill", nightBotDeps());
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("select_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performSelectTarget(room, roomId, socket.id, targetId);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("cast_witch_poison", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performWitchPoison(room, roomId, socket.id, targetId);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("scout_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performScoutTarget(room, roomId, socket.id, targetId);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("detective_scout", ({ roomId, targetAId, targetBId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performDetectiveScout(room, roomId, socket.id, targetAId, targetBId);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("cupid_pair", ({ roomId, targetAId, targetBId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performCupidPair(room, roomId, socket.id, targetAId, targetBId);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("instigator_pair", ({ roomId, targetAId, targetBId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performInstigatorPair(room, roomId, socket.id, targetAId, targetBId);
    });

    // ----------------------------------------------------------------
    // GIVE UP ORACLE SENSE (หมาป่าหยั่งรู้กด "สละลางสังหรณ์" กลายเป็นหมาป่าธรรมดาโดยสมัครใจ
    // เพื่อร่วมล่าได้แทนการส่อง — ย้อนกลับไม่ได้ ใช้ pattern เดียวกับกลายร่างอัตโนมัติตอนเหลือตัวเดียว)
    // ----------------------------------------------------------------
    socket.on("give_up_oracle_sense", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        // เดิมใช้ได้เฉพาะตอนกลางคืนเท่านั้น ตอนนี้เปิดให้กดได้ทั้งวันทั้งคืนแล้ว (สละพลังล้วน ๆ ไม่ใช่การกระทำต่อเป้าหมาย)

        const p = room.players.find((pl) => pl.id === socket.id);
        if (!p || !p.alive || p.isHost) return;
        if (p.role !== "หมาป่าหยั่งรู้") return;

        transformOracleWolfToNormal(room, roomId, p, "manual");

        io.to(roomId).emit("room_update", publicRoomView(room));
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

        const player = room.players.find((p) => p.id === socket.id);
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

        io.to(roomId).emit("room_update", publicRoomView(room));
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("select_shield", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performSelectShield(room, roomId, socket.id, targetId);
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
            io.to(roomId).emit("room_update", publicRoomView(room));
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("cult_action", ({ roomId, mode, targetId, sacrificeId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performCultAction(room, roomId, socket.id, { mode, targetId, sacrificeId });
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
            io.to(roomId).emit("room_update", publicRoomView(room));
            return;
        }

        if (targetId === playerId) return;
        const target = findTargetablePlayer(room, targetId);
        if (!target) return;
        // ตั้งใจไม่เช็คเงื่อนไข "เปลี่ยนไม่ได้" ตรงนี้ (เหตุผลเดียวกับ performCultAction — หัวโจรไม่รู้
        // บทจริงของเป้าหมายที่แตะเลือก) ให้แตะเลือกติดค้างไว้ได้ปกติก่อน แล้วค่อยเช็คจริงตอน resolve_night
        room.banditActions[playerId] = { targetId };

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("bandit_action", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performBanditAction(room, roomId, socket.id, { targetId });
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
        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("select_curse_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performSelectCurseTarget(room, roomId, socket.id, targetId);
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

        const shooter = room.players.find((p) => p.id === socket.id);
        if (!shooter || shooter.isHost) return;
        if (!shooter.alive) return;
        if (shooter.role !== "ศาลเตี้ย") return;
        if (!(shooter.sheriffBullets > 0)) return;
        if (shooter.sheriffUsedToday) return; // ใช้ความสามารถวันนี้ไปแล้ว (ยิงหรือดูบท อย่างใดอย่างหนึ่งต่อวัน)

        if (!targetId || targetId === socket.id) return;
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
        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // SHERIFF PEEK ROLE — ศาลเตี้ยใช้ "ดูบทบาท" คล้ายผู้หยั่งรู้ (เห็นบทบาทจริงเฉพาะตัวเอง)
    // ใช้ได้ตอนกลางวันเท่านั้น (เหมือนปืน) และมีสิทธิ์ 1 ครั้งตลอดเกม (มีนัดเดียวเหมือนปืน)
    // วันหนึ่งใช้ได้แค่ 1 ความสามารถ (ยิงหรือดูบท เลือกได้อย่างเดียว ใช้ทั้งคู่ในวันเดียวกันไม่ได้ —
    // เช็คร่วมกับ sheriffUsedToday ซึ่งถูกตั้งจากทั้งปืนและดูบท และรีเซ็ตทุกครั้งที่เริ่มวันใหม่)
    // เป้าหมายจะได้รับแจ้งว่า "ศาลเตี้ยได้ทราบบทบาทของคุณแล้ว" แบบไม่ระบุตัวตนศาลเตี้ย
    // (ต่างจากปืนที่เปิดเผยตัวศาลเตี้ยต่อสาธารณะทันที — ดูบทไม่เปิดเผยตัวศาลเตี้ยเลย)
    //
    // เฟส 5 (bot-autonomous-ai-phases.md): แยกเป็น performSheriffPeek(room, roomId, selectorId, targetId)
    // เหมือน performCastVote/performWolfKill ด้านบน เพื่อให้ botEngine.js เรียกใช้ตอนบอทศาลเตี้ยตัดสินใจ
    // ดูบทเองได้ (เดิมเป็น callback ตรงในนี้ ไม่มีบอทเรียกได้เลย)
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

        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("sheriff_peek_target", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performSheriffPeek(room, roomId, socket.id, targetId);
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
        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("cast_priest_holy_water", ({ roomId, targetId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performPriestHolyWater(room, roomId, socket.id, targetId);
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
        io.to(roomId).emit("room_update", publicRoomView(room));
    }
    socket.on("illusion_kill_disguised", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        performIllusionKillDisguised(room, roomId, socket.id);
    });

    // ----------------------------------------------------------------
    // BOT CHAT ANNOUNCE — เฟส 5 (bot-autonomous-ai-phases.md): ให้บอทบทบาทที่มีข้อมูล (ผู้หยั่งรู้/
    // ผู้มีลาง/ศาลเตี้ย) พิมพ์ข้อความในแชทรวมกลางวันได้เอง เพื่อ "บอกชาวบ้าน" ตามข้อมูลที่ตัวเองรู้
    // ทำงานเหมือน GLOBAL CHAT ใน send_chat ทุกอย่าง (เช็คกลางวัน/ไม่โดนใบ้) แค่ผู้พูดเป็นบอทแทนผู้เล่นจริง
    // ไม่ผ่าน detectPubliclySuspectedIds ซ้ำ (botEngine.js เป็นคนเติม room.publiclySuspectedIds เอง
    // โดยตรงตอนเรียกฟังก์ชันนี้ เพราะรู้ผลลัพธ์ที่แน่นอนอยู่แล้ว ไม่ต้องเดาจากข้อความอีกที)
    // ----------------------------------------------------------------
    function performBotChatMessage(room, roomId, botId, text) {
        const bot = room.players.find((p) => p.id === botId);
        if (!bot || !bot.alive || bot.isHost) return;
        if (room.isNight) return; // ประกาศได้เฉพาะกลางวันเท่านั้น เหมือนแชทรวมปกติ
        if (bot.silenced) return; // โดนใบ้ ห้ามพูด เหมือนผู้เล่นจริง

        const msg = { name: bot.name, text, type: "global" };
        room.globalChatHistory = room.globalChatHistory || [];
        pushGlobalChat(room, msg);
        io.to(roomId).emit("chat_message", msg);
    }

    // ----------------------------------------------------------------
    // SEND CHAT
    // ----------------------------------------------------------------
    socket.on("send_chat", ({ roomId, text, type }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find((p) => p.id === socket.id);
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

        // เฟส 5: ถ้าคนพูดเป็นผู้หยั่งรู้/ผู้มีลาง และข้อความเข้าข่ายเปิดเผยความสงสัย → จำชื่อที่ถูก
        // พาดพิงไว้ให้บอทชาวบ้านใช้โหวตตาม (ดู detectPubliclySuspectedIds ด้านบน + runVotePhase)
        const newlySuspectedIds = detectPubliclySuspectedIds(room, player, msg);
        if (newlySuspectedIds.length > 0) {
            room.publiclySuspectedIds = room.publiclySuspectedIds || [];
            newlySuspectedIds.forEach((id) => {
                if (!room.publiclySuspectedIds.includes(id)) room.publiclySuspectedIds.push(id);
            });
        }
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
        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // SET ALL WIN CONDITIONS (โหมดผู้ทดสอบ) — ปุ่ม "ปิดเงื่อนไขการชนะทั้งหมด" ทีเดียว
    // แทนที่จะต้องไล่กดปิดทีละข้อ 5 ครั้ง — enabled: false = ปิดทุกข้อ, true = เปิดทุกข้อกลับ
    // ----------------------------------------------------------------
    socket.on("set_all_win_conditions", ({ roomId, enabled }) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;

        room.testerConditions = Object.fromEntries(WIN_CONDITIONS.map((k) => [k, !!enabled]));
        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // CONFIRM CONTINUE — ผู้เล่นกด "ดำเนินการต่อ" หลังเกมจบ
    // ----------------------------------------------------------------
    socket.on("confirm_continue", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameOver) return;

        const player = room.players.find((p) => p.id === socket.id);
        if (!player || player.isHost) return;

        room.continueReady = room.continueReady || {};
        room.continueReady[socket.id] = true;
        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // ACCOUNT BOOTSTRAP — สร้าง/ตรวจ Game Account ตั้งแต่เปิดเกมครั้งแรก
    // ----------------------------------------------------------------
    socket.on("account_bootstrap", async ({ accountId, accountToken, name, page } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        if (resetInProgress) return cb({ ok: false, code: "RESET_IN_PROGRESS" });
        if (socket.data.testerToken || socket.data.admin) return cb({ ok: false, code: "IGNORED" });
        try {
            const identity = await ensureNormalAccountIdentity(normalizeAccountId(accountId || ""), sanitizeName(name, ""), {
                accountToken,
                roomId: "",
                isHost: page === "host",
                join: false,
            });
            if (!identity.ok) return cb({ ok: false, code: identity.code, account: accountPublicProfile(identity.profile) });
            cb({ ok: true, account: accountPublicProfile(identity.profile), accountId: identity.accountId, name: identity.name });
        } catch (e) {
            const code = e?.code === "ACCOUNT_TOKEN_REQUIRED" ? "ACCOUNT_TOKEN_REQUIRED" : "ACCOUNT_BOOTSTRAP_FAILED";
            recordDiagnostic({ source:"server", kind:"account_bootstrap_failed", page:"server", message:e?.message || String(e), stack:e?.stack || "", detail:{ code, page: String(page || "index"), hasAccountId: !!normalizeAccountId(accountId || "") } });
            cb({ ok: false, code });
        }
    });

    // ----------------------------------------------------------------
    // RENAME SELF — ผู้เล่นเปลี่ยนชื่อเองได้ แต่ server ต้องยืนยัน Login Identity ก่อน
    // ----------------------------------------------------------------
    socket.on("rename_my_account", async ({ accountId, accountToken, newName } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        if (resetInProgress) return cb({ ok: false, code: "RESET_IN_PROGRESS" });
        if (socket.data.testerToken || socket.data.admin) return cb({ ok: false, code: "IGNORED" });
        try {
            const result = await renameOwnAccount(accountId, accountToken, newName);
            cb({ ok: true, accountId: result.accountId, name: result.name, changed: result.changed, account: accountPublicProfile(result.profile) });
        } catch (e) {
            cb({ ok: false, code: e.code || "RENAME_FAILED", error: e.message || "rename failed", retryAfterMs: e.retryAfterMs || 0 });
        }
    });

    // ----------------------------------------------------------------
    // ACCOUNT TOUCH — action สำคัญที่ผู้ใช้ทำจริง เช่น เปิด Profile
    // ----------------------------------------------------------------
    socket.on("account_touch", async ({ accountId, accountToken, reason } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        if (resetInProgress) return cb({ ok: false, code: "RESET_IN_PROGRESS" });
        if (socket.data.testerToken || socket.data.admin) return cb({ ok: false, code: "IGNORED" });
        const id = normalizeAccountId(accountId || "");
        if (!id || !accountToken) return cb({ ok: false, code: "BAD_IDENTITY" });
        try {
            const verified = await verifyAccountLogin(id, accountToken);
            if (!verified.profile) return cb({ ok: false, code: "ACCOUNT_NOT_FOUND" });
            if (verified.ok === false) return cb({ ok: false, code: verified.code, account: accountPublicProfile(verified.profile) });
            const profile = verified.profile;
            const nowMs = Date.now();
            const doc = await getDynamoDocClient();
            const now = new Date(nowMs).toISOString();
            const exprValues = { ":now": now, ":reason": String(reason || "touch").slice(0, 32) };
            let updateExpression = "SET lastSeen = :now, lastActivityAt = :now, updatedAt = :now, lastActivityReason = :reason";
            if ((profile.accountType || ACCOUNT_TYPE_TEMPORARY) === ACCOUNT_TYPE_TEMPORARY) {
                updateExpression += ", temporaryExpiresAt = :expiry";
                exprValues[":expiry"] = buildTemporaryExpiry(nowMs);
            }
            const out = await doc.send(new UpdateCommand({
                TableName: STATS_TABLE_NAME,
                Key: { playerName: ACCOUNTS_PARTITION_KEY, statKey: accountProfileKey(id) },
                UpdateExpression: updateExpression,
                ExpressionAttributeValues: exprValues,
                ReturnValues: "ALL_NEW",
            }));
            accountActivityDbAt.set(id, nowMs);
            const next = out.Attributes || { ...profile, lastSeen: now, lastActivityAt: now, updatedAt: now, lastActivityReason: String(reason || "touch").slice(0, 32) };
            if ((profile.accountType || ACCOUNT_TYPE_TEMPORARY) === ACCOUNT_TYPE_TEMPORARY) next.temporaryExpiresAt = buildTemporaryExpiry(nowMs);
            else delete next.temporaryExpiresAt;
            accountProfileCache.set(id, next);
            cb({ ok: true, account: accountPublicProfile(next) });
        } catch (e) {
            logAccountDbWarning(e);
            cb({ ok: false, code: "ACCOUNT_TOUCH_FAILED" });
        }
    });

    // ----------------------------------------------------------------
    // GLOBAL PAGE PRESENCE — นับผู้เล่นออนไลน์ตั้งแต่หน้า index แม้ยังไม่เข้าห้อง
    // ----------------------------------------------------------------
    socket.on("presence_hello", async ({ token, name, page, visible, roomId, isHost, accountId, accountToken } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        if (resetInProgress) return cb({ ok: false, code: "RESET_IN_PROGRESS" });
        if (socket.data.testerToken || socket.data.admin) return cb({ ok: false, code: "IGNORED" });
        const id = normalizeAccountId(accountId || "");
        const safeName = sanitizeName(name, "");
        if (!id || !accountToken) return cb({ ok: false, code: "BAD_IDENTITY" });
        try {
            // Presence heartbeat ไม่ถือเป็น activity: แค่เปิดแท็บค้างไว้จะไม่ต่ออายุ Temporary Account
            // ต้องมี action ที่ server ยืนยันจริง เช่น bootstrap / เข้า-กลับห้อง / เปลี่ยนชื่อ / จบเกม
            const verified = await verifyAccountLogin(id, accountToken);
            if (!verified.profile) return cb({ ok: false, code: "ACCOUNT_NOT_FOUND" });
            if (verified.ok === false) return cb({ ok: false, code: verified.code, account: accountPublicProfile(verified.profile) });
            const profile = verified.profile;
            const resolvedName = sanitizeName(profile.currentName || safeName, "ผู้เล่น");
            setAccountPresenceSocket(id, socket.id, { page, name: resolvedName, visible, roomId, isHost });
            cb({ ok: true, accountId: id, name: resolvedName, account: accountPublicProfile(profile) });
        } catch (e) {
            cb({ ok: false, code: "PRESENCE_FAILED" });
        }
    });
    socket.on("presence_ping", ({ visible, roomId, isHost } = {}) => {
        if (resetInProgress) return;
        updateAccountPresenceSocket(socket.id, { visible: visible !== false, roomId: roomId || "", isHost: !!isHost });
    });

    // ----------------------------------------------------------------
    // ADMIN — หน้า admin.html (ไม่มีลิงก์เชื่อมจากหน้าไหนเลย ต้องพิมพ์ URL เอง)
    // ใช้ดู "บัญชี" ที่กำลังเชื่อมต่ออยู่จริงในระบบ (ทุกห้อง) และแก้ชื่อจากจุดเดียวนี้แทน
    // (เดิมแก้ชื่อได้จากหน้าโฮสต์ — ย้ายมารวมไว้ที่นี่แทนทั้งหมด ดูคอมเมนต์ที่ลบไปด้านบน)
    // ----------------------------------------------------------------

    socket.on("admin_list_rooms", (cb) => {
        if (typeof cb !== "function") cb=()=>{};
        const list=Object.values(rooms).map((r)=>({roomId:r.id,isTester:!!r.isTesterRoom,started:!!r.started,gameOver:!!r.gameOver,hostName:r.players?.find(p=>p.isHost)?.name||"-",hostSlot:r.testerHostSlot||0,players:(r.players||[]).filter(p=>!p.isHost).length,totalPlayers:(r.players||[]).filter(p=>!p.isHost&&!p.isBot).length,bots:(r.players||[]).filter(p=>p.isBot).length,maxPlayers:r.maxPlayers||0,createdAt:r.createdAt||null}));
        list.sort((a,b)=>String(a.roomId).localeCompare(String(b.roomId)));
        cb({ok:true,rooms:list});
    });

    socket.on("admin_close_room", async ({roomId}={}, cb) => {
        if (typeof cb !== "function") cb=()=>{};
        const id=String(roomId||"").toUpperCase();
        if(!rooms[id]) return cb({error:"room_not_found",code:"ROOM_NOT_FOUND"});
        try { await closeRoomNow(id,"admin_closed"); cb({ok:true,roomId:id}); }
        catch(e){ recordDiagnostic({source:"server",kind:"admin_close_room_failed",page:"admin",message:e?.message||String(e),stack:e?.stack||""}); cb({error:e.message||"close_failed",code:"CLOSE_FAILED"}); }
    });

    // LIST ACCOUNTS — ทุกบัญชีที่ "หน้าเว็บยังอยู่เบื้องหน้า" ไม่จำกัดว่าต้องอยู่ในห้องเกม
    // และยังตัด tester/bot ออกเหมือนเดิม. หนึ่งบัญชีอาจมีหลาย session จึงแสดงตาม session ที่ออนไลน์จริง.
    socket.on("admin_list_accounts", async (cb) => {
        if (typeof cb !== "function") cb = () => {};
        // Online presence is an in-memory live signal. Do NOT make the admin's online list depend
        // on DynamoDB being readable: an IAM/DB problem must not turn a visibly-open index page
        // into "offline". Persistence is a separate concern.
        try {
            let profileMap = new Map();
            try {
                const profiles = await queryAllAccountProfiles();
                profiles.forEach((it) => {
                    const id = normalizeAccountId(it.accountId || String(it.statKey || "").replace(/^ACCOUNT#/, ""));
                    if (id) profileMap.set(id, it);
                });
            } catch (e) {
                recordDiagnostic({ source:"server", kind:"admin_presence_profile_read_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "" });
            }
            const accounts = [];
            for (const [accountId] of accountPresence) {
                const profile = profileMap.get(accountId);
                if (profile?.status === "deleted" || profile?.isTester === true) continue;
                const sessions = getVisibleAccountPresence(accountId);
                for (const session of sessions) {
                    accounts.push({
                        accountId,
                        roomId: session.roomId || "",
                        page: session.page,
                        name: session.name || profile?.currentName || "ผู้เล่น",
                        accountType: profile?.accountType || ACCOUNT_TYPE_TEMPORARY,
                        temporaryExpiresAt: profile?.temporaryExpiresAt || null,
                        isHost: !!session.isHost,
                        isTester: false,
                        connected: true,
                    });
                }
            }
            cb({ ok: true, accounts });
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_list_accounts_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "" });
            cb({ error: e.message || "account list failed", code: "ACCOUNT_LIST_FAILED" });
        }
    });

    // RENAME ACCOUNT — ใช้ accountId ไม่ต้องออนไลน์ และอัปเดตทุกห้อง/ทุกจอของบัญชีเดียวกัน
    socket.on("admin_rename_account", async ({ accountId, roomId, playerId, newName } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        try {
            let id = normalizeAccountId(accountId);
            if (!id && roomId && playerId) {
                const room = rooms[roomId];
                const p = room?.players?.find((x) => x.id === playerId);
                if (p && !p.isBot && !p.isTester) id = normalizeAccountId(p.accountId || "");
            }
            if (!id) return cb({ error: "account not found", code: "ACCOUNT_NOT_FOUND" });
            const result = await updateAccountName(id, newName);
            cb({ ok: true, name: result.name, accountId: id, changed: result.changed });
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_rename_account_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", data:e?.code || "" });
            cb({ error: e.code === "ACCOUNT_NOT_FOUND" ? "account not found" : (e.code === "ACCOUNT_DELETED" ? "account deleted" : (e.message || "rename failed")), code: e.code || "RENAME_FAILED" });
        }
    });

    // จัดการบัญชีจากหน้า "ผู้เล่นทั้งหมด" — wrapper ด้านบนบังคับ Admin session ก่อนถึง event นี้เสมอเมื่อมี password
    socket.on("admin_set_account_status", async ({ accountId, status } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        try {
            const next = await setAccountStatus(accountId, status);
            if (status === "suspended" || status === "deleted") {
                disconnectAccountSessions(accountId, status === "deleted" ? "account_deleted" : "account_suspended", status);
            }
            cb({ ok: true, accountId: normalizeAccountId(accountId), status: next.status });
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_status_update_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", data:e?.code || "" });
            cb({ error: e.message || "status update failed", code: e.code || "STATUS_FAILED" });
        }
    });

    socket.on("admin_reset_account_stats", async ({ accountId } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        try {
            const result = await resetAccountStats(accountId);
            cb(result);
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_reset_stats_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", data:e?.code || "" });
            cb({ error: e.message || "reset stats failed", code: e.code || "RESET_STATS_FAILED" });
        }
    });

    socket.on("admin_kick_account", ({ accountId } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        const count = disconnectAccountSessions(accountId, "account_kicked", "admin_kick");
        cb({ ok: true, disconnected: count });
    });

    // Legacy player management — ข้อมูลก่อนระบบ accountId ยังแก้/ลบได้จากหน้า "ผู้เล่นทั้งหมด"
    // โดยย้าย/ลบทั้ง partition ตามชื่ออย่างปลอดภัยและห้าม merge กับข้อมูลชื่อใหม่ที่มีอยู่แล้ว
    socket.on("admin_rename_legacy_player", async ({ name, newName } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        try {
            const result = await renameLegacyPlayer(name, newName);
            cb({ ok: true, ...result });
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_legacy_rename_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", data:e?.code || "" });
            cb({ error: e.message || "legacy rename failed", code: e.code || "LEGACY_RENAME_FAILED" });
        }
    });

    socket.on("admin_migrate_legacy_player", async ({ name, accountId } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        try {
            const result = await migrateLegacyPlayerToAccount(name, accountId);
            cb(result);
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_legacy_migrate_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", data:e?.code || "" });
            cb({ error: e.message || "legacy migration failed", code: e.code || "LEGACY_MIGRATE_FAILED" });
        }
    });

    socket.on("admin_delete_legacy_player", async ({ name } = {}, cb) => {
        if (typeof cb !== "function") cb = () => {};
        try {
            const result = await deleteLegacyPlayer(name);
            cb({ ok: true, ...result });
        } catch (e) {
            recordDiagnostic({ source:"server", kind:"admin_legacy_delete_failed", page:"admin", message:e?.message || String(e), stack:e?.stack || "", data:e?.code || "" });
            cb({ error: e.message || "legacy delete failed", code: e.code || "LEGACY_DELETE_FAILED" });
        }
    });

    // รายละเอียดบัญชีเดียว: โปรไฟล์ + สถิติ + ประวัติ + session ออนไลน์
    // ----------------------------------------------------------------
    // ADD BOT (โหมดผู้ทดสอบ) — เพิ่มผู้เล่นปลอมเข้าห้องเพื่อให้แจกบทได้ครบตามจำนวน
    // บอทเป็น "ผู้เล่นจริง" ในสายตา server ทุกจุด (นับใน realPlayers, รับบทได้ปกติ)
    // เพียงแต่ยังไม่มี socket จริงผูกอยู่จนกว่าโฮสต์จะกด "เข้าสิง" (ดู client: ป๊อปอัป
    // iframe ของ player.html ที่ join_room ด้วย token ของบอทนี้ → กลายเป็น reconnect ปกติ
    // ทุกอย่างจึงใช้ path เดิมของผู้เล่นจริงหมด ไม่ต้องเขียน proxy การกระทำแยกเลย)
    // ----------------------------------------------------------------
    socket.on("host_add_bot", (roomId, cb) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return cb && cb({ error: "not host" });

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

        io.to(roomId).emit("room_update", publicRoomView(room));
        cb && cb({ ok: true, id: bot.id, token: bot.token, name: bot.name });
    });

    // ----------------------------------------------------------------
    // TOGGLE BOT AI (เฟส 4 — bot-autonomous-ai-phases.md)
    // ควบคุมการเล่นอัตโนมัติของบอทจากฝั่งโฮสต์ 2 ระดับ:
    //   - ระบุ botId → คุมเฉพาะบอทตัวนั้น เขียนลง room.botAI.perBot[botId]
    //     (false = ปิด AI ให้บอทตัวนี้เฉยๆ แม้ไม่มีคนเข้าสิงก็จะไม่ทำ action เอง)
    //   - ไม่ระบุ botId (undefined/null) → master switch ทั้งห้อง เขียนลง room.botAI.enabled
    // botEngine.js (botEligibleNow) อ่านค่าทั้งสอง field นี้อยู่แล้วตั้งแต่เฟส 2-3 จึงมีผลทันที
    // ตั้งแต่ action ถัดไปที่ยังไม่ได้ตั้ง timer — ไม่ต้อง restart อะไรเพิ่ม
    // ----------------------------------------------------------------
    socket.on("toggle_bot_ai", ({ roomId, botId, enabled } = {}) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;
        if (!room.botAI) room.botAI = { enabled: true, perBot: {}, llmBots: {} };

        if (botId) {
            const bot = room.players.find((p) => p.id === botId && p.isBot);
            if (!bot) return;
            if (!room.botAI.perBot) room.botAI.perBot = {};
            room.botAI.perBot[botId] = !!enabled;
        } else {
            room.botAI.enabled = !!enabled;
        }

        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // TOGGLE BOT LLM MODE (เฟส 5 / "แนวทาง B" — bot-autonomous-ai-approach-b-technical.md)
    // เปิด/ปิดให้บอทตัวหนึ่งใช้ Claude ตัดสินใจแทนสุ่ม — ต้องเปิด "เล่นเองอัตโนมัติ" (toggle_bot_ai)
    // ไว้ด้วยถึงจะมีผล เพราะ botEligibleNow() เช็ค room.botAI.enabled/perBot ก่อนเรียก botEngine.js
    // เสมออยู่แล้ว ไม่ว่าจะเป็นเส้นทางสุ่มหรือ LLM (llmBots เป็นแค่ "จะเลือกยังไง" ไม่ใช่ "จะเลือกไหม")
    // ปิดเป็นค่าเริ่มต้นเสมอ (room.botAI.llmBots ว่างตอนสร้างห้อง) — ไม่กระทบห้องที่ไม่เคยเปิดใช้เลย
    // ----------------------------------------------------------------
    socket.on("toggle_bot_llm_mode", ({ roomId, botId, enabled } = {}) => {
        const room = rooms[roomId];
        if (!room || !isHostSocket(room, socket.id)) return;
        if (!botId) return; // ไม่มี master switch สำหรับโหมดนี้ (ต่างจาก toggle_bot_ai) — ต้องระบุบอททีละตัวเสมอ

        const bot = room.players.find((p) => p.id === botId && p.isBot);
        if (!bot) return;

        if (!room.botAI) room.botAI = { enabled: true, perBot: {}, llmBots: {} };
        if (!room.botAI.llmBots) room.botAI.llmBots = {};
        room.botAI.llmBots[botId] = !!enabled;

        io.to(roomId).emit("room_update", publicRoomView(room));
    });

    // ----------------------------------------------------------------
    // RELEASE BOT — โฮสต์กด "กลับหน้าโฮสต์" จากในจอที่กำลังสิงบอทอยู่ เพื่อคืนสถานะให้บอท
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
        io.to(roomId).emit("room_update", publicRoomView(room));
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
            io.to(roomId).emit("room_update", publicRoomView(room));
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

        const player = room.players.find((p) => p.id === socket.id && p.token === token);
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

        room.players = room.players.filter((p) => p.id !== player.id);

        if (room.players.length === 0) {
            if (ROOM_PERSISTENCE_ENABLED) { try { await deletePersistedRoom(roomId); } catch (e) { console.error(`[room-persist] ลบ snapshot ห้อง ${roomId} ไม่สำเร็จ:`, e.name, e.message); } }
            delete rooms[roomId];
            clearGameOverTimer(roomId);
            clearVoteTimer(roomId);
        } else {
            renumberBots(room);
            io.to(roomId).emit("room_update", publicRoomView(room));
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
    socket.on("restart_room", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!isHostSocket(room, socket.id)) return;

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
        io.to(roomId).emit("room_update", publicRoomView(room));
        room.justReset = false; // ล้างทันทีหลังส่ง ไม่ให้ room_update รอบถัดไปเคลียร์กล่องแชทซ้ำ

        broadcastSuggestedRoom();
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
        removeAccountPresenceSocket(socket.id);
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
                const hostPlayer = room.players.find((p) => p.isHost);
                if (hostPlayer && !stillHasHostScreen) {
                    hostPlayer.disconnected = true;
                }
                io.to(hostRoomId).emit("room_update", publicRoomView(room));
                schedulePersistRoom(hostRoomId);
            }
            broadcastSuggestedRoom();
        }

        for (const id in rooms) {
            const room = rooms[id];
            const player = room.players.find((p) => p.id === socket.id);
            if (!player || player.isHost) continue; // โฮสต์ถูกจัดการไปแล้วด้านบน
            rememberSocketDisconnect('player', id, player.token, socket.id);

            // Tester player เป็น session ชั่วคราว: ถ้ายังไม่เริ่มเกมและแท็บถูกปิดจริง ให้เอาออกจากห้องทันที
            // เพื่อคืนเลข Player ที่ว่าง ไม่ปล่อยชื่อ 1/2/3 ค้างเพราะ RECONNECT_GRACE ของผู้เล่นปกติ
            if (player.isTester && !player.isBot && !room.started) {
                if (pendingRemovals[player.token]) { clearTimeout(pendingRemovals[player.token].timer); delete pendingRemovals[player.token]; }
                if (pendingIndicators[player.token]) { clearTimeout(pendingIndicators[player.token]); delete pendingIndicators[player.token]; }
                room.players = room.players.filter((p) => p.id !== player.id);
                io.to(id).emit("room_update", publicRoomView(room));
                if (room.players.length > 0) schedulePersistRoom(id, true);
                if (room.players.length === 0 && room.isTesterRoom) {
                    if (ROOM_PERSISTENCE_ENABLED) { try { await deletePersistedRoom(id); } catch (e) { logAccountDbWarning(e); } }
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

            // นับเวลาเริ่ม "ออฟไลน์" ตั้งแต่วินาทีที่ socket หลุดจริง (ไม่รอดีเลย์ของสถานะ UI
            // ด้านล่าง) เฉพาะตอนเกมกำลังเล่นอยู่เท่านั้น (ก่อนเริ่ม/หลังจบเกมไม่เกี่ยวกับการ
            // ตัดสิน "ออกเกม" ของตานี้ — ดู didLeaveGame/recordGameStats ด้านบน)
            if (room.started && !room.gameOver) {
                markPlayerOfflineStart(player);
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
                io.to(id).emit("room_update", publicRoomView(stillRoom));
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
                    io.to(id).emit("room_update", publicRoomView(stillRoom));
                    broadcastSuggestedRoom();
                }, RECONNECT_GRACE_MS),
            };
        }

        broadcastSuggestedRoom();
    });
});

// ============================================================
// HTTP_ERROR_MIDDLEWARE_V14: จับ exception ที่หลุดจาก Express route ให้มี trace/request/location ก่อนตอบ 500
app.use(function HTTP_ERROR_MIDDLEWARE_V14(err, req, res, next) {
    const ctx = req.__wwDiagnostic || {};
    recordDiagnostic({
        source:"server", kind:"http_handler_error", page:"server",
        message:err?.message || String(err), stack:err?.stack || "",
        endpoint:req.path, status:500,
        traceId:ctx.traceId, sessionId:ctx.sessionId, action:ctx.action,
        requestId:ctx.requestId, clientRequestId:ctx.clientRequestId,
        durationMs:Date.now() - Number(ctx.startedAt || Date.now()),
        context:{ method:req.method, endpoint:req.path, requestId:ctx.requestId },
    });
    if (res.headersSent) return next(err);
    res.status(500).json({ error:"internal_server_error", requestId:ctx.requestId || "" });
});



const HTTP_PORT = Number(process.env.PORT) || 3000;
const SHUTDOWN_GRACE_MS = Math.max(5000, Number(process.env.SHUTDOWN_GRACE_MS) || 20000);
let shutdownStarted = false;

function gracefulShutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    appDraining = true;
    console.log(`[shutdown] ${signal} received — draining HTTP/WebSocket connections`);

    const forceExit = setTimeout(() => {
        console.error(`[shutdown] grace period ${SHUTDOWN_GRACE_MS}ms exceeded — forcing exit`);
        process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref?.();

    try { io.close(); } catch (e) { console.error("[shutdown] Socket.IO close failed:", e?.message || e); }
    server.close((err) => {
        clearTimeout(forceExit);
        if (err) {
            console.error("[shutdown] HTTP server close failed:", err.message || err);
            process.exit(1);
            return;
        }
        console.log("[shutdown] HTTP/WebSocket drain complete");
        process.exit(0);
    });
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
