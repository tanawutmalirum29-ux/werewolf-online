
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  getGithubBugReportConfig,
  screenshotGithubPath,
  buildGithubScreenshotMetadata,
  createGithubRepositoryFile,
  createGithubScreenshotFiles,
  GITHUB_API_VERSION,
  MAX_SCREENSHOT_BYTES,
} = require('../utils/github-bug-reports');

const ROOT = path.resolve(__dirname, '..');
const adminBrowser = fs.readFileSync(path.join(ROOT, 'public/js/admin-browser.js'), 'utf8');
const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
const playerHtml = fs.readFileSync(path.join(ROOT, 'public/player.html'), 'utf8');
const hostHtml = fs.readFileSync(path.join(ROOT, 'public/host.html'), 'utf8');

function config() {
  return getGithubBugReportConfig({
    GITHUB_BUG_REPORT_TOKEN: 'github_pat_screenshot_test',
    GITHUB_BUG_REPORT_OWNER: 'tanawutmalirum29-ux',
    GITHUB_BUG_REPORT_REPO: 'werewolf-bug-reports',
    GITHUB_BUG_REPORT_BRANCH: 'main',
  });
}

function testAdminOnlyUiContract() {
  assert.ok(adminBrowser.includes('/api/admin/internal-browser/screenshots/github'), 'Admin Internal Browser must call the screenshot GitHub endpoint');
  assert.ok(adminBrowser.includes('adminBrowserCaptureGithubBtn'), 'Admin capture result must expose GitHub save button binding');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Width'), 'capture request must send viewport width metadata');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Height'), 'capture request must send viewport height metadata');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Dpr'), 'capture request must send DPR metadata');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Captured-At'), 'capture request must send capture time metadata');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Path'), 'capture request must send page path metadata');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Capture-Engine'), 'capture request must identify its rendering engine');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Scroll-X'), 'capture request must send horizontal scroll metadata');
  assert.ok(adminBrowser.includes('X-WW-Screenshot-Scroll-Y'), 'capture request must send vertical scroll metadata');
  assert.ok(adminHtml.includes('id="adminBrowserCaptureGithubBtn"'), 'Admin HTML must contain screenshot GitHub button');
  assert.ok(!playerHtml.includes('adminBrowserCaptureGithubBtn'), 'Player page must not gain screenshot GitHub button');
  assert.ok(!hostHtml.includes('adminBrowserCaptureGithubBtn'), 'Host page must not gain screenshot GitHub button');
  for (const size of ['390,844','768,1024','1180,682','1440,900','1920,1080']) {
    assert.ok(adminBrowser.includes(`width:${size.split(',')[0]}, height:${size.split(',')[1]}`), `viewport preset ${size} must remain available`);
  }
}

function testPathAndMetadata() {
  const imagePath = screenshotGithubPath({
    capturedAt: '2026-09-26T10:20:30.123Z',
    page: 'Tester Player',
    width: 390,
    height: 844,
    fileName: 'werewolf-Tester-Player-390x844-abc.png',
  });
  assert.strictEqual(imagePath, 'screenshots/2026/09/26/Tester-Player/390x844/werewolf-Tester-Player-390x844-abc.png');
  const metadata = JSON.parse(buildGithubScreenshotMetadata({
    page:'Tester Player', path:'/player.html?tp=secret', width:390, height:844, mode:'preset',
    presetId:'mobile', presetLabel:'มือถือมาตรฐาน', orientation:'Portrait', zoom:'100%',
    dpr:2, captureMode:'evidence', capturedAt:'2026-09-26T10:20:30.123Z', browser:'Chrome iOS',
    userAgent:'Bearer should-never-be-in-this-field', captureEngine:'html2canvas-viewport',
    scrollX:240, scrollY:480, activeScrollContainers:3, visualViewportScale:1,
  }));
  assert.strictEqual(metadata.kind, 'admin-internal-browser-screenshot');
  assert.deepStrictEqual(metadata.viewport, {width:390,height:844,mode:'preset',presetId:'mobile',presetLabel:'มือถือมาตรฐาน',orientation:'Portrait',zoom:'100%'});
  assert.strictEqual(metadata.dpr, 2);
  assert.strictEqual(metadata.captureMode, 'evidence');
  assert.strictEqual(metadata.captureEngine, 'html2canvas-viewport');
  assert.deepStrictEqual(metadata.scroll, {x:240,y:480,activeContainers:3,visualViewportScale:1});
  assert.ok(metadata.path.includes('/player.html'));
  assert.ok(!metadata.userAgent.includes('Bearer should-never-be-in-this-field'));
}

