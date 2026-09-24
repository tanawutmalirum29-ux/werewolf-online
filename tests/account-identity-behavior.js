const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require('path').join(__dirname, '..', 'public/js/account.identity.js'), 'utf8');

function makeStorage() {
  const data = new Map();
  return {
    getItem: (k) => data.has(k) ? data.get(k) : null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
    _data: data,
  };
}

function makeEnv() {
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const listeners = new Map();
  const window = {
    crypto: { randomUUID: () => 'token-a-' + Math.random().toString(36).slice(2) },
    addEventListener(name, fn) {
      const list = listeners.get(name) || [];
      list.push(fn);
      listeners.set(name, list);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach(fn => fn(event));
      return true;
    },
    CustomEvent: function(type, init) { this.type = type; this.detail = init?.detail; },
  };
  const context = {
    window,
    localStorage,
    sessionStorage,
    location: { search: '' },
    URLSearchParams,
    crypto: window.crypto,
    console,
    CustomEvent: window.CustomEvent,
  };
  vm.runInNewContext(source, context, { filename: 'account.identity.js' });
  return { account: window.wwAccount, localStorage, window };
}

(async () => {
  // 1) First open: a token is generated, accountId is empty, and one bootstrap is sent.
  {
    const { account, localStorage } = makeEnv();
    const identity = account.getIdentity();
    assert(identity.accountToken, 'first-open token should be generated');
    assert.strictEqual(identity.accountId, '', 'first-open accountId should be empty');
    let emits = 0;
    const socket = { emit(event, payload, cb) { emits++; assert.strictEqual(event, 'account_bootstrap'); assert.strictEqual(payload.accountId, ''); assert(payload.accountToken); cb({ ok: true, account: { accountId: 'new-id', displayName: 'Alice', accountType: 'temporary', temporaryExpiresAt: '2030-01-01T00:00:00.000Z' } }); } };
    const result = await account.bootstrap(socket, { name: 'Alice', page: 'index' });
    assert.strictEqual(emits, 1);
    assert.strictEqual(result.accountId, 'new-id');
    assert.strictEqual(localStorage.getItem('ww_account_id'), 'new-id');
    assert.strictEqual(localStorage.getItem('ww_account_name'), 'Alice');
    assert.strictEqual(localStorage.getItem('ww_account_recreate_required'), null);
  }

  // 2) Deleted account: it must not issue a second bootstrap or silently create a replacement.
  {
    const { account, localStorage } = makeEnv();
    localStorage.setItem('ww_account_id', 'old-id');
    localStorage.setItem('ww_account_token', 'old-token');
    localStorage.setItem('ww_account_name', 'OldName');
    let emits = 0;
    const socket = { emit(event, payload, cb) { emits++; cb({ ok: false, code: 'ACCOUNT_DELETED' }); } };
    await assert.rejects(() => account.bootstrap(socket, { name: 'OldName', page: 'index' }), e => e.code === 'ACCOUNT_DELETED_REQUIRES_RECREATE');
    assert.strictEqual(emits, 1, 'deleted account should not recursively bootstrap');
    assert.strictEqual(account.isRecreationRequired(), true);
    assert.strictEqual(localStorage.getItem('ww_account_id'), null);
    assert.strictEqual(localStorage.getItem('ww_account_token'), null);
    assert.strictEqual(localStorage.getItem('ww_account_name'), null);

    const blocked = account.getIdentity();
    assert.strictEqual(blocked.accountToken, '', 'blocked account must not generate a new token automatically');
    await assert.rejects(() => account.bootstrap(socket, { name: '', page: 'index' }), e => e.code === 'ACCOUNT_RECREATE_REQUIRED');
    assert.strictEqual(emits, 1, 'blocked state should not call server');
  }

  // 3) Explicit recreation: only after the user starts a new account does a new token appear.
  {
    const { account, localStorage } = makeEnv();
    account.markAccountDeleted('account_deleted');
    const newIdentity = account.beginNewTemporaryAccount('NewName');
    assert.strictEqual(account.isRecreationRequired(), false);
    assert.strictEqual(newIdentity.accountId, '');
    assert(newIdentity.accountToken, 'new account must receive a fresh token');
    assert.strictEqual(newIdentity.name, 'NewName');
    const oldToken = localStorage.getItem('ww_account_token');
    let emittedPayload = null;
    const socket = { emit(event, payload, cb) { emittedPayload = payload; cb({ ok: true, account: { accountId: 'brand-new-id', displayName: 'NewName', accountType: 'temporary' } }); } };
    const result = await account.bootstrap(socket, { name: 'NewName', page: 'index' });
    assert.strictEqual(result.accountId, 'brand-new-id');
    assert.strictEqual(emittedPayload.accountId, '');
    assert.strictEqual(emittedPayload.accountToken, oldToken);
    assert.strictEqual(localStorage.getItem('ww_account_id'), 'brand-new-id');
  }

  console.log('PASS: account.identity behavioral lifecycle checks');
})().catch(err => { console.error(err); process.exit(1); });
