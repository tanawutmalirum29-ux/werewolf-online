'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const server = read('server.js');
const account = read('public/js/account.identity.js');
const player = read('public/js/player.main.js');
const host = read('public/js/host.main.js');
const index = read('public/js/index.main.js');
const admin = read('public/admin.html');
const pkg = JSON.parse(read('package.json'));

const must = (name, condition) => {
  assert.ok(condition, `FAIL: ${name}`);
  console.log(`PASS: ${name}`);
};

must('Account has one active session hash', server.includes('ACCOUNT_ACTIVE_SESSION_HASH_FIELD') && server.includes('activeSessionHash'));
must('Account session binds to one device', server.includes('ACCOUNT_ACTIVE_DEVICE_ID_FIELD') && server.includes('ACCOUNT_DEVICE_CONFLICT'));
must('New login revokes older sessions', server.includes('issueGoogleAccountSession') && server.includes('disconnectAccountSockets') && server.includes('new_login'));
must('Cross-instance session watchdog exists', server.includes('validateConnectedAccountSessionsCrossInstance') && server.includes('ensureAccountSessionWatchdog'));
must('Same-device replacement is recoverable in client', account.includes('waitForSessionReplacement') && account.includes('sameDeviceReplacement'));
must('Different-device replacement clears client identity', account.includes('if (!sameDeviceReplacement) clearAccount()'));
must('Account activity prevents a second different activity', server.includes('acquireAccountActivity') && server.includes('ACCOUNT_ACTIVITY_CONFLICT') && server.includes('sameAccountActivity'));
must('Activity release is owned by room + membership + active session/device when not forced', server.includes('if (!force && safeMembership)') && server.includes('if (!force && safeSession)') && server.includes('if (!force && safeDevice)') && server.includes('const guardCondition = !force && conditions.length ? conditions.join(\" AND \") : undefined;') && server.includes('sessionHash: pendingMeta.sessionHash || \"\"'));
must('Same activity is explicitly shareable across tabs', server.includes('Multiple tabs/frames on the SAME authenticated device are views of one activity'));
must('Room membership has durable identity', server.includes('generateMembershipId') && server.includes('membershipId'));
must('Room player lookup uses account + membership before socket id', server.includes('function getRoomPlayerForSocket') && server.includes('socket.data?.membershipId') && server.includes('socket.data?.accountId'));
must('Normal join no longer sends room token as identity', player.includes('...(TESTER_MODE ? { token: clientToken } : (window.wwAccount ? window.wwAccount.payload() : {}))'));
must('Normal rejoin no longer sends room token as identity', player.includes('function wwRejoinRoom') && player.includes('...(TESTER_MODE ? { token: clientToken } : (window.wwAccount ? window.wwAccount.payload() : {}))'));
must('Server join ACK returns membership id', server.includes('cb({ ok: true, stateVersion: room.stateVersion, membershipId: String(player.membershipId || "") })'));
must('Player UI resolves self by membership id', player.includes('function getCurrentRoomPlayer') && player.includes('currentMembershipId') && player.includes('p?.membershipId'));
must('Player game runtime does not require socket id as identity', player.includes('return getCurrentRoomPlayer(room);'));
must('Pagehide carries durable account/membership context', player.includes('membershipId:String(currentMembershipId || "")') && server.includes('requestMembershipId'));
must('Browser exit ignores duplicate secondary same-account tab', server.includes('BROWSER_EXIT_SECONDARY_TAB_IGNORED') && server.includes('SECONDARY_TAB_RETAINED'));
must('Room owner is account-bound', server.includes('ownerAccountId') && server.includes('hostMembershipId'));
must('Host socket is marked separately from account identity', server.includes('socket.data.isHost = true'));
must('Index routes to server-resolved active activity', index.includes('/api/account/context') && index.includes('routeIndexToActiveActivity'));
must('Index reboots after a same-device token rotation', index.includes('wwAccountChanged') && index.includes('await bootstrapIndexAccount()'));
must('Admin aggregates one row per account', server.includes('const accountIds = new Set(accountPresence.keys())') && server.includes('connectionCount: sessions.length'));
must('Admin exposes connection count for duplicate-tab diagnosis', admin.includes('การเชื่อมต่อ') && admin.includes('connectionCount'));
must('Host lifecycle still has account-based session payload', host.includes('window.wwAccount.payload()'));
must('Tester remains explicitly separated', player.includes('TESTER_MODE') && server.includes('testerGranted') && server.includes('isTesterRoom'));
must('Single-session regression suite is part of npm test', pkg.scripts.test.includes('tests/account-session-room-membership-regression.js'));

console.log('account-session-room-membership regression: PASS');
