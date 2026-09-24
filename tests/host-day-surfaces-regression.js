const fs = require("fs");
const assert = require("assert");

const css = fs.readFileSync("public/css/host.css", "utf8");
const html = fs.readFileSync("public/host.html", "utf8");

assert(html.includes('<body data-page="host" class="is-day">'), "host page must start in daytime theme");

const requiredDaySelectors = [
  "body.is-day .app .host-role-card",
  "body.is-day .app .host-chat-card",
  "body.is-day .app .quick-add-chip",
  "body.is-day .app .roleBox",
  "body.is-day .app .roleBtn",
  "body.is-day .app .host-chat-card .chat-tabs",
  "body.is-day .app .host-chat-card .chat-log",
  "body.is-day .app .host-chat-card .msg",
  "body.is-day .vote-modal",
  "body.is-day .roomPickCard",
  "body.is-day .ww-modal-box",
  "body.is-day .ww-toast"
];
for (const selector of requiredDaySelectors) {
  assert(css.includes(selector), `day surface override missing: ${selector}`);
}

assert(css.includes("body.is-day .app .roleBox{\n    background:rgba(255,255,255,.90) !important;"), "role rows must be explicitly light in daytime");
assert(css.includes("body.is-day .app .host-chat-card .chat-log{\n    background:rgba(255,255,255,.42);"), "host chat area must be explicitly light in daytime");
assert(css.includes("body.is-day .vote-modal{\n    background:linear-gradient(145deg,rgba(255,255,255,.98),rgba(241,250,253,.96));"), "root-level modal must be light in daytime");
assert(css.includes("body.is-day .ww-modal-box{\n    background:linear-gradient(145deg,#ffffff,#effafe);"), "generic modal must be light in daytime");

// The dark night literals remain allowed in the base rules; the important invariant is
// that every affected surface has a later body.is-day override.
console.log("host-day-surfaces-regression: PASS");
