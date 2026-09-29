'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getGithubBugReportConfig, clearAllGithubScreenshotFiles, listAllGithubScreenshotFiles, GITHUB_API_VERSION } = require('../utils/github-bug-reports');
const ROOT = path.resolve(__dirname, '..');
const adminHtml = fs.readFileSync(path.join(ROOT,'public/admin.html'),'utf8');
const serverJs = fs.readFileSync(path.join(ROOT,'server.js'),'utf8');
const config = getGithubBugReportConfig({GITHUB_BUG_REPORT_TOKEN:'github_pat_screenshot_clear_test',GITHUB_BUG_REPORT_OWNER:'tanawutmalirum29-ux',GITHUB_BUG_REPORT_REPO:'werewolf-bug-reports',GITHUB_BUG_REPORT_BRANCH:'main'});
function contracts(){
  assert.ok(adminHtml.includes('id="adminBrowserCaptureClearGithubScreenshotsBtn"'));
  assert.ok(adminHtml.includes('clearGithubScreenshotsFromAdmin()'));
  assert.ok(adminHtml.includes('DELETE_ALL_GITHUB_SCREENSHOT_FILES'));
  assert.ok(adminHtml.includes('ไม่ลบ GitHub Issues หรือไฟล์อื่น'));
  assert.ok(serverJs.includes("/api/admin/diagnostics/github/screenshots/clear"));
  assert.ok(serverJs.includes('GITHUB_SCREENSHOT_CLEAR_IN_PROGRESS'));
  assert.ok(serverJs.includes('clearAllGithubScreenshotFiles'));
  assert.ok(serverJs.includes("kind:'github_screenshot_clear_partial_failure'"), 'partial screenshot clear must remain diagnosable');
  const clearBlock=serverJs.slice(serverJs.indexOf("app.post('/api/admin/diagnostics/github/screenshots/clear'"), serverJs.indexOf("app.get('/api/admin/diagnostics/github-status'"));
  assert.ok(!clearBlock.includes("kind:'github_screenshot_clear'"), 'successful screenshot clear must not be emitted as a diagnostic error');
}
async function behavior(){
  const calls=[];
  const mockFetch=async(url,options)=>{
    calls.push({url,options});
    assert.strictEqual(options.headers.Authorization,'Bearer github_pat_screenshot_clear_test');
    assert.strictEqual(options.headers['X-GitHub-Api-Version'],GITHUB_API_VERSION);
    if(options.method==='GET' && url.includes('/git/ref/heads/')) return {ok:true,status:200,async text(){return JSON.stringify({object:{sha:'TREE_SHA'}})}};
    if(options.method==='GET' && url.includes('/git/trees/')) return {ok:true,status:200,async text(){return JSON.stringify({truncated:false,tree:[
      {path:'screenshots/2026/09/26/index/390x844/a.png',type:'blob',sha:'sha-a'},
      {path:'screenshots/2026/09/26/index/390x844/a.json',type:'blob',sha:'sha-b'},
      {path:'screenshots/2026/09/26/index/390x844/notes.txt',type:'blob',sha:'sha-no'},
      {path:'README.md',type:'blob',sha:'sha-readme'}
    ]})}};
    assert.strictEqual(options.method,'DELETE');
    const body=JSON.parse(options.body);
    assert.ok(body.sha==='sha-a'||body.sha==='sha-b');
    assert.ok(body.branch==='main');
    assert.ok(url.includes('/contents/screenshots/'));
    return {ok:true,status:200,async text(){return JSON.stringify({commit:{html_url:'https://github.com/commit/test'}})}};
  };
  const listed=await listAllGithubScreenshotFiles({config,fetchImpl:mockFetch});
  assert.deepStrictEqual(listed.files.map(x=>x.path),['screenshots/2026/09/26/index/390x844/a.png','screenshots/2026/09/26/index/390x844/a.json']);
  const result=await clearAllGithubScreenshotFiles({config,fetchImpl:mockFetch});
  assert.strictEqual(result.found,2); assert.strictEqual(result.deleted,2); assert.strictEqual(result.remaining,0); assert.strictEqual(result.failed.length,0); assert.strictEqual(result.ok,true);
  assert.strictEqual(calls.filter(x=>x.options.method==='DELETE').length,2);
}
(async()=>{contracts();await behavior();console.log('github-screenshot-clear-regression: PASS');})().catch(err=>{console.error(err);process.exit(1)});
