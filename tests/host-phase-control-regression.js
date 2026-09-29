const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "host.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "js", "host.main.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "css", "host.css"), "utf8");

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

// One authoritative restart renderer.
assertOk((html.match(/id="restartRoomBtn"/g) || []).length === 1, "exactly one restart button must exist");
assertOk(!html.includes('id="focusRestartBtn"'), "legacy duplicate focus restart button must not exist");
const floatingStart = html.indexOf('<div class="floating-bar">');
assertOk(floatingStart >= 0, "floating dock missing");
assertOk(html.indexOf('id="restartRoomBtn"') > floatingStart, "restart button must be inside floating dock");

// Exact phase visibility state machine.
assertOk(js.includes('const gameInProgress = !!room.started && !room.gameOver;'), "game state guard missing");
assertOk(js.includes('const showStartNight = gameInProgress && !room.isNight;'), "start-night must be day-only");
assertOk(js.includes('const showResolveNight = gameInProgress && !!room.isNight;'), "resolve must be night-only");
assertOk(js.includes('startNightBtn.classList.toggle("hidden", !showStartNight);'), "start-night visibility toggle missing");
assertOk(js.includes('resolveBtn.classList.toggle("hidden", !showResolveNight);'), "resolve visibility toggle missing");

// Daytime bottom-dock text must have an explicit high-contrast override outside .app.
assertOk(css.includes('body.is-day .floating-context-kicker{\n    color:#06303c !important;'), "day kicker contrast override missing");
assertOk(css.includes('body.is-day .floating-context-copy{\n    color:#245463 !important;'), "day context contrast override missing");
assertOk(css.includes('body.is-day .floating-bar .btn-ghost{\n    color:#08323f !important;'), "day ghost-button contrast override missing");

// Execute the real updater against a tiny fake DOM to verify the visible state,
// not just the presence of strings in source.
const vm = require("vm");
const fnStart = js.indexOf("function updateNightFlowButtons(room)");
const fnEnd = js.indexOf("// ROLE UI", fnStart);
assertOk(fnStart >= 0 && fnEnd > fnStart, "cannot isolate host phase updater");
const fnSource = js.slice(fnStart, fnEnd);

function makeElement() {
  const classes = new Set();
  return {
    disabled: false,
    textContent: "",
    dataset: {},
    classList: {
      toggle(name, force) {
        if (force) classes.add(name); else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    _classes: classes,
  };
}

const ids = [
  "dayNightBadge", "dnIcon", "dnText", "startGameBtn", "restartRoomBtn",
  "startNightBtn", "resolveBtn", "voteBtn", "roleSettingsCard"
];
const elements = Object.fromEntries(ids.map((id) => [id, makeElement()]));
const layout = makeElement();
const body = makeElement();
const document = {
  body: { classList: body.classList },
  getElementById(id) { return elements[id] || null; },
  querySelector(selector) { return selector === ".layout" ? layout : null; },
  querySelectorAll() { return []; },
};

const context = {
  console,
  document,
  roleConfig: {},
  playerFocusMode: false,
  updateHostControlChrome() {},
  syncHostTimeTheme() { return false; },
  persistHostRoomTheme() {},
  setPlayerFocusMode() {},
  refreshGridColsForBreakpoint() {},
};
vm.runInNewContext(`${fnSource}\nthis.updateNightFlowButtons = updateNightFlowButtons;`, context);

function resetElements() {
  for (const el of Object.values(elements)) {
    el.disabled = false;
    el._classes.clear();
    el.dataset = {};
    el.textContent = "";
  }
}
function visible(id) { return !elements[id]._classes.has("hidden"); }

// Day: Start Night visible, Round Summary hidden.
resetElements();
context.updateNightFlowButtons({ started: true, gameOver: false, isNight: false, dayCount: 1, nightCount: 0, players: [], config: {} });
assertOk(visible("startNightBtn"), "Start Night must be visible during daytime");
assertOk(!visible("resolveBtn"), "Round Summary must be hidden during daytime");
assertOk(!elements.startNightBtn.disabled, "Start Night must be enabled during daytime");
assertOk(elements.resolveBtn.disabled, "Round Summary must be disabled during daytime");
assertOk(visible("restartRoomBtn"), "restart must remain available while game is active");

// Night: Round Summary visible, Start Night hidden.
resetElements();
context.updateNightFlowButtons({ started: true, gameOver: false, isNight: true, dayCount: 1, nightCount: 1, players: [], config: {} });
assertOk(!visible("startNightBtn"), "Start Night must be hidden during nighttime");
assertOk(visible("resolveBtn"), "Round Summary must be visible during nighttime");
assertOk(elements.startNightBtn.disabled, "Start Night must be disabled during nighttime");
assertOk(!elements.resolveBtn.disabled, "Round Summary must be enabled during nighttime");
assertOk(visible("restartRoomBtn"), "restart must remain available during nighttime");

// Pre-game/game-over: both phase transition buttons are absent.
for (const room of [
  { started: false, gameOver: false, isNight: false, players: [], config: {} },
  { started: true, gameOver: true, isNight: false, players: [], config: {} },
]) {
  resetElements();
  context.updateNightFlowButtons(room);
  assertOk(!visible("startNightBtn"), "Start Night must be hidden outside active daytime");
  assertOk(!visible("resolveBtn"), "Round Summary must be hidden outside active nighttime");
  assertOk(!visible("restartRoomBtn"), "restart must be hidden outside active game");
}

console.log("host-phase-control-regression: PASS");
