const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('function isLikelyAwsIamAction');
const end = server.indexOf('function diagnosticTimeMs', start);
assert.ok(start >= 0 && end > start, 'diagnostic IAM helper block must be extractable');

const sandbox = {
  Set,
  DIAGNOSTIC_AWS_SERVICE_PREFIXES: new Set(['dynamodb','elasticbeanstalk','s3','cloudfront']),
};
const block = `${server.slice(start, end)}\nfunction diagnosticEventCode(item = {}) { const ctx=item?.context||item?.detail||{}; return String(ctx.ackCode||ctx.serverCode||ctx.code||ctx.errorCode||item?.errorCode||item?.causeCode||'').toUpperCase(); }\nthis.api={isLikelyAwsIamAction,hasAuthoritativeIamEvidence,classifyDiagnosticCause,diagnosticStageForItem,diagnosticIsFailureEvent};`;
vm.runInNewContext(`const DIAGNOSTIC_AWS_SERVICE_PREFIXES = new Set(['dynamodb','elasticbeanstalk','s3','cloudfront']);\n${block}`, sandbox, {filename:'diagnostic-iam-authority-behavior.js'});
const api = sandbox.api;

assert.strictEqual(api.isLikelyAwsIamAction('dynamodb:GetItem'), true, 'DynamoDB action must be accepted as AWS IAM action');
assert.strictEqual(api.isLikelyAwsIamAction('node:fs'), false, 'node:fs must never be treated as AWS IAM action');
assert.strictEqual(api.isLikelyAwsIamAction('node:internal'), false, 'node:internal must never be treated as AWS IAM action');
assert.strictEqual(api.isLikelyAwsIamAction('madeup:Action'), false, 'unknown non-app service action must not become IAM evidence');

assert.strictEqual(api.hasAuthoritativeIamEvidence({source:'server', permission:{accessDenied:true,action:'dynamodb:GetItem'}}), true, 'structured DynamoDB denial is authoritative');
assert.strictEqual(api.hasAuthoritativeIamEvidence({source:'server', permission:{accessDenied:true,action:'node:fs'}}), false, 'replay node:fs denial is not AWS IAM evidence');
assert.strictEqual(api.hasAuthoritativeIamEvidence({source:'server', message:'AccessDeniedException: not authorized to perform: dynamodb:GetItem on resource'}), true, 'explicit AWS AccessDeniedException must be authoritative');
assert.strictEqual(api.hasAuthoritativeIamEvidence({source:'server', message:'EACCES: permission denied, open server.js'}), false, 'filesystem EACCES must not become IAM evidence');
assert.strictEqual(api.hasAuthoritativeIamEvidence({source:'server', message:'AccessDenied while reading local file'}), false, 'generic AccessDenied without AWS evidence must remain unclassified');
assert.strictEqual(api.hasAuthoritativeIamEvidence({source:'client', permission:{accessDenied:true,action:'dynamodb:GetItem'}}), false, 'client evidence alone must not become IAM');

const nodeCause = api.classifyDiagnosticCause({source:'server',kind:'bug_replay_failure',message:'permission denied',permission:{accessDenied:true,action:'node:fs'},context:{}});
assert.strictEqual(nodeCause.code, 'UNCLASSIFIED', 'node runtime permission must stay unclassified');
assert.notStrictEqual(api.diagnosticStageForItem({source:'server',permission:{accessDenied:true,action:'node:fs'},message:'permission denied'}), 'server.persistence', 'node runtime permission must not be staged as persistence');

const awsCause = api.classifyDiagnosticCause({source:'server',kind:'aws_error',message:'AccessDeniedException',permission:{accessDenied:true,action:'dynamodb:GetItem'},context:{}});
assert.strictEqual(awsCause.code, 'IAM_ACCESS_DENIED', 'AWS DynamoDB denial must remain IAM');

console.log('diagnostic IAM authority behavior: PASS');
