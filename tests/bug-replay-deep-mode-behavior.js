'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { runBugReplayScenario } = require('../utils/bug-replay-runner');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'tests');
const passFile = path.join(dir, '.bug-replay-pass-fixture.js');
const failFile = path.join(dir, '.bug-replay-fail-fixture.js');

function writeFixtures() {
    fs.writeFileSync(passFile, "console.log('fixture-pass');\n", 'utf8');
    fs.writeFileSync(failFile, "console.error('fixture-fail'); process.exit(7);\n", 'utf8');
}
function cleanup() {
    for (const p of [passFile, failFile]) {
        try { fs.unlinkSync(p); } catch (_) {}
    }
}

(async () => {
    writeFixtures();
    try {
        const scenario = { id:'deep-behavior-fixture', tests:[
            'tests/.bug-replay-fail-fixture.js',
            'tests/.bug-replay-pass-fixture.js',
            'tests/.bug-replay-fail-fixture.js',
        ] };

        const deep = await runBugReplayScenario(scenario, { timeoutMs:5000, continueOnFailure:true });
        assert.strictEqual(deep.ok, false, 'deep replay must report a failed scenario');
        assert.strictEqual(deep.stopped, false, 'deep replay must continue after failure');
        assert.strictEqual(deep.steps.length, 3, 'deep replay must execute every step after failures');
        assert.strictEqual(deep.failures.length, 2, 'deep replay must collect every failure in a scenario');
        assert.strictEqual(deep.steps[1].ok, true, 'deep replay must continue to later passing step');

        const failFast = await runBugReplayScenario(scenario, { timeoutMs:5000, continueOnFailure:false });
        assert.strictEqual(failFast.ok, false, 'fail-fast replay must report failure');
        assert.strictEqual(failFast.stopped, false, 'fail-fast failure is not admin cancellation');
        assert.strictEqual(failFast.steps.length, 1, 'fail-fast replay must stop at first failure');
        assert.strictEqual(failFast.failures.length, 1, 'fail-fast replay must keep only first failure');

        console.log('bug-replay deep mode behavior: PASS (continue-on-failure + fail-fast verified)');
    } finally {
        cleanup();
    }
})().catch((err) => {
    cleanup();
    console.error(err.stack || err);
    process.exit(1);
});
