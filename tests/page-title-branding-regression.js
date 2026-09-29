'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const titleOf = (html) => {
  const match = html.match(/<title>([^<]*)<\/title>/i);
  return match ? match[1].trim() : '';
};

for (const rel of ['public/index.html', 'public/host.html', 'public/player.html', 'public/maintenance.html']) {
  assert.strictEqual(titleOf(read(rel)), 'Werewolf-Online', `${rel} must expose the unified browser title`);
}

const adminHtml = read('public/admin.html');
assert.strictEqual(titleOf(adminHtml), 'Admin Control Center — Werewolf Online', 'Admin document title must stay unchanged');
assert.ok(adminHtml.includes('document.title = "Admin · Embedded";'), 'embedded Admin title must stay unchanged');

const browser = read('public/js/admin-browser.js');
assert.ok(browser.includes('if (type === "game") return "Werewolf-Online";'), 'Internal Browser game fallback must use the unified title');
assert.ok(browser.includes('if (p.endsWith("/host.html")) return "Werewolf-Online";'), 'Host page fallback must use the unified title');
assert.ok(browser.includes('if (p.endsWith("/player.html")) return "Werewolf-Online";'), 'Player page fallback must use the unified title');
assert.ok(browser.includes('if (type === "tester-host") return "Tester Host";'), 'Tester Host tab label must remain distinct');
assert.ok(browser.includes('if (type === "tester-player") return "Tester Player";'), 'Tester Player tab label must remain distinct');
assert.ok(browser.includes('const title = ["tester-host", "tester-player", "bot-player"].includes(tab.type)'), 'Tester child titles must not overwrite Admin Tester tab labels');

console.log('page-title-branding-regression: PASS');
