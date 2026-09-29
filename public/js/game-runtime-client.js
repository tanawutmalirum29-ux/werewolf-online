/*
 * WEREWOLF GAME RUNTIME CLIENT v20260926-7
 * Shared client-side state/action feedback for Player + Host.
 * Keeps connection UX, stateVersion tracking, action acknowledgements, timeline rendering,
 * and spectator rendering in one small module so page-specific game rules remain untouched.
 */
(function () {
    "use strict";

    const DEFAULT_TIMEOUT_MS = 8000;
    const ACTION_EVENTS = new Set([
        "cast_vote", "cast_wolf_kill", "select_target", "scout_target", "detective_scout",
        "cast_witch_poison", "cast_murderer_kill", "cast_instigator_kill", "cast_bandit_kill",
        "start_game", "restart_room", "confirm_continue", "update_room_settings", "host_add_bot",
        "toggle_state", "toggle_vote_mode", "resolve_night", "start_night", "kick_player",
        "toggle_bot_ai", "toggle_bot_llm_mode", "update_config", "create_room", "join_room",
        "select_shield", "select_curse_target", "cupid_pair", "instigator_pair", "cult_action",
        "bandit_action", "give_up_oracle_sense", "reveal_mayor", "fire_sheriff_gun",
        "sheriff_peek_target", "cast_priest_holy_water", "illusion_kill_disguised",
        "set_all_win_conditions", "toggle_win_condition", "toggle_vote_timer", "force_vote_all",
        "close_room", "host_clear_kill_target", "host_aim_kill"
    ]);

    const LABELS = {
        cast_vote: "โหวต",
        cast_wolf_kill: "เลือกเป้าหมาย",
        select_target: "เลือกเป้าหมาย",
        scout_target: "ส่องเป้าหมาย",
        detective_scout: "ตรวจสอบเป้าหมาย",
        cast_witch_poison: "ใช้ยาพิษ",
        cast_murderer_kill: "เลือกเป้าฆ่า",
        cast_instigator_kill: "เลือกเป้าฆ่า",
        cast_bandit_kill: "เลือกเป้าฆ่าทีมโจร",
        start_game: "เริ่มเกม",
        restart_room: "เริ่มห้องใหม่",
        confirm_continue: "ดำเนินการต่อ",
        update_room_settings: "บันทึกการตั้งค่า",
        host_add_bot: "เพิ่มบอท",
        toggle_state: "อัปเดตสถานะ",
        toggle_vote_mode: "โหมดโหวต",
        resolve_night: "สรุปผล",
        start_night: "เริ่มคืน",
        kick_player: "เตะผู้เล่น",
        toggle_bot_ai: "สลับ AI บอท",
        toggle_bot_llm_mode: "สลับ LLM บอท",
        update_config: "อัปเดตบทบาท",
        create_room: "สร้างห้อง",
        join_room: "เข้าห้อง",
        select_shield: "วางโล่",
        select_curse_target: "เลือกเป้าคำสาป",
        cupid_pair: "จับคู่กามเทพ",
        instigator_pair: "จับคู่ผู้ยุยง",
        cult_action: "ดำเนินการลัทธิ",
        bandit_action: "ดำเนินการโจร",
        give_up_oracle_sense: "สละลางสังหรณ์",
        reveal_mayor: "เปิดเผยนายก",
        fire_sheriff_gun: "ยิงปืนศาลเตี้ย",
        sheriff_peek_target: "ดูบทเป้าหมาย",
        cast_priest_holy_water: "ใช้น้ำมนต์",
        illusion_kill_disguised: "ฆ่าเป้าปลอมบท",
        set_all_win_conditions: "เปลี่ยนเงื่อนไขชนะทั้งหมด",
        toggle_win_condition: "เปลี่ยนเงื่อนไขชนะ",
        toggle_vote_timer: "จับเวลาโหวต",
        force_vote_all: "บังคับโหวตทั้งหมด",
        close_room: "ปิดห้อง",
        host_clear_kill_target: "ล้างเป้าฆ่า",
        host_aim_kill: "เล็งฆ่า",
    };

    const TIMELINE_LABELS = {
        room_created: ["🏠", "สร้างห้อง"],
        settings_changed: ["⚙️", "เปลี่ยนการตั้งค่า"],
        player_joined: ["👤", "ผู้เล่นเข้าร่วม"],
        player_left: ["🚪", "ผู้เล่นออก"],
        game_started: ["🎬", "เริ่มเกม"],
        phase_started: ["⏱️", "เริ่มช่วงเกม"],
        vote_started: ["🗳️", "เริ่มโหวต"],
        vote_resolved: ["⚖️", "สรุปผลโหวต"],
        player_died: ["💀", "มีผู้เล่นเสียชีวิต"],
        continue_confirmed: ["✅", "ยืนยันดำเนินการต่อ"],
        game_ended: ["🏁", "จบเกม"],
        room_reset: ["🔄", "รีเซ็ตห้อง"],
        room_closed: ["🔒", "ปิดห้อง"],
        state_changed: ["•", "อัปเดตสถานะ"],
    };

    function safeText(value, fallback = "") {
        const text = String(value ?? fallback);
        return text.length > 240 ? `${text.slice(0, 237)}...` : text;
    }

    function escapeHtml(value) {
        return safeText(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function formatTimelineTime(at) {
        if (!Number(at)) return "--:--:--";
        try {
            return new Date(Number(at)).toLocaleTimeString("th-TH", {
                hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
            });
        } catch (_) {
            return "--:--:--";
        }
    }

    function renderTimeline(target, timeline, { compact = false } = {}) {
        const el = typeof target === "string" ? document.getElementById(target) : target;
        if (!el) return;
        const items = Array.isArray(timeline) ? timeline.slice(-16) : [];
        if (!items.length) {
            el.innerHTML = '<div class="runtime-empty-note">ยังไม่มีเหตุการณ์สำคัญในรอบนี้</div>';
            return;
        }
        el.innerHTML = items.slice().reverse().map((entry) => {
            const [icon, label] = TIMELINE_LABELS[entry?.type] || TIMELINE_LABELS.state_changed;
            const detail = entry?.label || entry?.reason || "";
            const version = Number(entry?.stateVersion || 0);
            return `<div class="runtime-timeline-item${compact ? " compact" : ""}">
                <span class="runtime-timeline-icon">${icon}</span>
                <div class="runtime-timeline-copy">
                    <div class="runtime-timeline-main"><b>${escapeHtml(label)}</b>${version ? `<span class="runtime-state-version">v${version}</span>` : ""}</div>
                    ${detail ? `<div class="runtime-timeline-detail">${escapeHtml(detail)}</div>` : ""}
                </div>
                <time>${escapeHtml(formatTimelineTime(entry?.at))}</time>
            </div>`;
        }).join("");
    }

    function ensureRuntimeCard(id, html, parentSelector) {
        let card = document.getElementById(id);
        if (card) return card;
        const parent = document.querySelector(parentSelector);
        if (!parent) return null;
        card = document.createElement("div");
        card.id = id;
        card.className = "card runtime-card";
        card.innerHTML = html;
        parent.appendChild(card);
        return card;
    }

    function renderSpectator(room, player, targetId = "spectatorCard") {
        const card = document.getElementById(targetId);
        if (!card) return;
        const shouldShow = !!room?.started && !room?.gameOver && !!player && !player.isHost && player.alive === false;
        card.classList.toggle("hidden", !shouldShow);
        if (!shouldShow) return;
        const players = Array.isArray(room?.players) ? room.players.filter((p) => !p?.isHost) : [];
        const alive = players.filter((p) => p?.alive !== false).length;
        const total = players.length;
        const recent = Array.isArray(room?.timeline) ? room.timeline.slice(-3).reverse() : [];
        const latest = recent.map((entry) => {
            const [icon, label] = TIMELINE_LABELS[entry?.type] || TIMELINE_LABELS.state_changed;
            return `<span>${icon} ${escapeHtml(label)}</span>`;
        }).join(" · ");
        card.innerHTML = `<div class="runtime-card-head">
            <div><span class="runtime-kicker">SPECTATOR</span><h3>👻 คุณเสียชีวิตแล้ว</h3></div>
            <span class="runtime-spectator-badge">ผู้ชม</span>
        </div>
        <p class="runtime-spectator-copy">คุณยังติดตามเกมต่อได้ แต่ไม่สามารถใช้ความสามารถหรือโหวตในเกมนี้</p>
        <div class="runtime-spectator-stats">
            <span><b>${alive}</b><small>มีชีวิต</small></span>
            <span><b>${total}</b><small>ผู้เล่น</small></span>
            <span><b>${room?.isNight ? "🌙" : "☀️"}</b><small>${room?.isNight ? "กลางคืน" : room?.voteMode ? "โหวต" : "กลางวัน"}</small></span>
        </div>
        ${latest ? `<div class="runtime-spectator-latest">${latest}</div>` : ""}`;
    }

    function attach(socket, options = {}) {
        if (!socket || socket.__wwRuntimeClientAttached) return socket?.__wwRuntimeClientController || null;
        const page = String(options.page || document.body?.dataset?.page || "game");
        const getRoom = typeof options.getRoom === "function" ? options.getRoom : () => null;
        const getPlayer = typeof options.getPlayer === "function" ? options.getPlayer : () => null;
        const banner = document.getElementById(options.connectionBannerId || "connBanner");
        const actionStatus = document.getElementById(options.actionStatusId || "gameActionStatus");
        const pending = new Map();
        let lastStateVersion = Number(getRoom()?.stateVersion || 0);
        let actionSeq = 0;
        const originalEmit = socket.emit.bind(socket);

        function setBanner(mode, text) {
            if (!banner) return;
            banner.classList.remove("hidden", "runtime-connected", "runtime-syncing", "runtime-error");
            banner.classList.toggle("runtime-connected", mode === "connected");
            banner.classList.toggle("runtime-syncing", mode === "syncing");
            banner.classList.toggle("runtime-error", mode === "error");
            banner.textContent = text;
            if (mode === "connected") {
                setTimeout(() => banner.classList.add("hidden"), 900);
            }
        }

        function setActionStatus(mode, text) {
            if (!actionStatus) return;
            actionStatus.className = `runtime-action-status ${mode}`;
            actionStatus.textContent = text;
            actionStatus.classList.remove("hidden");
            if (mode === "success" || mode === "error") {
                const stamp = Date.now();
                actionStatus.dataset.runtimeStamp = String(stamp);
                setTimeout(() => {
                    if (actionStatus.dataset.runtimeStamp === String(stamp)) actionStatus.classList.add("hidden");
                }, 2600);
            }
        }

        function finishPending(item, ok, result = {}) {
            if (!item || item.done) return;
            item.done = true;
            pending.delete(item.id);
            if (ok) setActionStatus("success", `✓ ${item.label} สำเร็จ`);
            else {
                const code = result?.code || result?.error || "ACTION_REJECTED";
                setActionStatus("error", `✕ ${item.label} ไม่สำเร็จ · ${safeText(code)}`);
            }
        }

        function observeAction(eventName, callback, args) {
            const item = {
                id: `${page}-${++actionSeq}-${Date.now().toString(36)}`,
                eventName,
                label: LABELS[eventName] || eventName,
                startedAt: Date.now(),
                stateBefore: lastStateVersion,
                hasCallback: typeof callback === "function",
                done: false,
            };
            pending.set(item.id, item);
            setActionStatus("pending", `⏳ ${item.label} กำลังดำเนินการ...`);
            const timeout = setTimeout(() => {
                if (!item.done) finishPending(item, false, { code: "ACTION_TIMEOUT" });
            }, Number(options.actionTimeoutMs) || DEFAULT_TIMEOUT_MS);

            if (typeof callback === "function") {
                const wrapped = function (result) {
                    clearTimeout(timeout);
                    const ok = result === undefined || result === null || result?.ok === true;
                    finishPending(item, ok, result || {});
                    return callback.apply(this, arguments);
                };
                return { item, wrapped };
            }
            return { item, wrapped: null };
        }

        socket.emit = function (eventName, ...args) {
            if (!ACTION_EVENTS.has(eventName)) return originalEmit(eventName, ...args);
            const last = args[args.length - 1];
            const hasCallback = typeof last === "function";
            const callback = hasCallback ? last : null;
            if (hasCallback) args.pop();
            const observed = observeAction(eventName, callback, args);
            if (observed.wrapped) args.push(observed.wrapped);
            return originalEmit(eventName, ...args);
        };

        const onDisconnect = () => {
            setBanner("syncing", "🔄 การเชื่อมต่อขาดหาย · กำลังเชื่อมต่อใหม่...");
        };
        const onConnectError = (err) => {
            setBanner("error", `⚠️ เชื่อมต่อเซิร์ฟเวอร์ไม่ได้${err?.message ? ` · ${safeText(err.message, "")}` : ""}`);
        };
        const onConnect = () => {
            setBanner("syncing", "✓ เชื่อมต่อแล้ว · กำลังซิงค์สถานะเกม...");
        };
        const onRoomUpdate = (room) => {
            const version = Number(room?.stateVersion || 0);
            if (version > lastStateVersion) {
                lastStateVersion = version;
                [...pending.values()].forEach((item) => {
                    if (!item.hasCallback && item.stateBefore < version) {
                        finishPending(item, true, { ok: true, stateVersion: version });
                    }
                });
            } else if (version > 0) {
                lastStateVersion = Math.max(lastStateVersion, version);
            }
            if (socket.connected && (getRoom()?.roomId || room?.roomId)) {
                setBanner("connected", "✓ ซิงค์สถานะเกมแล้ว");
            }
        };

        socket.on("disconnect", onDisconnect);
        socket.on("connect_error", onConnectError);
        socket.on("connect", onConnect);
        socket.on("room_update", onRoomUpdate);

        if (lastStateVersion > 0) setActionStatus("info", `สถานะห้อง v${lastStateVersion}`);

        const controller = {
            getStateVersion: () => lastStateVersion || Number(getRoom()?.stateVersion || 0),
            setStateVersion: (value) => { lastStateVersion = Number(value) || lastStateVersion; },
            setConnectionMessage: setBanner,
            setActionStatus,
            renderTimeline,
            renderSpectator,
            destroy() {
                socket.emit = originalEmit;
                socket.off("disconnect", onDisconnect);
                socket.off("connect_error", onConnectError);
                socket.off("connect", onConnect);
                socket.off("room_update", onRoomUpdate);
                pending.clear();
                socket.__wwRuntimeClientAttached = false;
                socket.__wwRuntimeClientController = null;
            },
        };
        socket.__wwRuntimeClientAttached = true;
        socket.__wwRuntimeClientController = controller;
        return controller;
    }

    window.WWGameRuntime = { attach, renderTimeline, renderSpectator, labels: LABELS };
})();
