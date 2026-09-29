from pathlib import Path
import re

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f"SKIP: Python Playwright unavailable: {exc}")
    raise SystemExit(77)

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
SHELL = (ROOT / 'public/js/admin-shell.js').read_text()
REG = (ROOT / 'public/js/admin-command-registry.js').read_text()
P2 = (ROOT / 'public/js/admin-phase2.js').read_text()
SHELL_CSS = (ROOT / 'public/css/admin-shell.css').read_text()
P2_CSS = (ROOT / 'public/css/admin-phase2.css').read_text()

HTML = '''<!doctype html><html lang="th"><head><meta charset="utf-8"><style>{SHELL_CSS}\n{P2_CSS}</style></head><body data-page="admin">
<div class="admin-app-shell" id="adminApp">
<header class="admin-topbar"><div class="admin-brand"><button class="admin-brand-mark" id="brand">🐺</button></div><div class="admin-topbar-actions"><button class="admin-command-trigger" id="adminShellCommandBtn">⌕ คำสั่ง <kbd>⌘K</kbd></button><div class="admin-live-status"><div class="admin-status-item"><b id="adminShellServerStatus">ONLINE</b></div><div class="admin-status-item"><b id="adminShellRoomStatus">2 ห้อง</b></div><div class="admin-status-item"><b id="adminShellPlayerStatus">3 online</b></div><div class="admin-status-item"><b id="adminShellAuditStatus">0 findings</b></div></div><div class="admin-account-wrap"><button id="adminAccountTrigger" aria-expanded="false">Admin</button><div id="adminAccountMenu" class="admin-account-menu hidden"><button data-account-menu-command="session.logout">logout</button></div></div></div></header>
<div class="admin-layout-grid">
<aside class="admin-sidebar"><nav class="admin-sidebar-nav">
<button data-admin-nav="overview">overview</button><button data-admin-nav="all">players</button><button data-admin-nav="live">live</button><button data-admin-nav="rooms">rooms</button><button data-admin-nav="tools">tools</button><button data-admin-nav="diagnostics">diagnostics</button>
</nav></aside>
<main class="admin-workspace" id="adminWorkspace"><header class="admin-page-header" id="adminPageHeader"><div class="admin-page-heading"><div id="adminPanelKicker">OVERVIEW</div><h1 id="adminPanelTitle">Overview</h1><p id="adminPanelSub">summary</p></div><div class="admin-page-actions"><button data-shell-refresh-current type="button">refresh</button><div id="adminOperationsHeaderTools" class="admin-operations-header-tools" hidden><nav class="phase2-section-jump ops-header-section-jump"><button data-phase2-jump="#phase2ServerCard">Server</button><button data-phase2-jump="#phase2UpdateCard">Updates</button><button data-phase2-jump="#phase2TesterCard">Tester</button><button data-phase2-jump="#phase2DangerCard">Danger</button></nav></div></div></header><div class="admin-page-stack" id="adminPageStack">
<section class="tab-panel active" id="tab-overview"><section class="overview-dashboard"><div class="overview-metrics"><article class="overview-metric overview-metric-server"><div id="overviewServerState">เปิดอยู่</div><div id="overviewServerMeta">Running version · v3-42</div></article><article class="overview-metric"><div id="sumOnline" class="overview-metric-value">3</div></article><article class="overview-metric"><div id="sumRooms" class="overview-metric-value">2</div></article><article class="overview-metric"><div id="sumAccounts" class="overview-metric-value">3</div></article></div><div class="overview-main-grid"><section class="overview-panel"><div id="overviewRooms" class="overview-room-list"></div></section><section class="overview-panel"><div id="overviewActivity" class="overview-activity-list"></div></section></div></section></section>
<section class="tab-panel" id="tab-all"><div id="playerDirectoryView" class="admin-list-view"><div class="player-directory-toolbar"><div class="player-directory-toolbar-head"><div class="player-directory-title"><span class="phase2-eyebrow">PLAYER ACCOUNTS</span><div class="player-directory-count" id="directoryCount">3 ผู้เล่น</div></div><button class="btn btn-ghost player-directory-refresh" type="button">รีเฟรช</button></div><div id="playerFilterBar" class="phase2-filterbar player-directory-filters"></div><div class="search-box player-directory-search"><input id="playerSearch" value=""/></div></div><div id="allPlayersContent"><div class="manage-card all-player-card" data-player-index="0"><div class="manage-name">Alice</div><div class="manage-meta">ID: A1</div><div class="manage-tags"><span>🔵 Google</span><span>🟢 ออนไลน์</span></div></div><div class="manage-card all-player-card" data-player-index="1"><div class="manage-name">Bob</div><div class="manage-meta">ID: B1</div><div class="manage-tags"><span>🟡 ชั่วคราว</span><span>⚪ ออฟไลน์</span></div></div><div class="manage-card all-player-card" data-player-index="2"><div class="manage-name">Carol</div><div class="manage-meta">Legacy</div><div class="manage-tags"><span>📦 ข้อมูลเก่า</span></div></div></div></div><section class="admin-detail-workspace hidden" id="playerDetailWorkspace" aria-hidden="true"><div class="admin-detail-breadcrumb"><button type="button" data-player-detail-back>ผู้เล่น</button><span>›</span><strong id="playerDetailBreadcrumbName">รายละเอียดผู้เล่น</strong></div><div class="admin-detail-header"><div><span class="admin-detail-kicker">PLAYER DETAIL</span><h2><span id="playerDetailHeaderName">รายละเอียดผู้เล่น</span></h2><p id="playerDetailHeaderSub"></p></div><div class="admin-detail-header-actions"><button type="button" data-player-detail-back>กลับ</button><button type="button" data-player-detail-refresh>รีเฟรช</button></div></div><div id="accountDetailBody" class="admin-detail-body"></div></section></section>
<section class="tab-panel" id="tab-live"><div class="phase2-page-intro"><div><span class="phase2-eyebrow">LIVE OPERATIONS</span><h2>ออนไลน์</h2></div></div><div class="toolbar"><span id="connStatus">ok</span></div><div id="content"><div class="room-group"><div class="room-label">ห้อง ABC123</div><div class="account-card"><div>🐺 Alice</div><div>ห้อง ABC123</div></div></div><div class="room-group"><div class="room-label">หน้าเว็บ</div><div class="account-card"><div>👤 Bob</div><div>หน้า index</div></div></div></div></section>
<section class="tab-panel" id="tab-rooms"><div class="phase2-page-intro"><div><span class="phase2-eyebrow">ROOM OPERATIONS</span><h2>ห้องเกม</h2></div></div><div id="roomFilterBar" class="phase2-filterbar"></div><div class="phase2-inline-search"><input id="phase2RoomSearch" value=""/></div><div class="toolbar"></div><div id="roomsContent"><div class="room-grid"><div class="room-card"><button class="room-code admin-shell-room-select" data-room-id="ABC123" data-room-name="Alice" data-room-players="5">ABC123</button><div class="room-meta">โฮสต์: Alice · ผู้เล่น 5</div><div class="manage-tags"><span>🎮 กำลังเล่น</span></div></div><div class="room-card"><button class="room-code admin-shell-room-select" data-room-id="TEST01" data-room-name="Tester" data-room-players="2">TEST01</button><div class="room-meta">โฮสต์: Tester · ผู้เล่น 2</div><div class="manage-tags"><span>🧪 ทดลอง</span><span>⏳ รอเริ่ม</span></div></div></div></div></section>
<section class="tab-panel" id="tab-tools"><div class="tool-card" id="phase2ServerCard"></div><div class="tool-card" id="phase2UpdateCard"></div><div class="tool-card" id="phase2TesterCard"></div><div class="tool-card danger" id="phase2DangerCard"></div></section>
<section class="tab-panel" id="tab-diagnostics"><div class="phase2-page-intro"><div><span class="phase2-eyebrow">DIAGNOSTICS</span><h2>Diagnostics</h2></div></div><nav class="phase2-section-jump"><button data-phase2-jump="#bugReplayCard">Bug Replay</button><button data-phase2-jump="#diagPermissions">Permissions</button><button data-phase2-jump="#diagEvents">Events</button></nav><div id="bugReplayCard" class="tool-card"></div><div id="diagPermissions" class="tool-card"></div><div id="diagEvents" class="tool-card"></div></section>
</div></main></div></div>
<script>
window.wwToast=()=>{}; window.wwConfirm=async()=>true; window.WWAdminTabAuth={clear(){},getTabId(){return 't'}}; window.__WW_ADMIN_SHELL_STATUS__={server:'ONLINE',rooms:'2 ห้อง',players:'3 online',audit:'0 findings'}; window.__wwAdminSocket={disconnect(){}};
window.switchTab=(tab)=>{document.querySelectorAll('.tab-panel').forEach(x=>x.classList.toggle('active',x.id==='tab-'+tab)); const t=document.getElementById('adminOperationsHeaderTools'); if(t)t.hidden=tab!=='tools';};
window.refreshDashboard=()=>{}; window.loadAllPlayers=()=>{}; window.loadAccounts=()=>{}; window.loadRooms=()=>{}; window.refreshServerStatus=()=>{}; window.loadDiagnostics=()=>{}; window.startBugReplay=()=>{}; window.askForceReload=()=>{}; window.askPublishUpdate=()=>{}; window.enterTesterMode=()=>{}; window.pickTesterRole=()=>{}; window.clearDiagnostics=()=>{}; window.closeAccountDetail=()=>{document.getElementById('playerDetailWorkspace').classList.add('hidden');document.getElementById('playerDirectoryView').classList.remove('hidden');document.getElementById('playerDetailWorkspace').setAttribute('aria-hidden','true');};
window.openAccountDetail=(id,name)=>{switchTab('all');document.getElementById('playerDetailWorkspace').classList.remove('hidden');document.getElementById('playerDirectoryView').classList.add('hidden');document.getElementById('playerDetailWorkspace').setAttribute('aria-hidden','false');document.getElementById('accountDetailBody').textContent=name||id;document.getElementById('playerDetailBreadcrumbName').textContent=name||id;document.getElementById('playerDetailHeaderName').textContent=name||id;};
window.openHistoryModalByAccount=()=>{}; window.ensureAdminLogin=async()=>true;
let accounts=[]; let allPlayers=[]; let currentTab='overview';
</script>
<script>__REG__</script><script>__SHELL__</script><script>__P2__</script>
</body></html>'''


