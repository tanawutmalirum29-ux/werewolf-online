const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const hostCss = fs.readFileSync(path.join(root, "public", "css", "host.css"), "utf8");
const hostJs = fs.readFileSync(path.join(root, "public", "js", "host.main.js"), "utf8");
const playerCss = fs.readFileSync(path.join(root, "public", "css", "player.css"), "utf8");
const playerJs = fs.readFileSync(path.join(root, "public", "js", "player.main.js"), "utf8");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function loadPurePlayerGridFunction(source) {
    const start = source.indexOf("function computePlayerGridLayout");
    const end = source.indexOf("\nfunction getPlayerGridMetrics", start);
    assert(start >= 0 && end > start, "player grid pure function boundaries must exist");
    const sandbox = { module: { exports: null } };
    vm.runInNewContext(source.slice(start, end) + "\nmodule.exports = computePlayerGridLayout;", sandbox);
    return sandbox.module.exports;
}

const computePlayerGridLayout = loadPurePlayerGridFunction(playerJs);

// Host grid: automatic mode is the default and uses the real container width, not a viewport breakpoint.
assert(hostCss.includes("--host-player-grid-min:50px;"), "host grid minimum track must be 50px");
assert(hostCss.includes("grid-template-columns:repeat(auto-fit, minmax(min(100%, var(--host-player-grid-min)), 1fr));"), "host grid must auto-fit against real available width");
assert(!/\@media\s*\([^}]*max-width:\s*480px\)[\s\S]{0,300}\.players-grid\s*\{[\s\S]*grid-template-columns:repeat\(2/.test(hostCss), "host grid must not have a fixed mobile 2-column override");
assert(!/\@media\s*\([^}]*481px[^}]*1279px[\s\S]{0,500}\.players-grid\s*\{[\s\S]*grid-template-columns:repeat\(5/.test(hostCss), "host grid must not have a fixed tablet 5-column override");
assert(hostJs.includes('const GRID_COLS_DEFAULTS = { mobile: null, tablet: null, "tablet-landscape-full": null, desktop: null };'), "host grid defaults must be automatic");
assert(hostJs.includes('list.style.removeProperty("grid-template-columns")'), "host auto mode must clear stale inline grid columns");
assert(hostJs.includes('listSimple.style.removeProperty("grid-template-columns")'), "host auto mode must clear stale simple-list inline columns");
assert(hostJs.includes("cardFitObserver = new ResizeObserver"), "host must observe card geometry changes");
assert(hostJs.includes("const mo = new MutationObserver"), "host must re-observe live-added/removed cards");
assert(hostJs.includes('window.addEventListener("pageshow", scheduleCardFit'), "host must refit after returning to the page without reload");

// A single/partial row must stay at column 1; no auto-centering transform is allowed.
assert(!hostCss.slice(hostCss.indexOf(".player{"), hostCss.indexOf(".player-inner")).includes("margin-inline:auto"), "host normal player cards must not auto-center");
assert(hostCss.includes('body.host-player-focus #list .player{\n    max-width:var(--host-player-card-standard);\n    width:100%;\n    margin:0;'), "host focus cards must also start at the left edge");
assert(!playerJs.includes("function centerLastRow"), "legacy last-row centering function must be removed");
assert(!playerJs.includes("gridColumnStart"), "player grid must not offset incomplete rows with grid-column positioning");
assert(playerCss.includes("--player-grid-min:50px;"), "player grid fallback minimum must match the balanced layout calculator");
assert(playerCss.includes("justify-items:start;"), "player grid must pin incomplete rows to the left");

// Reproduce the important mobile/container cases mathematically from the actual pure function.
const options = { gap: 6, min: 50, max: 160, preferred: 5, rowGap: 6 };
const at = (w, h, count) => computePlayerGridLayout(w, h, count, options.gap, options.min, options.max, options.rowGap);

assert(at(340, 500, 5).size > 100, "340px/5 players should prioritize readable card size");
assert(at(340, 500, 6).size > 120, "340px/6 players should keep cards large instead of forcing 6 tiny columns");
assert(at(340, 500, 30).columns >= 4 && at(340, 500, 30).columns <= 6, "340px/30 players should choose a balanced grid");
assert(at(340, 500, 40).columns >= 4 && at(340, 500, 40).columns <= 7, "340px/40 players should remain width/height balanced");
assert(at(400, 500, 10).columns >= 2 && at(400, 500, 10).columns <= 4, "400px/10 players should prefer a readable balanced grid");
assert(at(340, 500, 1).columns === 1, "a single player must be one left-anchored column");
assert(at(720, 730, 12).size >= 150, "a wide 12-player area must not collapse cards into tiny circles");
assert(at(720, 730, 12).columns <= 6, "a wide 12-player area must use a balanced column count");
assert(at(690, 600, 37).size >= 85, "a 37-player mobile-like area must remain readable");

// Vertical pressure may shrink the card when the area is genuinely too short. The controller
// must still return a positive layout instead of producing zero/negative dimensions.
const cramped = at(340, 190, 30);
assert(cramped.columns >= 1, "short mobile height must keep a valid column count");
assert(cramped.size > 0 && cramped.size < 50, "genuinely cramped layout should shrink below the normal minimum only when necessary");

// Filtering must trigger a live re-fit instead of waiting for a later resize/reload event.
const filterStart = playerJs.indexOf("function filterPlayerList()");
const filterEnd = playerJs.indexOf("// =====", filterStart + 10);
const filterSegment = playerJs.slice(filterStart, filterEnd > filterStart ? filterEnd : filterStart + 5000);
assert(filterSegment.includes("scheduleFitPlayerGrid(true);"), "filter changes must trigger immediate player-grid refit");

console.log("player-grid-auto-flow-regression: PASS");
