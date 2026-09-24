const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'js', 'index.main.js'), 'utf8');
const reporter = fs.readFileSync(path.join(root, 'public', 'js', 'error-reporter.js'), 'utf8');
const sharedControl = fs.readFileSync(path.join(root, 'public', 'js', 'shared.server-control.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'public', 'js', 'host.main.js'), 'utf8');
const player = fs.readFileSync(path.join(root, 'public', 'js', 'player.main.js'), 'utf8');

assert(server.includes('async function withTimeout(promise, timeoutMs, code, message)'), 'bounded promise helper missing');
assert(server.includes('verifyAccountLogin(safeAccountId, safeAccountToken),\n            10000,\n            "ACCOUNT_AUTH_TIMEOUT"'), 'Google link verification must have a 10s server-side deadline');
assert(server.includes('ACCOUNT_AUTH_TIMEOUT: 503'), 'bounded Google verification must return a service-timeout code');
assert(server.includes('ExpressionAttributeNames: { "#status": "status" }'), 'account status update must keep reserved keyword aliasing');
assert(server.includes('ADD joinCount :one'), 'player registration must keep the joinCount increment');
assert(server.includes('ExpressionAttributeValues: { ":now": now, ":one": 1 }'), 'player registration joinCount value must remain bound to :one');
assert(index.includes('if (window.__WW_DIAG_PAGEHIDE__) return null;'), 'index bootstrap must swallow expected pagehide teardown');
assert(index.includes('ACCOUNT_AUTH_TIMEOUT:"เซิร์ฟเวอร์ยืนยันบัญชีใช้เวลานานเกินไป กรุณาลองเชื่อม Google อีกครั้ง"'), 'client must explain bounded Google verification timeout');
assert(reporter.includes('window.__WW_DIAG_PAGEHIDE__ = true'), 'diagnostic pagehide marker must remain available');

assert(sharedControl.includes('function loadedClientHash()'), 'loaded client hash detector missing');
assert(sharedControl.includes('function startClientCodeUpdate(expectedClientHash)'), 'stale client update handler missing');
assert(sharedControl.includes('window.wwCheckClientVersion = startClientCodeUpdate;'), 'client update checker export missing');
assert(sharedControl.includes('startClientCodeUpdate(cfg.clientHash || "")'), 'config polling must check stale Host/Player client code');
assert(sharedControl.includes('refreshAssetCache("files")'), 'stale client update must refresh game assets before reload');
assert(sharedControl.includes('_ww_client'), 'stale client reload must carry the target client hash');
assert(sharedControl.includes('ต่างจาก startReload(): ห้ามล้าง room/token'), 'stale client reload must preserve room credentials');
assert(host.includes('window.wwCheckClientVersion(info && info.clientHash)'), 'Host must check client hash immediately on socket serverInfo');
assert(player.includes('window.wwCheckClientVersion(info && info.clientHash)'), 'Player must check client hash immediately on socket serverInfo');

console.log('✅ diagnostic runtime hardening regression checks passed');
