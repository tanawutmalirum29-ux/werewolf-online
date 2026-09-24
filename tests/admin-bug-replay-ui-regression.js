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
assert.match(admin, /id="bugReplayPhase2Btn"/, "Phase 2 runner button missing");
assert.match(admin, /startBugReplay\('phase2'\)/, "Phase 2 button must start the allow-listed phase2 mode");
assert.match(admin, /bugReplayScenarioMode/, "Admin must track whether it is showing base or Phase 2 scenarios");
assert.match(admin, /job\.mode==="phase2" \? `\$\{done\} \/ \$\{total\} stage/, "Phase 2 progress must be expressed as stages");
assert.match(admin, /phase2Reports/, "Admin must surface structured Phase 2 stage reports");
assert.match(admin, /bug-replay\/scenarios\?mode=\'\+encodeURIComponent\(bugReplayScenarioMode\)/, "scenario API must request the selected runner mode");

// Failure report modal must never expose horizontal scrolling, even for long IDs/URLs/output.
assert.match(admin, /\.ww-modal-overlay\{overflow:hidden;/, "modal overlay must lock horizontal overflow");
assert.match(admin, /\.ww-modal-box\{min-width:0;max-width:calc\(100vw - 36px\);overflow-x:hidden;/, "modal box must suppress horizontal overflow");
assert.match(admin, /\.bug-replay-modal-report\{[^}]*overflow-wrap:anywhere;[^}]*overflow-x:hidden;/, "report body must wrap long tokens and hide horizontal overflow");
assert.match(admin, /\.bug-replay-modal-link\{[^}]*overflow-wrap:anywhere;[^}]*overflow-x:hidden;/, "share link area must wrap long URLs");
assert.match(admin, /class="ww-modal-box bug-replay-modal-box"/, "failure report must use hardened modal box");
assert.match(admin, /id='bugReplayFailureOverlay'/, "failure overlay must remain dynamically created");

console.log("admin bug replay UI regression: PASS");
