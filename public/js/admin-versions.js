/* ============================================================
   ADMIN — ELASTIC BEANSTALK VERSION MANAGER
   ============================================================ */
(function () {
    "use strict";

    const state = {
        loading: false,
        environment: null,
        versions: [],
        error: "",
        downloading: new Set(),
    };

    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function formatDate(value) {
        if (!value) return "—";
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return "—";
        try {
            return new Intl.DateTimeFormat("th-TH", {
                dateStyle: "medium",
                timeStyle: "short",
            }).format(d);
        } catch (_) {
            return d.toISOString();
        }
    }

    function statusClass(status) {
        const s = String(status || "").toLowerCase();
        if (s === "processed") return "processed";
        if (s === "unprocessed") return "unprocessed";
        if (s === "failed" || s === "processing" || s === "building") return "unavailable";
        return "unavailable";
    }

    function environmentStatusHtml(env) {
        const busy = String(env?.status || "") !== "Ready" || !!env?.abortableOperationInProgress;
        const cls = busy ? "busy" : "ready";
        const label = busy ? (env?.abortableOperationInProgress ? "มี operation กำลังทำงาน" : String(env?.status || "กำลังตรวจสอบ")) : "Ready";
        return `<span class="versions-status-badge ${cls}">${busy ? "⏳" : "●"} ${escapeHtml(label)}</span>`;
    }

    function renderEnvironment() {
        const host = $("adminVersionsEnvironment");
        if (!host) return;
        const env = state.environment;
        if (!env) {
            host.innerHTML = state.error
                ? `<div class="versions-error">${escapeHtml(state.error)}</div>`
                : `<div class="versions-empty">กำลังโหลดข้อมูล Elastic Beanstalk...</div>`;
            return;
        }
        const current = env.versionLabel || "unknown";
        host.innerHTML = `
            <div class="versions-environment-card">
                <div class="versions-env-head">
                    <div>
                        <div class="versions-env-kicker">ELASTIC BEANSTALK ENVIRONMENT</div>
                        <h3 class="versions-env-title">${escapeHtml(env.name || "—")}</h3>
                    </div>
                    <div class="versions-env-actions">
                        ${environmentStatusHtml(env)}
                        <button type="button" class="btn btn-ghost" id="adminVersionsRefreshBtn">🔄 รีเฟรช</button>
                    </div>
                </div>
                <div class="versions-env-grid">
                    <div class="versions-env-stat"><span>Application</span><b>${escapeHtml(env.applicationName || "—")}</b></div>
                    <div class="versions-env-stat"><span>Running EB Version</span><b>${escapeHtml(current)}</b></div>
                    <div class="versions-env-stat"><span>Health</span><b>${escapeHtml(env.health || env.healthStatus || "—")}</b></div>
                    <div class="versions-env-stat"><span>Deployment</span><b>${env.abortableOperationInProgress ? "กำลังทำงาน" : String(env.status || "—")}</b></div>
                </div>
                <div class="versions-hint">📌 ดาวน์โหลด ZIP ไม่เปลี่ยนเวอร์ชันที่กำลังรัน · การย้อนกลับจะเปลี่ยน <b>environment จริง</b> ให้ใช้ Application Version ที่เลือก และจะไม่มีการย้อนกลับอัตโนมัติภายหลัง</div>
            </div>
        `;
        $("adminVersionsRefreshBtn")?.addEventListener("click", () => window.loadAdminVersions?.());
    }

    function renderVersions() {
        const host = $("adminVersionsList");
        if (!host) return;
        if (state.error && !state.environment) {
            host.innerHTML = "";
            return;
        }
        if (!state.versions.length) {
            host.innerHTML = `<div class="versions-empty">ไม่พบ Application Version ใน Application นี้</div>`;
            return;
        }

        const envBusy = String(state.environment?.status || "") !== "Ready" || !!state.environment?.abortableOperationInProgress;
        const rows = state.versions.map((version) => {
            const label = String(version.versionLabel || "");
            const status = String(version.status || "ไม่ทราบ");
            const statusCls = statusClass(status);
            const current = !!version.current;
            const allowed = !!version.rollbackAllowed && !envBusy;
            const downloading = state.downloading.has(label);
            const currentBadge = current ? `<span class="versions-state-badge current">กำลังใช้งาน</span>` : "";
            const sourceBadge = version.downloadable
                ? `<span class="versions-status-badge ready">📦 source bundle</span>`
                : `<span class="versions-state-badge unavailable">ไม่มีไฟล์ต้นฉบับ</span>`;
            const rollbackTitle = envBusy
                ? "Environment ยังไม่พร้อมรับการสลับเวอร์ชัน"
                : (!isVersionDeployable(status) ? `สถานะ ${status} ยังไม่พร้อมสำหรับการย้อนกลับ` : `ย้อนกลับไปใช้ ${label}`);
            return `
                <div class="versions-row" data-version-row="${escapeHtml(label)}">
                    <div class="versions-version-cell">
                        <div class="versions-version-label"><code>${escapeHtml(label)}</code>${currentBadge}</div>
                        <div class="versions-description">${escapeHtml(version.description || "ไม่มีคำอธิบาย")}</div>
                    </div>
                    <div><span class="versions-state-badge ${statusCls}">${escapeHtml(status)}</span></div>
                    <div class="versions-muted">${escapeHtml(formatDate(version.dateCreated))}</div>
                    <div class="versions-muted">${escapeHtml(formatDate(version.dateUpdated || version.dateCreated))}</div>
                    <div class="versions-actions">
                        ${sourceBadge}
                        <button type="button" class="btn btn-ghost" data-version-download="${escapeHtml(label)}" ${(!version.downloadable || downloading) ? "disabled" : ""}>${downloading ? "⏳ กำลังเตรียมไฟล์" : "📥 ดาวน์โหลด ZIP"}</button>
                        <button type="button" class="btn btn-danger" data-version-rollback="${escapeHtml(label)}" title="${escapeHtml(rollbackTitle)}" ${(!allowed || current) ? "disabled" : ""}>↩️ ย้อนกลับ</button>
                    </div>
                </div>
            `;
        }).join("");

        host.innerHTML = `<div class="versions-table-wrap">
            <div class="versions-table-head"><div>Version</div><div>Status</div><div>Created</div><div>Updated</div><div>Actions</div></div>
            ${rows}
        </div>`;

        host.querySelectorAll("[data-version-download]").forEach((button) => {
            button.addEventListener("click", () => requestDownload(button.dataset.versionDownload));
        });
        host.querySelectorAll("[data-version-rollback]").forEach((button) => {
            button.addEventListener("click", () => askRollback(button.dataset.versionRollback));
        });
    }

    function isVersionDeployable(status) {
        return String(status || "") === "Processed" || String(status || "") === "Unprocessed";
    }

    function setLoading(loading) {
        state.loading = !!loading;
        const btn = $("adminVersionsRefreshBtn");
        if (btn) btn.disabled = state.loading;
    }

    async function loadAdminVersions() {
        if (state.loading) return false;
        const authReady = typeof window.ensureAdminLogin === "function" ? await window.ensureAdminLogin() : true;
        if (!authReady) return false;
        setLoading(true);
        state.error = "";
        renderEnvironment();
        try {
            const { response, data } = await window.adminFetchJson("/api/admin/versions", { method: "GET", cache: "no-store" });
            if (!response.ok || !data?.ok) {
                const code = data?.code || data?.error || `HTTP_${response.status}`;
                throw new Error(versionErrorMessage(code));
            }
            state.environment = data.environment || null;
            state.versions = Array.isArray(data.versions) ? data.versions : [];
            state.error = "";
            renderEnvironment();
            renderVersions();
            return true;
        } catch (e) {
            state.environment = null;
            state.versions = [];
            state.error = e?.message || "โหลดประวัติเวอร์ชันไม่สำเร็จ";
            renderEnvironment();
            renderVersions();
            return false;
        } finally {
            setLoading(false);
        }
    }

    function versionErrorMessage(code) {
        const c = String(code || "");
        if (c === "EB_VERSION_MANAGER_NOT_CONFIGURED") return "เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่า EB_ENVIRONMENT_NAME จึงไม่สามารถอ่าน Application Version ได้";
        if (c === "EB_VERSION_AWS_CREDENTIALS") return "Server ไม่มี AWS credential ที่ใช้ดู Elastic Beanstalk ได้";
        if (c === "EB_VERSION_LIST_FAILED") return "อ่านประวัติ Application Version จาก Elastic Beanstalk ไม่สำเร็จ — ดู Diagnostics เพื่อเช็ก IAM";
        if (c === "EB_VERSION_SOURCE_ACCESS_DENIED" || c === "EB_VERSION_AWS_PERMISSION_FAILED") return "AWS ปฏิเสธคำสั่ง — ตรวจ IAM ของ Elastic Beanstalk Instance Role";
        return `ดำเนินการไม่สำเร็จ (${c})`;
    }

    async function requestDownload(versionLabel) {
        const label = String(versionLabel || "").trim();
        if (!label || state.downloading.has(label)) return;
        const authReady = typeof window.ensureAdminLogin === "function" ? await window.ensureAdminLogin() : true;
        if (!authReady) return;
        state.downloading.add(label);
        renderVersions();
        try {
            const { response, data } = await window.adminFetchJson("/api/admin/versions/download-ticket", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ versionLabel: label }),
                cache: "no-store",
            });
            if (!response.ok || !data?.ok || !data.url) {
                const code = data?.code || data?.error || `HTTP_${response.status}`;
                throw new Error(versionErrorMessage(code));
            }
            // The ticket URL is short-lived and one-time. Content-Disposition on the
            // ticket route makes the browser save the EB source bundle as a ZIP.
            window.location.assign(String(data.url));
        } catch (e) {
            state.error = e?.message || "เตรียมไฟล์ดาวน์โหลดไม่สำเร็จ";
            renderEnvironment();
            if (window.wwToast) window.wwToast(state.error, { type: "error" });
        } finally {
            state.downloading.delete(label);
            renderVersions();
        }
    }

    async function askRollback(versionLabel) {
        const label = String(versionLabel || "").trim();
        if (!label) return;
        const version = state.versions.find((item) => String(item.versionLabel || "") === label);
        if (!version || !version.rollbackAllowed) return;
        const authReady = typeof window.ensureAdminLogin === "function" ? await window.ensureAdminLogin() : true;
        if (!authReady) return;
        const current = String(state.environment?.versionLabel || "");
        window.openActionModal?.({
            url: "/api/admin/versions/rollback",
            body: { versionLabel: label },
            title: `↩️ ย้อนกลับไปใช้ ${label}`,
            note: `คำสั่งนี้จะสั่ง Elastic Beanstalk environment จริง (${state.environment?.name || "—"}) ให้เปลี่ยนจาก ${current || "เวอร์ชันปัจจุบัน"} ไปใช้ Application Version ${label} ที่มีอยู่แล้ว · ไม่ต้องอัปโหลด ZIP ใหม่ · ระหว่าง deploy ผู้เล่นทั้งหมดจะได้รับระบบรุ่นที่กำลังถูกนำกลับมาใช้ · ไม่มีการย้อนกลับอัตโนมัติภายหลัง`,
            confirmLabel: "ยืนยันย้อนกลับ",
            tone: "btn-danger",
            resultEl: "adminVersionActionResult",
            describe: (data) => `✅ ส่งคำสั่งย้อนกลับแล้ว: ${data.previousVersion || current || "—"} → ${data.requestedVersion || label} · Elastic Beanstalk จะเริ่ม deployment และสถานะด้านบนจะเปลี่ยนตามจริง`,
            warn: () => true,
            afterSuccess: () => {
                window.setTimeout(() => window.loadAdminVersions?.(), 700);
                window.setTimeout(() => window.loadAdminVersions?.(), 4000);
            },
        });
    }

    window.loadAdminVersions = loadAdminVersions;
    window.requestAdminVersionDownload = requestDownload;
    window.askAdminVersionRollback = askRollback;

    document.addEventListener("click", (event) => {
        if (!event.target.closest("#adminVersionsList")) return;
        // Delegation is intentionally also kept in renderVersions for deterministic
        // testability; this listener does nothing when a handler has already run.
    });
})();
