from pathlib import Path
import re
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: Python Playwright unavailable: {exc}')
    raise SystemExit(77)

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
ADMIN_HTML = (ROOT / 'public' / 'admin.html').read_text()
SHELL_CSS = (ROOT / 'public' / 'css' / 'admin-shell.css').read_text()
BROWSER_CSS = (ROOT / 'public' / 'css' / 'admin-browser.css').read_text()
VERSIONS_CSS = (ROOT / 'public' / 'css' / 'admin-versions.css').read_text()
PHASE2_CSS = (ROOT / 'public' / 'css' / 'admin-phase2.css').read_text()
DEPENDENCIES = {
    'error-reporter.js': (ROOT / 'public' / 'js' / 'error-reporter.js').read_text(),
    'shared.config-client.js': (ROOT / 'public' / 'js' / 'shared.config-client.js').read_text(),
    'shared.update-check.js': (ROOT / 'public' / 'js' / 'shared.update-check.js').read_text(),
    'runtime-audit-engine.js': (ROOT / 'public' / 'js' / 'runtime-audit-engine.js').read_text(),
    'admin-auth-tab.js': (ROOT / 'public' / 'js' / 'admin-auth-tab.js').read_text(),
    'admin-command-registry.js': (ROOT / 'public' / 'js' / 'admin-command-registry.js').read_text(),
    'admin-shell.js': (ROOT / 'public' / 'js' / 'admin-shell.js').read_text(),
    'runtime-audit.js': (ROOT / 'public' / 'js' / 'runtime-audit.js').read_text(),
    'ww-ui.js': (ROOT / 'public' / 'js' / 'ww-ui.js').read_text(),
    'admin-browser.js': (ROOT / 'public' / 'js' / 'admin-browser.js').read_text(),
    'admin-versions.js': (ROOT / 'public' / 'js' / 'admin-versions.js').read_text(),
}


