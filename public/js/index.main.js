// ===== Local Profile =====
// หน้าแรกเก็บชื่อโปรไฟล์ท้องถิ่นเพียงอย่างเดียว; ไม่สร้างบัญชีผู้เล่นและไม่ส่งข้อมูลบัญชีไป server.
const PLAYER_NAME_KEY = "ww_profile_name";
const NAME_MAX_LENGTH = 24;
const RESERVED_TESTER_NAME_RE = /^(?:player|ผู้เล่น)(?:[0-9]+)?$/iu;
let indexProfileDocked = false;

function shouldDockIndexProfile() {
    return window.matchMedia("(min-width:1120px) and (min-height:560px)").matches;
}

function normalizeNameInput(value) {
    return String(value ?? "").replace(/\s+/gu, "").slice(0, NAME_MAX_LENGTH);
}

function isReservedTesterNameInput(value) {
    return RESERVED_TESTER_NAME_RE.test(normalizeNameInput(value));
}

function bindNameInputRestrictions(input) {
    if (!input || input.dataset.namePolicyBound === "1") return input;
    input.dataset.namePolicyBound = "1";
    // กด Space บนคีย์บอร์ดจริง = ไม่มีผลทันที; input handler ด้านล่างรองรับ paste/IME/การกรอกที่ไม่ผ่าน keydown ด้วย
    input.addEventListener("keydown", (event) => {
        if (event.key === " " || event.code === "Space") event.preventDefault();
    });
    input.addEventListener("input", () => {
        const normalized = normalizeNameInput(input.value);
        if (input.value !== normalized) input.value = normalized;
    });
    return input;
}

const indexSocket = io();
const indexRuntime = window.WWGameRuntime?.attach(indexSocket, { page: "index" });

indexSocket.on("serverInfo", function (info) {
    if (window.wwSetServerVersion) window.wwSetServerVersion(info && info.version);
});
function getSavedDisplayName() {
    const profileName = normalizeNameInput(window.wwProfile?.getName?.() || "");
    if (profileName) return profileName;
    try {
        return normalizeNameInput(localStorage.getItem(PLAYER_NAME_KEY) || "");
    } catch (_) {
        return "";
    }
}

function syncIndexProfileLayout(){
    const body = document.body;
    const name = getSavedDisplayName();
    const shouldDock = !!name && shouldDockIndexProfile();
    const wasDocked = indexProfileDocked;
    indexProfileDocked = shouldDock;
    body.classList.toggle("profile-docked", shouldDock);
    const profileModal = document.getElementById("profileModal");
    if (profileModal) profileModal.setAttribute("aria-modal", shouldDock ? "false" : "true");
    const nameBadge = document.getElementById("nameBadge");
    if (nameBadge && name) nameBadge.setAttribute("aria-hidden", shouldDock ? "true" : "false");
    if (shouldDock && !profileModal?.classList.contains("hidden")) return;
    if (shouldDock && profileModal?.classList.contains("hidden")) { openProfileModal(); return; }
    if (!shouldDock && wasDocked) closeProfileModal();
}
function syncProfileNameStores(name){
    const safe = normalizeNameInput(name);
    if (!safe || !window.wwProfile?.setName?.(safe)) return false;
    try { localStorage.setItem(PLAYER_NAME_KEY, safe); } catch (_) {}
    return true;
}
function saveDisplayName(name){
    const safe = normalizeNameInput(name);
    if (!safe || isReservedTesterNameInput(safe)) return false;
    syncProfileNameStores(safe);
    return true;
}

