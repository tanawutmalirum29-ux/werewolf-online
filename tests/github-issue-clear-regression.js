'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  getGithubBugReportConfig,
  listAllGithubIssues,
  deleteGithubIssueById,
  clearAllGithubIssues,
  GITHUB_API_VERSION,
} = require('../utils/github-bug-reports');

const ROOT = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function config() {
  return getGithubBugReportConfig({
    GITHUB_BUG_REPORT_TOKEN: 'github_pat_issue_clear_test',
    GITHUB_BUG_REPORT_OWNER: 'tanawutmalirum29-ux',
    GITHUB_BUG_REPORT_REPO: 'werewolf-online',
    GITHUB_BUG_REPORT_BRANCH: 'main',
  });
}

function testAdminUiContract() {
  assert.ok(adminHtml.includes('id="diagGithubClearIssuesBtn"'), 'Diagnostics must expose GitHub Issues clear button');
  assert.ok(adminHtml.includes("clearGithubIssuesFromAdmin()"), 'Diagnostics clear button must have a dedicated handler');
  assert.ok(adminHtml.includes("DELETE_ALL_GITHUB_ISSUES"), 'Admin must send an explicit clear confirmation marker');
  assert.ok(adminHtml.includes('ไม่ลบไฟล์ Screenshot'), 'Confirmation must state screenshot files are not deleted');
  assert.ok(serverJs.includes("/api/admin/diagnostics/github/issues/clear"), 'Server must expose the protected GitHub Issues clear endpoint');
  assert.ok(serverJs.includes('GITHUB_ISSUE_CLEAR_IN_PROGRESS'), 'Server must guard against overlapping destructive clear requests');
}

async function testListAndDeleteGraphql() {
  const calls = [];
  let listed = false;
  const mockFetch = async (url, options) => {
    calls.push({url, options});
    assert.strictEqual(options.method, 'POST');
    assert.strictEqual(options.headers.Authorization, 'Bearer github_pat_issue_clear_test');
    assert.strictEqual(options.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION);
    const payload = JSON.parse(options.body);
    if (payload.query.includes('repository(owner:$owner')) {
      listed = true;
      assert.deepStrictEqual(payload.variables, {owner:'tanawutmalirum29-ux',name:'werewolf-online',cursor:null});
      return {
        ok:true,status:200,
        async text(){ return JSON.stringify({data:{repository:{issues:{nodes:[
          {id:'I_kwDO1',number:1,title:'first',url:'https://github.com/tanawutmalirum29-ux/werewolf-online/issues/1'},
          {id:'I_kwDO2',number:2,title:'second',url:'https://github.com/tanawutmalirum29-ux/werewolf-online/issues/2'}
        ],pageInfo:{hasNextPage:false,endCursor:null},totalCount:2}}}}); },
      };
    }
    assert.ok(payload.query.includes('deleteIssue(input:{issueId:$issueId})'));
    assert.ok(payload.variables.issueId.startsWith('I_kwDO'));
    return {ok:true,status:200,async text(){return JSON.stringify({data:{deleteIssue:{repository:{url:'https://github.com/tanawutmalirum29-ux/werewolf-online'}}}});}};
  };

  const result = await clearAllGithubIssues({config:config(),fetchImpl:mockFetch});
  assert.strictEqual(listed,true);
  assert.deepStrictEqual(result.deletedIssueNumbers,[1,2]);
  assert.strictEqual(result.found,2);
  assert.strictEqual(result.deleted,2);
  assert.strictEqual(result.failed.length,0);
  assert.strictEqual(result.ok,true);
  assert.strictEqual(calls.length,3,'one list request + one delete mutation per issue');
}

async function testPagination() {
  let page = 0;
  const mockFetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (!payload.query.includes('repository(owner:$owner')) throw new Error('unexpected mutation');
    page += 1;
    const first = page === 1;
    return {
      ok:true,status:200,
      async text(){ return JSON.stringify({data:{repository:{issues:{
        nodes:first ? [{id:'I_1',number:1,title:'one',url:'u1'}] : [{id:'I_2',number:2,title:'two',url:'u2'}],
        pageInfo:{hasNextPage:first,endCursor:first?'CURSOR_2':null},
        totalCount:2,
      }}}}); },
    };
  };
  const result = await listAllGithubIssues({config:config(),fetchImpl:mockFetch});
  assert.deepStrictEqual(result.issues.map((x)=>x.number),[1,2]);
  assert.strictEqual(page,2);
}

async function testPartialFailureIsReported() {
  let mutation = 0;
  const mockFetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.query.includes('repository(owner:$owner')) {
      return {ok:true,status:200,async text(){return JSON.stringify({data:{repository:{issues:{nodes:[
        {id:'I_1',number:1,title:'one',url:'u1'},
        {id:'I_2',number:2,title:'two',url:'u2'}
      ],pageInfo:{hasNextPage:false,endCursor:null},totalCount:2}}}});}};
    }
    mutation += 1;
    if (mutation === 2) {
      return {ok:true,status:200,async text(){return JSON.stringify({errors:[{message:'Resource not accessible by personal access token'}]});}};
    }
    return {ok:true,status:200,async text(){return JSON.stringify({data:{deleteIssue:{repository:{url:'u'}}}});}};
  };
  const result = await clearAllGithubIssues({config:config(),fetchImpl:mockFetch});
  assert.strictEqual(result.ok,false);
  assert.strictEqual(result.deleted,1);
  assert.strictEqual(result.failed.length,1);
  assert.strictEqual(result.failed[0].number,2);
  assert.strictEqual(result.failed[0].code,'GITHUB_FORBIDDEN_OR_RATE_LIMITED');
}

async function testDirectDeleteValidation() {
  await assert.rejects(
    deleteGithubIssueById({issueId:'',config:config(),fetchImpl:async()=>{throw new Error('must not fetch');}}),
    (err)=>err.publicCode==='GITHUB_ISSUE_ID_REQUIRED'
  );
}

(async()=>{
  testAdminUiContract();
  await testListAndDeleteGraphql();
  await testPagination();
  await testPartialFailureIsReported();
  await testDirectDeleteValidation();
  console.log('github-issue-clear-regression: PASS');
})().catch((err)=>{ console.error(err); process.exit(1); });
