const fs = require("fs");
const assert = require("assert");
const server = fs.readFileSync("server.js", "utf8");
const admin = fs.readFileSync("public/admin.html", "utf8");

assert(server.includes("if (sock.data?.resetInvalidated) continue;"), "pre-reset sockets must not count toward live accounts");
assert(server.includes('if (resetInProgress) return cb({ ok: true, accounts: [], resetInProgress: true'), "live account listing must return empty during reset");
assert(server.includes('const resetEpochAtStart = resetEpoch || "";'), "admin account listing must capture reset epoch before async work");
assert(server.includes('resetEpoch !== resetEpochAtStart'), "late pre-reset account response must be discarded");
assert(server.includes('s.data.resetInvalidated = true;'), "reset must invalidate old game sockets");
assert(server.includes('s.emit("admin_reset_started"'), "admin reset start event missing");
assert(server.includes('s.emit("admin_reset_completed"'), "admin reset completion event missing");
assert(admin.includes('let adminResetGeneration = 0;'), "Admin needs reset generation guard");
assert(admin.includes('socket.on("admin_reset_started"'), "Admin must clear stale state when reset starts");
assert(admin.includes('socket.on("admin_reset_completed"'), "Admin must clear stale state when reset completes");
assert(admin.includes('if (generation !== adminResetGeneration) return;'), "Admin async callbacks must ignore pre-reset results");
console.log("admin-reset-state-fanout-regression: PASS");
