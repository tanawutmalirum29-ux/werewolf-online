"use strict";
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const root = require("path").resolve(__dirname, "..");
const server = fs.readFileSync(require("path").join(root, "server.js"), "utf8");
const index = fs.readFileSync(require("path").join(root, "public/js/index.main.js"), "utf8");
const account = fs.readFileSync(require("path").join(root, "public/js/account.identity.js"), "utf8");

function must(condition, message) { assert.ok(condition, message); }

const fnStart = server.indexOf('const PLAYER_NAME_MAX_LENGTH = 24;');
const fnEnd = server.indexOf('// ตั้งค่าห้องที่โฮสต์กรอกไว้', fnStart);
assert(fnStart >= 0 && fnEnd > fnStart, "name-policy server block must exist");
const policyContext = {};
vm.runInNewContext(`${server.slice(fnStart, fnEnd)}; this.__sanitizeName=sanitizeName; this.__reserved=isReservedTesterName; this.__assert=assertUserDisplayNameAllowed;`, policyContext);

const sanitizeName = policyContext.__sanitizeName;
const reserved = policyContext.__reserved;
const assertAllowed = policyContext.__assert;

for (const input of ["Alice Bob", " Alice\tBob ", "A\nB", "ผู้เล่น 1", "P l a y e r 2"]) {
    must(!/\s/u.test(sanitizeName(input)), `sanitizeName must remove all whitespace: ${JSON.stringify(input)}`);
}
must(sanitizeName("Alice Bob") === "AliceBob", "spaces must not survive server sanitization");
must(reserved("ผู้เล่น"), "Thai reserved base name must be reserved");
must(reserved("ผู้เล่น123"), "Thai tester-number name must be reserved");
must(reserved("Player"), "English reserved base name must be reserved");
must(reserved("PLAYER42"), "English reserved name must be case-insensitive");
must(reserved("p l a y e r 7"), "English reserved name must be detected after whitespace normalization");
must(!reserved("PlayerX"), "PlayerX must remain available");
must(!reserved("ผู้เล่นA"), "Thai name with non-numeric suffix must remain available");
assert.throws(() => assertAllowed("Player 1"), e => e?.code === "NAME_RESERVED");
assert.throws(() => assertAllowed("ผู้เล่น"), e => e?.code === "NAME_RESERVED");
assert.throws(() => assertAllowed("   "), e => e?.code === "BAD_NAME");
assert.strictEqual(assertAllowed(" Alice  Bob "), "AliceBob");

must(index.includes('const RESERVED_TESTER_NAME_RE = /^(?:player|ผู้เล่น)(?:[0-9]+)?$/iu;'), "index must define the same reserved-name policy");
must(index.includes('function normalizeNameInput(value)'), "index must normalize name input");
must(index.includes('if (event.key === " " || event.code === "Space") event.preventDefault();'), "Space key must have no effect");
must(index.includes('input.addEventListener("input", () => {'), "input normalization must also cover paste/IME input");
must(index.includes('bindNameInputRestrictions(displayNameInput);'), "main display-name input must be protected");
must(index.includes('bindNameInputRestrictions(accountRecreateNameInput);'), "recreate-name input must be protected");
must(index.includes('bindNameInputRestrictions(input);'), "inline account rename input must be protected");
must(index.includes('NAME_RESERVED: "ชื่อนี้สงวนไว้สำหรับ Player Tester"'), "client must show reserved-name error");
must(account.includes('replace(/\\s+/gu, "")'), "account identity storage must not persist whitespace in names");
must(server.includes('if ((!requestedAccountId || join) && requestedName && isReservedTesterName(requestedName))'), "server must reject reserved names for new/join flows");
must(server.includes('const displayName = (typeof name === "string" && name.length)'), "new temporary account creation must enforce name policy");
must(server.includes('const trimmed = assertUserDisplayNameAllowed(newName);'), "rename paths must use the server name policy");
must(server.includes('const target = assertUserDisplayNameAllowed(newName);'), "name-availability check must enforce policy");

console.log("name-policy-regression: PASS");
