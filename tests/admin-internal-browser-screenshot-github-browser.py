from pathlib import Path
import sys

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f"SKIP: Python Playwright unavailable: {exc}")
    raise SystemExit(77)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
from browser_harness import launch_chromium
import importlib.util
spec = importlib.util.spec_from_file_location(
    'admin_internal_browser_regression',
    ROOT / 'tests' / 'admin-internal-browser-regression.py',
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
BASE_FIXTURE = mod.FIXTURE

RESULT_HTML = """
  <div class="admin-browser-capture-result" id="adminBrowserCaptureResult" hidden>
    <div class="admin-browser-capture-result-card">
      <div class="admin-browser-capture-result-head"><div><strong id="adminBrowserCaptureResultTitle">Capture</strong><div id="adminBrowserCaptureMeta"></div></div><button id="adminBrowserCaptureCloseBtn" type="button">x</button></div>
      <div class="admin-browser-capture-result-list" id="adminBrowserCaptureResultList"></div>
      <div class="admin-browser-capture-result-actions"><button id="adminBrowserCaptureSaveBtn" type="button" disabled>Save</button><button id="adminBrowserCaptureGithubBtn" type="button" disabled>GitHub</button><button id="adminBrowserCaptureCloseBtn2" type="button">Close</button></div>
    </div>
  </div>
"""
# Reuse the existing Admin Internal Browser regression fixture verbatim and inject
# only the capture result action markup (the production preview image is gone).
FIXTURE = BASE_FIXTURE.replace(
    '</section></div>\n<script>', RESULT_HTML + '</section></div>\n<script>'
)


def main():
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f"SKIP: {exc}")
            raise SystemExit(77)

        page = browser.new_page(viewport={'width': 1280, 'height': 820})
        page.set_default_timeout(7000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content(FIXTURE, wait_until='load')
        page.wait_for_function('window.WWAdminBrowser && !window.WWAdminBrowser.state.restoreInFlight')
        page.evaluate('window.WWAdminBrowser.showBrowser()')
        page.wait_for_selector('[data-browser-frame].active', state='attached')
        page.wait_for_timeout(100)
        # The fixture's child page is synthetic; make it capture-ready without
        # changing production lifecycle behavior.
        page.evaluate("window.WWAdminBrowser.currentTab().status='ready'")

        page.evaluate("""() => {
          window.html2canvas = async function(node, opts){
            const c=document.createElement('canvas');
            c.width=Number(opts.width)||390; c.height=Number(opts.height)||844;
            const ctx=c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
            return c;
          };
          window.__githubScreenshotSeen = null;
          const originalFetch = window.fetch;
          window.fetch = async function(input, init = {}) {
            const url = typeof input === 'string' ? input : input?.url;
            if (String(url || '').includes('/api/admin/internal-browser/screenshots/github')) {
              const body = init?.body;
              window.__githubScreenshotSeen = {
                method: init?.method || 'GET',
                headers: Object.fromEntries(Object.entries(init?.headers || {}).map(([k,v]) => [String(k).toLowerCase(), String(v)])),
                bodySize: Number(body?.size || body?.byteLength || 0),
              };
              return new Response(JSON.stringify({
                ok:true,
                reused:false,
                repository:'tanawutmalirum29-ux/werewolf-bug-reports',
                imagePath:'screenshots/2026/09/26/index/390x844/a.png',
                metadataPath:'screenshots/2026/09/26/index/390x844/a.json',
                imageUrl:'https://github.com/tanawutmalirum29-ux/werewolf-bug-reports/blob/main/a.png',
                imageDownloadUrl:'https://raw.githubusercontent.com/tanawutmalirum29-ux/werewolf-bug-reports/main/a.png',
                metadataUrl:'https://github.com/tanawutmalirum29-ux/werewolf-bug-reports/blob/main/a.json'
              }), {status:200, headers:{'content-type':'application/json'}});
            }
            return originalFetch(input, init);
          };
        }""")

        page.evaluate("window.WWAdminBrowser.setViewport({mode:'preset',presetId:'mobile',width:390,height:844,zoom:'fit'});")
        page.wait_for_function("() => window.WWAdminBrowser.getViewport()?.presetId === 'mobile'")
        page.evaluate("() => window.WWAdminBrowser.capture('evidence')")
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        page.wait_for_function("() => !document.getElementById('adminBrowserCaptureGithubBtn')?.disabled", timeout=7000)

        assert page.locator('#adminBrowserCaptureGithubBtn').is_visible()
        assert page.locator('#adminBrowserCaptureGithubBtn').is_enabled()
        assert page.locator('#adminBrowserCaptureSaveBtn').is_visible()
        meta = page.locator('#adminBrowserCaptureMeta').inner_text()
        assert '390 × 844 CSS px' in meta, meta
        assert 'DPR' in meta, meta
        assert 'Page' in meta, meta

        page.locator('#adminBrowserCaptureGithubBtn').click()
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch?.items?.[0]?.status === 'github-saved'", timeout=7000)
        result_390 = page.evaluate("() => window.WWAdminBrowser.state.lastCaptureGithub")
        assert result_390 and result_390['imageUrl'] == 'https://github.com/tanawutmalirum29-ux/werewolf-bug-reports/blob/main/a.png', result_390
        seen = page.evaluate('window.__githubScreenshotSeen')
        assert seen['method'] == 'POST', seen
        assert seen['headers'].get('content-type','').startswith('image/png'), seen
        assert seen['headers'].get('x-ww-screenshot-width') == '390', seen
        assert seen['headers'].get('x-ww-screenshot-height') == '844', seen
        assert seen['headers'].get('x-ww-screenshot-capture-mode') == 'evidence', seen
        assert float(seen['headers'].get('x-ww-screenshot-dpr','0')) > 0, seen
        assert seen['bodySize'] > 32, seen
        assert 'authorization' not in seen['headers'], seen
        assert page.locator('#adminBrowserCaptureGithubBtn').is_disabled()
        assert page.locator('#adminBrowserCaptureGithubOpenBtn').count() == 0
        assert page.locator('#adminBrowserCapturePreview').count() == 0
        assert page.locator('#adminBrowserCaptureCanvas').count() == 0

        page.locator('#adminBrowserCaptureCloseBtn').click()
        page.evaluate("""() => {
          window.WWAdminBrowser.setViewport({mode:'custom',presetId:'custom',width:1180,height:682,zoom:'fit'});
        }""")
        page.wait_for_function("() => { const v=window.WWAdminBrowser.getViewport(); return v?.mode==='custom' && v.width===1180 && v.height===682; }")
        page.evaluate("() => window.WWAdminBrowser.capture('game')")
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        page.wait_for_function("() => !document.getElementById('adminBrowserCaptureGithubBtn')?.disabled", timeout=7000)
        assert '1180 × 682 CSS px' in page.locator('#adminBrowserCaptureMeta').inner_text()
        assert page.locator('#adminBrowserCaptureGithubBtn').is_visible()
        page.locator('#adminBrowserCaptureGithubBtn').click()
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch?.items?.[0]?.status === 'github-saved'", timeout=7000)
        result_1180 = page.evaluate("() => window.WWAdminBrowser.state.lastCaptureGithub")
        assert result_1180 and result_1180['imageUrl'], result_1180
        seen_1180 = page.evaluate('window.__githubScreenshotSeen')
        assert seen_1180['headers'].get('x-ww-screenshot-width') == '1180', seen_1180
        assert seen_1180['headers'].get('x-ww-screenshot-height') == '682', seen_1180
        assert seen_1180['headers'].get('x-ww-screenshot-viewport-mode') == 'custom', seen_1180
        assert page.locator('#adminBrowserCaptureGithubBtn').is_disabled()

        # Ensure the new control exists only in Admin's capture result, not in
        # the actual player/host source pages.
        admin_html = (ROOT / 'public/admin.html').read_text()
        assert 'adminBrowserCaptureGithubBtn' in admin_html
        for page_name in ('index.html', 'player.html', 'host.html'):
            html = (ROOT / 'public' / page_name).read_text()
            assert 'adminBrowserCaptureGithubBtn' not in html

        assert not errors, errors
        browser.close()
    print('admin-internal-browser-screenshot-github-browser: PASS')


if __name__ == '__main__':
    main()
