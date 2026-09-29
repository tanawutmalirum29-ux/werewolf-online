const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const ebPath = path.join(root, ".ebextensions", "01-high-availability.config");
const ebAvailable = fs.existsSync(ebPath);
const eb = ebAvailable ? fs.readFileSync(ebPath, "utf8") : "";
const runtimeReplay = process.env.WW_BUG_REPLAY === "1";
const errorReporter = fs.readFileSync(path.join(root, "public", "js", "error-reporter.js"), "utf8");
const fallback = fs.readFileSync(path.join(root, "cloudfront-errors", "server-unavailable.html"), "utf8");
const cfSetup = fs.readFileSync(path.join(root, "CLOUDFRONT-FAILOVER-SETUP.md"), "utf8");

function must(label, condition) {
    assert.ok(condition, `FAIL: ${label}`);
    console.log(`PASS: ${label}`);
}

if (ebAvailable) {
    must("immutable deployment is configured", eb.includes("DeploymentPolicy: Immutable"));
    must("configuration updates are immutable", eb.includes("RollingUpdateType: Immutable"));
    must("minimum capacity keeps two instances", eb.includes("MinSize: '2'"));
    must("maximum capacity is bounded", eb.includes("MaxSize: '4'"));
    must("strict readiness path is /ready", eb.includes("HealthCheckPath: /ready"));
    must("load balancer stickiness is enabled for Socket.IO handshake/session continuity", eb.includes("StickinessEnabled: 'true'"));
} else if (runtimeReplay) {
    console.log("SKIP: EB/ALB source manifest is not present in deployed runtime; source contract is verified before deployment and runtime drain/readiness checks continue below");
} else {
    must("EB/ALB source manifest is present", false);
}
must("server exposes liveness endpoint before the server-state gate", server.indexOf('app.get("/health"') < server.indexOf('app.use(async (req, res, next) => {\n    await serverStateReady;'));
must("server exposes strict readiness endpoint", server.includes('app.get("/ready"'));
must("draining flips before shutdown work", server.includes('appDraining = true;') && server.includes('marking instance draining before closing WebSocket connections'));
must("new Socket.IO handshakes are rejected during drain", server.includes('code: "SERVER_DRAINING"') && server.includes('if (appDraining)'));
must("shutdown stops the persistence scan", server.includes('clearInterval(roomPersistenceScanTimer);') && server.includes('roomPersistenceScanTimer = null;'));
must("shutdown cancels pending room snapshot debounce timers", server.includes('for (const timer of roomPersistenceTimers.values()) clearTimeout(timer);') && server.includes('roomPersistenceTimers.clear();'));
must("shutdown performs a final room snapshot flush", server.includes('flushRoomPersistenceForShutdown("final")'));
must("shutdown waits for Socket.IO connections to drain before final snapshot", server.includes("async function waitForSocketDrain") && server.includes("const socketDrained = await waitForSocketDrain()"));
must("shutdown waits for in-flight data writes around final snapshot", server.includes('waitForGameDataWritesDrain(Math.min(5_000, SHUTDOWN_ROOM_PERSIST_TIMEOUT_MS))'));
must("shutdown keeps a bounded grace period", server.includes('SHUTDOWN_GRACE_MS') && server.includes('process.exit(1)'));
must("diagnostics ignore expected server-draining handshake errors", errorReporter.includes('connectErrorMessage !== "server_draining"'));
must("CloudFront fallback covers 502/503/504", /502[\s\S]*503[\s\S]*504/.test(cfSetup));
must("CloudFront fallback is standalone", !fallback.includes('src="') && !fallback.includes('href="'));

console.log("deploy-drain-persistence regression: PASS");
