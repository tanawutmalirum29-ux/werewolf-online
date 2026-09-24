/*
 * WEREWOLF ONLINE — FLUID LAYOUT ENGINE v1
 *
 * เป้าหมาย:
 * - ทำให้ขนาดของ UI ตอบสนองต่อพื้นที่จริงแบบต่อเนื่องระหว่างการลาก resize / Split View / Stage Manager
 * - coalesce resize events ด้วย requestAnimationFrame เพื่อไม่คำนวณ layout ซ้ำหลายครั้งในเฟรมเดียว
 * - ใช้ ResizeObserver กับกล่องสำคัญ เพื่อรองรับกรณีที่ "พื้นที่แอป" เปลี่ยนโดยที่ viewport ไม่ได้เปลี่ยน
 * - รองรับ VisualViewport บนอุปกรณ์สัมผัส โดยไม่บังคับให้ layout หลักยุบตามคีย์บอร์ด
 * - ไม่แตะสถานะเกม/Socket/room logic
 */
(function () {
    "use strict";

    const root = document.documentElement;
    const body = document.body;
    const page = body?.dataset?.page || "unknown";
    let rafId = 0;
    let releaseTimer = 0;
    let lastValues = Object.create(null);
    let lastMeasuredBoxes = Object.create(null);
    let ready = false;

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function setRootVar(name, value) {
        const next = String(value);
        if (lastValues[name] === next) return false;
        lastValues[name] = next;
        root.style.setProperty(name, next);
        return true;
    }

    function rectSignature(rect) {
        if (!rect) return "0";
        return [
            rect.x, rect.y, rect.width, rect.height,
        ].map((v) => Number(v || 0).toFixed(3)).join("|");
    }

    function readViewport() {
        const vv = window.visualViewport;
        const width = Number(vv?.width || window.innerWidth || 0);
        const height = Number(vv?.height || window.innerHeight || 0);
        return {
            width: Math.max(0, width),
            height: Math.max(0, height),
            top: Number(vv?.offsetTop || 0),
            left: Number(vv?.offsetLeft || 0),
        };
    }

    function readLayoutBoxes() {
        const selectors = [
            ["app", ".app"],
            ["layout", ".layout"],
            ["players", "#players"],
            ["playersCard", "#playersCard, #playerCard"],
            ["chat", "#chatCard"],
            ["roles", "#rolesPanelCard, #roleSettingsCard"],
            ["rightCol", "#rightCol"],
        ];
        selectors.forEach(([key, selector]) => {
            const el = document.querySelector(selector);
            if (!el) return;
            const rect = el.getBoundingClientRect();
            const signature = rectSignature(rect);
            if (lastMeasuredBoxes[key] !== signature) {
                lastMeasuredBoxes[key] = signature;
                setRootVar(`--ww-${key}-w`, `${Math.max(0, rect.width).toFixed(2)}px`);
                setRootVar(`--ww-${key}-h`, `${Math.max(0, rect.height).toFixed(2)}px`);
            }
        });
    }

    function computeContinuousTokens(viewport) {
        const w = viewport.width;
        const h = viewport.height;

        // ค่ากลางที่ค่อย ๆ เปลี่ยน ไม่ใช่การสลับทีละ breakpoint
        if (page === "player") {
            const chat = clamp(w * 0.28, 232, 380);
            const roles = clamp(w * 0.22, 220, 330);
            const gap = clamp(w * 0.008, 6, 14);
            const edge = clamp(w * 0.012, 6, 18);
            const bottom = clamp(h * 0.07, 52, 82);
            setRootVar("--fluid-game-chat-width", `${chat.toFixed(2)}px`);
            setRootVar("--fluid-game-roles-width", `${roles.toFixed(2)}px`);
            setRootVar("--fluid-game-gap", `${gap.toFixed(2)}px`);
            setRootVar("--fluid-game-edge", `${edge.toFixed(2)}px`);
            setRootVar("--fluid-game-bottom-clearance", `${bottom.toFixed(2)}px`);
        }

        if (page === "host") {
            const left = clamp(w * 0.26, 250, 360);
            const chat = clamp(w * 0.25, 240, 370);
            const gap = clamp(w * 0.012, 8, 16);
            const pagePad = clamp(w * 0.016, 8, 22);
            setRootVar("--fluid-host-left", `${left.toFixed(2)}px`);
            setRootVar("--fluid-host-chat", `${chat.toFixed(2)}px`);
            setRootVar("--fluid-host-gap", `${gap.toFixed(2)}px`);
            setRootVar("--fluid-host-page-pad", `${pagePad.toFixed(2)}px`);
        }

        // ค่าเหล่านี้เอาไว้ให้ CSS/diagnostics อ้างอิงพื้นที่จริงได้โดยไม่ต้องอ่าน innerWidth เองซ้ำ
        setRootVar("--ww-viewport-w", `${w.toFixed(2)}px`);
        setRootVar("--ww-viewport-h", `${h.toFixed(2)}px`);
        setRootVar("--ww-viewport-top", `${viewport.top.toFixed(2)}px`);
        setRootVar("--ww-viewport-left", `${viewport.left.toFixed(2)}px`);
        setRootVar("--ww-dpr", String(Number(window.devicePixelRatio || 1).toFixed(2)));
    }

    function measureAndPublish() {
        rafId = 0;
        const viewport = readViewport();
        computeContinuousTokens(viewport);
        readLayoutBoxes();
        if (!ready) {
            ready = true;
            body.classList.add("fluid-layout-ready");
            root.dataset.fluidLayout = "ready";
        }
    }

    function schedule(reason) {
        body.classList.add("is-resizing");
        if (reason) body.dataset.fluidResizeReason = reason;

        if (!rafId) {
            rafId = requestAnimationFrame(measureAndPublish);
        }

        clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => {
            body.classList.remove("is-resizing");
            delete body.dataset.fluidResizeReason;
            if (!rafId) measureAndPublish();
        }, 110);
    }

    function observeImportantBoxes() {
        if (typeof ResizeObserver === "undefined") return;
        const elements = [
            document.querySelector(".app"),
            document.querySelector(".layout"),
            document.querySelector("#players"),
            document.querySelector("#playersCard"),
            document.querySelector("#playerCard"),
            document.querySelector("#chatCard"),
            document.querySelector("#rolesPanelCard"),
            document.querySelector("#roleSettingsCard"),
            document.querySelector("#rightCol"),
        ].filter(Boolean);

        if (!elements.length) return;
        const observer = new ResizeObserver(() => schedule("container"));
        elements.forEach((el) => {
            try {
                observer.observe(el, { box: "border-box" });
            } catch (e) {
                observer.observe(el);
            }
        });
    }

    function bind() {
        window.addEventListener("resize", () => schedule("window"), { passive: true });
        window.addEventListener("orientationchange", () => schedule("orientation"), { passive: true });

        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", () => schedule("visual-viewport"), { passive: true });
            window.visualViewport.addEventListener("scroll", () => schedule("visual-scroll"), { passive: true });
        }

        // เมื่อนำหน้าออกจาก background แล้ว ขนาดกล่องอาจเปลี่ยนโดยไม่มี resize event ที่เชื่อถือได้ทุก WebKit
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) schedule("visibility");
        }, { passive: true });

        window.addEventListener("pageshow", () => schedule("pageshow"), { passive: true });

        observeImportantBoxes();
        schedule("boot");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", bind, { once: true });
    } else {
        bind();
    }
})();
