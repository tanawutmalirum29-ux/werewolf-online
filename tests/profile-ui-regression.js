const fs = require('fs');
const assert = require('assert');

const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/js/index.main.js', 'utf8');
const css = fs.readFileSync('public/css/index.css', 'utf8');

function count(re, source) {
    return (source.match(re) || []).length;
}

// The profile header is the single canonical place where the current display name is shown.
assert.strictEqual(count(/id="statsModalName"/g, html), 1, 'profile must have exactly one statsModalName node');
assert(!js.includes('class="account-profile-name"'), 'legacy duplicated account-profile-name markup must be removed');
assert(js.includes('document.getElementById("statsModalName").textContent = displayName;'), 'server-resolved account name must drive the profile header');

// Rename is now attached to the profile heading rather than rendered as a second full-width action.
assert(html.includes('id="profileEditNameBtn"'), 'profile should have a compact edit-name control');
assert(!html.includes('id="accountRenameEditor"'), 'rename must not create a second editor area');
assert(!js.includes('<button class="account-rename-open" onclick="openRenameAccountPrompt()">✏️ เปลี่ยนชื่อ</button>'), 'legacy full-width rename button must not return');

// Google actions must communicate their different semantics instead of presenting two identical buttons.
assert(js.includes('เชื่อม Google กับบัญชีนี้'), 'link action must explicitly say it keeps the current account');
assert(js.includes('ใช้บัญชี Google เพื่อเปลี่ยนบัญชีเกม'), 'login/switch action must explicitly communicate account switching');
assert(js.includes('รักษา Account ID ชื่อ และสถิติของบัญชีนี้ไว้'), 'link action must explain what is preserved');
assert(js.includes('หรือสร้างใหม่ถ้ายังไม่เคยมี'), 'switch action must explain first-time Google account creation');
assert(js.includes('account-action-primary'), 'Google primary action should use the primary visual treatment');
assert(js.includes('account-switch-link'), 'Google account switch should use a secondary link treatment');
assert(!js.includes('<button class="account-rename-open" onclick="startGoogleAuthentication(\'link\')">🔗 เชื่อมบัญชี Google</button><button class="account-rename-open" onclick="startGoogleAuthentication(\'login\')">🌐 เข้าสู่ระบบ Google</button>'), 'legacy duplicated Google buttons must not return');

// Accessibility / touch UX guardrails for the refreshed controls.
assert(css.includes('min-height:42px;'), 'profile actions should have touch-friendly targets');
assert(css.includes('user-select:text;'), 'rename field must remain selectable/editable on touch browsers');
assert(css.includes('max-height:min(720px, 90vh);'), 'profile modal must remain usable on shorter screens');

console.log('profile-ui-regression: PASS');

assert(js.includes('input.className = "stats-modal-name-edit"'), 'rename input must replace the name in place');
assert(js.includes('nameEl.replaceWith(input)'), 'rename must happen directly in the name position');
assert(js.includes('anchor, danger:true'), 'Google logout confirmation must use the original button slot');
assert(js.includes('slot.appendChild(panel)'), 'Google confirmation must stay in the original action slot');
assert(css.includes('.account-action-slot{'), 'Google action must have a fixed confirmation slot');
assert(css.includes('.confirm-source-hidden{visibility:hidden;}'), 'original Google button must retain its exact layout slot');
console.log('profile-ui-inline-regression: PASS');
