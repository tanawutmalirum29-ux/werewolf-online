from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / 'public' / 'css' / 'player.css').read_text()
JS = (ROOT / 'public' / 'js' / 'player.main.js').read_text()
start = JS.find('function computePlayerGridLayout')
end = JS.find('// ===== px (อ้างอิงการ์ดดีฟอลต์ 88px)', start)
CONTROLLER = JS[start:end]


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


FIXTURE_TEMPLATE = '''<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>__CSS__</style></head>
<body data-page="player" class="is-day">
<div class="scene-layer"><div class="scene-stars"></div><div class="scene-disc"></div></div>
<div class="app game-visible game-started">
  <div class="card" id="rolesPanelCard"><h3>บทในเกมรอบนี้</h3><div id="rolesInGamePanel">
    <div class="role-row"><b>🐺 หมาป่า</b><span>5</span></div><div class="role-row"><b>🧙‍♂️ นักเล่นกล</b><span>2</span></div><div class="role-row"><b>🛡️ ผู้พิทักษ์</b><span>1</span></div><div class="role-row"><b>🔮 ผู้หยั่งรู้</b><span>1</span></div><div class="role-row"><b>🎭 ชาวบ้าน</b><span>20</span></div>
  </div></div>
  <div class="card" id="playersCard"><div class="players-card-head"><h3 id="phaseTitle"><span id="phaseIcon">☀️</span><span id="phaseText">กลางวัน · ผู้เล่นในห้อง</span></h3><div class="player-filter-chips"><button class="filterChip active">ทั้งหมด</button><button class="filterChip">มีชีวิต</button><button class="filterChip">ตายแล้ว</button></div></div><p class="sub" id="playersSub"><span>เหลือเวลา 01:45</span></p><div id="players"></div></div>
  <div class="card" id="chatCard"><div class="chatTabs"><div class="chatTab active">💬 รวม <span class="tab-badge">3</span></div><div class="chatTab">🐺 หมาป่า</div></div><div id="chatBoxGlobal"><div class="msg"><b>ผู้เล่น 3</b> พร้อมเริ่มแล้ว</div><div class="msg"><b>ผู้เล่น 8</b> มีใครเห็นคนแปลก ๆ ไหม</div><div class="msg"><b>ผู้เล่น 12</b> รอเสียงโหวต</div></div><div class="chatRow"><input value="พิมพ์ข้อความ..." disabled><button class="sendBtn">ส่ง</button></div></div>
</div>
<div id="bottomBar" class="bar-visible"><button id="maskBtn">🎭</button><div id="barRoleText"><div id="barRoleName">ผู้หยั่งรู้</div><div id="barRoleSub">แตะหน้ากากเพื่อดูรายละเอียด</div></div><button>🛡️</button><button>🔮</button><button>🧪</button><button>🪄</button><button>🐾</button></div>
<div id="dayNightBadge"></div>
<script>__CONTROLLER__</script>
<script>
window.addEventListener('load',()=>{
 const p=document.getElementById('players');
 for(let i=1;i<=29;i++){const d=document.createElement('div');d.className='player';d.dataset.pid='p'+i;d.dataset.alive='1';d.innerHTML='<div class="pname">ผู้เล่น'+i+'</div>';p.appendChild(d)}
 requestAnimationFrame(()=>requestAnimationFrame(()=>{ if(window.fitPlayerGrid) window.fitPlayerGrid(); }));
});
</script></body></html>'''
FIXTURE = FIXTURE_TEMPLATE.replace('__CSS__', CSS).replace('__CONTROLLER__', CONTROLLER)

