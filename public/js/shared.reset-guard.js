// shared.reset-guard.js
// ล้างตัวตนในเครื่องเมื่อแอดมินกด "ล้างข้อมูลเกมทั้งหมด" (ดู /api/admin/reset ใน server.js)
//
// หลักการ: server มีเลข "resetEpoch" (ส่งมากับ /api/config) ที่เปลี่ยนทุกครั้งที่แอดมินล้างข้อมูล
// เครื่องนี้จำเลขล่าสุดที่เห็นไว้ใน localStorage (ww_reset_epoch) ถ้าเลขไม่ตรงกัน = มีการล้างเกิดขึ้น
// → ลบทุกคีย์ที่ขึ้นต้นด้วย "ww_" (ชื่อผู้เล่น, token, ห้องล่าสุด, รหัสโฮสต์/ผู้ทดสอบ ฯลฯ) ทั้ง
// localStorage และ sessionStorage แล้วกลับหน้าแรก ทำให้เครื่องนี้เป็น "เข้าเกมครั้งแรก" เหมือนใหม่
//
// เช็คเมื่อ: โหลดหน้า / ทุก 30 วินาที / กลับมาเปิดแท็บ / server ส่ง socket event "force_reset" มา
// (ผู้เล่นที่ออนไลน์อยู่จะโดนทันที ส่วนเครื่องที่ออฟไลน์จะโดนตอนเปิดเกมครั้งถัดไป)
// ถ้า server ยังไม่มีเลข (ส่งค่าว่างมา) จะไม่ทำอะไรเลย กันล้างเครื่องทุกคนโดยไม่ตั้งใจ
(function () {
    "use strict";

    var EPOCH_KEY = "ww_reset_epoch";
    var PREFIX = "ww_";
    var busy = false;

    // แท็บที่ Admin เปิดเป็นโหมดทดลอง (?tester=1) เป็น session แยกจากเกมจริง
    // และ server-control มีสิทธิ์ shield ห้องผู้ทดสอบจาก reset/reload อยู่แล้ว
    // Reset Guard นี้จึงต้อง "ข้ามทั้งระบบ" สำหรับ tester ตั้งแต่ต้นทาง ไม่ใช่รอให้ไปเจอ
    // resetEpoch แล้วค่อยกัน redirect เพราะเครื่องใหม่ที่ไม่มี ww_reset_epoch จะถูกมองว่า
    // เป็น epoch "0" และอาจถูกส่งกลับ index.html ทั้งที่ยังไม่เคยเล่นเกมจริงเลย
    var isTesterPage = false;
    try {
        isTesterPage = new URLSearchParams(window.location.search).get("tester") === "1";
    } catch (e) {
        isTesterPage = false;
    }

    function readStoredEpoch() {
        try { return localStorage.getItem(EPOCH_KEY); } catch (e) { return null; }
    }

    function wipeGameKeys() {
        var removed = 0;
        [window.localStorage, window.sessionStorage].forEach(function (store) {
            try {
                var keys = [];
                for (var i = 0; i < store.length; i++) keys.push(store.key(i));
                keys.forEach(function (k) {
                    if (k && k.indexOf(PREFIX) === 0 && k !== EPOCH_KEY) {
                        store.removeItem(k);
                        removed++;
                    }
                });
            } catch (e) { /* เบราว์เซอร์บล็อก storage — ข้าม */ }
        });
        return removed;
    }

    function goHome() {
        var target = (location.pathname === "/" || /\/index\.html$/.test(location.pathname))
            ? (location.pathname || "/")
            : "/";
        var sep = target.indexOf("?") >= 0 ? "&" : "?";
        try {
            location.replace(target + sep + "_ww_force=" + encodeURIComponent(String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8)));
        } catch (e) {
            location.replace(target);
        }
    }

    // เครื่องที่ไม่เคยจำเลขไว้ถือเป็น "0" (ค่าเริ่มต้นของ server ที่ยังไม่เคยกดล้าง)
    window.wwApplyResetEpoch = function (serverEpoch) {
        // Defense-in-depth: ถึงจะมีโค้ดอื่นเรียกฟังก์ชันนี้โดยตรง
        // tester ก็ห้ามถูก reset/redirect จากระบบ reset ของเกมจริง
        if (isTesterPage || !serverEpoch || busy) return;
        var stored = readStoredEpoch() || "0";
        if (stored === String(serverEpoch)) return;

        busy = true;
        var removed = wipeGameKeys();
        try { localStorage.setItem(EPOCH_KEY, String(serverEpoch)); } catch (e) {}
        // ไม่ว่าหน้านี้จะมี ww_ data หรือไม่ หลัง reset ถือเป็น session เก่าเสมอ
        // ต้องกลับหน้าแรกเพื่อเริ่ม identity รุ่นใหม่ (สำคัญกับแท็บที่เคยเล่นแต่ storage บางส่วนหายไปแล้ว)
        goHome();
        if (removed === 0) busy = false;
    };

    function check() {
        if (isTesterPage || busy) return;
        window.wwGetConfig({})
            .then(function (data) { if (data) window.wwApplyResetEpoch(data.resetEpoch); })
            .catch(function () { /* ออฟไลน์/server ล่ม — ไว้เช็คใหม่รอบหน้า */ });
    }

    // Tester ไม่ต้องมี reset polling ของเกมจริงเลย
    // เพราะ shared.server-control.js เป็นตัวตรวจ server/tester shield ของแท็บนี้อยู่แล้ว
    if (!isTesterPage) {
        check();
        setInterval(check, 30000);
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") check();
        });
    }
})();
