from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f"SKIP: Python Playwright unavailable: {exc}")
    raise SystemExit(77)

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
BROWSER_JS = (ROOT / 'public/js/admin-browser.js').read_text()
# The execution environment blocks browser navigation to arbitrary hosts. Keep the
# production tab lifecycle/UI logic intact but provide a real same-origin child
# document through srcdoc so the strengthened frame-health contract is exercised.
BROWSER_JS = BROWSER_JS.replace('location.origin', '"http://internal.test"')
BROWSER_JS = BROWSER_JS.replace('iframe.src = frameSrc;', 'iframe.srcdoc = window.__WWAdminTestFrameDocument?.(tab) || "";')
BROWSER_JS = BROWSER_JS.replace('iframe.src = iframe.dataset.loadedSrc;', 'iframe.srcdoc = window.__WWAdminTestFrameDocument?.(tab) || "";')
BROWSER_JS = BROWSER_JS.replace('iframe.src = buildEmbeddedFrameUrl(tab.url);', 'iframe.srcdoc = window.__WWAdminTestFrameDocument?.(tab) || "";')
BROWSER_CSS = (ROOT / 'public/css/admin-browser.css').read_text()
ADMIN_HTML = (ROOT / 'public/admin.html').read_text()
_VIEWPORT_START = ADMIN_HTML.index('  <div class="admin-browser-viewport-bar" id="adminBrowserViewportBar"')
_VIEWPORT_END = ADMIN_HTML.index('  <div class="admin-browser-viewport-help" id="adminBrowserViewportHelp"', _VIEWPORT_START)
VIEWPORT_HTML = ADMIN_HTML[_VIEWPORT_START:_VIEWPORT_END] + ADMIN_HTML[_VIEWPORT_END:ADMIN_HTML.index('  <div class="admin-browser-stage"', _VIEWPORT_END)]

FIXTURE = r'''<!doctype html><html lang="th"><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;min-height:100%;overflow:hidden}__CSS__</style></head><body data-page="admin">
<div id="adminControlSurface"><button id="controlProbe">Control</button></div>
<div id="adminWorkspace"><div class="admin-page-header"></div><div class="admin-page-stack"><div class="tab-panel active"></div></div>
<section id="adminBrowserView" hidden>
  <div id="adminBrowserTabs" class="admin-browser-tabs-bar" role="tablist"></div>
  <div class="admin-browser-toolbar">
    <button id="adminBrowserBackBtn" type="button">‹</button><button id="adminBrowserForwardBtn" type="button">›</button><button id="adminBrowserReloadBtn" type="button">↻</button><button id="adminBrowserHomeBtn" type="button">⌂</button>
    <div class="admin-browser-address-wrap"><span id="adminBrowserPageStatus"></span><input id="adminBrowserAddress" readonly><span id="adminBrowserPageTitle"></span></div>
    <button id="adminBrowserNewTabTopBtn" type="button">+</button>
  </div>
VIEWPORT_HTML
  <div id="adminBrowserStage" class="admin-browser-stage"><div id="adminBrowserEmpty">empty</div></div>
  <div id="adminBrowserNewTabMenu" hidden><button data-new-browser="game" type="button">Game</button><button data-new-browser="admin" type="button">Admin</button><button data-new-browser="tester-host" type="button">Host</button><button data-new-browser="tester-player" type="button">Player</button></div>
</section></div>
<script>
window.WWAdminTesterAuth={getPass:async()=>({token:'signed-test-pass'}),controllerId:()=> 'admin-controller-test'};
window.__WWAdminTestFrameDocument = function(tab){
  const type = String(tab?.type || 'game');
  const page = type === 'tester-host' ? 'host' : (type === 'tester-player' || type === 'bot-player' ? 'player' : 'index');
  const root = page === 'host' ? '<main id="list"></main>' : (page === 'player' ? '<main id="joinCard"></main>' : '<main id="nameField"></main>');
  if (type === 'admin') {
    return '<!doctype html><html><head><meta charset="utf-8"><title>Admin</title></head><body data-page="admin"><main id="adminApp"></main></body></html>';
  }
  const title = page === 'host' ? 'Host' : (page === 'player' ? 'Player' : 'Game');
  const path = page === 'host' ? '/host.html' : (page === 'player' ? '/player.html' : '/index.html');
  return '<!doctype html><html><head><meta charset="utf-8"><title>'+title+'</title></head><body data-page="'+page+'">'+root+'<script>try{history.replaceState({},"","'+path+'");}catch(_){}<\/script></body></html>';
};
</script>
<script>__JS__</script></body></html>'''.replace('__CSS__', BROWSER_CSS).replace('__JS__', BROWSER_JS).replace('VIEWPORT_HTML\n', VIEWPORT_HTML)


