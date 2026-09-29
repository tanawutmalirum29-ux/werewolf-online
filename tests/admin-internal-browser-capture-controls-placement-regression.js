'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const browserCss = fs.readFileSync(path.join(ROOT, 'public', 'css', 'admin-browser.css'), 'utf8');

function blockBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex >= 0, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function contract() {
  const diagnosticsHeader = blockBetween(
    adminHtml,
    '<div class="admin-diagnostics-header-tools" id="adminDiagnosticsHeaderTools"',
    '<div class="admin-operations-header-tools" id="adminOperationsHeaderTools"'
  );
  const browserView = blockBetween(
    adminHtml,
    '<section aria-label="Internal Game Browser" class="admin-browser-view" id="adminBrowserView"',
    '</section>\n</main>\n</div>'
  );

  assert.ok(!diagnosticsHeader.includes('adminBrowserCaptureClearGithubScreenshotsBtn'),
    'screenshot clear button must not be inside Diagnostics header');
  assert.ok(diagnosticsHeader.includes('diagGithubClearIssuesBtn'),
    'GitHub Issues clear button must remain in Diagnostics');

  assert.ok(browserView.includes('id="adminBrowserCaptureMenu"'),
    'Internal Browser capture menu must exist');
  assert.ok(browserView.includes('id="adminBrowserCaptureClearGithubScreenshotsBtn"'),
    'screenshot clear button must be owned by the Internal Browser capture UI');
  assert.ok(browserView.includes('onclick="clearGithubScreenshotsFromAdmin()"'),
    'screenshot clear button must keep the existing admin action');

  const menu = blockBetween(
    browserView,
    '<div class="admin-browser-capture-menu" id="adminBrowserCaptureMenu"',
    'id="adminBrowserNewTabTopBtn"'
  );
  assert.ok(menu.includes('adminBrowserCaptureClearGithubScreenshotsBtn'),
    'screenshot clear button must be physically nested inside the capture menu');

  const clearFn = blockBetween(
    adminHtml,
    'async function clearGithubScreenshotsFromAdmin(){',
    'async function clearDiagnostics(){'
  );
  assert.ok(clearFn.includes("document.getElementById('adminBrowserCaptureClearGithubScreenshotsBtn')"),
    'clear function must target the relocated capture-menu button');
  assert.ok(adminHtml.includes('DELETE_ALL_GITHUB_SCREENSHOT_FILES'),
    'existing screenshot-clear confirmation contract must remain');

  assert.ok(browserCss.includes('.admin-browser-capture-github-tools'),
    'capture-menu screenshot management section needs dedicated styling');
  assert.ok(browserCss.includes('.admin-browser-capture-github-clear'),
    'relocated screenshot clear button needs dedicated styling');
}

contract();
console.log('admin-internal-browser-capture-controls-placement-regression: PASS');
