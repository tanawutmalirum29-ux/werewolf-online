"use strict";

const assert = require("assert");
const Module = require("module");
const path = require("path");

const ebCalls = [];
const s3Calls = [];
let ebPage = 0;

class FakeCommand {
    constructor(input) { this.input = input; }
}
class DescribeEnvironmentsCommand extends FakeCommand {}
class DescribeApplicationVersionsCommand extends FakeCommand {}
class UpdateEnvironmentCommand extends FakeCommand {}
class GetObjectCommand extends FakeCommand {}

const fakeElasticModule = {
    ElasticBeanstalkClient: class {},
    DescribeEnvironmentsCommand,
    DescribeApplicationVersionsCommand,
    UpdateEnvironmentCommand,
};
const fakeS3Module = {
    S3Client: class {},
    GetObjectCommand,
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "@aws-sdk/client-elastic-beanstalk") return fakeElasticModule;
    if (request === "@aws-sdk/client-s3") return fakeS3Module;
    return originalLoad.call(this, request, parent, isMain);
};

let manager;
manager = require(path.join(__dirname, "..", "utils", "elastic-beanstalk-version-manager.js"));

async function main() {
    const envClient = {
        async send(command) {
            ebCalls.push(command);
            assert(command instanceof DescribeEnvironmentsCommand);
            return { Environments: [{ EnvironmentName: "werewolf-env", ApplicationName: "werewolf-app", VersionLabel: "v3-42", Status: "Ready", Health: "Green", HealthStatus: "Ok", AbortableOperationInProgress: false }] };
        },
    };

    const environment = await manager.describeEnvironment({ environmentName: "werewolf-env", client: envClient });
    assert.strictEqual(environment.ApplicationName, "werewolf-app");
    assert.strictEqual(ebCalls[0].input.EnvironmentNames[0], "werewolf-env");

    const versionClient = {
        async send(command) {
            ebCalls.push(command);
            assert(command instanceof DescribeApplicationVersionsCommand);
            if (command.input.NextToken) {
                return {
                    ApplicationVersions: [{ VersionLabel: "v3-41", Status: "Processed", DateCreated: "2026-09-20T00:00:00Z", SourceBundle: { S3Bucket: "bucket", S3Key: "older.zip" } }],
                };
            }
            return {
                NextToken: "page-2",
                ApplicationVersions: [
                    { VersionLabel: "v3-40", Status: "Processed", DateCreated: "2026-09-18T00:00:00Z", SourceBundle: { S3Bucket: "bucket", S3Key: "old.zip" } },
                    { VersionLabel: "v3-42", Status: "Processed", DateCreated: "2026-09-21T00:00:00Z", SourceBundle: { S3Bucket: "bucket", S3Key: "current.zip" } },
                ],
            };
        },
    };
    const versions = await manager.listApplicationVersions({ applicationName: "werewolf-app", client: versionClient });
    assert.deepStrictEqual(versions.map((v) => v.versionLabel), ["v3-42", "v3-41", "v3-40"]);
    assert(versions.every((v) => !Object.prototype.hasOwnProperty.call(manager.publicApplicationVersion(v), "__sourceBucket")));

    const exactClient = {
        async send(command) {
            assert(command instanceof DescribeApplicationVersionsCommand);
            assert.deepStrictEqual(command.input.VersionLabels, ["v3-41"]);
            return { ApplicationVersions: [{ VersionLabel: "v3-41", Status: "Processed", SourceBundle: { S3Bucket: "bucket", S3Key: "exact.zip" } }] };
        },
    };
    const exact = await manager.getApplicationVersion({ applicationName: "werewolf-app", versionLabel: "v3-41", client: exactClient });
    assert.strictEqual(exact.__sourceBucket, "bucket");
    assert.strictEqual(exact.__sourceKey, "exact.zip");

    let updateCommand;
    const deployClient = {
        async send(command) {
            assert(command instanceof UpdateEnvironmentCommand);
            updateCommand = command;
            return { EnvironmentName: "werewolf-env", VersionLabel: command.input.VersionLabel, Status: "Updating" };
        },
    };
    await manager.deployApplicationVersion({ environmentName: "werewolf-env", versionLabel: "v3-41", client: deployClient });
    assert.deepStrictEqual(updateCommand.input, { EnvironmentName: "werewolf-env", VersionLabel: "v3-41" });

    const sourceClient = {
        async send(command) {
            assert(command instanceof GetObjectCommand);
            s3Calls.push(command);
            return { Body: "stream-placeholder", ContentLength: 123 };
        },
    };
    const object = await manager.getSourceBundleObject({ version: exact, client: sourceClient });
    assert.strictEqual(object.ContentLength, 123);
    assert.deepStrictEqual(s3Calls[0].input, { Bucket: "bucket", Key: "exact.zip" });

    const filename = manager.makeSafeDownloadFilename("release/2026 #42");
    assert.strictEqual(filename, "werewolf-online-release-2026-42.zip");
    assert.strictEqual(manager.isKnownDeployableStatus("Failed"), false);
    assert.strictEqual(manager.isKnownDeployableStatus("Processed"), true);
    assert.strictEqual(manager.isKnownDeployableStatus("Unprocessed"), true);

    console.log("elastic-beanstalk-version-manager-regression: PASS");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Module._load = originalLoad;
});
