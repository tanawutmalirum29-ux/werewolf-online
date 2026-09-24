const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const eb = fs.readFileSync(path.join(root, ".ebextensions", "01-high-availability.config"), "utf8");
const fallback = fs.readFileSync(path.join(root, "cloudfront-errors", "server-unavailable.html"), "utf8");
const readme = fs.readFileSync(path.join(root, "CLOUDFRONT-FAILOVER-SETUP.md"), "utf8");

function must(name, condition) {
    assert.ok(condition, `FAIL: ${name}`);
    console.log(`PASS: ${name}`);
}

must("EB environment name is explicitly defined", server.includes('const EB_ENVIRONMENT_NAME = String(process.env.EB_ENVIRONMENT_NAME || "").trim();'));
must("Elastic Beanstalk uses Immutable deployment", eb.includes("DeploymentPolicy: Immutable"));
must("Elastic Beanstalk immutable update policy is enabled", eb.includes("RollingUpdateType: Immutable"));
must("Load Balancer health check uses strict /ready gate", eb.includes("HealthCheckPath: /ready"));
must("Health route exists", server.includes('app.get("/health"'));
must("Health route is registered before the global server-state gate", server.indexOf('app.get("/health"') < server.indexOf('app.use(async (req, res, next) => {\n    await serverStateReady;'));
must("Room recovery promise is initialized before readiness orchestration uses it", server.indexOf('const roomRecoveryReady = new Promise') < server.indexOf('Promise.all([serverStateReady, roomRecoveryReady])'));
must("App health variables are initialized before server starts", server.indexOf('let appBootReady = false;') < server.indexOf('server.listen(HTTP_PORT'));
must("Unexpected process-level exceptions do not leave a dead Node upstream running", server.includes('terminateAfterProcessError') && server.includes('process.exit(1)'));
must("HTTP listener failures are logged and terminate the instance", server.includes('server.on("error", (err) => {') && server.includes('[server] HTTP listener error:'));
must("Health route is allowed while application is intentionally closed", server.includes('"/health", "/ready"'));
must("Health route remains a lightweight liveness check", server.includes('const alive = !appDraining;') && server.includes('return res.status(alive ? 200 : 503)') && server.includes('recoveryHealthy: !!roomRecoveryHealthy'));
must("Health route keeps boot/recovery details informational", server.includes('bootReady: !!appBootReady') && server.includes('recoveryHealthy: !!roomRecoveryHealthy'));
must("Ready route remains the strict readiness check", server.includes('const baseReady = appBootReady && !appDraining && roomRecoveryHealthy;') && server.includes('const adminReady = adminAuthReadyForDeployment();') && server.includes('const ready = baseReady && adminReady;'));
must("Graceful SIGTERM handling exists", server.includes('process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));'));
must("Graceful shutdown stops accepting HTTP connections", server.includes("server.close((err) => {"));
must("Graceful shutdown closes Socket.IO connections", server.includes("io.close();"));
must("CloudFront fallback page is self-contained", !fallback.includes('src="') && !fallback.includes('href="') && fallback.includes("location.reload()"));
must("Fallback page avoids AWS/CloudFront branding", !/CloudFront|Elastic Beanstalk|Amazon Web Services/i.test(fallback));
must("CloudFront setup keeps error page on separate origin", readme.includes("S3 bucket แยกจาก Elastic Beanstalk origin"));
must("CloudFront setup covers 502/503/504", readme.includes("`502`, `503`, `504`"));

// The old server-side EB helper must remain removed; the central utility owns VersionLabel lookup.
must("server.js does not instantiate the EB SDK directly", !server.includes("ElasticBeanstalkClient, DescribeEnvironmentsCommand"));
must("server diagnostics can safely report EB configuration", server.includes("ebEnvironmentConfigured: !!EB_ENVIRONMENT_NAME"));

console.log("✅ infrastructure resilience regression checks passed");
