"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const utility = require(path.join(root, "utils", "elastic-beanstalk-version-manager.js"));
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "admin.html"), "utf8");
const versionsJs = fs.readFileSync(path.join(root, "public", "js", "admin-versions.js"), "utf8");
const versionsCss = fs.readFileSync(path.join(root, "public", "css", "admin-versions.css"), "utf8");
const shell = fs.readFileSync(path.join(root, "public", "js", "admin-shell.js"), "utf8");
const registry = fs.readFileSync(path.join(root, "public", "js", "admin-command-registry.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.strictEqual(utility.isValidVersionLabel("v3-42"), true);
assert.strictEqual(utility.isValidVersionLabel(" v3-42 "), false);
assert.strictEqual(utility.isValidVersionLabel("v3\n42"), false);
assert.strictEqual(utility.isKnownDeployableStatus("Processed"), true);
assert.strictEqual(utility.isKnownDeployableStatus("Unprocessed"), true);
assert.strictEqual(utility.isKnownDeployableStatus("Failed"), false);

const a = utility.normalizeApplicationVersion({
    VersionLabel: "v3-42",
    Description: "old release",
    Status: "Processed",
    DateCreated: "2026-09-20T01:00:00Z",
    DateUpdated: "2026-09-20T02:00:00Z",
    SourceBundle: { S3Bucket: "private-eb-bucket", S3Key: "apps/v3-42.zip" },
});
const b = utility.normalizeApplicationVersion({
    VersionLabel: "v3-43",
    Status: "Processed",
    DateCreated: "2026-09-21T01:00:00Z",
    DateUpdated: "2026-09-21T02:00:00Z",
    SourceBundle: { S3Bucket: "private-eb-bucket", S3Key: "apps/v3-43.zip" },
});
assert.strictEqual(a.downloadable, true);
assert.deepStrictEqual(utility.publicApplicationVersion(a), {
    versionLabel: "v3-42",
    description: "old release",
    status: "Processed",
    dateCreated: "2026-09-20T01:00:00.000Z",
    dateUpdated: "2026-09-20T02:00:00.000Z",
    downloadable: true,
});
assert(utility.compareApplicationVersions(a, b) > 0, "newer version must sort first");
assert.strictEqual(utility.makeSafeDownloadFilename("v3/42"), "werewolf-online-v3-42.zip");

assert(pkg.dependencies["@aws-sdk/client-elastic-beanstalk"]);
assert(pkg.dependencies["@aws-sdk/client-s3"]);
assert(server.includes('app.get("/api/eb-version-download/:ticket"'), "ticket download route missing");
assert(server.includes('app.get("/api/admin/versions"'), "versions list route missing");
assert(server.includes('app.post("/api/admin/versions/rollback"'), "rollback route missing");
assert(server.includes('app.post("/api/admin/versions/download-ticket"'), "download-ticket route missing");
assert(server.includes('elasticbeanstalk:DescribeApplicationVersions'), "diagnostic IAM expectation missing");
assert(server.includes('elasticbeanstalk:UpdateEnvironment'), "diagnostic IAM expectation missing");
assert(server.includes('s3:GetObject'), "diagnostic IAM expectation missing");
assert(server.includes('require("./utils/elastic-beanstalk-version-manager")'), "version manager utility is not wired");
assert(server.includes('EB_VERSION_SOURCE_ACCESS_DENIED'), "download permission error code missing");
assert(server.includes('adminTabSessionRevoked.get(String(payload?.adminSessionNonce || ""))'), "download ticket must honor revoked Admin tab sessions");
assert(!server.includes("adminVersionDownloadTickets"), "download ticket must not depend on per-instance RAM state behind a load balancer");
assert(server.includes('EB_VERSION_ENVIRONMENT_BUSY'), "rollback busy guard missing");
assert(fs.readFileSync(path.join(root, "utils", "elastic-beanstalk-version-manager.js"), "utf8").includes("VersionLabel: label"), "rollback utility must deploy the exact requested VersionLabel");
assert(server.indexOf('app.get("/api/eb-version-download/:ticket"') < server.indexOf('app.use(async (req, res, next) => {'), "ticket download route must precede server-closed middleware");
assert(!server.includes('S3Bucket: sourceBucket') || server.includes('sourceBucket'), "sanity");

assert(html.includes('data-admin-nav="versions"'), "Admin Versions nav missing");
assert((html.match(/data-admin-nav="/g) || []).length === 8, "Admin nav count drifted — mobile nav must account for Versions");
assert((fs.readFileSync(path.join(root, "public", "css", "admin-shell.css"), "utf8")).includes("grid-template-columns:repeat(8,minmax(0,1fr));gap:3px;"), "Mobile Admin nav must expose all 8 sections without overflow");
assert(html.includes('id="tab-versions"'), "Admin Versions panel missing");
assert(html.includes('id="adminVersionsList"'), "Admin Versions list missing");
assert(html.includes('/css/admin-versions.css?v=20260926-1'), "Admin Versions CSS cache-buster missing");
assert(html.includes('/js/admin-versions.js?v=20260926-1'), "Admin Versions JS cache-buster missing");
assert(html.includes('next === "versions"'), "Versions switchTab branch missing");
assert(html.includes('versions: { title:"เวอร์ชันเกม"'), "Versions page metadata missing");

assert(versionsJs.includes('window.loadAdminVersions'), "loadAdminVersions is not exported");
assert(versionsJs.includes('/api/admin/versions'), "versions list endpoint missing in client");
assert(versionsJs.includes('/api/admin/versions/download-ticket'), "download ticket endpoint missing in client");
assert(versionsJs.includes('/api/admin/versions/rollback'), "rollback endpoint missing in client");
assert(versionsCss.includes('@media'), "Versions page needs responsive CSS");
assert(shell.includes('versions: "loadAdminVersions"'), "Admin shell refresh handler missing");
assert(shell.includes('v:"versions"'), "Admin shell g-v shortcut missing");
assert(registry.includes('versions.open'), "command palette Versions command missing");

// Verify the browser-side module parses without a browser or DOM dependency.
new vm.Script(versionsJs, { filename: "admin-versions.js" });
console.log("admin-version-manager-contract: PASS");
