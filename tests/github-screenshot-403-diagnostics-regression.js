
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  getGithubBugReportConfig,
  createGithubRepositoryFile,
  classifyGithubContentsWriteFailure,
} = require('../utils/github-bug-reports');

const ROOT = path.resolve(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const adminBrowser = fs.readFileSync(path.join(ROOT, 'public/js/admin-browser.js'), 'utf8');
const setup = fs.readFileSync(path.join(ROOT, 'GITHUB-BUG-REPORT-SETUP.md'), 'utf8');

const config = getGithubBugReportConfig({
  GITHUB_BUG_REPORT_TOKEN:'github_pat_screenshot_403_test',
  GITHUB_BUG_REPORT_OWNER:'tanawutmalirum29-ux',
  GITHUB_BUG_REPORT_REPO:'werewolf-bug-reports',
  GITHUB_BUG_REPORT_BRANCH:'main',
});

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { const key = Object.keys(headers).find(k => k.toLowerCase() === String(name).toLowerCase()); return key ? String(headers[key]) : ''; } },
    async text() { return JSON.stringify(body); },
  };
}

async function testPermission403() {
  await assert.rejects(
    createGithubRepositoryFile({
      path:'screenshots/2026/09/26/index/1366x768/test.png', content:Buffer.from('png'), config,
      fetchImpl:async()=>response(403,{message:'Resource not accessible by personal access token'},{'X-Accepted-GitHub-Permissions':'contents=write','X-RateLimit-Remaining':'4998'}),
    }),
    (err)=> err.publicCode === 'GITHUB_CONTENTS_PERMISSION_REQUIRED'
      && err.githubStatus === 403
      && err.githubAcceptedPermissions === 'contents=write'
      && err.githubRateLimitRemaining === '4998'
  );
}

async function testRateLimit403() {
  await assert.rejects(
    createGithubRepositoryFile({path:'x.png',content:Buffer.from('png'),config,fetchImpl:async()=>response(403,{message:'API rate limit exceeded'},{'X-RateLimit-Remaining':'0','X-RateLimit-Reset':'9999999999'})}),
    (err)=> err.publicCode === 'GITHUB_RATE_LIMITED' && err.githubStatus === 403 && err.githubRateLimitRemaining === '0'
  );
}

function testContracts() {
  const classified = classifyGithubContentsWriteFailure({response:response(403,{message:'Resource not accessible by personal access token'},{'X-Accepted-GitHub-Permissions':'contents=write'})});
  assert.strictEqual(classified.publicCode,'GITHUB_CONTENTS_PERMISSION_REQUIRED');
  assert.ok(serverJs.includes('GITHUB_CONTENTS_PERMISSION_REQUIRED'), 'server must expose a targeted Contents permission message');
  assert.ok(serverJs.includes('acceptedPermissions'), 'server diagnostic must retain accepted permission evidence');
  assert.ok(serverJs.includes('GITHUB_RATE_LIMITED'), 'server must distinguish rate limiting from permission failure');
  assert.ok(adminBrowser.includes('GITHUB_CREATE_SCREENSHOT_FAILED'), 'admin screenshot flow must keep generic fallback');
  assert.ok(setup.includes('Contents: Read and write'), 'setup must require Contents write for screenshot files');
}

(async()=>{
  await testPermission403();
  await testRateLimit403();
  testContracts();
  console.log('github-screenshot-403-diagnostics-regression: PASS');
})().catch(err=>{ console.error(err); process.exit(1); });
