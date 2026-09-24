const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const playerHtml = fs.readFileSync(path.join(root, "public", "player.html"), "utf8");
const playerCss = fs.readFileSync(path.join(root, "public", "css", "player.css"), "utf8");
const playerJs = fs.readFileSync(path.join(root, "public", "js", "player.main.js"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

// Explicitly bind this suite to the Player page's #players grid. Host #list is intentionally out of scope.
assert(playerHtml.includes('<div id="players"></div>'), "player.html #players grid hook missing");
assert(playerHtml.includes('<div class="card hidden" id="playersCard">'), "player.html #playersCard missing");
assert(playerCss.includes("#players{"), "player.css #players grid styles missing");
assert(playerJs.includes("function computePlayerGridLayout"), "Player grid layout controller missing");
assert(playerJs.includes('playerGridSmallFitStreak'), "Player grid must guard against transient tiny measurements");
assert(playerJs.includes('el.style.removeProperty("--player-card-size")'), "Player grid must clear transient inline sizing before settling");
assert(playerJs.includes("function renderPlayerCardFallback"), "Player grid must keep a per-card render fallback");
assert(playerJs.includes('window.WWDiagnostic.breadcrumb("player-grid.render-fallback"'), "Player grid fallback must record a diagnostic breadcrumb");
assert(playerJs.includes("scheduleFitPlayerGrid(false);\n\n    return mode;"), "Player grid render must refit after room updates");
assert(playerJs.includes('el.dataset.gridFitStatus = "empty"'), "Player grid must clear stale sizing state when no players remain");
assert(playerJs.includes('const suspiciousCollapsedHeight = metrics.height < 120'), "Player grid must detect collapsed transient measurements");
assert(playerJs.includes('window.addEventListener("pageshow", refit, { passive: true });'), "Player grid pageshow recovery hook missing");
assert(playerJs.includes('window.addEventListener("orientationchange", refit, { passive: true });'), "Player grid orientation recovery hook missing");
assert(playerJs.includes('document.addEventListener("visibilitychange"'), "Player grid visibility recovery hook missing");
assert(playerJs.includes('window.visualViewport.addEventListener("resize", () => scheduleFitPlayerGrid(true)'), "Player grid visual viewport recovery hook missing");
assert(playerCss.includes("justify-content:start;"), "Player grid must keep incomplete rows left-anchored");

// Always-available Node fallback: models the same width/height-driven controller for every
// add/remove/rotation state, so the regression remains useful even on machines without Playwright.
const start = playerJs.indexOf("function computePlayerGridLayout");
const end = playerJs.indexOf("\nfunction getPlayerGridMetrics", start);
assert(start >= 0 && end > start, "Player grid pure function boundaries must exist");
const sandboxSource = playerJs.slice(start, end) + "\nmodule.exports = computePlayerGridLayout;";
const sandbox = { module: { exports: null } };
require("vm").runInNewContext(sandboxSource, sandbox);
const computePlayerGridLayout = sandbox.module.exports;

const gap = 6;
const min = 50;
const max = 160;
const layoutAt = (w, h, count) => computePlayerGridLayout(w, h, count, gap, min, max, gap);
const pureScenarios = [
    { name: "mobile", w: 340, h: 470, counts: [1, 5, 6, 12, 18, 30] },
    { name: "tablet", w: 540, h: 760, counts: [1, 5, 8, 12, 18, 24, 30] },
    { name: "desktop", w: 760, h: 720, counts: [1, 5, 8, 12, 18, 24, 30] },
];
for (const scenario of pureScenarios) {
    for (const count of scenario.counts) {
        const layout = layoutAt(scenario.w, scenario.h, count);
        assert(layout && layout.columns >= 1 && layout.rows >= 1 && layout.size > 0, `${scenario.name} ${count}: invalid layout`);
        assert(layout.columns <= count, `${scenario.name} ${count}: columns exceed player count`);
        if (count === 6 && scenario.name === "mobile") {
            assert(layout.size >= 120, `mobile six-player grid should prioritize readable cards: ${JSON.stringify(layout)}`);
            assert(layout.columns <= 3, `mobile six-player grid should stay balanced: ${JSON.stringify(layout)}`);
        }
    }
}
for (const count of [10, 3, 17, 2, 19]) {
    const layout = layoutAt(540, 760, count);
    assert(layout.columns >= 1 && layout.size > 0, `live add/remove simulation failed at ${count} players`);
}
const rotated = layoutAt(470, 340, 11);
assert(rotated && rotated.columns >= 1 && rotated.rows >= 1 && rotated.size > 0, "rotation simulation must keep the grid valid");
const wideFew = layoutAt(720, 730, 12);
assert(wideFew.size >= 150, `wide 12-player grid must not collapse into tiny circles: ${JSON.stringify(wideFew)}`);
assert(wideFew.columns <= 6, `wide 12-player grid must use a balanced column count: ${JSON.stringify(wideFew)}`);
const mobileMany = layoutAt(690, 600, 37);
assert(mobileMany.size >= 85, `37-player grid must remain readable: ${JSON.stringify(mobileMany)}`);
console.log("player-html-grid-responsive-node-simulation: PASS");

// Browser-level validation is run when the environment has Python Playwright. This uses
// the actual player.css + player.main.js controller and getBoundingClientRect() values.
const py = spawnSync("python3", [path.join(__dirname, "player-html-grid-responsive-browser.py")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
});
if (py.status === 0) {
    process.stdout.write(py.stdout);
    process.stderr.write(py.stderr);
    console.log("player-html-grid-responsive-browser: PASS");
} else if (py.status === 2) {
    console.log("player-html-grid-responsive-browser: SKIP (Playwright unavailable)");
} else {
    const combined = `${py.stdout || ""}\n${py.stderr || ""}`;
    if (/Executable doesn't exist|No module named 'playwright'|playwright.*not installed/i.test(combined)) {
        console.log("player-html-grid-responsive-browser: SKIP (Playwright unavailable)");
    } else {
        throw new Error(`Chromium Player-grid browser suite failed (exit ${py.status}).\nSTDOUT:\n${py.stdout}\nSTDERR:\n${py.stderr}`);
    }
}

console.log("player-html-grid-responsive-regression: PASS");
