'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const harness = fs.readFileSync(path.join(root, 'tests/browser_harness.py'), 'utf8');
assert(harness.includes('def launch_chromium'), 'shared browser harness launcher missing');
assert(harness.includes('WW_CHROMIUM_PATH'), 'browser harness must allow an explicit Chromium path');
assert(harness.includes('Playwright-managed Chromium'), 'browser harness must fall back to a managed Playwright browser');
assert(harness.includes('RuntimeError(f"Chromium browser unavailable:'), 'browser launch failures must be classified as infrastructure failures');

const browserTests = [
  'tests/admin-phase2-browser.py',
  'tests/admin-internal-browser-regression.py',
  'tests/player-html-grid-responsive-browser.py',
  'tests/admin-real-html-browser.py',
  'tests/admin-shell-browser.py',
  'tests/runtime-audit-live-browser.py',
];

for (const relative of browserTests) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  assert(source.includes('from browser_harness import launch_chromium'), `${relative} must use the shared browser infrastructure harness`);
  assert(source.includes('Python Playwright unavailable'), `${relative} must identify missing Playwright as an infrastructure skip`);
  assert(source.includes('SystemExit(77)'), `${relative} must exit with 77 for infrastructure-only skips`);
  assert(source.includes('launch_chromium(p)'), `${relative} must still execute a real Chromium browser when available`);
}

console.log('browser-harness-regression: PASS');
