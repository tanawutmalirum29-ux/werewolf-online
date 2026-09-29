'use strict';
const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/css/index.css', 'utf8');
const reporter = fs.readFileSync('public/js/error-reporter.js', 'utf8');

assert(html.includes('<div class="wwIndexBootIcon" aria-hidden="true"></div>'), 'Index boot gate must use a non-resource icon container');
assert(!/<div class=\"wwIndexBootIcon\"[^>]*>\s*<img\b/i.test(html), 'Index boot gate must not contain an img placeholder');
assert(!html.includes('src=""'), 'Index must not contain empty image sources');
const indexHtml = html;
assert(indexHtml.includes('#wwIndexServerBoot .wwIndexBootIcon{'), 'boot icon container styling must remain');
assert(css.includes('background-image'), 'boot icon must be painted without an img resource placeholder');
assert(indexHtml.includes("var icon=el.querySelector('.wwIndexBootIcon');"), 'boot gate must target the resource-free icon container');
assert(indexHtml.includes("icon.style.backgroundImage"), 'boot gate must paint the server icon without creating an img resource');
assert(indexHtml.includes('safeIconUrl'), 'boot gate must use the sanitized server icon URL');
assert(reporter.includes('function isIgnorableResourceError(target, resourceUrl)'), 'resource error reporter needs targeted noise guard');
assert(reporter.includes('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='), 'known placeholder must be guarded narrowly');
console.log('index-resource-error regression: PASS');
