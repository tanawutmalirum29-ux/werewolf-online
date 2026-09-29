const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');

assert(server.includes('function hasAuthoritativeIamEvidence'));
assert(server.includes('source, message, stack, permission, context'));
assert(server.includes('String(source || "").toLowerCase() === "server" ? extractAwsPermissionFailure(fullText) : null'));
assert(server.includes('safeHintedCode'));
assert(server.includes('rawHintCode === "IAM_ACCESS_DENIED"'));

// A client-side "Load failed" path must not be converted into IAM by a stale client hint.
const reporter = fs.readFileSync('public/js/error-reporter.js', 'utf8');
assert(reporter.includes('causeCode: networkCode'));
assert(reporter.includes('classifyFetchFailure'));

console.log('diagnostic IAM false-positive regression: PASS');
