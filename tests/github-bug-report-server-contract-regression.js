'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const admin = fs.readFileSync(path.join(__dirname,'..','public','admin.html'),'utf8');

assert.ok(server.includes("require(\"./utils/github-bug-reports\")"), 'server must import GitHub reporter');
const middlewarePos = server.indexOf('app.use("/api/admin",');
const routePos = server.indexOf("app.post('/api/admin/diagnostics/github'");
assert.ok(middlewarePos >= 0 && routePos > middlewarePos, 'GitHub route must remain behind /api/admin auth middleware');
assert.ok(server.includes("const primary = diagnosticEvents.find((event) => String(event?.id || '') === eventId);"), 'server route must resolve the event server-side');
assert.ok(server.includes('const safePrimary = publicDiagnosticEvent(rootEvent);'), 'server must sanitize the selected root event before formatting');
assert.ok(server.includes('buildGithubBugReportIssue({'), 'server must format the Issue from server-side diagnostics');
assert.ok(server.includes('createGithubBugReportIssue({ issue, config });'), 'server must use the GitHub transport helper');
assert.ok(!server.includes('res.json({ ok:true, token:config.token'), 'server must never return the GitHub token');
assert.ok(!admin.includes('Authorization: `Bearer ${'), 'browser bundle must not construct GitHub Authorization headers');
assert.ok(!admin.match(/github_pat_[A-Za-z0-9_]+/), 'browser bundle must not contain a GitHub token value');
assert.ok(admin.includes("body:JSON.stringify({eventId:e.id})"), 'browser must send only the diagnostic event id');
assert.ok(admin.includes("/api/admin/diagnostics/github"), 'admin UI must call the GitHub submit endpoint');
assert.ok(admin.includes('diag-github-open'), 'admin UI must expose the created Issue link');


const host = fs.readFileSync(path.join(__dirname,'..','public','host.html'),'utf8');
const player = fs.readFileSync(path.join(__dirname,'..','public','player.html'),'utf8');
assert.ok(server.includes("/api/admin/internal-browser/screenshots/github"), 'server must expose an Admin-only screenshot GitHub endpoint');
assert.ok(server.includes("express.raw({ type: 'image/png'"), 'screenshot endpoint must receive PNG as binary');
assert.ok(server.includes("x-ww-screenshot-width"), 'server must capture viewport width metadata');
assert.ok(server.includes("x-ww-screenshot-dpr"), 'server must capture screenshot DPR metadata');
assert.ok(server.includes('createGithubScreenshotFiles'), 'server must save screenshot image and metadata through GitHub repository files');
assert.ok(!player.includes('/api/admin/internal-browser/screenshots/github'), 'player page must not reference screenshot GitHub endpoint');
assert.ok(!host.includes('/api/admin/internal-browser/screenshots/github'), 'host page must not reference screenshot GitHub endpoint');

console.log('github-bug-report-server-contract-regression: PASS');
