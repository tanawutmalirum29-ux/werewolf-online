// ===== ww-ui.js — ฟังก์ชันช่วย UI ที่ใช้ร่วมกันทั้ง host.main.js และ player.main.js =====
// รวมมาจากของเดิมที่ก็อปวางซ้ำกันในทั้งสองไฟล์ (escapeHtml + wwAlert/wwConfirm ทุกตัวเหมือนกัน
// เป๊ะ ส่วน wwPrompt/wwChoice เดิมมีแค่ฝั่ง host.main.js) — โหลดไฟล์นี้ก่อน host.main.js/
// player.main.js เสมอ (ดู <script> ใน host.html และ player.html)

// บั๊กความปลอดภัย (XSS): ทั่วทั้งไฟล์นี้เอาข้อมูลที่ผู้เล่นพิมพ์เองได้ (ชื่อผู้เล่น, ข้อความแชท)
// ไปแปะลง innerHTML ตรงๆ โดยไม่ escape เลย เช่น `<div class="pname">${escapeHtml(p.name)}</div>` — ถ้าใครตั้ง
// ชื่อเป็น "<img src=x onerror=alert(document.cookie)>" หรือพิมพ์แท็กแบบนี้ในแชท มันจะกลายเป็น
// HTML/JS จริงที่รันในเบราว์เซอร์ของโฮสต์และผู้เล่นคนอื่นทุกคนที่เห็นชื่อ/ข้อความนั้น (stored XSS)
// escapeHtml() แปลงอักขระที่มีความหมายพิเศษใน HTML ให้เป็น entity ธรรมดาก่อนแทรกลง innerHTML
function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

// ===== non-blocking CSS toast =====
// ใช้กับข้อความแจ้งเตือนทั่วไป เพื่อไม่หยุด event loop/animation ของเกมแบบ alert() ของ browser
function wwToast(message, options) {
    const opt = options || {};
    const host = document.createElement("div");
    host.className = "ww-toast-container";
    const toast = document.createElement("div");
    toast.className = "ww-toast" + (opt.type ? " ww-toast-" + String(opt.type).replace(/[^a-z-]/g, "") : "");
    toast.setAttribute("role", "status");
    toast.textContent = String(message ?? "");
    host.appendChild(toast);
    document.body.appendChild(host);
    const duration = Math.max(1800, Number(opt.duration) || 3200);
    requestAnimationFrame(() => toast.classList.add("show"));
    const close = () => { toast.classList.remove("show"); setTimeout(() => host.remove(), 220); };
    setTimeout(close, duration);
    return { close };
}

// ===== ww-modal helpers: แทน alert()/confirm() ของเบราว์เซอร์ทั้งหมด =====
function wwAlert(message) {
    return new Promise((resolve) => {
        wwToast(message, { type: "info" });
        resolve(true);
    });
}

// ส่งสัญญาณตอน pagehide โดยไม่พึ่ง fetch/socket ที่อาจถูก browser ตัดระหว่าง unload
function wwSendBrowserExitBeacon(endpoint, payload) {
    const body = JSON.stringify(payload || {});
    try {
        if (navigator.sendBeacon) {
            const blob = new Blob([body], { type: "application/json" });
            if (navigator.sendBeacon(endpoint, blob)) return true;
        }
    } catch (_) {}
    // fallback สำหรับ browser/webview ที่ไม่มี sendBeacon หรือรับ beacon ไม่สำเร็จ
    try {
        fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body, credentials: "same-origin", keepalive: true, cache: "no-store"
        }).catch(() => {});
        return true;
    } catch (_) { return false; }
}

// options (ไม่บังคับ — ไม่ส่งมา = พฤติกรรมเดิมทุกอย่าง): { okText, cancelText, danger }
//   okText/cancelText = ข้อความบนปุ่ม (ค่าเริ่มต้น "ยืนยัน"/"ยกเลิก"), danger = true → ปุ่มยืนยันเป็นสีแดง (การกระทำย้อนกลับไม่ได้)
function wwConfirm(message, options) {
    const opt = options || {};
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "ww-modal-overlay";
        overlay.innerHTML = `
            <div class="ww-modal-box">
                <div class="ww-modal-msg"></div>
                <div class="ww-modal-actions">
                    <button class="ww-modal-btn ww-modal-cancel">ยกเลิก</button>
                    <button class="ww-modal-btn ww-modal-ok">ยืนยัน</button>
                </div>
            </div>`;
        overlay.querySelector(".ww-modal-msg").textContent = message;
        if (opt.cancelText) overlay.querySelector(".ww-modal-cancel").textContent = opt.cancelText;
        if (opt.okText) overlay.querySelector(".ww-modal-ok").textContent = opt.okText;
        if (opt.danger) overlay.querySelector(".ww-modal-ok").classList.add("ww-modal-danger");
        document.body.appendChild(overlay);
        overlay.querySelector(".ww-modal-ok").onclick = () => { overlay.remove(); resolve(true); };
        overlay.querySelector(".ww-modal-cancel").onclick = () => { overlay.remove(); resolve(false); };
    });
}

// เหมือน wwAlert/wwConfirm แต่มีช่องกรอกข้อความ — ใช้แทน prompt() ของเบราว์เซอร์
// คืนค่าเป็นข้อความที่กรอก (string) หรือ null ถ้ากดยกเลิก
function wwPrompt(message, defaultValue) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "ww-modal-overlay";
        overlay.innerHTML = `
            <div class="ww-modal-box">
                <div class="ww-modal-msg"></div>
                <input type="text" class="ww-modal-input" maxlength="20">
                <div class="ww-modal-actions">
                    <button class="ww-modal-btn ww-modal-cancel">ยกเลิก</button>
                    <button class="ww-modal-btn ww-modal-ok">บันทึก</button>
                </div>
            </div>`;
        overlay.querySelector(".ww-modal-msg").textContent = message;
        const input = overlay.querySelector(".ww-modal-input");
        input.value = defaultValue || "";
        document.body.appendChild(overlay);
        setTimeout(() => { input.focus(); input.select(); }, 30);
        const submit = () => { const v = input.value.trim(); overlay.remove(); resolve(v || null); };
        overlay.querySelector(".ww-modal-ok").onclick = submit;
        overlay.querySelector(".ww-modal-cancel").onclick = () => { overlay.remove(); resolve(null); };
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    });
}

// เหมือน wwConfirm แต่ให้เลือกได้มากกว่า 2 ตัวเลือก (ใช้แทนกรณีต้องถามว่า "ใครเป็นคนลงมือ")
// options: [{ label, value }] — คืนค่า value ของตัวที่กด หรือ null ถ้ากดยกเลิก/ปิด overlay
function wwChoice(message, options) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "ww-modal-overlay";
        overlay.innerHTML = `
            <div class="ww-modal-box">
                <div class="ww-modal-msg"></div>
                <div class="ww-modal-actions ww-modal-actions-col"></div>
            </div>`;
        overlay.querySelector(".ww-modal-msg").textContent = message;
        const actions = overlay.querySelector(".ww-modal-actions-col");
        options.forEach((opt) => {
            const btn = document.createElement("button");
            btn.className = "ww-modal-btn ww-modal-ok";
            btn.textContent = opt.label;
            btn.onclick = () => { overlay.remove(); resolve(opt.value); };
            actions.appendChild(btn);
        });
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "ww-modal-btn ww-modal-cancel";
        cancelBtn.textContent = "ยกเลิก";
        cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
        actions.appendChild(cancelBtn);
        document.body.appendChild(overlay);
    });
}
