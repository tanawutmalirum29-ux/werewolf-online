const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const serverText = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = serverText.indexOf('function publicDiagnosticText(');
const end = serverText.indexOf('\nasync function persistDiagnosticShare(', start);
assert(start >= 0 && end > start, 'public diagnostic helper block not found');
const sandbox = { crypto, DIAGNOSTIC_SHARE_TOKEN_BYTES: 18 };
const block = `${serverText.slice(start, end)}\nthis.__api={publicDiagnosticText,publicDiagnosticValue,publicDiagnosticResource,diagnosticShareToken,validDiagnosticShareToken,diagnosticShareText,diagnosticShareHtml,diagnosticShareFocusedBundle,diagnosticShareEventUrl};`;
vm.runInNewContext(block, sandbox, { filename: 'diagnostic-share-block.js' });
const api = sandbox.__api;

const token = api.diagnosticShareToken();
assert(api.validDiagnosticShareToken(token), 'share token must pass strict token validation');
assert(token.length >= 20 && token.length <= 80, 'share token length must remain bounded');
assert(api.validDiagnosticShareToken('short') === false, 'short tokens must be rejected');

const secretText = 'https://x.test/join?tp=SUPERSECRET123456789&accountToken=abc123 user@example.com Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ eyJ' + 'a'.repeat(24) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12);
const safeText = api.publicDiagnosticText(secretText);
assert(!safeText.includes('SUPERSECRET123456789'), 'free-form text must redact tp');
assert(!safeText.includes('user@example.com'), 'free-form text must redact email');
assert(!safeText.includes('Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'free-form text must redact bearer credential');
assert(!safeText.includes('eyJ' + 'a'.repeat(24)), 'free-form text must redact JWT-like token');

const safeObj = api.publicDiagnosticValue({ accountToken:'SECRET', email:'user@example.com', nested:{ password:'PASS', ok:true } });
assert(!('accountToken' in safeObj) && !('email' in safeObj), 'object sanitizer must redact identity/credential keys');
assert(!('password' in safeObj.nested), 'nested object sanitizer must redact password');

const resource = api.publicDiagnosticResource('arn:aws:dynamodb:ap-southeast-7:123456789012:table/WerewolfPlayerStats');
assert(resource.includes(':***:table/'), 'AWS account id must be masked');
assert(!resource.includes('123456789012'), 'raw AWS account id must not remain');

const bundle = {
    createdAt:'2026-09-24T06:00:00.000Z', expiresAt:'2026-09-27T06:00:00.000Z', reportId:'evt-1',
    primary:{kind:'socket_ack_error',source:'client',page:'player',traceId:'tr-1',sessionId:'ses-1',operationId:'op-1',requestId:'req-1',roomId:'I3V9J',fingerprint:'fp-1'},
    analysis:{rootCause:'server rejected authentication',causeCode:'ACCOUNT_TOKEN_REQUIRED',failureStage:'account.authentication',rootCauseSource:'server',confidence:'high',firstFailureAt:'2026-09-24T06:00:00.000Z',rootCauseAt:'2026-09-24T06:00:00.020Z',lastSeenAt:'2026-09-24T06:00:00.050Z',relatedEventCount:4,evidence:['ack:ACCOUNT_TOKEN_REQUIRED'],blockingEvent:{id:'a1'},causalChain:[{status:'rejected',stage:'socket.server_response',evidence:'server rejected join_room'}],downstreamEffects:[{time:'2026-09-24T06:00:00.050Z',stage:'socket.transport',evidence:'disconnect'}],correlation:{operationId:'op-1'},nextStep:'inspect auth handshake'},
    relatedEvents:[],
};
const text = api.diagnosticShareText(bundle);
assert(text.includes('CAUSAL CHAIN'), 'share text must contain causal chain');
assert(text.includes('ACCOUNT_TOKEN_REQUIRED'), 'share text must contain cause code');
const html = api.diagnosticShareHtml(bundle, token);
assert(html.includes(`${token}.json`), 'share HTML must expose JSON link');
assert(html.includes('noindex,nofollow,noarchive'), 'share HTML must discourage indexing');

const bundle2 = {
    ...bundle,
    shareBaseUrl:'https://example.test',
    primary:{...bundle.primary},
    relatedEvents:[
        {...bundle.primary, id:'evt-1', kind:'socket_ack_error', message:'primary'},
        {id:'evt-0',time:'2026-09-24T05:59:59.000Z',source:'server',kind:'socket',message:'cause'},
        {id:'evt-2',time:'2026-09-24T06:00:01.000Z',source:'client',kind:'unhandled_rejection',message:'effect'},
    ],
    causalGraph:{
        primaryId:'evt-1',nodeCount:3,edgeCount:2,
        nodes:[{id:'evt-0',kind:'socket',code:'SERVER_ERROR',stage:'server.handler',message:'cause'},{id:'evt-1',kind:'socket_ack_error',code:'ACCOUNT_TOKEN_REQUIRED',stage:'account.authentication',message:'primary'},{id:'evt-2',kind:'unhandled_rejection',code:'ACCOUNT_BOOTSTRAP_FAILED',stage:'browser.runtime',message:'effect'}],
        edges:[
            {from:'evt-0',to:'evt-1',relation:'probable_cause',confidence:'high',score:120,timeDeltaMs:20,reasons:['same operation']},
            {from:'evt-1',to:'evt-2',relation:'downstream_effect',confidence:'high',score:110,timeDeltaMs:30,reasons:['same operation']},
        ],
        upstreamCauseIds:['evt-0'],downstreamEffectIds:['evt-2'],correlatedEventIds:[],rootPath:[{id:'evt-0',kind:'socket',code:'SERVER_ERROR',stage:'server.handler',message:'cause'}],
        impact:{causedAnotherLog:true,downstreamCount:1,upstreamCount:1,correlatedCount:0,downstreamEventIds:['evt-2'],upstreamEventIds:['evt-0'],statement:'test'},
    },
    nodeReports:[
        {eventId:'evt-0',analysis:{rootCause:'root',causeCode:'SERVER_ERROR',failureStage:'server.handler',confidence:'high'}},
        {eventId:'evt-1',analysis:bundle.analysis},
        {eventId:'evt-2',analysis:{rootCause:'effect root',causeCode:'ACCOUNT_BOOTSTRAP_FAILED',failureStage:'browser.runtime',confidence:'high'}},
    ],
};
const nestedUrl = api.diagnosticShareEventUrl(bundle2, token, 'evt-0', false);
assert(nestedUrl === `https://example.test/diagnostics/share/${token}/event/evt-0`, 'nested event report URL must be deterministic and share-token scoped');
const focused = api.diagnosticShareFocusedBundle(bundle2, 'evt-2');
assert(focused && focused.focusEventId === 'evt-2', 'focused share bundle should select the requested graph node');
const focusedText = api.diagnosticShareText(focused, token, 'evt-2');
assert(focusedText.includes('FOCUSED REPORT URL:'), 'focused text must expose its own report URL');
assert(focusedText.includes('UPSTREAM CAUSES'), 'focused text must show upstream causes');
assert(focusedText.includes('evt-1'), 'focused text must retain causal neighbor links');
const focusedHtml = api.diagnosticShareHtml(focused, token, 'evt-2');
assert(focusedHtml.includes('target="_blank"'), 'share HTML must render report URLs as clickable anchors');


console.log('diagnostic share behavior: PASS');
