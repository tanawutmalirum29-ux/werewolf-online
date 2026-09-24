const fs = require('fs');
const assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
assert(!source.includes('BatchGetCommand'), 'room recovery must not require BatchGetCommand');
assert(!source.includes('dynamodb:BatchGetItem'), 'diagnostic permissions must not require BatchGetItem after recovery change');
const marker = 'new GetCommand({';
assert(source.includes(marker), 'room recovery should read snapshots with GetCommand');
console.log('room-recovery IAM regression: PASS');
