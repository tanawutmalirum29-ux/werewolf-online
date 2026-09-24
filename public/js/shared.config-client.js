(function () {
    // Shared single-flight client for the tiny, read-only /api/config endpoint.
    // Several page modules need the same state (serverOpen/reset/reload/image/version).
    // Without this gate, interval + focus + visibility + navigation checks can overlap on
    // iPad/iOS and produce avoidable fetch lifecycle races.
    //
    // IMPORTANT: the promise resolves to parsed JSON, not a Response object. A Response body
    // can only be consumed once, so sharing raw Response instances would create a new bug.
    var inflight = Object.create(null);

    function normalizeHeaders(input) {
        var out = {};
        try {
            var h = new Headers(input || {});
            h.forEach(function (value, key) {
                // Diagnostic headers are injected by error-reporter.js per physical request and
                // must not affect the dedupe key. Only server-visible config identity headers do.
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

    function wwGetConfig(options) {
        options = options || {};
        var url = String(options.url || '/api/config');
        var init = Object.assign({}, options.init || {});
        init.method = 'GET';
        if (!init.cache) init.cache = 'no-store';
        if (!init.credentials) init.credentials = 'same-origin';

        var key = keyFor(url, init);
        if (!options.force && inflight[key]) return inflight[key];

        var p = window.fetch(url, init).then(function (res) {
            if (!res || !res.ok) {
                var err = new Error('config_http_' + (res ? res.status : 'unknown'));
                err.name = 'ConfigHTTPError';
                err.status = res && res.status;
                throw err;
            }
            return res.json();
        });

        if (!options.force) inflight[key] = p;
        var clear = function () {
            if (inflight[key] === p) delete inflight[key];
        };
        p.then(clear, clear);
        return p;
    }

    window.wwGetConfig = wwGetConfig;
})();
