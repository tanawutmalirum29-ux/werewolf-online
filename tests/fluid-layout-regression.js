const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const playerHtml = fs.readFileSync(path.join(root, "public", "player.html"), "utf8");
const hostHtml = fs.readFileSync(path.join(root, "public", "host.html"), "utf8");
const fluidJs = fs.readFileSync(path.join(root, "public", "js", "fluid-layout.js"), "utf8");
const playerCss = fs.readFileSync(path.join(root, "public", "css", "player.css"), "utf8");
const hostCss = fs.readFileSync(path.join(root, "public", "css", "host.css"), "utf8");
const playerMainJs = fs.readFileSync(path.join(root, "public", "js", "player.main.js"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(playerHtml.includes('<script src="js/fluid-layout.js"></script>'), "Player must load fluid-layout.js before main UI code");
assert(hostHtml.includes('<script src="js/fluid-layout.js"></script>'), "Host must load fluid-layout.js before main UI code");
assert(hostHtml.includes("interactive-widget=resizes-visual"), "Host viewport contract must support visual-viewport keyboard mode");

assert(fluidJs.includes("requestAnimationFrame"), "Fluid engine must coalesce live resize work with requestAnimationFrame");
assert(fluidJs.includes("ResizeObserver"), "Fluid engine must observe real container size changes");
assert(fluidJs.includes("visualViewport"), "Fluid engine must handle VisualViewport resize/scroll");
assert(fluidJs.includes("--fluid-game-chat-width"), "Fluid engine must publish Player chat width");
assert(fluidJs.includes("--fluid-host-chat"), "Fluid engine must publish Host chat width");
assert(fluidJs.includes("body.classList.add(\"is-resizing\")"), "Fluid engine must mark active resize state");
assert(playerMainJs.includes('window.addEventListener("resize", () => scheduleFitPlayerGrid(false)'), "Player grid must fit on the live resize frame without a multi-frame settle delay");
assert(!playerMainJs.includes('window.addEventListener("resize", () => scheduleFitPlayerGrid(true)'), "Player grid must not defer live resize fitting by a settle delay");

assert(playerCss.includes("container-name:player-app"), "Player app must be a named container");
assert(playerCss.includes("@container player-viewport (max-width:899px)"), "Player must use viewport-space-aware container query");
assert(playerCss.includes("var(--fluid-game-chat-width)"), "Player game layout must consume the continuous chat-width token");
assert(playerCss.includes("body.is-resizing .player"), "Player must disable geometry animation during live resize");

assert(hostCss.includes("container-name:host-app"), "Host app must be a named container");
assert(hostCss.includes("@container host-viewport (max-width:1019px)"), "Host must use viewport-space-aware layout collapse");
assert(hostCss.includes("var(--fluid-host-chat)"), "Host chat width must come from continuous token");
assert(hostCss.includes("body.is-resizing .host-player-card"), "Host must disable geometry animation during live resize");

console.log("fluid-layout-regression: PASS");
