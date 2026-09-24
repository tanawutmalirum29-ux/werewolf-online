const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const auditJs = fs.readFileSync(path.join(root, 'public/js/runtime-audit.js'), 'utf8');
const engineJs = fs.readFileSync(path.join(root, 'utils/runtime-audit-engine.js'), 'utf8');
const browserEngineJs = fs.readFileSync(path.join(root, 'public/js/runtime-audit-engine.js'), 'utf8');
assert.strictEqual(browserEngineJs, engineJs, 'browser runtime-audit engine must stay in sync with Node source');
for (const file of ['public/player.html','public/host.html','public/admin.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert(html.includes('runtime-audit-engine.js?v=1'), `${file}: runtime audit engine missing`);
    assert(html.includes('runtime-audit.js?v=1'), `${file}: runtime audit script missing`);
}
const player = fs.readFileSync(path.join(root, 'public/js/player.main.js'), 'utf8');
const host = fs.readFileSync(path.join(root, 'public/js/host.main.js'), 'utf8');
assert(player.includes('WWRuntimeAudit?.setStateProvider'), 'Player state provider hook missing');
assert(host.includes('WWRuntimeAudit?.setStateProvider'), 'Host state provider hook missing');
for (const needle of ['MutationObserver','PerformanceObserver','unhandledrejection','XMLHttpRequest','request.start','console.error']) {
    assert(auditJs.includes(needle), `runtime audit hook missing: ${needle}`);
}
assert(engineJs.includes('ack.timeout'), 'socket ACK timeout classification missing from audit engine');
assert(auditJs.includes("auditReport('runtime_audit_finding'"), 'runtime findings must reuse diagnostics intake');
assert(auditJs.includes("WWReportError('runtime_audit_summary'"), 'runtime summary must reuse diagnostics intake');

// Disabled by default must leave the page untouched. This catches accidental always-on wrapping.
const ctx = {
    window: {},
    document: { body:{ dataset:{} }, addEventListener(){}, querySelector(){ return null; } },
    location: { pathname:'/player.html', search:'' },
    localStorage: { getItem(){ return null; } },
    URLSearchParams,
    setTimeout,
    setInterval,
    clearInterval,
};
ctx.window.window = ctx.window;
ctx.window.localStorage = ctx.localStorage;
ctx.window.location = ctx.location;
ctx.window.URLSearchParams = URLSearchParams;
vm.runInNewContext(engineJs, ctx, { filename:'runtime-audit-engine.js' });
vm.runInNewContext(auditJs, ctx, { filename:'runtime-audit.js' });
assert(!ctx.window.__WW_RUNTIME_AUDIT__, 'audit must stay dormant unless explicitly enabled');

console.log('runtime-audit-browser-regression: PASS');
