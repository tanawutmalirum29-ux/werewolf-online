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
    'admin_internal_browser_screenshot_github_browser',
    ROOT / 'tests' / 'admin-internal-browser-screenshot-github-browser.py',
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
FIXTURE = mod.FIXTURE


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
        page_errors = []
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.set_content(FIXTURE, wait_until='load')
        page.wait_for_function('window.WWAdminBrowser && !window.WWAdminBrowser.state.restoreInFlight')
        page.evaluate('window.WWAdminBrowser.showBrowser()')
        page.wait_for_selector('[data-browser-frame].active', state='attached')
        page.wait_for_timeout(100)
        page.evaluate("window.WWAdminBrowser.currentTab().status='ready'")

        page.evaluate("""() => {
          window.__toastMessages = [];
          window.wwToast = (message) => window.__toastMessages.push(String(message));
          window.__xhrSeen = null;
          window.WWAdminTabAuth = {
            getToken: () => 'TEST_ADMIN_BEARER_TOKEN',
            getTabId: () => '0123456789abcdef0123456789abcdef'
          };
          window.html2canvas = async function(node, opts){
            const c=document.createElement('canvas');
            c.width=Number(opts.width)||390; c.height=Number(opts.height)||844;
            const ctx=c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
            return c;
          };
          window.__NativeFetch = window.fetch.bind(window);
          window.XMLHttpRequest = class FakeXHR {
            constructor(){ this.headers={}; this.status=0; this.responseText=''; this.responseURL=''; this.responseType=''; this.timeout=0; }
            open(method, url){ this.method=method; this.url=url; }
            setRequestHeader(k,v){ this.headers[String(k).toLowerCase()] = String(v); }
            send(body){
              window.__xhrSeen = {method:this.method, url:this.url, headers:{...this.headers}, bodySize:Number(body?.size||0)};
              this.status=200;
              this.responseText=JSON.stringify({
                ok:true,
                reused:false,
                repository:'tanawutmalirum29-ux/werewolf-bug-reports',
                imagePath:'screenshots/2026/09/26/index/390x844/fallback.png',
                metadataPath:'screenshots/2026/09/26/index/390x844/fallback.json',
                imageUrl:'https://github.com/tanawutmalirum29-ux/werewolf-bug-reports/blob/main/fallback.png',
                imageDownloadUrl:'https://raw.githubusercontent.com/tanawutmalirum29-ux/werewolf-bug-reports/main/fallback.png',
                metadataUrl:'https://github.com/tanawutmalirum29-ux/werewolf-bug-reports/blob/main/fallback.json'
              });
              queueMicrotask(() => this.onload?.());
            }
            abort(){ this.onabort?.(); }
          };
        }""")

        # Reproduce the iOS/WebKit TypeError path only for the screenshot endpoint.
        page.evaluate("() => { const nativeFetch=window.__NativeFetch; window.fetch = async function(input, init = {}) { const url=typeof input==='string'?input:input?.url; if(String(url||'').includes('/api/admin/internal-browser/screenshots/github')) throw new TypeError('Load failed'); return nativeFetch(input, init); }; }")

        page.evaluate("window.WWAdminBrowser.setViewport({mode:'preset',presetId:'mobile',width:390,height:844,zoom:'fit'});")
        page.wait_for_function("() => window.WWAdminBrowser.getViewport()?.presetId === 'mobile'")
        page.evaluate("() => window.WWAdminBrowser.capture('evidence')")
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        page.wait_for_function("() => !document.getElementById('adminBrowserCaptureGithubBtn')?.disabled", timeout=7000)

        page.locator('#adminBrowserCaptureGithubBtn').click()
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch?.items?.[0]?.status === 'github-saved'", timeout=7000)
        result = page.evaluate("() => window.WWAdminBrowser.state.lastCaptureGithub")
        assert result and result['imageUrl'].endswith('/fallback.png'), result
        seen = page.evaluate('window.__xhrSeen')
        assert seen['method'] == 'POST', seen
        assert seen['url'].endswith('/api/admin/internal-browser/screenshots/github'), seen
        assert seen['headers'].get('authorization') == 'Bearer TEST_ADMIN_BEARER_TOKEN', seen
        assert seen['headers'].get('x-ww-admin-tab-id') == '0123456789abcdef0123456789abcdef', seen
        assert seen['headers'].get('content-type','').startswith('image/png'), seen
        assert seen['headers'].get('x-ww-screenshot-width') == '390', seen
        assert seen['headers'].get('x-ww-screenshot-height') == '844', seen
        assert seen['bodySize'] > 32, seen
        assert page.locator('#adminBrowserCaptureGithubBtn').is_disabled()

        # A real 401 from the fallback must be converted into a contained UI error,
        # not an unhandled Promise rejection that creates a second diagnostic Issue.
        page.evaluate("""() => {
          window.__xhrSeen = null;
          window.XMLHttpRequest = class RejectingXHR {
            constructor(){ this.headers={}; this.status=0; this.responseText=''; this.responseType=''; }
            open(method,url){ this.method=method; this.url=url; }
            setRequestHeader(k,v){ this.headers[String(k).toLowerCase()] = String(v); }
            send(body){
              window.__xhrSeen={method:this.method,url:this.url,headers:{...this.headers},bodySize:Number(body?.size||0)};
              this.status=401;
              this.responseText=JSON.stringify({ok:false,error:'admin_auth_required',code:'ADMIN_AUTH_REQUIRED',message:'admin auth required'});
              queueMicrotask(() => this.onload?.());
            }
          };
        }""")
        page.evaluate("window.WWAdminBrowser.getLastCapture()")
        # Start a fresh capture so the retry button is available after a 401.
        page.locator('#adminBrowserCaptureCloseBtn').click()
        page.evaluate("window.WWAdminBrowser.capture('evidence')")
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        page.wait_for_function("() => !document.getElementById('adminBrowserCaptureGithubBtn')?.disabled", timeout=7000)
        page.locator('#adminBrowserCaptureGithubBtn').click()
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch?.items?.[0]?.status === 'ready'", timeout=7000)
        result2 = page.evaluate("() => window.WWAdminBrowser.state.lastCaptureGithub")
        assert result2 is None
        toasts = page.evaluate('window.__toastMessages')
        assert any('เซสชัน Admin หมดอายุหรือไม่ถูกส่งไปกับคำขอ' in m for m in toasts), toasts
        assert not page_errors, page_errors

        browser.close()
    print('admin-internal-browser-screenshot-auth-fallback-browser: PASS')


if __name__ == '__main__':
    main()
