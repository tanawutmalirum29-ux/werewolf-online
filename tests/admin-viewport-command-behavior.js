const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'admin.html'), 'utf8');

const start = admin.indexOf('const adminViewportChip = document.getElementById("adminViewportChip");');
const end = admin.indexOf('\nconst adminErrorMessages = {', start);
assert(start >= 0 && end > start, 'viewport/copy block boundaries not found');
const block = admin.slice(start, end);

function makeElement(initial = {}) {
    return {
        textContent: initial.textContent || '',
        title: initial.title || '',
        dataset: {},
        style: {},
        isConnected: true,
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        focus() {},
        select() {},
        setSelectionRange() {},
        setAttribute(name, value) {
            const key = String(name);
            if (key === 'title') this.title = String(value);
            else if (key === 'aria-label') this.ariaLabel = String(value);
            else if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value);
            else this[key] = String(value);
        },
        removeAttribute(name) {
            const key = String(name);
            if (key === 'title') this.title = '';
            else if (key === 'aria-label') this.ariaLabel = '';
            else if (key.startsWith('data-')) delete this.dataset[key.slice(5)];
            else delete this[key];
        },
        remove() { this.isConnected = false; },
    };
}

function makeContext({ clipboard = null, execCopy = false } = {}) {
    const viewport = makeElement();
    const copyBtn = makeElement({ textContent: '📎' });
    const elements = { adminViewportChip: viewport, copyAdminCommandBtn: copyBtn };
    const listeners = {};
    const visualListeners = {};
    const resizeObservers = [];
    const rafQueue = [];
    const toasts = [];
    const appended = [];

    const document = {
        documentElement: {},
        body: { appendChild(el) { appended.push(el); } },
        getElementById(id) { return elements[id] || null; },
        createElement() { return makeElement(); },
        addEventListener(type, fn) { listeners[`document:${type}`] = fn; },
        removeEventListener(type) { delete listeners[`document:${type}`]; },
        execCommand() { return execCopy; },
    };

    const windowObj = {
        innerWidth: 390,
        innerHeight: 844,
        visualViewport: {
            width: 390,
            height: 844,
            addEventListener(type, fn) { visualListeners[type] = fn; },
        },
        addEventListener(type, fn) { listeners[type] = fn; },
        requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
        setTimeout(fn) { rafQueue.push(fn); return rafQueue.length; },
        setInterval(fn) { return 1; },
        clearInterval() {},
        clearTimeout() {},
    };

    const context = {
        window: windowObj,
        document,
        ResizeObserver: class {
            constructor(cb) { this.cb = cb; resizeObservers.push(this); }
            observe() {}
        },
        navigator: clipboard ? { clipboard } : {},
        wwToast(message, opts) { toasts.push({ message, opts }); },
        console,
    };
    context.globalThis = context;

    vm.runInNewContext(block, context, { filename: 'admin.html#viewport-copy' });
    return { context, viewport, copyBtn, listeners, visualListeners, resizeObservers, rafQueue, toasts, appended };
}

(async () => {
    // Initial measurement and live resize/orientation/visual-viewport observation.
    const t = makeContext();
    assert.strictEqual(t.viewport.textContent, '📐 390 × 844 px');
    assert.strictEqual(t.viewport.dataset.width, '390');
    assert.strictEqual(t.viewport.dataset.height, '844');
    assert.strictEqual(t.viewport.title, 'Viewport หน้าเว็บ: 390 × 844 CSS px');
    assert(t.listeners.resize, 'window resize listener missing at runtime');
    assert(t.listeners.orientationchange, 'orientationchange listener missing at runtime');
    assert(t.visualListeners.resize, 'visualViewport resize listener missing at runtime');
    assert.strictEqual(t.resizeObservers.length, 1, 'ResizeObserver should watch the document root');
    assert(typeof t.resizeObservers[0].cb === 'function', 'ResizeObserver callback should remain attached for the lifetime of the page');

    t.context.window.innerWidth = 1024;
    t.context.window.innerHeight = 768;
    t.listeners.resize();
    assert.strictEqual(t.viewport.textContent, '📐 390 × 844 px', 'resize should be coalesced until the animation frame');
    t.rafQueue.shift()();
    assert.strictEqual(t.viewport.textContent, '📐 1024 × 768 px');

    t.context.window.innerWidth = 820;
    t.context.window.innerHeight = 1180;
    t.listeners.orientationchange();
    t.rafQueue.shift()();
    assert.strictEqual(t.viewport.textContent, '📐 820 × 1180 px');

    t.context.window.innerWidth = 768;
    t.context.window.innerHeight = 1024;
    t.visualListeners.resize();
    t.rafQueue.shift()();
    assert.strictEqual(t.viewport.textContent, '📐 768 × 1024 px');

    // Clipboard API success path copies the exact requested command and never exposes it in the button label.
    let copiedText = '';
    const success = makeContext({
        clipboard: { writeText: async (value) => { copiedText = value; } },
    });
    const required = 'เริ่มแก้ไฟล์เลย ขอให้แก้และดูอย่างละเอียดไม่เอารีบส่ง ของานละเอียด และเช็คซ้ำหลายๆรอบว่าทำงานได้ดีและตรงแล้ว เสร็จแล้วส่งไฟล์มา';
    await success.context.copyAdminFixCommand();
    assert.strictEqual(copiedText, required);
    assert.strictEqual(success.copyBtn.textContent, '✓', 'successful copy should visibly change the button to a check mark');
    assert.strictEqual(success.copyBtn.dataset.copied, '1');
    assert.strictEqual(success.copyBtn.title, 'คัดลอกคำสั่งแล้ว');
    assert.strictEqual(success.copyBtn.ariaLabel, 'คัดลอกคำสั่งแล้ว');
    assert.strictEqual(success.toasts.at(-1).message, 'คัดลอกคำสั่งเต็มแล้ว');
    const copyFeedbackTimer = success.rafQueue.pop();
    assert.strictEqual(typeof copyFeedbackTimer, 'function', 'copy success should schedule a short visual feedback reset');
    copyFeedbackTimer();
    assert.strictEqual(success.copyBtn.textContent, '📎', 'copy button should return to the paperclip after the short feedback');
    assert.strictEqual(success.copyBtn.dataset.copied, undefined);

    // HTTP/WebView/iOS fallback path remains functional when navigator.clipboard is unavailable.
    let fallbackText = '';
    const fallback = makeContext({ execCopy: true });
    const oldCreate = fallback.context.document.createElement;
    fallback.context.document.createElement = (tag) => {
        const el = oldCreate.call(fallback.context.document, tag);
        if (tag === 'textarea') {
            Object.defineProperty(el, 'value', {
                get() { return this._value || ''; },
                set(v) { this._value = v; },
            });
            el.select = () => { fallbackText = el.value; };
            el.setSelectionRange = () => {};
        }
        return el;
    };
    await fallback.context.copyAdminFixCommand();
    assert.strictEqual(fallbackText, required);
    assert.strictEqual(fallback.toasts.at(-1).message, 'คัดลอกคำสั่งเต็มแล้ว');

    const failed = makeContext();
    await failed.context.copyAdminFixCommand();
    assert.strictEqual(failed.copyBtn.textContent, '📎', 'failed copy should not leave the success check mark visible');
    assert.strictEqual(failed.copyBtn.dataset.copied, undefined);
    assert.strictEqual(failed.toasts.at(-1).message, 'คัดลอกไม่ได้ ลองกดค้างแล้วคัดลอกข้อความ');

    console.log('admin-viewport-command-behavior: PASS');
})().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