// สลับ UI ของชื่อหน้าแรกตามสถานะโปรไฟล์: ก่อนตั้งชื่อใช้ช่องกรอก; หลังตั้งแล้วใช้ชื่อโปรไฟล์ตามขนาดพื้นที่
// เรียกทั้งตอนเปิดหน้าครั้งแรกและทันทีหลังบันทึกชื่อ
function refreshNameUI(){
    const name = getSavedDisplayName();
    const nameField = document.getElementById("nameField");
    const nameBadge = document.getElementById("nameBadge");
    if (name) {
        nameField.classList.add("hidden");
        document.getElementById("nameBadgeText").textContent = name;
        nameBadge.classList.remove("hidden");
        nameBadge.setAttribute("aria-label", `เปิดโปรไฟล์ของ ${name}`);
        nameBadge.setAttribute("aria-hidden", document.body.classList.contains("profile-docked") ? "true" : "false");
    } else {
        nameField.classList.remove("hidden");
        nameBadge.classList.add("hidden");
        nameBadge.removeAttribute("aria-label");
        nameBadge.removeAttribute("aria-hidden");
    }
    syncIndexProfileLayout();
}

// เติมชื่อล่าสุดที่เคยตั้งไว้ให้อัตโนมัติทันทีที่เปิดหน้า (ถ้าเคยตั้งมาก่อน) แล้วสลับ UI ให้ตรงสถานะ
const displayNameInput = document.getElementById("displayNameInput");
bindNameInputRestrictions(displayNameInput);
if (displayNameInput) displayNameInput.value = normalizeNameInput(getSavedDisplayName());
refreshNameUI();

// ตรวจ + บันทึกชื่อก่อนจะพาไปหน้าอื่นเสมอ — ถ้ายังไม่กรอกชื่อ โชว์ข้อความเตือน + เขย่าช่องชื่อ
// แล้ว "ไม่พาไปต่อ" คืนค่า false ให้ฟังก์ชันที่เรียกใช้หยุดทำงานต่อ
function ensureDisplayName(){
    const input = document.getElementById("displayNameInput");
    const name = normalizeNameInput(input.value) || normalizeNameInput(getSavedDisplayName());
    input.value = name;
    if (!name) {
        document.getElementById("displayNameError").textContent = "กรอกชื่อของคุณก่อนนะ";
        input.classList.remove("shake");
        void input.offsetWidth;
        input.classList.add("shake");
        input.focus();
        return false;
    }
    if (isReservedTesterNameInput(name)) {
        document.getElementById("displayNameError").textContent = "ชื่อนี้สงวนไว้สำหรับ Player Tester";
        input.classList.remove("shake");
        void input.offsetWidth;
        input.classList.add("shake");
        input.focus();
        return false;
    }
    document.getElementById("displayNameError").textContent = "";
    if (!saveDisplayName(name)) return false;
    refreshNameUI(); // ตั้งชื่อสำเร็จครั้งแรก — ซ่อนช่องกรอกทันที เปลี่ยนไปโชว์ป้ายมุมขวาบนแทน
    return true;
}

document.getElementById("displayNameInput").addEventListener("input", () => {
    document.getElementById("displayNameError").textContent = "";
});