def make_browser_html():
    html = ADMIN_HTML.replace('__WW_ADMIN_RELEASE__', 'release-old')
    assert '<script src="/js/admin-shell.js?v=20260926-5"></script>' in html, 'real admin page must load Admin Shell script'
    assert '<script src="/js/admin-auth-tab.js?v=20260925-1"></script>' in html, 'real admin page must load tab auth script'
    assert '<script src="/js/admin-command-registry.js?v=20260925-2"></script>' in html, 'real admin page must load command registry'
    assert '<link href="/css/admin-shell.css?v=20260927-16" rel="stylesheet"/>' in html, 'real admin page must load wide-screen Admin shell stylesheet'
    assert '<script src="/js/admin-browser.js?v=20260926-24"></script>' in html, 'real admin page must load Internal Browser'
    assert '<link href="/css/admin-browser.css?v=20260927-22" rel="stylesheet"/>' in html, 'real admin page must load Internal Browser stylesheet'
    assert '<link href="/css/admin-versions.css?v=20260926-1" rel="stylesheet"/>' in html, 'real admin page must load Versions stylesheet'
    assert '<link href="/css/admin-phase2.css?v=20260926-7" rel="stylesheet"/>' in html, 'real admin page must load Phase 2 stylesheet'
    assert '<script src="/js/admin-versions.js?v=20260926-1"></script>' in html, 'real admin page must load Versions module'
    html, css_count = re.subn(r'<link[^>]*href="/css/admin-shell\.css(?:\?[^"]*)?"[^>]*>', f'<style>{SHELL_CSS}</style>', html, count=1)
    html, browser_css_count = re.subn(r'<link[^>]*href="/css/admin-browser\.css(?:\?[^"]*)?"[^>]*>', f'<style>{BROWSER_CSS}</style>', html, count=1)
    html, versions_css_count = re.subn(r'<link[^>]*href="/css/admin-versions\.css(?:\?[^"]*)?"[^>]*>', f'<style>{VERSIONS_CSS}</style>', html, count=1)
    html, phase2_css_count = re.subn(r'<link[^>]*href="/css/admin-phase2\.css(?:\?[^"]*)?"[^>]*>', f'<style>{PHASE2_CSS}</style>', html, count=1)
    assert browser_css_count == 1, 'could not inline admin browser stylesheet'
    assert versions_css_count == 1, 'could not inline admin versions stylesheet'
    assert css_count == 1, 'could not inline admin shell stylesheet'
    socket_stub = '''<script>(function(){window.io=function(){const h={};const s={connected:false,on(e,f){(h[e]??=[]).push(f);return s},once(e,f){return s.on(e,f)},emit(e,p,cb){if(typeof cb==='function')cb(e==='admin_list_accounts'?{ok:true,accounts:[]}:e==='admin_list_rooms'?{ok:true,rooms:[]}:({ok:true}));return s},connect(){if(s.connected)return s;s.connected=true;(h.connect||[]).forEach(f=>f());return s},disconnect(){if(!s.connected)return s;s.connected=false;(h.disconnect||[]).forEach(f=>f());return s}};return s};})();</script>'''
    html = html.replace('<script src="/socket.io/socket.io.js"></script>', socket_stub, 1)
    html = html.replace('<body data-page="admin">', '<body data-page="admin"><script>window.WWAdminTesterAuth={getPass:async()=>({token:"inline-test-pass"}),controllerId:()=>"inline-admin-controller"};</script>', 1)
    for filename, code in DEPENDENCIES.items():
        pattern = re.compile(r'<script\s+src="/js/' + re.escape(filename) + r'(?:\?[^\"]*)?"></script>')
        html, count = pattern.subn(lambda _m: '<script>' + code + '\n</script>', html, count=1)
        assert count == 1, f'could not inline {filename}'
    # Seed an older known version before the real Admin scripts run so the shared detector observes one update.
    # The Admin page only needs JSON-shaped responses for this DOM execution test. The version field is
    # the same canonical signal used by Index; no Admin release probe is involved.
    fetch_stub = '''<script>window.fetch=async function(url,init){const u=String(url||'');let body={ok:true};if(u.includes('/api/admin/session'))body={ok:true,required:false,authenticated:true,passwordEnabled:false,googleEnabled:false,provider:'test'};else if(u.includes('/api/config'))body={ok:true,serverOpen:true,appVersion:'inline-test',version:'release-new',deploymentState:'ready',environmentStatus:'Ready',environmentVersionLabel:'v3-42'};else if(u.includes('/api/admin/players'))body={ok:true,players:[]};else if(u.includes('/api/admin/diagnostics'))body={ok:true,events:[]};else if(u.includes('/api/admin/versions'))body={ok:true,environment:{name:'werewolf-online-th-env',applicationName:'werewolf-game',status:'Ready',health:'Green',healthStatus:'Ok',versionLabel:'v3-42',abortableOperationInProgress:false},versions:[{versionLabel:'v3-42',description:'current',status:'Processed',dateCreated:'2026-09-25T00:00:00Z',dateUpdated:'2026-09-25T00:00:00Z',downloadable:true,current:true,rollbackAllowed:false},{versionLabel:'v3-41',description:'previous',status:'Processed',dateCreated:'2026-09-24T00:00:00Z',dateUpdated:'2026-09-24T00:00:00Z',downloadable:true,current:false,rollbackAllowed:true}]};return {ok:true,status:200,headers:new Headers(),json:async()=>body,text:async()=>JSON.stringify(body)};};</script>'''
    html = html.replace('<style>', fetch_stub + '<style>', 1)
    return html


