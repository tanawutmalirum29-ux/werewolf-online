const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "host.html"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "css", "host.css"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "js", "host.main.js"), "utf8");

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

for (const id of ["playerCard", "playerFocusBtn", "list", "listSimple", "chatCard", "focusRestartBtn", "startNightBtn", "resolveBtn", "voteBtn", "reopenGameOverBtn", "reopenPopupBtn"]) {
  assertOk(new RegExp(`id=["']${id}["']`).test(html), `missing focus-mode hook: ${id}`);
}

assertOk(html.includes('onclick="togglePlayerFocusMode()"'), "focus button must call togglePlayerFocusMode");
assertOk(html.includes('aria-pressed="false"'), "focus button must expose initial pressed state");
assertOk(js.includes("let playerFocusMode = false;"), "missing player focus state");
assertOk(js.includes("function setPlayerFocusMode(active)"), "missing player focus setter");
assertOk(js.includes("document.documentElement.classList.toggle(\"host-player-focus\", playerFocusMode);"), "focus mode must lock root state");
assertOk(js.includes("document.body.classList.toggle(\"host-player-focus\", playerFocusMode);"), "focus mode must lock body state");
assertOk(js.includes('event.key === "Escape" && playerFocusMode'), "focus mode must support Escape exit");
assertOk(js.includes('const focusRestartBtn = document.getElementById("focusRestartBtn");'), "focus restart sync missing");
assertOk(js.includes('if (!canFocus && playerFocusMode) setPlayerFocusMode(false);'), "focus mode must auto-exit when host page is not available");

for (const rule of [
  ".host-player-card-head",
  ".player-focus-btn",
  "html.host-player-focus",
  "body.host-player-focus .app",
  "body.host-player-focus .seal-wrap",
  "body.host-player-focus #chatCard",
  "body.host-player-focus #playerCard",
  "body.host-player-focus #list",
  "body.host-player-focus .floating-bar",
  "body.host-player-focus .floating-context",
  "body.host-player-focus .vote-modal-overlay",
  "body.host-player-focus #wwVersionBadge",
  "body.is-day .host-player-card",
  "body.is-day.host-player-focus .floating-bar",
  "@media (max-width:800px)",
  "@media (max-width:480px)",
  "env(safe-area-inset-bottom",
  "100dvh",
  "overflow-y:auto"
]) {
  assertOk(css.includes(rule), `missing focus/day-theme CSS rule: ${rule}`);
}

assertOk(css.includes("html.host-player-focus,\nbody.host-player-focus{\n    width:100%;\n    min-height:100%;\n    height:100%;\n    overflow:hidden;\n}"), "focus mode must lock the document scroll container");
assertOk(css.includes("body.host-player-focus .app{\n    /* Full player mode is a true viewport layer."), "focus app must become the viewport layer");
assertOk(css.includes("overflow:visible !important;\n    overscroll-behavior:visible;"), "player grid must not create a nested scrollbar in focus mode");
assertOk(css.includes("body.host-player-focus #list .player{\n    max-width:var(--host-player-card-standard);"), "focus player cards must retain the standard width cap");
assertOk(css.includes("grid-auto-flow:row;"), "focus player grid must flow across rows instead of forcing a single row");

for (const hiddenSelector of [
  "body.host-player-focus .seal-wrap",
  "body.host-player-focus #leftCol",
  "body.host-player-focus #chatCard",
  "body.host-player-focus #dayNightBadge"
]) {
  assertOk(css.includes(hiddenSelector), `focus mode must hide: ${hiddenSelector}`);
}

assertOk(css.includes(`body.host-player-focus .vote-modal-overlay{\n    z-index:700;`), "focus mode must keep modal dialogs above the fullscreen player panel");
assertOk(css.includes(`body.host-player-focus #wwVersionBadge{\n    display:none !important;`), "focus mode must hide the normal version badge");

for (const actionId of ["startNightBtn", "resolveBtn", "voteBtn", "focusRestartBtn", "reopenGameOverBtn", "reopenPopupBtn"]) {
  assertOk(new RegExp(`id=["']${actionId}["']`).test(html), `focus dock missing action: ${actionId}`);
}

console.log("host-player-focus-regression: PASS");
