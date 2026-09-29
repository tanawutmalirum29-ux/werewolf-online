'use strict';

const DIAGNOSTIC_FEATURE_TAXONOMY_VERSION = 5;

const FEATURE_LABELS = Object.freeze({
  index:'หน้า Index / เข้าสู่เกม', config:'Config / Client bootstrap', account:'บัญชีผู้เล่น', google_auth:'Google Login',
  session:'Session / Identity', lobby:'Lobby / รายการห้อง', rooms:'ระบบห้อง', room_create:'สร้างห้อง', room_list:'ค้นหาห้อง', room_settings:'ตั้งค่าห้อง',
  room_security:'ความปลอดภัยห้อง', room_state:'สถานะห้อง', room_reset:'รีเซ็ตเกม/ห้อง', room_recovery:'กู้คืนห้อง', failover:'Failover',
  game_start:'เริ่มเกม / แจกบท', game_phase:'Phase กลางวัน/กลางคืน', roles:'Role Registry', role_catalog:'บทบาททั้งหมด',
  wolf_team:'ทีมหมาป่า', villager_team:'ทีมชาวบ้าน', solo_roles:'บทเดี่ยว', cult:'ลัทธิ', bandit:'โจร', accomplice:'ผู้สมรู้ร่วมคิด',
  lovers:'คู่รัก', instigator:'ผู้ยุยง', voting:'โหวต / ประหาร', night_actions:'คำสั่งกลางคืน', day_actions:'คำสั่งกลางวัน',
  game_outcomes:'เงื่อนไขจบเกม', chat:'แชท', team_chat:'แชททีม', private_secrets:'ข้อมูลลับ',
  bot_ai:'Bot AI', possession:'Bot Possession', tester:'โหมดผู้ทดสอบ', tester_conditions:'เงื่อนไข Tester',
  player_lifecycle:'วงจรผู้เล่น', player_grid:'Player Grid', reconnect:'Reconnect', background_recovery:'Background / Recovery',
  deployment:'Deployment / Update', version_drift:'Version Drift', stale_client:'Stale Client', network:'Network', runtime:'Runtime', performance:'Performance',
  security:'Security', cross_room:'Cross-room isolation', socket:'Socket.IO', socket_events:'Socket Events', socket_auth:'Socket Auth',
  admin:'Admin Center', admin_browser:'Admin Internal Browser', multi_tab:'Multi-tab', viewport:'Viewport', fullscreen:'Fullscreen',
  screenshots:'Screenshot Capture', screenshot_no_preview:'Screenshot ไม่มี Preview', screenshot_multisize:'Screenshot หลายขนาดจอ',
  diagnostics:'Diagnostics', diagnostic_share:'Diagnostic Share', causal_analysis:'Causal Analysis', causal_graph:'Causal Graph',
  incident:'Incident Consolidation', github:'GitHub Reporting', github_dedupe:'GitHub Dedupe', github_batch:'GitHub Batch Submit',
  bug_replay:'Bug Replay', replay_engine:'Replay Engine', replay_coverage:'Replay Coverage', environment_skip:'Environment Skip',
  reset_state:'Reset State Fan-out', persistence:'Persistence', aws:'AWS', dynamodb:'DynamoDB', s3:'S3', cloudfront:'CloudFront', elastic_beanstalk:'Elastic Beanstalk',
  assets:'External Assets', themes:'Themes', release:'Release Management', operations:'Admin Operations', room_inspector:'Room Inspector',
  action:'Game Actions', actions:'Game Actions', runtime_actions:'Runtime Actions', game_state:'Game State', server_validation:'Server Validation', state_snapshot:'State Snapshot', dom:'DOM Integrity', coverage:'Test Coverage', retry:'Retry / Recovery', resilience:'Resilience', sanitization:'Sanitization', browser_exit:'Browser Exit / Lifecycle', cross_room:'Cross-room Isolation',
  role_reveal:'เปิดบทคนตาย', reveal_dead_role:'Reveal Dead Role', illusionist:'นักเล่นกล',
  wizard_wolf:'หมาป่านักเวท', wolf_seer:'หมาป่าหยั่งรู้', stubborn_wolf:'หมาป่าดื้อรั้น', guardian_wolf:'หมาป่าผู้พิทักษ์', junior_wolf:'ลูกหมาป่า', cursed:'ผู้ถูกสาป',
  doctor:'หมอ', bodyguard:'บอดี้การ์ด', gangster:'อันธพาล', angry_grandma:'ยายขี้โมโห', vigilante:'ศาลเตี้ย', shield_guardian:'หนูน้อยผู้ใสซื่อ',
  aura_seer:'ผู้มีลาง', seer:'ผู้หยั่งรู้', detective:'นักสืบ', witch:'แม่มด', priest:'นักบวช', mayor:'นายก', loud_child:'เด็กขี้โวยวาย',
  fool:'คนบ้า', headhunter:'นักล่าหัว', serial_killer:'ฆาตกรต่อเนื่อง', cupid:'กามเทพ',
  role_transformation:'การเปลี่ยนบทบาท', role_guards:'Role Guards', phase_locks:'Phase Locks', win_conditions:'Win Conditions',
  admin_accounts:'จัดการบัญชี Admin', profile:'Profile / ชื่อผู้เล่น', privacy:'Privacy / Sanitization',
  session_isolation:'Session Isolation', role_secrets:'Role Secrets', memory:'Memory / Leak Trend',
});

