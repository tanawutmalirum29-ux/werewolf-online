/*
 * Admin Control Center — Phase 2 functional UX layer.
 * This module composes existing Admin data/functions into clearer workflows.
 * It does not own authentication, sockets, or business rules.
 */
(function(){
  "use strict";

  const state = {
    playerFilter: "all",
    roomFilter: "all",
    roomSearch: "",
    liveSearch: "",
    liveFilter: "all",
    rooms: [],
    observerInstalled: false,
    sectionJumpsBound: false,
    liveControlsBuilt: false,
    playerControlsBuilt: false,
    roomControlsBuilt: false,
    globalSearchReady: false,
  };

  const $ = (s, root=document) => root.querySelector(s);
  const $$ = (s, root=document) => Array.from(root.querySelectorAll(s));
  const text = (v) => String(v ?? "");

  function esc(v){
    return text(v).replace(/[&<>\"]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
  }

  function activeTab(){ return text(document.body?.dataset?.adminTab || window.__wwAdminCurrentTab || "overview"); }

  function navigate(tab){
    if(typeof window.switchTab === "function") window.switchTab(tab);
    else window.dispatchEvent(new CustomEvent("ww-admin-navigate", {detail:{tab}}));
  }

  function addClass(el, c, yes=true){ if(el) el.classList.toggle(c, !!yes); }

  function createPlayerFilters(){
    const bar=$("#playerFilterBar"); if(!bar || state.playerControlsBuilt) return;
    bar.innerHTML = "";
    const filters=[
      ["all","ทั้งหมด"], ["online","ออนไลน์"], ["google","Google"], ["temporary","ชั่วคราว"], ["suspended","พักบัญชี"], ["legacy","Legacy"]
    ];
    filters.forEach(([id,label])=>{
      const b=document.createElement("button"); b.type="button"; b.dataset.filter=id; b.innerHTML=`${label} <span class="count" data-count-for="${id}">0</span>`;
      b.addEventListener("click",()=>{ state.playerFilter=id; updatePlayerFilterButtons(); applyPlayerFilter(); });
      bar.appendChild(b);
    });
    const summary=document.createElement("div"); summary.className="phase2-player-summary"; summary.id="phase2PlayerSummary";
    $("#playerSearch")?.closest(".search-box")?.insertAdjacentElement("beforebegin",summary);
    state.playerControlsBuilt=true;
    updatePlayerFilterButtons();
  }
  function updatePlayerFilterButtons(){
    $$("#playerFilterBar [data-filter]").forEach(b=>b.classList.toggle("active",b.dataset.filter===state.playerFilter));
  }
  function classifyPlayerCard(card){
    const s=text(card?.textContent).toLowerCase();
    return {
      online:/🟢\s*ออนไลน์/.test(s) || /\bonline\b/.test(s),
      google:/google/.test(s),
      temporary:/ชั่วคราว|temporary/.test(s),
      suspended:/พักบัญชี|suspended/.test(s),
      legacy:/legacy|ข้อมูลเก่า/.test(s),
    };
  }
  function applyPlayerFilter(){
    const content=$("#allPlayersContent"); if(!content) return;
    const cards=$$(".all-player-card",content);
    let shown=0;
    cards.forEach(card=>{
      const c=classifyPlayerCard(card);
      const yes=state.playerFilter === "all" || !!c[state.playerFilter];
      addClass(card,"phase2-card-hidden",!yes); if(yes) shown++;
    });
    $$(".player-account-group",content).forEach(group=>{
      const visible=$$(".all-player-card:not(.phase2-card-hidden)",group).length;
      addClass(group,"phase2-card-hidden",visible===0);
    });
    const summary=$("#phase2PlayerSummary");
    if(summary){
      const total=cards.length;
      const online=cards.filter(c=>classifyPlayerCard(c).online).length;
      const google=cards.filter(c=>classifyPlayerCard(c).google).length;
      const temp=cards.filter(c=>classifyPlayerCard(c).temporary).length;
      const suspended=cards.filter(c=>classifyPlayerCard(c).suspended).length;
      summary.innerHTML=`<span class="phase2-summary-chip">แสดง <b>${shown}</b> / ${total}</span><span class="phase2-summary-chip">ออนไลน์ <b>${online}</b></span><span class="phase2-summary-chip">Google <b>${google}</b></span><span class="phase2-summary-chip">ชั่วคราว <b>${temp}</b></span><span class="phase2-summary-chip">พักบัญชี <b>${suspended}</b></span>`;
    }
    $$("#playerFilterBar [data-filter]").forEach(b=>{
      const f=b.dataset.filter;
      const count = f === "all" ? cards.length : cards.filter(c=>classifyPlayerCard(c)[f]).length;
      const c=b.querySelector("[data-count-for]"); if(c) c.textContent=String(count);
    });
    let empty=$("#phase2PlayerFilterEmpty");
    if(!shown && cards.length){
      if(!empty){ empty=document.createElement("div"); empty.id="phase2PlayerFilterEmpty"; empty.className="empty"; content.appendChild(empty); }
      empty.textContent="ไม่มีผู้เล่นตรงกับตัวกรองนี้"; empty.style.display="block";
    }else if(empty){ empty.style.display="none"; }
  }

  function createLiveControls(){
    const panel=$("#tab-live"); if(!panel || state.liveControlsBuilt) return;
    const toolbar=$("#tab-live .toolbar"); if(!toolbar) return;
    const box=document.createElement("div"); box.className="phase2-live-toolbar";
    box.innerHTML=`<input id="phase2LiveSearch" type="search" autocomplete="off" placeholder="ค้นหาชื่อผู้เล่น Room ID หรือหน้าเว็บ..."><button type="button" data-live-filter="all" class="active">ทั้งหมด</button><button type="button" data-live-filter="room">ในห้อง</button><button type="button" data-live-filter="page">หน้าเว็บ</button><span class="phase2-live-count" id="phase2LiveCount">0 session</span>`;
    toolbar.insertAdjacentElement("beforebegin",box);
    const input=$("#phase2LiveSearch"); input.addEventListener("input",()=>{state.liveSearch=input.value.trim().toLowerCase(); applyLiveFilter();});
    box.addEventListener("click",e=>{ const b=e.target.closest("[data-live-filter]"); if(!b)return; state.liveFilter=b.dataset.liveFilter; $$("[data-live-filter]",box).forEach(x=>x.classList.toggle("active",x===b)); applyLiveFilter(); });
    state.liveControlsBuilt=true;
  }
  function applyLiveFilter(){
    const content=$("#content"); if(!content)return;
    const cards=$$(".account-card",content);
    let shown=0;
    cards.forEach(card=>{
      const s=text(card.textContent).toLowerCase();
      const room=/ห้อง\s+[a-z0-9]/i.test(s);
      const page=/หน้าเว็บ|หน้า\s/.test(s) && !room;
      const typeOk=state.liveFilter==="all" || (state.liveFilter==="room"?room:page);
      const qOk=!state.liveSearch || s.includes(state.liveSearch);
      const yes=typeOk && qOk; addClass(card,"phase2-card-hidden",!yes); if(yes)shown++;
    });
    $$(".room-group",content).forEach(group=>{
      const visible=$$(".account-card:not(.phase2-card-hidden)",group).length;
      addClass(group,"phase2-card-hidden",visible===0);
    });
    const counter=$("#phase2LiveCount"); if(counter) counter.textContent=`${shown} session`;
    const indicator=$("#phase2LiveIndicator"); if(indicator) indicator.textContent=`● ${shown} session`;
  }

  function createRoomControls(){
    const bar=$("#roomFilterBar"); if(!bar || state.roomControlsBuilt) return;
    const filters=[["all","ทั้งหมด"],["playing","กำลังเล่น"],["waiting","รอเริ่ม"],["tester","Tester"]];
    filters.forEach(([id,label])=>{
      const b=document.createElement("button"); b.type="button"; b.dataset.roomFilter=id; b.innerHTML=`${label} <span class="count" data-room-count-for="${id}">0</span>`; b.addEventListener("click",()=>{state.roomFilter=id;$$("[data-room-filter]",bar).forEach(x=>x.classList.toggle("active",x===b));applyRoomFilter();}); bar.appendChild(b);
    });
    $("#phase2RoomSearch")?.addEventListener("input",e=>{state.roomSearch=e.target.value.trim().toLowerCase();applyRoomFilter();});
    const first=bar.firstElementChild; first?.classList.add("active"); state.roomControlsBuilt=true;
  }
  function classifyRoomCard(card){
    const s=text(card?.textContent).toLowerCase();
    return {tester:/ทดลอง|tester/.test(s),playing:/กำลังเล่น|playing/.test(s),waiting:/รอเริ่ม|waiting/.test(s)};
  }
  function applyRoomFilter(){
    const content=$("#roomsContent"); if(!content)return;
    const cards=$$(".room-card",content); let shown=0;
    cards.forEach(card=>{
      const c=classifyRoomCard(card); const s=text(card.textContent).toLowerCase();
      const filterOk=state.roomFilter==="all" || !!c[state.roomFilter];
      const qOk=!state.roomSearch || s.includes(state.roomSearch);
      const yes=filterOk && qOk; addClass(card,"phase2-card-hidden",!yes); if(yes)shown++;
    });
    let empty=$("#phase2RoomFilterEmpty");
    if(!shown && cards.length){ if(!empty){empty=document.createElement("div");empty.id="phase2RoomFilterEmpty";empty.className="empty";content.appendChild(empty);} empty.textContent="ไม่พบห้องตามตัวกรองนี้";empty.style.display="block"; }
    else if(empty) empty.style.display="none";
    $$("[data-room-filter]",$("#roomFilterBar")||document).forEach(b=>{
      const f=b.dataset.roomFilter; const count=f==="all"?cards.length:cards.filter(c=>classifyRoomCard(c)[f]).length;
      b.dataset.count=count;
      const badge=b.querySelector("[data-room-count-for]"); if(badge) badge.textContent=String(count);
    });
  }

  function markPhase2Cards(){
    /* Re-apply filters after legacy renderers replace their containers. */
    applyPlayerFilter(); applyLiveFilter(); applyRoomFilter();
  }

  function installSectionJumps(){
    if(state.sectionJumpsBound) return;
    document.addEventListener("click",e=>{
      const b=e.target.closest("[data-phase2-jump]"); if(!b)return;
      const el=$(b.dataset.phase2Jump); if(!el)return;
      el.scrollIntoView({behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches?"auto":"smooth",block:"start"});
    });
    state.sectionJumpsBound=true;
  }

  function installContextEnhancement(){
    // Context details are now handled by the dedicated account/room overlays.
    // Keep this hook as a no-op compatibility point for older callers.
  }

  function globalSearchItems(query){
    const q=text(query).trim().toLowerCase(); if(!q)return [];
    const result=[];
    try{
      const players=(Array.isArray(window.__WW_ADMIN_PHASE2_PLAYERS) && window.__WW_ADMIN_PHASE2_PLAYERS.length) ? window.__WW_ADMIN_PHASE2_PLAYERS : ((typeof allPlayers !== "undefined" && Array.isArray(allPlayers)) ? allPlayers : []);
      players.slice(0,1200).forEach(p=>{
        const hay=[p?.name,p?.accountId,p?.provider,p?.accountType,...(p?.aliases||[])].join(" ").toLowerCase();
        if(hay.includes(q)) result.push({id:`phase2.player.${encodeURIComponent(p?.accountId||p?.name||"")}`,title:p?.name||"ผู้เล่น",icon:"👤",category:"ผลการค้นหา · ผู้เล่น",keywords:[p?.accountId||""],phase2:true,run:()=>{typeof window.openAccountDetail==='function' && window.openAccountDetail(p?.accountId||"",p?.name||"",p);}});
      });
    }catch(_){}
    state.rooms.slice(0,400).forEach(r=>{
      const hay=[r?.roomId,r?.hostName,r?.isTester?"tester":"",r?.started?"playing":"waiting"].join(" ").toLowerCase();
      if(hay.includes(q)) result.push({id:`phase2.room.${encodeURIComponent(r?.roomId||"")}`,title:r?.roomId||"ห้อง",icon:"🏠",category:"ผลการค้นหา · ห้อง",keywords:[r?.hostName||""],phase2:true,run:()=>{window.openRoomInspector?.(r?.roomId||"",r); }});
    });
    return result.slice(0,12);
  }

  function installGlobalSearchBridge(){
    if(state.globalSearchReady || !window.WWAdminCommandRegistry) return;
    const registry=window.WWAdminCommandRegistry;
    if(typeof registry.search !== "function")return;
    const original=registry.search.bind(registry);
    registry.search=(q)=>{
      const base=original(q);
      const extra=globalSearchItems(q);
      return [...extra,...base].slice(0,30);
    };
    const originalFind=registry.find.bind(registry);
    registry.find=(id)=>{
      const key=text(id);
      if(key.startsWith("phase2.player.")){
        const lookup=decodeURIComponent(key.slice("phase2.player.".length));
        const players=(Array.isArray(window.__WW_ADMIN_PHASE2_PLAYERS) && window.__WW_ADMIN_PHASE2_PLAYERS.length) ? window.__WW_ADMIN_PHASE2_PLAYERS : ((typeof allPlayers !== "undefined" && Array.isArray(allPlayers)) ? allPlayers : []);
        const p=(players||[]).find(x=>text(x?.accountId||x?.name)===lookup);
        if(p) return {id:key,title:p.name||"ผู้เล่น",icon:"👤",category:"ผลการค้นหา · ผู้เล่น",phase2:true,run:()=>window.openAccountDetail?.(p.accountId||"",p.name||"",p)};
      }
      if(key.startsWith("phase2.room.")){
        const roomId=decodeURIComponent(key.slice("phase2.room.".length));
        const r=state.rooms.find(x=>text(x?.roomId)===roomId);
        if(r) return {id:key,title:r.roomId||"ห้อง",icon:"🏠",category:"ผลการค้นหา · ห้อง",phase2:true,run:()=>{window.openRoomInspector?.(r.roomId,r); }};
      }
      return originalFind(id);
    };
    const originalRun=registry.run.bind(registry);
    registry.run=(id)=>{
      if(text(id).startsWith("phase2.player.")){
        const key=decodeURIComponent(text(id).slice("phase2.player.".length));
        const players=(Array.isArray(window.__WW_ADMIN_PHASE2_PLAYERS) && window.__WW_ADMIN_PHASE2_PLAYERS.length) ? window.__WW_ADMIN_PHASE2_PLAYERS : ((typeof allPlayers !== "undefined" && Array.isArray(allPlayers)) ? allPlayers : []);
        const p=(players||[]).find(x=>text(x?.accountId||x?.name)===key);
        if(p){ window.openAccountDetail?.(p.accountId||"",p.name||"",p); return Promise.resolve(); }
      }
      if(text(id).startsWith("phase2.room.")){
        const roomId=decodeURIComponent(text(id).slice("phase2.room.".length));
        const r=state.rooms.find(x=>text(x?.roomId)===roomId);
        if(r){ window.openRoomInspector?.(r.roomId,r); return Promise.resolve(); }
      }
      return originalRun(id);
    };
    state.globalSearchReady=true;
  }

  function observeDataRefresh(){
    if(state.observerInstalled)return;
    [$("#allPlayersContent"),$("#content"),$("#roomsContent")].filter(Boolean).forEach(el=>{
      const ob=new MutationObserver(()=>window.requestAnimationFrame(markPhase2Cards));
      ob.observe(el,{childList:true,subtree:true});
    });
    window.addEventListener("ww-admin-event",()=>window.requestAnimationFrame(markPhase2Cards));
    state.observerInstalled=true;
  }

  function detectRoomsFromRenderer(){
    const original = window.renderRooms;
    /* Legacy renderer is a local declaration, so capture its output instead via a light DOM scrape. */
    const content=$("#roomsContent");
    if(content && !content.__phase2RoomScrape){
      Object.defineProperty(content,"__phase2RoomScrape",{value:true,writable:false});
      const ob=new MutationObserver(()=>{
        const cards=$$(".room-card",content);
        state.rooms=cards.map(card=>({
          roomId:text($(".room-code",card)?.textContent).trim(),
          hostName:(text($(".room-meta",card)?.textContent).match(/โฮสต์:\s*([^·]+)/)||[])[1]?.trim()||"",
          players:Number((text($(".room-meta",card)?.textContent).match(/ผู้เล่น\s*(\d+)/)||[])[1]||0),
          isTester:/ทดลอง|tester/i.test(text(card.textContent)),
          started:/กำลังเล่น|playing/i.test(text(card.textContent)),
        }));
        applyRoomFilter();
      });
      ob.observe(content,{childList:true,subtree:true});
    }
    void original;
  }

  function syncPlayerSearchSummary(){
    try{
      const players=typeof allPlayers !== "undefined" ? allPlayers : [];
      window.__WW_ADMIN_PHASE2_PLAYERS=Array.isArray(players)?players.slice():[];
    }catch(_){}
  }

  function updateBodyTab(){
    try{document.body.dataset.adminTab=typeof currentTab!=="undefined"?currentTab:"overview";}catch(_){}
  }

  function expose(){
    window.WWAdminPhase2={
      state,
      refreshFilters:markPhase2Cards,
      globalSearchItems,
      go:navigate,
    };
  }

  function init(){
    if(!document.body) return;
    expose();
    createPlayerFilters();
    createLiveControls();
    createRoomControls();
    installSectionJumps();
    installContextEnhancement();
    installGlobalSearchBridge();
    observeDataRefresh();
    detectRoomsFromRenderer();
    syncPlayerSearchSummary();
    markPhase2Cards();
    updateBodyTab();
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded",init,{once:true}); else init();
})();
