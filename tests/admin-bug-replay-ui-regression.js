const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const admin = fs.readFileSync(path.join(root, "public", "admin.html"), "utf8");

// Simulation runner must be collapsible without touching the existing start/stop lifecycle.
assert.match(admin, /id="bugReplayToggleBtn"/, "collapse toggle missing");
assert.match(admin, /aria-controls="bugReplayBody"/, "collapse toggle must target replay body");
assert.match(admin, /function setBugReplayCollapsed\(/, "collapse state helper missing");
assert.match(admin, /function toggleBugReplay\(/, "collapse toggle handler missing");
assert.match(admin, /localStorage\.setItem\(BUG_REPLAY_COLLAPSED_KEY/, "collapse state should persist");
assert.match(admin, /const BUG_REPLAY_COLLAPSED_KEY = "ww_admin_bug_replay_collapsed_v1"/, "collapse storage key missing");
assert.match(admin, /is-collapsed \.bug-replay-body|\.bug-replay-card\.is-collapsed \.bug-replay-body/, "collapsed state must hide replay details");
assert.match(admin, /updateBugReplayCompactStatus\(job\)/, "collapsed runner needs compact status updates");
assert.match(admin, /setInterval\(\(\)=>pollBugReplayStatus\(\),700\)/, "existing running poll must remain intact");

assert.match(admin, /id="bugReplayFirstBtn"/, "first-bug runner button missing");
assert.match(admin, /startBugReplay\('first'\)/, "first-bug button must start fail-fast mode");
assert.match(admin, /id="bugReplayStartBtn"/, "complete runner button missing");
assert.match(admin, /startBugReplay\('all'\)/, "complete button must start full mode");
assert.doesNotMatch(admin, /id="bugReplayDeepBtn"/, "deep runner button must be removed from the two-button UI");
assert.doesNotMatch(admin, /id="bugReplayPhase2Btn"/, "phase2 runner button must be removed from the two-button UI");
assert.match(admin, /คัดลอกรายงาน/, "first-bug copy report action missing");
assert.match(admin, /id="bugReplayTerminalReport"/, "terminal report panel missing");
assert.match(admin, /id="bugReplayTerminalCopyBtn"/, "terminal report copy button missing");
assert.match(admin, /id="bugReplayTerminalJsonBtn"/, "terminal report JSON download button missing");
assert.match(admin, /function loadBugReplayTerminalReport\(/, "terminal report loader missing");
assert.match(admin, /function downloadBugReplayFile\(/, "Bug Replay direct download helper missing");

// Completed runs must expose one aggregate report instead of stopping at / showing only the first-failure modal.
assert.match(admin, /id="bugReplayReportBar"/, "aggregate report bar must exist");
assert.match(admin, /คัดลอกลิงก์|คัดลอกรายงาน/, "aggregate report copy action missing");
assert.match(admin, /function renderBugReplayReportBar\(/, "aggregate report renderer missing");
assert.match(admin, /function createBugReplayAggregateReport\(/, "aggregate report creation action missing");
assert.match(admin, /ตรวจครบทุก scenario แล้ว · พบ/, "completed failure run must report all-scenario completion");
assert.doesNotMatch(admin, /function openBugReplayFailure\(/, "old first-failure modal should be removed");
assert.doesNotMatch(admin, /bugReplayFailureOverlay/, "old first-failure overlay should be removed");
assert.match(admin, /window\.open\(reportUrl,'_blank'/, "Bug Replay report action must open the dedicated report without activating a tester/game tab");

console.log("admin bug replay UI regression: PASS");
