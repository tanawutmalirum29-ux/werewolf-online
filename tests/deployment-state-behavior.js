const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const utilityPath = path.join(__dirname, "..", "utils", "getAppVersion.js");
const utilitySource = fs.readFileSync(utilityPath, "utf8");

function loadUtility(environmentSequence) {
    let index = 0;
    let sends = 0;
    const sandbox = {
        console,
        process: { env: { EB_ENVIRONMENT_NAME: "werewolf-online-th-env", AWS_REGION: "ap-southeast-7" } },
        Date,
        String,
        Number,
        Promise,
        Object,
    };
    sandbox.module = { exports: {} };
    class DescribeEnvironmentsCommand {
        constructor(input) { this.input = input; }
    }
    class ElasticBeanstalkClient {
        constructor(options) { this.options = options; }
        async send(command) {
            sends += 1;
            assert.ok(command instanceof DescribeEnvironmentsCommand);
            const item = environmentSequence[Math.min(index++, environmentSequence.length - 1)];
            return { Environments: [item] };
        }
    }
    sandbox.require = (request) => {
        if (request === "@aws-sdk/client-elastic-beanstalk") {
            return { ElasticBeanstalkClient, DescribeEnvironmentsCommand };
        }
        throw new Error(`Unexpected dependency: ${request}`);
    };
    vm.runInNewContext(utilitySource, sandbox, { filename: utilityPath });
    return { exports: sandbox.module.exports, sends: () => sends };
}

(async () => {
    const env = loadUtility([
        {
            EnvironmentName: "werewolf-online-th-env",
            VersionLabel: "v3-80",
            Status: "Updating",
            Health: "Grey",
            HealthStatus: "Unknown",
            AbortableOperationInProgress: true,
        },
        {
            EnvironmentName: "werewolf-online-th-env",
            VersionLabel: "v3-81",
            Status: "Ready",
            Health: "Green",
            HealthStatus: "Ok",
            AbortableOperationInProgress: false,
        },
    ]);

    let state = await env.exports.getAppEnvironmentState({ force: true });
    assert.strictEqual(state.versionLabel, "v3-80");
    assert.strictEqual(state.status, "Updating");
    assert.strictEqual(state.deploymentState, "updating");
    assert.strictEqual(state.abortableOperationInProgress, true);

    state = await env.exports.getAppEnvironmentState({ force: true });
    assert.strictEqual(state.versionLabel, "v3-81");
    assert.strictEqual(state.status, "Ready");
    assert.strictEqual(state.deploymentState, "ready");
    assert.strictEqual(state.abortableOperationInProgress, false);
    assert.strictEqual(env.sends(), 2);

    console.log("deployment-state behavior: PASS");
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
