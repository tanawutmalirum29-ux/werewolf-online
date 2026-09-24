/* Admin Shell: wraps the real index page and exposes commands/context without adding navigation tabs. */
(function(){
  "use strict";
  const $=(id)=>document.getElementById(id);
  const state={selected:null, indexReady:false,status:{server:"—",rooms:"—",players:"—",audit:"—"}};
  function emit(type,detail={}){ try{window.dispatchEvent(new CustomEvent("ww-admin-event",{detail:{type,...detail}}));}catch(_){} }
  function escape(s){return String(s??"").replace(/[&<>\"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m]));}
  function buildUI(){
    const legacyWrap=document.querySelector(".admin-wrap");
    const hero=legacyWrap?.querySelector(".admin-hero");
    if(!legacyWrap||!hero||document.getElementById("adminShellRoot")) return;
    const root=document.createElement("div"); root.id="adminShellRoot"; root.className="admin-shell-root";
    root.innerHTML=`<aside class="admin-shell-rail" aria-label="คำสั่งลัด"><button class="admin-shell-brand" type="button" data-shell-command="dashboard.open" title="ภาพรวม">🐺</button><button class="admin-shell-quick" type="button" id="adminShellCommandBtn">⚡<span>คำสั่ง</span></button><button class="admin-shell-quick" type="button" data-shell-command="players.open">👥<span>ผู้เล่น</span></button><button class="admin-shell-quick" type="button" data-shell-command="rooms.open">🏠<span>ห้อง</span></button><button class="admin-shell-quick" type="button" data-shell-command="diagnostics.open">🩺<span>ตรวจ</span></button></aside><main class="admin-shell-main"><section class="admin-shell-index" aria-label="หน้า Index จริง"><iframe id="adminGameSurface" title="Werewolf Online — Index จริง" src="/index.html?embedded=admin" loading="eager" referrerpolicy="same-origin"></iframe><div class="admin-shell-index-status" id="adminIndexStatus">กำลังโหลดหน้าเกมจริง...</div></section><section class="admin-shell-status-strip" aria-label="สถานะระบบ"><div><span>Server</span><b id="adminShellServerStatus">—</b></div><div><span>ห้อง</span><b id="adminShellRoomStatus">—</b></div><div><span>ผู้เล่น</span><b id="adminShellPlayerStatus">—</b></div><div><span>Runtime Audit</span><b id="adminShellAuditStatus">—</b></div></section></main><aside class="admin-shell-context" id="adminShellContext"><div class="admin-shell-context-empty"><span>🎯</span><b>ยังไม่ได้เลือก</b><p>เลือกผู้เล่นหรือห้องจากคำสั่งลัด แล้วแผงนี้จะกลายเป็นศูนย์ควบคุมตามสิ่งที่เลือก</p></div></aside><div class="admin-shell-palette hidden" id="adminCommandPalette" role="dialog" aria-modal="true" aria-labelledby="adminCommandTitle"><div class="admin-shell-palette-backdrop" data-shell-close></div><div class="admin-shell-palette-card"><div class="admin-shell-palette-head"><div><div class="admin-shell-kicker">ADMIN COMMAND</div><h2 id="adminCommandTitle">คำสั่งลัด</h2></div><button class="admin-shell-close" type="button" data-shell-close>×</button></div><div class="admin-shell-palette-search"><span>⌕</span><input id="adminCommandSearch" autocomplete="off" placeholder="ค้นหาคำสั่ง เช่น ผู้เล่น, ห้อง, reload, bug..."></div><div id="adminCommandList" class="admin-shell-command-list"></div><div class="admin-shell-palette-hint">กด <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> เพื่อเปิด · <kbd>Esc</kbd> เพื่อปิด</div></div></div>`;
    legacyWrap.insertAdjacentElement("afterend",root);
    document.querySelector(".admin-bottom-dock")?.setAttribute("hidden","");
    document.body.classList.add("admin-shell-enabled");
    bind(); renderCommands("");
  }
  function openPalette(){const p=$("adminCommandPalette"); if(!p)return; p.classList.remove("hidden"); document.body.classList.add("admin-shell-palette-open"); setTimeout(()=>$("adminCommandSearch")?.focus(),30); renderCommands($("adminCommandSearch")?.value||"");}
  function closePalette(){const p=$("adminCommandPalette");if(!p)return;p.classList.add("hidden");document.body.classList.remove("admin-shell-palette-open");}
  async function run(id){
    const c=window.WWAdminCommandRegistry?.find(id);if(!c)return;
    if(c.risk) emit("COMMAND_RISK",{commandId:id,risk:c.risk});
    try{closePalette();await window.WWAdminCommandRegistry.run(id);emit("COMMAND_FINISHED",{commandId:id,ok:true});}
    catch(e){emit("COMMAND_FINISHED",{commandId:id,ok:false,error:e?.message||String(e)});if(window.wwToast) window.wwToast("คำสั่งไม่สำเร็จ: "+(e?.message||"unknown"),{type:"error"});}
  }
  function renderCommands(q){
    const list=$("adminCommandList");if(!list)return;const items=window.WWAdminCommandRegistry?.search(q)||[];
    if(!items.length){list.innerHTML='<div class="admin-shell-empty">ไม่พบคำสั่งที่ค้นหา</div>';return;}
    let last=""; list.innerHTML=items.map(c=>{const group=c.category!==last?(last=c.category,`<div class="admin-shell-command-group">${escape(c.category)}</div>`):"";return group+`<button type="button" class="admin-shell-command" data-command-id="${escape(c.id)}"><span class="admin-shell-command-icon">${c.icon}</span><span class="admin-shell-command-copy"><b>${escape(c.title)}</b><small>${escape(c.id)}</small></span>${c.risk?`<span class="admin-shell-command-risk">${escape(c.risk)}</span>`:""}</button>`;}).join("");
  }
  function setContext(data){
    state.selected=data||null;const el=$("adminShellContext");if(!el)return;
    if(!data){el.innerHTML='<div class="admin-shell-context-empty"><span>🎯</span><b>ยังไม่ได้เลือก</b><p>เลือกผู้เล่นหรือห้องจากคำสั่งลัด แล้วแผงนี้จะกลายเป็นศูนย์ควบคุมตามสิ่งที่เลือก</p></div>';return;}
    const isPlayer=data.type==="player";el.innerHTML=`<div class="admin-shell-context-kicker">SELECTED ${isPlayer?"PLAYER":"ROOM"}</div><h3>${escape(data.name||data.roomId||"ไม่ระบุ")}</h3><div class="admin-shell-context-meta">${isPlayer?`ID: ${escape(data.accountId||"-")}<br>สถานะ: ${escape(data.status||"-")}<br>ห้อง: ${escape(data.roomId||"-")}`:`ห้อง: ${escape(data.roomId||"-")}<br>โฮสต์: ${escape(data.hostName||"-")}<br>ผู้เล่น: ${escape(data.players??"-")}`}</div><div class="admin-shell-context-actions">${isPlayer?`<button type="button" data-context-cmd="players.open">👤 เปิดข้อมูลผู้เล่น</button><button type="button" data-context-cmd="diagnostics.open">🩺 เปิด Diagnostics</button>`:`<button type="button" data-context-cmd="rooms.open">🏠 เปิดห้อง</button><button type="button" data-context-cmd="diagnostics.open">🩺 Diagnostics</button>`}</div>`;
    emit("CONTEXT_SELECTED",data);
  }
  function bind(){
    $("adminShellCommandBtn")?.addEventListener("click",openPalette);
    document.querySelectorAll("[data-shell-command]").forEach(b=>b.addEventListener("click",()=>run(b.dataset.shellCommand)));
    $("adminCommandSearch")?.addEventListener("input",e=>renderCommands(e.target.value));
    $("adminCommandList")?.addEventListener("click",e=>{const b=e.target.closest("[data-command-id]");if(b)run(b.dataset.commandId);});
    document.querySelectorAll("[data-shell-close]").forEach(b=>b.addEventListener("click",closePalette));
    $("adminShellContext")?.addEventListener("click",e=>{const b=e.target.closest("[data-context-cmd]");if(b)run(b.dataset.contextCmd);});
    const iframe=$("adminGameSurface");iframe?.addEventListener("load",()=>{state.indexReady=true;$("adminIndexStatus").textContent="หน้า Index จริงพร้อมใช้งาน";emit("INDEX_READY",{});});
    window.addEventListener("message",e=>{if(e.origin!==location.origin)return;const d=e.data||{};if(d.type!=="WW_ADMIN_CONTEXT")return;setContext(d.context||null);});
    document.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();openPalette();return;}if(e.key==="Escape"&&!$("adminCommandPalette")?.classList.contains("hidden"))closePalette();});
    window.addEventListener("ww-admin-event",e=>{if(e.detail?.type==="COMMAND_FINISHED"&&e.detail.ok){$("adminShellAuditStatus").textContent="พร้อม";}});
  }
  async function logout(){
    try{await fetch("/api/admin/logout",{method:"POST",cache:"no-store",credentials:"same-origin"});}catch(_){}
    window.WWAdminTabAuth?.clear();
    try{window.__wwAdminSocket?.disconnect();}catch(_){}
    location.reload();
  }
  function setStatus(partial={}){
    state.status={...state.status,...partial};
    const map={server:"adminShellServerStatus",rooms:"adminShellRoomStatus",players:"adminShellPlayerStatus",audit:"adminShellAuditStatus"};
    Object.keys(map).forEach((key)=>{ const el=$(map[key]); if(el&&state.status[key]!==undefined) el.textContent=String(state.status[key]); });
  }
  function updateAuditStatus(){
    try{
      const snap=window.WWRuntimeAudit?.snapshot?.();
      const count=Number(snap?.summary?.findingCount);
      if(Number.isFinite(count)) setStatus({audit:count===0?"0 findings":`${count} findings`});
    }catch(_){}
  }
  function init(){
    buildUI();
    window.WWAdminShell={openPalette,closePalette,run,setContext,setStatus,logout,state};
    try{ setStatus(window.__WW_ADMIN_SHELL_STATUS__ || state.status); }catch(_){ setStatus(state.status); }
    updateAuditStatus();
    window.setInterval(updateAuditStatus,1500);
  }

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();
