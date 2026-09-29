'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const adminBrowser = fs.readFileSync(path.join(ROOT, 'public/js/admin-browser.js'), 'utf8');

assert.ok(adminBrowser.includes('const CAPTURE_SCROLL_ATTRIBUTE = "data-ww-capture-scroll-id";'), 'capture must tag real scroll containers before cloning');
assert.ok(adminBrowser.includes('function snapshotCaptureScrollState(child)'), 'capture must snapshot nested scroll positions');
assert.ok(adminBrowser.includes('doc.scrollingElement'), 'capture must account for the document scrolling element');
assert.ok(adminBrowser.includes('node.scrollWidth'), 'capture must detect horizontally scrollable containers');
assert.ok(adminBrowser.includes('node.scrollHeight'), 'capture must detect vertically scrollable containers');
assert.ok(adminBrowser.includes('function restoreCaptureScrollStateIntoClone(clonedDocument, entries)'), 'capture must restore scroll state in the html2canvas clone');
assert.ok(adminBrowser.includes('clone.scrollLeft = entry.scrollLeft'), 'capture must restore horizontal scroll state');
assert.ok(adminBrowser.includes('clone.scrollTop = entry.scrollTop'), 'capture must restore vertical scroll state');
assert.ok(adminBrowser.includes('restoreCaptureScrollAttributes(scrollState);'), 'capture must clean temporary scroll markers from the real page');
assert.ok(adminBrowser.includes('finally {\n      restoreCaptureScrollAttributes(scrollState);'), 'cleanup must run even when html2canvas throws');
assert.ok(adminBrowser.includes('child?.scrollX ?? child?.pageXOffset'), 'capture must preserve real window horizontal scroll');
assert.ok(adminBrowser.includes('child?.scrollY ?? child?.pageYOffset'), 'capture must preserve real window vertical scroll');
assert.ok(adminBrowser.includes('html{scroll-behavior:auto!important;}'), 'capture clone must disable smooth scrolling during render');


assert.ok(adminBrowser.includes('function readLiveCaptureViewport(child, fallback = {})'), 'capture must read the actual child viewport at capture time');
assert.ok(adminBrowser.includes('width:liveViewport.width'), 'capture renderer must use the live viewport width');
assert.ok(adminBrowser.includes('height:liveViewport.height'), 'capture renderer must use the live viewport height');
assert.ok(adminBrowser.includes('windowWidth:liveViewport.width'), 'html2canvas clone viewport must match live width');
assert.ok(adminBrowser.includes('windowHeight:liveViewport.height'), 'html2canvas clone viewport must match live height');
assert.ok(!adminBrowser.includes('x:scrollX'), 'capture must not double-apply window scroll as an element crop offset');
assert.ok(!adminBrowser.includes('y:scrollY'), 'capture must not double-apply window scroll as an element crop offset');
assert.ok(!adminBrowser.includes('clonedDocument.documentElement.style.height = `${metadata.height}px`'), 'capture must not clamp clone root height to the viewport');
assert.ok(!adminBrowser.includes('clonedDocument.body.style.minHeight = `${metadata.height}px`'), 'capture must not clamp clone body height to the viewport');
assert.ok(!adminBrowser.includes('appendEvidenceBadge(clonedDocument, metadata)'), 'capture must not inject a synthetic overlay that was not visible on the live page');
assert.ok(adminBrowser.includes('captureEngine:"html2canvas-viewport"'), 'capture metadata must identify the viewport-preserving renderer');
assert.ok(adminBrowser.includes('X-WW-Screenshot-Scroll-Y'), 'GitHub upload must include the captured window scroll position');
assert.ok(adminBrowser.includes('X-WW-Screenshot-Active-Scroll-Containers'), 'GitHub upload must include nested scroll diagnostics');

console.log('admin-internal-browser-screenshot-scroll-state-regression: PASS');
