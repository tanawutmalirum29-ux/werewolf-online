const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");

function assertNotPresent(value, message) { assert(!html.includes(value), message); }

assertNotPresent("ADMIN_GOOGLE_EMAILS</code>", "Google allowlist implementation detail must not be shown in admin login UI");
assertNotPresent("credential ของแท็บเก็บใน", "tab credential implementation detail must not be shown in admin login UI");
assertNotPresent("admin-auth-hint", "technical auth hint should not be rendered in the login dialog");
assertNotPresent("id=\"adminAuthEmailHint\"", "Google email implementation-detail hint element should not remain");
assert(html.includes("เข้าสู่ระบบแอดมิน"), "admin login dialog must remain");
assert(html.includes("เข้าด้วย Google ของแอดมิน"), "Google admin login button must remain");
console.log("admin-auth-login-ui-regression: PASS");
