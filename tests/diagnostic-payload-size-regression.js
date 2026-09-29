const fs = require('fs');
const assert = require('assert');

const reporter = fs.readFileSync('public/js/error-reporter.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');

assert.match(reporter, /function diagnosticByteLength\(text\)/, 'diagnostic payload sizing must be byte-based');
assert.match(reporter, /function buildDiagnosticBody\(payload\)/, 'diagnostic payload must have a dedicated size-bounding builder');
assert.match(reporter, /diagnosticByteLength\(body\) <= 18000/, 'client must keep a safety margin below server parser limit');
assert.match(reporter, /if \(diagnosticByteLength\(body\) > 18000\) return;/, 'client must refuse to send an oversized final payload');
assert.match(server, /app\.post\("\/api\/diagnostics\/client-error", express\.json\(\{ limit: "64kb" \}\)/, 'diagnostic intake parser must have a defensive ceiling above client cap');
assert.match(server, /err\?\.type === "entity\.too\.large"/, 'server must recognize body-parser entity-too-large errors');
assert.match(server, /const status = isEntityTooLarge \? 413 : 500;/, 'oversized requests must return HTTP 413, not 500');
assert.match(server, /req\.path === "\/api\/diagnostics\/client-error"/, 'diagnostic intake parser errors must not recursively create another diagnostic');

console.log('diagnostic payload-size regression: PASS');
