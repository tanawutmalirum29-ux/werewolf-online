const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "public", "css", "host.css"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "js", "host.main.js"), "utf8");
const html = fs.readFileSync(path.join(root, "public", "host.html"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(css.includes("--host-player-card-standard:160px;"), "player card standard width must be explicitly fixed");
assert(css.includes("--host-player-card-canvas:220px;"), "player card inner canvas standard must be explicit");
assert(css.includes("grid-template-columns:repeat(auto-fit, minmax(min(100%, var(--host-player-grid-min)), 1fr));"), "base player grid must auto-fit from a small real-width threshold");
assert(css.includes("--host-player-grid-min:50px;"), "base player grid must define a 50px minimum track so columns can grow before player-count thresholds");
assert(css.includes("max-width:var(--host-player-card-standard);"), "player cards must never grow beyond the standard width");
assert(!css.includes("body.host-player-focus #list .player{\n    max-width:none;"), "focus mode must not remove the standard card width cap");
assert(css.includes("body.host-player-focus #list .player{\n    max-width:var(--host-player-card-standard);"), "focus mode must retain the standard card cap");
assert(css.includes("overflow:visible !important;\n    align-self:stretch;"), "player panel/list must flow with page instead of nested scrolling");
assert(css.includes("body:not(.setup-mode) .layout:not(.role-hidden) #rightCol .host-player-card,\nbody.host-game-mode .layout:not(.role-hidden) #rightCol .host-player-card"), "normal player panel must be allowed to size itself to content");
assert(js.includes("const CARD_BASE_SIZE = 220;"), "uniform inner-card reference size must remain 220px");
assert(js.includes("const scale = Math.min(1, cardWidth / CARD_BASE_SIZE);"), "card typography/content must scale uniformly from the same reference");
assert(js.includes("Math.min(n, count)"), "requested column count must remain bounded by current player count");
assert(html.includes('id="list" class="players-grid"'), "player grid hook missing");
assert(html.includes('id="gridColsInput"'), "grid column control hook missing");

console.log("host-player-grid-standard-regression: PASS");
