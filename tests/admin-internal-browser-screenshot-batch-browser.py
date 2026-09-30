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

CAPTURE_HTML = r'''
  <div class="admin-browser-capture-wrap">
    <button id="adminBrowserCaptureBtn" type="button">📷 <span>แคปภาพ</span></button>
    <button id="adminBrowserCaptureMenuBtn" type="button">▾</button>
    <div class="admin-browser-capture-menu" id="adminBrowserCaptureMenu" hidden>
      <div class="admin-browser-capture-mode-grid">
        <button type="button" data-capture-mode="evidence"><strong>Evidence</strong></button>
        <button type="button" data-capture-mode="game"><strong>Game Only</strong></button>
      </div>
      <button type="button" id="adminBrowserCapturePresetAllBtn">เลือกทั้งหมด</button>
      <button type="button" id="adminBrowserCapturePresetClearBtn">ล้าง</button>
      <span id="adminBrowserCapturePresetCount"></span>
      <div id="adminBrowserCapturePresetList"></div>
    </div>
  </div>
'''

RESULT_HTML = r'''
  <div class="admin-browser-capture-result" id="adminBrowserCaptureResult" hidden>
    <div class="admin-browser-capture-result-card">
      <div class="admin-browser-capture-result-head"><div><strong id="adminBrowserCaptureResultTitle">Capture</strong><div id="adminBrowserCaptureMeta"></div></div><button id="adminBrowserCaptureCloseBtn" type="button">x</button></div>
      <div class="admin-browser-capture-result-list" id="adminBrowserCaptureResultList"></div>
      <div class="admin-browser-capture-result-actions"><button id="adminBrowserCaptureSaveBtn" type="button" disabled>Save</button><button id="adminBrowserCaptureGithubBtn" type="button" disabled>GitHub</button><button id="adminBrowserCaptureCloseBtn2" type="button">Close</button></div>
    </div>
  </div>
'''

FIXTURE = BASE_FIXTURE.replace(
    '<div class="admin-browser-toolbar">',
    '<div class="admin-browser-toolbar">' + CAPTURE_HTML,
    1,
).replace(
    '</section></div>\n<script>', RESULT_HTML + '</section></div>\n<script>',
    1,
)


