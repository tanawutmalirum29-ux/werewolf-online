const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'admin-shell.css'), 'utf8');

const REQUIRED_COMMAND = 'เริ่มแก้ไฟล์เลย ขอให้แก้และดูอย่างละเอียดไม่เอารีบส่ง ของานละเอียด และเช็คซ้ำหลายๆรอบว่าทำงานได้ดีและตรงแล้ว เสร็จแล้วส่งไฟล์มา';

assert(admin.includes('id="runningVersionChip"'), 'running version chip must remain present');
assert(admin.includes('id="adminViewportChip"'), 'admin viewport chip is missing');
assert(admin.includes('id="copyAdminCommandBtn"'), 'admin copy-command button is missing');
assert(admin.includes('type="button">📎</button>'), 'copy-command button must be icon-only 📎');
assert(!admin.includes('📋 คัดลอกคำสั่ง'), 'old text copy-command label must not return');

// The compact copy control belongs in the persistent Admin topbar; the full command remains a clipboard payload only.
const topMetaMatch = admin.match(/<div class="admin-topbar-meta">([\s\S]*?)<\/div>\s*<div class="admin-account-wrap"/);
assert(topMetaMatch, 'Admin topbar metadata row is missing');
const topMeta = topMetaMatch[1];
assert(topMeta.includes('id="copyAdminCommandBtn"'), 'copy command button must be placed in topbar metadata');
assert(topMeta.includes('id="runningVersionChip"'), 'running version must remain in topbar metadata');
const versionToCopyOrder = topMeta.match(/id="runningVersionChip"[\s\S]*?id="copyAdminCommandBtn"/);
assert(versionToCopyOrder, 'copy command button must sit beside the running game version');
assert(!/<div class="tool-actions"[^>]*>[\s\S]*?id="copyAdminCommandBtn"/.test(admin), 'copy command button must not remain in an operations card');
assert.strictEqual((admin.match(/id="copyAdminCommandBtn"/g) || []).length, 1, 'copy command button must exist exactly once');
assert(admin.includes('role="status"') && admin.includes('aria-live="polite"'), 'viewport size must be exposed as a live status');
assert(admin.includes('window.innerWidth'), 'viewport width must come from the live browser viewport');
assert(admin.includes('window.innerHeight'), 'viewport height must come from the live browser viewport');
assert(admin.includes('window.visualViewport'), 'admin viewport monitor must support VisualViewport');
assert(admin.includes('ResizeObserver'), 'admin viewport monitor must support container/layout resize observation');
assert(admin.includes('requestAnimationFrame'), 'viewport updates must be coalesced with requestAnimationFrame');
assert(admin.includes('window.addEventListener("resize", scheduleAdminViewportMeasure'), 'window resize listener missing');
assert(admin.includes('window.addEventListener("orientationchange", scheduleAdminViewportMeasure'), 'orientation change listener missing');
assert(admin.includes('window.visualViewport.addEventListener("resize", scheduleAdminViewportMeasure'), 'visual viewport resize listener missing');
assert(admin.includes('adminViewportChip.textContent = `📐 ${width} × ${height} px`'), 'viewport chip must render width × height');
assert(admin.includes(`const ADMIN_FIX_COMMAND = "${REQUIRED_COMMAND}";`), 'full requested command must be stored exactly once as the copy payload');
assert(admin.includes('navigator.clipboard.writeText(ADMIN_FIX_COMMAND)'), 'copy button must use Clipboard API when available');
assert(admin.includes('document.execCommand("copy")'), 'copy button needs a fallback for HTTP/iOS/WebView contexts');
assert(admin.includes('copyAdminCommandBtn.addEventListener("click", copyAdminFixCommand)'), 'copy button click handler missing');
assert(admin.includes('copyAdminCommandBtn.textContent = "✓"'), 'successful copy must visibly switch the button to a check mark');
assert(admin.includes('copyAdminCommandBtn.textContent = "📎"'), 'copy button must restore the paperclip after feedback');
assert(admin.includes('data-copied="1"'), 'copy success state marker is missing');

// The full command is kept out of the rendered button/label; it should only be copied after a click.
const buttonMatch = admin.match(/<button[^>]*id="copyAdminCommandBtn"[\s\S]*?<\/button>/);
assert(buttonMatch, 'copy button HTML block missing');
assert(!buttonMatch[0].includes(REQUIRED_COMMAND), 'full command must not be visibly embedded in the copy button');
assert.strictEqual(buttonMatch[0].replace(/<[^>]+>/g, '').trim(), '📎', 'copy button visible content must be only 📎');

// Responsive layout: chips should stay usable without forcing the old full-width version pill.
assert(css.includes('grid-template-columns:repeat(8,minmax(0,1fr))'), 'mobile navigation must use a bounded eight-item grid after adding Versions');
assert(css.includes('.admin-topbar-meta .version-chip,.admin-topbar-meta .viewport-chip'), 'topbar metadata chips must share responsive styling');

console.log('admin-viewport-command-regression: PASS');
