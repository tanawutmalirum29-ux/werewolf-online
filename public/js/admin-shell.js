/*
 * Admin Control Center Shell — Phase 1
 * Owns navigation chrome, responsive shell behavior, command palette and
 * contextual quick actions. Existing Admin API/auth/business handlers remain
 * the source of truth; this layer delegates to them instead of replacing them.
 */
(function(){
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    selected: null,
    status: {server:"—", rooms:"—", players:"—", audit:"—"},
    recent: [],
    activeTab: "overview",
    paletteIndex: 0,
    commands: [],
    restoreFocus: null,
    pinned: [],
  };
  const RECENT_LIMIT = 8;
  const PINNED_KEY = "ww_admin_pinned_commands_v1";
  function loadPinned(){
    try {
      const raw = JSON.parse(localStorage.getItem(PINNED_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter(Boolean).slice(0, 12) : [];
    } catch (_) { return []; }
  }
  function savePinned(){ try { localStorage.setItem(PINNED_KEY, JSON.stringify(state.pinned.slice(0, 12))); } catch (_) {} }
  function togglePinned(id){
    const key = String(id || ""); if (!key) return false;
    const i = state.pinned.indexOf(key);
    let pinned;
    if (i >= 0) { state.pinned.splice(i, 1); pinned = false; }
    else { state.pinned.unshift(key); pinned = true; }
    state.pinned = state.pinned.slice(0, 12); savePinned(); return pinned;
  }
  function syncPinButton(){
    const b = $("adminCommandPinBtn");
    const id = state.commands[state.paletteIndex]?.id;
    if (!b) return;
    b.disabled = !id;
    b.textContent = id && state.pinned.includes(id) ? "★ เอาออกจากปักหมุด" : "☆ ปักหมุดคำสั่ง";
  }

  function emit(type, detail = {}) {
    try { window.dispatchEvent(new CustomEvent("ww-admin-event", {detail:{...detail, type, eventType:type}})); } catch (_) {}
  }
  function escape(value) {
    return String(value ?? "").replace(/[&<>\"]/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
  }

  function buildPalette() {
    if ($("adminCommandPalette")) return;
    const p = document.createElement("div");
    p.id = "adminCommandPalette";
    p.className = "admin-shell-palette hidden";
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-modal", "true");
    p.setAttribute("aria-labelledby", "adminCommandTitle");
    p.innerHTML = `
      <div class="admin-shell-palette-backdrop" data-shell-close></div>
      <div class="admin-shell-palette-card" role="document">
        <div class="admin-shell-palette-head">
          <div>
            <div class="admin-shell-kicker">ADMIN COMMAND</div>
            <h2 id="adminCommandTitle">คำสั่งลัด</h2>
          </div>
          <button class="admin-shell-close" type="button" data-shell-close aria-label="ปิด">×</button>
        </div>
        <div class="admin-shell-palette-search">
          <span aria-hidden="true">⌕</span>
          <input id="adminCommandSearch" autocomplete="off" placeholder="ค้นหาผู้เล่น ห้อง reload bug หรือคำสั่งอื่น..." aria-label="ค้นหาคำสั่ง">
        </div>
        <div id="adminCommandList" class="admin-shell-command-list" role="listbox" aria-label="รายการคำสั่ง"></div>
        <div class="admin-shell-palette-hint"><button type="button" id="adminCommandPinBtn" class="admin-shell-pin-btn">☆ ปักหมุดคำสั่ง</button><span><kbd>↑</kbd><kbd>↓</kbd> เลือก · <kbd>Enter</kbd> เปิด · <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> เปิด · <kbd>Esc</kbd> ปิด</span></div>
      </div>`;
    (document.body || document.documentElement).appendChild(p);
  }

  function syncCommands() {
    state.commands = window.WWAdminCommandRegistry?.all?.() || [];
  }

  function openPalette() {
    const p = $("adminCommandPalette");
    if (!p) return;
    syncCommands();
    state.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.paletteIndex = 0;
    p.classList.remove("hidden");
    document.body.classList.add("admin-shell-palette-open");
    const input = $("adminCommandSearch");
    if (input) {
      input.value = "";
      window.setTimeout(() => input.focus(), 20);
    }
    renderCommands("");
  }

  function closePalette() {
    const p = $("adminCommandPalette");
    if (!p) return;
    p.classList.add("hidden");
    document.body.classList.remove("admin-shell-palette-open");
    const target = state.restoreFocus;
    state.restoreFocus = null;
    try { target?.focus?.(); } catch (_) {}
  }

  function pushRecent(id) {
    state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
  }

  function filteredCommands(q) {
    const query = String(q || "").trim();
    const all = query
      ? (window.WWAdminCommandRegistry?.search?.(query) || [])
      : (window.WWAdminCommandRegistry?.all?.() || state.commands);
    if (query) return all;
    const byId = new Map(all.map((c) => [c.id, c]));
    const pinned = state.pinned.map((id) => byId.get(id)).filter(Boolean);
    const recent = state.recent.map((id) => byId.get(id)).filter((c) => c && !state.pinned.includes(c.id));
    return [...pinned, ...recent, ...all.filter((c) => !state.recent.includes(c.id) && !state.pinned.includes(c.id))];
  }

  function renderCommands(q) {
    const list = $("adminCommandList");
    if (!list) return;
    const items = filteredCommands(q);
    state.commands = items;
    if (!items.length) {
      list.innerHTML = '<div class="admin-shell-empty">ไม่พบคำสั่งที่ค้นหา</div>';
      state.paletteIndex = -1;
      return;
    }
    state.paletteIndex = Math.max(0, Math.min(Number.isFinite(state.paletteIndex) ? state.paletteIndex : 0, items.length - 1));
    let html = "";
    let last = "";
    items.forEach((c, i) => {
      const group = c.category !== last ? (last = c.category, `<div class="admin-shell-command-group">${escape(c.category)}</div>`) : "";
      const active = i === state.paletteIndex;
      html += group + `<button type="button" role="option" aria-selected="${active}" class="admin-shell-command${active ? " active" : ""}${state.pinned.includes(c.id) ? " is-pinned" : ""}" data-command-id="${escape(c.id)}" data-command-index="${i}"><span class="admin-shell-command-icon">${escape(c.icon || "•")}</span><span class="admin-shell-command-copy"><b>${escape(c.title)}</b><small>${escape(c.id)}</small></span>${c.risk ? `<span class="admin-shell-command-risk">${escape(c.risk)}</span>` : ""}</button>`;
    });
    list.innerHTML = html;
    list.querySelector(`[data-command-index="${state.paletteIndex}"]`)?.scrollIntoView?.({block:"nearest"});
    syncPinButton();
  }

  async function run(id) {
    const c = window.WWAdminCommandRegistry?.find?.(id);
    if (!c) return;
    if (c.risk) emit("COMMAND_RISK", {commandId:id, risk:c.risk});
    pushRecent(id);
    closePalette();
    try {
      await window.WWAdminCommandRegistry.run(id);
      emit("COMMAND_FINISHED", {commandId:id, ok:true});
    } catch (e) {
      const message = e?.message || String(e);
      emit("COMMAND_FINISHED", {commandId:id, ok:false, error:message});
      if (window.wwToast) window.wwToast("คำสั่งไม่สำเร็จ: " + message, {type:"error"});
    }
  }

  function syncWorkspaceStickyMetrics() {
    const workspace = $("adminWorkspace");
    const header = workspace?.querySelector(".admin-page-header");
    if (!workspace || !header) return;
    const height = Math.max(0, Math.ceil(header.getBoundingClientRect().height));
    workspace.style.setProperty("--admin-page-header-height", `${height}px`);
  }

  function setActiveTab(tab) {
    const next = String(tab || "overview");
    state.activeTab = next;
    try { document.body.dataset.adminTab = next; window.__wwAdminCurrentTab = next; } catch (_) {}
    document.querySelectorAll("[data-admin-nav]").forEach((btn) => {
      const active = btn.dataset.adminNav === next;
      btn.classList.toggle("active", active);
      if (active) btn.setAttribute("aria-current", next === "overview" ? "page" : "true");
      else btn.setAttribute("aria-current", "false");
    });
    window.requestAnimationFrame(syncWorkspaceStickyMetrics);
  }

  // Selection remains available to command/search integrations, but the old
  // persistent context rail is intentionally gone. Detail views use the existing
  // dedicated overlay/drawer when a user actually asks to inspect something.
  function setContext(data) {
    state.selected = data || null;
    if (data) emit("CONTEXT_SELECTED", {...data, contextType:data.type});
  }

  function setStatus(partial = {}) {
    state.status = {...state.status, ...partial};
    const map = {server:"adminShellServerStatus", rooms:"adminShellRoomStatus", players:"adminShellPlayerStatus", audit:"adminShellAuditStatus"};
    Object.keys(map).forEach((key) => {
      const el = $(map[key]);
      if (el && state.status[key] !== undefined) el.textContent = String(state.status[key]);
    });
  }

  function updateAuditStatus() {
    try {
      const snap = window.WWRuntimeAudit?.snapshot?.();
      const count = Number(snap?.summary?.findingCount);
      if (Number.isFinite(count)) setStatus({audit: count === 0 ? "0 findings" : `${count} findings`});
    } catch (_) {}
  }

  function go(tab) {
    const target = String(tab || "overview");
    if (typeof window.switchTab === "function") window.switchTab(target);
    else window.setTimeout(() => window.switchTab?.(target), 0);
  }

  function refreshCurrent() {
    const current = state.activeTab || "overview";
    const handlers = {
      overview: "refreshDashboard",
      all: "loadAllPlayers",
      live: "loadAccounts",
      rooms: "loadRooms",
      tools: "refreshServerStatus",
      versions: "loadAdminVersions",
      diagnostics: "loadDiagnostics",
    };
    const fn = handlers[current];
    if (fn && typeof window[fn] === "function") {
      try { return Promise.resolve(window[fn]()); } catch (e) { return Promise.reject(e); }
    }
    return Promise.resolve();
  }

  function setAccountMenu(open) {
    const menu = $("adminAccountMenu");
    const trigger = $("adminAccountTrigger");
    if (!menu || !trigger) return;
    const next = Boolean(open);
    menu.classList.toggle("hidden", !next);
    trigger.setAttribute("aria-expanded", String(next));
  }

  function onKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openPalette();
      return;
    }
    const palette = $("adminCommandPalette");
    if (palette && !palette.classList.contains("hidden")) {
      if (e.key === "Escape") { e.preventDefault(); closePalette(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const len = state.commands.length;
        if (!len) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        state.paletteIndex = (state.paletteIndex + step + len) % len;
        renderCommands($("adminCommandSearch")?.value || "");
        return;
      }
      if (e.key === "Enter" && state.commands[state.paletteIndex]) {
        e.preventDefault();
        run(state.commands[state.paletteIndex].id);
        return;
      }
      return;
    }
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      e.preventDefault();
      openPalette();
      return;
    }
    const t = e.target;
    if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
    if (e.key.toLowerCase() === "g") {
      window.__wwAdminKeySequence = "g";
      window.clearTimeout(window.__wwAdminKeyTimer);
      window.__wwAdminKeyTimer = window.setTimeout(() => window.__wwAdminKeySequence = "", 900);
      return;
    }
    if (window.__wwAdminKeySequence === "g") {
      const map = {o:"overview", p:"all", l:"live", r:"rooms", s:"tools", v:"versions", d:"diagnostics", b:"browser"};
      const tab = map[e.key.toLowerCase()];
      window.__wwAdminKeySequence = "";
      if (tab) { e.preventDefault(); go(tab); }
    }
  }

  function bind() {
    $("adminShellCommandBtn")?.addEventListener("click", openPalette);
    $("adminAccountTrigger")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = $("adminAccountMenu");
      setAccountMenu(menu?.classList.contains("hidden"));
    });
    $("adminAccountMenu")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-account-menu-command]");
      if (b) { setAccountMenu(false); run(b.dataset.accountMenuCommand); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".admin-account-wrap")) setAccountMenu(false);
      if (e.target.closest("[data-shell-close]")) closePalette();
    });
    document.querySelectorAll("[data-shell-command]").forEach((b) => b.addEventListener("click", () => run(b.dataset.shellCommand)));
    document.querySelectorAll("[data-admin-nav]").forEach((b) => b.addEventListener("click", () => go(b.dataset.adminNav)));
    document.querySelectorAll("[data-shell-refresh-current]").forEach((b) => b.addEventListener("click", () => {
      const result = refreshCurrent();
      if (result?.catch) result.catch((e) => window.wwToast?.("รีเฟรชไม่สำเร็จ: " + (e?.message || e), {type:"error"}));
    }));
    $("adminCommandSearch")?.addEventListener("input", (e) => { state.paletteIndex = 0; renderCommands(e.target.value); });
    $("adminCommandPinBtn")?.addEventListener("click", () => {
      const id = state.commands[state.paletteIndex]?.id; if (!id) return;
      togglePinned(id); renderCommands($("adminCommandSearch")?.value || "");
    });
    $("adminCommandList")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-command-id]");
      if (b) run(b.dataset.commandId);
    });
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", syncWorkspaceStickyMetrics, {passive:true});
    window.addEventListener("orientationchange", () => window.setTimeout(syncWorkspaceStickyMetrics, 60), {passive:true});
    document.addEventListener("click", (e) => {
      const b = e.target.closest(".admin-shell-room-select[data-room-id]");
      if (!b) return;
      setContext({type:"room", roomId:b.dataset.roomId || "", hostName:b.dataset.roomName || "", players:b.dataset.roomPlayers || ""});
    });
    window.addEventListener("ww-admin-event", (e) => {
      if (e.detail?.type === "COMMAND_FINISHED" && e.detail.ok) updateAuditStatus();
    });
  }

  async function logout() {
    try { await fetch("/api/admin/logout", {method:"POST", cache:"no-store", credentials:"same-origin"}); } catch (_) {}
    window.WWAdminTabAuth?.clear();
    try { window.__wwAdminSocket?.disconnect(); } catch (_) {}
    location.reload();
  }

  function init() {
    state.pinned = loadPinned();
    buildPalette();
    window.WWAdminShell = {openPalette, closePalette, run, setContext, setStatus, setActiveTab, refreshCurrent, logout, state};
    document.body.classList.add("admin-shell-enabled");
    bind();
    syncCommands();
    setActiveTab("overview");
    try { setStatus(window.__WW_ADMIN_SHELL_STATUS__ || state.status); } catch (_) { setStatus(state.status); }
    updateAuditStatus();
    window.requestAnimationFrame(syncWorkspaceStickyMetrics);
    window.setTimeout(syncWorkspaceStickyMetrics, 120);
    window.setInterval(updateAuditStatus, 1500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, {once:true});
  else init();
})();
