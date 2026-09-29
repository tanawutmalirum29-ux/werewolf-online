const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const src = fs.readFileSync('public/js/shared.config-client.js', 'utf8');
const calls = [];
let now = 0;

class FakeHeaders {
  constructor(input = {}) {
    this.map = Object.create(null);
    if (input instanceof FakeHeaders) input.forEach((v, k) => this.set(k, v));
    else Object.keys(input || {}).forEach(k => this.set(k, input[k]));
  }
  set(k, v) { this.map[String(k).toLowerCase()] = String(v); }
  get(k) { return this.map[String(k).toLowerCase()] || null; }
  forEach(cb) { Object.keys(this.map).forEach(k => cb(this.map[k], k)); }
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new FakeHeaders(headers),
    text: () => Promise.resolve(body),
  };
}

let mode = 'success';
const context = {
  window: {},
  Headers: FakeHeaders,
  AbortController,
  Promise,
  setTimeout,
  clearTimeout,
  Math,
  Date,
  JSON,
  String,
  Number,
  Object,
  Array,
  sessionStorage: {
    data: Object.create(null),
    getItem(k) { return this.data[k] || null; },
    setItem(k, v) { this.data[k] = String(v); },
  },
};
context.window = context;
context.window.__WW_DIAG_SESSION_ID__ = 'ses-test';
context.window.__WW_DIAG_REPORT_CONFIG_FAILURE__ = (detail) => { context.__failure = detail; };
context.window.fetch = (url, init) => {
  calls.push({ url, headers: new FakeHeaders(init.headers) });
  const attempt = Number(new FakeHeaders(init.headers).get('X-WW-Config-Attempt') || 0);
  if (mode === 'transient' && attempt < 3) return Promise.reject(Object.assign(new TypeError('Load failed'), { name: 'TypeError' }));
  if (mode === 'timeout') return new Promise((resolve, reject) => setTimeout(() => reject(Object.assign(new Error('/api/config request timed out'), { name: 'ConfigTimeoutError' })), 5));
  if (mode === 'caller-abort') return new Promise((resolve, reject) => {
    const fail = () => reject(Object.assign(new Error('caller aborted config request'), { name: 'AbortError' }));
    if (init.signal && init.signal.aborted) fail();
    else if (init.signal) init.signal.addEventListener('abort', fail, { once: true });
  });
  return Promise.resolve(response(200, JSON.stringify({ ok: true, version: 'v-test' }), {
    'X-WW-Config-Request-Id': 'srvreq-' + attempt,
    'X-WW-Server-Request-Id': 'srvreq-' + attempt,
    'X-WW-Config-Attempt': String(attempt),
    'X-WW-Config-Logical-Id': new FakeHeaders(init.headers).get('X-WW-Config-Logical-Id'),
  }));
};

vm.runInNewContext(src, context, { filename: 'shared.config-client.js' });

(async () => {
  const a = await context.window.wwGetConfig({});
  assert.strictEqual(a.version, 'v-test');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].headers.get('X-WW-Config-Attempt'), '1');
  assert.ok(calls[0].headers.get('X-WW-Config-Logical-Id'));
  assert.strictEqual(calls[0].headers.get('X-WW-Config-Retry-Managed'), '1');

  mode = 'transient';
  calls.length = 0;
  context.__failure = null;
  const b = await context.window.wwGetConfig({ force: true });
  assert.strictEqual(b.version, 'v-test');
  assert.strictEqual(calls.length, 3, 'transient config failures should use one retry chain (3 total attempts)');
  assert.deepStrictEqual(calls.map(c => c.headers.get('X-WW-Config-Attempt')), ['1','2','3']);
  assert.strictEqual(calls[0].headers.get('X-WW-Config-Logical-Id'), calls[1].headers.get('X-WW-Config-Logical-Id'));
  assert.strictEqual(calls[1].headers.get('X-WW-Config-Logical-Id'), calls[2].headers.get('X-WW-Config-Logical-Id'));

  mode = 'timeout';
  calls.length = 0;
  context.__failure = null;
  await assert.rejects(() => context.window.wwGetConfig({ force: true }), /timed out/);
  assert.strictEqual(calls.length, 3, 'timeout should stop after configured max attempts');
  assert.ok(context.__failure);
  assert.strictEqual(context.__failure.kind, 'config_timeout');

  mode = 'caller-abort';
  calls.length = 0;
  context.__failure = null;
  const controller = new AbortController();
  const aborted = context.window.wwGetConfig({ force: true, init: { signal: controller.signal } });
  controller.abort();
  await assert.rejects(() => aborted, /caller aborted config request/);
  assert.strictEqual(calls.length, 1, 'caller cancellation must not trigger a retry chain');
  assert.strictEqual(context.__failure, null, 'caller cancellation must not create a diagnostic incident');

  console.log('config client runtime behavior: PASS');
})().catch((err) => { console.error(err); process.exitCode = 1; });
