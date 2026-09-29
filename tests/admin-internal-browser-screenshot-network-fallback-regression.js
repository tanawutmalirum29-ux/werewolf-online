'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const adminBrowser = fs.readFileSync(path.join(ROOT, 'public/js/admin-browser.js'), 'utf8');

assert.ok(adminBrowser.includes('function isScreenshotNetworkFetchError(error)'), 'screenshot upload must classify network fetch failures');
assert.ok(adminBrowser.includes('function uploadScreenshotGithubViaXhr(url, headers, blob)'), 'screenshot upload must have XHR fallback');
assert.ok(adminBrowser.includes('xhr.withCredentials = true'), 'XHR fallback must preserve same-origin credentials');
assert.ok(adminBrowser.includes('xhr.send(blob)'), 'XHR fallback must upload the same PNG Blob');
assert.ok(adminBrowser.includes('return uploadScreenshotGithubViaXhr(url, headers, blob);'), 'TypeError/Load failed must fall back to XHR');
assert.ok(adminBrowser.includes('captureId'), 'fallback must reuse the same capture id for server-side deduplication');
assert.ok(adminBrowser.includes('GITHUB_SCREENSHOT_NETWORK_FAILED'), 'network fallback must expose a stable diagnostic code');
assert.ok(adminBrowser.includes('เชื่อมต่อเซิร์ฟเวอร์สำหรับบันทึกภาพไม่ได้'), 'final network error must not expose a raw TypeError only');

console.log('admin-internal-browser-screenshot-network-fallback-regression: PASS');
