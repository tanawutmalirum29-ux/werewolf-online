const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const version = fs.readFileSync(path.join(root, "utils", "getAppVersion.js"), "utf8");
const detector = fs.readFileSync(path.join(root, "public", "js", "shared.update-check.js"), "utf8");
const index = fs.readFileSync(path.join(root, "public", "js", "index.auto-update.js"), "utf8");
const ebPath = path.join(root, ".ebextensions", "01-high-availability.config");
const ebAvailable = fs.existsSync(ebPath);
const eb = ebAvailable ? fs.readFileSync(ebPath, "utf8") : "";
const runtimeReplay = process.env.WW_BUG_REPLAY === "1";

function must(name, condition) {
    assert.ok(condition, `FAIL: ${name}`);
    console.log(`PASS: ${name}`);
}

if (ebAvailable) must("EB deployment policy remains Immutable", eb.includes("DeploymentPolicy: Immutable"));
else if (runtimeReplay) console.log("SKIP: EB source-only .ebextensions manifest is not present in deployed runtime; runtime deployment behavior is validated through server readiness/state contracts");
else must("EB deployment manifest is present", false);
must("/ready does not depend on EB deploymentState", !server.includes("const ready = baseReady && adminReady && environmentState.deploymentState === \"ready\";"));
must("version utility reads Environment Status", version.includes("environment?.Status"));
must("version utility maps Ready to safe deployment state", version.includes('return status === "Ready" ? "ready" : (status === "unknown" ? "unknown" : "updating");'));
must("version utility exposes cached environment state", version.includes("getCachedAppEnvironmentState"));
must("/api/config exposes deploymentState", server.includes("deploymentState: environmentState.deploymentState"));
must("/api/config exposes deploymentInProgress", server.includes("deploymentInProgress: environmentState.deploymentState === \"updating\""));
must("fresh deployment probe exists", server.includes("const deploymentProbe = req.query.deploymentProbe === \"1\""));
must("fresh deployment probe forces EB status refresh", server.includes("getAppEnvironmentState({ force: deploymentProbe })"));
must("update detector suppresses updates during deployment", detector.includes('if (deploymentState !== "ready")'));
must("update detector performs a fresh probe after mismatch", detector.includes("/api/config?deploymentProbe=1"));
must("Host/Player client refresh receives deployment state", fs.readFileSync(path.join(root, "public", "js", "host.main.js"), "utf8").includes("wwCheckClientVersion(info && info.clientHash, info && info.deploymentState)") && fs.readFileSync(path.join(root, "public", "js", "player.main.js"), "utf8").includes("wwCheckClientVersion(info && info.clientHash, info && info.deploymentState)"));
must("shared client refresh suppresses Immutable transition", fs.readFileSync(path.join(root, "public", "js", "shared.server-control.js"), "utf8").includes('if (deployment && deployment !== "ready") return;'));
must("Host/Player refresh re-probes deployment before reload", fs.readFileSync(path.join(root, "public", "js", "shared.server-control.js"), "utf8").includes('window.wwGetConfig({ url: "/api/config?deploymentProbe=1"') && fs.readFileSync(path.join(root, "public", "js", "shared.server-control.js"), "utf8").includes('String(cfg.clientHash) !== expected'));
must("socket serverInfo carries deployment state", server.includes("deploymentState: getCachedAppEnvironmentState().deploymentState"));
must("Index continues using the shared detector", index.includes("window.WWUpdateDetector.check()"));
must("Index does not independently interpret EB status", !index.includes("deploymentState") || index.includes("WWUpdateDetector"));

console.log("deployment-aware update regression: PASS");
