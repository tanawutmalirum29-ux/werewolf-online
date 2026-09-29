from pathlib import Path
import runpy
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: Python Playwright unavailable: {exc}')
    raise SystemExit(77)

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
_fixture = runpy.run_path(str(ROOT / 'tests' / 'admin-real-html-browser.py'), run_name='admin_fixture')
MAKE_HTML = _fixture['make_browser_html']

GAME_HTML = '''<!doctype html><html><body data-page="index"><input id="nameField"><script>window.addEventListener('message',()=>{});</script></body></html>'''


def main():
    html = MAKE_HTML()
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f'SKIP: {exc}')
            raise SystemExit(77)
        page = browser.new_page(viewport={'width': 1180, 'height': 682})
        page.set_content(html, wait_until='load')
        page.evaluate("""() => {
          document.body.classList.add('admin-browser-open');
          document.body.dataset.adminSurface = 'browser';
          const grid=document.getElementById('adminControlSurface');
          const ws=document.getElementById('adminWorkspace');
          const view=document.getElementById('adminBrowserView');
          const bar=document.getElementById('adminBrowserViewportBar');
          grid?.classList.add('admin-browser-active');
          ws?.classList.add('admin-browser-active');
          if(view){ view.hidden=false; view.classList.add('is-active'); }
          if(bar) bar.dataset.mode='auto';
          document.getElementById('adminLoginOverlay')?.classList.add('hidden');
        }""")
        page.wait_for_timeout(40)
        page.wait_for_timeout(120)
        data = page.evaluate("""() => {
          const grid=document.getElementById('adminControlSurface');
          const ws=document.getElementById('adminWorkspace');
          const stage=document.getElementById('adminBrowserStage');
          const view=document.getElementById('adminBrowserView');
          const sidebar=document.querySelector('.admin-sidebar');
          const top=document.querySelector('.admin-topbar');
          const bar=document.getElementById('adminBrowserViewportBar');
          const toolbar=document.querySelector('.admin-browser-toolbar');
          const rect=(el)=>{const r=el.getBoundingClientRect();return {w:r.width,h:r.height,top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
          return {
            bodyOpen:document.body.classList.contains('admin-browser-open'),
            gridCols:getComputedStyle(grid).gridTemplateColumns,
            workspace:rect(ws), view:rect(view), stage:rect(stage), sidebar:rect(sidebar), top:rect(top),
            contextPresent:!!document.querySelector('.admin-context-panel'),
            viewportBar:rect(bar), viewportBarPosition:getComputedStyle(bar).position, toolbar:rect(toolbar),
            helpDisplay:getComputedStyle(document.getElementById('adminBrowserViewportHelp')).display,
            dimensionDisplay:getComputedStyle(document.querySelector('.admin-browser-viewport-dimensions')).display,
            mode:document.getElementById('adminBrowserViewportMode').value,
          };
        }""")
        assert data['bodyOpen'], data
        assert data['contextPresent'] is False, data
        assert data['workspace']['w'] > 1080 and data['gridCols'].strip().endswith('px'), data
        assert data['workspace']['w'] > 1080, data
        assert data['stage']['w'] > 1080, data
        assert data['stage']['h'] > 540, data
        assert data['sidebar']['w'] == 0 or data['sidebar']['w'] < 1, data
        assert data['top']['h'] == 0, data
        assert data['viewportBar']['h'] <= 62, data
        assert data['viewportBarPosition'] == 'relative', data
        assert data['stage']['top'] >= data['viewportBar']['bottom'] - 0.5, data
        assert data['toolbar']['h'] <= 46, data
        assert data['view']['h'] >= 680, data
        assert data['stage']['h'] >= 550, data
        assert data['helpDisplay'] == 'none', data
        assert data['dimensionDisplay'] == 'none', data
        assert data['mode'] == 'auto', data

        page.evaluate("() => { document.getElementById('adminBrowserViewportMode').value='custom'; document.getElementById('adminBrowserViewportBar').dataset.mode='custom'; }")
        page.wait_for_timeout(20)
        custom = page.evaluate("""() => ({
          dimDisplay:getComputedStyle(document.querySelector('.admin-browser-viewport-dimensions')).display,
          mode:document.getElementById('adminBrowserViewportMode').value,
          stageWidth:document.getElementById('adminBrowserStage').getBoundingClientRect().width,
          viewportPosition:getComputedStyle(document.getElementById('adminBrowserViewportBar')).position,
          viewportBottom:document.getElementById('adminBrowserViewportBar').getBoundingClientRect().bottom,
          stageTop:document.getElementById('adminBrowserStage').getBoundingClientRect().top,
        })""")
        assert custom['mode'] == 'custom', custom
        assert custom['dimDisplay'] != 'none', custom
        assert custom['stageWidth'] > 1080, custom
        assert custom['viewportPosition'] == 'relative', custom
        assert custom['stageTop'] >= custom['viewportBottom'] - 0.5, custom

        page.evaluate("() => { document.getElementById('adminBrowserViewportMode').value='auto'; document.getElementById('adminBrowserViewportBar').dataset.mode='auto'; }")
        page.wait_for_timeout(20)
        auto = page.evaluate("getComputedStyle(document.querySelector('.admin-browser-viewport-dimensions')).display")
        assert auto == 'none', auto

        browser.close()
    print('admin-browser-focus-layout-regression: PASS')

if __name__ == '__main__':
    main()
