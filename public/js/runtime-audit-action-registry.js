(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.WWRuntimeAuditActionRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const PAGE_META = {
        index: { label: 'Index / Lobby', actors: ['player', 'host'] },
        player: { label: 'Player', actors: ['player'] },
        host: { label: 'Host', actors: ['host'] },
        admin: { label: 'Admin', actors: ['admin'] },
        maintenance: { label: 'Maintenance', actors: ['system'] },
    };

    // Action records are intentionally declarative. Browser execution only uses the
    // selectors/verification contracts below. Destructive/game-changing actions stay
    // in the registry for coverage accounting but require an explicit test-mode runner.
    const ACTIONS = [
        // INDEX / LOBBY — safe UI probes
        { id:'index.name-input', page:'index', actor:'player', group:'identity', kind:'ui', mode:'safe', selector:'#displayNameInput', expected:{type:'actionable'} },
        { id:'index.open-profile', page:'index', actor:'player', group:'identity', kind:'ui', mode:'safe', selector:'#nameBadge', expected:{type:'visible'}, skipIf:{selector:'#nameBadge', visible:false}, cleanup:{selector:'.profile-modal-actions .modal-confirm', text:'ปิดโปรไฟล์'} },
        { id:'index.open-host', page:'index', actor:'host', group:'navigation', kind:'navigation', mode:'observe', selector:'.btn-host', expected:{type:'actionable'} },
        { id:'index.open-player', page:'index', actor:'player', group:'navigation', kind:'navigation', mode:'observe', selector:'.btn-player', expected:{type:'actionable'} },
        { id:'index.update-gate-button', page:'index', actor:'system', group:'recovery', kind:'ui', mode:'safe', selector:'#wwUpdateOverlay button', expected:{type:'actionable'}, skipIf:{selector:'#wwUpdateOverlay', visible:false} },

        { id:'index.join-room', page:'index', actor:'player', group:'room', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'join_room'} },
        { id:'index.list-open-rooms', page:'index', actor:'player', group:'room', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'list_open_rooms_players'} },
        { id:'index.presence-hello', page:'index', actor:'player', group:'identity', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'presence_hello'} },

        // PLAYER — actual non-destructive UI actions. Game/role mutations remain coverage-only.
        { id:'player.open-room-picker', page:'player', actor:'player', group:'room', kind:'ui', mode:'safe', selector:'#playerRoomPickerTrigger', expected:{type:'visible', selector:'#playerRoomPickerOverlay'}, cleanup:{selector:'#playerRoomPickerCloseBtn'} },
        { id:'player.refresh-room-list', page:'player', actor:'player', group:'room', kind:'socket', mode:'safe', selector:'#playerRoomRefreshBtn', expected:{type:'actionable', eventName:'list_open_rooms_players'} },
        { id:'player.filter-all', page:'player', actor:'player', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="all"]', expected:{type:'class', className:'active'} },
        { id:'player.filter-alive', page:'player', actor:'player', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="alive"]', expected:{type:'class', className:'active'} },
        { id:'player.filter-dead', page:'player', actor:'player', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="dead"]', expected:{type:'class', className:'active'} },
        { id:'player.filter-return-all', page:'player', actor:'player', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="all"]', expected:{type:'class', className:'active'} },
        { id:'player.chat-global-tab', page:'player', actor:'player', group:'chat', kind:'ui', mode:'safe', selector:'#tabGlobal', expected:{type:'class-or-aria', className:'active', ariaSelected:'true'} },
        { id:'player.open-role-popup', page:'player', actor:'player', group:'role', kind:'ui', mode:'safe', selector:'#maskBtn', expected:{type:'visible', selector:'#rolePopupOverlay'}, cleanup:{selector:'#rolePopupClose'} },
        { id:'player.join-empty-negative', page:'player', actor:'player', group:'validation', kind:'validation', mode:'negative', selector:'#joinBtn', expected:{type:'not-navigation', allowPathChanges:false} },
        { id:'player.select-target', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'select_target'} },
        { id:'player.cast-vote', page:'player', actor:'player', group:'vote', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cast_vote'} },
        { id:'player.cast-wolf-kill', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cast_wolf_kill'} },
        { id:'player.cast-murderer-kill', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cast_murderer_kill'} },
        { id:'player.cast-instigator-kill', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cast_instigator_kill'} },
        { id:'player.scout-target', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'scout_target'} },
        { id:'player.detective-scout', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'detective_scout'} },
        { id:'player.cupid-pair', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cupid_pair'} },
        { id:'player.instigator-pair', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'instigator_pair'} },
        { id:'player.select-shield', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'select_shield'} },
        { id:'player.select-curse-target', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'select_curse_target'} },
        { id:'player.cult-action', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cult_action'} },
        { id:'player.bandit-action', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'bandit_action'} },
        { id:'player.cast-bandit-kill', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cast_bandit_kill'} },
        { id:'player.fire-sheriff-gun', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'fire_sheriff_gun'} },
        { id:'player.sheriff-peek', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'sheriff_peek_target'} },
        { id:'player.illusion-kill', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'illusion_kill_disguised'} },
        { id:'player.priest-water', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cast_priest_holy_water'} },
        { id:'player.witch-poison', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'cast_witch_poison'} },
        { id:'player.reveal-mayor', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'reveal_mayor'} },
        { id:'player.oracle-give-up', page:'player', actor:'player', group:'role-action', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'give_up_oracle_sense'} },
        { id:'player.leave-room', page:'player', actor:'player', group:'room', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'leave_room'} },
        { id:'player.send-chat', page:'player', actor:'player', group:'chat', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'send_chat'} },
        { id:'player.reconnect-sync', page:'player', actor:'player', group:'recovery', kind:'socket', mode:'recovery', selector:'', expected:{type:'action-family', eventName:'request_sync'} },

        { id:'player.join-room', page:'player', actor:'player', group:'room', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'join_room'} },
        { id:'player.list-open-rooms', page:'player', actor:'player', group:'room', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'list_open_rooms_players'} },
        { id:'player.abandon-game', page:'player', actor:'player', group:'room', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'abandon_game'} },
        { id:'player.confirm-continue', page:'player', actor:'player', group:'game-lifecycle', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'confirm_continue'} },
        { id:'player.release-bot', page:'player', actor:'player', group:'tester', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'release_bot'} },
        { id:'player.resume-status', page:'player', actor:'player', group:'recovery', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'player_resume_status'} },
        { id:'player.presence-hello', page:'player', actor:'player', group:'identity', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'presence_hello'} },

        // HOST — actual non-destructive UI actions.
        { id:'host.open-room-settings', page:'host', actor:'host', group:'room-settings', kind:'ui', mode:'safe', selector:'#roomSettingsBtn', expected:{type:'visible', selector:'#roomSettingsOverlay'}, cleanup:{selector:'.vote-modal-close', text:'✕'} },
        { id:'host.collapse-role-card', page:'host', actor:'host', group:'layout', kind:'ui', mode:'safe', selector:'#roleCollapseBtn', expected:{type:'toggle'} },
        { id:'host.player-focus-mode', page:'host', actor:'host', group:'layout', kind:'ui', mode:'safe', selector:'#playerFocusBtn', expected:{type:'toggle'} },
        { id:'host.grid-cols-2', page:'host', actor:'host', group:'layout', kind:'ui', mode:'safe', selector:'.gridColsBtn[data-cols="2"]', expected:{type:'class', className:'active'} },
        { id:'host.grid-cols-4', page:'host', actor:'host', group:'layout', kind:'ui', mode:'safe', selector:'.gridColsBtn[data-cols="4"]', expected:{type:'class', className:'active'} },
        { id:'host.grid-cols-8', page:'host', actor:'host', group:'layout', kind:'ui', mode:'safe', selector:'.gridColsBtn[data-cols="8"]', expected:{type:'class', className:'active'} },
        { id:'host.view-grid', page:'host', actor:'host', group:'layout', kind:'ui', mode:'safe', selector:'#viewModeGridBtn', expected:{type:'class', className:'active'} },
        { id:'host.view-simple', page:'host', actor:'host', group:'layout', kind:'ui', mode:'safe', selector:'#viewModeSimpleBtn', expected:{type:'class', className:'active'} },
        { id:'host.filter-all', page:'host', actor:'host', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="all"]', expected:{type:'class', className:'active'} },
        { id:'host.filter-alive', page:'host', actor:'host', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="alive"]', expected:{type:'class', className:'active'} },
        { id:'host.filter-dead', page:'host', actor:'host', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="dead"]', expected:{type:'class', className:'active'} },
        { id:'host.filter-return-all', page:'host', actor:'host', group:'player-list', kind:'ui', mode:'safe', selector:'.filterChip[data-filter="all"]', expected:{type:'class', className:'active'} },
        { id:'host.chat-global', page:'host', actor:'host', group:'chat', kind:'ui', mode:'safe', selector:'#tabGlobal', expected:{type:'class-or-aria', className:'active-global', ariaPressed:'true'} },
        { id:'host.create-room', page:'host', actor:'host', group:'room-lifecycle', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'create_room'} },
        { id:'host.host-login', page:'host', actor:'host', group:'auth', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'host_login'} },
        { id:'host.start-game', page:'host', actor:'host', group:'game-lifecycle', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'start_game'} },
        { id:'host.update-room-settings', page:'host', actor:'host', group:'room-settings', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'update_room_settings'} },
        { id:'host.update-config', page:'host', actor:'host', group:'room-settings', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'update_config'} },
        { id:'host.host-chat', page:'host', actor:'host', group:'chat', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'host_chat'} },
        { id:'host.toggle-state', page:'host', actor:'host', group:'player-control', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'toggle_state'} },
        { id:'host.list-open-rooms', page:'host', actor:'host', group:'room', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'list_open_rooms'} },
        { id:'host.presence-hello', page:'host', actor:'host', group:'identity', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'presence_hello'} },
        { id:'host.set-all-win-conditions', page:'host', actor:'host', group:'game-rules', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'set_all_win_conditions'} },
        { id:'host.request-sync', page:'host', actor:'host', group:'recovery', kind:'socket', mode:'recovery', selector:'', expected:{type:'action-family', eventName:'request_sync'} },
        { id:'host.resolve-night', page:'host', actor:'host', group:'game-lifecycle', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'resolve_night'} },
        { id:'host.start-night', page:'host', actor:'host', group:'game-lifecycle', kind:'socket', mode:'simulation', selector:'', expected:{type:'action-family', eventName:'start_night'} },
        { id:'host.close-room', page:'host', actor:'host', group:'room-lifecycle', kind:'socket', mode:'destructive', selector:'', expected:{type:'action-family', eventName:'close_room'} },
        { id:'host.restart-room', page:'host', actor:'host', group:'room-lifecycle', kind:'socket', mode:'destructive', selector:'', expected:{type:'action-family', eventName:'restart_room'} },
        { id:'host.add-bot', page:'host', actor:'host', group:'players', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'host_add_bot'} },
        { id:'host.kick-player', page:'host', actor:'host', group:'players', kind:'socket', mode:'destructive', selector:'', expected:{type:'action-family', eventName:'kick_player'} },
        { id:'host.aim-kill', page:'host', actor:'host', group:'players', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'host_aim_kill'} },
        { id:'host.clear-kill-target', page:'host', actor:'host', group:'players', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'host_clear_kill_target'} },
        { id:'host.force-vote-all', page:'host', actor:'host', group:'vote', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'force_vote_all'} },
        { id:'host.toggle-vote-mode', page:'host', actor:'host', group:'vote', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'toggle_vote_mode'} },
        { id:'host.toggle-vote-timer', page:'host', actor:'host', group:'vote', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'toggle_vote_timer'} },
        { id:'host.win-conditions', page:'host', actor:'host', group:'game-rules', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'toggle_win_condition'} },
        { id:'host.bot-ai', page:'host', actor:'host', group:'bots', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'toggle_bot_ai'} },
        { id:'host.bot-llm-mode', page:'host', actor:'host', group:'bots', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'toggle_bot_llm_mode'} },

        // ADMIN — safe navigation / diagnostics probes plus coverage-only management actions.
        ...[
            ['overview','ภาพรวม'], ['all','ผู้เล่นทั้งหมด'], ['live','ออนไลน์'], ['rooms','ห้อง'], ['tools','Operations'], ['versions','เวอร์ชัน'], ['diagnostics','Diagnostics'], ['browser','แท็บภายใน']
        ].map(([tab, title]) => ({ id:`admin.nav.${tab}`, page:'admin', actor:'admin', group:'navigation', kind:'ui', mode:'safe', selector:`[data-admin-nav="${tab}"]`, expected:{type:'admin-panel', tab} })),
        { id:'admin.refresh-current', page:'admin', actor:'admin', group:'navigation', kind:'ui', mode:'safe', selector:'[data-shell-refresh-current]', expected:{type:'actionable'} },
        { id:'admin.open-player-detail', page:'admin', actor:'admin', group:'players', kind:'ui', mode:'safe', selector:'#allPlayersContent [data-account-id]', expected:{type:'actionable'} },
        { id:'admin.open-room-detail', page:'admin', actor:'admin', group:'rooms', kind:'ui', mode:'safe', selector:'#roomsContent [data-room-id]', expected:{type:'actionable'} },
        { id:'admin.runtime-audit-panel', page:'admin', actor:'admin', group:'diagnostics', kind:'ui', mode:'safe', selector:'#bugReplayAuditToggle', expected:{type:'toggle-panel'}, skipIf:{selector:'#bugReplayAudit', visible:false} },
        { id:'admin.open-internal-browser', page:'admin', actor:'admin', group:'browser', kind:'ui', mode:'safe', selector:'#adminBrowserNewTabBtn', expected:{type:'actionable'} },
        { id:'admin.embedded-admin', page:'admin', actor:'admin', group:'browser', kind:'iframe', mode:'observe', selector:'body[data-admin-embedded="1"]', expected:{type:'embedded-admin'} },
        { id:'admin.list-accounts', page:'admin', actor:'admin', group:'players', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'admin_list_accounts'} },
        { id:'admin.list-rooms-socket', page:'admin', actor:'admin', group:'rooms', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'admin_list_rooms'} },
        { id:'admin.get-room-detail', page:'admin', actor:'admin', group:'rooms', kind:'socket', mode:'observe', selector:'', expected:{type:'action-family', eventName:'admin_get_room_detail'} },
        { id:'admin.load-accounts', page:'admin', actor:'admin', group:'players', kind:'network', mode:'safe', selector:'#allPlayersContent', expected:{type:'exists'} },
        { id:'admin.list-rooms', page:'admin', actor:'admin', group:'rooms', kind:'network', mode:'safe', selector:'#roomsContent', expected:{type:'exists'} },
        { id:'admin.refresh-diagnostics', page:'admin', actor:'admin', group:'diagnostics', kind:'network', mode:'safe', selector:'[data-shell-command="diagnostics.refresh"]', expected:{type:'actionable'} },
        { id:'admin.rename-account', page:'admin', actor:'admin', group:'players', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'admin_rename_account'} },
        { id:'admin.kick-account', page:'admin', actor:'admin', group:'players', kind:'socket', mode:'destructive', selector:'', expected:{type:'action-family', eventName:'admin_kick_account'} },
        { id:'admin.set-account-status', page:'admin', actor:'admin', group:'players', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'admin_set_account_status'} },
        { id:'admin.reset-account-stats', page:'admin', actor:'admin', group:'players', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'admin_reset_account_stats'} },
        { id:'admin.migrate-legacy-player', page:'admin', actor:'admin', group:'players', kind:'socket', mode:'mutating', selector:'', expected:{type:'action-family', eventName:'admin_migrate_legacy_player'} },
        { id:'admin.delete-legacy-player', page:'admin', actor:'admin', group:'players', kind:'socket', mode:'destructive', selector:'', expected:{type:'action-family', eventName:'admin_delete_legacy_player'} },
        { id:'admin.close-room', page:'admin', actor:'admin', group:'rooms', kind:'socket', mode:'destructive', selector:'', expected:{type:'action-family', eventName:'admin_close_room'} },
        { id:'admin.server-control', page:'admin', actor:'admin', group:'operations', kind:'network', mode:'destructive', selector:'', expected:{type:'action-family', eventName:'server_control'} },

        // SYSTEM / MAINTENANCE
        { id:'maintenance.config-poll', page:'maintenance', actor:'system', group:'recovery', kind:'network', mode:'safe', selector:'body', expected:{type:'exists'} },
        { id:'maintenance.roles-load', page:'maintenance', actor:'system', group:'content', kind:'network', mode:'safe', selector:'#rolesBox', expected:{type:'exists'} },
    ];

    const ACTION_BY_ID = new Map(ACTIONS.map((action) => [action.id, Object.freeze({ ...action })]));

    function all() { return ACTIONS.map((action) => ({ ...action })); }
    function find(id) { return ACTION_BY_ID.get(String(id || '')) || null; }
    function forPage(page) { return ACTIONS.filter((action) => action.page === String(page || '')).map((action) => ({ ...action })); }
    function executable(page, includeNonSafe) {
        return forPage(page).filter((action) => includeNonSafe || action.mode === 'safe');
    }
    function coverage() {
        const pages = {};
        const actors = {};
        const modes = {};
        ACTIONS.forEach((action) => {
            pages[action.page] = (pages[action.page] || 0) + 1;
            actors[action.actor] = (actors[action.actor] || 0) + 1;
            modes[action.mode] = (modes[action.mode] || 0) + 1;
        });
        return { total:ACTIONS.length, pages, actors, modes, pageMeta:{...PAGE_META} };
    }
    return { all, find, forPage, executable, coverage, pageMeta: PAGE_META };
});
