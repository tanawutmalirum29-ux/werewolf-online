const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = serverSource.indexOf('async function syncServerStateFromAuthority');
const end = serverSource.indexOf('async function loadServerState', start);
assert(start >= 0 && end > start, 'Could not extract the persisted-state reconciliation function from server.js');
const fnSource = serverSource.slice(start, end).trim();

async function runCase({ persisted, initial, adminTouched = false }) {
    const calls = [];
    const context = {
        Date,
        console: { error() {}, log() {} },
        serverClosed: !!initial.serverClosed,
        closedMessage: initial.closedMessage || '',
        closedReopenAt: Number(initial.closedReopenAt || 0),
        reloadEpoch: initial.reloadEpoch || '',
        reloadKind: initial.reloadKind || '',
        testerReloadEpoch: initial.testerReloadEpoch || '',
        imageEpoch: initial.imageEpoch || '',
        roomResetAt: Number(initial.roomResetAt || 0),
        serverOpenTouchedByAdmin: !!adminTouched,
        reloadEpochTouchedByAdmin: false,
        imageEpochTouchedByAdmin: false,
        closingPlan: null,
        readAuthoritativeServerState: async () => persisted,
        closeServerNow: () => {
            calls.push('closeServerNow');
            context.serverClosed = true;
            return 1;
        },
        closeAllRoomsSilently: async ({ fast } = {}) => {
            calls.push(fast ? 'closeAllRoomsSilently:fast' : 'closeAllRoomsSilently:normal');
            return 1;
        },
        clearClosingPlan: () => {
            calls.push('clearClosingPlan');
            context.closingPlan = null;
        },
        armClosingPlan: (at, message, reopenAt) => {
            calls.push('armClosingPlan');
            context.closingPlan = { closeAt: at, message, reopenAt };
        },
        performServerClose: async () => {
            calls.push('performServerClose');
            context.serverClosed = true;
        },
    };

    vm.createContext(context);
    vm.runInContext(`${fnSource}\nthis.__sync=syncServerStateFromAuthority;`, context, { timeout: 1000 });
    await context.__sync();
    return { context, calls };
}

(async () => {
    // Core bug: this process still thinks the server is closed, while the shared DB state
    // already says Admin reopened it. The stale instance must become open before / is served.
    let result = await runCase({
        persisted: { closed: false, reloadEpoch: 'open-2', reloadKind: 'session', imageEpoch: 'img-2', roomResetAt: 200 },
        initial: { serverClosed: true, closedMessage: 'เก่า', closedReopenAt: 123 },
    });
    assert.strictEqual(result.context.serverClosed, false, 'persisted open state must release a stale locally-closed instance');
    assert(result.calls.includes('closeAllRoomsSilently:fast'), 'stale instance must clean old rooms before accepting public traffic again');
    assert.strictEqual(result.context.closedMessage, '', 'reopened state must clear the stale closed message');
    assert.strictEqual(result.context.reloadEpoch, 'open-2', 'reconciled instance must adopt the persisted reload epoch');
    assert.strictEqual(result.context.imageEpoch, 'img-2', 'reconciled instance must adopt the persisted image epoch');

    // Reverse direction: another instance closed the server and this process still thinks open.
    result = await runCase({
        persisted: { closed: true, message: 'ปิดปรับปรุง', reopenAt: 999 },
        initial: { serverClosed: false },
    });
    assert.strictEqual(result.context.serverClosed, true, 'persisted closed state must close a stale locally-open instance');
    assert(result.calls.includes('closeServerNow'), 'cross-instance close must use the normal server-close signal path');
    assert(result.calls.includes('closeAllRoomsSilently:fast'), 'cross-instance close must clean normal rooms');

    // A local Admin mutation must win until its own persistence write completes.
    result = await runCase({
        persisted: { closed: false },
        initial: { serverClosed: true, closedMessage: 'local admin command' },
        adminTouched: true,
    });
    assert.strictEqual(result.context.serverClosed, true, 'local Admin mutation must not be overwritten by a stale authority read');

    // Persisted future close schedule must be restored on an instance that missed the admin action.
    result = await runCase({
        persisted: { closed: false, planCloseAt: Date.now() + 60_000, planMessage: 'เตือน', planReopenAt: Date.now() + 120_000 },
        initial: { serverClosed: false },
    });
    assert(result.calls.includes('armClosingPlan'), 'persisted future close plan must be restored on a stale instance');

    console.log('index-server-state-authority-behavior: PASS');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
