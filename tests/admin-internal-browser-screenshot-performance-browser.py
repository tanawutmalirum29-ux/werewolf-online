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
      <div class="admin-browser-capture-result-actions"><button id="adminBrowserCaptureSaveBtn" type="button">Save</button><button id="adminBrowserCaptureGithubBtn" type="button">GitHub</button><button id="adminBrowserCaptureCloseBtn2" type="button">Close</button></div>
    </div>
  </div>
"""
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
        page.evaluate("window.WWAdminBrowser.currentTab().status='ready'")

        page.evaluate("""() => {
          const frame = document.querySelector('[data-browser-frame].active');
          const child = frame?.contentWindow;
          if (child?.document?.body) {
            const pending = child.document.createElement('img');
            pending.alt = 'intentionally pending capture test image';
            child.document.body.appendChild(pending);
            Object.defineProperty(pending, 'complete', {configurable:true, get(){ return false; }});
            pending.decode = () => new Promise(() => {});
            pending.getBoundingClientRect = () => ({top:10,left:10,right:110,bottom:110,width:100,height:100});
            window.__pendingCaptureImage = pending;
          }
          window.html2canvas = async function(node, opts){
            const c=document.createElement('canvas');
            c.width=Number(opts.width)||390; c.height=Number(opts.height)||844;
            c.getContext('2d').fillRect(0,0,c.width,c.height);
            const nativeToBlob = c.toBlob.bind(c);
            c.toBlob = (callback, type) => {
              window.__pngEncodeStartedAt = performance.now();
              window.setTimeout(() => {
                window.__pngEncodeFinishedAt = performance.now();
                nativeToBlob(callback, type || 'image/png');
              }, 750);
            };
            return c;
          };
        }""")
        page.evaluate("window.WWAdminBrowser.setViewport({mode:'preset',presetId:'mobile',width:390,height:844,zoom:'fit'});")
        page.wait_for_function("() => window.WWAdminBrowser.getViewport()?.presetId === 'mobile'")
        page.wait_for_function("() => { const child=document.querySelector('[data-browser-frame].active')?.contentWindow; return Math.round(child?.innerWidth || 0) === 390 && Math.round(child?.innerHeight || 0) === 844; }")

        page.evaluate("() => { window.__capturePromise = window.WWAdminBrowser.capture('evidence'); }")
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        page.wait_for_function('() => !!window.__pngEncodeStartedAt', timeout=7000)

        # The result shell is visible during PNG preparation, but no canvas or image is mounted.
        pending = page.evaluate("""() => ({
          resultVisible: !document.getElementById('adminBrowserCaptureResult').hidden,
          canvasVisible: !!document.getElementById('adminBrowserCaptureCanvas'),
          previewVisible: !!document.getElementById('adminBrowserCapturePreview'),
          saveDisabled: document.getElementById('adminBrowserCaptureSaveBtn').disabled,
          githubDisabled: document.getElementById('adminBrowserCaptureGithubBtn').disabled,
          pngEncodeStartedAt: window.__pngEncodeStartedAt || 0,
          pngEncodeFinishedAt: window.__pngEncodeFinishedAt || 0,
          timing: window.WWAdminBrowser.getLastCaptureTiming(),
        })""")
        assert pending['resultVisible'], pending
        assert not pending['canvasVisible'], pending
        assert not pending['previewVisible'], pending
        assert pending['saveDisabled'], pending
        assert pending['githubDisabled'], pending
        assert pending['pngEncodeStartedAt'] > 0, pending
        assert pending['pngEncodeFinishedAt'] == 0, pending
        assert pending['timing']['readiness']['pendingImages'] >= 1, pending
        assert pending['timing']['readiness']['imageTimedOut'] is True, pending
        assert pending['timing']['readyMs'] <= 500, pending

        page.wait_for_function("() => !!window.__pngEncodeFinishedAt", timeout=7000)
        page.evaluate("() => window.__capturePromise")
        page.wait_for_function("() => !document.getElementById('adminBrowserCaptureSaveBtn').disabled")
        done = page.evaluate("() => ({ saveDisabled:document.getElementById('adminBrowserCaptureSaveBtn').disabled, githubDisabled:document.getElementById('adminBrowserCaptureGithubBtn').disabled, timing:window.WWAdminBrowser.getLastCaptureTiming() })")
        assert done['saveDisabled'] is False, done
        assert done['githubDisabled'] is False, done
        assert done['timing']['pngEncodeMs'] >= 650, done
        assert done['timing']['totalMs'] >= done['timing']['pngEncodeMs'], done
        assert not errors, errors
        browser.close()
    print('admin-internal-browser-screenshot-performance-browser: PASS')


if __name__ == '__main__':
    main()
