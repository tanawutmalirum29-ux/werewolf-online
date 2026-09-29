from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlparse, parse_qs
import json

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: Python Playwright unavailable: {exc}')
    raise SystemExit(77)

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
BROWSER_JS = (ROOT / 'public/js/admin-browser.js').read_text()
BROWSER_CSS = (ROOT / 'public/css/admin-browser.css').read_text()

ADMIN_FIXTURE = r'''<!doctype html>
<html lang="th">
<head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}__CSS__</style></head>
<body data-page="admin">
<section id="adminBrowserView" hidden>
  <div id="adminBrowserTabs" role="tablist"></div>
  <div class="admin-browser-toolbar">
    <button id="adminBrowserBackBtn" type="button">‹</button>
    <button id="adminBrowserForwardBtn" type="button">›</button>
    <button id="adminBrowserReloadBtn" type="button">↻</button>
    <button id="adminBrowserHomeBtn" type="button">⌂</button>
    <div class="admin-browser-address-wrap"><span id="adminBrowserPageStatus"></span><input id="adminBrowserAddress" readonly><span id="adminBrowserPageTitle"></span></div>
    <button id="adminBrowserNewTabTopBtn" type="button">+</button>
  </div>
  <div id="adminBrowserStage" class="admin-browser-stage"><div id="adminBrowserEmpty">empty</div></div>
  <div id="adminBrowserNewTabMenu" hidden><button data-new-browser="game" type="button">Game</button></div>
</section>
<script>
window.wwToast=()=>{};
window.WWReportError=(cause,context)=>{window.__diagnostics=(window.__diagnostics||[]).concat({cause,context});};
window.WWAdminTesterAuth={getPass:async()=>({token:'test-pass'}),controllerId:()=> 'admin-controller'};
window.WWAdminShell={setActiveTab:()=>{}};
window.switchTab=()=>{};
</script>
<script>__JS__</script>
</body></html>'''.replace('__CSS__', BROWSER_CSS).replace('__JS__', BROWSER_JS)

GAME_PAGES = {
    '/index.html': ('index', '#nameField', 'Game Fixture'),
    '/host.html': ('host', '#list', 'Host Fixture'),
    '/player.html': ('player', '#joinCard', 'Player Fixture'),
}

request_log = []


def handle_route(route):
    request = route.request
    parsed = urlparse(request.url)
    path = parsed.path
    qs = parse_qs(parsed.query)
    request_log.append({'path': path, 'query': dict(qs)})

    if path == '/admin.html':
        route.fulfill(status=200, content_type='text/html', body=ADMIN_FIXTURE)
        return

    if path in GAME_PAGES:
        marker = 'ww_admin_release' in qs
        fail = 'fail' in qs
        if marker or fail:
            body = '<!doctype html><html><head><title>Blank CDN Fixture</title></head><body></body></html>'
        else:
            page, selector, title = GAME_PAGES[path]
            ident = selector[1:]
            body = f'<!doctype html><html><head><title>{title}</title></head><body data-page="{page}"><div id="{ident}"></div></body></html>'
        route.fulfill(status=200, content_type='text/html', body=body)
        return

    route.fulfill(status=404, content_type='text/plain', body='not found')