function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function openProfileModal(){
    const name = getSavedDisplayName();
    if (!name) return;
    const modal = document.getElementById("profileModal");
    const nameEl = document.getElementById("profileModalName");
    const body = document.getElementById("profileModalBody");
    if (nameEl) nameEl.textContent = name;
    if (body) body.innerHTML = '<div class="profile-simple"><div>โปรไฟล์ผู้เล่น</div><small>ใช้สำหรับแสดงชื่อในเกมเท่านั้น โดยเก็บเฉพาะชื่อไว้บนเครื่อง</small></div>';
    if (modal) modal.classList.remove("hidden");
}
function openRenameProfilePrompt(){
    const nameEl=document.getElementById("profileModalName");
    const editBtn=document.getElementById("profileEditNameBtn");
    if(!nameEl||!editBtn||nameEl.dataset.editing==="1") return;
    const current=getSavedDisplayName();
    const input=document.createElement("input");
    input.type="text"; input.id="profileNameInput"; input.className="profile-modal-name-edit";
    input.maxLength=24; input.autocomplete="off"; input.value=normalizeNameInput(current);
    bindNameInputRestrictions(input);
    input.addEventListener("keydown",(event)=>{
        if(event.key==="Enter"){event.preventDefault();submitRenameProfile();}
        if(event.key==="Escape"){event.preventDefault();closeRenameProfileEditor();}
    });
    nameEl.dataset.editing="1"; nameEl.replaceWith(input);
    editBtn.textContent="✓"; editBtn.title="บันทึกชื่อ"; editBtn.onclick=submitRenameProfile;
    setTimeout(()=>{input.focus();input.select();},30);
}
function closeRenameProfileEditor(){
    const input=document.getElementById("profileNameInput");
    const editBtn=document.getElementById("profileEditNameBtn");
    if(!input||!editBtn)return;
    const nameEl=document.createElement("div");
    nameEl.className="profile-modal-name"; nameEl.id="profileModalName"; nameEl.textContent=getSavedDisplayName()||"ผู้เล่น";
    input.replaceWith(nameEl); editBtn.textContent="✏️"; editBtn.title="เปลี่ยนชื่อ"; editBtn.onclick=openRenameProfilePrompt;
}
function submitRenameProfile(){
    const input=document.getElementById("profileNameInput");
    const newName=normalizeNameInput(input?.value||"");
    if(!newName||newName==="ผู้เล่น"){wwToast("กรุณาใช้ชื่อที่ถูกต้อง",{type:"error"});input?.focus();return;}
    syncProfileNameStores(newName); refreshNameUI(); closeRenameProfileEditor(); 
    wwToast("เปลี่ยนชื่อเรียบร้อย",{type:"success"});
}
function closeProfileModal(){
    closeRenameProfileEditor();
    // Desktop dock is intentionally persistent; only the small-screen modal can be closed.
    if (document.body.classList.contains("profile-docked")) return;
    document.getElementById("profileModal").classList.add("hidden");
}

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const renameInput = document.getElementById("profileNameInput");
    if (renameInput) {
        closeRenameProfileEditor();
        return;
    }
    if (!document.getElementById("profileModal")?.classList.contains("hidden")) {
        if (!document.body.classList.contains("profile-docked")) closeProfileModal();
    }
});

window.addEventListener("resize", syncIndexProfileLayout, { passive:true });

indexSocket.on("name_updated_by_host", (data) => {
    if (!data?.name) return;
    syncProfileNameStores(data.name);
    refreshNameUI();
    
});


function player(){
    if (!ensureDisplayName()) return;
    const name = encodeURIComponent(getSavedDisplayName());
    const go = () => { window.location.href = "player.html?name=" + name; };
    // เช็ครุ่นสดๆ อีกทีตรงจังหวะกดปุ่มก่อนพาไปหน้าเกมจริง — ดู wwGateBeforeNav ใน index.auto-update.js
    if (window.wwGateBeforeNav) wwGateBeforeNav(go); else go();
}

// ===== เข้าโหมดโฮสต์ =====
// เดิมมีรหัสผ่านกันคนเปิดมาเจอเฉยๆกดสร้างห้องมั่ว ตอนนี้ตัดออกแล้ว กดแล้วเข้าห้องได้เลย
function openHostModal(){
    if (!ensureDisplayName()) return;
    const go = () => { window.location.href = "host.html?name=" + encodeURIComponent(getSavedDisplayName()); };
    // เช็ครุ่นสดๆ อีกทีตรงจังหวะกดปุ่มก่อนพาไปหน้าเกมจริง — ดู wwGateBeforeNav ใน index.auto-update.js
    if (window.wwGateBeforeNav) wwGateBeforeNav(go); else go();
}

document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('gesturechange', e => e.preventDefault());
document.addEventListener('touchmove', e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });

window.openProfileModal = openProfileModal; window.closeProfileModal = closeProfileModal;
