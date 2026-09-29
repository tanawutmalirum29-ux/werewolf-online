(function () {
    "use strict";

    // Shared update/version detector used by Index and Admin.
    // The server's /api/config -> data.version is the single source of truth.
    // UI-specific pages decide how/when to present an update; this module only
    // handles the known-version baseline and the read-only version check.
    var WW_UPDATE_KNOWN_VERSION_KEY = "ww_update_known_version";
    var WW_LEGACY_PENDING_KEY = "ww_update_pending_version";

    function cleanVersion(value) {
        var v = String(value == null ? "" : value).trim();
        return v || null;
    }

    function readKnownVersion() {
        try {
            var value = cleanVersion(localStorage.getItem(WW_UPDATE_KNOWN_VERSION_KEY));
            // Old builds used this pending key. It is not authoritative anymore;
            // remove it so stale state cannot resurrect an old update decision.
            localStorage.removeItem(WW_LEGACY_PENDING_KEY);
            return value;
        } catch (_) {
            return null;
        }
    }

    var knownVersion = readKnownVersion();

    function setKnownVersion(version) {
        var v = cleanVersion(version);
        if (!v) return null;
        knownVersion = v;
        try { localStorage.setItem(WW_UPDATE_KNOWN_VERSION_KEY, v); } catch (_) {}
        return v;
    }

    function getKnownVersion() {
        return knownVersion;
    }

    function evaluate(data) {
        var version = cleanVersion(data && data.version);
        if (!version) {
            return {
                state: "unavailable",
                version: null,
                knownVersion: knownVersion,
                data: data || null,
            };
        }

        if (knownVersion === null) {
            setKnownVersion(version);
            return {
                state: "baseline",
                version: version,
                knownVersion: version,
                data: data,
            };
        }

        if (version !== knownVersion) {
            // Immutable EB deployments intentionally expose old and new instances together
            // while the environment status is Updating. Never announce an update in that
            // transition window; wait for the environment to return Ready first.
            var deploymentState = cleanVersion(data && data.deploymentState) || "unknown";
            if (deploymentState !== "ready") {
                return {
                    state: "deployment",
                    version: version,
                    knownVersion: knownVersion,
                    data: data,
                };
            }
            return {
                state: "update",
                version: version,
                knownVersion: knownVersion,
                data: data,
            };
        }

        return {
            state: "current",
            version: version,
            knownVersion: knownVersion,
            data: data,
        };
    }

    function deploymentProbeConfig() {
        return { url: "/api/config?deploymentProbe=1", init: { cache: "no-store" } };
    }

    function check(options) {
        options = options || {};
        if (typeof window.wwGetConfig !== "function") {
            return Promise.resolve({
                state: "unavailable",
                version: null,
                knownVersion: knownVersion,
                data: null,
            });
        }

        return window.wwGetConfig(options.config || {})
            .then(function (data) {
                var result = evaluate(data);
                // A version mismatch is the only moment where a fresh EB control-plane probe
                // is worth the extra request. This closes the small race where the first /api/config
                // response still carried a cached Ready state just as Immutable deployment began.
                if (result.state !== "update") return result;
                return window.wwGetConfig(deploymentProbeConfig())
                    .then(function (freshData) {
                        return evaluate(freshData);
                    })
                    .catch(function () {
                        // Preserve the safe initial result if AWS control-plane probing fails.
                        return result;
                    });
            });
    }

    window.WWUpdateDetector = {
        key: WW_UPDATE_KNOWN_VERSION_KEY,
        getKnownVersion: getKnownVersion,
        setKnownVersion: setKnownVersion,
        check: check,
    };
})();
