'use strict';

const assert = require('assert');
const {
    getGithubBugReportConfig,
    buildGithubBugReportStatus,
    buildGithubBugReportIssue,
    createGithubBugReportIssue,
    GITHUB_API_VERSION,
} = require('../utils/github-bug-reports');

function testConfig() {
    const config = getGithubBugReportConfig({
        GITHUB_BUG_REPORT_TOKEN: 'github_pat_test_only',
        GITHUB_BUG_REPORT_OWNER: 'tanawutmalirum29-ux',
        GITHUB_BUG_REPORT_REPO: 'werewolf-online',
        GITHUB_BUG_REPORT_LABELS: 'bug-report,runtime-audit',
        GITHUB_BUG_REPORT_TIMEOUT_MS: '9000',
    });
    assert.strictEqual(config.configured, true);
    assert.strictEqual(config.repository, 'tanawutmalirum29-ux/werewolf-online');
    assert.deepStrictEqual(config.labels, ['bug-report', 'runtime-audit']);
    assert.strictEqual(config.timeoutMs, 9000);
    const missing = getGithubBugReportConfig({ GITHUB_BUG_REPORT_TOKEN:'' });
    assert.strictEqual(missing.configured, false);
    assert.strictEqual(missing.configurationError, 'GITHUB_TOKEN_MISSING');
    assert.strictEqual(buildGithubBugReportStatus({ GITHUB_BUG_REPORT_TOKEN:'' }).configured, false);
    const status = buildGithubBugReportStatus({ GITHUB_BUG_REPORT_TOKEN:'github_pat_should_never_leave_server' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(status, 'token'), false);
    assert.strictEqual(status.repository, 'tanawutmalirum29-ux/werewolf-online');
}

function testIssueFormattingAndRedaction() {
    const issue = buildGithubBugReportIssue({
        event: {
            id:'evt_123', time:'2026-09-26T10:00:00Z', source:'client', kind:'socket_error', page:'host',
            message:'Bearer abcdefghijklmnopqrstuvwxyz user@example.com password=hunter2',
            endpoint:'/socket.io', traceId:'trace-1', sessionId:'session-1', operationId:'op-1', requestId:'req-1',
            context:{email:'user@example.com',token:'super-secret',eventName:'vote'},
            data:{authorization:'Bearer abcdefghijklmnopqrstuvwxyz'},
            stack:'Error: broken', roomId:'ABCD', status:500,
        },
        analysis:{causeCode:'SOCKET_ACK_ERROR',failureStage:'socket.client_send',rootCauseSource:'client',confidence:'high',rootCause:'ACK rejected',nextStep:'inspect server handler',causalChain:[{stage:'socket.client_send',status:'observed',evidence:'sent vote'}],timeline:[{time:'2026-09-26T10:00:00Z',stage:'socket',kind:'socket',code:'SOCKET_ACK_ERROR',label:'vote'}]},
        relatedEvents:[{id:'evt_2',time:'2026-09-26T09:59:59Z',kind:'handler_error',source:'server',page:'server',message:'handler failed email=admin@example.com token=still-secret'}],
        serverBreadcrumbs:[{time:'2026-09-26T09:59:58Z',type:'socket',label:'handler.start:vote',detail:{sessionId:'s',authorization:'Bearer abcdefghijklmnopqrstuvwxyz'}}],
        serverInfo:{appVersion:'v3-42',node:'v24.x',uptimeSec:12,serverClosed:false},
    });
    assert.ok(issue.title.startsWith('[BUG]'));
    const grouped = buildGithubBugReportIssue({ event:{id:'evt-root',time:'2026-09-26T10:00:00Z',source:'server',kind:'bug_replay_failure',page:'admin',message:'replay failed',incidentKeyHash:'abcdef0123456789abcdef0123456789abcdef01',operationId:'replay-op-1'}, incident:{incidentKeyHash:'abcdef0123456789abcdef0123456789abcdef01',rootEventId:'evt-root',requestedEventId:'evt-child',relatedFailureCount:4,replayRunId:'replay-op-1'} });
    assert.ok(grouped.title.includes('incident:abcdef0123456789ab'), `unexpected grouped title: ${grouped.title}`);
    assert.ok(grouped.body.includes('WEREWOLF-INCIDENT-KEY-HASH: abcdef0123456789abcdef0123456789abcdef01'));
    assert.ok(grouped.body.includes('Related failure events:** 4') || grouped.body.includes('Related failure events: ** 4'), `unexpected incident count line in body: ${grouped.body.match(/Related failure events[^\n]*/)?.[0] || 'missing'}`);
    assert.ok(issue.body.includes('WEREWOLF-DIAGNOSTIC-ID: evt_123'));
    assert.ok(!issue.body.includes('user@example.com'));
    assert.ok(!issue.body.includes('super-secret'));
    assert.ok(!issue.body.includes('hunter2'));
    assert.ok(!issue.body.includes('admin@example.com'));
    assert.ok(!issue.body.includes('still-secret'));
    assert.ok(issue.body.includes('Related failure events') || !issue.body.includes('[REDACTED] 4'));
    assert.ok(!issue.body.includes('events:[REDACTED]'), 'sanitizer must not mistake Markdown words ending in ts for a secret key');
    assert.ok(!issue.body.includes('Bearer abcdefghijklmnopqrstuvwxyz'));
    assert.ok(issue.body.includes('SOCKET_ACK_ERROR'));
    assert.ok(issue.body.includes('v3-42'));
    assert.ok(issue.body.length <= 60000);
}

async function testCreateIssue() {
    let received = null;
    const mockFetch = async (url, options) => {
        received = {url, options};
        return {
            ok:true,
            status:201,
            async text(){ return JSON.stringify({number:42,html_url:'https://github.com/tanawutmalirum29-ux/werewolf-online/issues/42',title:'[BUG] test'}); },
        };
    };
    const config = getGithubBugReportConfig({GITHUB_BUG_REPORT_TOKEN:'github_pat_test',GITHUB_BUG_REPORT_OWNER:'tanawutmalirum29-ux',GITHUB_BUG_REPORT_REPO:'werewolf-online'});
    const result = await createGithubBugReportIssue({
        issue:{title:'[BUG] test',body:'body'},
        config,
        fetchImpl:mockFetch,
    });
    assert.deepStrictEqual({number:result.number,issueUrl:result.issueUrl}, {number:42,issueUrl:'https://github.com/tanawutmalirum29-ux/werewolf-online/issues/42'});
    assert.strictEqual(received.options.method,'POST');
    assert.strictEqual(received.options.headers.Authorization,'Bearer github_pat_test');
    assert.strictEqual(received.options.headers['X-GitHub-Api-Version'],GITHUB_API_VERSION);
    const body = JSON.parse(received.options.body);
    assert.strictEqual(body.title,'[BUG] test');
    assert.deepStrictEqual(body.labels,['bug-report']);
}

async function testErrors() {
    const config = getGithubBugReportConfig({GITHUB_BUG_REPORT_TOKEN:'github_pat_test',GITHUB_BUG_REPORT_OWNER:'tanawutmalirum29-ux',GITHUB_BUG_REPORT_REPO:'werewolf-online'});
    await assert.rejects(
        createGithubBugReportIssue({issue:{title:'x',body:'y'},config,fetchImpl:async()=>({ok:false,status:401,text:async()=>JSON.stringify({message:'Bad credentials'})})}),
        (err)=>err.publicCode === 'GITHUB_AUTH_FAILED'
    );
    await assert.rejects(
        createGithubBugReportIssue({issue:{title:'x',body:'y'},config,fetchImpl:async()=>({ok:true,status:201,text:async()=>JSON.stringify({number:0,html_url:''})})}),
        (err)=>err.publicCode === 'GITHUB_RESPONSE_INVALID'
    );
}

(async()=>{
    testConfig();
    testIssueFormattingAndRedaction();
    await testCreateIssue();
    await testErrors();
    console.log('github-bug-report-regression: PASS');
})().catch((err)=>{ console.error(err); process.exit(1); });