const fs = require('fs');
const assert = require('assert');

const server = fs.readFileSync('server.js', 'utf8');
const eventNames = [...server.matchAll(/socket\.on\((['"])([^'"]+)\1\s*,/g)].map((m) => m[2]);
const unique = [...new Set(eventNames)];
assert(unique.length >= 40, `expected broad socket action coverage, got ${unique.length}`);

const expected = [
  'create_room','join_room','start_game','start_night','resolve_night','cast_vote','send_chat',
  'host_chat','select_target','select_shield','cast_wolf_kill','cast_murderer_kill','cast_bandit_kill',
  'cast_instigator_kill','cast_witch_poison','cast_priest_holy_water','fire_sheriff_gun','reveal_mayor',
  'player_resume_status','abandon_game','request_sync','restart_room','close_room','update_room_settings',
  'host_add_bot','release_bot','toggle_bot_ai','toggle_bot_llm_mode','admin_list_rooms','admin_list_accounts'
];
for (const event of expected) assert(unique.includes(event), `missing socket action handler: ${event}`);
assert(server.includes('const operationId = makeDiagnosticId("sockop")'), 'socket action replay must have operation correlation ids');
assert(server.includes('handler.start:${event}'), 'socket actions must record handler start breadcrumbs');
assert(server.includes('ack:${event}'), 'socket actions must record ACK breadcrumbs');

console.log(`bug-replay event coverage regression: PASS (${unique.length} socket actions audited)`);