def main():
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f"SKIP: {exc}")
            raise SystemExit(77)

        page = browser.new_page(viewport={'width': 1280, 'height': 820})
        page.set_default_timeout(10000)
        page.set_content(FIXTURE, wait_until='domcontentloaded')
        page.wait_for_function('window.WWAdminBrowser && !window.WWAdminBrowser.state.restoreInFlight')
        page.evaluate('window.WWAdminBrowser.showBrowser()')
        page.wait_for_selector('[data-browser-frame].active', state='attached')
        page.evaluate("window.WWAdminBrowser.currentTab().status='ready'")

        page.evaluate("""() => {
          window.__githubSeen = [];
          window.html2canvas = async function(node, opts){
            const c=document.createElement('canvas');
            c.width=Number(opts.width)||390; c.height=Number(opts.height)||844;
            const ctx=c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
            return c;
          };
          const nativeFetch = window.fetch;
          window.fetch = async function(input, init = {}) {
            const url = typeof input === 'string' ? input : input?.url;
            if (String(url || '').includes('/api/admin/internal-browser/screenshots/github')) {
              const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k,v]) => [String(k).toLowerCase(), String(v)]));
              window.__githubSeen.push({width:h['x-ww-screenshot-width'],height:h['x-ww-screenshot-height'],file:h['x-ww-screenshot-file']});
              return new Response(JSON.stringify({
                ok:true,reused:false,repository:'tanawutmalirum29-ux/werewolf-online',
                imagePath:'screenshots/test.png',metadataPath:'screenshots/test.json',
                imageUrl:'https://github.com/tanawutmalirum29-ux/werewolf-online/blob/main/test.png',
                imageDownloadUrl:'https://raw.githubusercontent.com/tanawutmalirum29-ux/werewolf-online/main/test.png',
                metadataUrl:'https://github.com/tanawutmalirum29-ux/werewolf-online/blob/main/test.json'
              }), {status:200,headers:{'content-type':'application/json'}});
            }
            return nativeFetch(input, init);
          };
        }""")

        # No preset selected: capture the exact current custom viewport, with no viewport mutation.
        page.evaluate("window.WWAdminBrowser.setViewport({mode:'custom',presetId:'custom',width:1110,height:720,zoom:'fit'})")
        page.wait_for_function("() => { const v=window.WWAdminBrowser.getViewport(); return v?.mode==='custom' && v.width===1110 && v.height===720; }")
        assert page.locator('#adminBrowserCapturePresetCount').inner_text() == 'ไม่เลือก = แคปขนาดปัจจุบัน'
        assert page.locator('#adminBrowserCaptureBtn span').inner_text() == 'แคปภาพ'
        page.locator('#adminBrowserCaptureBtn').click()
        page.wait_for_selector('#adminBrowserCaptureResult:not([hidden])')
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch?.items?.[0]?.status === 'ready'")
        current = page.evaluate("() => ({w:window.WWAdminBrowser.state.lastCaptureBatch.items[0].capture.width,h:window.WWAdminBrowser.state.lastCaptureBatch.items[0].capture.height,mode:window.WWAdminBrowser.getViewport().mode})")
        assert current == {'w':1110,'h':720,'mode':'custom'}, current
        assert page.locator('#adminBrowserCapturePreview').count() == 0
        assert page.locator('#adminBrowserCaptureCanvas').count() == 0
        page.locator('#adminBrowserCaptureCloseBtn').click()

        # Select three presets through the real checkbox UI; the visible viewport remains unchanged.
        page.locator('#adminBrowserCaptureMenuBtn').click()
        page.evaluate("""() => {
          for (const id of ['mobile','ipad-diagnostic','desktop-hd']) {
            const input = document.querySelector(`#adminBrowserCapturePresetList input[data-capture-preset][value="${id}"]`);
            if (!input) throw new Error(`missing preset ${id}`);
            input.checked = true;
            input.dispatchEvent(new Event('change', {bubbles:true}));
          }
        }""")
        assert page.locator('#adminBrowserCapturePresetCount').inner_text().startswith('เลือก 3 ขนาด'), page.locator('#adminBrowserCapturePresetCount').inner_text()
        assert page.locator('#adminBrowserCaptureBtn span').inner_text() == 'แคป 3 ขนาด'
        before = page.evaluate("() => window.WWAdminBrowser.getViewport()")
        assert before['width'] == 1110 and before['height'] == 720, before

        page.locator('#adminBrowserCaptureBtn').click()
        page.wait_for_function("() => window.WWAdminBrowser.state.captureInFlight === false")
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch?.items?.length === 3")
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch.items.every(x => x.status === 'ready')")

        batch = page.evaluate("""() => ({
          items: window.WWAdminBrowser.state.lastCaptureBatch.items.map(x => ({w:x.capture.width,h:x.capture.height,status:x.status})),
          viewport: window.WWAdminBrowser.getViewport(),
          button: document.querySelector('#adminBrowserCaptureBtn span')?.textContent,
          previewCount: document.querySelectorAll('#adminBrowserCapturePreview,#adminBrowserCaptureCanvas').length,
          resultRows: document.querySelectorAll('#adminBrowserCaptureResultList .admin-browser-capture-item').length,
          githubDisabled: document.getElementById('adminBrowserCaptureGithubBtn').disabled
        })""")
        assert [(x['w'],x['h']) for x in batch['items']] == [(390,844),(1180,682),(1280,720)], batch
        assert all(x['status'] == 'ready' for x in batch['items']), batch
        assert batch['viewport']['mode'] == 'custom' and batch['viewport']['width'] == 1110 and batch['viewport']['height'] == 720, batch['viewport']
        assert batch['button'] == 'แคป 3 ขนาด', batch['button']
        assert batch['previewCount'] == 0, batch
        assert batch['resultRows'] == 3, batch
        assert batch['githubDisabled'] is False, batch

        page.locator('#adminBrowserCaptureGithubBtn').click()
        page.wait_for_function("() => window.WWAdminBrowser.state.lastCaptureBatch.items.every(x => x.status === 'github-saved')", timeout=10000)
        seen = page.evaluate('window.__githubSeen')
        assert [(int(x['width']),int(x['height'])) for x in seen] == [(390,844),(1180,682),(1280,720)], seen
        assert page.locator('#adminBrowserCaptureGithubBtn').is_disabled()
        assert page.locator('#adminBrowserCaptureResultList .admin-browser-capture-item-done').count() == 3

        # The checklist itself stays selected for the next batch; closing the result never changes it.
        page.locator('#adminBrowserCaptureCloseBtn2').click()
        assert page.locator('#adminBrowserCaptureResult').is_hidden()
        assert page.locator('#adminBrowserCapturePresetCount').inner_text().startswith('เลือก 3 ขนาด')
        assert page.locator('#adminBrowserCaptureBtn span').inner_text() == 'แคป 3 ขนาด'

        browser.close()
    print('admin-internal-browser-screenshot-batch-browser: PASS')


if __name__ == '__main__':
    main()
