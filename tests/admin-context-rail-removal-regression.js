'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('public/admin.html');
const css = read('public/css/admin-shell.css');
const phase2 = read('public/css/admin-phase2.css');
const shell = read('public/js/admin-shell.js');
const browser = read('public/js/admin-browser.js');

assert(!html.includes('id="adminShellContext"'), 'persistent context rail markup must be removed from Admin HTML');
assert(!css.includes('var(--admin-context)'), 'obsolete context width variable must not remain');
assert(!css.includes('var(--admin-context)'), 'Admin Shell must not reserve a context column');
assert(/grid-template-columns:\s*var\(--admin-sidebar\)\s+minmax\(0,1fr\);/.test(css), 'Admin Shell must use sidebar + workspace only');
assert(!css.includes('.admin-context-panel{'), 'obsolete context rail CSS must be removed');
assert(shell.includes('function setContext(data)'), 'selection compatibility bridge must remain');
assert(shell.includes('state.selected = data || null;'), 'selection state must remain available to commands/search');
assert(shell.includes('emit("CONTEXT_SELECTED"'), 'selection event bridge must remain observable');
assert(!shell.includes('adminShellContext'), 'Admin Shell JS must not depend on removed context rail DOM');
assert(!browser.includes('adminShellContext'), 'Internal Browser JS must not depend on removed context rail DOM');
assert(phase2.includes('.phase2-page-intro>div:first-child{'), 'Phase 2 intro must allow the title column to shrink');
assert(phase2.includes('overflow-wrap:anywhere'), 'Phase 2 intro actions must wrap long text instead of overlapping');
console.log('admin-context-rail-removal: PASS');


assert(/\.admin-app-shell\{height:100dvh;min-height:0;display:flex;flex-direction:column;overflow:hidden;\}/.test(css), 'Admin shell must lock the outer viewport so child areas own scrolling');
assert(/\.admin-topbar\{\s*position:relative;\s*flex:0 0 var\(--admin-topbar\);/.test(css), 'topbar must stay outside the scrolling workspace');
assert(/\.admin-layout-grid\{[\s\S]*?height:calc\(100dvh - var\(--admin-topbar\)\);[\s\S]*?overflow:hidden;/.test(css), 'shell grid must have a fixed viewport height');
assert(/\.admin-sidebar\{[\s\S]*?overflow-x:hidden;\s*overflow-y:auto;/.test(css), 'sidebar must be its own vertical scroll container');
assert(/\.admin-workspace\{[\s\S]*?height:100%;[\s\S]*?overflow-x:hidden;[\s\S]*?overflow-y:auto;/.test(css), 'workspace must be its own vertical scroll container');
assert(/\.admin-page-header\{[\s\S]*?position:sticky;\s*top:0;/.test(css), 'page title/header must stay fixed while workspace content scrolls');
assert(shell.includes('function syncWorkspaceStickyMetrics()'), 'workspace sticky header metrics helper must exist');
console.log('admin-independent-scroll-contract: PASS');
