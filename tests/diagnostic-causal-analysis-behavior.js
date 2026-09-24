const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const serverText = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = serverText.indexOf('function diagnosticAckCode(');
const end = serverText.indexOf('\nfunction currentDiagnosticContext()', start);
assert(start >= 0 && end > start, 'diagnostic analysis block not found');

const sandbox = {
    safeDiagnosticValue(value) { return value; },
    publicDiagnosticText(value) { return String(value ?? ''); },
    DIAGNOSTIC_CAUSAL_MAX_NODES: 36,
    DIAGNOSTIC_CAUSAL_MAX_EDGES: 72,
    DIAGNOSTIC_CAUSAL_WINDOW_MS: 3 * 60 * 1000,
    DIAGNOSTIC_CAUSAL_STRONG_WINDOW_MS: 15 * 60 * 1000,
};
const block = `${serverText.slice(start, end)}\nthis.__api={isSuccessfulDiagnosticAck,buildDiagnosticAnalysis,buildDiagnosticCausalGraph,diagnosticStageForItem,diagnosticEventCode,diagnosticCausalPair};`;
vm.runInNewContext(block, sandbox, { filename: 'diagnostic-analysis-block.js' });
const api = sandbox.__api;

assert(api.isSuccessfulDiagnosticAck('list_open_rooms', [{ roomId: 'I3V9J' }]) === true, 'legacy room-list array must be success');
assert(api.isSuccessfulDiagnosticAck('join_room', [{ ok: true }]) === false, 'array payload for non-room-list event must not be auto-success');
assert(api.isSuccessfulDiagnosticAck('join_room', { ok: true }) === true, 'explicit ok:true ACK must be success');
assert(api.diagnosticStageForItem({ type: 'socket', label: 'ack:join_room', detail: { code: 'ACCOUNT_TOKEN_REQUIRED', ok: false } }) === 'socket.server_response', 'ACK breadcrumb stage should be server response');
assert(api.diagnosticStageForItem({ kind: 'socket_ack_error', context: { code: 'TESTER_PASS_INVALID' } }) === 'tester.authentication', 'tester auth code should map to tester stage');

const related = [
    {
        id: 'h1', time: '2026-09-24T06:00:00.000Z', source: 'server', type: 'socket', kind: 'socket_breadcrumb',
        label: 'handler.start:join_room', detail: {
            operationId: 'op-1',
            authObservation: {
                requestedTester: true,
                testerPassPresented: false,
                testerPassValid: false,
                testerGranted: false,
                hasAccountToken: false,
                hasAccountId: true,
            },
        },
    },
    {
        id: 'a1', time: '2026-09-24T06:00:00.020Z', source: 'server', type: 'socket', kind: 'socket_breadcrumb',
        label: 'ack:join_room', detail: { ok: false, code: 'ACCOUNT_TOKEN_REQUIRED', operationId: 'op-1' },
    },
    {
        id: 'c1', time: '2026-09-24T06:00:00.030Z', source: 'client', kind: 'socket_ack_error',
        message: 'ACCOUNT_TOKEN_REQUIRED', context: { eventName: 'join_room', operationId: 'op-1', code: 'ACCOUNT_TOKEN_REQUIRED' },
    },
    {
        id: 'd1', time: '2026-09-24T06:00:00.050Z', source: 'client', type: 'socket', kind: 'socket_breadcrumb',
        label: 'disconnect', detail: { reason: 'io server disconnect' },
    },
];
const primary = related[2];
const analysis = api.buildDiagnosticAnalysis(primary, related);

