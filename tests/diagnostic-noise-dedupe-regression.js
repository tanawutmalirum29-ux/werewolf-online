const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function diagnosticNoiseDedupeKey');
const end = server.indexOf('function sanitizeBugReplayText', start);
assert.ok(start >= 0 && end > start, 'diagnostic noise dedupe helper block must exist');

const sandbox = { diagnosticEvents: [], DIAGNOSTIC_EVENT_DEDUPE_WINDOW_MS: 15000, DIAGNOSTIC_NOISY_DEDUPE_KINDS: new Set(['network_error','resource_error','fetch_aborted']), diagnosticTimeMs(item = {}) { const value = Date.parse(String(item.time || '')); return Number.isFinite(value) ? value : 0; } };
vm.runInNewContext(`${server.slice(start, end)}\nthis.api={diagnosticNoiseDedupeKey,findRecentDiagnosticNoiseDuplicate};`, sandbox, {filename:'diagnostic-noise-dedupe-block.js'});
const api = sandbox.api;

const first = {id:'evt-1',time:'2026-09-26T10:00:00.000Z',source:'client',page:'admin',kind:'network_error',fingerprint:'abc',endpoint:'/api/config',file:'',traceId:'trace-1',status:0};
const duplicate = {...first,id:'evt-2',time:'2026-09-26T10:00:05.000Z'};
const differentTrace = {...first,id:'evt-3',time:'2026-09-26T10:00:05.000Z',traceId:'trace-2'};
const late = {...first,id:'evt-4',time:'2026-09-26T10:00:20.001Z'};

assert.ok(api.diagnosticNoiseDedupeKey(first), 'noisy errors with correlation must get a dedupe key');
assert.strictEqual(api.diagnosticNoiseDedupeKey({kind:'javascript_error',source:'client',page:'admin',traceId:'trace-1',fingerprint:'abc'}), '', 'non-noisy errors must not be coalesced');
sandbox.diagnosticEvents.push(first);
assert.strictEqual(api.findRecentDiagnosticNoiseDuplicate(duplicate).id, 'evt-1', 'same noisy incident within window must dedupe');
assert.strictEqual(api.findRecentDiagnosticNoiseDuplicate(differentTrace), null, 'different trace must remain separate');
assert.strictEqual(api.findRecentDiagnosticNoiseDuplicate(late), null, 'events outside dedupe window must remain separate');

const reporter = fs.readFileSync('public/js/error-reporter.js', 'utf8');
assert.ok(reporter.includes('resourceError: true'), 'resource error report must mark the event as a resource failure');
assert.ok(reporter.includes('resourceTag:'), 'resource diagnostic must retain the element tag');
assert.ok(reporter.includes('resourceUrl:'), 'resource diagnostic must retain the failing resource URL/path');
assert.ok(reporter.includes('currentSrc:'), 'resource diagnostic must retain currentSrc when available');

const serverContract = server;
assert.ok(serverContract.includes('coalescedCount'), 'server must retain coalesced count');
assert.ok(serverContract.includes('coalescedEventIds'), 'server must retain coalesced event references');
assert.ok(serverContract.includes('refreshDiagnosticEventAnalysis(noiseDuplicate)'), 'coalesced event must refresh its analysis');

console.log('diagnostic noise dedupe regression: PASS');
