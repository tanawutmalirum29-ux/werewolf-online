const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registry = require('../public/js/runtime-audit-action-registry.js');

const coverage = registry.coverage();
const actions = registry.all();
const ids = new Set();

assert(coverage.total >= 100, `action registry should contain broad coverage, got ${coverage.total}`);
for (const page of ['index','player','host','admin','maintenance']) {
    assert(coverage.pages[page] > 0, `missing page coverage: ${page}`);
}
for (const actor of ['player','host','admin']) {
    assert(coverage.actors[actor] > 0, `missing actor coverage: ${actor}`);
}
assert((coverage.modes.safe || 0) >= 35, 'safe action coverage too small');
assert((coverage.modes.simulation || 0) >= 25, 'simulation coverage too small');
assert((coverage.modes.destructive || 0) >= 5, 'destructive action coverage too small');

for (const action of actions) {
    assert(action.id && /^[a-z0-9._-]+$/.test(action.id), `invalid action id: ${action.id}`);
    assert(!ids.has(action.id), `duplicate action id: ${action.id}`);
    ids.add(action.id);
    assert(['index','player','host','admin','maintenance'].includes(action.page), `invalid page: ${action.id}`);
    assert(['player','host','admin','system'].includes(action.actor), `invalid actor: ${action.id}`);
    assert(action.group && action.kind && action.mode, `incomplete action metadata: ${action.id}`);
    const raw = JSON.stringify(action);
    assert(!/(password|secret|token|authorization|cookie|googleSub|testerPass|@)/i.test(raw), `action registry must not carry credentials: ${action.id}`);
    if (action.kind === 'socket') assert(action.expected?.eventName, `socket action missing eventName: ${action.id}`);
}

for (const page of ['index','player','host','admin']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', `${page}.html`), 'utf8');
    assert(html.includes('runtime-audit-action-registry.js'), `${page}: action registry script missing`);
    assert(html.includes('runtime-audit-actions.js'), `${page}: action runner script missing`);
}
const maintenance = fs.readFileSync(path.join(__dirname, '..', 'public', 'maintenance.html'), 'utf8');
assert(maintenance.includes('__WW_MAINTENANCE_RUNTIME_AUDIT__'), 'maintenance inline audit missing');

console.log(`runtime-audit-action-registry-regression: PASS (${coverage.total} actions)`);