const FEATURE_KEY_ALIASES = Object.freeze({
  runtime_actions:'runtime', runtime_audit:'runtime',
  room_settings:'room_settings', reveal_dead_role:'reveal_dead_role',
  tester_conditions:'tester_conditions', role_registry:'roles',
  admin_browser:'admin_browser', admin_internal_browser:'admin_browser',
  screenshot_capture:'screenshots', screenshot_batch:'screenshot_multisize', screenshot_current_viewport:'screenshot_current_viewport',
  screenshot_no_preview:'screenshot_no_preview', screenshots_no_preview:'screenshot_no_preview',
  github_reporting:'github', github_dedupe:'github_dedupe', github_batch:'github_batch',
  bug_replay_engine:'replay_engine', reset_fanout:'reset_state', admin_reset_fanout:'reset_state', game_reset:'room_reset', external_assets:'assets', github_auth:'github',
  role_catalog:'role_catalog', phase_locks:'phase_locks', win_conditions:'win_conditions',
  state_snapshot:'state_snapshot', game_state:'game_state', server_validation:'server_validation',
  player_grid:'player_grid', browser_exit:'browser_exit', crossroom:'cross_room', external_asset_source:'assets', room_failover:'failover',
});

function normalizeDiagnosticFeatureKeys(input) {
  const raw = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const out = new Set();
  for (const item of raw) {
    let key = String(item || '').trim()
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/[-_]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!key) continue;
    key = FEATURE_KEY_ALIASES[key] || key;
    out.add(key);
  }
  return [...out].sort();
}

function featureAreaLabel(key) {
  const k = String(key || '');
  return FEATURE_LABELS[k] || k.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown Feature';
}

function featureLabels(keys) {
  return normalizeDiagnosticFeatureKeys(keys).map(featureAreaLabel);
}

function stableHash(value) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function roleMechanicKey(roleName) {
  const map = {
    'หมาป่า':'wolf_team','ลูกหมาป่า':'junior_wolf','หมาป่าผู้พิทักษ์':'guardian_wolf','หมาป่าดื้อรั้น':'stubborn_wolf','หมาป่านักเวท':'wizard_wolf','หมาป่าหยั่งรู้':'wolf_seer',
    'ชาวบ้าน':'villager_team','ผู้ถูกสาป':'cursed','หมอ':'doctor','บอดี้การ์ด':'bodyguard','อันธพาล':'gangster','หนูน้อยผู้ใสซื่อ':'shield_guardian','ผู้มีลาง':'aura_seer','ผู้หยั่งรู้':'seer','นักสืบ':'detective','ยายขี้โมโห':'angry_grandma','แม่มด':'witch','ศาลเตี้ย':'vigilante','นักบวช':'priest','นายก':'mayor','เด็กขี้โวยวาย':'loud_child',
    'คนบ้า':'fool','นักล่าหัว':'headhunter','ฆาตกรต่อเนื่อง':'serial_killer','นักเล่นกล':'illusionist','กามเทพ':'cupid','ผู้นำลัทธิ':'cult','ผู้ยุยง':'instigator','โจร':'bandit','ผู้สมรู้ร่วมคิด':'accomplice',
  };
  return map[roleName] || `role:${String(roleName || 'unknown').slice(0,60)}`;
}

