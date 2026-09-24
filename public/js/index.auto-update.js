(function () {
    // ===== UPDATE NOTIFIER (index.html เท่านั้น — จุดเดียวในระบบที่แจ้ง/ให้กดอัปเดต) =====
    // สถาปัตยกรรม:
    //   • host.html / player.html "ไม่มีระบบอัปเดตเลย" (ไม่มีสคริปต์ตรวจ version, ไม่มีแบนเนอร์, ไม่ reload/redirect เพราะ version เปลี่ยน)
    //     ผู้เล่นที่กำลังเล่นอยู่เล่นต่อไปตามปกติ ไม่มีอะไรมารบกวน
    //   • พอผู้เล่น "กลับมาหน้า index เอง" หน้านี้เทียบ version ปัจจุบันของ server (/api/config → version = hash เนื้อหาไฟล์เกมจริง)
    //     กับ "รุ่นที่เครื่องนี้เคยกดอัปเดตไว้ล่าสุด" (baseline ใน localStorage) ถ้าไม่ตรง → โชว์ overlay เต็มจอ "มีอัปเดตเกมใหม่"
    //   • ผู้ใช้ต้อง "กดปุ่มเอง" เท่านั้น ถึงจะโหลดรุ่นใหม่ (ไม่มี reload อัตโนมัติที่จุดไหนในไฟล์นี้)
    //
    // baseline: การเปิด index ครั้งแรกสุดของเครื่อง (ยังไม่มี baseline) ไม่ถือว่ามีอัปเดต → บันทึก baseline เงียบๆ ไม่ขึ้น overlay
    // version ไม่ผูกกับเวลาบูต/instance (ดู computeServerVersion ใน server.js) → Node restart ที่ไฟล์เหมือนเดิม หรือ Android/iOS ที่ได้ instance
    // คนละตัว จะเห็น version เดียวกัน ไม่เกิด overlay หลอก/วนลูป
    var WW_KNOWN_VERSION_KEY = "ww_update_known_version";
    var WW_LEGACY_PENDING_KEY = "ww_update_pending_version"; // ของระบบเก่าที่ host/player เคยเขียนไว้ — ไม่ใช้แล้ว ล้างทิ้งกันค้างในเครื่อง

    var wwKnownVersion = null;
    try {
        wwKnownVersion = localStorage.getItem(WW_KNOWN_VERSION_KEY);
        localStorage.removeItem(WW_LEGACY_PENDING_KEY);
    } catch (e) {}

    var wwOverlayShown = false;
    var wwApplyVersion = null; // version ที่ overlay กำลังจะพาไปอัปเดตเป็น เมื่อผู้ใช้กดปุ่ม
    var wwApplying = false;

    function wwSaveKnownVersion(v) {
        wwKnownVersion = v;
        try { localStorage.setItem(WW_KNOWN_VERSION_KEY, v); } catch (e) {}
    }

    // แสดง overlay เต็มจอ — เรียกครั้งเดียวพอ (ถ้าโชว์อยู่แล้วไม่ต้องทำซ้ำ)
    function wwShowUpdateOverlay(newVersion) {
        if (wwOverlayShown) return;
        wwOverlayShown = true;
        wwApplyVersion = newVersion;
        var overlay = document.getElementById("wwUpdateOverlay");
        if (overlay) overlay.classList.add("show");
        document.body.classList.add("ww-update-lock"); // กัน index scroll หนี overlay
    }

    // ดึง index/host/player + js/css ของทุกหน้า "ข้ามแคชจริง" (cache: "reload" = ข้ามแล้วเขียนทับแคชด้วยของใหม่)
    // เพื่อให้หน้าเกม (host/player) ที่ผู้ใช้จะเข้าหลังจากนี้ได้ไฟล์ชุดใหม่เดียวกันทุกเครื่อง (Safari/Android Chrome) ไม่ปนไฟล์เก่าจากแคช
    // รอไม่เกิน 6 วิ แล้วไปต่อไม่ว่าจะเสร็จหรือไม่ (เน็ตช้า/บางไฟล์พลาดไม่ทำให้ปุ่มค้าง)
    function wwRefreshAssetCache() {
        var seen = {};
        function fetchFresh(u) {
            if (seen[u]) return Promise.resolve();
            seen[u] = 1;
            return fetch(u, { cache: "reload", credentials: "same-origin" })
                .then(function (r) { return r.text().then(function (t) { return { url: u, text: t, ok: r.ok }; }); })
                .catch(function () { return null; });
        }
        function refsOf(pageRes) {
            var out = [];
            if (!pageRes || !pageRes.ok) return out;
            try {
                var doc = new DOMParser().parseFromString(pageRes.text, "text/html");
                var nodes = doc.querySelectorAll("script[src], link[rel~='stylesheet'][href]");
                for (var i = 0; i < nodes.length; i++) {
                    var raw = nodes[i].getAttribute("src") || nodes[i].getAttribute("href");
                    var a = new URL(raw, location.origin + "/");
                    if (a.origin === location.origin) { a.hash = ""; out.push(a.href); }
                }
            } catch (e) { /* ข้าม */ }
            return out;
        }
        var pages = ["/", "/host.html", "/player.html"];
        var job = Promise.all(pages.map(fetchFresh)).then(function (results) {
            var all = [];
            results.forEach(function (r) { all = all.concat(refsOf(r)); });
            return Promise.all(all.map(fetchFresh));
        });
        var timeout = new Promise(function (resolve) { setTimeout(resolve, 6000); });
        return Promise.race([job, timeout]);
    }

    // ผู้ใช้กด "🔄 อัปเดตเกมเพื่อเล่น" — เรียกจาก onclick ใน index.html (จุดเดียวที่โหลดรุ่นใหม่)
    // จำ version ใหม่เป็น baseline ก่อน → ล้างแคชไฟล์เกม → โหลด index ใหม่ (ต่อ query กันโดน cache เดิม)
    function wwApplyUpdate() {
        if (wwApplying) return;
        wwApplying = true;
        var btn = document.querySelector("#wwUpdateOverlay button");
        if (btn) { btn.disabled = true; btn.textContent = "กำลังอัปเดต..."; }
        if (wwApplyVersion) wwSaveKnownVersion(wwApplyVersion);
        var go = function () { window.location.href = window.location.pathname + "?_wwupd=" + Date.now(); };
        wwRefreshAssetCache().then(go, go);
    }
    window.wwApplyUpdate = wwApplyUpdate;

    var wwCheckVersionPending = null;

    function wwCheckVersion() {
        if (wwOverlayShown) return; // overlay ขึ้นแล้ว รอผู้ใช้กดเอง ไม่ต้องเช็คซ้ำ
        if (wwCheckVersionPending) return wwCheckVersionPending;
        wwCheckVersionPending = window.wwGetConfig({})
            .then(function (data) {
                if (!data) return;
                var badge = document.getElementById("wwVersionBadge");
                if (badge && data.appVersion) badge.textContent = data.appVersion;
                if (typeof data.version !== "string" || !data.version) return; // ไม่มีค่า version → ไม่ตัดสินอะไร

                // ครั้งแรกสุดที่เครื่องนี้เปิด index (ยังไม่เคยมี baseline เลย) — ตั้ง baseline เงียบ ๆ
                // ไม่ถือเป็นการเจออัปเดต (กัน popup โผล่ทันทีตั้งแต่เปิดใช้งานครั้งแรก)
                if (wwKnownVersion === null) {
                    wwSaveKnownVersion(data.version);
                    return;
                }

                // version ปัจจุบันของ server ไม่ตรงกับรุ่นที่เครื่องนี้เคยใช้งานล่าสุด → มีรุ่นใหม่ → โชว์ overlay ให้ผู้ใช้กดเอง
                if (data.version !== wwKnownVersion) {
                    wwShowUpdateOverlay(data.version);
                }
            })
            .catch(function () { /* เน็ตหลุดชั่วคราว/โหลดไม่ติด ไม่ต้องทำอะไร ลองใหม่รอบหน้า */ })
            .then(function () { wwCheckVersionPending = null; });
        return wwCheckVersionPending;
    }

    wwCheckVersion();
    // เดิมเช็คทุก 120 วิ (2 นาที) — นานเกินไปสำหรับคนที่ "ค้างอยู่หน้า index เฉยๆ ไม่สลับแท็บ/แอปเลย"
    // (visibilitychange ด้านล่างไม่ช่วยกรณีนี้เพราะ visibility ไม่เคยเปลี่ยน) ลดลงมาเป็น 20 วิ ให้ใกล้เคียงกับ
    // รอบโพล /api/config ของ shared.server-control.js (ก็ 20 วิเหมือนกัน อยู่แล้วบนหน้านี้) จะได้เห็น overlay
    // ไวขึ้นมากแม้ไม่ได้ทำอะไรกับหน้าเลย
    setInterval(wwCheckVersion, 20000);

    // เช็คทันทีตอนกลับมาเปิดแท็บอีกครั้ง (สลับแอป/ปลดล็อกจอ) ไม่ต้องรอ interval
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") wwCheckVersion();
    });
    // "focus" ครอบกรณีที่ visibilitychange ไม่ยิง (บางเบราว์เซอร์/บาง flow บนมือถือ เช่น สลับมาจาก
    // แอปอื่นแบบ split-screen หรือคลิกกลับมาที่แท็บจากหน้าต่างอื่นบนเดสก์ท็อป) — ถ้าซ้ำกับ visibilitychange
    // ก็แค่เช็คซ้ำเฉยๆ ไม่มีผลข้างเคียง
    window.addEventListener("focus", wwCheckVersion);
    // "pageshow" ครอบกรณีเบราว์เซอร์ดึงหน้าเดิมออกจาก back/forward cache (bfcache) กลับมาแสดงตรงๆ
    // (พบบ่อยบน iOS Safari ตอนสลับแอปแล้วกลับมา) ซึ่งบาง engine ไม่นับเป็น visibilitychange/focus ใหม่
    window.addEventListener("pageshow", function (e) {
        if (e.persisted) wwCheckVersion();
    });

    // ===== เช็คซ้ำอีกทีตอน "กดสร้างห้อง"/"กดเข้าร่วมห้อง" (ดักคนละกรณีกับด้านบน) =====
    // ด้านบนทั้งหมดคือเช็ค "เชิงรับ" (พาสซีฟ) — รอ interval/event มาถึงค่อยเช็ค ถ้าผู้เล่นกดปุ่มเข้าเกมในช่วงรอยต่อ
    // พอดี (เช่น เพิ่งเปิดหน้าเสร็จ ยังไม่ทันครบ 20 วิแรก) อาจหลุดเข้าไปเล่นด้วยไฟล์รุ่นเก่าได้ จึงเพิ่มการเช็ค
    // "เชิงรุก" ครั้งเดียวตรงจังหวะกดปุ่มเลย — ยิง /api/config สดๆ ทันที (ไม่รอ cache/interval):
    //   • มีรุ่นใหม่ → โชว์ overlay บังไว้เหมือนเดิม "ไม่พา" ไปหน้า host/player (ผู้เล่นกดอัปเดตเองจาก overlay)
    //   • รุ่นเดิม/เช็คไม่สำเร็จ (เน็ตมีปัญหาชั่วคราว) → เข้าเกมได้เลยตามปกติ ไม่บล็อกผู้เล่นเพราะเน็ตสะดุด
    // index.main.js เรียกผ่าน window.wwGateBeforeNav(goFn) ก่อน location.href ไปหน้า host.html/player.html
    function wwGateBeforeNav(cb) {
        if (wwOverlayShown) return; // overlay ขึ้นอยู่แล้วจากเช็คก่อนหน้า — บล็อกไปเลย ไม่ต้องเช็คซ้ำ/ไม่พาไปไหน
        window.wwGetConfig({})
            .then(function (data) {
                if (!data || typeof data.version !== "string" || !data.version) { cb(); return; }
                if (wwKnownVersion === null) { wwSaveKnownVersion(data.version); cb(); return; }
                if (data.version !== wwKnownVersion) { wwShowUpdateOverlay(data.version); return; }
                cb();
            })
            .catch(cb); // เน็ตหลุดชั่วคราว/เช็คไม่สำเร็จ — ปล่อยเข้าเกมตามปกติ ไม่บล็อกผู้เล่นเพราะเรื่องนี้
    }
    window.wwGateBeforeNav = wwGateBeforeNav;
})();