async function testRepositoryFileUpload() {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({url, options});
    const payload = JSON.parse(options.body);
    assert.strictEqual(options.method, 'PUT');
    assert.strictEqual(options.headers.Authorization, 'Bearer github_pat_screenshot_test');
    assert.strictEqual(options.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION);
    assert.strictEqual(payload.branch, 'main');
    assert.ok(payload.content);
    return {
      ok:true,
      status:201,
      async text() { return JSON.stringify({content:{path:'x.png',sha:'abc123',html_url:'https://github.com/tanawutmalirum29-ux/werewolf-bug-reports/blob/main/x.png',download_url:'https://raw.githubusercontent.com/tanawutmalirum29-ux/werewolf-bug-reports/main/x.png'}}); },
    };
  };
  const result = await createGithubRepositoryFile({
    path:'screenshots/2026/09/26/player/390x844/a.png',
    content:Buffer.from('fake-png'),
    message:'Admin screenshot',
    config:config(),
    fetchImpl:mockFetch,
    contentType:'image/png',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.includes('/contents/screenshots/2026/09/26/player/390x844/a.png'));
}

async function testScreenshotPairUpload() {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({url, options});
    return {
      ok:true,
      status:201,
      async text() {
        const parsed = JSON.parse(options.body);
        const isMeta = String(parsed.message).includes('metadata');
        const file = isMeta ? 'a.json' : 'a.png';
        return JSON.stringify({content:{path:file,sha:isMeta?'jsonsha':'pngsha',html_url:`https://github.com/tanawutmalirum29-ux/werewolf-bug-reports/blob/main/${file}`,download_url:`https://raw.githubusercontent.com/tanawutmalirum29-ux/werewolf-bug-reports/main/${file}`}});
      },
    };
  };
  const result = await createGithubScreenshotFiles({
    imageBuffer:Buffer.from('png-bytes'),
    imagePath:'screenshots/2026/09/26/player/390x844/a.png',
    metadataPath:'screenshots/2026/09/26/player/390x844/a.json',
    metadata:{page:'Tester Player',path:'/player.html',width:390,height:844,mode:'preset',presetId:'mobile',presetLabel:'มือถือมาตรฐาน',orientation:'Portrait',zoom:'100%',dpr:2,captureMode:'evidence',capturedAt:'2026-09-26T10:20:30.123Z'},
    config:config(),
    fetchImpl:mockFetch,
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls.length, 2, 'metadata and image must be committed serially');
}

async function testLimits() {
  const c = config();
  await assert.rejects(
    createGithubRepositoryFile({path:'a.png',content:Buffer.alloc(MAX_SCREENSHOT_BYTES + 1),config:c,fetchImpl:async()=>{ throw new Error('must not fetch'); }}),
    (err) => err.publicCode === 'GITHUB_SCREENSHOT_TOO_LARGE'
  );
}

(async()=>{
  testAdminOnlyUiContract();
  testPathAndMetadata();
  await testRepositoryFileUpload();
  await testScreenshotPairUpload();
  await testLimits();
  console.log('admin-internal-browser-screenshot-github-regression: PASS');
})().catch((err)=>{ console.error(err); process.exit(1); });