def main():
    html = make_browser_html()
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f"SKIP: {exc}")
            raise SystemExit(77)
        page = browser.new_page(viewport={'width': 1024, 'height': 720})
        page_errors = []
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.set_content(html, wait_until='load')
        page.wait_for_timeout(700)

        assert page.locator('#adminApp').count() == 1, 'real admin.html did not create Admin Control Center'
        assert page.locator('.admin-sidebar [data-admin-nav]').count() == 8, 'persistent sidebar navigation missing'
        assert page.locator('.admin-sidebar [data-admin-nav=\"browser\"]').count() == 1, 'Internal Browser navigation missing from sidebar'
        assert page.locator('#adminGameSurface').count() == 0, 'legacy Index iframe must not be part of the Admin workspace'
        assert page.locator('.admin-bottom-dock').count() == 0, 'legacy bottom dock should be removed'
        assert page.locator('#adminPanelSheet').count() == 0, 'legacy floating panel sheet should be removed'
        assert page.locator('#adminCommandPalette').count() == 1, 'command palette missing'
        assert page.locator('#adminBrowserView').count() == 1, 'internal browser surface missing'
        assert page.locator('#adminBrowserTabs').count() == 1, 'internal browser tab strip missing'
        assert page.evaluate('Boolean(window.WWAdminBrowser && window.WWAdminBrowser.openTester)')
        assert page.locator('#adminShellServerStatus').count() == 1, 'live shell status strip missing'
        assert page.evaluate('Boolean(window.WWAdminShell && window.WWAdminTabAuth && window.WWAdminCommandRegistry)')
        # Seed the shared detector with an older known version after the page's bootstrap calls,
        # then invoke the exact same detector-based Admin check used by the live page.
        page.evaluate("window.WWUpdateDetector.setKnownVersion('release-old')")
        page.evaluate("checkAdminUpdate()")
        page.wait_for_timeout(100)
        assert page.locator('#adminUpdateNotice').count() == 1, 'Admin did not surface the shared version-update notice'
        assert page.locator('#adminUpdateNotice').inner_text().find('มีรุ่นใหม่พร้อมใช้งาน') >= 0
        assert page.locator('#adminUpdateReloadBtn').count() == 1, 'shared update notice is missing its reload button'
        assert page.locator('#adminUpdateNotice').evaluate('(el)=>getComputedStyle(el).position') == 'fixed'
        page.keyboard.press('Control+K')
        assert page.locator('#adminCommandPalette').is_visible(), 'real admin page command palette did not open'
        page.keyboard.press('Escape')
        page.wait_for_timeout(30)
        assert not page.locator('#adminCommandPalette').is_visible(), 'command palette Escape did not close'
        page.evaluate("switchTab('all')")
        page.wait_for_timeout(60)
        assert page.locator('#tab-all .player-directory-toolbar').count() == 1, 'Player Accounts compact toolbar missing'
        assert page.locator('#tab-all .directory-banner').count() == 0, 'legacy verbose directory banner must stay removed'
        assert page.locator('#tab-all .player-directory-search').count() == 1, 'Player Accounts search control missing'
        assert page.locator('#tab-all .player-directory-refresh').count() == 0, 'duplicate Player Accounts refresh button must stay removed'
        assert page.locator('#tab-all #allPlayersContent').count() == 1, 'Player Accounts content mount missing'
        page.evaluate("switchTab('versions')")
        page.wait_for_timeout(80)
        assert page.locator('#tab-versions.active').count() == 1, 'Versions panel did not activate in real Admin HTML'
        assert page.locator('#adminVersionsEnvironment').inner_text().find('v3-42') >= 0, 'Versions environment did not show current EB version'
        assert page.locator('#adminVersionsList [data-version-download]').count() == 2, 'Versions download actions did not render from API data'
        assert page.locator('#adminVersionsList [data-version-rollback]').count() == 2, 'Versions rollback actions did not render from API data'

        # Operations redesign regression: compact action-first layout with concise copy.
        page.evaluate("switchTab('tools')")
        page.wait_for_timeout(80)
        assert page.locator('#tab-tools.active').count() == 1, 'Operations panel did not activate'
        assert page.locator('#tab-tools .ops-grid').count() == 1, 'Operations grid missing'
        assert page.locator('#tab-tools .ops-card').count() == 4, 'Operations card structure is incomplete'
        assert page.locator('#adminOperationsHeaderTools').is_visible(), 'Operations header tools are not visible'
        assert page.locator('#adminOperationsHeaderTools .ops-header-section-jump button').count() == 4, 'Operations header navigation is incomplete'
        assert page.locator('#tab-tools .ops-more').count() == 0, 'Operations details accordions must be removed'
        body_text = page.locator('#tab-tools').inner_text()
        for old in [
            'งานประจำวันอยู่ด้านบน งานสำหรับนักพัฒนาอยู่ท้าย',
            'สั่งให้ทุกเครื่องที่เปิดเกมอยู่โหลดใหม่แล้วกลับ หน้าแรก',
            'สิทธิ์นี้ตัดสินจากบัตรผ่านที่ server ออกให้เท่านั้น',
            'ข้อมูลสำหรับตรวจรุ่นหน้า Admin และเครื่องมือช่วยส่งคำสั่งแก้ไข',
            'ข้อมูลรุ่นของ Admin และ Shell',
            'Admin release',
            'UI shell',
            'Control Center v2',
        ]:
            assert old not in body_text, f'verbose legacy Operations copy remains: {old}'
        ops = page.evaluate("""() => {
          const panel=document.querySelector('#tab-tools');
          const grid=document.querySelector('#tab-tools .ops-grid');
          const all=[...document.querySelectorAll('#tab-tools .ops-card')];
          return {
            scrollW:document.documentElement.scrollWidth, vw:innerWidth,
            gridCols:getComputedStyle(grid).gridTemplateColumns,
            gridWidth:grid.getBoundingClientRect().width,
            panelWidth:panel.getBoundingClientRect().width,
            panelRight:panel.getBoundingClientRect().right,
            cardRects:all.map(x=>{const r=x.getBoundingClientRect();return {id:x.id||x.className,w:r.width,right:r.right,bottom:r.bottom};}),
            headerPosition:getComputedStyle(document.querySelector('#adminPageHeader')).position,
            navInsideHeader:document.querySelector('#adminPageHeader #adminOperationsHeaderTools .ops-header-section-jump') !== null,
            headerToolHeight:document.querySelector('#adminOperationsHeaderTools').getBoundingClientRect().height
          };
        }""")
        assert ops['scrollW'] <= ops['vw'] + 1, ops
        assert len(ops['gridCols'].split()) >= 2 and abs(float(ops['gridCols'].split()[0].replace('px','')) - float(ops['gridCols'].split()[1].replace('px',''))) < 2, ops
        assert all(r['right'] <= ops['panelRight'] + 2 for r in ops['cardRects']), ops
        assert ops['headerPosition'] == 'sticky' and ops['navInsideHeader'], ops
        page.screenshot(path=str(ROOT / 'ADMIN-OPERATIONS-PREVIEW-1440x900.png'), full_page=False)

        # Mobile Operations regression: single-column cards, horizontal jump row, and no overflow.
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(50)
        mobile_ops = page.evaluate("""() => {
          const panel=document.querySelector('#tab-tools');
          const grid=panel.querySelector('.ops-grid');
          const nav=document.querySelector('#adminOperationsHeaderTools .ops-header-section-jump');
          const cards=[...panel.querySelectorAll('.ops-card')];
          return {
            scrollW:document.documentElement.scrollWidth,vw:innerWidth,
            cols:getComputedStyle(grid).gridTemplateColumns,
            gridW:grid.getBoundingClientRect().width,panelW:panel.getBoundingClientRect().width,
            navW:nav.getBoundingClientRect().width,navScrollW:nav.scrollWidth,
            cards:cards.map(x=>{const r=x.getBoundingClientRect();return {right:r.right,w:r.width}})
          };
        }""")
        assert mobile_ops['scrollW'] <= mobile_ops['vw'] + 1, mobile_ops
        assert mobile_ops['gridW'] <= mobile_ops['panelW'] + 1, mobile_ops
        assert len(mobile_ops['cols'].split()) == 1, mobile_ops
        assert all(r['right'] <= (mobile_ops['panelW'] + 24) + 2 for r in mobile_ops['cards']), mobile_ops
        assert mobile_ops['navScrollW'] + 1 >= mobile_ops['navW'], mobile_ops
        assert page.locator('#adminOperationsHeaderTools').is_visible(), 'Operations header tools disappeared on mobile'

        # Mobile Admin header regression: page chrome must stay compact even on the
        # Operations and Diagnostics tabs, where secondary controls used to stack
        # into multiple vertical rows and consume the content viewport.
        mobile_headers = page.evaluate("""() => {
          const h=()=>document.querySelector('.admin-page-header').getBoundingClientRect().height;
          return {overview:h(), tools:(switchTab('tools'), h()), diagnostics:(switchTab('diagnostics'), h())};
        }""")
        assert mobile_headers['overview'] <= 90, mobile_headers
        assert mobile_headers['tools'] <= 100, mobile_headers
        assert mobile_headers['diagnostics'] <= 100, mobile_headers
        assert page.locator('#adminDiagnosticsHeaderTools').is_visible(), 'Diagnostics header tools disappeared on mobile'
        page.evaluate("switchTab('overview')")
        page.wait_for_timeout(40)

        page.set_viewport_size({'width': 1180, 'height': 682})
        page.wait_for_timeout(40)
        page.evaluate("switchTab('overview')")
        page.wait_for_timeout(40)
        # Overview dashboard contract: four primary metrics, no tester KPI / Quick Actions / health duplicate.
        assert page.locator('#tab-overview.active .overview-dashboard').count() == 1, 'redesigned Overview dashboard missing'
        assert page.locator('#tab-overview.active .overview-metric').count() == 4, 'Overview must contain exactly four primary metrics'
        assert page.locator('#tab-overview.active #overviewRooms').count() == 1, 'Overview room panel missing'
        assert page.locator('#tab-overview.active #overviewActivity').count() == 1, 'Overview activity panel missing'
        assert page.locator('#tab-overview.active .dashboard-focus').count() == 0, 'legacy Overview guidance block remains'
        assert page.locator('#tab-overview.active #phase2OverviewExtra').count() == 0, 'legacy Phase 2 overview layer remains'

        # Independent scroll-region regression. Add enough content to force both the
        # sidebar and workspace to scroll without growing the outer document. The
        # page title/header and global topbar must remain pinned while workspace and
        # sidebar move independently.
        page.evaluate(r'''() => {
          const sidebar = document.querySelector('.admin-sidebar');
          const recent = document.getElementById('overviewActivity');
          if (sidebar) {
            const filler = document.createElement('div');
            filler.setAttribute('data-scroll-test-sidebar-filler','true');
            filler.style.height = '1800px';
            sidebar.appendChild(filler);
          }
          if (recent) {
            const filler = document.createElement('div');
            filler.setAttribute('data-scroll-test-workspace-filler','true');
            filler.style.height = '2400px';
            recent.appendChild(filler);
          }
        }''')
        page.wait_for_timeout(40)
        independent = page.evaluate(r'''() => {
          const body = document.body;
          const top = document.querySelector('.admin-topbar');
          const side = document.querySelector('.admin-sidebar');
          const ws = document.getElementById('adminWorkspace');
          const head = document.querySelector('.admin-page-header');
          const before = {
            top: top?.getBoundingClientRect().top ?? -1,
            side: side?.getBoundingClientRect().top ?? -1,
            head: head?.getBoundingClientRect().top ?? -1
          };
          ws.scrollTop = 420;
          side.scrollTop = 260;
          const after = {
            top: top?.getBoundingClientRect().top ?? -1,
            side: side?.getBoundingClientRect().top ?? -1,
            head: head?.getBoundingClientRect().top ?? -1
          };
          return {
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            workspaceClientHeight: ws.clientHeight,
            workspaceScrollHeight: ws.scrollHeight,
            workspaceScrollTop: ws.scrollTop,
            sidebarClientHeight: side.clientHeight,
            sidebarScrollHeight: side.scrollHeight,
            sidebarScrollTop: side.scrollTop,
            topBefore: before.top, topAfter: after.top,
            sideBefore: before.side, sideAfter: after.side,
            headBefore: before.head, headAfter: after.head,
            htmlScrollWidth: document.documentElement.scrollWidth,
            bodyScrollWidth: body.scrollWidth
          };
        }''')
        assert independent['bodyScrollHeight'] <= independent['bodyClientHeight'] + 1, f'outer document must not scroll: {independent}'
        assert independent['workspaceScrollHeight'] > independent['workspaceClientHeight'] + 100, f'workspace must own vertical scrolling: {independent}'
        assert independent['sidebarScrollHeight'] > independent['sidebarClientHeight'] + 100, f'sidebar must own vertical scrolling: {independent}'
        assert independent['workspaceScrollTop'] > 0, f'workspace did not scroll: {independent}'
        assert independent['sidebarScrollTop'] > 0, f'sidebar did not scroll independently: {independent}'
        assert abs(independent['topAfter'] - independent['topBefore']) < 1, f'global topbar moved with workspace: {independent}'
        assert abs(independent['headAfter'] - independent['headBefore']) < 1, f'page title header moved with workspace: {independent}'
        assert abs(independent['sideAfter'] - independent['sideBefore']) < 1, f'sidebar moved when its own scroll position changed: {independent}'
        assert independent['htmlScrollWidth'] <= independent['viewportWidth'] + 1, f'Admin HTML acquired unexpected horizontal overflow: {independent}'

        # Phone regression: bottom navigation stays fixed while the workspace remains
        # the only page content scroller. The topbar and page title must not move.
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_timeout(60)
        phone = page.evaluate("""() => {
          const top=document.querySelector('.admin-topbar');
          const side=document.querySelector('.admin-sidebar');
          const ws=document.getElementById('adminWorkspace');
          const head=document.querySelector('.admin-page-header');
          ws.scrollTop=260;
          return {
            viewportWidth:innerWidth,
            workspaceScrollTop:ws.scrollTop,
            workspaceOverflow:getComputedStyle(ws).overflowY,
            sidebarPosition:getComputedStyle(side).position,
            topPosition:getComputedStyle(top).position,
            headPosition:getComputedStyle(head).position,
            topTop:top.getBoundingClientRect().top,
            headTop:head.getBoundingClientRect().top,
            bodyScrollHeight:document.body.scrollHeight,
            bodyClientHeight:document.body.clientHeight,
            htmlScrollWidth:document.documentElement.scrollWidth
          };
        }""")
        assert phone['workspaceScrollTop'] > 0, f'phone workspace did not scroll: {phone}'
        assert phone['workspaceOverflow'] in ('auto','scroll'), f'phone workspace is not the scroll owner: {phone}'
        assert phone['sidebarPosition'] == 'fixed', f'phone navigation must remain fixed: {phone}'
        assert phone['topPosition'] == 'relative', f'phone topbar must remain outside page scrolling: {phone}'
        assert phone['headPosition'] == 'sticky', f'phone page title header must remain sticky: {phone}'
        assert phone['bodyScrollHeight'] <= phone['bodyClientHeight'] + 1, f'phone outer document must not scroll: {phone}'
        assert phone['htmlScrollWidth'] <= phone['viewportWidth'] + 1, f'phone acquired horizontal overflow: {phone}'
        # Context-rail removal regression: the workspace must retain the full width after the fixed sidebar.
        page.set_viewport_size({'width': 1180, 'height': 682})
        page.wait_for_timeout(40)
        mid = page.evaluate("""() => {
          const grid=document.querySelector('.admin-layout-grid');
          const ws=document.querySelector('.admin-workspace');
          const intro=document.querySelector('.phase2-page-intro');
          const actions=document.querySelector('.phase2-page-actions');
          const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,w:r.width,right:r.right,h:r.height};};
          return {scrollW:document.documentElement.scrollWidth, vw:innerWidth, grid:rect(grid), ws:rect(ws), intro:intro?rect(intro):null, actions:actions?rect(actions):null, cols:getComputedStyle(grid).gridTemplateColumns};
        }""")
        assert mid['scrollW'] <= mid['vw'] + 1, mid
        assert mid['ws']['w'] > 900, mid
        assert mid['grid']['w'] >= mid['ws']['w'], mid
        assert mid['intro']['right'] <= mid['ws']['right'] + 1, mid
        assert mid['actions']['right'] <= mid['intro']['right'] + 1, mid
        assert '260px' not in mid['cols'] and '286px' not in mid['cols'], mid

        page.set_viewport_size({'width': 1440, 'height': 900})
        page.wait_for_timeout(30)
        wide_mid = page.evaluate("""() => ({
          scrollW:document.documentElement.scrollWidth, vw:innerWidth,
          grid:getComputedStyle(document.querySelector('.admin-layout-grid')).gridTemplateColumns,
          ws:document.querySelector('.admin-workspace').getBoundingClientRect().width
        })""")
        assert wide_mid['scrollW'] <= wide_mid['vw'] + 1, wide_mid
        assert '260px' not in wide_mid['grid'] and '286px' not in wide_mid['grid'], wide_mid
        assert wide_mid['ws'] > 1160, wide_mid

        # Wide desktop regression: Admin content must expand beyond the legacy 1180px cap.
        page.set_viewport_size({'width': 2560, 'height': 1440})
        page.wait_for_timeout(50)
        wide_stack_width = page.locator('#adminPageStack').evaluate('(el)=>el.getBoundingClientRect().width')
        wide_header_width = page.locator('.admin-page-header').evaluate('(el)=>el.getBoundingClientRect().width')
        assert wide_stack_width > 1700, wide_stack_width
        assert wide_header_width > 1700, wide_header_width
        page.set_viewport_size({'width': 3840, 'height': 2160})
        page.wait_for_timeout(50)
        ultra_stack_width = page.locator('#adminPageStack').evaluate('(el)=>el.getBoundingClientRect().width')
        assert ultra_stack_width > 2500, ultra_stack_width
        page.set_viewport_size({'width': 390, 'height': 700})
        page.wait_for_timeout(50)
        assert page.locator('.admin-sidebar').evaluate('(el)=>getComputedStyle(el).position') == 'fixed'
        assert not page_errors, page_errors
        browser.close()
    print('admin-real-html-browser: PASS')


if __name__ == '__main__':
    main()
