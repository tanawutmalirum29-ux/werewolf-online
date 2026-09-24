(function () {
    "use strict";

    // ========================================================================
    // WEREWOLF DIAGNOSTICS v16
    // - ผู้เล่นเห็น Error แบบเดิม: สั้น กระชับ ไม่ทำให้เกมหยุด
    // - Admin copy จะได้ Full Diagnostic Report: trace/session, breadcrumb,
    //   request, socket event, state และ stack โดยอัตโนมัติ
    // - ห้ามเก็บ query/hash เพราะอาจมี token/session ของโหมดทดสอบ
    // ========================================================================
    if (window.__WW_ERROR_REPORTER__) return;
    window.__WW_ERROR_REPORTER__ = true;

    var PAGE = (document.body && document.body.dataset && document.body.dataset.page) ||
        (location.pathname.match(/\/([^/]+?)(?:\.html)?$/) || [])[1] ||
        (location.pathname === "/" ? "index" : "unknown");
    if (PAGE === "index.html") PAGE = "index";

    var sent = 0;
    var WINDOW_MS = 60 * 1000;
    var MAX_PER_WINDOW = 12;
    var windowStart = Date.now();
    var MAX_BREADCRUMBS = 80;
    var TRACE_TTL_MS = 15 * 1000;
    var breadcrumbs = [];
    var activeTrace = null;
    var lastRoomId = "";
    var socketIoInstalled = false;
    var diagnosticOperations = {};
    var DIAG_SOCKET_ACK_TIMEOUT_MS = 15000;
    var diagnosticSeq = 0;

    function safeString(v, max) {
        if (v === null || v === undefined) return "";
        var s;
        try { s = typeof v === "string" ? v : JSON.stringify(v); }
        catch (_) { s = String(v); }
        return String(s).slice(0, max || 4000);
    }

    function sanitizePath(v) {
        var s = String(v || "");
        try {
            if (/^https?:\/\//i.test(s)) {
                var u = new URL(s);
                return u.origin + u.pathname;
            }
        } catch (_) {}
        return s.split(/[?#]/)[0].slice(0, 500);
    }

    function makeId(prefix) {
        var base = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        return (prefix || "id") + "-" + base;
    }

    function getSessionId() {
        var key = "ww_diag_session_id";
        try {
            var existing = sessionStorage.getItem(key);
            if (existing) return existing;
            var id = makeId("ses");
            sessionStorage.setItem(key, id);
            return id;
        } catch (_) {
            return makeId("ses");
        }
    }
    var sessionId = getSessionId();

    function allowedToSend() {
        var now = Date.now();
        if (now - windowStart >= WINDOW_MS) {
            windowStart = now;
            sent = 0;
        }
        if (sent >= MAX_PER_WINDOW) return false;
        sent++;
        return true;
    }

    function compactDetail(value) {
        if (value === null || value === undefined) return "";
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).slice(0, 300);
        if (Array.isArray(value)) return value.slice(0, 12).map(compactDetail);
        var out = {};
        Object.keys(value).slice(0, 20).forEach(function (k) {
            if (/token|secret|password|authorization|cookie|session/i.test(k)) return;
            out[String(k).slice(0, 60)] = compactDetail(value[k]);
        });
        return out;
    }

    function pushBreadcrumb(type, label, detail, traceId) {
        var item = {
            time: new Date().toISOString(),
            type: String(type || "event").slice(0, 32),
            label: String(label || "").slice(0, 120),
            traceId: String(traceId || (activeTrace && activeTrace.id) || "").slice(0, 120),
            detail: compactDetail(detail || {})
        };
        breadcrumbs.push(item);
        if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.splice(0, breadcrumbs.length - MAX_BREADCRUMBS);
        return item;
    }

    function beginTrace(action, detail) {
        activeTrace = { id: makeId("tr"), action: String(action || "user_action").slice(0, 100), startedAt: Date.now() };
        pushBreadcrumb("action", activeTrace.action, detail || {}, activeTrace.id);
        return activeTrace.id;
    }

    function currentTraceId(forceNew) {
        var now = Date.now();
        if (!forceNew && activeTrace && now - activeTrace.startedAt <= TRACE_TTL_MS) return activeTrace.id;
        return beginTrace("background_request");
    }

    function getSafeClientMode() {
        var q = {};
        try {
            var p = new URLSearchParams(location.search || "");
            q.tester = p.get("tester") === "1";
            q.botControlled = q.tester && !!p.get("jr") && !!p.get("t");
            q.hasJoinRequest = !!p.get("jr");
            q.hasTesterPass = !!p.get("tp");
            q.hasLaunchId = !!p.get("ts");
            q.hasAdminController = !!p.get("ac");
        } catch (_) {}
        return q;
    }
    function getStoragePresence() {
        var keys = ["ww_joinedRoom","ww_lastRoom","ww_host_room","ww_token","ww_bot_tokens","ww_account_id","ww_account_token","ww_account_type","ww_account_recreate_required"];
        var out = {};
        try { keys.forEach(function(k){ out[k] = { local: localStorage.getItem(k) != null, session: sessionStorage.getItem(k) != null }; }); } catch (_) {}
        return out;
    }
    function getState() {
        var state = {
            online: !!navigator.onLine,
            visibility: document.visibilityState,
            readyState: document.readyState,
            href: (location.origin || "") + (location.pathname || ""),
            page: PAGE,
            screen: { width: window.innerWidth || 0, height: window.innerHeight || 0, dpr: window.devicePixelRatio || 1 },
            language: navigator.language || "",
            userAgent: String(navigator.userAgent || "").slice(0, 600),
            pagehide: !!window.__WW_DIAG_PAGEHIDE__,
            mode: getSafeClientMode(),
            storagePresence: getStoragePresence(),
            activeTrace: activeTrace ? { id: activeTrace.id, action: activeTrace.action, ageMs: Date.now() - activeTrace.startedAt } : null,
            pendingOperations: Object.keys(diagnosticOperations).slice(0, 20)
        };
        try { state.socket = !!(window.WW_DIAG_SOCKET_CONNECTED || false); } catch (_) {}
        return state;
    }

    function send(payload) {
        if (!allowedToSend()) return;
        var body;
        try {
            var safePayload = Object.assign({}, payload);
            safePayload.breadcrumbs = Array.isArray(payload.breadcrumbs) ? payload.breadcrumbs.slice(-40) : [];
            if (safePayload.state && safePayload.state.userAgent) safePayload.state = Object.assign({}, safePayload.state, { userAgent: String(safePayload.state.userAgent).slice(0, 320) });
            body = JSON.stringify(safePayload);
            if (body.length > 18000) {
                safePayload.breadcrumbs = safePayload.breadcrumbs.slice(-24);
                if (safePayload.stack) safePayload.stack = String(safePayload.stack).slice(0, 5000);
                body = JSON.stringify(safePayload);
            }
            if (body.length > 22000) {
                safePayload.breadcrumbs = safePayload.breadcrumbs.slice(-10);
                safePayload.context = compactDetail(safePayload.context || {});
                body = JSON.stringify(safePayload);
            }
        } catch (_) { return; }

        try {
            if (navigator.sendBeacon) {
                var blob = new Blob([body], { type: "application/json" });
                if (navigator.sendBeacon("/api/diagnostics/client-error", blob)) return;
            }
        } catch (_) {}

        try {
            window.fetch("/api/diagnostics/client-error", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: body,
                keepalive: true,
                cache: "no-store",
                credentials: "same-origin"
            }).catch(function () {});
        } catch (_) {}
    }

    function makeFingerprint(parts) {
        var raw = Array.isArray(parts) ? parts.filter(function(x){ return x !== null && x !== undefined; }).map(String).join("|") : String(parts || "");
        var h = 2166136261;
        for (var i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(16).padStart(8, "0");
    }
    function inferClientFailureStage(kind) {
        if (/socket_ack|socket_emit/.test(kind)) return "socket.client";
        if (/http|fetch|network/.test(kind)) return "browser.transport";
        if (/resource|javascript|unhandled/.test(kind)) return "browser.runtime";
        return "unknown";
    }
    function inferClientCauseCode(kind, detail) {
        var c = detail && detail.context && (detail.context.ackCode || detail.context.code || detail.context.errorCode);
        if (c) return String(c);
        if (kind === "socket_ack_timeout") return "ACK_TIMEOUT";
        if (kind === "socket_ack_error") return "SOCKET_ACK_ERROR";
        if (kind === "socket_emit_error") return "SOCKET_EMIT_ERROR";
        if (kind === "http_error") return "HTTP_" + String(detail && detail.status || "ERROR");
        if (kind === "network_error") return "NETWORK_ERROR";
        if (kind === "fetch_aborted") return "FETCH_ABORTED";
        return "UNCLASSIFIED";
    }
    function recentSocketAckEvidence(traceId) {
        var now=Date.now();
        for (var i=breadcrumbs.length-1;i>=0;i--) {
            var b=breadcrumbs[i];
            if (b.type !== "socket" || String(b.label||"").indexOf("ack:") !== 0) continue;
            if (traceId && b.traceId && b.traceId !== traceId) continue;
            var t=Date.parse(b.time||"");
            if (!t || now-t > 30000) continue;
            var d=b.detail||{};
            return { eventName:String(String(b.label).slice(4)), ok:d.ok===true, ackCode:String(d.ackCode||""), ack:compactDetail(d.ack||{}), operationId:String(d.operationId||""), elapsedMs:Number(d.elapsedMs||0)||0 };
        }
        return null;
    }

    function nextOperationId() {
        diagnosticSeq += 1;
        return "op-" + Date.now().toString(36) + "-" + diagnosticSeq.toString(36);
    }

    function report(kind, detail) {
        detail = detail || {};
        var traceId = String(detail.traceId || currentTraceId(false)).slice(0, 120);
        if (detail.breadcrumbs !== false) pushBreadcrumb("error", kind, { message: detail.message || "" }, traceId);
        send({
            source: "client",
            kind: String(kind || "error").slice(0, 48),
            page: String(PAGE || "unknown").slice(0, 48),
            path: sanitizePath(location.pathname || "").slice(0, 180),
            time: new Date().toISOString(),
            traceId: traceId,
            sessionId: sessionId,
            action: String(detail.action || (activeTrace && activeTrace.action) || "").slice(0, 120),
            requestId: String(detail.requestId || "").slice(0, 120),
            message: safeString(detail.message, 4000),
            stack: safeString(detail.stack, 10000),
            file: sanitizePath(detail.file || "").slice(0, 500),
            line: Number(detail.line || 0) || 0,
            column: Number(detail.column || 0) || 0,
            status: Number(detail.status || 0) || 0,
            endpoint: sanitizePath(detail.endpoint || "").slice(0, 500),
            roomId: String(detail.roomId || extractRoomId()).slice(0, 32),
            operationId: String(detail.operationId || "").slice(0, 120),
            context: compactDetail(detail.context || detail.data || {}),
            state: getState(),
            breadcrumbs: breadcrumbs.slice(-MAX_BREADCRUMBS),
            causalHint: {
                failureStage: String(detail.failureStage || inferClientFailureStage(kind)).slice(0, 80),
                causeCode: String(detail.causeCode || inferClientCauseCode(kind, detail)).slice(0, 100),
                confidence: String(detail.causeConfidence || "medium").slice(0, 20)
            },
            fingerprint: makeFingerprint([kind, detail.message, detail.endpoint, detail.status, detail.context && (detail.context.eventName || detail.context.code || detail.context.ackCode)])
        });
    }

    function extractRoomId() {
        if (lastRoomId) return lastRoomId;
        try {
            var keys = ["ww_host_room", "ww_joinedRoom", "ww_lastRoom"];
            for (var i = 0; i < keys.length; i++) {
                var val = localStorage.getItem(keys[i]) || sessionStorage.getItem(keys[i]);
                if (val && /^[A-Za-z0-9]{3,12}$/.test(val)) return val.toUpperCase();
            }
        } catch (_) {}
        return "";
    }

    function actionFromElement(el) {
        if (!el) return "";
        var explicit = el.getAttribute && el.getAttribute("data-diagnostic-action");
        if (explicit) return explicit;
        var id = el.id ? String(el.id) : "";
        var text = String(el.getAttribute && (el.getAttribute("aria-label") || el.title) || el.innerText || el.textContent || "")
            .replace(/\s+/g, " ").trim().slice(0, 80);
        if (id && /create|room|start|join|leave|kick|close|restart|reload|reset|bot|vote|save|delete|rename|login|submit/i.test(id)) return id;
        if (text && el.tagName && /^(BUTTON|A)$/i.test(el.tagName)) return text;
        return "";
    }

    document.addEventListener("click", function (event) {
        try {
            var el = event.target && event.target.closest ? event.target.closest("button,a,[role='button']") : event.target;
            var action = actionFromElement(el);
            if (!action) return;
            beginTrace(action, {
                element: el && el.tagName,
                id: el && el.id || "",
                text: String(el && (el.innerText || el.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 100)
            });
        } catch (_) {}
    }, true);
    document.addEventListener("submit", function (event) {
        try {
            var form = event.target;
            beginTrace("submit:" + String(form && (form.id || form.name || form.action) || "form").slice(0, 100));
        } catch (_) {}
    }, true);
    document.addEventListener("visibilitychange", function () {
        pushBreadcrumb("lifecycle", "visibility:" + document.visibilityState, {}, currentTraceId(false));
    });
    window.addEventListener("pagehide", function () {
        window.__WW_DIAG_PAGEHIDE__ = true;
        pushBreadcrumb("lifecycle", "pagehide", {}, currentTraceId(false));
    });
    window.addEventListener("online", function () { pushBreadcrumb("network", "online", {}, currentTraceId(false)); });
    window.addEventListener("offline", function () { pushBreadcrumb("network", "offline", {}, currentTraceId(false)); });

    window.addEventListener("error", function (event) {
        var target = event && event.target;
        var isResource = target && target !== window && (target.src || target.href);
        report(isResource ? "resource_error" : "javascript_error", {
            message: event && event.message || (isResource ? "Resource failed to load" : "Unknown JavaScript error"),
            stack: event && event.error && event.error.stack || "",
            file: event && event.filename || (target && (target.src || target.href)) || "",
            line: event && event.lineno,
            column: event && event.colno,
            action: activeTrace && activeTrace.action
        });
    }, true);

    window.addEventListener("unhandledrejection", function (event) {
        var reason = event && event.reason;
        var traceId=currentTraceId(false);
        var evidence=recentSocketAckEvidence(traceId) || recentSocketAckEvidence("");
        report("unhandled_rejection", {
            message: reason && reason.message || safeString(reason, 4000),
            stack: reason && reason.stack || "",
            traceId:traceId,
            operationId:String((reason&& (reason.operationId||reason.opId)) || (evidence&&evidence.operationId) || ""),
            causeCode:String((reason&& (reason.code||reason.sourceCode)) || (evidence&&evidence.ackCode) || "UNCLASSIFIED"),
            causeConfidence:(reason&& (reason.code||reason.sourceCode)) || evidence ? "high" : "medium",
            failureStage:evidence ? "socket.server_response" : "browser.runtime",
            context:{
                errorName:String(reason&&reason.name||""),
                promiseCode:String(reason&&reason.code||""),
                promiseSourceCode:String(reason&&reason.sourceCode||""),
                lastSocketAck:evidence,
                pageLifecycle:{visibility:document.visibilityState,pagehide:!!window.__WW_DIAG_PAGEHIDE__}
            }
        });
    });

    function sanitizeNavigationTarget(v) { try { var u=new URL(String(v||""),location.href); return u.origin+u.pathname; } catch (_) { return sanitizePath(v); } }
    try {
        var rawWindowOpen=window.open;
        if(typeof rawWindowOpen==="function") window.open=function(){
            var url=arguments[0]||"", target=arguments[1]||"", traceId=currentTraceId(false), before=Date.now();
            pushBreadcrumb("navigation","window.open.start",{targetUrl:sanitizeNavigationTarget(url),targetName:String(target||"").slice(0,80)},traceId);
            try { var opened=rawWindowOpen.apply(this,arguments); pushBreadcrumb("navigation","window.open.result",{targetUrl:sanitizeNavigationTarget(url),targetName:String(target||"").slice(0,80),returned:!!opened,elapsedMs:Date.now()-before},traceId); return opened; }
            catch(e){ report("window_open_error",{message:e.message||String(e),stack:e.stack||"",traceId:traceId,failureStage:"browser.navigation",causeCode:"WINDOW_OPEN_ERROR",causeConfidence:"high",context:{targetUrl:sanitizeNavigationTarget(url),targetName:String(target||"").slice(0,80)}}); throw e; }
        };
    } catch (_) {}
    try {
        ["pushState","replaceState"].forEach(function(name){ var raw=history[name]; if(typeof raw!=="function")return; history[name]=function(){ pushBreadcrumb("navigation","history."+name,{targetUrl:sanitizeNavigationTarget(arguments[2]||"")},currentTraceId(false)); return raw.apply(this,arguments); }; });
        window.addEventListener("popstate",function(){pushBreadcrumb("navigation","popstate",{},currentTraceId(false));});
        window.addEventListener("beforeunload",function(){pushBreadcrumb("lifecycle","beforeunload",{},currentTraceId(false));});
    } catch (_) {}

    function makeRequestId(prefix) { return makeId(prefix || "req"); }

    function requestContext(endpoint, requestId, startedAt, extra) {
        var data = {
            requestId: requestId || "",
            endpoint: sanitizePath(endpoint || ""),
            durationMs: Math.max(0, Date.now() - startedAt),
            online: navigator.onLine,
            visibility: document.visibilityState,
            readyState: document.readyState,
            href: (location.origin || "") + (location.pathname || "")
        };
        if (extra) for (var k in extra) data[k] = compactDetail(extra[k]);
        return data;
    }

    try {
        var originalFetch = window.fetch;
        if (typeof originalFetch === "function") {
            window.fetch = function () {
                var rawArgs = Array.prototype.slice.call(arguments);
                var endpoint = "";
                var method = "GET";
                try {
                    endpoint = typeof rawArgs[0] === "string" ? rawArgs[0] : (rawArgs[0] && rawArgs[0].url) || "";
                    method = (rawArgs[1] && rawArgs[1].method) || (rawArgs[0] && rawArgs[0].method) || "GET";
                } catch (_) {}
                if (sanitizePath(endpoint).indexOf("/api/diagnostics/") !== -1) return originalFetch.apply(this, rawArgs);

                var traceId = currentTraceId(false);
                var requestId = makeRequestId(sanitizePath(endpoint).indexOf("/api/config") !== -1 ? "cfg" : "req");
                var startedAt = Date.now();
                var fetchThis = this;
                pushBreadcrumb("http", "request.start", { method: method, endpoint: sanitizePath(endpoint), requestId: requestId }, traceId);
                try {
                    var init = rawArgs[1] || {};
                    var headers = new Headers(init.headers || (rawArgs[0] && rawArgs[0].headers) || undefined);
                    headers.set("X-WW-Diagnostic-Trace-Id", traceId);
                    headers.set("X-WW-Client-Session-Id", sessionId);
                    headers.set("X-WW-Client-Request-Id", requestId);
                    headers.set("X-WW-Diagnostic-Action", String((activeTrace && activeTrace.action) || "").slice(0, 120));
                    rawArgs[1] = Object.assign({}, init, { headers: headers });
                } catch (_) {}

                return originalFetch.apply(this, rawArgs).then(function (res) {
                    var responseTraceId = "";
                    var responseRequestId = "";
                    var serverClientRequestId = "";
                    var serverInstance = "";
                    try {
                        responseTraceId = res.headers.get("X-WW-Diagnostic-Trace-Id") || "";
                        responseRequestId = res.headers.get("X-WW-Config-Request-Id") || "";
                        serverClientRequestId = res.headers.get("X-WW-Client-Request-Id") || "";
                        serverInstance = res.headers.get("X-WW-Server-Instance") || "";
                    } catch (_) {}
                    pushBreadcrumb("http", "request.response", { method: method, endpoint: sanitizePath(endpoint), status: res.status, durationMs: Date.now() - startedAt, requestId: responseRequestId || requestId, serverInstance: serverInstance }, responseTraceId || traceId);
                    if (!res.ok) {
                        try {
                            res.clone().text().then(function(bodyText){
                                var trimmed=String(bodyText||"").slice(0,2500);
                                var parsed=null; try{ parsed=trimmed?JSON.parse(trimmed):null; }catch(_){}
                                pushBreadcrumb("http", "request.response.body", { status:res.status, endpoint:sanitizePath(endpoint), requestId:responseRequestId||requestId, responseCode:parsed&&parsed.code||"", responseError:parsed&&parsed.error||"", body:parsed?compactDetail(parsed):trimmed }, responseTraceId||traceId);
                            }).catch(function(){});
                        } catch (_) {}
                        report("http_error", {
                            message: "HTTP " + res.status,
                            status: res.status,
                            endpoint: endpoint,
                            traceId: responseTraceId || traceId,
                            requestId: responseRequestId || requestId,
                            action: activeTrace && activeTrace.action,
                            roomId: extractRoomId(),
                            context: requestContext(endpoint, requestId, startedAt, {
                                method: method,
                                serverRequestId: responseRequestId,
                                serverClientRequestId: serverClientRequestId,
                                serverTraceId: responseTraceId,
                                serverInstance: serverInstance
                            })
                        });
                    }
                    return res;
                }, function (err) {
                    var cleanEndpoint = sanitizePath(endpoint);
                    var isConfigGet = cleanEndpoint === "/api/config" && String(method || "GET").toUpperCase() === "GET";
                    var isAbort = !!(err && err.name === "AbortError");

                    // Background config requests can be torn down by page navigation/lifecycle.
                    // iPad/iOS Chromium may surface that teardown as TypeError("Load failed") instead of
                    // AbortError. Treat both forms as lifecycle noise when the page is already hidden or
                    // has fired pagehide; visible-page failures still go through the normal retry/report path.
                    var isPageLifecycleTeardown = isConfigGet && (document.visibilityState === "hidden" || window.__WW_DIAG_PAGEHIDE__);
                    if (isPageLifecycleTeardown) {
                        pushBreadcrumb("http", "request.ignored", { method: method, endpoint: cleanEndpoint, reason: isAbort ? "navigation_or_pagehide_abort" : "navigation_or_pagehide_network_error", errorName: err && err.name || "", message: err && err.message || "" }, traceId);
                        throw err;
                    }

                    // /api/config is tiny, idempotent and requested in the background. Safari/iPad/
                    // Chromium can surface a transient TypeError("Load failed") when navigation/lifecycle
                    // changes race the fetch, even when the origin has already completed the request.
                    // Retry once before creating an Admin diagnostic. This prevents false positives while
                    // still reporting a real failure when the retry also fails.
                    if (isConfigGet && !isAbort && navigator.onLine !== false) {
                        pushBreadcrumb("http", "request.retry.start", { method: method, endpoint: cleanEndpoint, reason: err && err.message || "network request failed" }, traceId);
                        try {
                            var retryInit = Object.assign({}, rawArgs[1] || {});
                            var retryHeaders = new Headers(retryInit.headers || {});
                            var retryRequestId = makeRequestId("cfg-retry");
                            retryHeaders.set("X-WW-Diagnostic-Trace-Id", traceId);
                            retryHeaders.set("X-WW-Client-Session-Id", sessionId);
                            retryHeaders.set("X-WW-Client-Request-Id", retryRequestId);
                            retryHeaders.set("X-WW-Diagnostic-Action", String((activeTrace && activeTrace.action) || "").slice(0, 120));
                            retryInit.headers = retryHeaders;
                            return originalFetch.apply(fetchThis, [rawArgs[0], retryInit]).then(function (retryRes) {
                                var retryTraceId = "";
                                var retryResponseRequestId = "";
                                try {
                                    retryTraceId = retryRes.headers.get("X-WW-Diagnostic-Trace-Id") || "";
                                    retryResponseRequestId = retryRes.headers.get("X-WW-Config-Request-Id") || "";
                                } catch (_) {}
                                pushBreadcrumb("http", "request.retry.response", { method: method, endpoint: cleanEndpoint, status: retryRes.status, requestId: retryResponseRequestId || retryRequestId }, retryTraceId || traceId);
                                if (!retryRes.ok) {
                                    report("http_error", {
                                        message: "HTTP " + retryRes.status + " after config retry",
                                        status: retryRes.status,
                                        endpoint: endpoint,
                                        traceId: retryTraceId || traceId,
                                        requestId: retryResponseRequestId || retryRequestId,
                                        action: activeTrace && activeTrace.action,
                                        roomId: extractRoomId(),
                                        context: requestContext(endpoint, retryRequestId, startedAt, {
                                            method: method,
                                            initialErrorName: err && err.name || "",
                                            initialErrorMessage: err && err.message || "",
                                            configRetry: true
                                        })
                                    });
                                }
                                // The retry succeeded (or returned a real HTTP response), so the caller
                                // receives the usable response and we do not emit a fake network_error.
                                return retryRes;
                            }, function (retryErr) {
                                pushBreadcrumb("http", "request.retry.failed", { method: method, endpoint: cleanEndpoint, errorName: retryErr && retryErr.name || "", message: retryErr && retryErr.message || "" }, traceId);
                                var retryKind = retryErr && retryErr.name === "AbortError" ? "fetch_aborted" : "network_error";
                                report(retryKind, {
                                    message: retryErr && retryErr.message || err && err.message || "network request failed",
                                    stack: retryErr && retryErr.stack || err && err.stack || "",
                                    endpoint: endpoint,
                                    traceId: traceId,
                                    requestId: retryRequestId,
                                    action: activeTrace && activeTrace.action,
                                    roomId: extractRoomId(),
                                    context: requestContext(endpoint, retryRequestId, startedAt, {
                                        method: method,
                                        initialErrorName: err && err.name || "",
                                        initialErrorMessage: err && err.message || "",
                                        retryErrorName: retryErr && retryErr.name || "",
                                        configRetry: true
                                    })
                                });
                                throw retryErr;
                            });
                        } catch (_) {
                            // Fall through to the normal error report if creating the retry itself fails.
                        }
                    }

                    var kind = isAbort ? "fetch_aborted" : "network_error";
                    pushBreadcrumb("http", "request.failed", { method: method, endpoint: cleanEndpoint, durationMs: Date.now() - startedAt, errorName: err && err.name || "", message: err && err.message || "" }, traceId);
                    report(kind, {
                        message: err && err.message || "network request failed",
                        stack: err && err.stack || "",
                        endpoint: endpoint,
                        traceId: traceId,
                        requestId: requestId,
                        action: activeTrace && activeTrace.action,
                        roomId: extractRoomId(),
                        context: requestContext(endpoint, requestId, startedAt, { method: method, errorName: err && err.name || "" })
                    });
                    throw err;
                });
            };
        }
    } catch (_) {}

    function summarizeSocketArgs(args) {
        try {
            var clean = [];
            for (var i = 0; i < Math.min(args.length, 3); i++) {
                var v = args[i];
                if (typeof v === "function") continue;
                clean.push(compactDetail(v));
            }
            return clean;
        } catch (_) { return []; }
    }

    function instrumentSocket(socket) {
        if (!socket || socket.__wwDiagInstrumented) return socket;
        socket.__wwDiagInstrumented = true;
        try { socket.auth = Object.assign({}, socket.auth || {}, { wwDiagSessionId: sessionId }); } catch (_) {}
        try {
            socket.on("connect", function () { var authPresence={}; try{var a=socket.io&&socket.io.opts&&socket.io.opts.auth||{}; authPresence={testerPassPresented:!!a.testerPass,hasDiagSession:!!a.wwDiagSessionId,hasRoomIdentity:!!(a.roomId&&a.token),hasAdminIntent:a.admin===true};}catch(_){} window.WW_DIAG_SOCKET_CONNECTED = true; pushBreadcrumb("socket", "connect", { id: socket.id || "", authPresence:authPresence }, currentTraceId(false)); });
            socket.on("disconnect", function (reason) {
                window.WW_DIAG_SOCKET_CONNECTED = false;
                Object.keys(diagnosticOperations).forEach(function(id){ if (diagnosticOperations[id]) diagnosticOperations[id].lastDisconnectReason = String(reason || ""); });
                pushBreadcrumb("socket", "disconnect", { reason:String(reason || ""), pendingOperations:Object.keys(diagnosticOperations).length }, currentTraceId(false));
            });
            socket.on("connect_error", function (err) {
                var traceId = currentTraceId(false);
                pushBreadcrumb("socket", "connect_error", { message:err && err.message || String(err || ""), name:err && err.name || "" }, traceId);
                if (String(err && err.message || "") !== "server_closed") report("socket_connect_error", { message:err && err.message || String(err || "socket connection error"), stack:err && err.stack || "", traceId:traceId, failureStage:"socket.connect", causeCode:"SOCKET_CONNECT_ERROR", causeConfidence:"high" });
            });
            socket.on("error", function (err) { report("socket_error", { message:err && err.message || String(err || "socket error"), stack:err && err.stack || "", failureStage:"socket.runtime", causeCode:"SOCKET_ERROR", causeConfidence:"high" }); });
            if (typeof socket.onAny === "function") {
                socket.onAny(function(eventName) {
                    var args = Array.prototype.slice.call(arguments, 1);
                    if (/^(connect|disconnect|connect_error|error)$/.test(String(eventName))) return;
                    pushBreadcrumb("socket", "receive:" + String(eventName), { args:summarizeSocketArgs(args) }, currentTraceId(false));
                });
            }
            var rawEmit = socket.emit.bind(socket);
            socket.emit = function () {
                var args = Array.prototype.slice.call(arguments);
                var eventName = String(args[0] || "event");
                var traceId = currentTraceId(false);
                var operationId = nextOperationId();
                var startedAt = Date.now();
                try {
                    var firstPayload = args.slice(1).find(function(x){ return x && typeof x === "object" && x.roomId; });
                    if (firstPayload && /^[A-Za-z0-9]{3,12}$/.test(String(firstPayload.roomId))) lastRoomId = String(firstPayload.roomId).toUpperCase();
                    var roomArg = args.slice(1).find(function(x){ return typeof x === "string" && /^[A-Za-z0-9]{3,12}$/.test(x); });
                    if (roomArg && /room|close|start|join/i.test(eventName)) lastRoomId = String(roomArg).toUpperCase();
                } catch (_) {}
                var ackIndex = -1;
                for (var i=args.length-1;i>=1;i--) { if (typeof args[i] === "function") { ackIndex=i; break; } }
                var operation={id:operationId,eventName:eventName,traceId:traceId,startedAt:startedAt,done:false};
                diagnosticOperations[operationId]=operation;
                pushBreadcrumb("socket", "emit:"+eventName, { operationId:operationId, hasAck:ackIndex>=0, args:summarizeSocketArgs(args.slice(1, ackIndex>=0?ackIndex:undefined)) }, traceId);
                if (ackIndex>=0) {
                    var originalAck=args[ackIndex];
                    args[ackIndex]=function(){
                        var ackArgs=Array.prototype.slice.call(arguments), res=ackArgs[0];
                        if (operation.done) { pushBreadcrumb("socket","ack.duplicate:"+eventName,{operationId:operationId,elapsedMs:Date.now()-startedAt,ack:compactDetail(res||{})},traceId); try{return originalAck.apply(this,arguments);}catch(_){return undefined;} }
                        operation.done=true; clearTimeout(operation.timer); delete diagnosticOperations[operationId];
                        // รายการห้องของ legacy socket API ใช้ callback(array) ไม่ใช่ callback({ok:true,...})
                        // ดังนั้น array เป็น successful payload สำหรับ event ที่ขึ้นต้นด้วย list_ ไม่ใช่ error
                        // (ก่อนหน้านี้ Diagnostic v16 รายงาน list_open_rooms เป็น rejected ทั้งที่ server ทำงานสำเร็จ)
                        var arrayPayloadSuccess = Array.isArray(res) && /^(list_open_rooms|list_open_rooms_players)$/.test(eventName);
                        // Some legacy room APIs returned a structured success payload without ok:true.
                        // create_room is successful when the server returns a roomId and no error/code.
                        // Keep this compatibility rule so diagnostics do not report a false SOCKET_ACK_ERROR
                        // after the room has actually been created. The server now also sends ok:true.
                        var createRoomPayloadSuccess = eventName === "create_room" && !!(res && res.roomId) && !res.error && !res.code;
                        var ok=!!(res&&res.ok===true) || arrayPayloadSuccess || createRoomPayloadSuccess, ackCode=res&&(res.code||res.errorCode||res.error)||"";
                        pushBreadcrumb("socket","ack:"+eventName,{operationId:operationId,elapsedMs:Date.now()-startedAt,ok:ok,ackCode:String(ackCode).slice(0,100),ack:compactDetail(res||{})},traceId);
                        if (!ok) report("socket_ack_error",{message:String((res&&(res.error||res.message||res.code))||("Socket event "+eventName+" rejected")),traceId:traceId,operationId:operationId,roomId:extractRoomId(),causeCode:String(ackCode||"SOCKET_ACK_ERROR"),causeConfidence:"high",failureStage:"socket.server_response",context:{eventName:eventName,operationId:operationId,ackCode:String(ackCode),serverMessage:res&&(res.error||res.message||""),elapsedMs:Date.now()-startedAt,socketConnected:!!window.WW_DIAG_SOCKET_CONNECTED,ack:compactDetail(res||{})}});
                        try{return originalAck.apply(this,arguments);}catch(e){report("socket_ack_callback_error",{message:e.message||String(e),stack:e.stack||"",traceId:traceId,operationId:operationId,context:{eventName:eventName,operationId:operationId},failureStage:"browser.callback",causeCode:"ACK_CALLBACK_ERROR",causeConfidence:"high"});}
                    };
                    operation.timer=setTimeout(function(){
                        if(operation.done)return; operation.done=true; delete diagnosticOperations[operationId];
                        pushBreadcrumb("socket","ack.timeout",{operationId:operationId,eventName:eventName,elapsedMs:Date.now()-startedAt,socketConnected:!!window.WW_DIAG_SOCKET_CONNECTED},traceId);
                        report("socket_ack_timeout",{message:"Socket event "+eventName+" did not receive ACK within "+DIAG_SOCKET_ACK_TIMEOUT_MS+"ms",traceId:traceId,operationId:operationId,roomId:extractRoomId(),causeCode:"ACK_TIMEOUT",causeConfidence:"high",failureStage:"socket.ack",context:{eventName:eventName,operationId:operationId,elapsedMs:Date.now()-startedAt,socketConnected:!!window.WW_DIAG_SOCKET_CONNECTED}});
                    },DIAG_SOCKET_ACK_TIMEOUT_MS);
                }
                try { var out=rawEmit.apply(socket,args); pushBreadcrumb("socket","emit.sent:"+eventName,{operationId:operationId,elapsedMs:Date.now()-startedAt},traceId); return out; }
                catch(e){ if(operation.timer)clearTimeout(operation.timer); operation.done=true; delete diagnosticOperations[operationId]; report("socket_emit_error",{message:e.message||String(e),stack:e.stack||"",traceId:traceId,operationId:operationId,roomId:extractRoomId(),causeCode:"SOCKET_EMIT_ERROR",causeConfidence:"high",failureStage:"socket.client_send",context:{eventName:eventName,operationId:operationId}}); throw e; }
            };
        } catch (_) {}
        return socket;
    }

    function instrumentSocketIoIfReady() {
        try {
            var baseIo = window.io;
            if (typeof baseIo !== "function") return false;
            if (baseIo.__wwInstrumentedV16) return true;
            var instrumentedIo = function () {
                var args = Array.prototype.slice.call(arguments);
                try {
                    var optionsIndex = (args.length >= 2 && typeof args[1] === "object") ? 1 : (args.length >= 1 && typeof args[0] === "object" ? 0 : -1);
                    if (optionsIndex >= 0) {
                        var opts = args[optionsIndex] || {};
                        var auth = Object.assign({}, opts.auth || {}, { wwDiagSessionId: sessionId });
                        args[optionsIndex] = Object.assign({}, opts, { auth: auth });
                    } else {
                        args.push({ auth: { wwDiagSessionId: sessionId } });
                    }
                } catch (_) {}
                var socket = baseIo.apply(this, args);
                return instrumentSocket(socket);
            };
            Object.keys(baseIo).forEach(function (key) { try { instrumentedIo[key] = baseIo[key]; } catch (_) {} });
            instrumentedIo.__wwInstrumentedV16 = true;
            window.io = instrumentedIo;
            socketIoInstalled = true;
            return true;
        } catch (_) { return false; }
    }
    if (!instrumentSocketIoIfReady()) {
        var ioProbeStartedAt = Date.now();
        var ioProbe = setInterval(function () {
            if (instrumentSocketIoIfReady() || Date.now() - ioProbeStartedAt > 15000) clearInterval(ioProbe);
        }, 100);
    }

    window.WWDiagnostic = {
        version: "16",
        sessionId: sessionId,
        beginTrace: beginTrace,
        breadcrumb: function (label, detail) { return pushBreadcrumb("manual", label, detail || {}, currentTraceId(false)); },
        report: report,
        getBreadcrumbs: function () { return breadcrumbs.slice(); },
        getState: getState
    };
    window.WWReportError = report;
    pushBreadcrumb("lifecycle", "page_loaded", { page: PAGE, reporter: "v16" }, "");
})();
