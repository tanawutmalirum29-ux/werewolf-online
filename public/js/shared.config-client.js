(function () {
    "use strict";

    // Shared single-flight client for the tiny, read-only /api/config endpoint.
    // Mobile/iOS browsers can surface a generic TypeError("Load failed") even when
    // the origin is healthy. Keep retries, timeout, and request correlation in one
    // place so different page modules do not accidentally multiply retries.
    var inflight = Object.create(null);
    var CONFIG_TIMEOUT_MS = 4500;
    var CONFIG_MAX_ATTEMPTS = 3;
    var RETRY_DELAYS_MS = [400, 1000];

    function normalizeHeaders(input) {
        var out = {};
        try {
            var h = new Headers(input || {});
            h.forEach(function (value, key) {
                var k = String(key).toLowerCase();
                if (k === 'x-ww-room' || k === 'x-ww-token' || k === 'cookie') out[k] = String(value);
            });
        } catch (_) {}
        return out;
    }

    function keyFor(url, init) {
        var headers = normalizeHeaders(init && init.headers);
        var method = String((init && init.method) || 'GET').toUpperCase();
        var credentials = String((init && init.credentials) || 'same-origin');
        return [method, String(url), credentials, headers['x-ww-room'] || '', headers['x-ww-token'] || '', headers['cookie'] || ''].join('|');
    }

    function makeId(prefix) {
        return (prefix || 'cfg') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    function sessionId() {
        try {
            if (window.__WW_DIAG_SESSION_ID__) return String(window.__WW_DIAG_SESSION_ID__).slice(0, 120);
            var key = 'ww_diag_session_id';
            var v = sessionStorage.getItem(key);
            if (v) return String(v).slice(0, 120);
            var id = makeId('ses');
            sessionStorage.setItem(key, id);
            return id;
        } catch (_) { return ''; }
    }

    function shouldRetry(err) {
        if (!err) return false;
        if (err.configCallerAborted) return false;
        if (err.name === 'TypeError' || err.name === 'AbortError' || err.name === 'ConfigNetworkError' || err.name === 'ConfigTimeoutError') return true;
        var status = Number(err.status || 0);
        return status === 502 || status === 503 || status === 504;
    }

    function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    function buildAttemptInit(baseInit, logicalId, attempt) {
        var init = Object.assign({}, baseInit || {});
        var headers = new Headers(init.headers || {});
        var requestId = logicalId + '-a' + String(attempt);
        headers.set('X-WW-Client-Request-Id', requestId.slice(0, 120));
        headers.set('X-WW-Client-Session-Id', sessionId());
        headers.set('X-WW-Config-Logical-Id', logicalId.slice(0, 120));
        headers.set('X-WW-Config-Attempt', String(attempt));
        headers.set('X-WW-Config-Retry-Managed', '1');
        init.headers = headers;
        return { init: init, requestId: requestId };
    }

    function fetchAttempt(url, baseInit, logicalId, attempt) {
        var built = buildAttemptInit(baseInit, logicalId, attempt);
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var originalSignal = baseInit && baseInit.signal;
        var timeoutTimer = null;
        var removeAbortForwarder = null;

        if (controller) {
            built.init.signal = controller.signal;
            if (originalSignal) {
                if (originalSignal.aborted) controller.abort();
                else {
                    var onAbort = function () { try { controller.abort(); } catch (_) {} };
                    try { originalSignal.addEventListener('abort', onAbort, { once: true }); removeAbortForwarder = function () { originalSignal.removeEventListener('abort', onAbort); }; } catch (_) {}
                }
            }
            timeoutTimer = setTimeout(function () {
                try { controller.abort(); } catch (_) {}
            }, CONFIG_TIMEOUT_MS);
        }

        return window.fetch(url, built.init).then(function (res) {
            if (!res || !res.ok) {
                var httpErr = new Error('config_http_' + (res ? res.status : 'unknown'));
                httpErr.name = 'ConfigHTTPError';
                httpErr.status = res && res.status;
                httpErr.configRequestId = built.requestId;
                httpErr.configLogicalId = logicalId;
                httpErr.configAttempt = attempt;
                throw httpErr;
            }
            return res.text().then(function (text) {
                try {
                    return JSON.parse(text);
                } catch (parseErr) {
                    var jsonErr = new Error('invalid /api/config JSON response');
                    jsonErr.name = 'ConfigJSONError';
                    jsonErr.configRequestId = built.requestId;
                    jsonErr.configLogicalId = logicalId;
                    jsonErr.configAttempt = attempt;
                    jsonErr.cause = parseErr;
                    throw jsonErr;
                }
            });
        }).catch(function (err) {
            err = err || new Error('config request failed');
            err.configRequestId = err.configRequestId || built.requestId;
            err.configLogicalId = err.configLogicalId || logicalId;
            err.configAttempt = err.configAttempt || attempt;
            if (originalSignal && originalSignal.aborted) {
                err.configCallerAborted = true;
                throw err;
            }
            if (controller && controller.signal.aborted) {
                var timeoutErr = new Error('/api/config request timed out');
                timeoutErr.name = 'ConfigTimeoutError';
                timeoutErr.code = 'CONFIG_TIMEOUT';
                timeoutErr.configRequestId = built.requestId;
                timeoutErr.configLogicalId = logicalId;
                timeoutErr.configAttempt = attempt;
                throw timeoutErr;
            }
            throw err;
        }).finally(function () {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (removeAbortForwarder) removeAbortForwarder();
        });
    }

    function notifyTerminalFailure(err, logicalId, startedAt, attempt) {
        try {
            var reporter = window.__WW_DIAG_REPORT_CONFIG_FAILURE__;
            if (typeof reporter === 'function') {
                var status = Number(err && err.status || 0) || 0;
                var kind = status >= 400 ? 'http_error' : (err && err.name === 'ConfigJSONError' ? 'config_invalid_json' : (err && err.name === 'ConfigTimeoutError' ? 'config_timeout' : 'network_error'));
                var code = status >= 400 ? 'HTTP_' + status : (err && err.name === 'ConfigJSONError' ? 'CONFIG_INVALID_JSON' : (err && err.name === 'ConfigTimeoutError' ? 'CONFIG_TIMEOUT' : 'NETWORK_ERROR'));
                reporter({
                    kind: kind,
                    message: err && err.message || 'config request failed',
                    stack: err && err.stack || '',
                    endpoint: '/api/config',
                    status: status,
                    requestId: err && err.configRequestId || '',
                    context: {
                        configLogicalId: logicalId,
                        configAttempt: attempt,
                        durationMs: Date.now() - startedAt,
                        errorName: err && err.name || '',
                        errorCode: err && err.code || '',
                        configRetryManaged: true
                    },
                    causeCode: code,
                    causeConfidence: status || code === 'CONFIG_TIMEOUT' ? 'high' : 'medium',
                    failureStage: status >= 500 ? 'http.server' : (status >= 400 ? 'http.response' : 'browser.transport')
                });
            }
        } catch (_) {}
    }

    function wwGetConfig(options) {
        options = options || {};
        var url = String(options.url || '/api/config');
        var init = Object.assign({}, options.init || {});
        init.method = 'GET';
        if (!init.cache) init.cache = 'no-store';
        if (!init.credentials) init.credentials = 'same-origin';

        var key = keyFor(url, init);
        if (!options.force && inflight[key]) return inflight[key];

        var logicalId = makeId('cfg');
        var startedAt = Date.now();

        function request(attempt) {
            return fetchAttempt(url, init, logicalId, attempt).catch(function (err) {
                if (attempt < CONFIG_MAX_ATTEMPTS && shouldRetry(err)) {
                    return delay(RETRY_DELAYS_MS[attempt - 1] || 1000).then(function () { return request(attempt + 1); });
                }
                err.configLogicalId = err.configLogicalId || logicalId;
                err.configAttempt = err.configAttempt || attempt;
                if (err.configCallerAborted) throw err;
                notifyTerminalFailure(err, logicalId, startedAt, attempt);
                throw err;
            });
        }

        var p = request(1);
        if (!options.force) inflight[key] = p;
        var clear = function () { if (inflight[key] === p) delete inflight[key]; };
        p.then(clear, clear);
        return p;
    }

    window.wwGetConfig = wwGetConfig;
})();
