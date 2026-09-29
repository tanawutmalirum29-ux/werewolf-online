'use strict';

const fs = require('fs');
const assert = require('assert');
const vm = require('vm');

const server = fs.readFileSync('server.js', 'utf8');
const start = server.indexOf('async function submitDiagnosticEventToGithub');
const end = server.indexOf("\napp.post('/api/admin/diagnostics/github'", start);
assert.ok(start >= 0 && end > start, 'GitHub submission helper must exist');

const created = [];
const breadcrumbs = [];
const sandbox = {
  cleanupDiagnosticGithubReports(){},
  diagnosticGithubReports:new Map(),
  diagnosticGithubIncidentReports:new Map(),
  diagnosticGithubIncidentInFlight:new Map(),
  diagnosticGithubIncidentIdentity:(event)=>`bug-replay:${String(event?.data?.testPath || '')}:${String(event?.data?.stderr || '')}`,
  diagnosticIncidentKeyHash:(key)=>String(key).replace(/[^a-z0-9]+/gi,'').padEnd(40,'0').slice(0,40),
  diagnosticTimeMs:(e)=>Date.parse(e?.time || '2026-09-27T00:00:00Z') || 0,
  diagnosticIsFailureEvent:(e)=>String(e?.kind||'').toLowerCase()==='bug_replay_failure',
  relatedDiagnosticEventsFor:(primary)=>sandbox.__events,
  relatedServerBreadcrumbs:()=>[],
  buildDiagnosticAnalysis:()=>({causeCode:'BUG_REPLAY_FAILED',failureStage:'bug_replay.scenario',rootCauseSource:'server',confidence:'high',rootCause:'test failed',nextStep:'inspect'}),
  publicDiagnosticEvent:(e)=>e,
  publicDiagnosticValue:(e)=>e,
  buildGithubBugReportIssue:({event,relatedEvents,incident})=>({title:event.id,body:JSON.stringify({root:event.id,related:relatedEvents.map(x=>x.id),incident})}),
  createGithubBugReportIssue:async({issue})=>{
    const number=created.length+100;
    const result={number,issueUrl:`https://github.com/o/r/issues/${number}`,title:issue.title,repository:'o/r'};
    created.push({issue,result});
    return result;
  },
  findExistingGithubIncidentIssue:async()=>null,
  addDiagnosticBreadcrumb:(x)=>breadcrumbs.push(x),
  getCachedAppVersion:()=> 'v-test',
  process:{version:'v-test',uptime:()=>10},
  serverClosed:false,
};

const events = [
  {id:'evt-a',time:'2026-09-27T10:00:00Z',kind:'bug_replay_failure',source:'server',page:'admin',operationId:'replay-1',data:{testPath:'tests/a.js',exitCode:1,stderr:'AssertionError: A'},context:{testPath:'tests/a.js'}},
  {id:'evt-b',time:'2026-09-27T10:00:01Z',kind:'bug_replay_failure',source:'server',page:'admin',operationId:'replay-1',data:{testPath:'tests/b.js',exitCode:1,stderr:'AssertionError: B'},context:{testPath:'tests/b.js'}},
];
sandbox.__events=events;
vm.runInNewContext(`${server.slice(start,end)}\nthis.api={submitDiagnosticEventToGithub};`, sandbox, {filename:'diagnostic-github-bug-replay-submit-behavior.js'});

(async()=>{
  const config={configured:true,repository:'o/r'};
  const [a,b]=await Promise.all([
    sandbox.api.submitDiagnosticEventToGithub(events[0],config),
    sandbox.api.submitDiagnosticEventToGithub(events[1],config),
  ]);
  assert.strictEqual(created.length,2,'different Bug Replay failures in one replay run must create two distinct Issues');
  assert.notStrictEqual(a.number,b.number,'different Bug Replay failure keys must not share one Issue');
  assert.strictEqual(JSON.parse(created[0].issue.body).root,'evt-a','first Issue must use its own Bug Replay failure as root');
  assert.deepStrictEqual(JSON.parse(created[0].issue.body).related,[],'root event should not be duplicated in Related events');
  assert.strictEqual(JSON.parse(created[1].issue.body).root,'evt-b','second Issue must use its own Bug Replay failure as root');
  assert.deepStrictEqual(JSON.parse(created[1].issue.body).related,[],'root event should not be duplicated in Related events');
  assert.strictEqual(a.reused,false);
  assert.strictEqual(b.reused,false);

  const duplicate = {...events[0], id:'evt-a-again', operationId:'replay-2'};
  const dupResult=await sandbox.api.submitDiagnosticEventToGithub(duplicate,config);
  assert.strictEqual(created.length,2,'same stable Bug Replay failure must reuse its Issue instead of creating a third one');
  assert.strictEqual(dupResult.reused,true);
  assert.strictEqual(dupResult.number,a.number);
  console.log('diagnostic GitHub Bug Replay submission behavior: PASS');
})().catch((err)=>{console.error(err);process.exit(1);});
