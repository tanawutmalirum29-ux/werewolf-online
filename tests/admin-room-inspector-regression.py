from pathlib import Path
import json
from playwright.sync_api import sync_playwright
from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
ADMIN = (ROOT / 'public' / 'admin.html').read_text(encoding='utf-8')
SERVER = (ROOT / 'server.js').read_text(encoding='utf-8')
PHASE2 = (ROOT / 'public' / 'js' / 'admin-phase2.js').read_text(encoding='utf-8')
SHELL_CSS = (ROOT / 'public' / 'css' / 'admin-shell.css').read_text(encoding='utf-8')
INLINE_CSS = ADMIN[ADMIN.index('<style>') + 7:ADMIN.index('</style>')]
js_start = ADMIN.index('let roomDetailData = null;')
js_end = ADMIN.index('function loadRooms()', js_start)
ROOM_JS = ADMIN[js_start:js_end]

ROOM = {
    'roomId':'AB12C', 'isTesterRoom':False, 'testerHostSlot':0, 'isClosing':False,
    'createdAt':'2026-09-26T05:00:00Z', 'startedAt':'2026-09-26T05:05:00Z',
    'gameRoundId':'round-1', 'started':True, 'gameOver':False, 'phase':'night',
    'nightCount':2, 'dayCount':1, 'isNight':True, 'voteMode':False, 'voteDeadline':None,
    'host':{'slot':1,'name':'Host A','connected':True},
    'counts':{'players':2,'totalPlayers':2,'bots':1,'connected':3,'alive':2,'maxPlayers':8},
    'settings':{'hasHostPassword':True,'hasJoinCode':False,'maxPlayers':8,'revealDeadRole':True,'voteTimerEnabled':True,'botAIEnabled':True,'testerConditions':{},'roleConfig':{'หมาป่า':1,'ชาวบ้าน':1}},
    'gameResult':None,
    'players':[
        {'slot':1,'name':'Host A','isHost':True,'isBot':False,'isTester':False,'accountId':'','alive':True,'connected':True,'selectedTarget':None,'voteTarget':None,'shieldTarget':None,'wolfKillTarget':None,'banditKillTarget':None},
        {'slot':2,'name':'Alice','isHost':False,'isBot':False,'isTester':False,'accountId':'ACC-A','alive':True,'connected':True,'displayRole':'ชาวบ้าน','selectedTarget':{'slot':3,'name':'Bot 1','isBot':True,'isHost':False},'voteTarget':None,'shieldTarget':None,'wolfKillTarget':None,'banditKillTarget':None},
        {'slot':3,'name':'Bot 1','isHost':False,'isBot':True,'isTester':False,'accountId':'','alive':True,'connected':True,'displayRole':'หมาป่า','selectedTarget':None,'voteTarget':{'slot':2,'name':'Alice','isBot':False,'isHost':False},'shieldTarget':None,'wolfKillTarget':{'slot':2,'name':'Alice','isBot':False,'isHost':False},'banditKillTarget':None},
    ],
    'diagnostics':{'selectedTargetCount':1,'voteCount':1,'shieldTargetCount':0,'wolfKillVoteCount':1,'banditKillVoteCount':0,'continueReadyCount':0,'chatMessages':4},
}

def fixture_html():
    helpers = r'''
    window.escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    window.formatDateTime = (iso) => iso ? new Date(iso).toLocaleString('th-TH', {timeZone:'UTC'}) : '-';
    window.socket = {connected:true, emit:(event,payload,cb)=> { if(event==='admin_get_room_detail') cb({ok:true,room:window.__room}); }};
    window.openAccountDetail = (id,name) => { window.__openedPlayer = {id,name}; };
    window.WWAdminShell = {setContext:()=>{}};
    window.currentTab = 'rooms';
    window.switchTab = () => {};
    window.closeAccountDetail = () => {};
    window.setAdminPageHeader = () => {};
    window.adminCloseRoom = (id) => { window.__closedRoom = id; };
    window.document.documentElement.style.setProperty('--safe','#4ade80');
    '''
    css = SHELL_CSS + '\n' + INLINE_CSS
    return f'''<!doctype html><html lang="th"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>{css}</style></head><body data-page="admin">
    <div class="admin-app-shell"><header class="admin-topbar" style="height:72px;flex:0 0 72px"><div>ADMIN</div></header><div class="admin-layout-grid" style="height:calc(100dvh - 72px);grid-template-columns:minmax(0,1fr)"><main class="admin-workspace" style="padding:12px"><div class="admin-page-stack"><section id="roomDirectoryView" class="admin-list-view"><div id="roomsContent"></div></section><section id="roomDetailWorkspace" class="admin-detail-workspace hidden" aria-hidden="true"><div class="admin-detail-breadcrumb"><button type="button" data-room-detail-back>ห้องเกม</button><span>›</span><strong id="roomDetailBreadcrumbId">รายละเอียดห้อง</strong></div><div class="admin-detail-header"><div><span class="admin-detail-kicker">ROOM INSPECTOR</span><h2>🏠 <span id="roomDetailHeaderId">รายละเอียดห้อง</span></h2><p id="roomDetailHeaderSub"></p><div class="admin-detail-header-meta"><span id="roomDetailHeaderStatus"></span></div></div><div class="admin-detail-header-actions"><button type="button" class="btn" data-room-detail-back>กลับ</button><button type="button" class="btn" data-room-detail-refresh>รีเฟรช</button><button type="button" class="btn btn-danger" data-room-detail-close-room>ปิดห้อง</button></div></div><div class="admin-detail-body" id="roomDetailBody"></div></section></div></main></div></div>
    <script>window.__room={json.dumps(ROOM, ensure_ascii=False)};</script><script>{helpers}</script><script>{ROOM_JS}</script></body></html>'''