assert(analysis.causeCode === 'ACCOUNT_TOKEN_REQUIRED', `expected ACCOUNT_TOKEN_REQUIRED, got ${analysis.causeCode}`);
assert(analysis.failureStage === 'account.authentication', `expected account.authentication, got ${analysis.failureStage}`);
assert(analysis.rootCauseSource === 'server', `expected server root, got ${analysis.rootCauseSource}`);
assert(analysis.confidence === 'high', `expected high confidence, got ${analysis.confidence}`);
assert(analysis.causalChain.some((x) => x.stage === 'socket.server_handler'), 'causal chain should contain server handler start');
assert(analysis.causalChain.some((x) => x.stage === 'tester.authentication' && /did not receive a tester pass/.test(x.evidence)), 'causal chain should explain tester handshake mismatch');
assert(analysis.causalChain.some((x) => x.stage === 'socket.server_response'), 'causal chain should contain server ACK rejection');
assert(analysis.downstreamEffects.some((x) => x.stage === 'socket.transport'), 'downstream disconnect should be preserved');
assert(analysis.correlation.operationId === 'op-1', 'correlation must preserve operation id');
assert(analysis.timeline.some((x) => x.label === 'ack:join_room' && x.code === 'ACCOUNT_TOKEN_REQUIRED'), 'timeline must retain the rejecting ACK');

const graphEvents = [
    { id:'g0', time:'2026-09-24T06:00:00.000Z', source:'server', kind:'aws_dynamodb_error', message:'DynamoDB AccessDenied', traceId:'tr-g', sessionId:'ses-g', operationId:'op-g', roomId:'I3V9J', permission:{accessDenied:true,action:'dynamodb:GetItem'} },
    { id:'g1', time:'2026-09-24T06:00:00.050Z', source:'server', type:'socket', kind:'socket', label:'handler.start:join_room', context:{eventName:'join_room',operationId:'op-g'}, traceId:'tr-g', sessionId:'ses-g', operationId:'op-g', roomId:'I3V9J' },
    { id:'g2', time:'2026-09-24T06:00:00.090Z', source:'server', type:'socket', kind:'socket', label:'ack:join_room', detail:{ok:false,code:'ACCOUNT_TOKEN_REQUIRED'}, context:{operationId:'op-g'}, traceId:'tr-g', sessionId:'ses-g', operationId:'op-g', roomId:'I3V9J' },
    { id:'g3', time:'2026-09-24T06:00:00.110Z', source:'client', kind:'socket_ack_error', message:'ACCOUNT_TOKEN_REQUIRED', context:{eventName:'join_room',operationId:'op-g',code:'ACCOUNT_TOKEN_REQUIRED'}, traceId:'tr-g', sessionId:'ses-g', operationId:'op-g', roomId:'I3V9J' },
    { id:'g4', time:'2026-09-24T06:00:00.160Z', source:'client', kind:'unhandled_rejection', message:'account bootstrap failed', context:{operationId:'op-g'}, traceId:'tr-g', sessionId:'ses-g', operationId:'op-g', roomId:'I3V9J' },
];
const graph = api.buildDiagnosticCausalGraph(graphEvents[3], graphEvents);
assert(graph.upstreamCauseIds.includes('g2'), 'graph should connect rejecting server ACK as upstream of client ACK error');
assert(graph.downstreamEffectIds.includes('g4'), 'graph should connect unhandled rejection as downstream effect');
assert(graph.impact.causedAnotherLog === true, 'primary ACK error should report downstream log impact');
assert(graph.edges.some((e) => e.from === 'g0' && e.to === 'g3' && e.relation === 'probable_cause' && e.confidence === 'high'), 'graph should connect persistence/IAM root to client failure');

const unrelatedRoomEvents = [
    { id:'r1', time:'2026-09-24T06:00:00.000Z', source:'client', kind:'http_error', status:500, message:'one request failed', roomId:'R1' },
    { id:'r2', time:'2026-09-24T06:00:00.100Z', source:'client', kind:'unhandled_rejection', message:'different flow failed', roomId:'R1' },
];
assert(api.diagnosticCausalPair(unrelatedRoomEvents[0], unrelatedRoomEvents[1]) === null, 'same room alone must not be treated as causal without strong semantic evidence');


console.log('diagnostic causal-analysis behavior: PASS');