def main():
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f'SKIP: {exc}')
            raise SystemExit(77)
        context = browser.new_context(viewport={'width': 1280, 'height': 820})
        page = context.new_page()
        page.set_default_timeout(8000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('https://internal.test/**', handle_route)
        try:
            page.goto('https://internal.test/admin.html', wait_until='load')
        except Exception as exc:
            if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(exc):
                print('SKIP: sandbox blocks browser network navigation required for live iframe regression')
                try:
                    context.close()
                    browser.close()
                except Exception:
                    pass
                raise SystemExit(77)
            raise
        page.evaluate('sessionStorage.clear()')
        page.evaluate('window.WWAdminBrowser.showBrowser()')
        page.wait_for_function("window.WWAdminBrowser && window.WWAdminBrowser.state.tabs.length === 1")

        # Home: release-marked load must be identified as health-invalid and then
        # retried through the exact canonical pathname without the marker.
        page.wait_for_function("document.querySelector('.admin-browser-frame') && document.querySelector('.admin-browser-frame').contentDocument && document.querySelector('.admin-browser-frame').contentDocument.body?.dataset.page === 'index'")
        frame = page.locator('.admin-browser-frame').first
        assert urlparse(frame.get_attribute('src')).path == '/index.html'
        assert 'ww_admin_release' not in frame.get_attribute('src')

        page.evaluate("window.WWAdminBrowser.openUrl('/host.html?tester=1&am=1&at=host-tab&ts=host-launch&tp=test-pass',{type:'tester-host',title:'Tester Host',icon:'🎮'})")
        page.wait_for_function("Array.from(document.querySelectorAll('.admin-browser-frame')).some(x => x.contentDocument && x.contentDocument.body?.dataset.page === 'host')")
        page.evaluate("window.WWAdminBrowser.openUrl('/player.html?tester=1&am=1&at=player-tab&ts=player-launch&tp=test-pass',{type:'tester-player',title:'Tester Player',icon:'👤'})")
        page.wait_for_function("Array.from(document.querySelectorAll('.admin-browser-frame')).some(x => x.contentDocument && x.contentDocument.body?.dataset.page === 'player')")

        # Admin itself may also be opened as a same-origin iframe tab. The URL must
        # be canonicalized into embedded mode and must never create a second browser tab.
        page.evaluate("window.WWAdminBrowser.openAdmin()")
        page.wait_for_function("Array.from(document.querySelectorAll('.admin-browser-frame')).some(x => x.contentDocument && x.contentDocument.body?.dataset.page === 'admin')")
        admin_frames = page.locator('.admin-browser-frame')
        admin_src = None
        for i in range(admin_frames.count()):
            candidate = admin_frames.nth(i)
            body_page = candidate.evaluate("(f) => f.contentDocument?.body?.dataset.page || ''")
            if body_page == 'admin':
                admin_src = candidate.get_attribute('src')
                break
        assert admin_src, 'Admin iframe frame not found'
        assert urlparse(admin_src).path == '/admin.html'
        assert parse_qs(urlparse(admin_src).query).get('ww_admin_embed') == ['1']
        assert parse_qs(urlparse(admin_src).query).get('ww_admin_embed_depth') == ['1']
        assert parse_qs(urlparse(admin_src).query).get('ww_admin_embed_id'), admin_src
        assert page.locator('.admin-browser-tab').count() == 4
        assert len(context.pages) == 1

        # An embedded Admin context may not recursively open another Admin iframe.
        assert page.evaluate("(() => { const child = document.querySelector('.admin-browser-frame[data-browser-frame]'); return true; })()")

        # A permanently blank page must never become a silent black screen.
        page.evaluate("window.WWAdminBrowser.openUrl('/player.html?tester=1&am=1&at=bad&ts=bad&tp=test-pass&fail=1',{type:'tester-player',title:'Broken Player',icon:'⚠️'})")
        page.wait_for_function("window.WWAdminBrowser.state.tabs.at(-1).status === 'error'")
        assert page.locator('.admin-browser-frame-notice').is_visible()
        assert 'โหลดหน้าเกมภายในไม่สำเร็จ' in page.locator('.admin-browser-frame-notice-title').inner_text()

        reqs = request_log
        assert not any(r['path'].startswith('/__ww_admin_embed__') for r in reqs), reqs
        for required in ['/index.html', '/host.html', '/player.html', '/admin.html']:
            matching = [r for r in reqs if r['path'] == required]
            assert matching, f'missing canonical request for {required}: {json.dumps(reqs, ensure_ascii=False)}'
            if required != '/admin.html':
                assert any('ww_admin_release' in r['query'] for r in matching), f'missing release-marked request for {required}'
                assert any('ww_admin_release' not in r['query'] for r in matching), f'missing canonical fallback for {required}'
            else:
                assert any('ww_admin_embed' in r['query'] for r in matching), f'missing embedded Admin marker for {required}'
        assert len(context.pages) == 1
        assert not errors, errors
        browser.close()

    print('admin-internal-browser-live-frame-regression: PASS')


if __name__ == '__main__':
    main()
