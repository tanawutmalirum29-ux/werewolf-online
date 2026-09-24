const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRuntimeAudit } = require('./runtime-audit-engine');

// Bug Replay is deliberately allow-listed. The Admin page can choose a scenario only by id;
// it can never send an arbitrary command/path to the server.
const BUG_REPLAY_SCENARIOS = [
    { id:'preflight-integrity', title:'Preflight / ตรวจระบบตรวจบั๊ก', action:'ตรวจความครอบคลุมและ regression ของจุดที่พึ่งแก้', description:'ตรวจว่า Bug Replay ครอบคลุม test ทุกไฟล์ที่รันได้ และล็อก Player Grid, force reload, Host fullscreen, version drift และตัว runner เอง', tests:['tests/bug-replay-coverage-audit-regression.js','tests/bug-replay-recent-fixes-regression.js'] },
    { id:'runtime-audit', title:'Runtime Audit / ตรวจเหตุผิดปกติละเอียด', action:'ตรวจ state + DOM + socket + network + runtime + performance', description:'ตรวจเครื่องมือจับเหตุการณ์เฟส 1 เองและยืนยันว่า invariant, DOM anomaly, socket anomaly, network error และ timing anomaly ถูกจำแนกได้', tests:['tests/runtime-audit-engine-regression.js','tests/runtime-audit-browser-regression.js','tests/runtime-audit-live-browser.py','tests/runtime-audit-integration-regression.js'] },
    { id:'boot-config', title:'เปิดเกม / โหลด Config', action:'โหลดหน้าเกมและ config', description:'ตรวจเส้นทางเริ่มต้นที่ทุกหน้าใช้ก่อนเข้าสู่เกม', tests:['tests/config-diagnostics-regression.js','tests/config-client-retry-regression.js','tests/app-version-regression.js'] },
    { id:'account', title:'ตัวตนบัญชี', action:'เข้าสู่ระบบ / bootstrap บัญชี', description:'ตรวจ bootstrap, session และ identity ก่อนเล่นเกม', tests:['tests/account-identity-behavior.js','tests/account-phase2-contract.js'] },
    { id:'room-create', title:'สร้างห้อง', action:'สร้างห้องใหม่', description:'ตรวจ ACK และ state ของการสร้างห้อง', tests:['tests/create-room-ack-regression.js'] },
    { id:'room-list', title:'ค้นหา / เลือกห้อง', action:'ดูห้องและเลือกห้อง', description:'ตรวจรายการห้อง, การเลือกห้อง และการตอบ ACK', tests:['tests/socket-list-ack-regression.js','tests/player-room-choice-regression.js','tests/player-lobby-ui-regression.js'] },
    { id:'room-security', title:'รหัสห้อง / ห้องซ้อน / เต็ม', action:'ลองรหัสผิด ห้องชน และเข้าห้องที่ไม่ควรเข้า', description:'negative tests สำหรับ room-id collision, join code, max players และการกันผู้เล่นใหม่หลังเริ่มเกม', tests:['tests/room-security-depth-regression.js','tests/room-password-separation-regression.js','tests/room-nested-reconnect-regression.js','tests/room-state-machine-simulation-regression.js'] },
    { id:'pre-game', title:'ห้องก่อนเริ่มเกม', action:'ตั้งค่าห้อง / รอผู้เล่น', description:'ตรวจธีม, UI และ state ก่อนกดเริ่มเกม', tests:['tests/pregame-day-theme-regression.js','tests/room-theme-reload-regression.js','tests/room-theme-reload-behavior.js','tests/host-day-surfaces-regression.js'] },
    { id:'start-game', title:'เริ่มเกม / แจกบท', action:'กดเริ่มเกมและแจกบท', description:'ตรวจการเริ่มรอบ, จำนวนบทบาท และ UI หลังเริ่มเกม', tests:['tests/host-ui-regression.js','tests/player-game-ui-regression.js','tests/host-role-image-stability-regression.js'] },
    { id:'role-catalog', title:'ตรวจอาชีพครบ 30 บท', action:'ตรวจบทบาททุกอาชีพ', description:'ตรวจ registry ของทั้ง 30 อาชีพและทีมของแต่ละบท', tests:['tests/role-catalog-depth-regression.js','tests/role-action-matrix-regression.js'] },
    { id:'role-wolf', title:'อาชีพหมาป่าทั้งสาย', action:'จำลองการล่าและสกิลหมาป่า', description:'หมาป่า, ลูกหมาป่า, ผู้พิทักษ์, ดื้อรั้น, นักเวท และหยั่งรู้', tests:['tests/role-action-guards-regression.js','tests/forbidden-phase-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'role-villager', title:'อาชีพชาวบ้าน', action:'จำลองป้องกัน / ส่อง / ยิง / เผยตัว', description:'หมอ, บอดี้การ์ด, อันธพาล, หนูน้อย, ผู้มีลาง, ผู้หยั่งรู้, นักสืบ, ยาย, แม่มด, ศาลเตี้ย, นักบวช, นายก, เด็กขี้โวยวาย', tests:['tests/role-action-guards-regression.js','tests/role-action-matrix-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'role-solo', title:'อาชีพเดี่ยว', action:'จำลองคนบ้า / นักล่าหัว / ฆาตกร / นักเล่นกล', description:'ตรวจความสามารถและผลชนะของบทเดี่ยวทุกแบบ', tests:['tests/game-outcome-simulation-regression.js','tests/game-outcome-contract-regression.js','tests/negative-actions-security-regression.js'] },
    { id:'role-pairs', title:'กามเทพ / ผู้ยุยง', action:'จับคู่และตรวจชะตาร่วม', description:'จำลอง pending pair, pairing, secret result และเงื่อนไขชนะพิเศษ', tests:['tests/role-secret-results-regression.js','tests/game-action-simulation-regression.js','tests/game-outcome-simulation-regression.js'] },
    { id:'role-cult-bandit', title:'ลัทธิ / โจร', action:'ชักชวน / สังเวย / เปลี่ยนบท / ฆ่า', description:'ตรวจข้อห้ามของเป้าหมาย, กลุ่มแยก และการเปลี่ยนบทบาทกลางเกม', tests:['tests/role-action-guards-regression.js','tests/forbidden-phase-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'night-actions', title:'คืน / resolve กลางคืน', action:'เลือกเป้าและสรุปผลกลางคืน', description:'ตรวจการบันทึกคำสั่งก่อนเช้า, resolve, cascade deaths และ reset state', tests:['tests/bot-possession-regression.js','tests/game-action-simulation-regression.js','tests/role-action-guards-regression.js'] },
    { id:'vote', title:'โหวต / ประหาร', action:'เปิดโหวตและลงคะแนน', description:'ตรวจโหวตปกติ, นายก 2 เสียง, โล่, หมาป่าดื้อรั้น และ threshold', tests:['tests/player-game-ui-regression.js','tests/negative-actions-security-regression.js'] },
    { id:'vote-draw', title:'เสมอ / ไม่ประหาร', action:'จำลองคะแนนเสมอกัน', description:'ตรวจ tie vote ไม่ประหารใครแล้วเดินเกมต่อ', tests:['tests/vote-tie-draw-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'game-outcomes', title:'จบเกม: แพ้ / ชนะ / ผลพิเศษ', action:'จำลองทุกผลลัพธ์', description:'wolf, villager, fool, headhunter, murderer, illusionist, lovers และ instigators รวมถึงเกมที่ยังไม่จบ', tests:['tests/game-outcome-simulation-regression.js','tests/game-outcome-contract-regression.js'] },
    { id:'forbidden-actions', title:'ลองทำสิ่งที่ห้าม', action:'ยิง event ตรงนอก phase / ผิดบท / ตายแล้ว / self-target', description:'negative matrix ตรวจว่าคำสั่งต้องห้ามไม่เปลี่ยน state', tests:['tests/negative-actions-security-regression.js','tests/forbidden-phase-regression.js','tests/role-action-guards-regression.js','tests/forbidden-action-matrix-simulation-regression.js'] },
    { id:'private-secrets', title:'กันข้อมูลลับรั่ว', action:'ลองดูบท / แชททีม / ผลส่องของคนอื่น', description:'ตรวจ actor-scoped role result และ private/team chat isolation', tests:['tests/private-data-leak-regression.js','tests/role-secret-results-regression.js','tests/role-chat-privacy-regression.js'] },
    { id:'chat', title:'แชททุกประเภท', action:'global / wolf / cult / bandit / instigator / host chat', description:'ตรวจ phase, role และขอบเขตผู้รับข้อความทุกแบบ', tests:['tests/role-chat-privacy-regression.js','tests/player-game-ui-regression.js','tests/host-ui-regression.js'] },
    { id:'room-recovery', title:'กลับเข้าห้อง / Reconnect', action:'reconnect / recover ห้อง', description:'จำลองเส้นทางที่ RAM room หายหรือ browser reconnect', tests:['tests/room-recovery-iam-regression.js','tests/host-room-recovery-regression.js','tests/room-nested-reconnect-regression.js'] },
    { id:'browser-exit', title:'ปิดแท็บ / กลับเข้าใหม่', action:'pagehide / browser exit / reconnect', description:'ตรวจ grace period และการกันการปิดห้องโดยไม่ตั้งใจ', tests:['tests/browser-exit-guard-regression.js','tests/browser-exit-guard-behavior.js','tests/browser-exit-duplicate-lifecycle-regression.js'] },
    { id:'leave', title:'ออกกลางเกม / abandon', action:'ออกห้องระหว่างสถานะต่าง ๆ', description:'ตรวจผลของการออกก่อนเริ่ม, ระหว่างเกม และตอนจบ', tests:['tests/player-room-choice-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'restart', title:'จบรอบ / เริ่มรอบใหม่', action:'restart หลังจบเกม', description:'ตรวจการล้าง state รอบเก่าและการกลับเข้าสู่รอบใหม่', tests:['tests/host-room-recovery-regression.js','tests/create-room-ack-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'bot-flow', title:'บอท / AI', action:'เพิ่มบอทและเดินเกมต่อ', description:'ตรวจ ownership, possession, AI toggles และการห้ามเพิ่มบอทหลังเริ่มเกม', tests:['tests/bot-possession-regression.js','tests/negative-actions-security-regression.js'] },
    { id:'client-update', title:'อัปเดต Client กลางห้อง', action:'ตรวจ client version / refresh', description:'ตรวจการรับรุ่นใหม่โดยไม่ทำลายห้องหรือ token', tests:['tests/app-version-regression.js','tests/admin-release-regression.js'] },
    { id:'runtime', title:'Runtime / Network Error', action:'จำลอง network และ runtime failure', description:'ตรวจ timeout, unhandled rejection และการรักษาห้อง', tests:['tests/diagnostic-runtime-hardening-regression.js','tests/diagnostic-runtime-hardening-behavior.js','tests/config-client-retry-regression.js'] },
    { id:'diagnostics', title:'สร้างรายงานบั๊ก', action:'จับ Error และสร้าง report', description:'ตรวจ causal analysis, incident และ share link', tests:['tests/admin-diagnostics-regression.js','tests/diagnostic-causal-analysis-regression.js','tests/diagnostic-causal-analysis-behavior.js','tests/diagnostic-causal-links-regression.js','tests/diagnostic-share-regression.js','tests/diagnostic-share-behavior.js','tests/diagnostic-incident-share-regression.js','tests/diagnostic-incident-share-behavior.js'] },
    { id:'event-coverage', title:'ตรวจ Event เกมทั้งหมด', action:'ตรวจ action handlers ทั้งหมด', description:'สแกน socket event ทั้งหมดที่เซิร์ฟเวอร์ประกาศ และตรวจ sensitive event ให้ครบ', tests:['tests/bug-replay-event-coverage-regression.js','tests/all-event-negative-matrix-regression.js'] },
    { id:'security-cross-room', title:'ข้ามห้อง / สิทธิ์ข้ามผู้ใช้', action:'เอา socket/token ของอีกห้องมายิง event', description:'ตรวจว่า identity ของ socket และ room ถูกผูกถูกต้อง ไม่อ่านหรือแก้ state ข้ามห้อง', tests:['tests/cross-room-authorization-regression.js','tests/negative-actions-security-regression.js'] },
    { id:'admin', title:'ศูนย์แอดมิน', action:'ตรวจ session / release / deploy readiness', description:'ตรวจส่วนควบคุมที่ใช้ตรวจและซ่อมระบบ', tests:['tests/admin-auth-regression.js','tests/admin-tab-session-regression.js','tests/admin-tab-duplication-behavior.js','tests/admin-shell-browser.py','tests/admin-real-html-browser.py','tests/admin-release-regression.js','tests/admin-quick-panel-account-separation-regression.js'] },
    { id:'assets', title:'Assets / S3', action:'โหลดไฟล์ CSS / JS / รูป', description:'ตรวจไฟล์ที่หน้าเกมต้องใช้ในการแสดงผล', tests:['tests/s3-assets-regression.js'] },
    { id:'player-grid-deep', title:'Player Grid / Responsive Deep Audit', action:'จำลองจำนวนผู้เล่น + resize + หมุนจอ + background recovery', description:'ตรวจ Grid ด้วยพื้นที่/จำนวนคนจริง, transient measurement, fallback card และ browser harness', tests:['tests/player-grid-auto-flow-regression.js','tests/player-html-grid-responsive-regression.js','tests/player-html-grid-responsive-browser.py','tests/fluid-layout-regression.js'] },
    { id:'host-focus', title:'Host Fullscreen / Grid Deep Audit', action:'สลับเต็มจอ + เปลี่ยนห้อง + resize', description:'ตรวจ race ของ room_update/host_login, ปุ่มเต็มจอ และ grid ใน Host', tests:['tests/host-player-focus-regression.js','tests/host-player-grid-standard-regression.js','tests/admin-viewport-command-regression.js','tests/admin-viewport-command-behavior.js'] },
    { id:'admin-ops', title:'Admin Operations / Dispatch Deep Audit', action:'บังคับโหลดใหม่ + session + deploy readiness', description:'ตรวจเส้นทางคำสั่งแอดมินที่ต้องตอบสนองไวและไม่รอ persistence โดยไม่จำเป็น', tests:['tests/admin-force-reload-fast-regression.js','tests/admin-deploy-readiness-regression.js','tests/admin-release-regression.js','tests/admin-quick-panel-account-separation-regression.js','tests/admin-bug-replay-ui-regression.js','tests/bug-replay-admin-regression.js'] },
    { id:'version-deploy', title:'Version / Deployment Drift Audit', action:'จำลองรุ่นเก่า → รุ่นใหม่ → AWS สะดุด', description:'ตรวจ Running Version freshness, stale client detection และ deployment transition', tests:['tests/app-version-regression.js','tests/admin-release-regression.js','tests/tester-update-channel-regression.js','tests/config-client-retry-regression.js'] },
    { id:'replay-engine', title:'Bug Replay Engine / Self Audit', action:'ทดสอบตัวเครื่องมือจำลองเอง', description:'ตรวจ catalog, allow-list, event coverage, comprehensive matrix และ runner semantics', tests:['tests/bug-replay-admin-regression.js','tests/bug-replay-runner-regression.js','tests/bug-replay-deep-mode-behavior.js','tests/bug-replay-comprehensive-regression.js','tests/bug-replay-event-coverage-regression.js'] },
    { id:'auth-edge', title:'Authentication / Tester Edge Audit', action:'จำลอง login, tester handshake และ session isolation', description:'ตรวจ account, Google auth และโหมดทดสอบไม่ชนกัน', tests:['tests/google-auth-regression.js','tests/tester-auth-startup-race-regression.js','tests/tester-cookie-isolation-regression.js','tests/tester-pass-handshake-regression.js','tests/tester-shared-secret-regression.js','tests/profile-ui-regression.js'] },
    { id:'runtime-resilience', title:'Infrastructure / Runtime Deep Audit', action:'จำลอง server warming, network, IAM และ runtime failure', description:'ตรวจระบบที่ต้องทน deployment, network และสิทธิ์ AWS ผิดพลาด', tests:['tests/infrastructure-resilience-regression.js','tests/diagnostic-runtime-hardening-regression.js','tests/diagnostic-runtime-hardening-behavior.js','tests/room-recovery-iam-regression.js'] },
    { id:'diagnostics-deep', title:'Diagnostics / Sanitization Deep Audit', action:'จำลอง error → causal chain → share report', description:'ตรวจรายงานละเอียด, การ sanitize และความสัมพันธ์ของเหตุการณ์', tests:['tests/diagnostic-report-sanitization-regression.js','tests/admin-diagnostics-regression.js','tests/diagnostic-causal-analysis-regression.js','tests/diagnostic-causal-analysis-behavior.js','tests/diagnostic-causal-links-regression.js','tests/diagnostic-share-regression.js','tests/diagnostic-share-behavior.js','tests/diagnostic-incident-share-regression.js','tests/diagnostic-incident-share-behavior.js'] },
    { id:'full-audit', title:'Full Coverage Audit', action:'นับบทบาท + event + negative cases + outcomes', description:'รันตัวตรวจภาพรวมอีกชั้นเพื่อยืนยันว่าชุดทดสอบไม่ขาดหมวดสำคัญ', tests:['tests/bug-replay-comprehensive-regression.js'] },
];

const PHASE2_SCENARIOS = [
    { id:'phase2-chaos', title:'เฟส 2A · Chaos Fault Injection', action:'ฉีด disconnect / delay / duplicate / reorder / stale / HTTP / lifecycle faults', description:'รัน Chaos แบบ deterministic พร้อม seed, fault timeline และตรวจว่า state ยัง recovery/converge ได้', tests:['tests/phase2-chaos-regression.js'] },
    { id:'phase2-stress', title:'เฟส 2B · Stress 1→100 Players', action:'โหลดผู้เล่นเสมือน 1, 2, 4, 8, 16, 32, 50, 75, 100 คน', description:'รัน action workload หลายระดับ เก็บ p50/p95/p99 และตรวจ player/state/listener invariants', tests:['tests/phase2-stress-regression.js'] },
    { id:'phase2-long-run', title:'เฟส 2C · Long-Run / Endurance', action:'จำลอง lifecycle หลายพันรอบพร้อม checkpoint และ leak trend', description:'ตรวจแนวโน้ม listener, timer, DOM node และ event queue ว่าค่อย ๆ โตหรือไม่', tests:['tests/phase2-long-run-regression.js'] },
    { id:'phase2-recovery', title:'เฟส 2D · Recovery / Final Convergence', action:'จำลอง socket, HTTP, reload, background, interrupted action และ room rejoin recovery', description:'ตรวจว่า client กลับมาตรงกับ server และไม่มี stale/ghost state หลัง recovery', tests:['tests/phase2-recovery-regression.js'] },
    { id:'phase2-full-suite', title:'เฟส 2 · Full Chaos → Stress → Long-Run → Recovery', action:'รันทั้ง 4 ชั้นตามลำดับเดียวกับ production pre-release gate', description:'รวมทุก stage และสรุป pass/fail เดียวสำหรับเฟส 2', tests:['tests/phase2-suite-regression.js','tests/phase2-runner-integration-regression.js'] },
];

const ALL_SCENARIOS = [...BUG_REPLAY_SCENARIOS, ...PHASE2_SCENARIOS];
const byId = new Map(ALL_SCENARIOS.map((x) => [x.id, Object.freeze({ ...x, tests:Object.freeze([...x.tests]) })]));

function listBugReplayScenarios(mode = 'all') {
    const source = String(mode || 'all') === 'phase2' ? PHASE2_SCENARIOS : BUG_REPLAY_SCENARIOS;
    return source.map((x, i) => ({ index:i, id:x.id, title:x.title, action:x.action, description:x.description, testCount:x.tests.length }));
}

function getBugReplayScenario(id) {
    return byId.get(String(id || '')) || null;
}

function runChildTest(testPath, { timeoutMs = 20_000, env = process.env, onStart, onOutput, scenarioId = '', stepIndex = -1 } = {}) {
    return new Promise((resolve) => {
        const rootDir = path.resolve(__dirname, '..');
        const absolute = path.resolve(rootDir, testPath);
        if (!absolute.startsWith(rootDir + path.sep) || !fs.existsSync(absolute)) {
            resolve({ ok:false, exitCode:null, signal:null, durationMs:0, stdout:'', stderr:`test_not_found: ${testPath}` });
            return;
        }
        if (!/\.(?:js|py)$/.test(absolute)) {
            resolve({ ok:false, exitCode:null, signal:null, durationMs:0, stdout:'', stderr:`test_runtime_not_allowlisted: ${testPath}` });
            return;
        }
        const isPython = absolute.endsWith('.py');
        const command = isPython ? 'python3' : process.execPath;
        const args = [absolute];
        const started = Date.now();
        const spawnOptions = {
            cwd: rootDir,
            env: { ...env, WW_BUG_REPLAY: '1', WW_REPLAY_SCENARIO_ID: String(scenarioId || ''), WW_REPLAY_STEP_INDEX: String(stepIndex) },
            stdio: ['ignore', 'pipe', 'pipe'],
        };
        const child = isPython
            ? spawn('python3', args, spawnOptions)
            : spawn(process.execPath, [absolute], spawnOptions);
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve({ ...result, durationMs:Date.now()-started, stdout:stdout.slice(-12000), stderr:stderr.slice(-12000) });
        };
        onStart?.(child);
        child.stdout.on('data', (chunk) => { const s = String(chunk); stdout += s; onOutput?.({stream:'stdout', text:s}); });
        child.stderr.on('data', (chunk) => { const s = String(chunk); stderr += s; onOutput?.({stream:'stderr', text:s}); });
        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 500);
            finish({ ok:false, exitCode:null, signal:'TIMEOUT', timedOut:true });
        }, Math.max(2000, Number(timeoutMs) || 20_000));
        child.once('error', (err) => {
            clearTimeout(timer);
            if (isPython && err?.code === 'ENOENT') {
                finish({ ok:false, skipped:true, exitCode:null, signal:null, error:`SKIP: python3 unavailable for ${testPath}` });
                return;
            }
            finish({ ok:false, exitCode:null, signal:null, error:err.message });
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            const combined = `${stdout}\n${stderr}`;
            const skipped = code === 77 || /^SKIP:/m.test(combined);
            finish({ ok:code === 0 && !skipped, skipped, exitCode:code, signal, timedOut:false });
        });
    });
}

async function runBugReplayScenario(scenario, options = {}) {
    const tests = Array.isArray(scenario?.tests) ? scenario.tests : [];
    const steps = [];
    const failures = [];
    const continueOnFailure = options.continueOnFailure === true;
    for (let i = 0; i < tests.length; i += 1) {
        if (options.shouldStop?.()) {
            return { ok:false, stopped:true, stepIndex:i, steps, failures, failure:failures[0] || null };
        }
        const testPath = tests[i];
        options.audit?.record('test', 'test.start', { scenarioId:scenario?.id || '', testPath, stepIndex:i, totalSteps:tests.length });
        const result = await runChildTest(testPath, {
            timeoutMs: options.timeoutMs,
            env: options.env,
            scenarioId: scenario?.id || '',
            stepIndex: i,
            onStart: (child) => options.onTestStart?.({ child, testPath, stepIndex:i, totalSteps:tests.length }),
            onOutput: (out) => {
                if (options.audit) {
                    const text = String(out?.text || '');
                    options.audit.record('test', 'test.output', { testPath, stepIndex:i, stream:out?.stream || '', bytes:Buffer.byteLength(text), tail:text.slice(-500) });
                    const phase2Match = text.match(/^PHASE2_RESULT:(\{.*\})$/m);
                    if (phase2Match) {
                        try {
                            const parsed = JSON.parse(phase2Match[1]);
                            options.audit.record('phase2', 'phase2.stage.result', { testPath, stepIndex:i, result:parsed }, { source:'phase2-runner' });
                        } catch (_) {
                            options.audit.addFinding('runner', 'PHASE2_RESULT_INVALID', 'Phase 2 test emitted an invalid structured result', { testPath, stepIndex:i, tail:phase2Match[1].slice(-800) }, 'warning', 'phase2-runner');
                        }
                    }
                    if (/UnhandledPromiseRejection|uncaught(?:Exception| error)|SyntaxError|ReferenceError|TypeError:/i.test(text)) {
                        options.audit.addFinding('runtime', 'CHILD_RUNTIME_ERROR', 'child test output มี runtime error pattern', { testPath, stepIndex:i, stream:out?.stream || '', tail:text.slice(-1200) }, 'error', 'bug-replay');
                    }
                }
                options.onOutput?.({ ...out, testPath, stepIndex:i });
            },
        });
        const step = { index:i, testPath, ok:!!result.ok, skipped:!!result.skipped, exitCode:result.exitCode, signal:result.signal, timedOut:!!result.timedOut, durationMs:result.durationMs, stdout:result.stdout, stderr:result.stderr };
        if (options.audit) {
            options.audit.record('test', 'test.complete', { testPath, stepIndex:i, ok:step.ok, skipped:step.skipped, exitCode:step.exitCode, signal:step.signal, timedOut:step.timedOut, durationMs:step.durationMs });
            options.audit.slowStep(testPath, step.durationMs, { stepIndex:i });
            if (step.timedOut) options.audit.addFinding('performance', 'CHILD_TIMEOUT', `child test timeout: ${testPath}`, { testPath, stepIndex:i, durationMs:step.durationMs }, 'critical', 'bug-replay');
            else if (!step.ok && !step.skipped) options.audit.addFinding('test', 'TEST_STEP_FAILED', `test step failed: ${testPath}`, { testPath, stepIndex:i, exitCode:step.exitCode, signal:step.signal, stderr:String(step.stderr || '').slice(-2000) }, 'error', 'bug-replay');
        }
        steps.push(step);
        options.onStep?.(step);
        if (result.skipped) continue;
        if (!result.ok) {
            failures.push(step);
            if (options.shouldStop?.()) return { ok:false, stopped:true, stepIndex:i, steps, failures, failure:failures[0] || step };
            if (!continueOnFailure) return { ok:false, stopped:false, stepIndex:i, steps, failures, failure:step };
        }
    }
    return { ok:failures.length === 0, stopped:false, stepIndex:tests.length - 1, steps, failures, failure:failures[0] || null };
}

module.exports = { BUG_REPLAY_SCENARIOS, listBugReplayScenarios, getBugReplayScenario, runBugReplayScenario, createRuntimeAudit };
