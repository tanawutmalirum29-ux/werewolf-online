/*
 * Werewolf Admin Internal Browser
 *
 * A browser-like surface that keeps Game / Tester Host / Tester Player pages
 * inside the Admin tab. It owns tab lifecycle and presentation only; game
 * business rules, auth, Socket.IO and Tester Pass issuance remain in the
 * existing application code.
 */
(function () {
  "use strict";

  const MAX_TABS = 24;
  const DEFAULT_GAME = "index.html";
  const EMBED_QUERY_KEY = "ww_admin_embed";
  const EMBED_DEPTH_KEY = "ww_admin_embed_depth";
  const EMBED_INSTANCE_KEY = "ww_admin_embed_id";
  const ADMIN_EMBED_MAX_DEPTH = 1;
  const ADMIN_EMBED_MODE = (() => {
    try { return new URLSearchParams(location.search).get(EMBED_QUERY_KEY) === "1"; } catch (_) { return false; }
  })();
  const ADMIN_EMBED_DEPTH = (() => {
    try { return Math.max(0, Math.min(10, Number(new URLSearchParams(location.search).get(EMBED_DEPTH_KEY) || 0))); } catch (_) { return 0; }
  })();
  const ADMIN_EMBED_INSTANCE = (() => {
    try {
      const raw = new URLSearchParams(location.search).get(EMBED_INSTANCE_KEY) || "";
      const clean = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      return clean || (ADMIN_EMBED_MODE ? makeId("admin-embed") : "");
    } catch (_) { return ADMIN_EMBED_MODE ? `admin-embed-${Date.now().toString(36)}` : ""; }
  })();
  const STORE_KEY = `ww_admin_internal_browser_v2${ADMIN_EMBED_MODE ? `__embed_${ADMIN_EMBED_INSTANCE || "nested"}` : ""}`;
  const LEGACY_STORE_KEY = ADMIN_EMBED_MODE ? "" : "ww_admin_internal_browser_v1";
  const GAME_PATHS = new Set(["/", "/index.html", "/host.html", "/player.html", "/admin.html"]);
  const TESTER_PATHS = new Set(["/host.html", "/player.html"]);
  const isAdminPath = (pathname) => pathname === "/admin.html";
  const canOpenAdminPage = () => !ADMIN_EMBED_MODE || ADMIN_EMBED_DEPTH < ADMIN_EMBED_MAX_DEPTH;
  const VIEWPORT_PRESETS = [
    { id:"mobile-small", group:"มือถือ", label:"มือถือเล็ก", width:320, height:568 },
    { id:"mobile", group:"มือถือ", label:"มือถือมาตรฐาน", width:390, height:844 },
    { id:"mobile-large", group:"มือถือ", label:"มือถือใหญ่", width:430, height:932 },
    { id:"tablet", group:"แท็บเล็ต", label:"Tablet", width:768, height:1024 },
    { id:"tablet-landscape", group:"แท็บเล็ต", label:"Tablet Landscape", width:1024, height:768 },
    { id:"ipad-mini", group:"iPad", label:"iPad mini", width:744, height:1133 },
    { id:"ipad-109", group:"iPad", label:'iPad 10.9"', width:820, height:1180 },
    { id:"ipad-11", group:"iPad", label:'iPad 11"', width:834, height:1194 },
    { id:"ipad-129", group:"iPad", label:'iPad 12.9/13"', width:1024, height:1366 },
    { id:"ipad-diagnostic", group:"iPad", label:"iPad Diagnostic 1180×682", width:1180, height:682 },
    { id:"laptop", group:"คอมพิวเตอร์", label:"Laptop 1366×768", width:1366, height:768 },
    { id:"desktop-hd", group:"คอมพิวเตอร์", label:"Desktop HD 1280×720", width:1280, height:720 },
    { id:"desktop", group:"คอมพิวเตอร์", label:"Desktop 1440×900", width:1440, height:900 },
    { id:"desktop-fhd", group:"คอมพิวเตอร์", label:"Desktop FHD 1920×1080", width:1920, height:1080 },
    { id:"desktop-plus", group:"คอมพิวเตอร์", label:"Desktop Plus 1600×900", width:1600, height:900 },
    { id:"desktop-qhd", group:"คอมพิวเตอร์", label:"Desktop QHD 2560×1440", width:2560, height:1440 },
    { id:"desktop-4k", group:"คอมพิวเตอร์", label:"Desktop 4K 3840×2160", width:3840, height:2160 },
    { id:"ultrawide", group:"คอมพิวเตอร์", label:"Ultrawide 3440×1440", width:3440, height:1440 },
    { id:"super-ultrawide", group:"คอมพิวเตอร์", label:"Super Ultrawide 5120×1440", width:5120, height:1440 },
    { id:"desktop-5k", group:"คอมพิวเตอร์", label:"Desktop 5K 5120×2880", width:5120, height:2880 },
  ];
  const VIEWPORT_ZOOMS = ["fit", "25", "33", "50", "67", "75", "100", "125", "150", "200"];
  const ADMIN_RELEASE = (() => {
    try {
      const metaValue = String(document.querySelector('meta[name="ww-admin-release"]')?.content || "").trim();
      if (metaValue && !metaValue.includes("__WW_ADMIN_RELEASE__")) {
        return metaValue.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "live";
      }
      const script = [...document.scripts].find((node) => /\/js\/admin-browser\.js(?:\?|$)/.test(String(node.src || "")));
      const queryValue = script ? new URL(script.src, location.href).searchParams.get("v") : "";
      return String(queryValue || "live").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "live";
    } catch (_) { return "live"; }
  })();

  const state = {
    tabs: [],
    activeTabId: "",
    controlSurface: true,
    lastControlTab: "overview",
    restoreInFlight: false,
    lastCapture: null,
    lastCaptureBlob: null,
    lastCaptureGithub: null,
    lastCaptureBatch: null,
    capturePresetIds: [],
    captureMode: "evidence",
    captureGithubInFlight: false,
    captureInFlight: false,
    lastCaptureTiming: null,
  };

  let frameLayoutObserver = null;
  let frameLayoutResizeHandlerBound = false;
  let frameLayoutTimer = 0;
  let frameLayoutAttempt = 0;
  let browserSurfaceAnchor = null;

  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  }[m]));

  function makeId(prefix) {
    try {
      if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    } catch (_) {}
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function currentTab() {
    return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
  }

  function internalPageAllowed(raw) {
    try {
      const url = new URL(raw, location.origin);
      if (url.origin !== location.origin) return false;
      if (!GAME_PATHS.has(url.pathname)) return false;
      if (isAdminPath(url.pathname) && !canOpenAdminPage()) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function sanitizeDisplayUrl(raw) {
    try {
      const url = new URL(raw, location.origin);
      const params = new URLSearchParams(url.search);
      ["tp", "t", "ac", "hc", "ts"].forEach((key) => {
        if (params.has(key)) params.set(key, "•••");
      });
      params.delete("ww_admin_release");
      const query = params.toString();
      return `${url.pathname || "/"}${query ? `?${query}` : ""}${url.hash || ""}`;
    } catch (_) {
      return "/";
    }
  }

  function defaultTitleFor(url, type) {
    if (type === "game") return "Werewolf-Online";
    if (type === "tester-host") return "Tester Host";
    if (type === "tester-player") return "Tester Player";
    if (type === "bot-player") return "Tester Bot";
    if (type === "admin") return "Admin";
    try {
      const p = new URL(url, location.origin).pathname;
      if (p.endsWith("/host.html")) return "Werewolf-Online";
      if (p.endsWith("/player.html")) return "Werewolf-Online";
      if (p.endsWith("/admin.html")) return "Admin";
      return "Werewolf-Online";
    } catch (_) {
      return "Werewolf-Online";
    }
  }

  function buildUrl(type, meta = {}) {
    if (type === "game") return DEFAULT_GAME;
    const page = type === "tester-host" ? "host.html" : "player.html";
    const params = new URLSearchParams();
    params.set("tester", "1");
    params.set("am", "1");
    const pass = String(meta.testerPass || "");
    if (pass) params.set("tp", pass);
    const launchId = String(meta.launchId || makeId("launch"));
    params.set("ts", launchId);
    params.set("at", String(meta.tabId || ""));
    params.set("ac", String(meta.controllerId || ""));
    if (meta.botToken) params.set("t", String(meta.botToken));
    if (meta.roomId) params.set("jr", String(meta.roomId));
    if (meta.hostControllerId) params.set("hc", String(meta.hostControllerId));
    if (meta.name) params.set("name", String(meta.name).slice(0, 24));
    return `${page}?${params.toString()}`;
  }

  function buildAdminUrl(meta = {}) {
    const depth = Math.min(ADMIN_EMBED_MAX_DEPTH, Math.max(1, ADMIN_EMBED_DEPTH + 1));
    const embedId = String(meta.embedId || makeId("admin-embed")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
    const url = new URL("/admin.html", location.origin);
    url.searchParams.set(EMBED_QUERY_KEY, "1");
    url.searchParams.set(EMBED_DEPTH_KEY, String(depth));
    url.searchParams.set(EMBED_INSTANCE_KEY, embedId || "nested");
    return `${url.pathname}${url.search}`;
  }

  function canonicalizeAdminUrl(raw, embedId = "") {
    try {
      const url = new URL(raw, location.origin);
      if (!isAdminPath(url.pathname)) return url.href;
      if (!canOpenAdminPage()) return null;
      const requestedDepth = Number(url.searchParams.get(EMBED_DEPTH_KEY) || 0);
      const depth = Math.min(ADMIN_EMBED_MAX_DEPTH, Math.max(1, requestedDepth || (ADMIN_EMBED_DEPTH + 1)));
      const id = String(embedId || url.searchParams.get(EMBED_INSTANCE_KEY) || makeId("admin-embed"))
        .replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "nested";
      url.searchParams.set(EMBED_QUERY_KEY, "1");
      url.searchParams.set(EMBED_DEPTH_KEY, String(depth));
      url.searchParams.set(EMBED_INSTANCE_KEY, id);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch (_) { return null; }
  }

  function cloneDefaultViewport() {
    return {
      mode:"auto",
      presetId:"auto",
      width:0,
      height:0,
      zoom:"100",
      lockAspect:false,
      orientation:"auto",
    };
  }

  function normalizeViewport(raw) {
    const base = cloneDefaultViewport();
    const source = raw && typeof raw === "object" ? raw : {};
    const mode = source.mode === "custom" || source.mode === "preset" ? source.mode : "auto";
    const preset = VIEWPORT_PRESETS.find((item) => item.id === String(source.presetId || ""));
    const width = Math.max(160, Math.min(7680, Math.round(Number(source.width) || preset?.width || 390)));
    const height = Math.max(160, Math.min(4320, Math.round(Number(source.height) || preset?.height || 844)));
    const zoom = source.zoom === "fit" || VIEWPORT_ZOOMS.includes(String(source.zoom)) ? String(source.zoom) : base.zoom;
    return {
      mode,
      presetId: mode === "preset" && preset ? preset.id : mode === "auto" ? "auto" : "custom",
      width: mode === "auto" ? 0 : width,
      height: mode === "auto" ? 0 : height,
      zoom,
      lockAspect: !!source.lockAspect,
      orientation: ["auto", "portrait", "landscape"].includes(String(source.orientation)) ? String(source.orientation) : "auto",
    };
  }

  function loadSavedMeta() {
    try {
      const raw = JSON.parse(sessionStorage.getItem(STORE_KEY) || sessionStorage.getItem(LEGACY_STORE_KEY) || "{}");
      const tabs = Array.isArray(raw.tabs) ? raw.tabs : [];
      return {
        tabs: tabs.filter((tab) => tab && tab.id && ["game", "tester-host", "tester-player", "admin"].includes(tab.type) && (tab.type !== "admin" || canOpenAdminPage())).slice(0, MAX_TABS),
      };
    } catch (_) {
      return { tabs: [] };
    }
  }

  function persistMeta() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        version:2,
        tabs: state.tabs.filter((tab) => tab.persistent !== false).map((tab) => ({
          id: tab.id,
          type: tab.type,
          title: tab.title,
          launchId: tab.launchId,
          url: tab.type === "admin" ? tab.url : "",
          embedId: tab.embedId || "",
          persistent: tab.persistent !== false,
          viewport: normalizeViewport(tab.viewport),
        })).slice(0, MAX_TABS),
      }));
    } catch (_) {}
  }

  function ensureRootMarkup() {
    const view = $("adminBrowserView");
    if (!view) {
      console.error("[admin-browser] missing #adminBrowserView markup");
      return;
    }
    // Keep a stable restoration point. While Browser is active the surface is
    // portaled directly under <body> so iPad/WebKit cannot constrain a fixed
    // surface by the Admin three-column grid or a nested scrolling context.
    if (!browserSurfaceAnchor && view.parentNode) {
      browserSurfaceAnchor = document.createComment("ww-admin-browser-anchor");
      view.parentNode.insertBefore(browserSurfaceAnchor, view);
    }
  }

  function portalBrowserSurface(browser) {
    const view = $("adminBrowserView");
    if (!view) return;
    ensureRootMarkup();
    if (browser) {
      if (view.parentNode !== document.body) document.body.appendChild(view);
      view.dataset.portal = "body";
    } else if (browserSurfaceAnchor?.parentNode) {
      browserSurfaceAnchor.parentNode.insertBefore(view, browserSurfaceAnchor.nextSibling);
      delete view.dataset.portal;
    }
  }

  function syncBrowserSurfaceGeometry(browser) {
    const view = $("adminBrowserView");
    if (!view) return;
    if (browser) {
      // Do not rely only on the parent grid or stylesheet timing. iPad/WebKit can
      // briefly preserve the old three-column layout while the active tab changes.
      // Pin the browser surface itself to the visual viewport so the shell can
      // never steal horizontal space from the game canvas.
      view.style.setProperty("position", "fixed");
      view.style.setProperty("inset", "0");
      view.style.setProperty("width", "100vw");
      view.style.setProperty("height", "100dvh");
      view.style.setProperty("min-height", "0");
      view.style.setProperty("margin", "0");
      view.style.setProperty("z-index", "99999");
    } else {
      ["position", "inset", "width", "height", "min-height", "margin", "z-index"].forEach((prop) => view.style.removeProperty(prop));
    }
  }

  function showSurface(browser) {
    ensureRootMarkup();
    const view = $("adminBrowserView");
    const workspace = $("adminWorkspace");
    if (!view || !workspace) return;

    state.controlSurface = !browser;
    portalBrowserSurface(!!browser);
    view.classList.toggle("is-active", !!browser);
    view.hidden = !browser;
    workspace.classList.toggle("admin-browser-active", !!browser);
    document.body.dataset.adminSurface = browser ? "browser" : "control";
    document.body.classList.toggle("admin-browser-open", !!browser);
    syncBrowserSurfaceGeometry(!!browser);
    syncFrameVisibility();

    const toggle = $("adminBrowserToggleBtn");
    if (toggle) {
      toggle.textContent = "↩";
      toggle.setAttribute("aria-pressed", String(!!browser));
    }
    if (browser) {
      setupFrameLayoutObserver();
      const currentAdminTab = String(document.body.dataset.adminTab || "overview");
      if (currentAdminTab && currentAdminTab !== "browser") state.lastControlTab = currentAdminTab;
      try { window.WWAdminShell?.setActiveTab?.("browser"); } catch (_) {}
      renderTabs();
      const tab = currentTab();
      if (tab) {
        renderFrame(tab);
        scheduleFrameLayoutSync(tab, "surface-visible");
      }
    } else {
      stopFrameLayoutTimer();
    }
  }

  function renderTabs() {
    const strip = $("adminBrowserTabs");
    if (!strip) return;
    const count = $("adminBrowserTabCount");
    if (count) count.textContent = String(state.tabs.length);
    strip.innerHTML = state.tabs.map((tab) => {
      const active = tab.id === state.activeTabId;
      const status = tab.status || "ready";
      const canClose = tab.closable !== false;
      const viewport = normalizeViewport(tab.viewport);
      tab.viewport = viewport;
      return `<button class="admin-browser-tab${active ? " active" : ""}" type="button" role="tab" aria-selected="${active}" data-browser-tab="${esc(tab.id)}" title="${esc(tab.title)}">
        <span class="admin-browser-tab-status ${esc(status)}" aria-hidden="true"></span>
        <span class="admin-browser-tab-icon">${esc(tab.icon || "🌐")}</span>
        <span class="admin-browser-tab-title">${esc(tab.title || "Untitled")}</span>
        <span class="admin-browser-tab-viewport" title="Viewport ของแท็บนี้">${esc(viewport.mode === "auto" ? "AUTO" : `${viewport.width}×${viewport.height}`)}</span>
        ${canClose ? `<span class="admin-browser-tab-close" data-browser-close="${esc(tab.id)}" aria-label="ปิด ${esc(tab.title || "แท็บ")}">×</span>` : ""}
      </button>`;
    }).join("") + `<button class="admin-browser-newtab" type="button" id="adminBrowserNewTabBtn" title="สร้างแท็บใหม่" aria-label="สร้างแท็บใหม่">+</button>`;
  }

  function buildEmbeddedFrameUrl(raw) {
    try {
      const url = new URL(raw, location.origin);
      if (!GAME_PATHS.has(url.pathname)) return url.href;
      // IMPORTANT: keep the actual game pathname as the iframe URL. The old
      // release-scoped /__ww_admin_embed__/ route depended on CloudFront
      // forwarding a brand-new pathname to Express. When that behavior was
      // not deployed, every internal tab could become a perfectly valid-looking
      // but empty iframe. A harmless query marker still separates Admin's
      // current release from stale browser/CDN cache without changing routing.
      url.searchParams.set("ww_admin_release", ADMIN_RELEASE);
      return `${url.pathname === "/" ? "/index.html" : url.pathname}${url.search}${url.hash}`;
    } catch (_) {
      return String(raw || "");
    }
  }

  function getFrameHealthContract(type) {
    if (type === "admin") return { page: "admin", path: "/admin.html", selector: "#adminApp" };
    if (type === "tester-host") return { page: "host", path: "/host.html", selector: "#list" };
    if (type === "tester-player" || type === "bot-player") return { page: "player", path: "/player.html", selector: "#joinCard" };
    return { page: "index", path: "/index.html", selector: "#nameField" };
  }

  function getFrameHealth(iframe, tab) {
    try {
      const doc = iframe?.contentDocument;
      if (!doc || !doc.documentElement || !doc.body) return { ok: false, reason: "document_unavailable" };
      const expected = getFrameHealthContract(tab.type);
      const page = String(doc.body.dataset?.page || "");
      const pathname = String(iframe?.contentWindow?.location?.pathname || "");
      const normalizedPath = pathname === "/" ? "/index.html" : pathname;
      if (normalizedPath && normalizedPath !== expected.path) {
        return { ok: false, reason: `unexpected_path:${normalizedPath}` };
      }
      if (page !== expected.page) {
        return { ok: false, reason: `unexpected_page:${page || "none"}` };
      }
      if (!doc.querySelector(expected.selector)) {
        return { ok: false, reason: `missing_root:${expected.selector}` };
      }
      return { ok: true, reason: "ready" };
    } catch (_) {
      return { ok: false, reason: "frame_access_failed" };
    }
  }

  function ensureFrameNotice() {
    const stage = $("adminBrowserStage");
    if (!stage) return null;
    let notice = stage.querySelector(".admin-browser-frame-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "admin-browser-frame-notice";
      notice.hidden = true;
      notice.innerHTML = `
        <div class="admin-browser-frame-notice-card">
          <div class="admin-browser-frame-notice-icon" aria-hidden="true">⚠️</div>
          <div class="admin-browser-frame-notice-title"></div>
          <div class="admin-browser-frame-notice-copy"></div>
          <button type="button" class="admin-browser-frame-notice-retry">ลองโหลดอีกครั้ง</button>
        </div>`;
      stage.appendChild(notice);
      notice.querySelector(".admin-browser-frame-notice-retry")?.addEventListener("click", () => {
        const tab = currentTab();
        if (tab) reloadActive();
      });
    }
    return notice;
  }

  function setFrameNotice(tab, visible, title = "", copy = "") {
    const notice = ensureFrameNotice();
    if (!notice) return;
    notice.hidden = !visible;
    if (!visible) return;
    const titleEl = notice.querySelector(".admin-browser-frame-notice-title");
    const copyEl = notice.querySelector(".admin-browser-frame-notice-copy");
    if (titleEl) titleEl.textContent = title || "ไม่สามารถแสดงหน้าเกมภายในได้";
    if (copyEl) copyEl.textContent = copy || "หน้า Admin ยังเปิดอยู่ แต่เนื้อหาของแท็บนี้ไม่ตอบสนองตามโครงสร้างที่คาดไว้";
    notice.dataset.tabId = tab?.id || "";
  }

  function elementBox(element) {
    if (!element) return { width: 0, height: 0 };
    const rect = element.getBoundingClientRect?.();
    return {
      width: Math.max(0, Number(rect?.width) || Number(element.clientWidth) || 0),
      height: Math.max(0, Number(rect?.height) || Number(element.clientHeight) || 0),
    };
  }

  function getViewportLabel(tab) {
    const viewport = normalizeViewport(tab?.viewport);
    if (viewport.mode === "auto") return "Auto";
    const preset = VIEWPORT_PRESETS.find((item) => item.id === viewport.presetId);
    return preset ? preset.label : "กำหนดเอง";
  }

  function resolveViewportDimensions(tab, stageBox) {
    const viewport = normalizeViewport(tab?.viewport);
    if (viewport.mode === "auto") {
      return {
        mode:"auto",
        width:Math.max(1, stageBox.width),
        height:Math.max(1, stageBox.height),
        zoom:1,
        displayWidth:Math.max(1, stageBox.width),
        displayHeight:Math.max(1, stageBox.height),
        label:"Auto",
      };
    }
    const rawW = Math.max(160, viewport.width || 390);
    const rawH = Math.max(160, viewport.height || 844);
    let width = rawW;
    let height = rawH;
    if (viewport.orientation === "portrait" && width > height) [width, height] = [height, width];
    if (viewport.orientation === "landscape" && height > width) [width, height] = [height, width];
    let zoom = viewport.zoom === "fit" ? 1 : Math.max(0.25, Math.min(2, Number(viewport.zoom || 100) / 100));
    if (viewport.zoom === "fit") {
      const pad = 24;
      const availableW = Math.max(1, stageBox.width - pad * 2);
      const availableH = Math.max(1, stageBox.height - pad * 2);
      zoom = Math.min(2, availableW / width, availableH / height);
    }
    return {
      mode:viewport.mode,
      width,
      height,
      zoom,
      displayWidth:width * zoom,
      displayHeight:height * zoom,
      label:getViewportLabel({...tab, viewport:{...viewport, width, height}}),
    };
  }

  function applyFrameViewport(tab) {
    if (!tab) return;
    const stage = $("adminBrowserStage");
    const iframe = stage?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
    if (!stage || !iframe) return;
    const stageBox = elementBox(stage);
    const resolved = resolveViewportDimensions(tab, stageBox);
    iframe.dataset.viewportMode = resolved.mode;
    iframe.dataset.viewportWidth = String(Math.round(resolved.width));
    iframe.dataset.viewportHeight = String(Math.round(resolved.height));
    iframe.dataset.viewportZoom = String(resolved.zoom);
    iframe.style.width = resolved.mode === "auto" ? "100%" : `${Math.round(resolved.width)}px`;
    iframe.style.height = resolved.mode === "auto" ? "100%" : `${Math.round(resolved.height)}px`;
    iframe.style.left = resolved.mode === "auto" ? "0" : "50%";
    iframe.style.top = resolved.mode === "auto" ? "0" : "50%";
    iframe.style.right = resolved.mode === "auto" ? "0" : "auto";
    iframe.style.bottom = resolved.mode === "auto" ? "0" : "auto";
    iframe.style.transform = resolved.mode === "auto" ? "none" : `translate(-50%, -50%) scale(${resolved.zoom})`;
    iframe.style.transformOrigin = "center center";
    iframe.setAttribute("aria-label", `${tab.title || "แท็บ"} — ${resolved.mode === "auto" ? "ขนาดอัตโนมัติ" : `${Math.round(resolved.width)} × ${Math.round(resolved.height)} CSS px`}`);
    updateViewportControls(tab, resolved);
  }

  const VIEWPORT_MODE_OPTIONS = [
    {value:"auto", icon:"⚙️", label:"Auto", detail:"พอดีพื้นที่ Admin"},
    {value:"preset", icon:"📱", label:"ขนาดสำเร็จรูป", detail:"เลือกจากอุปกรณ์"},
    {value:"custom", icon:"✏️", label:"ตั้งเอง", detail:"กำหนด W × H"},
  ];
  const VIEWPORT_ORIENTATION_OPTIONS = [
    {value:"auto", label:"↔ Auto"},
    {value:"portrait", label:"↕ Portrait"},
    {value:"landscape", label:"↔ Landscape"},
  ];
  const VIEWPORT_ZOOM_OPTIONS = [
    {value:"fit", label:"Fit", detail:"พอดีพื้นที่"},
    ...["25","33","50","67","75","100","125","150","200"].map((value) => ({value, label:`${value}%`, detail:"ซูมแสดงผล"})),
  ];
  const VIEWPORT_MENU_MAP = {
    mode: {button:"adminBrowserViewportModeBtn", menu:"adminBrowserViewportModeMenu"},
    preset: {button:"adminBrowserViewportPresetBtn", menu:"adminBrowserViewportPresetMenu"},
    zoom: {button:"adminBrowserViewportZoomBtn", menu:"adminBrowserViewportZoomMenu"},
  };

  let openViewportMenuKey = "";
  let viewportMenuFocusIndex = -1;
  let viewportMenuDocumentBound = false;

  function viewportMenuNodes(key) {
    const meta = VIEWPORT_MENU_MAP[key];
    return meta ? {button:$(meta.button), menu:$(meta.menu)} : {button:null, menu:null};
  }

  function portalViewportMenus() {
    Object.values(VIEWPORT_MENU_MAP).forEach(({menu:menuId}) => {
      const menu = $(menuId);
      if (menu && menu.parentElement !== document.body) document.body.appendChild(menu);
    });
  }

  function viewportMenuOptions(menu) {
    return [...(menu?.querySelectorAll?.('[role="option"]') || [])].filter((node) => node.getAttribute("aria-disabled") !== "true");
  }

  function setViewportMenuHidden(menu, hidden) {
    if (!menu) return;
    menu.hidden = hidden;
    menu.classList.toggle("is-open", !hidden);
  }

  function positionViewportMenu(key) {
    const {button, menu} = viewportMenuNodes(key);
    if (!button || !menu || menu.hidden) return;
    const rect = button.getBoundingClientRect();
    const gap = 5;
    const pad = 8;
    const width = Math.min(key === "preset" ? 360 : 260, Math.max(rect.width, window.innerWidth - pad * 2));
    menu.style.width = `${Math.round(width)}px`;
    menu.style.left = `${Math.round(Math.min(Math.max(pad, rect.left), Math.max(pad, window.innerWidth - width - pad)))}px`;
    const menuHeight = menu.getBoundingClientRect().height || 240;
    const below = rect.bottom + gap;
    const above = rect.top - gap - menuHeight;
    const top = below + menuHeight <= window.innerHeight - pad || above < pad ? below : above;
    menu.style.top = `${Math.round(Math.max(pad, Math.min(top, Math.max(pad, window.innerHeight - menuHeight - pad))))}px`;
  }

  function closeViewportMenus({restoreFocus = false} = {}) {
    if (!openViewportMenuKey) return;
    const previousKey = openViewportMenuKey;
    const previous = viewportMenuNodes(previousKey);
    if (previous.button) previous.button.setAttribute("aria-expanded", "false");
    setViewportMenuHidden(previous.menu, true);
    openViewportMenuKey = "";
    viewportMenuFocusIndex = -1;
    if (restoreFocus) previous.button?.focus?.();
  }

  function focusViewportMenuOption(menu, index) {
    const options = viewportMenuOptions(menu);
    if (!options.length) return;
    viewportMenuFocusIndex = Math.max(0, Math.min(index, options.length - 1));
    options[viewportMenuFocusIndex].focus?.();
  }

  function openViewportMenu(key, {focusSelected = true} = {}) {
    const current = viewportMenuNodes(key);
    if (!current.button || !current.menu || current.button.disabled) return;
    if (openViewportMenuKey && openViewportMenuKey !== key) closeViewportMenus();
    const willClose = openViewportMenuKey === key && !current.menu.hidden;
    if (willClose) {
      closeViewportMenus({restoreFocus:true});
      return;
    }
    openViewportMenuKey = key;
    current.button.setAttribute("aria-expanded", "true");
    setViewportMenuHidden(current.menu, false);
    positionViewportMenu(key);
    const options = viewportMenuOptions(current.menu);
    const selected = options.findIndex((node) => node.getAttribute("aria-selected") === "true");
    viewportMenuFocusIndex = selected >= 0 ? selected : 0;
    if (focusSelected) focusViewportMenuOption(current.menu, viewportMenuFocusIndex);
  }

  function setViewportMenuSelection(menu, value) {
    if (!menu) return;
    [...menu.querySelectorAll('[role="option"]')].forEach((node) => {
      const selected = String(node.dataset.value || "") === String(value);
      node.setAttribute("aria-selected", selected ? "true" : "false");
      node.classList.toggle("is-selected", selected);
    });
  }

  function createViewportMenuOption({value, label, detail = "", disabled = false, dimension = ""} = {}) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "admin-browser-viewport-menu-option";
    option.setAttribute("role", "option");
    option.dataset.value = String(value ?? "");
    option.setAttribute("aria-selected", "false");
    if (disabled) option.setAttribute("aria-disabled", "true");
    const main = document.createElement("span");
    main.className = "admin-browser-viewport-menu-option-main";
    main.textContent = String(label ?? "");
    option.appendChild(main);
    if (dimension || detail) {
      const meta = document.createElement("span");
      meta.className = "admin-browser-viewport-menu-option-meta";
      meta.textContent = dimension || detail;
      option.appendChild(meta);
    }
    return option;
  }

  function renderStaticViewportMenu(menuId, options) {
    const menu = $(menuId);
    if (!menu || menu.dataset.ready === "1") return;
    options.forEach((item) => menu.appendChild(createViewportMenuOption(item)));
    menu.dataset.ready = "1";
  }

  function renderViewportPresetOptions() {
    const menu = $("adminBrowserViewportPresetMenu");
    if (!menu || menu.dataset.ready === "1") return;
    const groups = new Map();
    VIEWPORT_PRESETS.forEach((item) => {
      if (!groups.has(item.group)) {
        const section = document.createElement("div");
        section.className = "admin-browser-viewport-menu-section";
        const title = document.createElement("div");
        title.className = "admin-browser-viewport-menu-section-title";
        title.textContent = item.group;
        section.appendChild(title);
        const list = document.createElement("div");
        list.className = "admin-browser-viewport-menu-section-list";
        section.appendChild(list);
        groups.set(item.group, {section, list});
        menu.appendChild(section);
      }
      const option = createViewportMenuOption({value:item.id, label:item.label, dimension:`${item.width} × ${item.height} CSS px`});
      groups.get(item.group).list.appendChild(option);
    });
    menu.dataset.ready = "1";
  }

  function viewportMenuLabel(kind, value) {
    if (kind === "mode") {
      const item = VIEWPORT_MODE_OPTIONS.find((entry) => entry.value === value);
      return item ? `${item.icon} ${item.label} · ${item.detail}` : "⚙️ Auto · พอดีพื้นที่";
    }
    if (kind === "zoom") return VIEWPORT_ZOOM_OPTIONS.find((entry) => entry.value === value)?.label || "Fit";
    if (kind === "preset") {
      const item = VIEWPORT_PRESETS.find((entry) => entry.id === value);
      return item ? `${item.label} · ${item.width} × ${item.height}` : "เลือกขนาดจอ";
    }
    return "";
  }

  function syncCustomViewportControls(viewport) {
    const mode = $("adminBrowserViewportMode");
    const preset = $("adminBrowserViewportPreset");
    const orientation = $("adminBrowserViewportOrientation");
    const zoom = $("adminBrowserViewportZoom");
    if (mode) mode.value = viewport.mode;
    if (preset) preset.value = viewport.mode === "preset" && VIEWPORT_PRESETS.some((item) => item.id === viewport.presetId) ? viewport.presetId : "custom";
    if (orientation) orientation.value = viewport.orientation;
    if (zoom) zoom.value = viewport.mode === "auto" ? "100" : viewport.zoom;

    const modeText = $("adminBrowserViewportModeText");
    const presetText = $("adminBrowserViewportPresetText");
    const zoomText = $("adminBrowserViewportZoomText");
    if (modeText) modeText.textContent = viewportMenuLabel("mode", viewport.mode);
    if (presetText) presetText.textContent = viewportMenuLabel("preset", preset?.value || "custom");
    if (zoomText) zoomText.textContent = viewportMenuLabel("zoom", zoom?.value || "fit");
    setViewportMenuSelection($("adminBrowserViewportModeMenu"), viewport.mode);
    setViewportMenuSelection($("adminBrowserViewportPresetMenu"), preset?.value || "custom");
    setViewportMenuSelection($("adminBrowserViewportZoomMenu"), zoom?.value || "fit");

    const orientationGroup = $("adminBrowserViewportOrientationGroup");
    if (orientationGroup) {
      [...orientationGroup.querySelectorAll('[data-viewport-orientation]')].forEach((button) => {
        const selected = button.dataset.viewportOrientation === viewport.orientation;
        button.setAttribute("aria-checked", selected ? "true" : "false");
        button.classList.toggle("is-selected", selected);
      });
    }

    const lock = $("adminBrowserViewportLock");
    const lockButton = $("adminBrowserViewportLockBtn");
    if (lock) lock.checked = !!viewport.lockAspect;
    if (lockButton) {
      lockButton.setAttribute("aria-checked", viewport.lockAspect ? "true" : "false");
      lockButton.classList.toggle("is-on", !!viewport.lockAspect);
    }
  }

  function updateViewportControls(tab, resolved = null) {
    const viewport = normalizeViewport(tab?.viewport);
    const width = $("adminBrowserViewportWidth");
    const height = $("adminBrowserViewportHeight");
    const label = $("adminBrowserViewportLabel");
    syncCustomViewportControls(viewport);
    const widthEditing = width && document.activeElement === width;
    const heightEditing = height && document.activeElement === height;
    if (width && !widthEditing) width.value = viewport.mode === "auto" ? Math.round(resolved?.width || 0) : viewport.width;
    if (height && !heightEditing) height.value = viewport.mode === "auto" ? Math.round(resolved?.height || 0) : viewport.height;
    if (width) {
      width.disabled = viewport.mode === "auto";
      width.setAttribute("aria-valuenow", String(viewport.mode === "auto" ? Math.round(resolved?.width || 0) : viewport.width));
    }
    if (height) {
      height.disabled = viewport.mode === "auto";
      height.setAttribute("aria-valuenow", String(viewport.mode === "auto" ? Math.round(resolved?.height || 0) : viewport.height));
    }
    const presetButton = $("adminBrowserViewportPresetBtn");
    const lockButton = $("adminBrowserViewportLockBtn");
    if (presetButton) presetButton.disabled = viewport.mode !== "preset";
    if (lockButton) lockButton.disabled = viewport.mode === "auto";
    const stepButtons = document.querySelectorAll?.("[data-viewport-step]") || [];
    stepButtons.forEach((button) => { button.disabled = viewport.mode === "auto"; });

    const bar = $("adminBrowserViewportBar");
    if (bar) {
      bar.dataset.mode = viewport.mode;
      bar.dataset.orientation = viewport.orientation;
      bar.dataset.zoom = viewport.zoom;
      bar.dataset.lockAspect = viewport.lockAspect ? "1" : "0";
    }
    if (label) {
      const actual = resolved || resolveViewportDimensions(tab, elementBox($("adminBrowserStage")));
      label.textContent = actual.mode === "auto"
        ? `AUTO · ${Math.round(actual.width)} × ${Math.round(actual.height)}`
        : `${Math.round(actual.width)} × ${Math.round(actual.height)} · ${actual.zoom === 1 ? "100%" : `${Math.round(actual.zoom * 100)}%`}`;
      label.title = actual.mode === "auto" ? "ใช้ขนาดพื้นที่ Internal Browser จริง" : `${getViewportLabel(tab)} · ${Math.round(actual.width)} × ${Math.round(actual.height)} CSS px`;
    }
  }

  function commitViewportDimension(axis, rawValue, reason) {
    const tab = currentTab();
    if (!tab || normalizeViewport(tab.viewport).mode === "auto") return;
    const current = normalizeViewport(tab.viewport);
    const fallback = axis === "width" ? current.width || 390 : current.height || 844;
    const max = axis === "width" ? 7680 : 4320;
    const value = Math.max(160, Math.min(max, Math.round(Number(rawValue) || fallback)));
    const patch = {mode:"custom", presetId:"custom", [axis]:value};
    if (current.lockAspect) {
      if (axis === "width") patch.height = Math.max(160, Math.min(4320, Math.round(value * (current.height / Math.max(1, current.width)))));
      else patch.width = Math.max(160, Math.min(7680, Math.round(value * (current.width / Math.max(1, current.height)))));
    }
    setViewportForTab(tab, patch, reason);
  }

  function stepViewportDimension(axis, delta) {
    const field = $(axis === "width" ? "adminBrowserViewportWidth" : "adminBrowserViewportHeight");
    const base = Number(field?.value) || (axis === "width" ? 390 : 844);
    const step = Math.abs(base) >= 1000 ? 10 : 1;
    commitViewportDimension(axis, base + Number(delta) * step, `viewport-custom-${axis}-step`);
  }

  function handleViewportMenuSelection(key, value) {
    const tab = currentTab();
    if (!tab) return;
    if (key === "mode") updateViewportMode(value);
    else if (key === "preset") {
      const preset = VIEWPORT_PRESETS.find((item) => item.id === value);
      if (preset) setViewportForTab(tab, {mode:"preset", presetId:preset.id, width:preset.width, height:preset.height, zoom:"fit"}, "viewport-preset");
    } else if (key === "zoom") {
      setViewportForTab(tab, {zoom:value}, "viewport-zoom");
    }
    closeViewportMenus({restoreFocus:true});
  }

  function bindViewportMenuDocumentEvents() {
    if (viewportMenuDocumentBound) return;
    viewportMenuDocumentBound = true;
    document.addEventListener("pointerdown", (event) => {
      if (!openViewportMenuKey) return;
      const {button, menu} = viewportMenuNodes(openViewportMenuKey);
      if (!button?.contains?.(event.target) && !menu?.contains?.(event.target)) closeViewportMenus();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && openViewportMenuKey) {
        event.preventDefault();
        closeViewportMenus({restoreFocus:true});
      }
    });
    window.addEventListener("resize", () => {
      if (openViewportMenuKey) positionViewportMenu(openViewportMenuKey);
    }, {passive:true});
    window.addEventListener("scroll", () => {
      if (openViewportMenuKey) positionViewportMenu(openViewportMenuKey);
    }, {passive:true, capture:true});
  }

  function bindViewportMenu(key) {
    const {button, menu} = viewportMenuNodes(key);
    if (!button || !menu || button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => openViewportMenu(key));
    button.addEventListener("keydown", (event) => {
      if (["ArrowDown","ArrowUp","Enter"," "].includes(event.key)) {
        event.preventDefault();
        const wasOpen = openViewportMenuKey === key && !menu.hidden;
        openViewportMenu(key, {focusSelected:!wasOpen});
      }
    });
    menu.addEventListener("click", (event) => {
      const option = event.target.closest?.('[role="option"]');
      if (!option || option.getAttribute("aria-disabled") === "true") return;
      handleViewportMenuSelection(key, option.dataset.value);
    });
    menu.addEventListener("keydown", (event) => {
      const options = viewportMenuOptions(menu);
      if (!options.length) return;
      if (event.key === "Escape") {
        event.preventDefault(); closeViewportMenus({restoreFocus:true}); return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = viewportMenuFocusIndex + (event.key === "ArrowDown" ? 1 : -1);
        focusViewportMenuOption(menu, (next + options.length) % options.length); return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault(); focusViewportMenuOption(menu, event.key === "Home" ? 0 : options.length - 1); return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const selected = options[viewportMenuFocusIndex] || options[0];
        handleViewportMenuSelection(key, selected.dataset.value);
      }
    });
  }

  function bindViewportControls() {
    portalViewportMenus();
    renderStaticViewportMenu("adminBrowserViewportModeMenu", VIEWPORT_MODE_OPTIONS.map((item) => ({value:item.value, label:`${item.icon} ${item.label}`, detail:item.detail})));
    renderViewportPresetOptions();
    renderStaticViewportMenu("adminBrowserViewportZoomMenu", VIEWPORT_ZOOM_OPTIONS);
    bindViewportMenuDocumentEvents();
    bindViewportMenu("mode");
    bindViewportMenu("preset");
    bindViewportMenu("zoom");

    document.querySelectorAll?.("[data-viewport-orientation]").forEach((button) => {
      button.addEventListener("click", () => {
        const tab = currentTab();
        if (tab) setViewportForTab(tab, {orientation:button.dataset.viewportOrientation}, "viewport-orientation");
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
        const items = [...document.querySelectorAll('[data-viewport-orientation]')];
        const current = Math.max(0, items.indexOf(button));
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)));
        event.preventDefault(); items[next]?.focus(); items[next]?.click();
      });
    });

    ["width","height"].forEach((axis) => {
      const field = $(axis === "width" ? "adminBrowserViewportWidth" : "adminBrowserViewportHeight");
      field?.addEventListener("change", (event) => commitViewportDimension(axis, event.target.value, `viewport-custom-${axis}`));
      field?.addEventListener("blur", (event) => commitViewportDimension(axis, event.target.value, `viewport-custom-${axis}-blur`));
      field?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault(); commitViewportDimension(axis, event.target.value, `viewport-custom-${axis}`); event.target.blur();
        }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault(); stepViewportDimension(axis, event.key === "ArrowUp" ? 1 : -1);
        }
      });
    });

    document.querySelectorAll?.("[data-viewport-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const [axis, delta] = String(button.dataset.viewportStep || "").split(":");
        stepViewportDimension(axis, Number(delta) || 0);
      });
    });

    $("adminBrowserViewportLockBtn")?.addEventListener("click", () => {
      const tab = currentTab();
      const button = $("adminBrowserViewportLockBtn");
      if (tab && button && !button.disabled) setViewportForTab(tab, {lockAspect:button.getAttribute("aria-checked") !== "true"}, "viewport-lock");
    });
    $("adminBrowserViewportReset")?.addEventListener("click", () => {
      const tab = currentTab();
      if (tab) { closeViewportMenus(); setViewportForTab(tab, cloneDefaultViewport(), "viewport-reset"); }
    });
    $("adminBrowserViewportFit")?.addEventListener("click", () => {
      const tab = currentTab();
      if (tab && tab.viewport?.mode !== "auto") { closeViewportMenus(); setViewportForTab(tab, {zoom:"fit"}, "viewport-fit"); }
    });
  }

  function setViewportForTab(tab, patch = {}, reason = "viewport-change") {
    if (!tab) return false;
    const current = normalizeViewport(tab.viewport);
    const next = normalizeViewport({ ...current, ...patch });
    if (next.mode === "preset") {
      const preset = VIEWPORT_PRESETS.find((item) => item.id === next.presetId);
      if (preset) {
        next.width = preset.width;
        next.height = preset.height;
      }
    }
    tab.viewport = next;
    applyFrameViewport(tab);
    persistMeta();
    scheduleFrameLayoutSync(tab, reason);
    emit("viewport-change", tab);
    return true;
  }

  function updateViewportMode(mode) {
    const tab = currentTab();
    if (!tab) return;
    const requested = String(mode || "auto");
    if (requested === "auto") setViewportForTab(tab, {mode:"auto", presetId:"auto", width:0, height:0, zoom:"100"}, "viewport-auto");
    else if (requested === "preset") setViewportForTab(tab, {mode:"preset", presetId:"mobile", zoom:"fit"}, "viewport-preset-mode");
    else setViewportForTab(tab, {mode:"custom", presetId:"custom", width:390, height:844, zoom:"fit"}, "viewport-custom-mode");
  }

  function activeFrameLayout(tab) {
    const workspace = $("adminWorkspace");
    const view = $("adminBrowserView");
    const stage = $("adminBrowserStage");
    const iframe = tab ? stage?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`) : null;
    const workspaceBox = elementBox(workspace);
    const viewBox = elementBox(view);
    const stageBox = elementBox(stage);
    if (tab && iframe) applyFrameViewport(tab);
    const frameBox = elementBox(iframe);
    const viewport = tab && stageBox.width > 0 && stageBox.height > 0 ? resolveViewportDimensions(tab, stageBox) : null;
    return {
      workspaceWidth: workspaceBox.width,
      workspaceHeight: workspaceBox.height,
      viewWidth: viewBox.width,
      viewHeight: viewBox.height,
      stageWidth: stageBox.width,
      stageHeight: stageBox.height,
      frameWidth: frameBox.width,
      frameHeight: frameBox.height,
      viewportWidth: viewport?.width || frameBox.width,
      viewportHeight: viewport?.height || frameBox.height,
      viewportZoom: viewport?.zoom || 1,
      viewportMode: viewport?.mode || "auto",
      usable: !state.controlSurface
        && tab?.id === state.activeTabId
        && stageBox.width > 0 && stageBox.height > 0
        && frameBox.width > 0 && frameBox.height > 0,
    };
  }

  function stopFrameLayoutTimer() {
    if (frameLayoutTimer) {
      cancelAnimationFrame(frameLayoutTimer);
      frameLayoutTimer = 0;
    }
  }

  function dispatchChildResize(tab, reason, attempt) {
    if (!tab) return false;
    const stage = $("adminBrowserStage");
    const iframe = stage?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
    if (!iframe?.contentWindow) return false;
    const layout = activeFrameLayout(tab);
    if (!layout.usable) return false;
    try {
      iframe.contentWindow.postMessage({
        type: "ww-admin-browser-layout",
        tabId: tab.id,
        reason: String(reason || "layout-sync"),
        attempt: Number(attempt) || 0,
        adminRelease: ADMIN_RELEASE,
        width: layout.viewportWidth,
        height: layout.viewportHeight,
        viewportWidth: layout.viewportWidth,
        viewportHeight: layout.viewportHeight,
        timestamp: Date.now(),
      }, location.origin);
      try { iframe.contentWindow.dispatchEvent(new Event("resize")); } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  }

  function scheduleFrameLayoutSync(tab, reason = "layout-sync") {
    if (!tab || state.controlSurface || tab.id !== state.activeTabId || tab.status === "error") return;
    stopFrameLayoutTimer();
    const startedAt = performance.now();
    const maxAttempts = 45;
    frameLayoutAttempt = 0;
    const tick = () => {
      frameLayoutTimer = 0;
      frameLayoutAttempt += 1;
      const layout = activeFrameLayout(tab);
      if (layout.usable) {
        const sent = dispatchChildResize(tab, reason, frameLayoutAttempt);
        if (sent) {
          delete tab.frameViewportUnavailable;
          if (tab.status === "loading" || tab.status === "layout-wait") {
            setTabStatus(tab.id, "ready");
          }
          setFrameNotice(tab, false);
          try {
            const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
            if (iframe && !iframe.dataset.readyBridgeSent) {
              iframe.dataset.readyBridgeSent = "1";
              postToChild(tab, { type: "ww-admin-browser-ready", tabId: tab.id, reason: "frame-layout-ready" });
            }
          } catch (_) {}
          updateToolbar(tab);
          renderTabs();
          return;
        }
      }

      if (frameLayoutAttempt < maxAttempts && performance.now() - startedAt < 2400) {
        frameLayoutTimer = requestAnimationFrame(tick);
        return;
      }

      tab.frameViewportUnavailable = true;
      if (tab.status !== "error") {
        tab.status = "layout-wait";
        renderTabs();
      }
      setFrameNotice(
        tab,
        true,
        "กำลังรอพื้นที่แสดงผลของแท็บเกม",
        `พื้นที่ Internal Browser ยังวัดขนาดไม่ได้ (stage ${Math.round(layout.stageWidth)}×${Math.round(layout.stageHeight)}, frame ${Math.round(layout.frameWidth)}×${Math.round(layout.frameHeight)}) ระบบจะลองจัด layout ใหม่เมื่อพื้นที่พร้อม`
      );
      try {
        window.WWReportError?.("admin_internal_browser_frame_viewport_unavailable", {
          message: "Internal Browser iframe has no usable layout box",
          context: { tabId: tab.id, page: tab.url, reason, attempt: frameLayoutAttempt, layout },
        });
      } catch (_) {}
    };
    frameLayoutTimer = requestAnimationFrame(tick);
  }

  function setupFrameLayoutObserver() {
    if (frameLayoutObserver || typeof ResizeObserver === "undefined") return;
    const targets = [$("adminWorkspace"), $("adminBrowserView"), $("adminBrowserStage")].filter(Boolean);
    if (!targets.length) return;
    frameLayoutObserver = new ResizeObserver(() => {
      const tab = currentTab();
      if (tab && !state.controlSurface) scheduleFrameLayoutSync(tab, "parent-resize");
    });
    targets.forEach((target) => {
      try { frameLayoutObserver.observe(target, { box: "border-box" }); } catch (_) { frameLayoutObserver.observe(target); }
    });
    if (!frameLayoutResizeHandlerBound) {
      const handler = () => {
        const tab = currentTab();
        if (tab && !state.controlSurface) scheduleFrameLayoutSync(tab, "window-resize");
      };
      window.addEventListener("resize", handler, { passive: true });
      window.addEventListener("orientationchange", handler, { passive: true });
      window.visualViewport?.addEventListener("resize", handler, { passive: true });
      frameLayoutResizeHandlerBound = true;
    }
  }

  function syncFrameVisibility() {
    const stage = $("adminBrowserStage");
    if (!stage) return;
    state.tabs.forEach((item) => {
      const iframe = stage.querySelector(`[data-browser-frame="${CSS.escape(item.id)}"]`);
      if (!iframe) return;
      const active = item.id === state.activeTabId && !state.controlSurface;
      iframe.classList.toggle("active", active);
      iframe.hidden = !active;
    });
  }

  function renderFrame(tab) {
    const stage = $("adminBrowserStage");
    if (!stage || !tab) return;
    syncFrameVisibility();
    let iframe = stage.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.className = "admin-browser-frame";
      iframe.dataset.browserFrame = tab.id;
      iframe.title = tab.title || "Internal game";
      iframe.allow = "fullscreen; gamepad; autoplay; clipboard-read; clipboard-write";
      iframe.referrerPolicy = "same-origin";
      iframe.addEventListener("load", () => handleFrameLoad(tab.id));
      iframe.addEventListener("error", () => handleFrameLoadError(tab.id, "iframe_error"));
      stage.appendChild(iframe);
    }
    const active = tab.id === state.activeTabId && !state.controlSurface;
    syncFrameVisibility();
    if (!active) return;
    applyFrameViewport(tab);

    const frameSrc = buildEmbeddedFrameUrl(tab.url);
    if (iframe.dataset.loadedSrc !== frameSrc) {
      tab.status = "loading";
      delete iframe.dataset.directFallbackTried;
      delete iframe.dataset.readyBridgeSent;
      delete tab.frameViewportUnavailable;
      iframe.dataset.loadedSrc = frameSrc;
      setFrameNotice(tab, false);
      iframe.src = frameSrc;
      return;
    }
    scheduleFrameLayoutSync(tab, "frame-visible");
  }

  function removeFrame(tabId) {
    const stage = $("adminBrowserStage");
    stage?.querySelector(`[data-browser-frame="${CSS.escape(tabId)}"]`)?.remove();
  }

  function setTabStatus(tabId, status) {
    const tab = state.tabs.find((x) => x.id === tabId);
    if (!tab) return;
    tab.status = status;
    renderTabs();
  }

  function postToChild(tab, message) {
    try {
      const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
      iframe?.contentWindow?.postMessage(message, location.origin);
    } catch (_) {}
  }

  function handleFrameLoadError(tabId, reason) {
    const tab = state.tabs.find((x) => x.id === tabId);
    if (!tab) return;
    const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tabId)}"]`);
    // First load uses the canonical game pathname with an Admin release marker.
    // Retry the exact canonical pathname once, without the marker, before showing
    // a visible failure surface. This handles stale/query-hostile CDN behavior
    // without ever depending on a new Express route.
    if (iframe && !iframe.dataset.directFallbackTried && internalPageAllowed(tab.url)) {
      iframe.dataset.directFallbackTried = "1";
      delete iframe.dataset.readyBridgeSent;
      delete tab.frameViewportUnavailable;
      tab.status = "loading";
      const url = new URL(tab.url, location.origin);
      iframe.dataset.loadedSrc = `${url.pathname === "/" ? "/index.html" : url.pathname}${url.search}${url.hash}`;
      iframe.src = iframe.dataset.loadedSrc;
      delete tab.frameErrorReason;
      setFrameNotice(tab, false);
      renderTabs();
      return;
    }
    tab.frameErrorReason = String(reason || "unknown");
    setTabStatus(tabId, "error");
    setFrameNotice(
      tab,
      true,
      tab.type === "admin" ? "โหลดหน้า Admin ภายในไม่สำเร็จ" : "โหลดหน้าเกมภายในไม่สำเร็จ",
      `เส้นทาง ${sanitizeDisplayUrl(tab.url)} ตอบกลับแต่ไม่พบหน้า ${getFrameHealthContract(tab.type).page} ที่ถูกต้อง (${String(reason || "unknown")})`
    );
    try {
      window.WWReportError?.("admin_internal_browser_frame_load_failed", {
        message: "Internal Browser iframe load failed",
        context: { tabId: tab.id, page: tab.url, reason: String(reason || "unknown"), canonicalFrame: true, directFallbackTried: !!iframe?.dataset.directFallbackTried },
      });
    } catch (_) {}
  }

  function handleFrameLoad(tabId) {
    const tab = state.tabs.find((x) => x.id === tabId);
    if (!tab) return;
    const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tabId)}"]`);
    if (!iframe) return;
    const health = getFrameHealth(iframe, tab);
    if (!health.ok) {
      handleFrameLoadError(tabId, health.reason);
      return;
    }
    delete tab.frameErrorReason;
    tab.status = "layout-wait";
    tab.frameViewportUnavailable = false;
    setFrameNotice(tab, false);
    try {
      const child = iframe.contentWindow;
      const title = ["tester-host", "tester-player", "bot-player"].includes(tab.type)
        ? defaultTitleFor(child.location.href, tab.type)
        : (child.document.title || defaultTitleFor(child.location.href, tab.type));
      if (title) tab.title = cleanTitle(title, tab.type);
      tab.url = child.location.href;
      tab.displayUrl = sanitizeDisplayUrl(tab.url);
      const p = child.location.pathname;
      if (TESTER_PATHS.has(p) && tab.type === "game") tab.type = p.endsWith("host.html") ? "tester-host" : "tester-player";
      wireChildBrowserHooks(tab, child);
    } catch (_) {
      // Same-origin content is expected; if a browser changes that contract the
      // explicit health check above will keep the tab from silently becoming black.
    }
    updateToolbar(tab);
    renderTabs();
    scheduleFrameLayoutSync(tab, "frame-load");
  }

  function cleanTitle(title, type) {
    const value = String(title || "").replace(/\s+/g, " ").trim();
    if (!value) return defaultTitleFor("/", type);
    if (value.length <= 30) return value;
    return value.slice(0, 29) + "…";
  }

  function wireChildBrowserHooks(tab, child) {
    try {
      if (child.__wwAdminBrowserWired) return;
      child.__wwAdminBrowserWired = true;

      const originalOpen = child.open;
      child.open = function (url, target, features) {
        const raw = String(url || "");
        if (internalPageAllowed(raw)) {
          const newTab = openUrl(raw, { source: "child-window", parentTabId: tab.id });
          if (!newTab) return null;
          return makeChildWindowProxy(newTab.id);
        }
        if (typeof originalOpen === "function") return originalOpen.call(child, url, target, features);
        return null;
      };

      const doc = child.document;
      doc.addEventListener("click", (event) => {
        const anchor = event.target?.closest?.('a[target="_blank"]');
        if (!anchor) return;
        if (!internalPageAllowed(anchor.href)) return;
        event.preventDefault();
        event.stopPropagation();
        openUrl(anchor.href, { source: "child-link", parentTabId: tab.id });
      }, true);

      const notify = () => {
        try {
          const currentUrl = child.location.href;
          tab.url = currentUrl;
          tab.displayUrl = sanitizeDisplayUrl(currentUrl);
          const nextTitle = ["tester-host", "tester-player", "bot-player"].includes(tab.type)
            ? defaultTitleFor(child.location.href, tab.type)
            : (child.document.title || tab.title);
          tab.title = cleanTitle(nextTitle, tab.type);
          updateToolbar(tab);
          renderTabs();
        } catch (_) {}
      };
      child.addEventListener("hashchange", notify);
      child.addEventListener("popstate", notify);
      child.addEventListener("keydown", onKeydown);
    } catch (_) {}
  }

  function makeChildWindowProxy(tabId) {
    const proxy = {
      focus() { activateTab(tabId); },
      close() { closeTab(tabId); },
    };
    Object.defineProperty(proxy, "closed", {
      enumerable: true,
      get() { return !state.tabs.some((tab) => tab.id === tabId); },
    });
    Object.defineProperty(proxy, "location", {
      get() {
        return {
          set href(value) {
            navigateTab(tabId, String(value || ""));
          }
        };
      }
    });
    return proxy;
  }

  function openUrl(url, options = {}) {
    closeViewportMenus();
    if (!internalPageAllowed(url)) return null;
    const urlObj = new URL(url, location.origin);
    const normalizedUrl = isAdminPath(urlObj.pathname) ? canonicalizeAdminUrl(urlObj.href, options.embedId || "") : urlObj.href;
    if (!normalizedUrl) return null;
    if (state.tabs.length >= MAX_TABS) {
      window.wwToast?.(`เปิดได้สูงสุด ${MAX_TABS} แท็บใน Admin`, {type: "warning"});
      return null;
    }
    const parent = options.parentTabId || "";
    const inferredType = isAdminPath(new URL(normalizedUrl, location.origin).pathname) ? "admin" : "";
    const type = options.type || inferredType || "game";
    const tab = {
      id: options.tabId || makeId("tab"),
      type,
      role: options.role || "",
      title: options.title || defaultTitleFor(url, type),
      icon: options.icon || (type === "tester-host" ? "🎮" : type === "tester-player" || type === "bot-player" ? "👤" : type === "admin" ? "🛡️" : "🏠"),
      url: String(normalizedUrl),
      displayUrl: sanitizeDisplayUrl(normalizedUrl),
      launchId: options.launchId || "",
      embedId: options.embedId || "",
      parentTabId: parent,
      status: "loading",
      closable: options.closable !== false,
      pinned: !!options.pinned,
      persistent: options.persistent !== false && type !== "bot-player",
      createdAt: Date.now(),
      viewport: normalizeViewport(options.viewport),
    };
    state.tabs.push(tab);
    state.activeTabId = tab.id;
    if (options.showBrowser !== false) showSurface(true);
    renderTabs();
    renderFrame(tab);
    applyFrameViewport(tab);
    updateViewportControls(tab);
    updateToolbar(tab);
    persistMeta();
    emit("tab-open", tab);
    return tab;
  }

  async function getTesterPass() {
    const provider = window.WWAdminTesterAuth;
    if (provider?.getPass) return provider.getPass();
    throw new Error("TESTER_PASS_PROVIDER_MISSING");
  }

  async function openTester(role) {
    const kind = role === "player" ? "tester-player" : "tester-host";
    const tabId = makeId("tab");
    const launchId = makeId("launch");
    try {
      const pass = await getTesterPass();
      if (!pass?.token) throw new Error("TESTER_PASS_MISSING");
      const controllerId = window.WWAdminTesterAuth?.controllerId?.() || "";
      const url = buildUrl(kind, {testerPass: pass.token, tabId, launchId, controllerId});
      const tab = openUrl(url, {type: kind, role, tabId, launchId, title: role === "player" ? "Tester Player" : "Tester Host", icon: role === "player" ? "👤" : "🎮"});
      if (!tab) throw new Error("INTERNAL_TAB_OPEN_FAILED");
      window.wwToast?.(`เปิด ${role === "player" ? "Tester Player" : "Tester Host"} ในแท็บภายในแล้ว`, {type:"success"});
      return tab;
    } catch (error) {
      state.activeTabId = state.tabs.find((x) => x.id === tabId)?.id || state.activeTabId;
      throw error;
    }
  }

  async function openBot(options = {}) {
    const tabId = makeId("tab");
    const launchId = makeId("launch");
    const pass = options.testerPass ? {token: options.testerPass} : await getTesterPass();
    if (!pass?.token) throw new Error("TESTER_PASS_MISSING");
    const controllerId = window.WWAdminTesterAuth?.controllerId?.() || "";
    const url = buildUrl("tester-player", {
      testerPass: pass.token,
      tabId,
      launchId,
      controllerId,
      botToken: options.botToken,
      roomId: options.roomId,
      hostControllerId: options.hostTabId || "",
    });
    const tab = openUrl(url, {
      type: "bot-player",
      role: "player",
      tabId,
      launchId,
      title: options.title || "Tester Bot",
      icon: "🤖",
      persistent: false,
    });
    if (!tab) throw new Error("INTERNAL_TAB_OPEN_FAILED");
    return tab;
  }

  function openAdmin() {
    if (!canOpenAdminPage()) {
      window.wwToast?.("Admin ภายในระดับนี้ไม่สามารถเปิดซ้ำซ้อนเพิ่มได้", {type:"warning"});
      return null;
    }
    const tabId = makeId("tab");
    const embedId = makeId("admin-embed");
    const url = buildAdminUrl({embedId});
    const tab = openUrl(url, {
      type:"admin",
      tabId,
      embedId,
      title:"Admin",
      icon:"🛡️",
      persistent:true,
      viewport:{mode:"auto"},
    });
    if (tab) window.wwToast?.("เปิด Admin ใน iframe ภายในแล้ว", {type:"success"});
    return tab;
  }

  function openGame() {
    let tab = state.tabs.find((x) => x.type === "game");
    if (tab) {
      activateTab(tab.id);
      return tab;
    }
    return openUrl(DEFAULT_GAME, {type:"game", title:"Werewolf-Online", icon:"🏠", persistent:true});
  }

  function activateTab(tabId) {
    closeViewportMenus();
    const tab = state.tabs.find((x) => x.id === tabId);
    if (!tab) return;
    state.activeTabId = tab.id;
    persistMeta();
    showSurface(true);
    syncFrameVisibility();
    renderTabs();
    renderFrame(tab);
    applyFrameViewport(tab);
    updateViewportControls(tab);
    updateToolbar(tab);
    if (tab.status === "error") {
      setFrameNotice(tab, true, tab.type === "admin" ? "โหลดหน้า Admin ภายในไม่สำเร็จ" : "โหลดหน้าเกมภายในไม่สำเร็จ", `เส้นทาง ${sanitizeDisplayUrl(tab.url)} ตอบกลับแต่ไม่พบหน้า ${getFrameHealthContract(tab.type).page} ที่ถูกต้อง (${tab.frameErrorReason || "unknown"})`);
    } else {
      setFrameNotice(tab, false);
    }
    try {
      $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`)?.focus();
    } catch (_) {}
  }

  function activateRelativeTab(delta) {
    if (!state.tabs.length) return null;
    const currentIndex = Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeTabId));
    const offset = Number(delta) || 1;
    const nextIndex = (currentIndex + offset + state.tabs.length) % state.tabs.length;
    const tab = state.tabs[nextIndex];
    activateTab(tab.id);
    return tab;
  }

  function closeTab(tabId) {
    const index = state.tabs.findIndex((x) => x.id === tabId);
    if (index < 0) return;
    const tab = state.tabs[index];
    if (tab.closable === false) return;
    removeFrame(tabId);
    state.tabs.splice(index, 1);
    if (!state.tabs.length) {
      openGame();
      return;
    }
    if (state.activeTabId === tabId) {
      const next = state.tabs[index] || state.tabs[index - 1] || state.tabs[0];
      state.activeTabId = next.id;
    }
    persistMeta();
    renderTabs();
    activateTab(state.activeTabId);
    emit("tab-close", tab);
  }

  function closeOthers(tabId) {
    const keep = state.tabs.find((x) => x.id === tabId);
    if (!keep) return;
    state.tabs.filter((x) => x.id !== tabId && x.closable !== false).forEach((x) => removeFrame(x.id));
    state.tabs = state.tabs.filter((x) => x.id === tabId || x.closable === false);
    if (!state.tabs.some((x) => x.id === tabId)) state.tabs.push(keep);
    state.activeTabId = tabId;
    persistMeta();
    renderTabs();
    activateTab(tabId);
  }

  function navigateTab(tabId, rawUrl) {
    const tab = state.tabs.find((x) => x.id === tabId);
    if (!tab || !internalPageAllowed(rawUrl)) return false;
    const rawObj = new URL(rawUrl, location.origin);
    const normalizedUrl = isAdminPath(rawObj.pathname) ? canonicalizeAdminUrl(rawObj.href, tab.embedId || "") : rawObj.href;
    if (!normalizedUrl) return false;
    const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tabId)}"]`);
    if (!iframe) return false;
    tab.url = String(normalizedUrl);
    tab.type = isAdminPath(new URL(tab.url, location.origin).pathname) ? "admin" : tab.type;
    tab.displayUrl = sanitizeDisplayUrl(tab.url);
    tab.status = "loading";
    delete iframe.dataset.directFallbackTried;
    iframe.dataset.loadedSrc = "";
    iframe.src = buildEmbeddedFrameUrl(tab.url);
    applyFrameViewport(tab);
    updateViewportControls(tab);
    updateToolbar(tab);
    renderTabs();
    return true;
  }

  function reloadActive() {
    const tab = currentTab();
    if (!tab) return;
    const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
    if (!iframe) return;
    tab.status = "loading";
    delete iframe.dataset.directFallbackTried;
    setFrameNotice(tab, false);
    iframe.dataset.loadedSrc = buildEmbeddedFrameUrl(tab.url);
    iframe.src = iframe.dataset.loadedSrc;
    applyFrameViewport(tab);
    updateViewportControls(tab);
    renderTabs();
  }

  function historyAction(action) {
    const tab = currentTab();
    if (!tab) return;
    const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
    try {
      if (action === "back") iframe.contentWindow.history.back();
      if (action === "forward") iframe.contentWindow.history.forward();
    } catch (_) {}
  }

  function updateToolbar(tab) {
    const address = $("adminBrowserAddress");
    const title = $("adminBrowserPageTitle");
    if (address) address.value = tab?.displayUrl || "/";
    if (title) title.textContent = tab?.title || "Internal Browser";
    const badge = $("adminBrowserPageStatus");
    if (badge) badge.dataset.status = tab?.status || "ready";
  }

  function showNewTabMenu(open) {
    const menu = $("adminBrowserNewTabMenu");
    if (!menu) return;
    menu.hidden = !open;
    if (open) menu.querySelector("button")?.focus();
  }

  function activateControlCenter() {
    const target = state.lastControlTab && state.lastControlTab !== "browser" ? state.lastControlTab : "overview";
    showSurface(false);
    try { window.switchTab?.(target); } catch (_) {}
  }

  function handleMessage(event) {
    if (event.origin !== location.origin) return;
    const data = event.data || {};
    if (!String(data.type || "").startsWith("ww-admin-browser-")) return;
    if (data.tabId) {
      const frame = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(String(data.tabId))}"]`);
      if (!frame || !event.source || frame.contentWindow !== event.source) return;
    }
    if (data.type === "ww-admin-browser-return-admin") {
      activateControlCenter();
      return;
    }
    if (data.type === "ww-admin-browser-return-host") {
      if (data.targetTabId) activateTab(String(data.targetTabId));
      else activateControlCenter();
      return;
    }
    if (data.type === "ww-admin-browser-title") {
      const tab = state.tabs.find((x) => x.id === String(data.tabId));
      if (!tab) return;
      if (data.title) tab.title = cleanTitle(data.title, tab.type);
      if (data.url) {
        tab.url = String(data.url);
        tab.displayUrl = sanitizeDisplayUrl(tab.url);
      }
      renderTabs();
      updateToolbar(tab);
    }
    if (data.type === "ww-admin-browser-status") {
      setTabStatus(String(data.tabId || ""), String(data.status || "ready"));
    }
  }

  const HTML2CANVAS_SOURCES = [
    {
      src:"https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
      integrity:"sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==",
    },
    {
      src:"https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
      integrity:"sha512-BNaRQnYJYiPSqHHDb58B0yaPfCu+Wgds8Gp/gU33kqBtgNS4tSPHuGibyoeqMV/TJlSKda6FXzoEyYGjTe+vXA==",
    },
  ];
  let html2CanvasLoadPromise = null;
  const CAPTURE_READY_BUDGET_MS = 360;
  const CAPTURE_FONT_WAIT_MS = 180;
  const CAPTURE_IMAGE_WAIT_MS = 260;
  const CAPTURE_MAX_TRACKED_IMAGES = 64;

  function captureErrorMessage(error) {
    const name = String(error?.name || "Error");
    const message = String(error?.message || error || "ไม่ทราบสาเหตุ");
    return `${name}: ${message}`.slice(0, 240);
  }

  function sanitizeFilePart(value, fallback = "untitled") {
    const safe = String(value || "")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    return safe || fallback;
  }

  function getCaptureOrientation(resolved) {
    if (!resolved) return "Unknown";
    return Number(resolved.width) >= Number(resolved.height) ? "Landscape" : "Portrait";
  }

  function getCaptureMetadata(tab, resolved) {
    const viewport = normalizeViewport(tab?.viewport);
    const width = Math.max(1, Math.round(Number(resolved?.width) || 0));
    const height = Math.max(1, Math.round(Number(resolved?.height) || 0));
    const preset = viewport.mode === "preset" ? VIEWPORT_PRESETS.find((item) => item.id === viewport.presetId) : null;
    return {
      width,
      height,
      mode: viewport.mode,
      presetId: viewport.presetId || "",
      presetLabel: preset?.label || (viewport.mode === "custom" ? "กำหนดเอง" : "Auto"),
      orientation: getCaptureOrientation({width, height}),
      zoom: resolved?.zoom === 1 ? "100%" : `${Math.round(Number(resolved?.zoom || 1) * 100)}%`,
      title: String(tab?.title || "Internal Browser"),
      path: sanitizeDisplayUrl(tab?.url || DEFAULT_GAME),
      capturedAt: new Date().toISOString(),
      dpr: Math.max(0.1, Math.min(10, Number(window.devicePixelRatio) || 1)),
      browser: String(navigator.userAgent || '').slice(0, 240),
    };
  }

  function ensureHtml2Canvas() {
    if (typeof window.html2canvas === "function") return Promise.resolve(window.html2canvas);
    if (html2CanvasLoadPromise) return html2CanvasLoadPromise;
    html2CanvasLoadPromise = new Promise(async (resolve, reject) => {
      let lastError = null;
      for (const source of HTML2CANVAS_SOURCES) {
        try {
          await new Promise((res, rej) => {
            const existing = [...document.scripts].find((node) => node.src === source.src);
            if (existing) {
              if (typeof window.html2canvas === "function") return res();
              existing.addEventListener("load", res, {once:true});
              existing.addEventListener("error", () => rej(new Error(`HTML2CANVAS_LOAD_FAILED:${source.src}`)), {once:true});
              return;
            }
            const script = document.createElement("script");
            script.src = source.src;
            script.integrity = source.integrity;
            script.crossOrigin = "anonymous";
            script.async = true;
            script.onload = () => res();
            script.onerror = () => rej(new Error(`HTML2CANVAS_LOAD_FAILED:${source.src}`));
            document.head.appendChild(script);
          });
          if (typeof window.html2canvas === "function") return resolve(window.html2canvas);
        } catch (error) {
          lastError = error;
        }
      }
      reject(lastError || new Error("HTML2CANVAS_UNAVAILABLE"));
    }).finally(() => { html2CanvasLoadPromise = null; });
    return html2CanvasLoadPromise;
  }

  function scheduleHtml2CanvasWarmup() {
    if (typeof window.html2canvas === "function" || html2CanvasLoadPromise) return;
    const start = () => { void ensureHtml2Canvas().catch(() => {}); };
    try {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(start, {timeout:900});
        return;
      }
    } catch (_) {}
    window.setTimeout(start, 250);
  }

  function withCaptureTimeout(promise, timeoutMs) {
    const safeMs = Math.max(0, Number(timeoutMs) || 0);
    if (!safeMs) return Promise.resolve({value:undefined, timedOut:true});
    return new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({value:undefined, timedOut:true});
      }, safeMs);
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({value, timedOut:false});
      }, () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({value:undefined, timedOut:false});
      });
    });
  }

  function captureImageIsVisible(img, child, metadata) {
    try {
      const width = Math.max(1, Number(metadata?.width) || Number(child?.innerWidth) || 390);
      const height = Math.max(1, Number(metadata?.height) || Number(child?.innerHeight) || 844);
      const rect = img.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return false;
      return rect.bottom > -32 && rect.right > -32 && rect.top < height + 32 && rect.left < width + 32;
    } catch (_) {
      return true;
    }
  }

  function waitForImageReady(img) {
    if (!img || img.complete) return Promise.resolve();
    if (typeof img.decode === "function") {
      return img.decode().catch(() => new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener("load", done, {once:true});
        img.addEventListener("error", done, {once:true});
      }));
    }
    return new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener("load", done, {once:true});
      img.addEventListener("error", done, {once:true});
    });
  }

  async function waitForFrameCaptureReady(child, metadata) {
    const startedAt = performance.now();
    const diagnostics = {fontTimedOut:false, imageTimedOut:false, pendingImages:0, waitedMs:0};
    try {
      const fonts = child.document?.fonts;
      if (fonts && fonts.status !== "loaded") {
        const fontResult = await withCaptureTimeout(fonts.ready, Math.min(CAPTURE_FONT_WAIT_MS, CAPTURE_READY_BUDGET_MS));
        diagnostics.fontTimedOut = !!fontResult.timedOut;
      }
    } catch (_) {}

    try {
      const pendingImages = [...(child.document?.images || [])]
        .filter((img) => !img.complete && captureImageIsVisible(img, child, metadata))
        .slice(0, CAPTURE_MAX_TRACKED_IMAGES);
      diagnostics.pendingImages = pendingImages.length;
      const remainingBudget = Math.max(0, CAPTURE_READY_BUDGET_MS - (performance.now() - startedAt));
      if (pendingImages.length && remainingBudget > 0) {
        const imageResult = await withCaptureTimeout(
          Promise.all(pendingImages.map(waitForImageReady)),
          Math.min(CAPTURE_IMAGE_WAIT_MS, remainingBudget),
        );
        diagnostics.imageTimedOut = !!imageResult.timedOut;
      }
    } catch (_) {}

    await new Promise((resolve) => requestAnimationFrame(resolve));
    diagnostics.waitedMs = Math.round(performance.now() - startedAt);
    return diagnostics;
  }

  const CAPTURE_SCROLL_ATTRIBUTE = "data-ww-capture-scroll-id";

  function getCaptureScrollCandidates(child) {
    const doc = child?.document;
    if (!doc) return [];
    const candidates = [];
    const seen = new Set();
    const add = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      candidates.push(node);
    };
    add(doc.scrollingElement);
    add(doc.documentElement);
    add(doc.body);
    try {
      doc.querySelectorAll("*").forEach(add);
    } catch (_) {}
    return candidates;
  }

  function snapshotCaptureScrollState(child) {
    const entries = [];
    let sequence = 0;
    for (const node of getCaptureScrollCandidates(child)) {
      let scrollLeft = 0;
      let scrollTop = 0;
      let scrollableX = false;
      let scrollableY = false;
      try {
        scrollLeft = Number(node.scrollLeft) || 0;
        scrollTop = Number(node.scrollTop) || 0;
        scrollableX = Number(node.scrollWidth) > Number(node.clientWidth) + 1;
        scrollableY = Number(node.scrollHeight) > Number(node.clientHeight) + 1;
      } catch (_) {}
      if (!scrollableX && !scrollableY && scrollLeft === 0 && scrollTop === 0) continue;

      const hadAttribute = node.hasAttribute(CAPTURE_SCROLL_ATTRIBUTE);
      const previousAttribute = hadAttribute ? node.getAttribute(CAPTURE_SCROLL_ATTRIBUTE) : null;
      const id = `ww-capture-scroll-${++sequence}`;
      try {
        node.setAttribute(CAPTURE_SCROLL_ATTRIBUTE, id);
        entries.push({node, id, scrollLeft, scrollTop, hadAttribute, previousAttribute});
      } catch (_) {}
    }
    return entries;
  }

  function restoreCaptureScrollAttributes(entries) {
    for (const entry of entries || []) {
      try {
        if (entry.hadAttribute) entry.node.setAttribute(CAPTURE_SCROLL_ATTRIBUTE, String(entry.previousAttribute ?? ""));
        else entry.node.removeAttribute(CAPTURE_SCROLL_ATTRIBUTE);
      } catch (_) {}
    }
  }

  function restoreCaptureScrollStateIntoClone(clonedDocument, entries) {
    if (!clonedDocument || !Array.isArray(entries) || !entries.length) return;
    const cloneMap = new Map();
    try {
      clonedDocument.querySelectorAll(`[${CAPTURE_SCROLL_ATTRIBUTE}]`).forEach((node) => {
        const id = node.getAttribute(CAPTURE_SCROLL_ATTRIBUTE);
        if (id) cloneMap.set(id, node);
      });
    } catch (_) {}
    for (const entry of entries) {
      const clone = cloneMap.get(entry.id);
      if (!clone) continue;
      try { clone.scrollLeft = entry.scrollLeft; } catch (_) {}
      try { clone.scrollTop = entry.scrollTop; } catch (_) {}
    }
  }

  function getCaptureFileName(metadata, mode) {
    const stamp = metadata.capturedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const page = sanitizeFilePart(metadata.title, "page");
    const suffix = mode === "evidence" ? "evidence" : "game";
    return `werewolf-${page}-${metadata.width}x${metadata.height}-${stamp}-${suffix}.png`;
  }

  function saveCaptureBlob(blob, fileName) {
    if (!(blob instanceof Blob) || !blob.size) throw new Error("CAPTURE_BLOB_MISSING");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return fileName;
  }

  function captureModeLabel(mode) {
    return mode === "game" ? "Game Only" : "Evidence";
  }

  function getSelectedCapturePresets() {
    const ids = Array.isArray(state.capturePresetIds) ? state.capturePresetIds : [];
    const selected = [];
    const seen = new Set();
    for (const id of ids) {
      const preset = VIEWPORT_PRESETS.find((item) => item.id === String(id));
      if (!preset || seen.has(preset.id)) continue;
      seen.add(preset.id);
      selected.push(preset);
    }
    return selected;
  }

  function captureUiButtonBusy(button, text) {
    if (!button) return;
    button.disabled = true;
    button.dataset.busy = "1";
    const label = button.querySelector("span");
    if (label) label.textContent = text.replace(/^📷\s*/, "");
    else button.textContent = text;
  }

  function updateCaptureButtonLabel() {
    const button = $("adminBrowserCaptureBtn");
    if (!button) return;
    const label = button.querySelector("span");
    const selectedCount = getSelectedCapturePresets().length;
    if (state.captureInFlight) {
      if (label) label.textContent = selectedCount > 0 ? `กำลังแคป ${selectedCount} ขนาด…` : "กำลังแคป…";
      button.title = selectedCount > 0
        ? `กำลังแคป ${selectedCount} ขนาดที่เลือกไว้`
        : "กำลังแคปภาพแท็บปัจจุบัน";
      return;
    }
    if (label) label.textContent = selectedCount > 0 ? `แคป ${selectedCount} ขนาด` : "แคปภาพ";
    button.title = selectedCount > 0
      ? `แคปภาพตาม ${selectedCount} ขนาดจอที่เลือกไว้`
      : "แคปภาพแท็บปัจจุบันตามขนาด Viewport ที่กำลังแสดง";
  }

  function setCapturePresetSelection(ids, {announce = true} = {}) {
    const validIds = [];
    const seen = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      const value = String(id || "");
      if (!VIEWPORT_PRESETS.some((item) => item.id === value) || seen.has(value)) continue;
      seen.add(value);
      validIds.push(value);
    }
    state.capturePresetIds = validIds;
    document.querySelectorAll?.('#adminBrowserCapturePresetList input[data-capture-preset]').forEach((input) => {
      input.checked = validIds.includes(String(input.value || ""));
    });
    const count = $("adminBrowserCapturePresetCount");
    if (count) count.textContent = validIds.length ? `เลือก ${validIds.length} ขนาด · กดแคปเพื่อเริ่ม` : "ไม่เลือก = แคปขนาดปัจจุบัน";
    const clear = $("adminBrowserCapturePresetClearBtn");
    const all = $("adminBrowserCapturePresetAllBtn");
    if (clear) clear.disabled = validIds.length === 0;
    if (all) all.disabled = validIds.length === VIEWPORT_PRESETS.length;
    updateCaptureButtonLabel();
    if (announce) {
      try {
        window.dispatchEvent(new CustomEvent("ww-admin-browser-capture-selection", {detail:{presetIds:[...validIds]}}));
      } catch (_) {}
    }
  }

  function renderCapturePresetOptions() {
    const list = $("adminBrowserCapturePresetList");
    if (!list) return;
    const selected = new Set(state.capturePresetIds || []);
    const groups = [];
    const byGroup = new Map();
    VIEWPORT_PRESETS.forEach((preset) => {
      const key = String(preset.group || "อื่น ๆ");
      if (!byGroup.has(key)) {
        const group = {label:key, items:[]};
        byGroup.set(key, group);
        groups.push(group);
      }
      byGroup.get(key).items.push(preset);
    });
    list.innerHTML = groups.map((group) => `
      <section class="admin-browser-capture-preset-group" data-capture-group="${esc(group.label)}">
        <div class="admin-browser-capture-preset-group-label">${esc(group.label)}</div>
        <div class="admin-browser-capture-preset-grid">
          ${group.items.map((preset) => `
            <label class="admin-browser-capture-preset-option">
              <input type="checkbox" value="${esc(preset.id)}" data-capture-preset ${selected.has(preset.id) ? "checked" : ""}/>
              <span class="admin-browser-capture-preset-copy">
                <strong>${esc(preset.label)}</strong>
                <small>${preset.width} × ${preset.height}</small>
              </span>
            </label>`).join("")}
        </div>
      </section>`).join("");
    list.querySelectorAll('input[data-capture-preset]').forEach((input) => {
      input.addEventListener("change", () => {
        const next = [...list.querySelectorAll('input[data-capture-preset]:checked')].map((node) => String(node.value || ""));
        setCapturePresetSelection(next);
      });
    });
    setCapturePresetSelection([...selected], {announce:false});
  }

  function setCaptureMode(mode) {
    const normalized = String(mode || "evidence") === "game" ? "game" : "evidence";
    state.captureMode = normalized;
    document.querySelectorAll?.('#adminBrowserCaptureMenu [data-capture-mode]').forEach((button) => {
      const active = String(button.dataset.captureMode || "") === normalized;
      button.classList.toggle("is-selected", active);
      button.setAttribute("aria-checked", String(active));
    });
    return normalized;
  }

  function clearCaptureResultDom() {
    const resultList = $("adminBrowserCaptureResultList");
    if (resultList) resultList.innerHTML = "";
  }

  function captureResultSummary(items) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const ready = list.filter((item) => item?.status === "ready" || item?.status === "github-saved").length;
    const saved = list.filter((item) => item?.status === "github-saved").length;
    const failed = list.filter((item) => item?.status === "failed").length;
    const working = total - ready - failed;
    return {total, ready, saved, failed, working};
  }

  function captureResultItemStatusText(item) {
    switch (item?.status) {
      case "github-saved": return "✅ GitHub แล้ว";
      case "ready": return "✅ PNG พร้อม";
      case "failed": return "❌ ล้มเหลว";
      case "capturing": return "📷 กำลังแคป…";
      case "encoding": return "⚙️ กำลังเตรียม PNG…";
      case "github": return "🐙 กำลังส่ง GitHub…";
      default: return "⏳ รอดำเนินการ";
    }
  }

  function renderCaptureResult() {
    const result = $("adminBrowserCaptureResult");
    const meta = $("adminBrowserCaptureMeta");
    const title = $("adminBrowserCaptureResultTitle");
    const list = $("adminBrowserCaptureResultList");
    const save = $("adminBrowserCaptureSaveBtn");
    const github = $("adminBrowserCaptureGithubBtn");
    const close = $("adminBrowserCaptureCloseBtn");
    if (!result || !meta || !title || !list || !save || !github) throw new Error("CAPTURE_RESULT_UI_MISSING");

    const items = Array.isArray(state.lastCaptureBatch?.items) ? state.lastCaptureBatch.items : [];
    const summary = captureResultSummary(items);
    const mode = captureModeLabel(state.lastCaptureBatch?.mode);
    const batch = items.length > 1;
    title.textContent = batch ? `📷 ภาพที่แคปได้ · ${items.length} ขนาด` : "📷 ภาพที่แคปได้";
    meta.textContent = batch
      ? `${mode} · ${summary.ready}/${summary.total} PNG พร้อม · ${summary.failed ? `${summary.failed} ล้มเหลว` : "ไม่มีรายการล้มเหลว"}`
      : (items[0]?.capture ? `Page ${items[0].capture.page} · ${items[0].capture.width} × ${items[0].capture.height} CSS px · DPR ${items[0].capture.dpr} · ${items[0].capture.presetLabel} · ${items[0].capture.orientation} · ${mode}` : "กำลังเตรียมภาพ…");

    list.innerHTML = items.map((item, index) => {
      const capture = item.capture || {};
      const ready = item.status === "ready" || item.status === "github-saved";
      const failed = item.status === "failed";
      const githubSaved = item.status === "github-saved";
      const label = capture.presetLabel || (capture.width && capture.height ? `${capture.width} × ${capture.height}` : "ขนาดปัจจุบัน");
      const error = failed ? `<div class="admin-browser-capture-item-error">${esc(item.error || "ไม่ทราบสาเหตุ")}</div>` : "";
      return `<div class="admin-browser-capture-item ${failed ? "is-failed" : ""}" data-capture-item-index="${index}">
        <div class="admin-browser-capture-item-main">
          <div class="admin-browser-capture-item-title"><strong>${esc(label)}</strong><span>${esc(capture.width && capture.height ? `${capture.width} × ${capture.height}` : "")}</span></div>
          <div class="admin-browser-capture-item-status">${captureResultItemStatusText(item)}</div>
          ${error}
        </div>
        <div class="admin-browser-capture-item-actions">
          <button type="button" class="admin-browser-capture-item-download" data-capture-download-index="${index}" ${ready ? "" : "disabled"}>⬇️</button>
          ${githubSaved ? "<span class=\"admin-browser-capture-item-done\">GitHub</span>" : ""}
        </div>
      </div>`;
    }).join("");

    const anyReady = items.some((item) => item?.blob instanceof Blob && item.blob.size > 0);
    const hasUploadable = items.some((item) => item?.blob instanceof Blob && item.blob.size > 0 && item.status !== "github-saved");
    const allCaptureSettled = items.length > 0 && items.every((item) => ["ready", "failed", "github-saved"].includes(item?.status));
    save.disabled = !anyReady || !allCaptureSettled;
    save.textContent = batch ? "⬇️ ดาวน์โหลดทั้งหมด" : "⬇️ ดาวน์โหลด PNG";
    github.disabled = !hasUploadable || !allCaptureSettled || state.captureGithubInFlight;
    github.textContent = batch ? "🐙 เอาทั้งหมดเข้า GitHub" : "🐙 เอาเข้า GitHub";
    github.dataset.busy = state.captureGithubInFlight ? "1" : "0";
    if (close) close.disabled = !allCaptureSettled || state.captureGithubInFlight;
    result.hidden = false;
  }

  function openCaptureResultShell(mode, expectedCount = 1) {
    state.lastCaptureBatch = {
      mode: mode === "game" ? "game" : "evidence",
      expectedCount: Math.max(1, Number(expectedCount) || 1),
      items: [],
      startedAt: new Date().toISOString(),
    };
    clearCaptureResultDom();
    const result = $("adminBrowserCaptureResult");
    if (result) result.hidden = false;
    renderCaptureResult();
  }

  function closeCaptureResult() {
    if (state.captureInFlight || state.captureGithubInFlight) return false;
    const result = $("adminBrowserCaptureResult");
    if (result) result.hidden = true;
    state.lastCaptureBatch = null;
    state.lastCaptureBlob = null;
    state.lastCaptureGithub = null;
    state.lastCapture = null;
    state.lastCaptureTiming = null;
    clearCaptureResultDom();
    return true;
  }

  function addCaptureBatchItem(item) {
    if (!state.lastCaptureBatch) state.lastCaptureBatch = {mode:item?.capture?.mode || "evidence", expectedCount:1, items:[]};
    state.lastCaptureBatch.items.push(item);
    renderCaptureResult();
  }

  function readLiveCaptureViewport(child, fallback = {}) {
    const fallbackWidth = Math.max(1, Math.round(Number(fallback.width) || 1));
    const fallbackHeight = Math.max(1, Math.round(Number(fallback.height) || 1));
    let width = fallbackWidth;
    let height = fallbackHeight;
    let visualScale = 1;
    let visualOffsetX = 0;
    let visualOffsetY = 0;
    try {
      width = Math.max(1, Math.round(Number(child?.innerWidth) || fallbackWidth));
      height = Math.max(1, Math.round(Number(child?.innerHeight) || fallbackHeight));
    } catch (_) {}
    try {
      const vv = child?.visualViewport;
      if (vv) {
        const vvWidth = Number(vv.width);
        const vvHeight = Number(vv.height);
        if (vvWidth > 0 && vvHeight > 0) {
          width = Math.max(1, Math.round(vvWidth));
          height = Math.max(1, Math.round(vvHeight));
        }
        visualScale = Math.max(0.1, Math.min(10, Number(vv.scale) || 1));
        visualOffsetX = Number(vv.offsetLeft) || 0;
        visualOffsetY = Number(vv.offsetTop) || 0;
      }
    } catch (_) {}
    return {width, height, visualScale, visualOffsetX, visualOffsetY};
  }

  function buildCaptureScrollMetadata(child, scrollState, liveViewport) {
    let scrollX = 0;
    let scrollY = 0;
    try { scrollX = Number(child?.scrollX ?? child?.pageXOffset) || 0; } catch (_) {}
    try { scrollY = Number(child?.scrollY ?? child?.pageYOffset) || 0; } catch (_) {}
    const entries = Array.isArray(scrollState) ? scrollState : [];
    return {
      scrollX: Math.round(scrollX * 100) / 100,
      scrollY: Math.round(scrollY * 100) / 100,
      activeScrollContainers: entries.length,
      visualViewport: {
        width:Number(liveViewport?.width) || 0,
        height:Number(liveViewport?.height) || 0,
        scale:Number(liveViewport?.visualScale) || 1,
        offsetX:Number(liveViewport?.visualOffsetX) || 0,
        offsetY:Number(liveViewport?.visualOffsetY) || 0,
      },
    };
  }

  async function captureWithHtml2Canvas(child, metadata, mode) {
    const html2canvas = await ensureHtml2Canvas();
    const liveViewport = readLiveCaptureViewport(child, metadata);
    const scrollX = Number(child?.scrollX ?? child?.pageXOffset) || 0;
    const scrollY = Number(child?.scrollY ?? child?.pageYOffset) || 0;
    const scrollState = snapshotCaptureScrollState(child);
    let canvas;
    try {
      // html2canvas renders a cloned DOM rather than accessing the browser's native
      // screen framebuffer. Keep the clone's geometry identical to the live page;
      // only the requested viewport crop and the captured scroll offsets are supplied.
      // In particular, never force html/body to the viewport height/width because that
      // collapses the scroll range and changes what was actually visible at capture time.
      canvas = await html2canvas(child.document.documentElement, {
        backgroundColor:null,
        allowTaint:false,
        useCORS:true,
        scale:1,
        width:liveViewport.width,
        height:liveViewport.height,
        windowWidth:liveViewport.width,
        windowHeight:liveViewport.height,
        scrollX,
        scrollY,
        foreignObjectRendering:false,
        logging:false,
        removeContainer:true,
        onclone: (clonedDocument) => {
          // Preserve the page's real CSS/layout metrics. The clone should look like
          // the live viewport at the same scroll position, not like a new preset-sized
          // document with its root dimensions recalculated.
          restoreCaptureScrollStateIntoClone(clonedDocument, scrollState);
          const freeze = clonedDocument.createElement("style");
          freeze.textContent = "html{scroll-behavior:auto!important;}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}";
          clonedDocument.head?.appendChild(freeze);
          restoreCaptureScrollStateIntoClone(clonedDocument, scrollState);
        },
      });
    } finally {
      restoreCaptureScrollAttributes(scrollState);
    }
    const blobPromise = new Promise((resolve, reject) => {
      try {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("CAPTURE_PNG_ENCODE_FAILED")), "image/png");
      } catch (error) {
        reject(error);
      }
    });
    return {canvas, blobPromise, width:canvas.width, height:canvas.height, liveViewport, scroll:{scrollX, scrollY, activeScrollContainers:scrollState.length}};
  }

  function isScreenshotNetworkFetchError(error) {
    const name = String(error?.name || "");
    const message = String(error?.message || error || "");
    return name === "TypeError" || /Failed to fetch|Load failed|NetworkError|network request failed/i.test(message);
  }

  function getAdminScreenshotAuthHeaders() {
    const authHeaders = {};
    try {
      const auth = window.WWAdminTabAuth;
      const token = String(auth?.getToken?.() || "");
      const tabId = String(auth?.getTabId?.() || "");
      if (token) authHeaders.Authorization = `Bearer ${token}`;
      if (tabId) authHeaders["X-WW-Admin-Tab-Id"] = tabId;
    } catch (_) {}
    return authHeaders;
  }

  function uploadScreenshotGithubViaXhr(url, headers, blob) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.withCredentials = true;
      xhr.responseType = "text";
      const requestHeaders = { ...getAdminScreenshotAuthHeaders(), ...(headers || {}) };
      Object.entries(requestHeaders).forEach(([key, value]) => {
        try { xhr.setRequestHeader(key, String(value)); } catch (_) {}
      });
      xhr.onload = () => {
        let data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch (_) {}
        if (xhr.status >= 200 && xhr.status < 300 && data?.ok) return resolve({response:{ok:true,status:xhr.status},data});
        const error = new Error(String(data?.message || data?.code || `HTTP_${xhr.status || 0}`).slice(0, 240));
        error.publicCode = data?.code || "GITHUB_CREATE_SCREENSHOT_FAILED";
        error.githubStatus = Number(data?.githubStatus || 0) || 0;
        reject(error);
      };
      xhr.onerror = () => {
        const error = new Error("Screenshot upload network request failed");
        error.name = "TypeError";
        error.code = "GITHUB_SCREENSHOT_NETWORK_FAILED";
        error.publicCode = "GITHUB_SCREENSHOT_NETWORK_FAILED";
        reject(error);
      };
      xhr.ontimeout = () => {
        const error = new Error("Screenshot upload timed out");
        error.name = "TimeoutError";
        error.code = "GITHUB_REQUEST_TIMEOUT";
        error.publicCode = "GITHUB_REQUEST_TIMEOUT";
        reject(error);
      };
      xhr.onabort = () => {
        const error = new Error("Screenshot upload was aborted");
        error.name = "AbortError";
        error.code = "GITHUB_SCREENSHOT_ABORTED";
        error.publicCode = "GITHUB_SCREENSHOT_ABORTED";
        reject(error);
      };
      xhr.timeout = 90000;
      try { xhr.send(blob); } catch (error) { reject(error); }
    });
  }

  async function postScreenshotToGithub(url, headers, blob) {
    try {
      const response = await fetch(url, {
        method:"POST",
        credentials:"same-origin",
        cache:"no-store",
        headers,
        body:blob,
      });
      const data = await response.json().catch(() => ({}));
      return {response, data};
    } catch (error) {
      if (!isScreenshotNetworkFetchError(error)) throw error;
      // iOS/WebKit can reject a Blob upload with TypeError("Load failed") even though
      // an equivalent same-origin XHR upload succeeds. The server deduplicates by
      // captureId, so retrying the exact request is safe if fetch reached the origin
      // but its response was lost.
      return uploadScreenshotGithubViaXhr(url, headers, blob);
    }
  }


  function buildScreenshotGithubHeaders(capture) {
    return {
      ...getAdminScreenshotAuthHeaders(),
      "Content-Type":"image/png",
      "X-WW-Screenshot-Id":String(capture.captureId || makeId("screenshot")),
      "X-WW-Screenshot-File":String(capture.fileName || "screenshot.png"),
      "X-WW-Screenshot-Page":String(capture.page || capture.title || "Internal Browser"),
      "X-WW-Screenshot-Path":String(capture.path || "/"),
      "X-WW-Screenshot-Width":String(capture.width || 0),
      "X-WW-Screenshot-Height":String(capture.height || 0),
      "X-WW-Screenshot-Viewport-Mode":String(capture.viewportMode || "auto"),
      "X-WW-Screenshot-Preset-Id":String(capture.presetId || ""),
      "X-WW-Screenshot-Preset-Label":String(capture.presetLabel || ""),
      "X-WW-Screenshot-Orientation":String(capture.orientation || ""),
      "X-WW-Screenshot-Zoom":String(capture.zoom || ""),
      "X-WW-Screenshot-Dpr":String(capture.dpr || 1),
      "X-WW-Screenshot-Capture-Mode":String(capture.mode === "game" ? "game" : "evidence"),
      "X-WW-Screenshot-Captured-At":String(capture.capturedAt || new Date().toISOString()),
      "X-WW-Screenshot-Browser":String(capture.browser || navigator.userAgent || "").slice(0, 240),
      "X-WW-Screenshot-Capture-Engine":String(capture.captureEngine || "html2canvas-viewport"),
      "X-WW-Screenshot-Scroll-X":String(Number(capture.scroll?.scrollX) || 0),
      "X-WW-Screenshot-Scroll-Y":String(Number(capture.scroll?.scrollY) || 0),
      "X-WW-Screenshot-Active-Scroll-Containers":String(Number(capture.scroll?.activeScrollContainers) || 0),
      "X-WW-Screenshot-Visual-Viewport-Scale":String(Number(capture.scroll?.visualViewport?.scale) || 1),
    };
  }

  async function uploadCaptureItemToGithub(item) {
    const capture = item?.capture;
    const blob = item?.blob;
    if (!capture || !(blob instanceof Blob) || !blob.size) throw new Error("CAPTURE_BLOB_MISSING");
    item.status = "github";
    renderCaptureResult();
    try {
      const upload = await postScreenshotToGithub("/api/admin/internal-browser/screenshots/github", buildScreenshotGithubHeaders(capture), blob);
      const response = upload.response;
      const data = upload.data || {};
      if (!response.ok || !data?.ok) {
        const error = new Error(String(data?.message || data?.code || `HTTP_${response.status}`).slice(0, 240));
        error.publicCode = data?.code || "GITHUB_CREATE_SCREENSHOT_FAILED";
        throw error;
      }
      item.github = {
        imageUrl:String(data.imageUrl || ""),
        imageDownloadUrl:String(data.imageDownloadUrl || ""),
        metadataUrl:String(data.metadataUrl || ""),
        imagePath:String(data.imagePath || ""),
        metadataPath:String(data.metadataPath || ""),
        repository:String(data.repository || ""),
        reused:!!data.reused,
      };
      item.status = "github-saved";
      state.lastCaptureGithub = item.github;
      return item.github;
    } catch (error) {
      item.status = "ready";
      item.githubError = error?.publicCode || captureErrorMessage(error);
      throw error;
    } finally {
      renderCaptureResult();
    }
  }

  async function saveCaptureBatchToGithub() {
    const items = Array.isArray(state.lastCaptureBatch?.items) ? state.lastCaptureBatch.items : [];
    const uploadable = items.filter((item) => item?.blob instanceof Blob && item.blob.size && item.status !== "github-saved");
    if (!uploadable.length) {
      window.wwToast?.("ไม่มีภาพที่พร้อมบันทึกเข้า GitHub", {type:"error"});
      return {saved:0, failed:0, skipped:items.length};
    }
    if (state.captureGithubInFlight) return null;
    state.captureGithubInFlight = true;
    const button = $("adminBrowserCaptureGithubBtn");
    captureUiButtonBusy(button, uploadable.length > 1 ? "⏳ กำลังส่งทั้งหมด…" : "⏳ กำลังส่ง…");
    let saved = 0;
    let failed = 0;
    const failureMessages = [];
    try {
      for (const item of uploadable) {
        try {
          await uploadCaptureItemToGithub(item);
          saved += 1;
        } catch (error) {
          failed += 1;
          const publicMessage = error?.publicCode === "GITHUB_SCREENSHOT_NETWORK_FAILED"
            ? "เชื่อมต่อเซิร์ฟเวอร์สำหรับบันทึกภาพไม่ได้"
            : error?.publicCode === "ADMIN_AUTH_REQUIRED"
              ? "เซสชัน Admin หมดอายุหรือไม่ถูกส่งไปกับคำขอ"
              : captureErrorMessage(error);
          item.githubError = publicMessage;
          failureMessages.push(publicMessage);
        }
      }
      const label = items.length > 1 ? `GitHub สำเร็จ ${saved}/${uploadable.length}` : (saved ? "✅ บันทึกแล้ว" : "🐙 เอาเข้า GitHub");
      if (button) { button.disabled = failed === 0 ? true : false; button.dataset.busy = "0"; button.textContent = label; }
      window.wwToast?.(
        failed
          ? `ส่งเข้า GitHub แล้ว ${saved} รายการ · ล้มเหลว ${failed} รายการ${failureMessages[0] ? ` · ${failureMessages[0]}` : ""}`
          : `ส่งเข้า GitHub แล้ว ${saved} รายการ`,
        {type:failed ? "error" : "success"},
      );
      return {saved, failed, skipped:items.length - uploadable.length};
    } finally {
      // Clear the in-flight flag before the final render so a failed upload can
      // immediately re-enable the retry button, while a fully saved batch stays disabled.
      state.captureGithubInFlight = false;
      renderCaptureResult();
    }
  }

  function downloadCaptureItem(index) {
    const item = state.lastCaptureBatch?.items?.[Number(index)];
    if (!item || !(item.blob instanceof Blob) || !item.blob.size) {
      window.wwToast?.("ภาพนี้ยังไม่พร้อมดาวน์โหลด", {type:"error"});
      return false;
    }
    try {
      saveCaptureBlob(item.blob, item.capture.fileName);
      window.wwToast?.(`ดาวน์โหลดแล้ว · ${item.capture.width} × ${item.capture.height}`, {type:"success"});
      return true;
    } catch (error) {
      window.wwToast?.(`ดาวน์โหลด PNG ไม่สำเร็จ: ${captureErrorMessage(error)}`, {type:"error"});
      return false;
    }
  }

  function downloadCaptureBatch() {
    const items = Array.isArray(state.lastCaptureBatch?.items) ? state.lastCaptureBatch.items : [];
    const ready = items.filter((item) => item?.blob instanceof Blob && item.blob.size);
    if (!ready.length) {
      window.wwToast?.("ไม่มีภาพที่พร้อมดาวน์โหลด", {type:"error"});
      return false;
    }
    let downloaded = 0;
    ready.forEach((item) => {
      try { saveCaptureBlob(item.blob, item.capture.fileName); downloaded += 1; } catch (_) {}
    });
    window.wwToast?.(
      downloaded === ready.length ? `ดาวน์โหลดแล้ว ${downloaded} ภาพ` : `ดาวน์โหลดได้ ${downloaded}/${ready.length} ภาพ`,
      {type:downloaded === ready.length ? "success" : "warning"},
    );
    return downloaded === ready.length;
  }

  async function waitForCaptureViewport(child, width, height, timeoutMs = 1200) {
    const targetW = Math.max(1, Math.round(Number(width) || 0));
    const targetH = Math.max(1, Math.round(Number(height) || 0));
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      try {
        if (Math.round(Number(child.innerWidth) || 0) === targetW && Math.round(Number(child.innerHeight) || 0) === targetH) {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return true;
        }
      } catch (_) {}
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return false;
  }

  async function switchCaptureViewport(tab, preset, reason) {
    const previousViewport = normalizeViewport(tab.viewport);
    const nextViewport = normalizeViewport({
      ...previousViewport,
      mode:"preset",
      presetId:preset.id,
      width:preset.width,
      height:preset.height,
      orientation:"auto",
      zoom:"fit",
    });
    tab.viewport = nextViewport;
    applyFrameViewport(tab);
    dispatchChildResize(tab, reason || "screenshot-capture-preset", 1);
    const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
    let child = null;
    try { child = iframe?.contentWindow; } catch (_) {}
    if (!child) throw new Error("CAPTURE_FRAME_MISSING");
    await waitForCaptureViewport(child, preset.width, preset.height);
    return {previousViewport, child};
  }

  function restoreCaptureViewport(tab, previousViewport, reason) {
    if (!tab || !previousViewport) return;
    tab.viewport = normalizeViewport(previousViewport);
    applyFrameViewport(tab);
    dispatchChildResize(tab, reason || "screenshot-capture-restore", 1);
    persistMeta();
  }

  async function captureOne(mode, tab, {preset = null, showResult = false} = {}) {
    const iframe = $("adminBrowserStage")?.querySelector(`[data-browser-frame="${CSS.escape(tab.id)}"]`);
    if (!iframe) throw new Error("CAPTURE_FRAME_MISSING");
    if (tab.status === "error") throw new Error("CAPTURE_FRAME_IN_ERROR_STATE");
    let child;
    try { child = iframe.contentWindow; void child.document; } catch (_) { throw new Error("CAPTURE_FRAME_NOT_ACCESSIBLE"); }
    if (!child?.document?.documentElement) throw new Error("CAPTURE_DOCUMENT_MISSING");

    const captureStartedAt = performance.now();
    const stageBox = elementBox($("adminBrowserStage"));
    const resolved = resolveViewportDimensions(tab, stageBox);
    if (resolved.mode !== "auto") {
      const synced = await waitForCaptureViewport(child, resolved.width, resolved.height, 1400);
      if (!synced) throw new Error(`CAPTURE_VIEWPORT_SYNC_TIMEOUT:${Math.round(resolved.width)}x${Math.round(resolved.height)}`);
    }
    const metadata = getCaptureMetadata(tab, resolved);
    if (preset) {
      metadata.mode = "preset";
      metadata.presetId = preset.id;
      metadata.presetLabel = preset.label;
      metadata.width = preset.width;
      metadata.height = preset.height;
      metadata.orientation = getCaptureOrientation(preset);
    }
    const readiness = await waitForFrameCaptureReady(child, metadata);
    const readyAt = performance.now();
    const liveViewport = readLiveCaptureViewport(child, metadata);
    // The Admin iframe can have a presentation transform. Metadata must describe the
    // logical viewport actually exposed to the child page, not the transformed stage box.
    metadata.width = liveViewport.width;
    metadata.height = liveViewport.height;
    metadata.zoom = liveViewport.visualScale === 1 ? metadata.zoom : `${Math.round(liveViewport.visualScale * 100)}%`;
    const result = await captureWithHtml2Canvas(child, metadata, mode);
    const renderedAt = performance.now();
    if (result.width !== metadata.width || result.height !== metadata.height) {
      throw new Error(`CAPTURE_DIMENSION_MISMATCH:${result.width}x${result.height}`);
    }

    const fileName = getCaptureFileName(metadata, mode);
    const captureId = makeId("screenshot");
    const capture = {
      captureId,
      mode,
      fileName,
      width:metadata.width,
      height:metadata.height,
      presetLabel:metadata.presetLabel,
      orientation:metadata.orientation,
      zoom:metadata.zoom,
      capturedAt:metadata.capturedAt,
      tabId:tab.id,
      page:metadata.title,
      path:metadata.path,
      presetId:metadata.presetId,
      viewportMode:metadata.mode,
      dpr:metadata.dpr,
      browser:metadata.browser,
      captureEngine:"html2canvas-viewport",
      scroll: result.scroll || buildCaptureScrollMetadata(child, snapshotCaptureScrollState(child), liveViewport),
      timing: {
        readyMs:Math.round(readyAt - captureStartedAt),
        renderMs:Math.round(renderedAt - readyAt),
        previewMs:0,
        pngEncodeMs:null,
        totalMs:null,
        readiness,
      },
    };
    state.lastCapture = capture;
    state.lastCaptureTiming = {...capture.timing};
    emit("screenshot-capture", {...tab, screenshot:{...capture}});

    const item = {
      capture,
      blob:null,
      status:"encoding",
      github:null,
      error:"",
    };
    if (showResult) addCaptureBatchItem(item);

    const pngStartedAt = performance.now();
    try {
      const blob = await result.blobPromise;
      const pngFinishedAt = performance.now();
      capture.timing.pngEncodeMs = Math.round(pngFinishedAt - pngStartedAt);
      capture.timing.totalMs = Math.round(pngFinishedAt - captureStartedAt);
      state.lastCaptureTiming = {...capture.timing};
      item.blob = blob;
      item.status = "ready";
      state.lastCaptureBlob = blob;
      if (showResult) renderCaptureResult();
      return item;
    } catch (error) {
      item.status = "failed";
      item.error = captureErrorMessage(error);
      capture.timing.pngEncodeMs = Math.round(performance.now() - pngStartedAt);
      capture.timing.totalMs = Math.round(performance.now() - captureStartedAt);
      state.lastCaptureTiming = {...capture.timing};
      if (showResult) renderCaptureResult();
      throw error;
    } finally {
      // The canvas is intentionally never mounted into the Admin DOM. It exists only
      // as the renderer source for PNG encoding and can be reclaimed after this item.
      try { result.canvas.width = 1; result.canvas.height = 1; } catch (_) {}
    }
  }

  async function captureCurrentActive(mode = "evidence") {
    const tab = currentTab();
    if (!tab) throw new Error("CAPTURE_NO_ACTIVE_TAB");
    state.captureInFlight = true;
    const button = $("adminBrowserCaptureBtn");
    captureUiButtonBusy(button, "📷 กำลังแคป…");
    updateCaptureButtonLabel();
    openCaptureResultShell(mode, 1);
    try {
      const item = await captureOne(mode, tab, {showResult:true});
      state.lastCaptureBatch.items = [item];
      renderCaptureResult();
      window.wwToast?.(`แคปภาพแล้ว · ${item.capture.width} × ${item.capture.height} · PNG พร้อมแล้ว`, {type:"success"});
      return {blob:item.blob, fileName:item.capture.fileName, metadata:item.capture};
    } finally {
      state.captureInFlight = false;
      if (button) { button.disabled = false; button.dataset.busy = "0"; }
      updateCaptureButtonLabel();
      renderCaptureResult();
    }
  }

  async function captureSelectedPresets(mode, presets) {
    const tab = currentTab();
    if (!tab) throw new Error("CAPTURE_NO_ACTIVE_TAB");
    if (!presets.length) return captureCurrentActive(mode);
    state.captureInFlight = true;
    const button = $("adminBrowserCaptureBtn");
    captureUiButtonBusy(button, `📷 กำลังแคป 0/${presets.length}…`);
    openCaptureResultShell(mode, presets.length);
    const previousViewport = normalizeViewport(tab.viewport);
    let completed = 0;
    try {
      for (const preset of presets) {
        let switched = false;
        try {
          await switchCaptureViewport(tab, preset, `screenshot-capture-${preset.id}`);
          switched = true;
          const item = await captureOne(mode, tab, {preset, showResult:true});
          state.lastCapture = item.capture;
          state.lastCaptureBlob = item.blob;
          completed += 1;
          if (button) {
            const label = button.querySelector("span");
            if (label) label.textContent = `กำลังแคป ${completed}/${presets.length}…`;
            else button.textContent = `📷 กำลังแคป ${completed}/${presets.length}…`;
          }
        } catch (error) {
          const metadata = getCaptureMetadata(tab, resolveViewportDimensions(tab, elementBox($("adminBrowserStage"))));
          const failedCapture = {
            captureId:makeId("screenshot"),
            mode,
            fileName:getCaptureFileName({...metadata, width:preset.width, height:preset.height, capturedAt:new Date().toISOString()}, mode),
            width:preset.width,
            height:preset.height,
            presetLabel:preset.label,
            orientation:getCaptureOrientation(preset),
            zoom:"Fit",
            capturedAt:new Date().toISOString(),
            tabId:tab.id,
            page:metadata.title,
            path:metadata.path,
            presetId:preset.id,
            viewportMode:"preset",
            dpr:metadata.dpr,
            browser:metadata.browser,
          };
          addCaptureBatchItem({capture:failedCapture, blob:null, status:"failed", github:null, error:captureErrorMessage(error)});
        } finally {
          if (switched) restoreCaptureViewport(tab, previousViewport, `screenshot-capture-restore-${preset.id}`);
          else restoreCaptureViewport(tab, previousViewport, "screenshot-capture-restore-after-failure");
        }
      }
      const summary = captureResultSummary(state.lastCaptureBatch.items);
      window.wwToast?.(
        summary.failed
          ? `แคปเสร็จแล้ว · สำเร็จ ${summary.ready} · ล้มเหลว ${summary.failed}`
          : `แคปเสร็จแล้ว · ${summary.ready}/${summary.total} ขนาด`,
        {type:summary.failed ? "warning" : "success"},
      );
      return state.lastCaptureBatch.items.map((item) => item.blob ? {blob:item.blob, fileName:item.capture.fileName, metadata:item.capture} : {error:item.error, metadata:item.capture});
    } finally {
      // Always return the Admin's visible viewport to exactly what was there before the batch.
      restoreCaptureViewport(tab, previousViewport, "screenshot-capture-batch-final-restore");
      state.captureInFlight = false;
      if (button) { button.disabled = false; button.dataset.busy = "0"; }
      updateCaptureButtonLabel();
      renderCaptureResult();
    }
  }

  async function captureActive(mode = "evidence") {
    const normalizedMode = mode === "game" ? "game" : "evidence";
    const presets = getSelectedCapturePresets();
    if (state.captureInFlight) return null;
    if (presets.length) return captureSelectedPresets(normalizedMode, presets);
    return captureCurrentActive(normalizedMode);
  }

  function showCaptureMenu(open) {
    const menu = $("adminBrowserCaptureMenu");
    const button = $("adminBrowserCaptureMenuBtn");
    if (!menu) return;
    menu.hidden = !open;
    button?.setAttribute("aria-expanded", String(!!open));
  }

  function setupMarkupEvents() {
    bindViewportControls();
    $("adminBrowserTabs")?.addEventListener("click", (event) => {
      const close = event.target.closest("[data-browser-close]");
      if (close) {
        event.preventDefault();
        event.stopPropagation();
        closeTab(close.dataset.browserClose);
        return;
      }
      const tabBtn = event.target.closest("[data-browser-tab]");
      if (tabBtn) activateTab(tabBtn.dataset.browserTab);
      if (event.target.closest("#adminBrowserNewTabBtn")) showNewTabMenu(true);
    });

    $("adminBrowserNewTabTopBtn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      showNewTabMenu(true);
    });

    $("adminBrowserNewTabMenu")?.addEventListener("click", async (event) => {
      const btn = event.target.closest("[data-new-browser]");
      if (!btn) return;
      showNewTabMenu(false);
      const type = btn.dataset.newBrowser;
      if (type === "game") openGame();
      else if (type === "admin") openAdmin();
      else if (type === "tester-host") { try { await openTester("host"); } catch (e) { window.wwToast?.(`เปิด Tester ไม่สำเร็จ: ${e.message || e}`, {type:"error"}); } }
      else if (type === "tester-player") { try { await openTester("player"); } catch (e) { window.wwToast?.(`เปิด Tester ไม่สำเร็จ: ${e.message || e}`, {type:"error"}); } }
    });

    document.addEventListener("click", (event) => {
      if (event.target.closest("#adminBrowserNewTabBtn, #adminBrowserNewTabTopBtn, #adminBrowserNewTabMenu")) return;
      if (!event.target.closest("#adminBrowserCaptureMenuBtn, #adminBrowserCaptureMenu")) showCaptureMenu(false);
      showNewTabMenu(false);
    });
    $("adminBrowserBackBtn")?.addEventListener("click", () => historyAction("back"));
    $("adminBrowserForwardBtn")?.addEventListener("click", () => historyAction("forward"));
    $("adminBrowserReloadBtn")?.addEventListener("click", reloadActive);
    $("adminBrowserHomeBtn")?.addEventListener("click", openGame);
    $("adminBrowserToggleBtn")?.addEventListener("click", () => {
      if (state.controlSurface) {
        openGame();
      } else {
        activateControlCenter();
      }
    });
    $("adminBrowserCaptureBtn")?.addEventListener("click", async () => {
      showCaptureMenu(false);
      try { await captureActive(state.captureMode); }
      catch (error) { window.wwToast?.(`แคปภาพไม่สำเร็จ: ${captureErrorMessage(error)}`, {type:"error"}); closeCaptureResult(); }
    });
    $("adminBrowserCaptureMenuBtn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = $("adminBrowserCaptureMenu");
      if (menu?.hidden) renderCapturePresetOptions();
      showCaptureMenu(!!menu && menu.hidden);
    });
    $("adminBrowserCaptureMenu")?.addEventListener("click", (event) => {
      const option = event.target.closest("[data-capture-mode]");
      if (option) {
        setCaptureMode(option.dataset.captureMode);
        return;
      }
      if (event.target.closest("#adminBrowserCapturePresetAllBtn")) {
        setCapturePresetSelection(VIEWPORT_PRESETS.map((item) => item.id));
        return;
      }
      if (event.target.closest("#adminBrowserCapturePresetClearBtn")) {
        setCapturePresetSelection([]);
      }
    });
    $("adminBrowserCapturePresetList")?.addEventListener("click", (event) => event.stopPropagation());
    $("adminBrowserCaptureSaveBtn")?.addEventListener("click", () => {
      if (!state.lastCaptureBatch?.items?.length) {
        window.wwToast?.("ไม่มีภาพที่พร้อมดาวน์โหลด", {type:"error"});
        return;
      }
      downloadCaptureBatch();
    });
    $("adminBrowserCaptureGithubBtn")?.addEventListener("click", async () => {
      try { await saveCaptureBatchToGithub(); }
      catch (error) { window.wwToast?.(`บันทึกเข้า GitHub ไม่สำเร็จ: ${captureErrorMessage(error)}`, {type:"error"}); renderCaptureResult(); }
    });
    $("adminBrowserCaptureCloseBtn")?.addEventListener("click", closeCaptureResult);
    $("adminBrowserCaptureCloseBtn2")?.addEventListener("click", closeCaptureResult);
    $("adminBrowserCaptureResultList")?.addEventListener("click", (event) => {
      const download = event.target.closest("[data-capture-download-index]");
      if (!download) return;
      event.preventDefault();
      event.stopPropagation();
      downloadCaptureItem(download.dataset.captureDownloadIndex);
    });
    $("adminBrowserCaptureResult")?.addEventListener("click", (event) => {
      if (event.target.id === "adminBrowserCaptureResult") closeCaptureResult();
    });
    renderCapturePresetOptions();
    setCaptureMode(state.captureMode);
  }

  function onKeydown(event) {
    if (state.controlSurface) return;
    const target = event.target;
    const typing = target && /INPUT|TEXTAREA|SELECT/.test(target.tagName) && target.id !== "adminBrowserAddress";
    const key = String(event.key || "").toLowerCase();

    // Browser-style shortcuts deliberately work even when the active Game/Tester
    // iframe has focus. Key events from an iframe do not bubble to Admin's document,
    // so wireChildBrowserHooks() registers this same handler inside every child tab.
    if (!typing && (event.ctrlKey || event.metaKey) && key === "t") {
      event.preventDefault(); event.stopPropagation(); showNewTabMenu(true); return;
    }
    if (!typing && (event.ctrlKey || event.metaKey) && key === "w") {
      event.preventDefault(); event.stopPropagation();
      const tab = currentTab(); if (tab) closeTab(tab.id);
      return;
    }
    if (!typing && (event.ctrlKey || event.metaKey) && event.key === "Tab") {
      event.preventDefault(); event.stopPropagation(); activateRelativeTab(event.shiftKey ? -1 : 1); return;
    }
    if (!typing && (event.ctrlKey || event.metaKey) && key === "r") {
      event.preventDefault(); event.stopPropagation(); reloadActive(); return;
    }
    if (!typing && event.altKey && event.key === "ArrowLeft") { event.preventDefault(); event.stopPropagation(); historyAction("back"); return; }
    if (!typing && event.altKey && event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); historyAction("forward"); return; }
    if (!typing && (event.ctrlKey || event.metaKey) && key === "l") {
      event.preventDefault(); event.stopPropagation();
      $("adminBrowserAddress")?.focus();
      $("adminBrowserAddress")?.select?.();
    }
  }

  function restoreTabs() {
    if (state.restoreInFlight) return;
    state.restoreInFlight = true;
    const saved = loadSavedMeta().tabs;
    if (!saved.length) {
      openUrl(DEFAULT_GAME, {type:"game", title:"Game", icon:"🏠", persistent:true, showBrowser:false});
      state.restoreInFlight = false;
      showSurface(false);
      return;
    }

    (async () => {
      for (const meta of saved) {
        if (meta.type === "admin") {
          const url = internalPageAllowed(meta.url) ? String(meta.url) : buildAdminUrl({embedId:meta.embedId || makeId("admin-embed")});
          openUrl(url, {tabId:meta.id, type:"admin", title:meta.title || "Admin", icon:"🛡️", persistent:true, viewport:meta.viewport, embedId:meta.embedId || "", showBrowser:false});
          continue;
        }
        if (meta.type === "game") {
          openUrl(DEFAULT_GAME, {tabId: meta.id, type:"game", title:"Werewolf-Online", launchId: meta.launchId || "", persistent:true, viewport:meta.viewport, showBrowser:false});
          continue;
        }
        try {
          const pass = await getTesterPass();
          const url = buildUrl(meta.type, {testerPass: pass.token, tabId: meta.id, launchId: meta.launchId || makeId("launch"), controllerId: window.WWAdminTesterAuth?.controllerId?.() || ""});
          openUrl(url, {tabId:meta.id, type:meta.type, role:meta.type === "tester-host" ? "host" : "player", launchId:meta.launchId || "", title:meta.title, icon:meta.type === "tester-host" ? "🎮" : "👤", viewport:meta.viewport, showBrowser:false});
        } catch (e) {
          window.wwToast?.("กู้แท็บ Tester ไม่สำเร็จ — เปิดใหม่ได้จาก + New Tab", {type:"warning"});
        }
      }
      state.restoreInFlight = false;
      if (!state.tabs.length) openUrl(DEFAULT_GAME, {type:"game", title:"Werewolf-Online", icon:"🏠", persistent:true, showBrowser:false});
      if (state.tabs.length) {
        state.activeTabId = state.tabs[0].id;
        syncFrameVisibility();
        renderTabs();
        const active = currentTab();
        if (active) { renderFrame(active); applyFrameViewport(active); updateViewportControls(active); }
      }
      showSurface(false);
    })();
  }

  function emit(action, tab) {
    try { window.dispatchEvent(new CustomEvent("ww-admin-browser", {detail:{action, tab:{...tab}}})); } catch (_) {}
  }

  function init() {
    if (!$('adminBrowserView')) return;
    setupMarkupEvents();
    setupFrameLayoutObserver();
    window.addEventListener("message", handleMessage);
    document.addEventListener("keydown", onKeydown);
    window.WWAdminBrowser = {
      state,
      open: () => { openGame(); },
      openGame,
      openAdmin,
      openTester,
      openBot,
      openUrl,
      activateTab,
      activateRelativeTab,
      closeTab,
      closeOthers,
      reloadActive,
      showBrowser: () => { showSurface(true); if (!state.tabs.length) openGame(); },
      showAdmin: activateControlCenter,
      currentTab,
      setViewport: (patch) => setViewportForTab(currentTab(), patch, "api-viewport-change"),
      resetViewport: () => setViewportForTab(currentTab(), cloneDefaultViewport(), "api-viewport-reset"),
      fitViewport: () => { const tab = currentTab(); return !!tab && tab.viewport?.mode !== "auto" && setViewportForTab(tab, {zoom:"fit"}, "api-viewport-fit"); },
      capture: (mode = "evidence") => captureCurrentActive(mode === "game" ? "game" : "evidence"),
      captureBatch: (mode = "evidence", presetIds = []) => {
        const wanted = Array.isArray(presetIds) ? presetIds : [];
        const presets = wanted.length
          ? wanted.map((id) => VIEWPORT_PRESETS.find((item) => item.id === String(id))).filter(Boolean)
          : getSelectedCapturePresets();
        return captureSelectedPresets(mode === "game" ? "game" : "evidence", presets);
      },
      getLastCapture: () => state.lastCapture ? ({...state.lastCapture}) : null,
      getLastCaptureTiming: () => state.lastCaptureTiming ? ({...state.lastCaptureTiming, readiness:state.lastCaptureTiming.readiness ? {...state.lastCaptureTiming.readiness} : null}) : null,
      getViewport: () => currentTab() ? ({...normalizeViewport(currentTab().viewport)}) : null,
      getViewportResolved: () => { const tab = currentTab(); return tab ? resolveViewportDimensions(tab, elementBox($("adminBrowserStage"))) : null; },
      viewportPresets: VIEWPORT_PRESETS.map((item) => ({...item})),
      embeddedAdmin: ADMIN_EMBED_MODE,
      adminEmbedDepth: ADMIN_EMBED_DEPTH,
    };
    showSurface(false);
    scheduleHtml2CanvasWarmup();
    restoreTabs();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, {once:true});
  else init();
})();
