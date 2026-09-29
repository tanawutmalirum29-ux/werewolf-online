from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
SHELL_CSS = (ROOT / 'public/css/admin-shell.css').read_text()
BROWSER_CSS = (ROOT / 'public/css/admin-browser.css').read_text()
ADMIN_HTML = (ROOT / 'public/admin.html').read_text()
VIEWPORT_START = ADMIN_HTML.index('  <div class="admin-browser-viewport-bar" id="adminBrowserViewportBar"')
VIEWPORT_END = ADMIN_HTML.index('  <div class="admin-browser-viewport-help" id="adminBrowserViewportHelp"', VIEWPORT_START)
VIEWPORT_HTML = ADMIN_HTML[VIEWPORT_START:VIEWPORT_END]

HTML = f'''<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>{SHELL_CSS}\n{BROWSER_CSS}</style>
<body data-page="admin">
<div class="admin-app-shell">
  <header class="admin-topbar"><div class="admin-brand"><div class="admin-brand-mark">🐺</div></div></header>
  <div class="admin-layout-grid">
    <aside class="admin-sidebar"><nav class="admin-sidebar-nav">
      <button class="admin-nav-item">ภาพรวม</button><button class="admin-nav-item">ผู้เล่น</button><button class="admin-nav-item">ออนไลน์</button>
    </nav></aside>
    <main class="admin-workspace" id="adminWorkspace">
      <section class="admin-browser-view is-active" id="adminBrowserView">
        <div class="admin-browser-tabs-bar"><button class="admin-browser-tab active">Game</button><button class="admin-browser-newtab">+</button></div>
        <div class="admin-browser-toolbar">
          <button class="admin-browser-tool-btn admin-browser-exit-btn">↩</button><button class="admin-browser-tool-btn">‹</button><button class="admin-browser-tool-btn">›</button><button class="admin-browser-tool-btn">↻</button>
          <div class="admin-browser-address-wrap"><span class="admin-browser-page-status"></span><input class="admin-browser-address" value="/index.html"><span class="admin-browser-page-title">Game</span></div>
          <button class="admin-browser-tool-btn">+</button>
        </div>
        <div class="admin-browser-viewport-bar"><div class="admin-browser-viewport-group admin-browser-viewport-mode-group"><select class="admin-browser-viewport-select"><option>Auto</option></select></div><div class="admin-browser-viewport-group"><select class="admin-browser-viewport-select"><option>iPad Diagnostic</option></select></div><div class="admin-browser-viewport-group"><select class="admin-browser-viewport-select"><option>100%</option></select></div></div>
        <div class="admin-browser-stage"><div style="width:100%;height:100%;display:grid;place-items:center;color:white;font:22px sans-serif">CANVAS</div></div>
      </section>
    </main>
  </div>
</div>
'''


def metrics(page):
    return page.evaluate('''() => {
      const box = s => { const e=document.querySelector(s); if(!e)return null; const r=e.getBoundingClientRect(), c=getComputedStyle(e); return {display:c.display,position:c.position,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,parentTag:e.parentElement?.tagName || '',parentId:e.parentElement?.id || ''}; };
      return {
        inner:[innerWidth,innerHeight],
        coarse:matchMedia('(pointer:coarse)').matches,
        sidebar:box('.admin-sidebar'), topbar:box('.admin-topbar'),
        view:box('#adminBrowserView'), tabs:box('.admin-browser-tabs-bar'), toolbar:box('.admin-browser-toolbar'),
        stage:box('.admin-browser-stage'), viewport:box('.admin-browser-viewport-bar'),
        hasFallback:CSS.supports('selector(body:has(#adminBrowserView.is-active))')
      };
    }''')


def assert_full(m):
    assert m['inner'] == [1180,682], m
    assert m['coarse'] is True, m
    assert m['hasFallback'] is True, m
    assert m['sidebar']['display'] == 'none', m
    assert m['topbar']['display'] == 'none', m
    assert m['view']['position'] == 'fixed', m
    assert abs(m['view']['width']-1180) < 0.5 and abs(m['view']['height']-682) < 0.5, m
    assert m['stage']['width'] >= 1179 and m['stage']['height'] >= 540, m
    assert m['tabs']['height'] == 30, m
    assert m['toolbar']['height'] == 34, m
    assert m['stage']['top'] >= m['viewport']['bottom'] - 0.5, m
    assert m['stage']['bottom'] == 682, m
    assert m['viewport']['position'] == 'relative', m
    assert abs(m['viewport']['left']) < 0.5 and abs(m['viewport']['right']-1180) < 0.5, m
    assert m['viewport']['top'] >= 64, m


def main():
    with sync_playwright() as p:
        browser = launch_chromium(p)
        ua='Mozilla/5.0 (iPad; CPU OS 26_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/152.0.7977.40 Mobile/15E148 Safari/604.1'
        ctx = browser.new_context(
            viewport={'width':1180,'height':682}, screen={'width':1180,'height':682},
            device_scale_factor=2, is_mobile=True, has_touch=True, user_agent=ua
        )
        page = ctx.new_page()
        page.set_content(HTML, wait_until='load')
        # Deliberately omit admin-browser-open: this is the WebKit/iPad fallback path.
        m = metrics(page)
        assert_full(m)
        # Real Admin markup must expose custom CSS controls instead of native popup controls.
        assert '<select' not in VIEWPORT_HTML
        assert 'input id="adminBrowserViewportLock" type="checkbox" hidden' in VIEWPORT_HTML
        assert 'role="switch"' in VIEWPORT_HTML
        for custom_id in ('adminBrowserViewportModeMenu','adminBrowserViewportPresetMenu','adminBrowserViewportZoomMenu','adminBrowserViewportOrientationGroup'):
            assert f'id="{custom_id}"' in VIEWPORT_HTML, custom_id
        page.screenshot(path='/mnt/data/admin-ipad-browser-focus-regression-1180x682.png', full_page=False)

        # Rotation-sized tablet view must retain full width and keep the shell hidden.
        page.set_viewport_size({'width':820,'height':1180})
        m2 = metrics(page)
        assert m2['sidebar']['display'] == 'none', m2
        assert abs(m2['view']['width']-820) < .5 and abs(m2['view']['height']-1180) < .5, m2

        ctx.close(); browser.close()
    print('admin-ipad-browser-focus-regression: PASS')


if __name__ == '__main__':
    main()
