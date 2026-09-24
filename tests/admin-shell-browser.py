from pathlib import Path
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: python Playwright unavailable: {exc}')
    raise SystemExit(77)

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'public' / 'admin.html').read_text()
CSS = (ROOT / 'public' / 'css' / 'admin-shell.css').read_text()
AUTH = (ROOT / 'public' / 'js' / 'admin-auth-tab.js').read_text()
REG = (ROOT / 'public' / 'js' / 'admin-command-registry.js').read_text()
SHELL = (ROOT / 'public' / 'js' / 'admin-shell.js').read_text()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1024, 'height': 720})
        page.on('console', lambda m: print('CONSOLE', m.type, m.text))
        page.on('pageerror', lambda e: print('PAGEERROR', e))
        harness = '''<!doctype html><html><head><style>__CSS__</style></head><body data-page="admin">
<div class="wrap admin-wrap"><section class="admin-hero"><div class="admin-hero-main"><h1>Admin</h1><p class="sub" id="pageSub"></p></div></section><div class="tab-panel active" id="tab-overview"><div id="overviewRecent"></div></div></div>
<nav class="admin-bottom-dock"><button data-admin-nav="overview">overview</button></nav>
<script>
window.wwToast=()=>{};
window.__WW_ADMIN_SHELL_STATUS__={server:'PRECONNECT',rooms:'0 ห้อง',players:'0 online',audit:'0 findings'};
window.__wwAdminSocket={disconnect(){window.__socketDisconnected=true;}};
window.WWAdminTabAuth={clear(){window.__cleared=true;}};
window.refreshDashboard=()=>window.__calls=(window.__calls||[]).concat('refreshDashboard');
window.closeAdminPanel=()=>window.__calls=(window.__calls||[]).concat('closeAdminPanel');
window.switchTab=(x)=>window.__calls=(window.__calls||[]).concat('switchTab:'+x);
window.startBugReplay=(x)=>window.__calls=(window.__calls||[]).concat('startBugReplay:'+x);
window.askForceReload=(x)=>window.__calls=(window.__calls||[]).concat('askForceReload:'+x);
window.askPublishUpdate=()=>window.__calls=(window.__calls||[]).concat('askPublishUpdate');
window.enterTesterMode=()=>window.__calls=(window.__calls||[]).concat('enterTesterMode');
window.pickTesterRole=(x)=>window.__calls=(window.__calls||[]).concat('pickTesterRole:'+x);
window.loadDiagnostics=()=>window.__calls=(window.__calls||[]).concat('loadDiagnostics');
window.clearDiagnostics=()=>window.__calls=(window.__calls||[]).concat('clearDiagnostics');
</script>
<script>__AUTH__</script><script>__REG__</script><script>__SHELL__</script>
</body></html>'''
        harness = harness.replace('__CSS__', CSS).replace('__AUTH__', AUTH).replace('__REG__', REG).replace('__SHELL__', SHELL)
        page.set_content(harness, wait_until='load')
        page.wait_for_timeout(100)
        assert page.locator('#adminShellRoot').count() == 1, 'Admin Shell root missing'
        assert page.locator('#adminShellServerStatus').count() == 1, 'shell status strip missing'
        assert page.locator('#adminShellServerStatus').inner_text() == 'PRECONNECT', 'pending status was not applied during shell initialization'
        page.evaluate("window.WWAdminShell.setStatus({server:'ONLINE',rooms:'2 ห้อง',players:'16 online',audit:'0 findings'})")
        assert page.locator('#adminShellServerStatus').inner_text() == 'ONLINE'
        assert page.locator('#adminShellRoomStatus').inner_text() == '2 ห้อง'
        assert page.locator('#adminShellPlayerStatus').inner_text() == '16 online'
        assert page.locator('#adminShellAuditStatus').inner_text() == '0 findings'
        assert page.locator('#adminGameSurface').count() == 1, 'real Index iframe missing'
        assert page.locator('#adminGameSurface').get_attribute('src') == '/index.html?embedded=admin', 'wrong Index source'
        assert page.locator('.admin-bottom-dock').get_attribute('hidden') == '', 'legacy tab dock should be hidden'

        page.keyboard.press('Control+K')
        assert page.locator('#adminCommandPalette').is_visible(), 'command palette did not open with Ctrl+K'
        page.locator('#adminCommandSearch').fill('reload')
        page.wait_for_timeout(30)
        assert page.locator('[data-command-id="server.reload.both"]').count() == 1, 'reload command missing from search'
        page.locator('[data-command-id="server.reload.both"]').click()
        page.wait_for_timeout(30)
        calls = page.evaluate('window.__calls || []')
        assert 'askForceReload:both' in calls, f'command registry did not dispatch to existing handler: {calls}'

        page.keyboard.press('Control+K')
        page.wait_for_timeout(20)
        # Same-origin context messages are accepted.
        page.evaluate('window.dispatchEvent(new MessageEvent("message",{origin:location.origin,data:{type:"WW_ADMIN_CONTEXT",context:{type:"player",accountId:"a1",name:"Alice",status:"active",roomId:"ABC123"}}}))')
        page.wait_for_timeout(30)
        assert page.locator('.admin-shell-context h3').inner_text() == 'Alice', 'same-origin context message not accepted'

        page.set_viewport_size({'width': 390, 'height': 700})
        page.wait_for_timeout(40)
        display = page.locator('.admin-shell-rail').evaluate('(el)=>getComputedStyle(el).position')
        assert display == 'fixed', f'mobile shell rail should be fixed, got {display}'
        browser.close()
    print('admin-shell-browser: PASS')

if __name__ == '__main__':
    main()
