const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "host.html"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "css", "host.css"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "js", "host.main.js"), "utf8");

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

for (const id of [
  "hostLivePill", "hostFactPlayers", "hostFactRoles", "hostFactAccess", "hostFactPhase",
  "setupSteps", "floatingContext", "setupCard", "roleSettingsCard", "list", "chatCard"
]) {
  assertOk(new RegExp(`id=["']${id}["']`).test(html), `missing host UI hook: ${id}`);
}

for (const rule of [
  "body.setup-mode #leftCol",
  ".layout.role-hidden #rightCol",
  ".layout.role-hidden #chatCard",
  "@media (max-width:800px)",
  "@media (max-width:480px)",
  "env(safe-area-inset-bottom",
  ".setup-steps",
  ".host-room-facts",
  ".floating-context"
]) {
  assertOk(css.includes(rule), `missing responsive host UI rule: ${rule}`);
}

assertOk(js.includes("updateHostControlChrome"), "missing host chrome updater");
assertOk(js.includes("function keepChatInRightCol()"), "chat must remain owned by the right workspace column");
assertOk(js.includes("if (chatCard.parentElement !== rightCol) rightCol.appendChild(chatCard);"), "chat placement must not migrate between workspace columns");
assertOk(js.includes("updateHostControlChrome(currentRoom || { started:false"), "role count/step must update the host chrome");

for (const rule of [
  "body.host-game-mode .seal-actions + .seal-actions",
  "@media (max-width:1080px)",
  ".layout.role-hidden #rightCol{ grid-template-columns:minmax(0,1fr); }",
  "@media (min-width:701px)",
  "body.setup-mode .floating-context-kicker::before{ content:none !important; }",
  "body.setup-mode .quick-add-chip span",
  "body.host-game-mode .host-room-shell"
]) {
  assertOk(css.includes(rule), `missing final host layout guard: ${rule}`);
}

console.log("host-ui-regression: PASS");
