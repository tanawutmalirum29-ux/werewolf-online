const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const shared = fs.readFileSync(path.join(root, "public", "js", "shared.server-control.js"), "utf8");
const maintenance = fs.readFileSync(path.join(root, "public", "maintenance.html"), "utf8");

assert(server.includes('const IMAGE_BASE_URL = (process.env.IMAGE_BASE_URL || "").replace'), "IMAGE_BASE_URL must remain the single external image origin");
assert(server.includes('const SERVER_CLOSED_ICON_PATH = "/icons-server.png";'), "closed-server icon path must be defined once at the image-origin root");
assert(server.includes('function imgUrl(imgPath)'), "server closed icon must use the generic image URL helper");
assert(server.includes('const src = imgUrl(SERVER_CLOSED_ICON_PATH);'), "maintenance HTML rewrite must use the same image helper as all other images");
assert(server.includes('serverIconUrl: imgUrl(SERVER_CLOSED_ICON_PATH)'), "server-state/config must expose the canonical resolved icon URL");
assert(!server.includes('IMAGE_BASE_URL}/icons-server.png'), "server must not construct a second special-case closed-icon S3 URL");
assert(index.includes("typeof info.serverIconUrl==='string'"), "index first-paint gate must use server-provided icon URL");
assert(shared.includes('window.WW_CLOSED_SERVER_ICON_URL'), "shared overlay must use server-provided canonical icon URL when available");
assert(shared.includes('window.wwImg("/icons-server.png")'), "shared overlay must request the icon from the same image-origin root path as cover-1200x630.png");
assert(index.includes('__WW_IMAGE_BASE__/cover-1200x630.png'), "cover must use the image-origin root path");
assert(maintenance.includes('d.serverIconUrl'), "maintenance page must use server-provided canonical icon URL");
assert(!maintenance.includes('String(d.imageBase).replace(/\/+$/, "") + "/icons-server.png"'), "maintenance must not rebuild a special-case S3 icon path");

console.log("server-closed-icon-source-regression: PASS");
