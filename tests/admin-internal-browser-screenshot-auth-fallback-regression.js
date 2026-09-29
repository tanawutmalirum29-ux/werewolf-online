'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const adminBrowser = fs.readFileSync(path.join(ROOT, 'public/js/admin-browser.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');

assert.ok(adminBrowser.includes('function getAdminScreenshotAuthHeaders()'), 'screenshot upload must have a dedicated Admin auth header helper');
assert.ok(adminBrowser.includes('auth?.getToken?.()'), 'screenshot upload must read the current tab bearer token');
assert.ok(adminBrowser.includes('auth?.getTabId?.()'), 'screenshot upload must read the current Admin tab id');
assert.ok(adminBrowser.includes('Authorization = `Bearer ${token}`'), 'screenshot upload must attach the Admin bearer token');
assert.ok(adminBrowser.includes('["X-WW-Admin-Tab-Id"] = tabId'), 'screenshot upload must attach the Admin tab binding');
assert.ok(adminBrowser.includes('const requestHeaders = { ...getAdminScreenshotAuthHeaders(), ...(headers || {}) };'), 'XHR fallback must carry Admin auth headers');
assert.ok(adminBrowser.includes('return null;'), 'UI screenshot upload failure must be contained rather than becoming unhandled_rejection');
assert.ok(adminBrowser.includes('เซสชัน Admin หมดอายุหรือไม่ถูกส่งไปกับคำขอ'), 'Admin auth failure must have a targeted user-facing message');
assert.ok(adminHtml.includes('/js/admin-browser.js?v=20260926-24'), 'Admin Browser cache marker must advance after the auth fallback fix');
console.log('admin-internal-browser-screenshot-auth-fallback-regression: PASS');
