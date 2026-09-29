const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRuntimeAudit } = require('./runtime-audit-engine');
const { normalizeDiagnosticFeatureKeys, featureAreaLabel } = require('./diagnostic-feature-taxonomy');

// Bug Replay is deliberately allow-listed. The Admin page can choose a scenario only by id;
// it can never send an arbitrary command/path to the server.
const BUG_REPLAY_SCENARIOS = [
    { id:'preflight-integrity', title:'Preflight / ตรวจระบบตรวจบั๊ก', action:'ตรวจความครอบคลุมและ regression ของจุดที่พึ่งแก้', description:'ตรวจว่า Bug Replay ครอบคลุม test ทุกไฟล์ที่รันได้ และล็อก Player Grid, force reload, Host fullscreen, version drift, Internal Browser embed, Admin workspace layout และผลลัพธ์ popup ของ runner เอง', tests:['tests/bug-replay-coverage-audit-regression.js','tests/name-policy-regression.js','tests/name-policy-browser-regression.py','tests/browser-harness-regression.js','tests/bug-replay-recent-fixes-regression.js','tests/diagnostic-feature-taxonomy-regression.js','tests/diagnostic-server-profile-parser-regression.js','tests/github-bug-report-game-profile-regression.js','tests/bug-replay-aggregate-report-regression.js','tests/admin-overview-ui-regression.js','tests/bug-replay-popup-behavior.js','tests/admin-internal-browser-embed-regression.js','tests/admin-release-clear-behavior.js','tests/update-detector-behavior.js','tests/admin-version-manager-contract.js','tests/admin-context-rail-removal-regression.js','tests/elastic-beanstalk-version-manager-regression.js','tests/admin-operations-ui-regression.js','tests/github-bug-report-regression.js','tests/github-bug-report-batch-regression.js','tests/github-bug-report-server-contract-regression.js','tests/github-issue-clear-regression.js','tests/github-screenshot-clear-regression.js','tests/github-screenshot-403-diagnostics-regression.js','tests/github-issue-clear-success-diagnostic-regression.js','tests/diagnostic-iam-authority-behavior.js','tests/diagnostic-noise-dedupe-regression.js','tests/diagnostic-github-incident-grouping-regression.js','tests/diagnostic-github-incident-lookup-behavior.js','tests/index-account-touch-lifecycle-regression.js','tests/index-lobby-viewport-fit-regression.py','tests/index-profile-dock-separation-regression.py','tests/index-resource-error-regression.js','tests/admin-internal-browser-capture-controls-placement-regression.js','tests/admin-internal-browser-screenshot-github-regression.js','tests/admin-internal-browser-screenshot-network-fallback-regression.js','tests/admin-internal-browser-screenshot-auth-fallback-regression.js','tests/admin-internal-browser-screenshot-performance-regression.js','tests/admin-internal-browser-screenshot-scroll-state-regression.js','tests/admin-internal-browser-screenshot-scroll-browser.py','tests/admin-internal-browser-screenshot-batch-browser.py','tests/page-title-branding-regression.js','tests/admin-internal-browser-screenshot-github-browser.py','tests/admin-internal-browser-screenshot-auth-fallback-browser.py','tests/admin-internal-browser-screenshot-performance-browser.py'] },
    { id:'runtime-audit', title:'Runtime Audit / ตรวจเหตุผิดปกติละเอียด', action:'ตรวจ state + DOM + socket + network + runtime + performance', description:'ตรวจเครื่องมือจับเหตุการณ์เฟส 1 เองและยืนยันว่า invariant, DOM anomaly, socket anomaly, network error และ timing anomaly ถูกจำแนกได้', tests:['tests/runtime-audit-engine-regression.js','tests/runtime-audit-browser-regression.js','tests/runtime-audit-live-browser.py','tests/runtime-audit-integration-regression.js','tests/runtime-audit-viewport-unavailable-regression.js'] },
    { id:'runtime-action-audit', title:'Runtime Action Audit / ตรวจการกระทำทุกหน้า', action:'ตรวจ UI action + socket action + outcome contract ของ Index / Player / Host / Admin', description:'ตรวจ Action Registry, action engine, static page contracts และรัน safe actions จริงบน browser fixture ของทุกหน้าหลัก เพื่อจับกรณีปุ่มกดได้แต่ผลไม่เกิด, action timeout และ contract ผิด รวมถึง Action Feedback, State Snapshot, Server Validation และ Timeline UX', tests:['tests/runtime-audit-action-registry-regression.js','tests/runtime-audit-action-engine-regression.js','tests/runtime-audit-action-page-contract-regression.js','tests/runtime-audit-browser-actions-regression.py','tests/runtime-audit-cross-page-regression.js','tests/runtime-audit-user-action-observation-regression.py','tests/game-runtime-client-contract-regression.js','tests/game-runtime-client-browser-regression.py','tests/gameplay-state-ux-regression.js','tests/server-action-validation-regression.js','tests/server-state-snapshot-contract-regression.js'] },
    { id:'runtime-action-deep', title:'Runtime Action Deep / เกมจริงจำลอง + Negative + Recovery', action:'ครอบคลุมการกระทำ Player / Host / Admin ตั้งแต่ lobby → game → recovery', description:'รวม Action Registry เข้ากับชุดทดสอบเกมที่มีอยู่แล้ว: role matrix, forbidden actions, security, outcomes, chat privacy, room state machine, reconnect และ bot flow โดยไม่ auto-run destructive action บนห้องจริง พร้อม Host Preset และ reconnect snapshot UX', tests:['tests/runtime-audit-action-registry-regression.js','tests/runtime-audit-cross-page-regression.js','tests/game-action-simulation-regression.js','tests/role-action-matrix-regression.js','tests/forbidden-action-matrix-simulation-regression.js','tests/negative-actions-security-regression.js','tests/role-action-guards-regression.js','tests/role-secret-results-regression.js','tests/role-chat-privacy-regression.js','tests/room-state-machine-simulation-regression.js','tests/game-outcome-simulation-regression.js','tests/bot-possession-regression.js','tests/host-room-recovery-regression.js','tests/room-nested-reconnect-regression.js','tests/reconnect-snapshot-ux-regression.js','tests/host-preset-regression.js'] },
    { id:'boot-config', title:'เปิดเกม / โหลด Config', action:'โหลดหน้าเกมและ config', description:'ตรวจเส้นทางเริ่มต้นที่ทุกหน้าใช้ก่อนเข้าสู่เกม', tests:['tests/config-diagnostics-regression.js','tests/config-client-retry-regression.js','tests/config-client-runtime-behavior.js','tests/diagnostic-iam-cause-regression.js','tests/app-version-regression.js','tests/index-server-state-boot-gate-regression.js','tests/index-server-state-authority-behavior.js','tests/index-server-reopen-no-flash-regression.js','tests/index-server-closed-no-flash-browser.py'] },
    { id:'account', title:'ตัวตนบัญชี', action:'เข้าสู่ระบบ / bootstrap บัญชี', description:'ตรวจ bootstrap, session และ identity ก่อนเล่นเกม', tests:['tests/account-identity-behavior.js','tests/account-phase2-contract.js','tests/account-session-room-membership-regression.js'] },
    { id:'room-create', title:'สร้างห้อง', action:'สร้างห้องใหม่', description:'ตรวจ ACK และ state ของการสร้างห้อง', tests:['tests/create-room-ack-regression.js'] },
    { id:'room-list', title:'ค้นหา / เลือกห้อง', action:'ดูห้องและเลือกห้อง', description:'ตรวจรายการห้อง, การเลือกห้อง และการตอบ ACK', tests:['tests/socket-list-ack-regression.js','tests/player-room-choice-regression.js','tests/player-lobby-ui-regression.js'] },
    { id:'room-security', title:'รหัสห้อง / ห้องซ้อน / เต็ม', action:'ลองรหัสผิด ห้องชน และเข้าห้องที่ไม่ควรเข้า', description:'negative tests สำหรับ room-id collision, join code, max players และการกันผู้เล่นใหม่หลังเริ่มเกม', tests:['tests/room-security-depth-regression.js','tests/room-password-separation-regression.js','tests/room-nested-reconnect-regression.js','tests/room-state-machine-simulation-regression.js'] },
    { id:'pre-game', title:'ห้องก่อนเริ่มเกม', action:'ตั้งค่าห้อง / รอผู้เล่น', description:'ตรวจธีม, UI และ state ก่อนกดเริ่มเกม', tests:['tests/pregame-day-theme-regression.js','tests/room-theme-reload-regression.js','tests/room-theme-reload-behavior.js','tests/host-day-surfaces-regression.js'] },
    { id:'start-game', title:'เริ่มเกม / แจกบท', action:'กดเริ่มเกมและแจกบท', description:'ตรวจการเริ่มรอบ, จำนวนบทบาท และ UI หลังเริ่มเกม', tests:['tests/host-ui-regression.js','tests/host-phase-control-regression.js','tests/player-game-ui-regression.js','tests/host-role-image-stability-regression.js'] },
    { id:'role-catalog', title:'ตรวจ Role Registry ปัจจุบัน', action:'ตรวจบทบาททุกอาชีพ', description:'ตรวจ registry ของบทบาทที่เกมรุ่นนี้ประกาศและทีมของแต่ละบท', tests:['tests/role-catalog-depth-regression.js','tests/role-action-matrix-regression.js'] },
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
    { id:'room-recovery', title:'กลับเข้าห้อง / Reconnect', action:'reconnect / recover ห้อง', description:'จำลองเส้นทางที่ RAM room หาย, browser reconnect และ Immutable deployment handoff', tests:['tests/room-recovery-iam-regression.js','tests/host-room-recovery-regression.js','tests/room-nested-reconnect-regression.js','tests/room-failover-handoff-regression.js'] },
    { id:'browser-exit', title:'ปิดแท็บ / กลับเข้าใหม่', action:'pagehide / browser exit / reconnect', description:'ตรวจ grace period และการกันการปิดห้องโดยไม่ตั้งใจ', tests:['tests/browser-exit-guard-regression.js','tests/browser-exit-guard-behavior.js','tests/browser-exit-duplicate-lifecycle-regression.js'] },
    { id:'leave', title:'ออกกลางเกม / abandon', action:'ออกห้องระหว่างสถานะต่าง ๆ', description:'ตรวจผลของการออกก่อนเริ่ม, ระหว่างเกม และตอนจบ', tests:['tests/player-room-choice-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'restart', title:'จบรอบ / เริ่มรอบใหม่', action:'restart หลังจบเกม', description:'ตรวจการล้าง state รอบเก่าและการกลับเข้าสู่รอบใหม่', tests:['tests/host-room-recovery-regression.js','tests/create-room-ack-regression.js','tests/game-action-simulation-regression.js'] },
    { id:'bot-flow', title:'บอท / AI', action:'เพิ่มบอทและเดินเกมต่อ', description:'ตรวจ ownership, possession, AI toggles และการห้ามเพิ่มบอทหลังเริ่มเกม', tests:['tests/bot-possession-regression.js','tests/negative-actions-security-regression.js'] },
    { id:'client-update', title:'อัปเดต Client กลางห้อง', action:'ตรวจ client version / refresh', description:'ตรวจการรับรุ่นใหม่โดยไม่ทำลายห้องหรือ token', tests:['tests/app-version-regression.js','tests/admin-release-regression.js','tests/admin-update-regression.js','tests/deployment-aware-update-regression.js','tests/deployment-state-behavior.js'] },
    { id:'runtime', title:'Runtime / Network Error', action:'จำลอง network และ runtime failure', description:'ตรวจ timeout, unhandled rejection และการรักษาห้อง', tests:['tests/diagnostic-runtime-hardening-regression.js','tests/diagnostic-runtime-hardening-behavior.js','tests/config-client-retry-regression.js'] },
    { id:'diagnostics', title:'สร้างรายงานบั๊ก', action:'จับ Error และสร้าง report', description:'ตรวจ causal analysis, incident, share link และ export JSON ของรายงาน', tests:['tests/admin-diagnostics-regression.js','tests/admin-diagnostics-browser-regression.py','tests/admin-diagnostics-toolbar-ui-regression.js','tests/bug-replay-first-failure-export-regression.js','tests/bug-replay-first-failure-report-regression.js','tests/diagnostic-causal-analysis-regression.js','tests/diagnostic-causal-analysis-behavior.js','tests/diagnostic-causal-links-regression.js','tests/diagnostic-share-regression.js','tests/diagnostic-share-behavior.js','tests/diagnostic-incident-share-regression.js','tests/diagnostic-incident-share-behavior.js','tests/diagnostic-payload-size-regression.js','tests/diagnostic-incident-replay-regression.js','tests/diagnostic-json-export-regression.js'] },
    { id:'event-coverage', title:'ตรวจ Event เกมทั้งหมด', action:'ตรวจ action handlers ทั้งหมด', description:'สแกน socket event ทั้งหมดที่เซิร์ฟเวอร์ประกาศ และตรวจ sensitive event ให้ครบ', tests:['tests/bug-replay-event-coverage-regression.js','tests/all-event-negative-matrix-regression.js'] },
    { id:'security-cross-room', title:'ข้ามห้อง / สิทธิ์ข้ามผู้ใช้', action:'เอา socket/token ของอีกห้องมายิง event', description:'ตรวจว่า identity ของ socket และ room ถูกผูกถูกต้อง ไม่อ่านหรือแก้ state ข้ามห้อง', tests:['tests/cross-room-authorization-regression.js','tests/negative-actions-security-regression.js'] },
    { id:'admin', title:'ศูนย์แอดมิน', action:'ตรวจ session / release / deploy readiness', description:'ตรวจส่วนควบคุมที่ใช้ตรวจและซ่อมระบบ', tests:['tests/admin-auth-regression.js','tests/admin-auth-login-ui-regression.js','tests/admin-tab-session-regression.js','tests/admin-tab-duplication-behavior.js','tests/admin-shell-browser.py','tests/admin-real-html-browser.py','tests/admin-phase2-browser.py','tests/admin-phase2-ui-regression.js','tests/admin-release-regression.js','tests/admin-quick-panel-account-separation-regression.js','tests/admin-player-detail-history-regression.py','tests/admin-room-inspector-regression.py','tests/admin-room-inspector-contract.js','tests/admin-popup-header-boundary-regression.py','tests/admin-embedded-session-regression.js'] },
    { id:'admin-internal-browser', title:'Admin Internal Browser / Multi-Tab Tester', action:'เปิด Game / Tester ในแท็บภายใน Admin โดยไม่สร้างแท็บ Chrome ใหม่', description:'ตรวจ Internal Browser shell, per-tab session isolation, Tester launch และการควบคุมแท็บจาก Admin หน้าเดียว', tests:['tests/admin-internal-browser-regression.py','tests/admin-internal-browser-contract.js','tests/admin-internal-browser-storage-regression.js','tests/admin-internal-browser-embed-regression.js','tests/admin-internal-browser-health-contract.js','tests/admin-internal-browser-live-frame-regression.py','tests/admin-internal-browser-viewport-recovery-regression.js','tests/admin-browser-focus-layout-regression.py','tests/admin-ipad-browser-focus-regression.py','tests/admin-browser-report-fixes-regression.js','tests/host-admin-browser-layout-recovery-regression.js'] },
    { id:'assets', title:'Assets / S3', action:'โหลดไฟล์ CSS / JS / รูป', description:'ตรวจไฟล์ที่หน้าเกมต้องใช้ในการแสดงผล', tests:['tests/s3-assets-regression.js','tests/server-closed-icon-source-regression.js'] },
    { id:'player-grid-deep', title:'Player Grid / Responsive Deep Audit', action:'จำลองจำนวนผู้เล่น + resize + หมุนจอ + background recovery', description:'ตรวจ Grid ด้วยพื้นที่/จำนวนคนจริง, transient measurement, fallback card และ browser harness', tests:['tests/player-grid-auto-flow-regression.js','tests/player-html-grid-responsive-regression.js','tests/player-html-grid-responsive-browser.py','tests/player-wide-screen-browser.py','tests/fluid-layout-regression.js'] },
    { id:'host-focus', title:'Host Fullscreen / Grid Deep Audit', action:'สลับเต็มจอ + เปลี่ยนห้อง + resize', description:'ตรวจ race ของ room_update/host_login, ปุ่มเต็มจอ, compact tablet grid และ 29-bot viewport reproduction ใน Host', tests:['tests/host-player-focus-regression.js','tests/host-player-grid-standard-regression.js','tests/admin-viewport-command-regression.js','tests/admin-viewport-command-behavior.js','tests/admin-browser-viewport-regression.js','tests/host-player-grid-incident-regression.js','tests/host-player-grid-29-viewport-browser.py'] },
    { id:'admin-ops', title:'Admin Operations / Dispatch Deep Audit', action:'บังคับโหลดใหม่ + session + deploy readiness', description:'ตรวจเส้นทางคำสั่งแอดมินที่ต้องตอบสนองไวและไม่รอ persistence โดยไม่จำเป็น', tests:['tests/admin-force-reload-fast-regression.js','tests/admin-deploy-readiness-regression.js','tests/admin-release-regression.js','tests/admin-quick-panel-account-separation-regression.js','tests/admin-bug-replay-ui-regression.js','tests/bug-replay-live-failure-report-regression.js','tests/bug-replay-admin-regression.js','tests/admin-player-detail-history-regression.py','tests/admin-room-inspector-regression.py','tests/admin-room-inspector-contract.js','tests/admin-popup-header-boundary-regression.py','tests/admin-embedded-session-regression.js'] },
    { id:'version-deploy', title:'Version / Deployment Drift Audit', action:'จำลองรุ่นเก่า → รุ่นใหม่ → AWS สะดุด', description:'ตรวจ Running Version freshness, stale client detection และ deployment transition', tests:['tests/app-version-regression.js','tests/admin-release-regression.js','tests/tester-update-channel-regression.js','tests/config-client-retry-regression.js'] },
    { id:'replay-engine', title:'Bug Replay Engine / Self Audit', action:'ทดสอบตัวเครื่องมือจำลองเอง', description:'ตรวจ catalog, allow-list, event coverage, comprehensive matrix และ runner semantics', tests:['tests/bug-replay-admin-regression.js','tests/bug-replay-runner-regression.js','tests/bug-replay-deep-mode-behavior.js','tests/bug-replay-comprehensive-regression.js','tests/bug-replay-event-coverage-regression.js'] },
    { id:'auth-edge', title:'Authentication / Tester Edge Audit', action:'จำลอง login, tester handshake และ session isolation', description:'ตรวจ account, Google auth และโหมดทดสอบไม่ชนกัน', tests:['tests/google-auth-regression.js','tests/admin-auth-diagnostic-wrapper-behavior.js','tests/tester-auth-startup-race-regression.js','tests/tester-cookie-isolation-regression.js','tests/tester-pass-handshake-regression.js','tests/tester-shared-secret-regression.js','tests/profile-ui-regression.js'] },
    { id:'runtime-resilience', title:'Infrastructure / Runtime Deep Audit', action:'จำลอง server warming, network, IAM และ runtime failure', description:'ตรวจระบบที่ต้องทน deployment, network และสิทธิ์ AWS ผิดพลาด', tests:['tests/infrastructure-resilience-regression.js','tests/deploy-drain-persistence-regression.js','tests/diagnostic-runtime-hardening-regression.js','tests/diagnostic-runtime-hardening-behavior.js','tests/room-recovery-iam-regression.js'] },
    { id:'diagnostics-deep', title:'Diagnostics / Sanitization Deep Audit', action:'จำลอง error → causal chain → share report', description:'ตรวจรายงานละเอียด, การ sanitize และความสัมพันธ์ของเหตุการณ์', tests:['tests/diagnostic-report-sanitization-regression.js','tests/admin-diagnostics-regression.js','tests/diagnostic-causal-analysis-regression.js','tests/diagnostic-causal-analysis-behavior.js','tests/diagnostic-causal-links-regression.js','tests/diagnostic-share-regression.js','tests/diagnostic-share-behavior.js','tests/diagnostic-incident-share-regression.js','tests/diagnostic-incident-share-behavior.js','tests/diagnostic-incident-replay-regression.js'] },
    { id:'full-audit', title:'Full Coverage Audit', action:'นับบทบาท + event + negative cases + outcomes', description:'รันตัวตรวจภาพรวมอีกชั้นเพื่อยืนยันว่าชุดทดสอบไม่ขาดหมวดสำคัญ', tests:['tests/bug-replay-comprehensive-regression.js'] },
];


const SCENARIO_FEATURE_KEYS = Object.freeze({
    'preflight-integrity':['bug_replay','replay_coverage','diagnostics','github','screenshots','player_grid','version_drift','admin_browser','room_reset'],
    'runtime-audit':['runtime','performance','network','socket','state_snapshot','dom'],
    'runtime-action-audit':['runtime_actions','player_lifecycle','game_state','server_validation','state_snapshot','actions'],
    'runtime-action-deep':['roles','role_guards','voting','night_actions','game_outcomes','chat','private_secrets','bots','reconnect','room_recovery'],
    'boot-config':['index','config','deployment','version_drift','stale_client'],
    'account':['account','session','profile','privacy'],
    'room-create':['room_create','room_state','persistence'],
    'room-list':['room_list','lobby','socket_events'],
    'room-security':['room_security','cross_room','socket_auth','account','room_state'],
    'pre-game':['room_settings','themes','reveal_dead_role','tester_conditions'],
    'start-game':['game_start','roles','role_catalog','game_phase'],
    'role-catalog':['role_catalog','roles','wolf_team','villager_team','solo_roles','cult','bandit','accomplice'],
    'role-wolf':['wolf_team','junior_wolf','guardian_wolf','stubborn_wolf','wizard_wolf','wolf_seer','cursed'],
    'role-villager':['villager_team','doctor','bodyguard','gangster','shield_guardian','aura_seer','seer','detective','angry_grandma','witch','vigilante','priest','mayor','loud_child'],
    'role-solo':['solo_roles','fool','headhunter','serial_killer','illusionist','win_conditions'],
    'role-pairs':['cupid','lovers','instigator','private_secrets','game_outcomes'],
    'role-cult-bandit':['cult','bandit','accomplice','role_transformation','role_guards'],
    'night-actions':['night_actions','game_phase','role_guards','voting','game_outcomes'],
    'vote':['voting','day_actions','game_outcomes'],
    'outcomes':['game_outcomes','win_conditions','lovers','instigator','solo_roles'],
    'chat':['chat','team_chat','private_secrets','cult','bandit','instigator'],
    'negative-actions':['security','role_guards','phase_locks','socket_auth','cross_room'],
    'private-secrets':['private_secrets','role_secrets','team_chat','privacy'],
    'vote-draw':['voting','game_state','game_outcomes'],
    'game-outcomes':['game_outcomes','win_conditions','lovers','instigator','solo_roles'],
    'forbidden-actions':['security','role_guards','phase_locks','server_validation'],
    'room-recovery':['reconnect','room_recovery','failover','persistence','state_snapshot'],
    'browser-exit':['browser_exit','player_lifecycle','session','reconnect'],
    'leave':['player_lifecycle','rooms','room_state'],
    'restart':['game_state','game_start','room_reset'],
    'bots':['bot_ai','possession','player_lifecycle','room_state','reconnect'],
    'bot-flow':['bot_ai','possession','player_lifecycle','room_state','reconnect'],
    'client-update':['deployment','version_drift','stale_client','retry'],
    'runtime':['runtime','network','performance','aws','dynamodb','s3'],
    'security-cross-room':['security','cross_room','socket_auth','rooms'],
    'assets':['assets','s3','cloudfront'],
    'player-grid-deep':['player_grid','viewport','performance','fullscreen'],
    'tester-mode':['tester','tester_conditions','session','session_isolation','admin_browser','multi_tab'],
    'reconnect':['reconnect','room_recovery','failover','background_recovery'],
    'deployment':['deployment','version_drift','stale_client','retry','resilience'],
    'runtime-resilience':['runtime','network','performance','aws','persistence'],
    'diagnostics':['diagnostics','diagnostic_share','causal_analysis','causal_graph','incident','github'],
    'event-coverage':['socket_events','coverage','security','cross_room'],
    'admin':['admin','admin_accounts','session','release','deployment'],
    'admin-internal-browser':['admin_browser','multi_tab','viewport','fullscreen','tester','session'],
    'host-focus':['player_grid','viewport','fullscreen','admin_browser'],
    'admin-ops':['admin','operations','room_inspector','reset_state','diagnostics'],
    'version-deploy':['deployment','version_drift','stale_client','cloudfront','elastic_beanstalk'],
    'replay-engine':['bug_replay','replay_engine','replay_coverage','environment_skip','diagnostics'],
    'auth-edge':['google_auth','account','session','tester','session_isolation','profile'],
    'diagnostics-deep':['diagnostics','diagnostic_share','sanitization','causal_analysis','incident','github'],
    'full-audit':['role_catalog','socket_events','game_outcomes','security','diagnostics','bug_replay'],
    'phase2-chaos':['runtime','network','reconnect','resilience','room_recovery'],
    'phase2-stress':['performance','player_lifecycle','player_grid','bot_ai','runtime'],
    'phase2-long-run':['performance','runtime','memory','player_lifecycle','reconnect'],
    'phase2-recovery':['reconnect','background_recovery','room_recovery','failover','session'],
    'phase2-full-suite':['runtime','performance','reconnect','resilience','bug_replay','replay_coverage'],
});

function scenarioFeatureKeys(scenario) {
    const keys = [];
    if (scenario?.featureKeys) keys.push(...scenario.featureKeys);
    keys.push(...(SCENARIO_FEATURE_KEYS[scenario?.id] || []));
    return normalizeDiagnosticFeatureKeys(keys);
}

function scenarioFeatureLabels(scenario) {
    return scenarioFeatureKeys(scenario).slice(0, 14).map(featureAreaLabel);
}

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
    return source.map((x, i) => ({ index:i, id:x.id, title:x.title, action:x.action, description:x.description, testCount:x.tests.length, featureKeys:scenarioFeatureKeys(x), featureLabels:scenarioFeatureLabels(x) }));
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
            const pythonPlaywrightMissing = isPython && /ModuleNotFoundError:\s*No module named [\"']playwright[\"']/i.test(combined);
            const skipped = code === 77 || /^SKIP:/m.test(combined) || pythonPlaywrightMissing;
            finish({
                ok:code === 0 && !skipped,
                skipped,
                skipReason: pythonPlaywrightMissing ? 'PYTHON_PLAYWRIGHT_UNAVAILABLE' : '',
                exitCode:code,
                signal,
                timedOut:false,
            });
        });
    });
}

