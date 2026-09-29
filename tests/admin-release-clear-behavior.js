const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

(async () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  const start = admin.indexOf('const ADMIN_UPDATE_CHECK_MS =');
  const end = admin.indexOf('const adminErrorMessages =');
  assert(start >= 0 && end > start, 'Admin shared update section missing');
  const source = admin.slice(start, end);

  const elements = new Map();
  function makeEl(tag){
    return {
      tagName: tag.toUpperCase(), id:'', style:{}, innerHTML:'', isConnected:true,
      remove(){ elements.delete(this.id); this.isConnected=false; },
      appendChild(){}, setAttribute(){}, addEventListener(){},
    };
  }

  let checks = 0;
  const sandbox = {
    updateRunningVersion(){},
    document: {
      hidden: false,
      getElementById(id){ return elements.get(id) || null; },
      createElement: makeEl,
      body: { appendChild(el){ elements.set(el.id, el); } },
      addEventListener(){},
    },
    window: {
      setInterval(){ return 1; },
      clearInterval(){},
      location:{replace(){}},
      addEventListener(){},
      WWUpdateDetector:{
        async check(){ checks++; return {state: checks === 1 ? 'update' : 'current', version:'version-new', data:{appVersion:'v-new'} }; },
        setKnownVersion(v){ return v; },
      },
    },
    Date, Math, console,
  };

  vm.runInNewContext(source + '\nglobalThis.__test={checkAdminUpdate,showAdminUpdateNotice,getState:()=>({shown:adminUpdateShown})};', sandbox);

  await sandbox.__test.checkAdminUpdate();
  assert.strictEqual(sandbox.__test.getState().shown, true, 'update notice should latch after a mismatch');
  assert(elements.has('adminUpdateNotice'), 'update notice element should be present');

  // A later matching response must not cause a visible flicker or silently reset the update latch.
  await sandbox.__test.checkAdminUpdate();
  assert.strictEqual(sandbox.__test.getState().shown, true, 'matching response must not clear the shown update notice');
  assert(elements.has('adminUpdateNotice'), 'update notice must remain until Admin is reloaded');

  sandbox.__test.showAdminUpdateNotice('version-new');
  assert.strictEqual(elements.size, 1, 'repeated update notice calls must not create duplicates');

  console.log('admin-release-clear behavior: PASS');
})().catch((err) => { console.error(err); process.exit(1); });
