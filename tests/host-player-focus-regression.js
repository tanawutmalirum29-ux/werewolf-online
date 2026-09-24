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
assertOk(js.includes('event.key === "Escape" && playerFocusMode'), "Escape exit handler missing");

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
  "@media (max-width:800px)",
  "@media (max-width:480px)",
  "env(safe-area-inset-bottom"
]) {
  assertOk(css.includes(rule), `missing focus-mode CSS rule: ${rule}`);
}

// Focus mode must keep only the player board + game action dock visible.
for (const hiddenSelector of [
  "body.host-player-focus .seal-wrap",
  "body.host-player-focus #leftCol",
  "body.host-player-focus #chatCard",
  "body.host-player-focus #dayNightBadge"
]) {
  assertOk(css.includes(hiddenSelector), `focus mode must hide: ${hiddenSelector}`);
}

assertOk(css.includes(`body.host-player-focus .vote-modal-overlay{
    z-index:700;`), "focus mode must keep modal dialogs above the fullscreen player panel");
assertOk(css.includes(`body.host-player-focus #wwVersionBadge{
    display:none !important;`), "focus mode must hide the normal version badge");

// The game-control dock must keep the phase actions and an explicit exit route.
for (const actionId of ["startNightBtn", "resolveBtn", "voteBtn", "focusRestartBtn", "reopenGameOverBtn", "reopenPopupBtn"]) {
  assertOk(new RegExp(`id=["']${actionId}["']`).test(html), `focus dock missing action: ${actionId}`);
}

console.log("host-player-focus-regression: PASS");