async function runBugReplayScenario(scenario, options = {}) {
    const tests = Array.isArray(scenario?.tests) ? scenario.tests : [];
    const steps = [];
    const failures = [];
    const continueOnFailure = options.continueOnFailure !== false;
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
        const step = { index:i, testPath, ok:!!result.ok, skipped:!!result.skipped, skipReason:result.skipReason || '', exitCode:result.exitCode, signal:result.signal, timedOut:!!result.timedOut, durationMs:result.durationMs, stdout:result.stdout, stderr:result.stderr };
        if (options.audit) {
            options.audit.record('test', 'test.complete', { testPath, stepIndex:i, ok:step.ok, skipped:step.skipped, exitCode:step.exitCode, signal:step.signal, timedOut:step.timedOut, durationMs:step.durationMs });
            options.audit.slowStep(testPath, step.durationMs, { stepIndex:i });
            if (step.timedOut) options.audit.addFinding('performance', 'CHILD_TIMEOUT', `child test timeout: ${testPath}`, { testPath, stepIndex:i, durationMs:step.durationMs }, 'critical', 'bug-replay');
            else if (step.skipped && step.skipReason) options.audit.addFinding('environment', step.skipReason, `ข้าม browser test เนื่องจาก Python Playwright ไม่พร้อม: ${testPath}`, { testPath, stepIndex:i }, 'warning', 'bug-replay');
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

module.exports = { BUG_REPLAY_SCENARIOS, listBugReplayScenarios, getBugReplayScenario, runChildTest, runBugReplayScenario, createRuntimeAudit };
