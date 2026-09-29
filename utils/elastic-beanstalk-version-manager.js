"use strict";

// Elastic Beanstalk application-version management lives here so the Admin page
// does not need to know AWS resource names, S3 keys, or deployment semantics.
// AWS SDK modules are loaded lazily: static/regression tests can exercise the
// validation helpers without requiring node_modules in the source ZIP.

const DEFAULT_AWS_REGION = "ap-southeast-7";

function resolveRegion() {
    return String(process.env.AWS_REGION || DEFAULT_AWS_REGION).trim() || DEFAULT_AWS_REGION;
}

function requireElasticBeanstalkSdk() {
    // eslint-disable-next-line global-require
    return require("@aws-sdk/client-elastic-beanstalk");
}

function requireS3Sdk() {
    // eslint-disable-next-line global-require
    return require("@aws-sdk/client-s3");
}

function createElasticBeanstalkClient({ region = resolveRegion(), clientFactory } = {}) {
    if (typeof clientFactory === "function") return clientFactory({ region });
    const { ElasticBeanstalkClient } = requireElasticBeanstalkSdk();
    return new ElasticBeanstalkClient({ region });
}

function createS3Client({ region = resolveRegion(), clientFactory } = {}) {
    if (typeof clientFactory === "function") return clientFactory({ region });
    const { S3Client } = requireS3Sdk();
    return new S3Client({ region });
}

function configuredEnvironmentName(value = process.env.EB_ENVIRONMENT_NAME) {
    return String(value || "").trim();
}

function normalizeVersionLabel(value) {
    const label = String(value ?? "").trim();
    return label.slice(0, 100);
}

function isValidVersionLabel(value) {
    const raw = String(value ?? "");
    const label = normalizeVersionLabel(raw);
    return !!label && label === raw && label.length <= 100 && !/[\r\n]/.test(label);
}

