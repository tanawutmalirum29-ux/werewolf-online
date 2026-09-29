const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registry = require('../public/js/runtime-audit-action-registry');

const root = path.resolve(__dirname, '..');
const htmlByPage = {};
for (const page of ['index','player','host','admin','maintenance']) htmlByPage[page] = fs.readFileSync(path.join(root,'public',`${page}.html`),'utf8');
const source = fs.readFileSync(path.join(root,'server.js'),'utf8');
const player = fs.readFileSync(path.join(root,'public/js/player.main.js'),'utf8');
const host = fs.readFileSync(path.join(root,'public/js/host.main.js'),'utf8');
const admin = fs.readFileSync(path.join(root,'public/admin.html'),'utf8');
const adminBrowser = fs.readFileSync(path.join(root,'public/js/admin-browser.js'),'utf8');

for (const action of registry.all()) {
    const html = htmlByPage[action.page];
    const sourcePool = html + (action.page === 'admin' ? adminBrowser : '');
    if (!action.selector || action.selector === 'body' || action.selector.includes('[data-id]') || action.selector.includes('[data-account-id]') || action.selector.includes('[data-room-id]') || action.selector.includes('.player')) continue;
    // Dynamic rendered selectors are validated by the browser-action fixture; static selectors must exist in source.
    if (action.mode !== 'simulation' && action.mode !== 'recovery' && action.mode !== 'destructive' && action.mode !== 'mutating') {
        const idMatch = action.selector.match(/^#([A-Za-z0-9_-]+)$/);
        if (idMatch) assert(sourcePool.includes(`id="${idMatch[1]}"`) || sourcePool.includes(`id='${idMatch[1]}'`) || sourcePool.includes(idMatch[1]), `${action.id}: missing static id selector ${action.selector}`);
    }
    if (action.selector.startsWith('.') && !action.selector.includes('[')) {
        const cls = action.selector.slice(1);
        const classRe = new RegExp('class=[\"\'][^\"\']*\\b' + cls.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\b[^\"\']*[\"\']');
        assert(classRe.test(html) || html.includes('.'+cls), `${action.id}: missing static class selector ${action.selector}`);
    }
}

const eventSources = { player, host, admin, index: htmlByPage.index };
for (const action of registry.all()) {
    const eventName = action.expected?.eventName;
    if (!eventName || eventName === 'server_control') continue;
    if (action.kind === 'socket') {
        const src = eventSources[action.page] || '';
        assert(src.includes(`emit("${eventName}"`) || src.includes(`emit('${eventName}'`) || src.includes(`emit(\"${eventName}\"`) || source.includes(`on("${eventName}"`) || source.includes(`on('${eventName}'`), `${action.id}: event contract not found for ${eventName}`);
    }
}

// The admin rename action was corrected to use the real server event.
assert(source.includes('socket.on("admin_rename_account"'), 'admin rename server event missing');
assert(!JSON.stringify(registry.find('admin.rename-account')).includes('admin_set_player_name'));

console.log('runtime-audit-action-page-contract-regression: PASS');
