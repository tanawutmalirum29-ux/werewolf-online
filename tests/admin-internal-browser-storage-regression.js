const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..');
const sharedCode = fs.readFileSync(path.join(root, 'public/js/shared.server-control.js'), 'utf8');
const accountCode = fs.readFileSync(path.join(root, 'public/js/account.identity.js'), 'utf8');

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
  clear() { this.map.clear(); }
}

function createWindow(search, rawSession) {
  const listeners = new Map();
  const window = {
    location: { search, pathname: '/player.html', origin: 'https://werewolf.test', href: 'https://werewolf.test/player.html' + search },
    sessionStorage: rawSession,
    localStorage: new MemoryStorage(),
    navigator: { onLine: true },
    fetch: async () => ({ ok: true }),
    wwGetConfig: () => Promise.resolve({ ok: true, serverOpen: true, reloadEpoch: '', imageEpoch: '', appVersion: 'test', clientHash: '' }),
    wwSetServerVersion: () => {},
    wwImg: () => '',
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    dispatchEvent() {},
    close() {},
    focus() {},
  };
  const document = { body: { appendChild() {} }, addEventListener() {}, querySelectorAll: () => [] };
  const context = { window, document, location: window.location, sessionStorage: rawSession, localStorage: window.localStorage, navigator: window.navigator, URLSearchParams, URL, Date, JSON, Promise, console, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, CustomEvent: class CustomEvent { constructor(type, init={}) { this.type=type; this.detail=init.detail; } } };
  vm.createContext(context);
  vm.runInContext(sharedCode, context, { filename: 'shared.server-control.js' });
  vm.runInContext(accountCode, context, { filename: 'account.identity.js' });
  return { context, window };
}

const rawSession = new MemoryStorage();
const a = createWindow('?tester=1&am=1&at=tab-A&ts=launch-A&tp=pass', rawSession);
const b = createWindow('?tester=1&am=1&at=tab-B&ts=launch-B&tp=pass', rawSession);

assert.strictEqual(a.window.wwEmbeddedStorage.embedded, true);
assert.strictEqual(b.window.wwEmbeddedStorage.embedded, true);
assert.strictEqual(a.window.wwEmbeddedStorage.tabId, 'tab-A');
assert.strictEqual(b.window.wwEmbeddedStorage.tabId, 'tab-B');

a.window.wwEmbeddedStorage.session.setItem('ww_token', 'token-A');
a.window.wwEmbeddedStorage.session.setItem('ww_account_id', 'account-A');
a.window.wwAccount.setName('Alice');
b.window.wwEmbeddedStorage.session.setItem('ww_token', 'token-B');
b.window.wwEmbeddedStorage.session.setItem('ww_account_id', 'account-B');
b.window.wwAccount.setName('Bob');

assert.strictEqual(a.window.wwEmbeddedStorage.session.getItem('ww_token'), 'token-A');
assert.strictEqual(b.window.wwEmbeddedStorage.session.getItem('ww_token'), 'token-B');
assert.strictEqual(a.window.wwAccount.getIdentity().accountId, 'account-A');
assert.strictEqual(b.window.wwAccount.getIdentity().accountId, 'account-B');
assert.strictEqual(a.window.wwAccount.getName(), 'Alice');
assert.strictEqual(b.window.wwAccount.getName(), 'Bob');

const rawKeys = Array.from({length: rawSession.length}, (_, i) => rawSession.key(i));
assert(rawKeys.some(k => k.startsWith('ww_admin_tab_tab-A__')));
assert(rawKeys.some(k => k.startsWith('ww_admin_tab_tab-B__')));
assert.strictEqual(rawSession.getItem('ww_token'), null, 'tester state must not leak into raw sessionStorage');

// Clearing one embedded tab may not clear another tab's tester/game identity.
a.window.wwEmbeddedStorage.session.clear();
assert.strictEqual(b.window.wwEmbeddedStorage.session.getItem('ww_token'), 'token-B');
assert.strictEqual(b.window.wwAccount.getName(), 'Bob');

console.log('admin-internal-browser-storage: PASS');
