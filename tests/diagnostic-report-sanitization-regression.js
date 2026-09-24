const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert(server.includes('function publicDiagnosticValue'), 'public diagnostic sanitizer missing');
assert(server.includes('/token|secret|password|authorization|cookie|accountToken|googleSub|email|ipAddress|remoteAddress|hostname/i'), 'public share sanitizer must redact secret/identity/network fields');
assert(server.includes('function publicDiagnosticResource'), 'public IAM resource sanitizer missing');
assert(server.includes('arn:aws:$1:$2:***:'), 'public IAM resource must mask AWS account ID');
assert(server.includes('function publicDiagnosticEvent'), 'public event projection missing');
assert(server.includes('diagnosticShareText(bundle)'), 'share text must be generated server-side for AI/web readers');
assert(server.includes('<pre>'), 'human-readable share page must contain plain text in server-rendered HTML');
assert(server.includes('machine-readable JSON'), 'human-readable share page must link to machine-readable JSON');
assert(server.includes('function publicDiagnosticText'), 'public share must sanitize free-form message and stack text');

console.log('diagnostic report sanitization regression: PASS');
