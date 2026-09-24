const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const SERVER = path.join(ROOT, "server.js");
const SHARED = path.join(PUBLIC, "js", "shared.server-control.js");
const HOST = path.join(PUBLIC, "js", "host.main.js");
const PLAYER = path.join(PUBLIC, "js", "player.main.js");

const LEGACY = [
    "favicon.ico",
    "favicon-16x16.png",
    "favicon-32x32.png",
    "apple-touch-icon.png",
    "cover-1200x630.png",
];

for (const file of LEGACY) {
    assert.ok(!fs.existsSync(path.join(PUBLIC, file)), `legacy local site asset must be removed: public/${file}`);
}

const server = fs.readFileSync(SERVER, "utf8");
const shared = fs.readFileSync(SHARED, "utf8");
const host = fs.readFileSync(HOST, "utf8");
const player = fs.readFileSync(PLAYER, "utf8");

for (const file of ["index.html", "host.html", "player.html", "admin.html", "maintenance.html"]) {
    const html = fs.readFileSync(path.join(PUBLIC, file), "utf8");
    assert.ok(html.includes("__WW_IMAGE_BASE__/"), `${file} must use an external-image placeholder rather than a same-origin icon path`);
    assert.ok(!/(?:href|content)=["']\/(?:favicon\.ico|favicon-32x32\.png|favicon-16x16\.png|apple-touch-icon\.png|cover-1200x630\.png)["']/i.test(html), `${file} must not contain a same-origin site icon URL`);
}

assert.ok(server.includes('const IMAGE_BASE_URL = (process.env.IMAGE_BASE_URL || "").replace'), "IMAGE_BASE_URL must be the external image origin");
assert.ok(server.includes('if (!IMAGE_BASE_URL) return "";'), "generic image helper must fail closed instead of falling back to local /images paths");
assert.ok(server.includes('const SITE_ICON_REF_RE'), "site icon rewriting must remain enabled");
assert.ok(server.includes('return `${pre}${IMAGE_BASE_URL}${assetPath}'), "site icons must be rewritten to S3/CDN URLs");
assert.ok(server.includes('app.use("/images", (req, res) =>'), "local /images access must be blocked");
assert.ok(!server.match(/CLOSED_ALLOWED_PATHS[\s\S]{0,250}favicon\.ico/), "closed-server allowlist must not expose local favicon paths");

assert.ok(shared.includes('if (!base) return "";'), "shared image helper must fail closed when S3/CDN base is missing");
assert.ok(shared.includes('if (window.WW_IMG_BASE) {'), "client preload must require an external image base");
assert.ok(shared.includes('addImageUrl(window.WW_IMG_BASE + p)'), "client preload must build site icon URLs from S3/CDN base");
assert.ok(!shared.includes('].forEach(addImageUrl);'), "client must not blindly fetch site icons as same-origin relative paths");

for (const [name, code] of [["host.main.js", host], ["player.main.js", player]]) {
    assert.ok(code.includes('return base ? base + p : "";'), `${name} stale-HTML compatibility helper must not fall back to same-origin /images`);
}

console.log("S3 site assets regression checks passed");
