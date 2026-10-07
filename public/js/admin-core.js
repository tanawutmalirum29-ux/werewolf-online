(()=>{
  "use strict";
  const $=id=>document.getElementById(id), q=s=>document.querySelector(s), qa=s=>[...document.querySelectorAll(s)];
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let socket=null, currentRoom="", internal=[], internalId=0, presenceTimer=null, activeInternal=null, refreshTimer=null, bugData=null, bugsBusy=false, authGeneration=0;
  function notice(message='', error=false){ $('adminNotice').textContent=message; $('adminNotice').classList.toggle('error',error); $('adminNotice').hidden=!message; }
  async function j(url,opt={}){
    const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),12000);
    try { const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...opt,signal:controller.signal});
      const d=await r.json().catch(()=>({}));
      if(!r.ok){ if(r.status===401){window.WWAdminTabAuth?.clear();showLogin('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');socket?.disconnect();}
        throw Object.assign(new Error(d.message||d.error||`HTTP ${r.status}`),{data:d,status:r.status}); }
      return d;
    } finally {clearTimeout(timer);}
  }
  async function run(task,button){ if(button?.disabled)return; if(button)button.disabled=true;
    try {await task();}catch(e){notice(e.name==='AbortError'?'คำขอหมดเวลา ลองใหม่อีกครั้ง':e.message,true);}
    finally{if(button)button.disabled=false;}
  }
  function ask(event,payload){return new Promise((resolve,reject)=>{
    if(!socket?.connected)return reject(new Error('ยังไม่เชื่อมต่อ Admin socket'));
    const ack=(error,data)=>{if(error)return reject(new Error('คำขอหมดเวลา ลองใหม่อีกครั้ง'));if(data?.code==='ADMIN_AUTH_REQUIRED'){showLogin('เซสชันแอดมินหมดอายุ');socket.disconnect();}if(data?.error||data?.ok===false)return reject(new Error(data.error||data.code||'ดำเนินการไม่สำเร็จ'));resolve(data);};
    if(payload===undefined)socket.timeout(8000).emit(event,ack);else socket.timeout(8000).emit(event,payload,ack);
  });}
  function tab(name){ qa('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===name)); qa('.tab').forEach(s=>s.classList.toggle('active',s.id===`tab-${name}`)); }
  function showLogin(msg="", meta={}){ $('app').hidden=true; $('login').classList.remove('hidden'); $('loginMsg').textContent=msg; const password=$('password'); if(password){ password.disabled=meta.passwordEnabled===false; password.required=true; password.placeholder='รหัสผ่านแอดมิน'; if(!password.disabled) password.focus(); } $('loginBtn').disabled=meta.passwordEnabled===false; }
  function hideLogin(){ $('login').classList.add('hidden'); $('app').hidden=false; }
  async function session(generation){ const d=await j('/api/admin/session'); if(generation!==authGeneration)return false; if(d.authenticated){ hideLogin(); return true; } showLogin('', d); return false; }
  async function login(){ authGeneration++;try{ await window.WWAdminTabAuth?.ready; if($('password').disabled) return; const p=$('password').value; const tabId=window.WWAdminTabAuth?.getTabId?.()||""; const d=await j('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p,tabId})}); if(d.token) window.WWAdminTabAuth?.setSession?.(d); $('password').value=''; hideLogin(); connectSocket(); await refreshAll(); await restoreInternal(); }catch(e){$('loginMsg').textContent=e?.data?.error||e.message||'เข้าสู่ระบบไม่สำเร็จ';} }
  function connectSocket(){
    if(socket){if(!socket.connected)socket.connect();return;}
    socket=io({autoConnect:false,auth:cb=>cb(window.WWAdminTabAuth?.getSocketAuth?.()||{admin:true})});
    socket.on('connect',()=>{run(refreshRooms);run(refreshPresence);});
    socket.on('disconnect',()=>{ $('rooms').innerHTML='<div class="card muted">ขาดการเชื่อมต่อ กำลังเชื่อมใหม่...</div>'; });
    socket.on('connect_error',e=>{if(/admin_auth/i.test(e?.message||''))showLogin('เซสชันแอดมินหมดอายุ',{passwordEnabled:true});else notice('เชื่อมต่อ Admin socket ไม่สำเร็จ: '+e.message,true);});
    socket.connect();
  }
  async function refreshAll(){ await Promise.allSettled([refreshBugs(),refreshServer(),refreshRooms(),refreshVersions()]); startPresenceRefresh(); startAutoRefresh(); }
  function renderBugs(){
    if(!bugData)return;
    const search=$('bugSearch').value.trim().toLowerCase(), status=$('bugStatus').value;
    const reports=(bugData.reports||[]).filter(r=>(!status||r.status===status)&&(!search||[r.message,r.stack,r.roomId,r.page,r.source].join(' ').toLowerCase().includes(search)));
    const storage=bugData.storage==='degraded'?' · บันทึกถาวรมีปัญหา':bugData.storage==='memory'?' · เก็บในหน่วยความจำเท่านั้น':'';
    $('bugSummary').textContent=`แสดง ${reports.length}/${bugData.total||0} รายการ${storage} · อัปเดต ${new Date().toLocaleTimeString('th-TH')}`;
    $('bugs').innerHTML=reports.length?reports.map(r=>`<article class="card item"><div><h3>${esc(r.message||'ไม่มีข้อความ')}</h3><div class="meta">${esc(r.createdAt)} · ${esc(r.page)} · v${esc(r.version||'-')} · ${esc(r.source)}</div>${r.roomId?`<div class="meta">ห้อง ${esc(r.roomId)}</div>`:''}<div class="text">${esc(r.stack||'ไม่มี stack trace')}</div></div><div class="item-actions"><b class="status-${esc(r.status)}">${esc(r.status)}</b>${r.githubIssueUrl?`<a href="${esc(r.githubIssueUrl)}" target="_blank" rel="noopener">GitHub</a>`:`<button data-report-github="${esc(r.id)}" ${bugData.github?.configured?'':'disabled title="ยังไม่ได้ตั้งค่า GitHub"'}>ส่ง GitHub</button>`}<button data-report-status="${esc(r.id)}" data-status="reviewed">ตรวจแล้ว</button><button data-report-status="${esc(r.id)}" data-status="${r.status==='closed'?'new':'closed'}">${r.status==='closed'?'เปิดใหม่':'ปิดรายงาน'}</button><button data-report-delete="${esc(r.id)}" class="danger">ลบ</button></div></article>`).join(''):'<div class="card muted">ไม่มีรายงานตรงกับตัวกรอง</div>';
  }
  async function refreshBugs(){
    if(bugsBusy)return;bugsBusy=true;
    try{const data=await j('/api/admin/bug-reports?limit=200');const changed=JSON.stringify(data)!==JSON.stringify(bugData);bugData=data;if(changed)renderBugs();}
    catch(e){$('bugSummary').textContent='โหลดรายงานไม่สำเร็จ: '+e.message;throw e;}finally{bugsBusy=false;}
  }
  function startAutoRefresh(){if(refreshTimer)return;refreshTimer=setInterval(()=>{if(document.hidden||$('app').hidden)return;if($('tab-bugs').classList.contains('active'))run(refreshBugs);if($('tab-rooms').classList.contains('active'))run(refreshRooms);},5000);}
  async function refreshServer(){ try{const d=await j('/api/config'); const open=!!d.serverOpen; $('serverState').textContent=open?'🟢 เปิด':'🔴 ปิด'; $('serverMeta').textContent=`Version ${d.appVersion||d.version||'-'} · ${d.environmentStatus||'-'} · deployment ${d.deploymentState||'-'}`; $('serverNotice').textContent=d.noticeMessage||'ไม่มีประกาศ'; $('version').textContent=d.appVersion||d.version||'-'; $('serverBadge').textContent=open?'ONLINE':'CLOSED';}catch(e){$('serverMeta').textContent=e.message;} run(refreshPresence); }
  function renderPresence(presence){ const p=presence||{}; $('presenceStats').innerHTML=[['ห้องเปิดอยู่',p.openRooms||0],['ห้องที่กำลังเล่น',p.playingRooms||0],['ผู้เล่นอยู่ในห้อง',p.humansPlaying||0],['ผู้เล่นเชื่อมต่ออยู่',p.humansConnected||0]].map(([label,value])=>`<div class="presence-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join(''); const groups=new Map(); (p.players||[]).forEach(player=>{const id=String(player.roomId||'').toUpperCase();if(!id)return;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(player);}); const rooms=[...groups.entries()]; $('livePlayers').innerHTML=rooms.length?rooms.map(([roomId,players])=>`<section class="live-room"><div class="live-room-head"><span class="live-room-title">ห้อง ${esc(roomId)}</span><span class="meta">${players.some(x=>x.started)?'กำลังเล่น':'รอเริ่ม'} · ${players.length} คน</span></div><div class="live-room-players">${players.map(x=>`<span class="live-player ${x.connected?'online':'offline'}"><i class="dot"></i>${esc(x.name)}${x.connected?'':' · หลุดการเชื่อมต่อ'}</span>`).join('')}</div></section>`).join(''):'<div class="live-empty">ตอนนี้ยังไม่มีผู้เล่นจริงอยู่ในห้อง</div>'; const t=Number(p.updatedAt||0); $('presenceUpdated').textContent=t?`อัปเดต ${new Date(t).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}`:'—'; }
  async function refreshPresence(){if(socket?.connected){const data=await ask('admin_list_rooms');if(data?.ok)renderPresence(data.presence||{});}}
  function startPresenceRefresh(){ if(presenceTimer)return; run(refreshPresence); presenceTimer=setInterval(()=>{ const active=$('tab-server')?.classList.contains('active'); if(active)run(refreshPresence); },5000); }
  function stopPresenceRefresh(){ if(presenceTimer){clearInterval(presenceTimer);presenceTimer=null;} }
  async function serverControl(open){ const body={open}; if(!open){const message=prompt('ข้อความแจ้งผู้เล่น (เว้นว่างได้)');if(message===null)return;body.message=message||'เซิร์ฟเวอร์กำลังปิดปรับปรุง';} try{await j('/api/admin/server-open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); await refreshServer();}catch(e){alert(e.message)} }
  async function forceReload(kind){ if(!confirm(`บังคับผู้เล่นโหลด ${kind==='both'?'ไฟล์ + รูป':'ไฟล์เกม'} ใหม่ และจบห้องปกติหรือไม่?`))return; try{const d=await j('/api/admin/force-reload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind})}); alert(`ส่งคำสั่งแล้ว ${d.notified||0} เครื่อง · ปิดห้อง ${d.closedRooms||0} ห้อง`); await refreshServer();}catch(e){alert(e.message)} }
  async function refreshRooms(){
    if(!socket?.connected){$('rooms').innerHTML='<div class="card muted">กำลังเชื่อมต่อ Admin socket...</div>';return;}
    try{const res=await ask('admin_list_rooms'),rooms=res.rooms||[];
      $('rooms').innerHTML=rooms.length?rooms.map(r=>`<article class="card item"><div><h3>${esc(r.roomId)} ${r.isTester?'🧪':''}</h3><div class="meta">Host: ${esc(r.hostName)} · ผู้เล่น ${r.players} · บอท ${r.bots} · ${r.started?'กำลังเล่น':'รอเริ่ม'}</div></div><div class="item-actions"><button data-room-open="${esc(r.roomId)}">ดู</button><button data-room-close="${esc(r.roomId)}" class="danger">ปิดห้อง</button></div></article>`).join(''):'<div class="card muted">ไม่มีห้อง</div>';
      if(currentRoom){if(rooms.some(r=>r.roomId===currentRoom))await refreshRoomDetail(currentRoom);else{currentRoom='';$('roomDetail').hidden=true;}}
    }catch(e){$('rooms').innerHTML=`<div class="card">โหลดห้องไม่สำเร็จ: ${esc(e.message)}</div>`;throw e;}
  }
  async function refreshRoomDetail(id){currentRoom=id;const box=$('roomDetail');box.hidden=false;
    try{const res=await ask('admin_get_room_detail',{roomId:id}),r=res.room||{};if(currentRoom!==id)return;
      box.innerHTML=`<h3>ห้อง ${esc(r.roomId||id)}</h3><div class="meta">Phase: ${esc(r.phase||'-')} · Day: ${esc(r.dayCount||0)} · Night: ${r.isNight?'ใช่':'ไม่ใช่'}</div><div class="text">${esc(JSON.stringify(r.players||[],null,2))}</div>`;
    }catch(e){box.innerHTML=`<b>โหลดไม่สำเร็จ</b><p class="muted">${esc(e.message)}</p>`;throw e;}
  }
  async function refreshVersions(){ try{const d=await j('/api/admin/versions'); $('versions').innerHTML=(d.versions||[]).map(v=>`<article class="card item"><div><h3>${esc(v.versionLabel)} ${v.current?'🟢':''}</h3><div class="meta">${esc(v.status)} · ${esc(v.dateCreated||'-')} · ${esc(v.description||'')}</div></div><div class="item-actions">${v.downloadable?`<button data-version-download="${esc(v.versionLabel)}">ดาวน์โหลด</button>`:''}${v.rollbackAllowed?`<button data-version-rollback="${esc(v.versionLabel)}" class="danger">Rollback</button>`:''}</div></article>`).join('');}catch(e){$('versions').innerHTML=`<div class="card">${esc(e.message)}</div>`;} }
  async function downloadVersion(v){try{const d=await j('/api/admin/versions/download-ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionLabel:v})}); location.href=d.url;}catch(e){alert(e.message)} }
  async function rollbackVersion(v){if(!confirm(`Rollback ไป ${v} ?`))return;try{await j('/api/admin/versions/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionLabel:v})});alert('สั่ง rollback แล้ว');await refreshVersions();}catch(e){alert(e.message)} }
  async function testerPass(){return j('/api/admin/tester-pass',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});}
  const INTERNAL_KEY='ww_admin_screens_v2';
  function saveInternal(){try{sessionStorage.setItem(INTERNAL_KEY,JSON.stringify({screens:internal,active:activeInternal}));}catch(_){}}
  function renderInternal(){
    $('internalTabs').innerHTML=internal.map(x=>`<div class="internal-screen-tab"><button class="internal-tab ${activeInternal===x.id?'active':''}" data-internal="${esc(x.id)}">${esc(x.title)}</button><button data-internal-close="${esc(x.id)}" aria-label="ปิด ${esc(x.title)}">×</button></div>`).join('')||'<span class="muted">ยังไม่มีจอ</span>';
  }
  function mountInternal(screen){
    const frame=document.createElement('iframe');frame.dataset.screen=screen.id;frame.title=screen.title;frame.dataset.testerPass=new URL(screen.src,location.origin).searchParams.get('tp')||'';frame.src=screen.src;frame.hidden=true;
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-modals allow-popups');
    frame.addEventListener('load',()=>{try{const url=new URL(frame.contentWindow.location.href);const match=url.pathname.match(/^\/(index|host|player)\.html$/);if(url.origin===location.origin&&match){screen.src=`/__ww_admin_embed__/${screen.id}/${match[1]}.html${url.search}`;saveInternal();}}catch(_){}});
    $('internalFrames').appendChild(frame);
  }
  function selectInternal(id){if(!internal.some(x=>x.id===id))return;activeInternal=id;
    qa('#internalFrames iframe').forEach(frame=>{frame.hidden=frame.dataset.screen!==id;});renderInternal();saveInternal();
  }
  function closeInternal(id){const index=internal.findIndex(x=>x.id===id);if(index<0)return;
    q(`#internalFrames iframe[data-screen="${id}"]`)?.remove();internal.splice(index,1);try{Object.keys(sessionStorage).filter(key=>key.startsWith('ww_admin_screen:'+id+':')).forEach(key=>sessionStorage.removeItem(key));}catch(_){}
    if(activeInternal===id)activeInternal=internal[Math.min(index,internal.length-1)]?.id||null;
    if(activeInternal)selectInternal(activeInternal);else{renderInternal();saveInternal();}
  }
  async function newInternal(kind='home'){
    if(internal.length>=12)throw new Error('เปิดได้สูงสุด 12 จอ กรุณาปิดจอที่ไม่ใช้ก่อน');
    const pass=await testerPass();if(!pass.token)throw new Error('ไม่ได้รับ Tester Pass');
    const id=crypto.randomUUID?.().replaceAll('-','')||Date.now().toString(36)+'_'+(++internalId);
    const page=kind==='host'?'host':kind==='player'?'player':'index';
    const params=new URLSearchParams({tester:'1',tp:pass.token,ww_admin_embed:'1',ww_test_screen:id});
    const title=(kind==='host'?'Host':kind==='player'?'Player':'Game')+' '+(Math.max(0,...internal.filter(x=>x.kind===kind).map(x=>Number(x.title.split(' ').at(-1))||0))+1);
    const screen={id,kind,title,src:`/__ww_admin_embed__/${id}/${page}.html?${params}`};
    internal.push(screen);mountInternal(screen);selectInternal(id);notice('เปิด '+title+' แล้ว');
  }
  async function restoreInternal(){if(internal.length)return;
    try{const stored=JSON.parse(sessionStorage.getItem(INTERNAL_KEY)||'null');
      internal=(stored?.screens||[]).filter(x=>/^[a-zA-Z0-9_-]{1,80}$/.test(x.id||'')&&String(x.src||'').startsWith('/__ww_admin_embed__/')).slice(0,12);
      internal.forEach(mountInternal);if(internal.length)selectInternal(internal.some(x=>x.id===stored.active)?stored.active:internal[0].id);
    }catch(_){internal=[];}
  }
  $('loginBtn').onclick=()=>run(login,$('loginBtn')); $('password').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();run(login,$('loginBtn'));}}; $('logoutBtn').onclick=()=>run(async()=>{await j('/api/admin/logout',{method:'POST'});window.WWAdminTabAuth?.clear();sessionStorage.removeItem(INTERNAL_KEY);location.reload();},$('logoutBtn'));
  qa('.tabs button').forEach(b=>b.onclick=()=>{tab(b.dataset.tab); if(b.dataset.tab==='server') {startPresenceRefresh();run(refreshServer);} else stopPresenceRefresh();if(b.dataset.tab==='bugs')run(refreshBugs);if(b.dataset.tab==='rooms')run(refreshRooms);if(b.dataset.tab==='versions')run(refreshVersions);});
  $('bugSearch').addEventListener('input',renderBugs);$('bugStatus').addEventListener('change',renderBugs);
  document.body.addEventListener('click',e=>{
    const t=e.target.closest('button');if(!t||t.disabled)return;let task=null;
    const refresh={bugs:refreshBugs,server:refreshServer,rooms:refreshRooms,versions:refreshVersions};
    if(t.dataset.action?.startsWith('refresh-'))task=refresh[t.dataset.action.slice(8)];
    if(t.dataset.server)task=()=>serverControl(t.dataset.server==='open');
    if(t.dataset.reload)task=()=>forceReload(t.dataset.reload);
    if(t.dataset.roomOpen)task=()=>refreshRoomDetail(t.dataset.roomOpen);
    if(t.dataset.roomClose)task=async()=>{if(!confirm('ปิดห้อง '+t.dataset.roomClose+' ?'))return;await ask('admin_close_room',{roomId:t.dataset.roomClose});await refreshRooms();};
    if(t.dataset.versionDownload)task=()=>downloadVersion(t.dataset.versionDownload);
    if(t.dataset.versionRollback)task=()=>rollbackVersion(t.dataset.versionRollback);
    if(t.dataset.internalKind)task=()=>newInternal(t.dataset.internalKind);
    if(t.dataset.reportGithub)task=async()=>{await j('/api/admin/bug-reports/'+encodeURIComponent(t.dataset.reportGithub)+'/github',{method:'POST'});await refreshBugs();};
    if(t.dataset.reportStatus)task=async()=>{await j('/api/admin/bug-reports/'+encodeURIComponent(t.dataset.reportStatus)+'/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:t.dataset.status})});await refreshBugs();};
    if(t.dataset.reportDelete)task=async()=>{if(!confirm('ลบรายงานนี้?'))return;await j('/api/admin/bug-reports/'+encodeURIComponent(t.dataset.reportDelete),{method:'DELETE'});await refreshBugs();};
    if(t.dataset.internal)selectInternal(t.dataset.internal);
    if(t.dataset.internalClose)closeInternal(t.dataset.internalClose);
    if(task)run(task,t);
  });
  new ResizeObserver(entries=>document.documentElement.style.setProperty('--admin-header-height',entries[0].target.offsetHeight+'px')).observe(q('header'));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('app').hidden){run(refreshBugs);run(refreshRooms);}});
  run(async()=>{await window.WWAdminTabAuth?.ready;if(await session(0)){connectSocket();await refreshAll();await restoreInternal();}});
})();