function safeRoleRegistry(roles) {
  const entries = Object.entries(roles || {}).map(([name, info]) => ({ name:String(name), team:String(info?.team || 'unknown'), score:Number(info?.score) || 0 }));
  entries.sort((a,b)=>a.name.localeCompare(b.name,'th'));
  return entries;
}

function extractSocketEvents(source='') {
  const names = new Set();
  for (const m of String(source).matchAll(/socket\.on\(\s*["'`]([^"'`]+)["'`]/g)) names.add(m[1]);
  return [...names].sort();
}

function extractHttpRoutes(source='') {
  const routes = new Set();
  for (const m of String(source).matchAll(/app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) routes.add(`${m[1].toUpperCase()} ${m[2]}`);
  return [...routes].sort();
}

function inferMechanicsFromRole(roleName, team) {
  const keys = [roleMechanicKey(roleName)];
  if (team === 'wolf') keys.push('wolf_team');
  if (team === 'villager') keys.push('villager_team');
  if (team === 'solo') keys.push('solo_roles');
  if (team === 'cult') keys.push('cult');
  if (team === 'bandit') keys.push('bandit');
  if (roleName === 'กามเทพ' || roleName === 'ผู้ยุยง') keys.push('lovers');
  if (roleName === 'ผู้ถูกสาป' || roleName === 'ผู้สมรู้ร่วมคิด') keys.push('role_transformation');
  return keys;
}

const SOURCE_FEATURE_RULES = Object.freeze([
  ['google_auth', /google|oauth|googleapis/i],
  ['room_settings', /update_room_settings|revealDeadRole|maxPlayers/i],
  ['reveal_dead_role', /revealDeadRole/i],
  ['themes', /theme|ธีม/i],
  ['room_security', /joinCode|hostPassword|cross-room|room.?security/i],
  ['room_recovery', /recoverPersistedRoom|roomLeaseEpoch|handoff|reconnect/i],
  ['failover', /roomLeaseEpoch|handoff|immutable/i],
  ['bot_ai', /isBot|botAI|botEngine/i],
  ['possession', /possession|possess|bot.*control/i],
  ['tester', /isTester|testerPass|testerSessionId|tester mode/i],
  ['session_isolation', /tester.*session|session.?isolation|embeddedStorage/i],
  ['player_grid', /player-grid|playerGrid|grid/i],
  ['viewport', /viewport|innerWidth|devicePixelRatio/i],
  ['fullscreen', /requestFullscreen|fullscreen/i],
  ['screenshots', /html2canvas|screenshot|captureCurrentActive/i],
  ['screenshot_no_preview', /no.?preview|lastCaptureBatch|captureBatch/i],
  ['screenshot_multisize', /VIEWPORT_PRESETS|captureBatch|captureMultiple/i],
  ['diagnostics', /recordDiagnostic|client-error|diagnostic/i],
  ['diagnostic_share', /diagnostics\/share|persistDiagnosticShare/i],
  ['causal_analysis', /buildDiagnosticAnalysis/i],
  ['causal_graph', /buildDiagnosticCausalGraph/i],
  ['incident', /diagnosticIncidentIdentity|incidentKeyHash/i],
  ['github', /createGithubBugReportIssue|GITHUB_BUG_REPORT/i],
  ['github_dedupe', /diagnosticGithubIncidentReports|searchGithubIssuesByText/i],
  ['github_batch', /createGithubScreenshotFiles|send all|ส่งรายงานทั้งหมด/i],
  ['bug_replay', /runBugReplayScenario|bugReplayJobs/i],
  ['replay_coverage', /bug-replay-coverage-audit|coverage audit/i],
  ['environment_skip', /PYTHON_PLAYWRIGHT_UNAVAILABLE|skipped.*playwright/i],
  ['reset_state', /resetInvalidated|admin_reset_started|startNewSessionEpoch/i],
  ['persistence', /DynamoDB|persistRoomSnapshot|ROOM_SNAPSHOT/i],
  ['external_assets', /s3|S3|external asset/i],
  ['deployment', /Elastic Beanstalk|deployment|deploy|release/i],
  ['version_drift', /stale.?client|version drift|appVersion/i],
  ['network', /fetch|network_error|socket/i],
  ['performance', /performance|timedOut|timeout/i],
  ['security', /authorization|permission|cross-room|forbidden/i],
  ['socket_events', /socket\.on\(|socket\.emit\(/i],
  ['admin_browser', /admin.?internal.?browser|embedded.?session/i],
  ['multi_tab', /multi.?tab|tab duplication|tabSession/i],
  ['room_reset', /reset.*room|restart.*room/i],
  ['game_phase', /isNight|phase|resolve_night/i],
  ['voting', /cast_vote|vote/i],
  ['night_actions', /resolve_night|night_actions|cast_wolf_kill/i],
  ['day_actions', /cast_vote|priest|vigilante|reveal_mayor/i],
  ['game_outcomes', /checkGameEnd|WIN_CONDITIONS|isWinner/i],
  ['chat', /send_chat|globalChatHistory|wolfChatHistory/i],
  ['private_secrets', /private|self-only|secret/i],
  ['role_transformation', /role = |change role|bandit|cursed/i],
  ['role_guards', /role.?guard|forbidden|cannot.*target/i],
  ['phase_locks', /room\.started|if \(room\.started\) return cb/i],
]);

function detectImplementedFeatureKeys(source = '', roleEntries = [], capabilities = {}) {
  const text = String(source || '');
  const out = new Set();
  for (const [key, pattern] of SOURCE_FEATURE_RULES) if (pattern.test(text)) out.add(key);
  if (roleEntries.length) {
    out.add('roles');
    out.add('role_catalog');
  }
  if (Array.isArray(capabilities?.roleRegistry) && capabilities.roleRegistry.length) {
    out.add('roles');
    out.add('role_catalog');
  }
  for (const role of roleEntries) {
    for (const key of normalizeDiagnosticFeatureKeys(inferMechanicsFromRole(role.name, role.team))) out.add(key);
  }
  for (const [key, enabled] of Object.entries(capabilities || {})) {
    if (enabled === true) out.add(key);
  }
  return normalizeDiagnosticFeatureKeys([...out]);
}

function buildGameDiagnosticProfile({ source='', appVersion='unknown', roles={}, teamLabels={}, winConditions=[], roomSettings=[], capabilities={}, replayScenarios=[], taxonomyVersion=DIAGNOSTIC_FEATURE_TAXONOMY_VERSION, runtimeSnapshot=null } = {}) {
  const roleEntries = safeRoleRegistry(roles);
  const teamCounts = {};
  for (const r of roleEntries) teamCounts[r.team] = (teamCounts[r.team] || 0) + 1;
  const roleFeatureCoverage = {};
  for (const r of roleEntries) roleFeatureCoverage[r.name] = normalizeDiagnosticFeatureKeys(inferMechanicsFromRole(r.name, r.team));

  const socketEvents = extractSocketEvents(source);
  const httpRoutes = extractHttpRoutes(source);
  const detectedFeatures = new Set(detectImplementedFeatureKeys(source, roleEntries, capabilities));
  if (Array.isArray(winConditions) && winConditions.length) detectedFeatures.add('win_conditions');
  if (Array.isArray(roomSettings) && roomSettings.length) detectedFeatures.add('room_settings');
  const systemFeatures = normalizeDiagnosticFeatureKeys([...detectedFeatures]);
  const rolesByTeam = {};
  for (const role of roleEntries) {
    const team = role.team || 'unknown';
    if (!rolesByTeam[team]) rolesByTeam[team] = [];
    rolesByTeam[team].push(role.name);
  }
  for (const list of Object.values(rolesByTeam)) list.sort((a,b)=>a.localeCompare(b,'th'));

  const replayCoverage = new Map();
  for (const scenario of Array.isArray(replayScenarios) ? replayScenarios : []) {
    for (const k of normalizeDiagnosticFeatureKeys(scenario?.featureKeys || [])) replayCoverage.set(k, (replayCoverage.get(k) || 0) + 1);
  }
  const replayFeatureCoverage = [...replayCoverage.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key, scenarioCount])=>({ key, label:featureAreaLabel(key), scenarioCount }));

  const normalizedCapabilities = {};
  for (const [rawKey, enabled] of Object.entries(capabilities || {})) {
    const canonical = normalizeDiagnosticFeatureKeys([rawKey])[0] || String(rawKey || '');
    if (canonical) normalizedCapabilities[canonical] = enabled;
  }
  const profile = {
    profileVersion: 1,
    appVersion:String(appVersion || 'unknown').slice(0,120),
    generatedAt:new Date().toISOString(),
    roleCount:roleEntries.length,
    roleRoster:roleEntries,
    teamCounts,
    teamLabels:{...teamLabels},
    winConditions:[...new Set((winConditions || []).map(String))],
    mechanics:{
      implementedKeys:systemFeatures,
      implementedLabels:featureLabels(systemFeatures),
      enabledKeys:systemFeatures,
      enabledLabels:featureLabels(systemFeatures),
      roleFeatureCoverage,
      rolesByTeam,
    },
    room:{
      settingKeys:normalizeDiagnosticFeatureKeys(roomSettings),
      testerFeatures:normalizeDiagnosticFeatureKeys(['tester_conditions','session_isolation']).filter((k)=>systemFeatures.includes(k)),
      revealDeadRoleSupported:systemFeatures.includes('reveal_dead_role'),
      revealDeadRoleEditableBeforeStart:systemFeatures.includes('reveal_dead_role') && systemFeatures.includes('phase_locks'),
    },
    actionRegistry:{
      socketEventCount:socketEvents.length,
      socketEvents,
      httpRouteCount:httpRoutes.length,
      httpRoutes,
      hash:stableHash({socketEvents,httpRoutes}),
    },
    capabilities:{
      reset_state_fanout:false, runtime_game_snapshot:false, event_time_game_profile:true,
      screenshot_no_preview:false, screenshot_multisize:false, screenshot_current_viewport:false,
      github_batch_submit:false, github_dedupe:false, incident_consolidation:false, causal_graph:false,
      ...normalizedCapabilities,
    },
    replay:{
      scenarioCount:Array.isArray(replayScenarios) ? replayScenarios.length : 0,
      featureCoverage:replayFeatureCoverage,
    },
    currentMechanics:{
      implementedCount:systemFeatures.length,
      implementedKeys:systemFeatures,
      implementedLabels:featureLabels(systemFeatures),
    },
    taxonomy:{ version:Number(taxonomyVersion)||DIAGNOSTIC_FEATURE_TAXONOMY_VERSION, labels:FEATURE_LABELS },
    runtime:runtimeSnapshot || null,
  };
  profile.featureSetHash = stableHash({
    roleRoster:profile.roleRoster,
    teamCounts:profile.teamCounts,
    winConditions:profile.winConditions,
    enabledKeys:profile.mechanics.enabledKeys,
    actionRegistry:profile.actionRegistry.hash,
    rolesByTeam:profile.mechanics.rolesByTeam,
    room:profile.room,
    capabilities:profile.capabilities,
  });
  return profile;
}

module.exports = {
  DIAGNOSTIC_FEATURE_TAXONOMY_VERSION,
  FEATURE_LABELS,
  normalizeDiagnosticFeatureKeys,
  featureAreaLabel,
  featureLabels,
  stableHash,
  roleMechanicKey,
  buildGameDiagnosticProfile,
};
