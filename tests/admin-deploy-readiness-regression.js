const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const requiredFixture = ".ebextensions/01-high-availability.config";
if (!fs.existsSync(path.join(root, requiredFixture))) {
    console.log(`SKIP: deployment fixture missing: ${requiredFixture}`);
    process.exit(0);
}
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const health = fs.readFileSync(path.join(root, ".ebextensions", "01-high-availability.config"), "utf8");
const admin = fs.readFileSync(path.join(root, "public", "admin.html"), "utf8");

assert(server.includes("function adminAuthReadyForDeployment()"), "deployment admin auth readiness helper missing");
assert(server.includes("return !!ADMIN_AUTH_CONFIGURED || !EB_ENVIRONMENT_NAME;"), "production readiness must require admin auth");
assert(server.includes("const adminReady = adminAuthReadyForDeployment();"), "ready endpoint must gate on admin auth readiness");
assert(server.includes('status = "admin_auth_not_configured"'), "ready endpoint must expose the exact admin auth gate reason");
assert(server.includes('code: appDraining ? "ADMIN_SERVER_DRAINING" : "ADMIN_SERVER_WARMING"'), "admin session must distinguish deployment warming/draining from missing configuration");
assert(health.includes("HealthCheckPath: /ready"), "Elastic Beanstalk health check must use strict readiness");
assert(admin.includes("ADMIN_SERVER_WARMING"), "admin UI must recognize deployment warming");
assert(admin.includes("ADMIN_SERVER_DRAINING"), "admin UI must recognize deployment draining");
assert(admin.includes("scheduleAdminWarmupRetry"), "admin UI must retry automatically after deployment warm-up");
assert(admin.includes("closeAdminLoginModal(true);"), "admin UI must close the warm-up notice when authenticated again");
assert(admin.includes("เซิร์ฟเวอร์กำลังเริ่มรุ่นใหม่"), "admin UI must show a deployment-specific message");

console.log("admin-deploy-readiness regression: PASS");
