const { ElasticBeanstalkClient, DescribeEnvironmentsCommand } = require("@aws-sdk/client-elastic-beanstalk");

let cachedVersion = null;
let cachedAt = 0;
let requestPromise = null;
let lastFailureAt = 0;
let refreshTimer = null;

// Elastic Beanstalk can update the environment's Running Version after the Node
// process has already started. A permanent process-local cache therefore can
// freeze the UI at the previous deployment forever. Keep the cache only as a
// short-lived optimisation and refresh it in the background.
const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const FAILURE_RETRY_DELAY_MS = 2_000;

function configuredRefreshIntervalMs() {
    const raw = Number(process.env.WW_APP_VERSION_REFRESH_MS);
    return Number.isFinite(raw) && raw > 0 ? Math.max(250, Math.floor(raw)) : DEFAULT_REFRESH_INTERVAL_MS;
}

function normalizeVersion(value) {
    const version = String(value ?? "").trim();
    return version || "unknown";
}

function isCacheFresh(now = Date.now()) {
    return !!cachedVersion && cachedVersion !== "unknown" && cachedAt > 0
        && now - cachedAt < configuredRefreshIntervalMs();
}

async function refreshAppVersion({ force = false } = {}) {
    if (requestPromise) return requestPromise;

    const envName = String(process.env.EB_ENVIRONMENT_NAME || "").trim();
    if (!envName) {
        cachedVersion = "local-dev";
        cachedAt = Date.now();
        lastFailureAt = 0;
        return cachedVersion;
    }

    const now = Date.now();
    if (!force && lastFailureAt && now - lastFailureAt < FAILURE_RETRY_DELAY_MS && cachedVersion) {
        return cachedVersion;
    }

    requestPromise = (async () => {
        try {
            const client = new ElasticBeanstalkClient({
                region: process.env.AWS_REGION || "ap-southeast-7",
            });
            const res = await client.send(new DescribeEnvironmentsCommand({
                EnvironmentNames: [envName],
            }));

            const version = normalizeVersion(res.Environments?.[0]?.VersionLabel);
            if (version !== "unknown") {
                cachedVersion = version;
                cachedAt = Date.now();
                lastFailureAt = 0;
            }
            return cachedVersion || version;
        } catch (err) {
            lastFailureAt = Date.now();
            console.error("Failed to get app version:", err);
            // Preserve the last known good label instead of replacing a known
            // version with "unknown" during a brief AWS control-plane hiccup.
            return cachedVersion || "unknown";
        } finally {
            requestPromise = null;
        }
    })();

    return requestPromise;
}

async function getAppVersion({ force = false } = {}) {
    if (!String(process.env.EB_ENVIRONMENT_NAME || "").trim()) {
        return refreshAppVersion();
    }

    if (!force && isCacheFresh()) return cachedVersion;
    return refreshAppVersion({ force });
}

function getCachedAppVersion() {
    return cachedVersion || (process.env.EB_ENVIRONMENT_NAME ? "unknown" : "local-dev");
}

function startAppVersionRefresh(intervalMs = configuredRefreshIntervalMs()) {
    if (refreshTimer) return refreshTimer;

    const refresh = () => {
        getAppVersion({ force: true }).catch((err) => {
            console.error("Failed to refresh app version:", err);
        });
    };

    // Refresh immediately, then keep the process-local snapshot current.
    refresh();
    refreshTimer = setInterval(refresh, Math.max(250, Number(intervalMs) || configuredRefreshIntervalMs()));
    if (typeof refreshTimer.unref === "function") refreshTimer.unref();
    return refreshTimer;
}

function stopAppVersionRefresh() {
    if (!refreshTimer) return;
    clearInterval(refreshTimer);
    refreshTimer = null;
}

module.exports = { getAppVersion, getCachedAppVersion, startAppVersionRefresh, stopAppVersionRefresh };
