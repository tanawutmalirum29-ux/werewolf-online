const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const auth = fs.readFileSync(path.join(root, 'public/js/admin-auth-tab.js'), 'utf8');
const channels = new Map();

class FakeBroadcastChannel {
    constructor(name) {
        this.name = name;
        this.onmessage = null;
        const set = channels.get(name) || new Set();
        set.add(this);
        channels.set(name, set);
    }
    postMessage(data) {
        const set = channels.get(this.name) || new Set();
        for (const peer of set) {
            if (peer === this || typeof peer.onmessage !== 'function') continue;
            setTimeout(() => peer.onmessage({ data }), 0);
        }
    }
    close() { channels.get(this.name)?.delete(this); }
}

function makeSandbox(instance, initial) {
    const storage = new Map(initial);
    const listeners = new Map();
    const window = {
        addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
        dispatch(type) { for (const fn of listeners.get(type) || []) fn(); },
        fetch: async () => ({ ok:true, json:async()=>({ok:true}) }),
    };
    const crypto = { randomUUID: () => instance + '-123456789012345678901234567890' };
    const sandbox = {
        window,
        sessionStorage: {
            getItem:k=>storage.has(k)?storage.get(k):null,
            setItem:(k,v)=>storage.set(k,String(v)),
            removeItem:k=>storage.delete(k),
        },
        crypto,
        BroadcastChannel: FakeBroadcastChannel,
        setTimeout,
        clearTimeout,
        Date,
        URLSearchParams,
        Headers,
        history:{replaceState(){}},
        location:{hash:'',origin:'https://game.example',assign(){}},
        fetch: window.fetch,
        console,
    };
    window.window=window;
    return {sandbox,storage,close:()=>window.dispatch('pagehide')};
}

(async()=>{
    const seed = [
        ['ww_admin_tab_id','shared-tab-id-1234567890'],
        ['ww_admin_tab_token','copied-admin-token'],
        ['ww_admin_tab_meta', JSON.stringify({email:'admin@example.com',provider:'google',expiresAt:Date.now()+60000})],
    ];

    // Existing active tab + later duplicate: the later page must rotate away and lose the copied token.
    const oldTab=makeSandbox('00000000000000000000000000000001',seed);
    vm.runInNewContext(auth,oldTab.sandbox);
    await oldTab.sandbox.window.WWAdminTabAuth.ready;
    const originalId=oldTab.sandbox.window.WWAdminTabAuth.getTabId();
    const newTab=makeSandbox('ffffffffffffffffffffffffffffffff',seed);
    vm.runInNewContext(auth,newTab.sandbox);
    await newTab.sandbox.window.WWAdminTabAuth.ready;
    await new Promise(r=>setTimeout(r,220));
    assert.strictEqual(oldTab.sandbox.window.WWAdminTabAuth.getTabId(), originalId, 'active original tab must retain its identity');
    assert.notStrictEqual(newTab.sandbox.window.WWAdminTabAuth.getTabId(), originalId, 'later duplicate tab must rotate its identity');
    assert.strictEqual(newTab.sandbox.window.WWAdminTabAuth.getToken(), '', 'rotated duplicate tab must drop copied credential');
    oldTab.close();
    newTab.close();

    // Reload of the same tab: closing handshake should let the next page inherit the same identity/session.
    const reloadOld=makeSandbox('11111111111111111111111111111111',seed);
    vm.runInNewContext(auth,reloadOld.sandbox);
    await reloadOld.sandbox.window.WWAdminTabAuth.ready;
    const reloadId=reloadOld.sandbox.window.WWAdminTabAuth.getTabId();
    const reloadStorage=[...reloadOld.storage.entries()];
    reloadOld.close();
    const reloadNew=makeSandbox('22222222222222222222222222222222',reloadStorage);
    vm.runInNewContext(auth,reloadNew.sandbox);
    await reloadNew.sandbox.window.WWAdminTabAuth.ready;
    await new Promise(r=>setTimeout(r,120));
    assert.strictEqual(reloadNew.sandbox.window.WWAdminTabAuth.getTabId(), reloadId, 'normal reload must preserve tab identity');
    assert.strictEqual(reloadNew.sandbox.window.WWAdminTabAuth.getToken(), 'copied-admin-token', 'normal reload must preserve tab credential');
    reloadNew.close();
    console.log('✅ admin tab duplication/reload guard behavior passed');
})().catch(err=>{ console.error(err); process.exit(1); });
