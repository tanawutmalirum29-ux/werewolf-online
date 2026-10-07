(() => {
    'use strict';
    const page = document.body.dataset.page;
    const awsMode = window.WEREWOLF_CONFIG?.mode === 'aws';
    const $ = id => document.getElementById(id);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const team = value => ({ wolf:'ฝ่ายหมาป่า', villager:'ฝ่ายชาวบ้าน', solo:'ฝ่ายเดี่ยว', bandit:'ฝ่ายโจร', cult:'ฝ่ายลัทธิ' }[value] || 'ใช้กติกาที่โฮสต์ประกาศ');
    const key = `ww_basic_${page}`;
    const invited = new URLSearchParams(location.search).get('room')?.trim().toUpperCase() || '';
    let session = null, state = null, roles = [], socket, busy = false, cardShown = false, cardIdentity = '';
    try { session = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) {}
    if (session && (session.kind !== page || (page === 'player' && invited && session.roomId !== invited))) session = null;
    if (page === 'player') $('roomInput').value = invited || session?.roomId || '';
    if (session?.name) $('name').value = session.name;

    function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
    function remember(data) {
        session = data;
        try { if (data) sessionStorage.setItem(key, JSON.stringify(data)); else sessionStorage.removeItem(key); }
        catch (_) { notice('เบราว์เซอร์นี้ไม่เก็บข้อมูลแท็บ อย่ารีเฟรชระหว่างเล่น'); }
    }
    function entry(message = '') {
        remember(null); state = null; cardShown = false; cardIdentity = '';
        $('room').hidden = true; $('entry').hidden = false; notice(message);
    }
    function connection() {
        $('connection').textContent = socket?.connected ? '● เชื่อมต่อแล้ว' : '○ กำลังเชื่อมต่อใหม่…';
        $('submit').disabled = !socket?.connected || busy || !roles.length;
    }
    function ask(event, data = {}) {
        return new Promise((resolve, reject) => {
            if (!socket.connected) return reject(new Error('ยังไม่เชื่อมต่อ รอสักครู่แล้วลองใหม่'));
            socket.timeout(awsMode ? 15000 : 8000).emit(event, data, (timeout, reply) => {
                if (timeout) return reject(Object.assign(new Error('คำขอหมดเวลา ลองใหม่อีกครั้ง'), { timeout: true }));
                if (!reply?.ok) return reject(new Error(reply?.error || 'ทำรายการไม่สำเร็จ'));
                resolve(reply);
            });
        });
    }
    async function task(action) {
        if (busy) return;
        busy = true; connection(); notice();
        try { await action(); } catch (error) { notice(error.message); }
        finally { busy = false; connection(); if (state) { if (page === 'host') renderHost(); else renderPlayer(); } }
    }
    function status(player) {
        return `<span class="status ${!player.alive ? 'dead' : !player.connected ? 'offline' : ''}">${!player.alive ? 'เสียชีวิต' : player.connected ? 'ออนไลน์' : 'ออฟไลน์'}</span>`;
    }
    function phaseText(room) {
        if (room.phase === 'lobby') return 'รอแจกการ์ด';
        if (room.phase === 'ended') return `จบเกม · ${room.winner}`;
        return `${room.phase === 'night' ? '🌙 กลางคืน' : '☀️ กลางวัน'} · รอบ ${room.round}`;
    }
    function receive(room) {
        state = room; $('entry').hidden = true; $('room').hidden = false;
        $('roomCode').textContent = room.id;
        $('roomStatus').textContent = `${phaseText(room)} · โฮสต์ ${room.hostName}`;
        if (page === 'host') renderHost(); else renderPlayer();
    }
    function renderHost() {
        const lobby = state.phase === 'lobby', ended = state.phase === 'ended', reveal = $('hostReveal').checked;
        $('playerCount').textContent = `(${state.players.length})`;
        $('lobbyControls').hidden = !lobby; $('gameControls').hidden = lobby;
        $('players').innerHTML = state.players.length ? state.players.map(player => `<article class="player-row"><div class="player-main"><span class="player-name">${esc(player.name)}</span>${status(player)}</div>
            <p class="player-role">${reveal ? esc(player.role || 'ยังไม่ได้แจกการ์ด') : 'ซ่อนบทบาทแล้ว'}</p><div class="player-controls">
            <label><input type="checkbox" data-field="alive" data-player="${player.id}" ${player.alive ? 'checked' : ''}>มีชีวิต</label>
            ${!lobby ? `<label><input type="checkbox" data-field="protected" data-player="${player.id}" ${player.protected ? 'checked' : ''}>ป้องกัน</label><label><input type="checkbox" data-field="killed" data-player="${player.id}" ${player.killed ? 'checked' : ''}>ถูกเล็ง</label>` : ''}
            ${!lobby && !ended && reveal ? `<select data-change-role="${player.id}" aria-label="เปลี่ยนบทบาทของ ${esc(player.name)}">${roles.map(role => `<option value="${esc(role.id)}" ${player.role === role.id ? 'selected' : ''}>${esc(role.id)}</option>`).join('')}</select>` : ''}
            <button data-remove="${player.id}" class="danger">นำออก</button></div></article>`).join('') : '<p class="empty">ยังไม่มีผู้เล่น ส่งลิงก์ให้เพื่อนเข้าห้องก่อน</p>';
        const selected = Object.values(state.config).reduce((sum, count) => sum + count, 0);
        const extra = Math.max(0, state.players.length - selected);
        $('deckSummary').textContent = `ผู้เล่น ${state.players.length} คน · เลือกการ์ด ${selected} ใบ · เติมชาวบ้าน ${extra} ใบ${selected > state.players.length ? ' — การ์ดเกิน ลดจำนวนก่อนแจก' : ''}`;
        $('deal').disabled = !lobby || !state.players.length || selected > state.players.length || state.players.some(player => !player.connected);
        document.querySelectorAll('[data-phase]').forEach(button => {
            button.classList.toggle('active', state.phase === button.dataset.phase); button.disabled = ended || state.phase === button.dataset.phase;
        });
        $('endGame').disabled = ended;
        renderRoles();
    }
    function renderRoles() {
        const search = $('roleSearch').value.trim();
        const visible = roles.filter(role => role.id.includes(search));
        $('roleEditor').innerHTML = visible.length ? visible.map(role => `<div class="role-row"><span>${esc(role.title)}</span><div class="counter"><button data-role="${esc(role.id)}" data-delta="-1" aria-label="ลด ${esc(role.id)}" ${!state.config[role.id] ? 'disabled' : ''}>−</button><b>${state.config[role.id]}</b><button data-role="${esc(role.id)}" data-delta="1" aria-label="เพิ่ม ${esc(role.id)}">+</button></div></div>`).join('') : '<p class="empty">ไม่พบบทบาท</p>';
    }
    function renderPlayer() {
        $('myName').textContent = state.self.name;
        $('myStatus').textContent = state.self.alive ? 'คุณยังมีชีวิตอยู่' : 'คุณเสียชีวิตแล้ว รอฟังโฮสต์และชมเกมต่อได้';
        $('hostPresence').textContent = state.hostConnected ? 'โฮสต์อยู่ในห้อง' : 'โฮสต์ออฟไลน์ รอโฮสต์กลับมาคุมเกม';
        $('roster').innerHTML = state.players.map(player => `<article class="player-row"><div class="player-main"><span class="player-name">${esc(player.name)}${player.id === state.self.id ? ' · คุณ' : ''}</span>${status(player)}</div>${state.phase === 'ended' ? `<div class="player-role">${esc(player.role || 'ไม่มีการ์ด')}</div>` : ''}</article>`).join('');
        const card = state.self.card;
        $('waiting').hidden = !!card; $('secret').hidden = !card;
        $('leaveRoom').disabled = !['lobby', 'ended'].includes(state.phase);
        if (!card) { cardIdentity = ''; cardShown = false; return; }
        const identity = `${state.id}:${card.id}`;
        if (identity !== cardIdentity) { cardIdentity = identity; cardShown = false; }
        $('roleTitle').textContent = card.title; $('roleDescription').textContent = card.description; $('roleTeam').textContent = team(card.team);
        if ($('roleImage').getAttribute('src') !== card.icon) {
            $('roleImage').hidden = false; $('roleFallback').hidden = true;
            $('roleImage').src = card.icon; $('roleImage').alt = card.id;
        }
        showCard();
    }
    function showCard() {
        $('roleCard').hidden = !cardShown; $('cardCover').hidden = cardShown;
        $('toggleCard').textContent = cardShown ? 'ซ่อนการ์ด' : 'เปิดดูการ์ดของฉัน';
    }
    $('entryForm').addEventListener('submit', event => {
        event.preventDefault(); task(async () => {
            const name = $('name').value.trim();
            const reply = await ask(page === 'host' ? 'room:create' : 'room:join', { name, roomId: page === 'player' ? $('roomInput').value.trim().toUpperCase() : undefined });
            remember({ kind: page, name, roomId: reply.roomId, token: reply.token, hostFingerprint:reply.hostFingerprint }); receive(reply.state);
        });
    });
    if (page === 'host') {
        $('hostReveal').addEventListener('change', () => state && renderHost());
        $('roleSearch').addEventListener('input', () => state && renderRoles());
        $('copyInvite').addEventListener('click', () => task(async () => {
            const invite = new URL(`/player.html?room=${state.id}`, location.origin);
            if (socket.inviteFragment) invite.hash = socket.inviteFragment;
            const link = invite.href;
            try { await navigator.clipboard.writeText(link); notice('คัดลอกลิงก์แล้ว ส่งให้เพื่อนได้เลย'); }
            catch (_) { notice(`ลิงก์ชวนเพื่อน: ${link}`); }
        }));
        $('closeRoom').addEventListener('click', () => { if (confirm('ปิดห้องนี้และนำทุกคนออก?')) task(() => ask('host:close')); });
        $('deal').addEventListener('click', () => task(() => ask('host:deal')));
        $('backLobby').addEventListener('click', () => { if (confirm('ล้างการ์ดและสถานะ เพื่อกลับไปตั้งรอบใหม่?')) task(() => ask('host:lobby')); });
        $('endGame').addEventListener('click', () => { if (confirm('จบเกมและเปิดเผยบทบาททุกคน?')) task(() => ask('host:phase', { phase:'ended', winner:$('winner').value })); });
        document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => task(() => ask('host:phase', { phase:button.dataset.phase }))));
        $('roleEditor').addEventListener('click', event => {
            const button = event.target.closest('[data-role]'); if (!button || button.disabled || !state) return;
            task(() => ask('host:config', { config: { ...state.config, [button.dataset.role]:state.config[button.dataset.role] + Number(button.dataset.delta) } }));
        });
        $('players').addEventListener('change', event => {
            const target = event.target;
            if (target.dataset.field) task(() => ask('host:player', { playerId:target.dataset.player, [target.dataset.field]:target.checked }));
            if (target.dataset.changeRole) task(() => ask('host:player', { playerId:target.dataset.changeRole, role:target.value }));
        });
        $('players').addEventListener('click', event => {
            const button = event.target.closest('[data-remove]'); if (!button) return;
            const player = state.players.find(player => player.id === button.dataset.remove);
            if (confirm(`นำ ${player?.name || 'ผู้เล่น'} ออกจากห้อง?`)) task(() => ask('host:remove', { playerId:button.dataset.remove }));
        });
    } else {
        $('roleImage').addEventListener('error', () => { $('roleImage').hidden = true; $('roleFallback').hidden = false; });
        $('toggleCard').addEventListener('click', () => { cardShown = !cardShown; showCard(); });
        $('leaveRoom').addEventListener('click', () => { if (confirm('ออกจากห้องนี้?')) task(() => ask('player:leave')); });
        document.addEventListener('visibilitychange', () => { if (document.hidden && $('secret')) { cardShown = false; showCard(); } });
    }
    async function start() {
        try {
            if (awsMode) {
                if (!window.WEREWOLF_CONFIG.events) throw new Error('เว็บยังไม่พร้อมเล่น ให้เจ้าของเว็บตั้งค่า AppSync ตามคู่มือ deploy');
                roles = window.WEREWOLF_ROLES;
            } else {
                const response = await fetch('/api/roles'); if (!response.ok) throw new Error('โหลดบทบาทไม่สำเร็จ รีเฟรชเพื่อลองใหม่');
                roles = await response.json();
            }
            socket = io(undefined, { autoConnect:false });
            socket.on('connect', async () => {
                connection();
                if (!session) return;
                try { const reply = await ask('room:resume', session); receive(reply.state); notice(); }
                catch (error) { if (error.timeout) notice(error.message); else entry(error.message); }
            });
            socket.on('disconnect', () => { connection(); if (state) notice('ขาดการเชื่อมต่อ กำลังกลับเข้าห้อง…'); });
            socket.on('connect_error', error => { connection(); notice(awsMode ? error.message : 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กำลังลองใหม่'); });
            socket.on('room:state', receive);
            socket.on('room:closed', data => entry(data.message));
            socket.on('room:removed', data => entry(data.message));
            socket.on('room:left', () => entry('ออกจากห้องแล้ว'));
            socket.connect();
        } catch (error) { notice(error.message); }
    }
    if (awsMode && page === 'host') window.addEventListener('beforeunload', event => {
        if (state) { event.preventDefault(); event.returnValue = ''; }
    });
    window.addEventListener('pagehide', () => socket?.disconnect());
    window.addEventListener('pageshow', event => { if (event.persisted) socket?.connect(); });
    start();
})();