with sync_playwright() as p:
    browser = launch_chromium(p)
    cases = [
        (390,844,'mobile-390', True),
        (600,900,'mobile-large-600', True),
        (768,1024,'tablet-768', False),
        (834,1194,'ipad-11-portrait', False),
        (1024,768,'tablet-1024', False),
        (1180,682,'ipad-landscape', False),
        (1280,720,'desktop-1280', False),
        (1366,768,'desktop-1366', False),
        (1440,900,'desktop-1440', False),
        (1474,1007,'desktop-1474', False),
        (1920,1080,'desktop-1920', False),
        (2560,1440,'desktop-2560', False),
        (3840,2160,'desktop-3840', False),
    ]
    out = ROOT.parent / 'player_wide_screens'
    out.mkdir(exist_ok=True)
    summaries = []
    for w,h,name,is_mobile in cases:
        page=browser.new_page(viewport={'width':w,'height':h},device_scale_factor=1)
        page.set_content(FIXTURE,wait_until='load')
        page.wait_for_timeout(220)
        page.evaluate('''() => { if (typeof window.fitPlayerGrid !== 'function') throw new Error('production fitPlayerGrid unavailable'); window.fitPlayerGrid(); }''')
        page.wait_for_timeout(220)
        metrics=page.evaluate('''() => {
            const rect=e=>{const r=e?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null};
            const p=document.getElementById('players');
            const cards=[...p.querySelectorAll('.player')].map(rect);
            const pr=rect(p), chat=rect(document.getElementById('chatCard')), dock=rect(document.getElementById('bottomBar')), roles=rect(document.getElementById('rolesPanelCard'));
            const overflow=cards.length&&pr ? Math.max(0,...cards.map(r=>Math.max(pr.x-r.x,r.x+r.w-(pr.x+pr.w),pr.y-r.y,r.y+r.h-(pr.y+pr.h),0))) : 0;
            return {
                viewport:[innerWidth,innerHeight], app:rect(document.querySelector('.app')), roles, players:rect(document.getElementById('playersCard')), grid:pr, chat,dock,
                columns:+(p.dataset.gridColumns||0), rows:+(p.dataset.gridRows||0), card:cards.length?Math.min(...cards.map(x=>x.w)):0,
                status:p.dataset.gridFitStatus||'', scroll:Math.max(0,p.scrollHeight-p.clientHeight), overflow
            };
        }''')
        assert_true(metrics['columns'] >= 1 and metrics['rows'] >= 1, f'{name}: invalid grid dimensions {metrics}')
        assert_true(metrics['card'] >= 40, f'{name}: card collapsed below readable emergency floor {metrics}')
        assert_true(metrics['scroll'] <= 1 and metrics['overflow'] <= 1, f'{name}: player cards overflow their stage {metrics}')
        assert_true(metrics['status'] in ('fit','guarded'), f'{name}: grid did not settle {metrics}')
        assert_true(metrics['chat']['y'] + metrics['chat']['h'] <= metrics['dock']['y'] + 1, f'{name}: chat overlaps command dock {metrics}')

        if is_mobile:
            assert_true(metrics['roles']['w'] == 0, f'{name}: role rail should be hidden {metrics}')
            assert_true(metrics['dock']['h'] <= 68, f'{name}: mobile dock became tall again {metrics}')
        elif w < 1280:
            assert_true(metrics['roles']['w'] == 0, f'{name}: tablet role rail should stay hidden {metrics}')
            assert_true(metrics['dock']['h'] <= 68, f'{name}: tablet dock became tall again {metrics}')
        else:
            assert_true(metrics['roles']['w'] >= 210, f'{name}: desktop role zone disappeared {metrics}')
            assert_true(metrics['chat']['w'] >= 280, f'{name}: desktop chat zone disappeared {metrics}')

        if w >= 1920:
            assert_true(metrics['card'] >= (175 if w < 2400 else 230), f'{name}: large-screen player cards did not scale with available space {metrics}')
        if w >= 3200:
            assert_true(metrics['card'] >= 320, f'{name}: 4K workspace is still capped at the old small card size {metrics}')
            assert_true(metrics['roles']['w'] >= 400 and metrics['chat']['w'] >= 500, f'{name}: 4K side zones are not using the additional width {metrics}')

        print(name, metrics)
        page.screenshot(path=str(out/f'{name}.png'),full_page=False)
        summaries.append((name,metrics))
        page.close()
    browser.close()

print('player-wide-screen-browser: PASS')
