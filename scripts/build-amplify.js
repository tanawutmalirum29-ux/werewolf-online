'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const http = process.env.APPSYNC_HTTP_URL?.trim() || '';
const realtime = process.env.APPSYNC_REALTIME_URL?.trim() || '';
const apiKey = process.env.APPSYNC_API_KEY?.trim() || '';
const configured = Boolean(http && realtime && apiKey);
if ((http || realtime || apiKey) && !configured) throw new Error('Set all three AppSync values: APPSYNC_HTTP_URL, APPSYNC_REALTIME_URL and APPSYNC_API_KEY.');
if (configured) {
    const h = new URL(http), r = new URL(realtime);
    if (h.protocol !== 'https:' || r.protocol !== 'wss:' || h.pathname !== '/event' || r.pathname !== '/event/realtime' || [h,r].some(u => u.username || u.password || u.search || u.hash)) {
        throw new Error('Use the AppSync Events HTTPS endpoint ending /event and WSS endpoint ending /event/realtime.');
    }
    if (!/^da2-[A-Za-z0-9_-]+$/.test(apiKey)) throw new Error('APPSYNC_API_KEY must be an AppSync API key (da2-...), never an AWS access key.');
}
fs.rmSync(output, { recursive:true, force:true });
fs.cpSync(path.join(root, 'public'), output, { recursive:true });
fs.writeFileSync(path.join(output, 'js/config.js'), `window.WEREWOLF_CONFIG = ${JSON.stringify({ mode:'aws', events: configured ? {httpUrl:http, realtimeUrl:realtime, apiKey} : null })};\n`);
fs.copyFileSync(path.join(root, 'lib/game.js'), path.join(output, 'js/game.js'));
fs.writeFileSync(path.join(output, 'js/roles.js'), `window.WEREWOLF_ROLES = ${fs.readFileSync(path.join(root, 'roles.json'),'utf8')};\n`);
for (const page of ['host', 'player']) {
    const file = path.join(output, page + '.html');
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace('<script defer src="/socket.io/socket.io.js"></script>', ['roles','random','game','aws-events'].map(name => `<script defer src="/js/${name}.js"></script>`).join(''));
    if (page === 'host') html = html.replace('รีเฟรชหน้าแล้วกลับห้องได้ตราบที่เซิร์ฟเวอร์เดิมยังทำงาน หากห้องหายให้สร้างใหม่', 'เปิดหน้าโฮสต์ไว้ตลอดเกม อย่ารีเฟรช ปิดแท็บ หรือพักเครื่อง เพราะห้องอยู่ในหน้านี้และจะหาย');
    fs.writeFileSync(file, html);
}
const index = path.join(output, 'index.html');
let html = fs.readFileSync(index, 'utf8').replace('ห้องเป็นวงเล่นชั่วคราว หากเซิร์ฟเวอร์เริ่มใหม่ ให้สร้างห้องใหม่', 'ห้องอยู่ในหน้าโฮสต์ โฮสต์ต้องเปิดหน้านี้ไว้ตลอดเกม หากปิดหรือรีเฟรช ให้สร้างห้องใหม่');
if (!configured) html = html.replace('<main class="landing">', '<main class="landing"><p class="notice" role="status">เว็บติดตั้งแล้ว แต่ยังไม่พร้อมเล่น เจ้าของเว็บต้องตั้งค่า AppSync ตาม README แล้ว deploy อีกครั้ง</p>');
fs.writeFileSync(index, html);
console.log(configured ? 'Built AWS frontend in dist/. Ready for an AppSync connection test.' : 'Built setup frontend in dist/. Gameplay is disabled until the three AppSync variables are configured. See README.');