function normalizeDate(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isKnownDeployableStatus(status) {
    const normalized = String(status || "").trim();
    return normalized === "Processed" || normalized === "Unprocessed";
}

function isRollbackBlockedStatus(status) {
    const normalized = String(status || "").trim();
    return !isKnownDeployableStatus(normalized);
}

function normalizeApplicationVersion(version = {}) {
    const source = version.SourceBundle || version.sourceBundle || null;
    const bucket = String(version.__sourceBucket || source?.S3Bucket || source?.Bucket || "").trim();
    const key = String(version.__sourceKey || source?.S3Key || source?.Key || "").trim();
    const status = String(version.Status || version.status || "").trim();
    const versionLabel = normalizeVersionLabel(version.VersionLabel || version.versionLabel);
    return {
        versionLabel,
        description: String(version.Description || version.description || "").trim().slice(0, 500),
        status,
        dateCreated: normalizeDate(version.DateCreated || version.dateCreated),
        dateUpdated: normalizeDate(version.DateUpdated || version.dateUpdated),
        downloadable: !!(bucket && key),
        // These fields stay server-side. Use them only for the S3 download call.
        __sourceBucket: bucket,
        __sourceKey: key,
    };
}

function publicApplicationVersion(version = {}) {
    const normalized = normalizeApplicationVersion(version);
    return {
        versionLabel: normalized.versionLabel,
        description: normalized.description,
        status: normalized.status,
        dateCreated: normalized.dateCreated,
        dateUpdated: normalized.dateUpdated,
        downloadable: normalized.downloadable,
    };
}

function compareApplicationVersions(a, b) {
    const ad = Date.parse(a?.dateUpdated || a?.dateCreated || "") || 0;
    const bd = Date.parse(b?.dateUpdated || b?.dateCreated || "") || 0;
    if (ad !== bd) return bd - ad;
    return String(b?.versionLabel || "").localeCompare(String(a?.versionLabel || ""));
}

async function describeEnvironment({ environmentName = configuredEnvironmentName(), client } = {}) {
    const safeEnvName = configuredEnvironmentName(environmentName);
    if (!safeEnvName) throw Object.assign(new Error("EB_ENVIRONMENT_NAME is not configured"), { code: "EB_VERSION_MANAGER_NOT_CONFIGURED" });
    const awsClient = client || createElasticBeanstalkClient();
    const { DescribeEnvironmentsCommand } = requireElasticBeanstalkSdk();
    const result = await awsClient.send(new DescribeEnvironmentsCommand({ EnvironmentNames: [safeEnvName] }));
    const environment = result.Environments?.find((item) => String(item.EnvironmentName || "") === safeEnvName) || result.Environments?.[0];
    if (!environment) throw Object.assign(new Error(`Elastic Beanstalk environment not found: ${safeEnvName}`), { code: "EB_ENVIRONMENT_NOT_FOUND" });
    return environment;
}

async function describeApplicationVersions({ applicationName, versionLabels, nextToken = undefined, client } = {}) {
    const safeAppName = String(applicationName || "").trim();
    if (!safeAppName) throw Object.assign(new Error("Elastic Beanstalk application name is missing"), { code: "EB_APPLICATION_NAME_MISSING" });
    const labels = Array.isArray(versionLabels) ? versionLabels.map(normalizeVersionLabel).filter(Boolean) : undefined;
    const awsClient = client || createElasticBeanstalkClient();
    const { DescribeApplicationVersionsCommand } = requireElasticBeanstalkSdk();
    return awsClient.send(new DescribeApplicationVersionsCommand({
        ApplicationName: safeAppName,
        ...(labels?.length ? { VersionLabels: labels } : {}),
        ...(nextToken ? { NextToken: String(nextToken) } : {}),
    }));
}

async function listApplicationVersions({ applicationName, client } = {}) {
    const out = [];
    let nextToken = undefined;
    do {
        const result = await describeApplicationVersions({ applicationName, nextToken, client });
        for (const item of result.ApplicationVersions || []) out.push(normalizeApplicationVersion(item));
        nextToken = String(result.NextToken || "").trim() || undefined;
    } while (nextToken);
    return out.sort(compareApplicationVersions);
}

async function getApplicationVersion({ applicationName, versionLabel, client } = {}) {
    const label = normalizeVersionLabel(versionLabel);
    if (!isValidVersionLabel(label)) throw Object.assign(new Error("Invalid Elastic Beanstalk version label"), { code: "EB_VERSION_LABEL_INVALID" });
    const result = await describeApplicationVersions({ applicationName, versionLabels: [label], client });
    const found = result.ApplicationVersions?.find((item) => String(item.VersionLabel || "").trim() === label);
    if (!found) throw Object.assign(new Error(`Elastic Beanstalk application version not found: ${label}`), { code: "EB_VERSION_NOT_FOUND" });
    return normalizeApplicationVersion(found);
}

async function deployApplicationVersion({ environmentName = configuredEnvironmentName(), versionLabel, client } = {}) {
    const safeEnvName = configuredEnvironmentName(environmentName);
    const label = normalizeVersionLabel(versionLabel);
    if (!safeEnvName) throw Object.assign(new Error("EB_ENVIRONMENT_NAME is not configured"), { code: "EB_VERSION_MANAGER_NOT_CONFIGURED" });
    if (!isValidVersionLabel(label)) throw Object.assign(new Error("Invalid Elastic Beanstalk version label"), { code: "EB_VERSION_LABEL_INVALID" });
    const awsClient = client || createElasticBeanstalkClient();
    const { UpdateEnvironmentCommand } = requireElasticBeanstalkSdk();
    return awsClient.send(new UpdateEnvironmentCommand({ EnvironmentName: safeEnvName, VersionLabel: label }));
}

async function getSourceBundleObject({ version, client } = {}) {
    const sourceBucket = String(version?.__sourceBucket || "").trim();
    const sourceKey = String(version?.__sourceKey || "").trim();
    if (!sourceBucket || !sourceKey) {
        throw Object.assign(new Error("Elastic Beanstalk application version has no source bundle"), { code: "EB_VERSION_SOURCE_NOT_FOUND" });
    }
    const awsClient = client || createS3Client();
    const { GetObjectCommand } = requireS3Sdk();
    return awsClient.send(new GetObjectCommand({ Bucket: sourceBucket, Key: sourceKey }));
}

function makeSafeDownloadFilename(versionLabel) {
    const safe = normalizeVersionLabel(versionLabel).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "version";
    return `werewolf-online-${safe}.zip`;
}

module.exports = {
    DEFAULT_AWS_REGION,
    resolveRegion,
    configuredEnvironmentName,
    normalizeVersionLabel,
    isValidVersionLabel,
    normalizeApplicationVersion,
    publicApplicationVersion,
    compareApplicationVersions,
    isKnownDeployableStatus,
    isRollbackBlockedStatus,
    describeEnvironment,
    describeApplicationVersions,
    listApplicationVersions,
    getApplicationVersion,
    deployApplicationVersion,
    getSourceBundleObject,
    makeSafeDownloadFilename,
};