HTML = HTML.replace('{SHELL_CSS}', SHELL_CSS).replace('{P2_CSS}', P2_CSS).replace('__REG__', REG).replace('__SHELL__', SHELL).replace('__P2__', P2)


def main():
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f"SKIP: {exc}")
            raise SystemExit(77)

        page=browser.new_page(viewport={'width':1024,'height':720}); page.set_default_timeout(5000)
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.set_content(HTML, wait_until='load', timeout=8000)
        page.wait_for_timeout(250)
        assert not errors, errors
        page.evaluate("switchTab('tools')")
        page.wait_for_timeout(30)
        assert page.locator('#adminOperationsHeaderTools').is_visible()
        assert page.locator('#adminPageHeader #adminOperationsHeaderTools .ops-header-section-jump button').count() == 4
        assert page.locator('#tab-tools .phase2-section-jump').count() == 0
        assert page.locator('#tab-tools #phase2DevCard').count() == 0
        assert page.locator('#tab-tools .ops-more').count() == 0
        assert page.locator('#phase2OverviewExtra').count()==0
        assert page.locator('#tab-overview .overview-dashboard').count()==1
        assert page.locator('#tab-overview .overview-metric').count()==4
        assert page.locator('#tab-overview #overviewRooms').count()==1
        assert page.locator('#tab-overview #overviewActivity').count()==1
        assert page.locator('#tab-overview .dashboard-focus').count()==0
        assert page.locator('#tab-all .player-directory-toolbar').count()==1
        assert page.locator('#tab-all .directory-banner').count()==0
        assert page.locator('#tab-all #allPlayersContent').count()==1
        assert page.locator('#playerFilterBar [data-filter]').count()==6
        page.locator('[data-admin-nav="all"]').click(); page.wait_for_timeout(50)
        page.locator('#playerFilterBar [data-filter="online"]').click(); page.wait_for_timeout(50)
        assert page.locator('#allPlayersContent .all-player-card:not(.phase2-card-hidden)').count()==1
        page.locator('[data-admin-nav="rooms"]').click(); page.wait_for_timeout(50)
        assert page.locator('#phase2RoomSearch').count()==1
        page.locator('#phase2RoomSearch').fill('TEST01'); page.wait_for_timeout(50)
        assert page.locator('#roomsContent .room-card:not(.phase2-card-hidden)').count()==1
        page.locator('#phase2RoomSearch').fill(''); page.wait_for_timeout(50)
        page.locator('.admin-shell-room-select[data-room-id="ABC123"]').click(); page.wait_for_timeout(30)
        assert page.evaluate('window.WWAdminShell.state.selected.roomId')=='ABC123'
        assert page.locator('#adminShellContext').count()==0
        page.evaluate("window.__WW_ADMIN_PHASE2_PLAYERS=[{accountId:'A1',name:'Alice',accountType:'google',provider:'google',aliases:[]}]")
        page.keyboard.press('Control+K'); page.locator('#adminCommandSearch').fill('Alice'); page.wait_for_timeout(50)
        assert page.locator('[data-command-id^="phase2.player."]').count()==1
        page.locator('[data-command-id^="phase2.player."]').click(); page.wait_for_timeout(40)
        assert page.locator('#playerDetailWorkspace').is_visible()
        assert page.locator('#playerDirectoryView').is_hidden()
        assert page.locator('#accountDetailBody').inner_text() == 'Alice'
        page.locator('[data-player-detail-back]').first.click();
        page.evaluate("window.WWAdminShell.setContext({type:'player',accountId:'A1',name:'Alice'})")
        page.wait_for_timeout(30)
        assert page.evaluate('window.WWAdminShell.state.selected.name')=='Alice'
        assert page.locator('#adminShellContext').count()==0
        page.keyboard.press('Control+K'); page.locator('#adminCommandSearch').fill('ภาพรวม'); page.wait_for_timeout(40)
        page.locator('#adminCommandPinBtn').click(); page.wait_for_timeout(20)
        assert page.evaluate("window.WWAdminShell.state.pinned.includes('dashboard.open')")
        page.keyboard.press('Escape')
        page.set_viewport_size({'width':390,'height':700}); page.wait_for_timeout(40)
        assert page.evaluate('innerWidth') == 390, 'viewport did not switch to mobile'
        assert page.locator('.admin-sidebar').evaluate('(el)=>getComputedStyle(el).position') in ('fixed','sticky')
        browser.close()
    print('admin-phase2-browser: PASS')

if __name__ == '__main__': main()

