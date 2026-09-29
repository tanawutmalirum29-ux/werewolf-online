const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const auth = fs.readFileSync(path.join(root, 'public/js/admin-auth-tab.js'), 'utf8');

class Storage {
  constructor(seed = []) { this.map = new Map(seed); }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  entries() { return [...this.map.entries()]; }
}

const calls = [];
class FakeBroadcastChannel {
  constructor(name) { calls.push({type:'construct', name}); this.onmessage = null; }
  postMessage(data) { calls.push({type:'post', data}); }
  close() { calls.push({type:'close'}); }
}

function makeSandbox(search, storage) {
  const listeners = new Map();
  const window = {
    addEventListener(type, fn) { (listeners.get(type) || (listeners.set(type, []), listeners.get(type))).push(fn); },
    location: { search, hash:'', origin:'https://game.example', assign(){} },
    fetch: async () => ({ ok:true, json:async()=>({ok:true}) }),
  };
  window.window = window;
  const sandbox = {
    window,
    crypto: { randomUUID: () => 'embedded-admin-tab-1234567890abcdef' },
    sessionStorage: storage,
    BroadcastChannel: FakeBroadcastChannel,
    setTimeout,
    clearTimeout,
    Date,
    URLSearchParams,
    Headers,
    history: { replaceState(){} },
    location: window.location,
    fetch: async () => ({ ok:true, json:async()=>({ok:true}) }),
    console,
  };
  return sandbox;
}

(async () => {
  const shared = new Storage([
    ['ww_admin_tab_id', 'shared-admin-tab-1234567890'],
    ['ww_admin_tab_token', 'signed-admin-token'],
    ['ww_admin_tab_meta', JSON.stringify({email:'admin@example.com',provider:'google',expiresAt:Date.now()+60000})],
  ]);
  const sandbox = makeSandbox('?ww_admin_embed=1&ww_admin_embed_depth=1&ww_admin_embed_id=embed-a', shared);
  vm.runInNewContext(auth, sandbox);
  await sandbox.window.WWAdminTabAuth.ready;

  assert.strictEqual(sandbox.window.WWAdminTabAuth.embedded, true);
  assert.strictEqual(sandbox.window.WWAdminTabAuth.getTabId(), 'shared-admin-tab-1234567890');
  assert.strictEqual(sandbox.window.WWAdminTabAuth.getToken(), 'signed-admin-token');
  assert.strictEqual(calls.filter(x => x.type === 'construct').length, 0, 'Embedded Admin must not start the duplicate-tab BroadcastChannel guard');
  assert.strictEqual(calls.filter(x => x.type === 'post').length, 0, 'Embedded Admin must not claim the parent tab identity');
  console.log('admin-embedded-session: PASS');
})().catch((error) => { console.error(error); process.exit(1); });
