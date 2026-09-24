const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'host.main.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'host.html'), 'utf8');

function assertOk(condition, message) {
  if (!condition) throw new Error(message);
}

assertOk(js.includes('function preserveExistingRoleImage('), 'missing role image preservation helper');
assertOk(js.includes('const oldRoleImage = div.querySelector(".prole-icon");'), 'player card does not capture existing role image node');
assertOk(js.includes('preserveExistingRoleImage(div, ".prole-icon", oldRoleImage, nextRoleImage);'), 'player card does not restore existing role image node');
assertOk(js.includes('if (playerViewMode !== "simple") return;'), 'hidden simple view is still rebuilt on every room update');
assertOk(js.includes('const oldRoleImages = {};'), 'simple view does not preserve existing role image nodes');
assertOk(js.includes('preserveExistingRoleImage(row, ".srow-role-icon", oldImage, newImage);'), 'simple view does not restore role image nodes');
assertOk(js.includes('let rolesDataSignature = "";'), 'roles_data signature guard missing');
assertOk(js.includes('if (rolesDataSignature && nextSignature && rolesDataSignature === nextSignature) {'), 'identical roles_data is still rebuilding role UI');

const roomUpdateStart = js.indexOf('socket.on("room_update", (room) => {');
const roomUpdateEnd = js.indexOf('\n});', roomUpdateStart);
assertOk(roomUpdateStart >= 0 && roomUpdateEnd > roomUpdateStart, 'room_update handler missing');
const roomUpdate = js.slice(roomUpdateStart, roomUpdateEnd);
const renderRolesCalls = [...roomUpdate.matchAll(/renderRoles\(\)/g)].map(m => m.index);
assertOk(renderRolesCalls.length <= 1, `room_update directly rebuilds role settings ${renderRolesCalls.length} times`);
assertOk(roomUpdate.includes('if (configChanged) {'), 'role settings render is not guarded by configChanged');

assertOk(html.includes('class="roleBox"') || html.includes('id="roles"'), 'host role UI hooks missing');
console.log('host-role-image-stability-regression: PASS');
