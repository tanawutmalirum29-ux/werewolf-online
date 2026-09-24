const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const utilityPath = path.join(root, "utils", "getAppVersion.js");
const serverPath = path.join(root, "server.js");
const sharedPath = path.join(root, "public", "js", "shared.server-control.js");
const indexPath = path.join(root, "public", "js", "index.main.js");
const playerPath = path.join(root, "public", "js", "player.main.js");
const hostPath = path.join(root, "public", "js", "host.main.js");

assert.ok(fs.existsSync(utilityPath), "getAppVersion utility must exist");
const utility = fs.readFileSync(utilityPath, "utf8");
assert.match(utility, /DescribeEnvironmentsCommand/);
assert.match(utility, /EB_ENVIRONMENT_NAME/);
assert.match(utility, /AWS_REGION \|\| "ap-southeast-7"/);
assert.match(utility, /module\.exports = \{ getAppVersion, getCachedAppVersion, startAppVersionRefresh, stopAppVersionRefresh \}/);

const server = fs.readFileSync(serverPath, "utf8");
assert.doesNotMatch(server, /const \{ ElasticBeanstalkClient, DescribeEnvironmentsCommand \}/, "server.js should no longer own the EB client");
assert.doesNotMatch(server, /function getCachedRunningVersionLabel\(/, "legacy running-version helper must be removed");
assert.match(server, /getAppVersion\(\)\.then\(\(version\) =>/);
assert.match(server, /console\.log\("Running version:", version\)/);
assert.match(server, /socket\.emit\("serverInfo", \{ version, buildVersion: computeServerVersion\(\), clientHash: computeClientHash\(\), adminHash: computeAdminHash\(\) \}\)/);
assert.match(server, /const appVersion = await Promise\.race\(\[versionPromise, versionTimeout\]\);/);

const shared = fs.readFileSync(sharedPath, "utf8");
assert.match(shared, /window\.wwSetServerVersion/);
assert.match(shared, /window\.wwSetServerVersion\(cfg\.appVersion\)/);
assert.match(shared, /window\.__WW_SERVER_VERSION = version\.trim\(\);/);
assert.match(shared, /DOMContentLoaded/);

for (const file of [indexPath, playerPath, hostPath]) {
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /serverInfo/);
    assert.match(text, /wwSetServerVersion/);
}

const vm = require("vm");
const utilitySource = fs.readFileSync(utilityPath, "utf8");

function loadUtility(mockEbClient) {
    const sandbox = {
        console,
        process: { env: { ...process.env } },
        Date,
        String,
        Promise,
    };
    sandbox.module = { exports: {} };
    sandbox.require = (request) => {
        if (request === "@aws-sdk/client-elastic-beanstalk") return mockEbClient;
        throw new Error(`Unexpected dependency: ${request}`);
    };
    vm.runInNewContext(utilitySource, sandbox, { filename: utilityPath });
    return { exports: sandbox.module.exports, env: sandbox.process.env };
}

(async () => {
    // Local mode never constructs the AWS client.
    const localMock = {
        ElasticBeanstalkClient: class { constructor() { throw new Error("AWS client must not be created in local mode"); } },
        DescribeEnvironmentsCommand: class {},
    };
    const local = loadUtility(localMock);
    local.env.EB_ENVIRONMENT_NAME = "";
    assert.strictEqual(await local.exports.getAppVersion(), "local-dev");
    assert.strictEqual(local.exports.getCachedAppVersion(), "local-dev");

    // AWS mode: concurrent callers share one DescribeEnvironments request and receive VersionLabel.
    let sends = 0;
    let runningVersion = "v3-57";
    let failNext = false;
    class FakeClient {
        constructor(options) { this.options = options; }
        async send(command) {
            sends += 1;
            assert.strictEqual(this.options.region, "ap-southeast-7");
            assert.ok(command instanceof localAws.DescribeEnvironmentsCommand);
            if (failNext) { failNext = false; throw new Error("temporary AWS control-plane failure"); }
            return { Environments: [{ VersionLabel: runningVersion }] };
        }
    }
    const localAws = {
        ElasticBeanstalkClient: FakeClient,
        DescribeEnvironmentsCommand: class DescribeEnvironmentsCommand {
            constructor(input) { this.input = input; }
        },
    };
    const aws = loadUtility(localAws);
    aws.env.EB_ENVIRONMENT_NAME = "werewolf-online-env";
    aws.env.AWS_REGION = "";
    const [a, b] = await Promise.all([aws.exports.getAppVersion(), aws.exports.getAppVersion()]);
    assert.strictEqual(a, "v3-57");
    assert.strictEqual(b, "v3-57");
    assert.strictEqual(sends, 1, "concurrent callers must share one AWS request");
    assert.strictEqual(aws.exports.getCachedAppVersion(), "v3-57");

    // A forced refresh must pick up the next deployment instead of staying frozen at v3-57.
    runningVersion = "v3-58";
    const refreshed = await aws.exports.getAppVersion({ force: true });
    assert.strictEqual(refreshed, "v3-58");
    assert.strictEqual(aws.exports.getCachedAppVersion(), "v3-58");
    assert.strictEqual(sends, 2, "forced refresh must issue a new AWS request");

    // Temporary AWS failure must preserve the last known good version rather than regress to unknown.
    runningVersion = "v3-59";
    failNext = true;
    const afterFailure = await aws.exports.getAppVersion({ force: true });
    assert.strictEqual(afterFailure, "v3-58");
    assert.strictEqual(aws.exports.getCachedAppVersion(), "v3-58");

    await aws.exports.getAppVersion({ force: true });
    assert.strictEqual(aws.exports.getCachedAppVersion(), "v3-59");

    console.log("App version regression tests passed.");
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