def main():
    with sync_playwright() as p:
        browser=launch_chromium(p); page=browser.new_page(viewport={'width':1180,'height':682}); errors=[]; page.on('pageerror',lambda e: errors.append(str(e))); page.set_content(fixture_html(),wait_until='domcontentloaded'); page.wait_for_timeout(50); assert not errors,errors
        page.evaluate('window.openRoomInspector("ab12c")'); page.wait_for_timeout(60)
        assert page.locator('#roomDetailWorkspace').is_visible()
        assert page.locator('#roomDirectoryView').is_hidden()
        assert page.locator('#roomDetailHeaderId').inner_text().strip() == 'AB12C'; assert page.locator('#roomDetailBreadcrumbId').inner_text().strip() == 'AB12C'; assert page.locator('#roomDetailHeaderStatus .room-inspector-chip').count() >= 2
        assert page.locator('.room-inspector-kpi').count()==4
        assert page.locator('.room-inspector-player').count()==3
        assert page.locator('.room-inspector-detail').count()==2
        assert page.locator('.room-inspector-action-chip').count()>=2
        assert page.locator('[data-room-detail-close-room]').count()==1
        assert page.locator('[data-room-detail-refresh]').count()>=1
        page.locator('[data-room-player-account="ACC-A"]').click(); assert page.evaluate('window.__openedPlayer')=={'id':'ACC-A','name':'Alice'}
        page.locator('[data-room-detail-close-room]').click(); assert page.evaluate('window.__closedRoom')=='AB12C'
        page.set_viewport_size({'width':1440,'height':900}); page.wait_for_timeout(30)
        detail=page.locator('#roomDetailWorkspace').bounding_box(); work=page.locator('.admin-workspace').bounding_box(); top=page.locator('.admin-topbar').bounding_box(); inner=page.locator('.admin-workspace').evaluate("e=>e.clientWidth-parseFloat(getComputedStyle(e).paddingLeft)-parseFloat(getComputedStyle(e).paddingRight)"); assert detail and work and top and detail['width']>=inner-2 and detail['y'] >= top['y'] + top['height'] - 1, (detail,work,top,inner)
        for width,height in [(1180,682),(390,844),(1440,900),(1800,1000)]:
            page.set_viewport_size({'width':width,'height':height}); page.wait_for_timeout(25); overflow=page.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth'); assert overflow<=1,(width,height,overflow)
        page.evaluate('window.__room.gameOver=true; window.__room.gameResult={title:"ทีมหมาป่าชนะ",label:"หมาป่า",winners:[{name:"Alice",isBot:false,isHost:false}]}; window.renderRoomInspector(window.__room)'); assert 'ทีมหมาป่าชนะ' in page.locator('#roomDetailBody').inner_text()
        page.locator('[data-room-detail-back]').first.click(); page.wait_for_function("document.getElementById('roomDirectoryView')?.classList.contains('hidden') === false && document.getElementById('roomDetailWorkspace')?.classList.contains('hidden') === true"); assert 'hidden' not in (page.locator('#roomDirectoryView').get_attribute('class') or ''); assert page.locator('#roomDetailWorkspace').is_hidden()
        browser.close()
    assert 'socket.on("admin_get_room_detail"' in SERVER and 'recoverPersistedRoomById(id, { reason: "admin_room_inspector" })' in SERVER
    assert 'window.openRoomInspector?.(r?.roomId||"",r)' in PHASE2 and 'window.openRoomInspector?.(r.roomId,r)' in PHASE2
    print('admin-room-inspector-regression: PASS')
if __name__=='__main__': main()
