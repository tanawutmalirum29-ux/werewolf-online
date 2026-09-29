const fs = require('fs');
const assert = require('assert');
const vm = require('vm');
const server = fs.readFileSync('server.js','utf8');
const start = server.indexOf('async function findExistingGithubIncidentIssue');
const end = server.indexOf('function diagnosticGithubPublicError', start);
assert.ok(start >= 0 && end > start, 'incident lookup helper must exist');

const calls=[];
const sandbox={
  diagnosticIncidentKeyHash:()=> 'abcdef0123456789abcdef0123456789abcdef01',
  listAllGithubIssues: async()=>{
    calls.push('list');
    return {issues:[
      {number:11,url:'https://github.com/o/r/issues/11',title:'[BUG] server · admin · incident:abcdef0123456789abcd',state:'CLOSED'},
      {number:12,url:'https://github.com/o/r/issues/12',title:'[BUG] replay · admin · incident:abcdef0123456789abcd',state:'OPEN'},
      {number:13,url:'https://github.com/o/r/issues/13',title:'[BUG] other · admin · incident:deadbeefdeadbeefdead',state:'OPEN'}
    ]};
  },
  searchGithubIssuesByText: async()=>{ calls.push('search'); return []; },
};
vm.runInNewContext(`${server.slice(start,end)}\nthis.api={findExistingGithubIncidentIssue};`,sandbox,{filename:'diagnostic-github-incident-lookup-behavior.js'});
(async()=>{
  const found=await sandbox.api.findExistingGithubIncidentIssue('operation:replay-1',{configured:true});
  assert.strictEqual(found.number,12,'lookup must reuse only an OPEN issue for the same incident marker');
  assert.strictEqual(calls.length,1,'current-hash lookup must not need the legacy body search');

  let legacyCalls=0;
  sandbox.listAllGithubIssues=async()=>{ legacyCalls += 1; return {issues:[]}; };
  sandbox.searchGithubIssuesByText=async({queryText})=>{
    calls.push('legacy-search');
    assert.strictEqual(queryText,'WEREWOLF-DIAGNOSTIC-ID: evt-old');
    return [
      {number:21,url:'https://github.com/o/r/issues/21',title:'old duplicate',state:'OPEN',body:'<!-- WEREWOLF-DIAGNOSTIC-ID: evt-old -->'},
      {number:22,url:'https://github.com/o/r/issues/22',title:'other',state:'CLOSED',body:'<!-- WEREWOLF-DIAGNOSTIC-ID: evt-old -->'},
      {number:20,url:'https://github.com/o/r/issues/20',title:'older duplicate',state:'OPEN',body:'<!-- WEREWOLF-DIAGNOSTIC-ID: evt-old -->'},
    ];
  };
  const legacy=await sandbox.api.findExistingGithubIncidentIssue('operation:replay-2',{configured:true},{event:{id:'evt-old'}});
  assert.strictEqual(legacy.number,20,'historical exact event marker lookup must deterministically choose the oldest OPEN duplicate');
  assert.strictEqual(legacyCalls,1);

  sandbox.listAllGithubIssues=async()=>({issues:[]});
  let eventOnlySearch='';
  sandbox.searchGithubIssuesByText=async({queryText})=>{ eventOnlySearch=queryText; return [{number:31,url:'https://github.com/o/r/issues/31',title:'event-only duplicate',state:'OPEN',body:'<!-- WEREWOLF-DIAGNOSTIC-ID: evt-no-incident -->'}]; };
  const eventOnly=await sandbox.api.findExistingGithubIncidentIssue('',{configured:true},{event:{id:'evt-no-incident'}});
  assert.strictEqual(eventOnly.number,31,'exact event marker lookup must still dedupe when no incident key exists');
  assert.strictEqual(eventOnlySearch,'WEREWOLF-DIAGNOSTIC-ID: evt-no-incident');

  sandbox.listAllGithubIssues=async()=>{ throw Object.assign(new Error('GITHUB_RATE_LIMITED'),{publicCode:'GITHUB_RATE_LIMITED'}); };
  await assert.rejects(
    sandbox.api.findExistingGithubIncidentIssue('operation:replay-3',{configured:true},{event:{id:'evt-any'}}),
    (err)=>err.publicCode === 'GITHUB_RATE_LIMITED'
  );
  console.log('diagnostic GitHub incident lookup behavior: PASS');
})().catch((err)=>{console.error(err);process.exit(1);});
