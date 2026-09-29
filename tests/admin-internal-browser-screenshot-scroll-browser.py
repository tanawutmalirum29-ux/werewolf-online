from pathlib import Path
import sys

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f"SKIP: Python Playwright unavailable: {exc}")
    raise SystemExit(77)

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
import importlib.util
spec = importlib.util.spec_from_file_location('admin_internal_browser_regression', ROOT / 'tests' / 'admin-internal-browser-regression.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

RESULT_HTML = """
  <div class="admin-browser-capture-result" id="adminBrowserCaptureResult" hidden>
    <div class="admin-browser-capture-result-card">
      <div class="admin-browser-capture-result-head"><div><strong id="adminBrowserCaptureResultTitle">Capture</strong><div id="adminBrowserCaptureMeta"></div></div><button id="adminBrowserCaptureCloseBtn" type="button">x</button></div>
      <div class="admin-browser-capture-result-list" id="adminBrowserCaptureResultList"></div>
      <div class="admin-browser-capture-result-actions"><button id="adminBrowserCaptureSaveBtn" type="button">Save</button><button id="adminBrowserCaptureGithubBtn" type="button">GitHub</button><button id="adminBrowserCaptureCloseBtn2" type="button">Close</button></div>
    </div>
  </div>
"""
FIXTURE = mod.FIXTURE.replace('</section></div>\n<script>', RESULT_HTML + '</section></div>\n<script>')


def main():
    with sync_playwright() as p:
        try:
            browser = mod.launch_chromium(p)
        except RuntimeError as exc:
            print(f"SKIP: {exc}")
            raise SystemExit(77)

        page = browser.new_page(viewport={'width': 1280, 'height': 820})
        page.set_default_timeout(7000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content(FIXTURE, wait_until='domcontentloaded')
        page.wait_for_function('window.WWAdminBrowser && !window.WWAdminBrowser.state.restoreInFlight')
        page.evaluate('window.WWAdminBrowser.showBrowser()')
        page.wait_for_selector('[data-browser-frame].active', state='attached')
        page.wait_for_timeout(100)
        page.evaluate("window.WWAdminBrowser.currentTab().status='ready'")

        page.evaluate("""() => {
          const frame = document.querySelector('[data-browser-frame].active');
          const child = frame?.contentWindow;
          if (!child?.document?.body) throw new Error('capture child not ready');
          const doc = child.document;
          doc.documentElement.style.height = '2400px';
          doc.documentElement.style.overflow = 'auto';
          doc.body.style.minHeight = '2400px';
          doc.body.style.margin = '0';
          doc.body.innerHTML = `
            <div style="height:1200px; padding-top:20px; box-sizing:border-box;">
              <div id="app" style="height:600px; overflow:auto; border:1px solid transparent;">
                <div style="height:1400px; padding-top:700px; box-sizing:border-box;">
                  <div id="nested" style="height:220px; overflow:auto; border:1px solid transparent;">
                    <div style="height:900px; padding-top:450px; box-sizing:border-box;"><span id="deep">deep</span></div>
                  </div>
                </div>
              </div>
            </div>`;
          const app = doc.getElementById('app');
          const nested = doc.getElementById('nested');
          child.scrollTo(0, 240);
          app.scrollTop = 480;
          nested.scrollTop = 120;
          window.__captureScrollProbe = {
            before:{windowX:child.scrollX,windowY:child.scrollY,app:app.scrollTop,nested:nested.scrollTop},
            options:null,
            clone:null,
            markersAfter:null,
          };
          window.html2canvas = async function(node, opts) {
            window.__captureScrollProbe.options = {scrollX:opts.scrollX, scrollY:opts.scrollY, x:opts.x, y:opts.y, width:opts.width, height:opts.height, windowWidth:opts.windowWidth, windowHeight:opts.windowHeight};
            const cloneFrame = document.createElement('iframe');
            cloneFrame.setAttribute('aria-hidden', 'true');
            cloneFrame.style.position = 'fixed';
            cloneFrame.style.left = '-10000px';
            cloneFrame.style.top = '0';
            cloneFrame.style.width = `${opts.width || 390}px`;
            cloneFrame.style.height = `${opts.height || 844}px`;
            document.body.appendChild(cloneFrame);
            const clonedDocument = cloneFrame.contentDocument;
            clonedDocument.open();
            clonedDocument.write('<!doctype html>'+node.ownerDocument.documentElement.outerHTML);
            clonedDocument.close();
            if (typeof opts.onclone === 'function') opts.onclone(clonedDocument);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const cloneApp = clonedDocument.getElementById('app');
            const cloneNested = clonedDocument.getElementById('nested');
            window.__captureScrollProbe.clone = {
              app: cloneApp?.scrollTop || 0,
              nested: cloneNested?.scrollTop || 0,
              rootHeight: clonedDocument.documentElement?.style.height || '',
              bodyMinHeight: clonedDocument.body?.style.minHeight || '',
              bodyWidth: clonedDocument.body?.style.width || '',
              badgeCount: clonedDocument.querySelectorAll('[data-capture-hide]').length,
            };
            window.__captureScrollProbe.markersDuring = node.ownerDocument.querySelectorAll('[data-ww-capture-scroll-id]').length;
            cloneFrame.remove();
            const canvas=document.createElement('canvas');
            canvas.width=Number(opts.width)||390;
            canvas.height=Number(opts.height)||844;
            return canvas;
          };
        }""")

        page.evaluate("window.WWAdminBrowser.setViewport({mode:'preset',presetId:'mobile',width:390,height:844,zoom:'fit'})")
        page.wait_for_function("() => window.WWAdminBrowser.getViewport()?.presetId === 'mobile'")
        page.wait_for_function("() => { const child=document.querySelector('[data-browser-frame].active')?.contentWindow; return Math.round(child?.innerWidth || 0) === 390 && Math.round(child?.innerHeight || 0) === 844; }")
        page.evaluate("window.WWAdminBrowser.capture('evidence')")
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        probe = page.evaluate('window.__captureScrollProbe')

        assert probe['before']['windowY'] >= 200, probe
        assert probe['before']['app'] == 480, probe
        assert probe['before']['nested'] == 120, probe
        assert probe['options']['scrollX'] == probe['before']['windowX'], probe
        assert probe['options']['scrollY'] == probe['before']['windowY'], probe
        assert (probe['options']['x'] or 0) == 0, probe
        assert (probe['options']['y'] or 0) == 0, probe
        assert probe['options']['width'] == 390, probe
        assert probe['options']['height'] == 844, probe
        assert probe['clone']['app'] == 480, probe
        assert probe['clone']['nested'] == 120, probe
        assert probe['clone']['rootHeight'] == '2400px', probe
        assert probe['clone']['bodyMinHeight'] == '2400px', probe
        assert probe['clone']['bodyWidth'] == '', probe
        assert probe['clone']['badgeCount'] == 0, probe
        assert probe['markersDuring'] == 3, probe

        after = page.evaluate("""() => {
          const child=document.querySelector('[data-browser-frame].active')?.contentWindow;
          const doc=child?.document;
          return {
            windowY:child?.scrollY,
            app:doc?.getElementById('app')?.scrollTop,
            nested:doc?.getElementById('nested')?.scrollTop,
            markerCount:doc?.querySelectorAll('[data-ww-capture-scroll-id]').length,
          };
        }""")
        assert after['windowY'] == probe['before']['windowY'], after
        assert after['app'] == probe['before']['app'], after
        assert after['nested'] == probe['before']['nested'], after
        assert after['markerCount'] == 0, after

        # Auto mode must capture the viewport that is actually visible in the iframe.
        # This is the regression for the original symptom: scrolling the live page must
        # not silently snap the capture back to a preset-sized/top-of-page render.
        page.evaluate("window.WWAdminBrowser.setViewport({mode:'auto',presetId:'auto',width:0,height:0,zoom:'100'})")
        page.wait_for_function("() => window.WWAdminBrowser.getViewport()?.mode === 'auto'")
        page.wait_for_function("() => { const child=document.querySelector('[data-browser-frame].active')?.contentWindow; return Math.round(child?.innerWidth || 0) === 1280 && Math.round(child?.innerHeight || 0) === 699; }")
        page.evaluate("window.WWAdminBrowser.capture('evidence')")
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch?.items?.[0]?.status === 'ready'")
        auto_probe = page.evaluate('window.__captureScrollProbe')
        assert auto_probe['before']['windowY'] >= 200, auto_probe
        assert auto_probe['before']['app'] == 480, auto_probe
        assert auto_probe['before']['nested'] == 120, auto_probe
        assert auto_probe['options']['width'] == 1280, auto_probe
        assert auto_probe['options']['height'] == 699, auto_probe
        assert auto_probe['options']['windowWidth'] == 1280, auto_probe
        assert auto_probe['options']['windowHeight'] == 699, auto_probe
        assert auto_probe['options']['scrollY'] == auto_probe['before']['windowY'], auto_probe
        assert auto_probe['clone']['app'] == 480, auto_probe
        assert auto_probe['clone']['nested'] == 120, auto_probe
        assert auto_probe['clone']['rootHeight'] == '2400px', auto_probe
        assert auto_probe['clone']['badgeCount'] == 0, auto_probe
        assert not errors, errors
        browser.close()
    print('admin-internal-browser-screenshot-scroll-browser: PASS')


if __name__ == '__main__':
    main()