def frame_metrics(page):
    return page.evaluate("""() => {
        const f=document.querySelector('[data-browser-frame].active');
        if (!f) return null;
        return {w:Number(f.dataset.viewportWidth),h:Number(f.dataset.viewportHeight),mode:f.dataset.viewportMode,zoom:Number(f.dataset.viewportZoom)};
    }""")


def choose_menu(page, button_id, menu_id, value):
    page.locator(f'#{button_id}').click()
    page.locator(f'#{menu_id} [role=option][data-value=\"{value}\"]').click()


def choose_orientation(page, value):
    page.locator(f'[data-viewport-orientation=\"{value}\"]').click()


def main():
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f"SKIP: {exc}")
            raise SystemExit(77)

        page=browser.new_page(viewport={'width':1280,'height':820})
        page.set_default_timeout(5000)
        errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content(FIXTURE, wait_until='load')
        page.wait_for_function('window.WWAdminBrowser && !window.WWAdminBrowser.state.restoreInFlight')

        assert len(page.context.pages)==1
        assert page.locator('[data-browser-tab]').count()==1
        page.evaluate('window.WWAdminBrowser.showBrowser()')
        assert page.locator('#adminBrowserView').is_visible()
        assert page.locator('#adminControlSurface').is_visible()
        assert page.locator('#adminWorkspace.admin-browser-active').count() == 1
        assert page.locator('#adminBrowserView').evaluate('(el)=>getComputedStyle(el).position') == 'fixed'
        assert page.locator('#adminBrowserView').evaluate('(el)=>el.parentElement?.tagName') == 'BODY'
        assert page.locator('#adminBrowserView').evaluate('(el)=>el.getBoundingClientRect().width') == page.evaluate('innerWidth')
        assert page.locator('#adminBrowserView').evaluate('(el)=>el.getBoundingClientRect().height') == page.evaluate('innerHeight')
        assert page.locator('#adminBrowserView').evaluate('(el)=>getComputedStyle(el).display') == 'flex'
        assert page.locator('#adminBrowserView').evaluate('(el)=>getComputedStyle(el).flexDirection') == 'column'
        assert len(page.context.pages)==1

        # Viewport controls are fully custom UI: no visible native select, checkbox, or number input popup.
        native_visible = page.locator('#adminBrowserViewportBar select:visible, #adminBrowserViewportBar input[type=checkbox]:visible, #adminBrowserViewportBar input[type=number]:visible').count()
        assert native_visible == 0, native_visible
        for control_id in ('adminBrowserViewportModeBtn','adminBrowserViewportPresetBtn','adminBrowserViewportZoomBtn','adminBrowserViewportOrientationGroup'):
            assert page.locator(f'#{control_id}').is_visible(), control_id
        assert page.locator('#adminBrowserViewportLockBtn').count() == 1

        # Keyboard access: Enter opens a custom listbox and Escape closes it while restoring focus.
        mode_btn = page.locator('#adminBrowserViewportModeBtn')
        mode_btn.focus(); page.keyboard.press('Enter'); page.wait_for_timeout(10)
        assert page.locator('#adminBrowserViewportModeMenu').is_visible()
        assert mode_btn.get_attribute('aria-expanded') == 'true'
        page.keyboard.press('Escape'); page.wait_for_timeout(10)
        assert not page.locator('#adminBrowserViewportModeMenu').is_visible()
        assert mode_btn.get_attribute('aria-expanded') == 'false'
        assert page.evaluate('document.activeElement?.id') == 'adminBrowserViewportModeBtn'

        # Only one custom menu may remain open at once; choosing another enabled control replaces the first.
        choose_menu(page, 'adminBrowserViewportModeBtn', 'adminBrowserViewportModeMenu', 'preset')
        page.locator('#adminBrowserViewportPresetBtn').click(); page.wait_for_timeout(10)
        assert page.locator('#adminBrowserViewportPresetMenu').is_visible()
        page.locator('#adminBrowserViewportZoomBtn').click(); page.wait_for_timeout(10)
        assert not page.locator('#adminBrowserViewportPresetMenu').is_visible()
        assert page.locator('#adminBrowserViewportZoomMenu').is_visible()
        # Pointerdown outside the portalled menu closes it without affecting the selected viewport.
        page.locator('#adminBrowserPageTitle').click(); page.wait_for_timeout(10)
        assert not page.locator('#adminBrowserViewportZoomMenu').is_visible()

        # Opening another internal tab also closes any open viewport menu.
        page.locator('#adminBrowserViewportModeBtn').click(); page.wait_for_timeout(10)
        assert page.locator('#adminBrowserViewportModeMenu').is_visible()
        page.evaluate("window.WWAdminBrowser.openTester('host')")
        page.wait_for_function("() => window.WWAdminBrowser.currentTab()?.type === 'tester-host'")
        assert not page.locator('#adminBrowserViewportModeMenu').is_visible()
        temporary_host = page.evaluate('window.WWAdminBrowser.currentTab().id')
        page.evaluate("window.WWAdminBrowser.closeTab(%r)" % temporary_host)
        page.wait_for_timeout(20)

        # Return to the original game tab before the viewport behavior assertions.
        page.evaluate("window.WWAdminBrowser.activateTab(%r)" % page.evaluate('window.WWAdminBrowser.state.tabs[0].id'))
        page.wait_for_timeout(20)

        # Large-display Fit: a smaller logical viewport may be enlarged for presentation
        # so a large monitor is not left mostly empty; CSS viewport dimensions remain exact.
        page.set_viewport_size({'width': 3840, 'height': 2160})
        page.wait_for_timeout(40)
        choose_menu(page, 'adminBrowserViewportModeBtn', 'adminBrowserViewportModeMenu', 'preset')
        choose_menu(page, 'adminBrowserViewportPresetBtn', 'adminBrowserViewportPresetMenu', 'desktop-fhd')
        page.wait_for_timeout(40)
        large_metrics = frame_metrics(page)
        assert large_metrics and large_metrics['w'] == 1920 and large_metrics['h'] == 1080 and large_metrics['zoom'] >= 1.8, large_metrics
        choose_menu(page, 'adminBrowserViewportPresetBtn', 'adminBrowserViewportPresetMenu', 'desktop-4k')
        page.wait_for_timeout(40)
        q4k_metrics = frame_metrics(page)
        assert q4k_metrics and q4k_metrics['w'] == 3840 and q4k_metrics['h'] == 2160 and q4k_metrics['zoom'] < 1.01, q4k_metrics
        page.set_viewport_size({'width': 1280, 'height': 820})
        page.wait_for_timeout(40)
        choose_menu(page, 'adminBrowserViewportModeBtn', 'adminBrowserViewportModeMenu', 'auto')
        page.wait_for_timeout(30)

        # The control surface remains usable across the main responsive widths.
        for width, height in [(1440,900),(1280,720),(1024,768),(820,1180),(768,1024),(696,601),(600,900),(390,844)]:
            page.set_viewport_size({'width':width,'height':height})
            page.wait_for_timeout(30)
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert page.locator('#adminBrowserViewportBar').is_visible()

        # Preset: 1180×682 stays the real iframe viewport; Fit only controls presentation scale.
        choose_menu(page, 'adminBrowserViewportModeBtn', 'adminBrowserViewportModeMenu', 'preset')
        choose_menu(page, 'adminBrowserViewportPresetBtn', 'adminBrowserViewportPresetMenu', 'ipad-diagnostic')
        page.wait_for_timeout(40)
        metrics = frame_metrics(page)
        assert metrics and metrics['w']==1180 and metrics['h']==682 and metrics['mode']=='preset' and 0 < metrics['zoom'] <= 1, metrics
        assert page.locator('#adminBrowserViewportLabel').inner_text().startswith('1180 × 682'), page.locator('#adminBrowserViewportLabel').inner_text()

        # Orientation swaps the logical CSS viewport while preserving the selected preset.
        choose_orientation(page, 'portrait')
        page.wait_for_timeout(30)
        metrics = frame_metrics(page)
        assert metrics and metrics['w']==682 and metrics['h']==1180, metrics

        # Explicit presentation zoom never changes CSS viewport dimensions.
        choose_menu(page, 'adminBrowserViewportZoomBtn', 'adminBrowserViewportZoomMenu', '50')
        page.wait_for_timeout(30)
        metrics = frame_metrics(page)
        assert metrics == {'w':682,'h':1180,'mode':'preset','zoom':0.5}, metrics

        # Custom dimensions + aspect lock.
        choose_menu(page, 'adminBrowserViewportModeBtn', 'adminBrowserViewportModeMenu', 'custom')
        choose_orientation(page, 'auto')
        assert page.locator('#adminBrowserViewportLockBtn').is_visible()
        choose_menu(page, 'adminBrowserViewportZoomBtn', 'adminBrowserViewportZoomMenu', '100')
        page.locator('#adminBrowserViewportWidth').fill('800')
        page.locator('#adminBrowserViewportWidth').dispatch_event('change')
        page.locator('#adminBrowserViewportHeight').fill('600')
        page.locator('#adminBrowserViewportHeight').dispatch_event('change')
        page.wait_for_timeout(30)
        assert frame_metrics(page) == {'w':800,'h':600,'mode':'custom','zoom':1}, frame_metrics(page)
        page.locator('#adminBrowserViewportLockBtn').click()
        page.locator('#adminBrowserViewportWidth').fill('400')
        page.locator('#adminBrowserViewportWidth').dispatch_event('change')
        page.wait_for_timeout(30)
        assert frame_metrics(page) == {'w':400,'h':300,'mode':'custom','zoom':1}, frame_metrics(page)

        # Fit works without mutating the logical viewport dimensions.
        page.locator('#adminBrowserViewportFit').click()
        page.wait_for_timeout(30)
        metrics = frame_metrics(page)
        assert metrics and metrics['w']==400 and metrics['h']==300 and metrics['mode']=='custom' and metrics['zoom'] <= 1, metrics

        # Per-tab viewport values are isolated.
        game_tab = page.evaluate('window.WWAdminBrowser.currentTab().id')
        page.evaluate("window.WWAdminBrowser.openTester('host')")
        page.wait_for_function("() => window.WWAdminBrowser.currentTab()?.type === 'tester-host' && document.querySelector('[data-browser-frame].active')")
        choose_menu(page, 'adminBrowserViewportModeBtn', 'adminBrowserViewportModeMenu', 'preset')
        choose_menu(page, 'adminBrowserViewportPresetBtn', 'adminBrowserViewportPresetMenu', 'mobile')
        page.wait_for_function("() => window.WWAdminBrowser.currentTab()?.viewport?.presetId === 'mobile'")
        page.wait_for_timeout(30)
        host_tab = page.evaluate('window.WWAdminBrowser.currentTab().id')
        assert frame_metrics(page) and frame_metrics(page)['w']==390 and frame_metrics(page)['h']==844
        page.evaluate("window.WWAdminBrowser.openTester('player')")
        page.wait_for_function("() => window.WWAdminBrowser.currentTab()?.type === 'tester-player' && document.querySelector('[data-browser-frame].active') && document.querySelectorAll('[data-browser-tab]').length === window.WWAdminBrowser.state.tabs.length")
        assert page.locator('[data-browser-tab]').count()==3
        assert len(page.context.pages)==1
        state=page.evaluate('window.WWAdminBrowser.state')
        assert [t['type'] for t in state['tabs']] == ['game','tester-host','tester-player']
        assert all('signed-test-pass' not in str(t.get('displayUrl','')) for t in state['tabs'])

        # Admin can itself be opened as a first-class iframe tab, without creating a real browser tab.
        page.evaluate("window.WWAdminBrowser.openAdmin()")
        page.wait_for_function("() => window.WWAdminBrowser.currentTab()?.type === 'admin' && document.querySelector('[data-browser-frame].active')")
        admin_tab = page.evaluate('window.WWAdminBrowser.currentTab()')
        assert admin_tab['type'] == 'admin' and admin_tab['url'].startswith('/admin.html?ww_admin_embed=1'), admin_tab
        assert page.locator('[data-browser-tab]').count()==4
        assert page.locator('[data-browser-frame].active').evaluate("f => f.contentDocument?.body?.dataset.page") == 'admin'
        assert page.locator('[data-browser-frame].active').evaluate("f => Boolean(f.contentDocument?.querySelector('#adminApp'))")
        assert len(page.context.pages)==1

        page.evaluate("window.WWAdminBrowser.activateTab(%r)" % host_tab)
        page.wait_for_timeout(30)
        assert frame_metrics(page) and frame_metrics(page)['w']==390 and frame_metrics(page)['h']==844, frame_metrics(page)
        page.evaluate("window.WWAdminBrowser.activateTab(%r)" % game_tab)
        page.wait_for_timeout(30)
        assert frame_metrics(page) == {'w':400,'h':300,'mode':'custom','zoom':metrics['zoom'] if metrics else 1} or (frame_metrics(page) and frame_metrics(page)['w']==400 and frame_metrics(page)['h']==300), frame_metrics(page)

        # Internal navigation and tab controls must be isolated from the top-level page.
        page.evaluate("window.WWAdminBrowser.openUrl('/player.html?tester=1&am=1&at=direct&ts=direct&tp=pass',{type:'bot-player',title:'Tester Bot',icon:'🤖',persistent:false})")
        page.wait_for_timeout(50)
        assert page.locator('[data-browser-tab]').count()==5
        page.evaluate("window.WWAdminBrowser.activateRelativeTab(-1)")
        assert page.locator('[data-browser-tab].active').count()==1
        page.locator('[data-browser-tab].active').click()
        page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',code:'Tab',ctrlKey:true,bubbles:true,cancelable:true}))")
        page.wait_for_function("() => window.WWAdminBrowser.currentTab()?.type === 'bot-player'")
        page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'w',code:'KeyW',ctrlKey:true,bubbles:true,cancelable:true}))")
        page.wait_for_function("() => document.querySelectorAll('[data-browser-tab]').length === 4")
        assert page.locator('[data-browser-tab]').count()==4
        assert len(page.context.pages)==1

        # Browser can return to the Admin control workspace without removing the sidebar/menu.
        page.evaluate('window.WWAdminBrowser.showAdmin()')
        page.wait_for_timeout(20)
        assert page.locator('#adminControlSurface').is_visible()
        assert not page.locator('#adminWorkspace.admin-browser-active').count()
        assert page.locator('#adminBrowserView').evaluate('(el)=>getComputedStyle(el).position') in ('relative','static')
        assert page.locator('#adminBrowserView').evaluate('(el)=>el.parentElement?.id') == 'adminWorkspace'
        page.keyboard.press('Control+K'); page.wait_for_timeout(20)
        assert not page.locator('#adminBrowserView').is_visible()

        assert not errors, errors
        browser.close()
    print('admin-internal-browser: PASS')


if __name__=='__main__':
    main()
