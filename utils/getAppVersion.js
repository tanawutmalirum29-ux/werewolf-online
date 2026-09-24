const { ElasticBeanstalkClient, DescribeEnvironmentsCommand } = require("@aws-sdk/client-elastic-beanstalk");

let cachedVersion = null;
let requestPromise = null;
let lastFailureAt = 0;
const RETRY_AFTER_FAILURE_MS = 60_000;

function normalizeVersion(value) {
    const version = String(value ?? "").trim();
    return version || "unknown";
}

async function getAppVersion() {
    if (cachedVersion) return cachedVersion;

    const envName = String(process.env.EB_ENVIRONMENT_NAME || "").trim();
    if (!envName) {
        cachedVersion = "local-dev";
        return cachedVersion;
    }

    const now = Date.now();
    if (requestPromise) return requestPromise;
    if (lastFailureAt && now - lastFailureAt < RETRY_AFTER_FAILURE_MS) return "unknown";

    requestPromise = (async () => {
        try {
            const client = new ElasticBeanstalkClient({
                region: process.env.AWS_REGION || "ap-southeast-7",
            });
            const res = await client.send(new DescribeEnvironmentsCommand({
                EnvironmentNames: [envName],
            }));

            const version = normalizeVersion(res.Environments?.[0]?.VersionLabel);
            if (version !== "unknown") cachedVersion = version;
            lastFailureAt = 0;
            return version;
        } catch (err) {
            lastFailureAt = Date.now();
            console.error("Failed to get app version:", err);
            return "unknown";
        } finally {
            requestPromise = null;
        }
    })();

    return requestPromise;
}

function getCachedAppVersion() {
    return cachedVersion || (process.env.EB_ENVIRONMENT_NAME ? "unknown" : "local-dev");
}

module.exports = { getAppVersion, getCachedAppVersion };
