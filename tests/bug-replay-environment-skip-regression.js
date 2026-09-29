'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runChildTest } = require('../utils/bug-replay-runner');

const root = path.resolve(__dirname, '..');
const tempPath = path.join(root, 'tests', '.tmp-missing-playwright-regression.py');
fs.writeFileSync(tempPath, [
    'import sys',
    "sys.stderr.write(\"ModuleNotFoundError: No module named 'playwright'\\n\")",
    'sys.exit(1)',
    '',
].join('\n'), 'utf8');

(async () => {
    try {
        const result = await runChildTest('tests/.tmp-missing-playwright-regression.py', { timeoutMs: 5000 });
        assert.strictEqual(result.skipped, true, 'missing Python Playwright must be treated as an environment skip');
        assert.strictEqual(result.skipReason, 'PYTHON_PLAYWRIGHT_UNAVAILABLE');
        assert.strictEqual(result.ok, false, 'environment skip must not count as a passed test');
        assert.strictEqual(result.timedOut, false);
        console.log('bug-replay environment skip regression: PASS');
    } finally {
        try { fs.unlinkSync(tempPath); } catch (_) {}
    }
})().catch((err) => { console.error(err); process.exit(1); });
