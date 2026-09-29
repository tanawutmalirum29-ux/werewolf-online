from pathlib import Path
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: Python Playwright unavailable: {exc}')
    raise SystemExit(77)

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / 'public' / 'css' / 'admin-shell.css').read_text()
AUTH = (ROOT / 'public' / 'js' / 'admin-auth-tab.js').read_text()
REG = (ROOT / 'public' / 'js' / 'admin-command-registry.js').read_text()
SHELL = (ROOT / 'public' / 'js' / 'admin-shell.js').read_text()


def main():
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f"SKIP: {exc}")
            raise SystemExit(77)
        page = browser.new_page(viewport={'width': 1024, 'height': 720})
        page.on('console', lambda m: print('CONSOLE', m.type, m.text))
        page.on('pageerror', lambda e: print('PAGEERROR', e))
        harness = '''<!doctype html><html><head><style>__CSS__</style></head><body data-page="admin">
<div class="wrap admin-wrap"><div class="admin-app-shell" id="adminApp">
<header class="admin-topbar"><button id="adminShellCommandBtn">command</button><div class="admin-account-wrap"><button id="adminAccountTrigger" aria-expanded="false" type="button">Admin</button><div id="adminAccountMenu" class="admin-account-menu hidden"><button data-account-menu-command="session.logout" type="button">logout</button></div></div>
<div class="admin-live-status"><b id="adminShellServerStatus">—</b><b id="adminShellRoomStatus">—</b><b id="adminShellPlayerStatus">—</b><b id="adminShellAuditStatus">—</b></div>
</header>
<div class="admin-layout-grid">
<aside class="admin-sidebar"><nav class="admin-sidebar-nav">
<button data-admin-nav="overview">overview</button><button data-admin-nav="all">players</button><button data-admin-nav="live">live</button><button data-admin-nav="rooms">rooms</button><button data-admin-nav="tools">tools</button><button data-admin-nav="versions">versions</button><button data-admin-nav="diagnostics">diagnostics</button><button data-admin-nav="browser">browser</button>
</nav><button data-shell-command="dashboard.refresh">refresh</button></aside>
<main id="adminWorkspace"><button data-shell-refresh-current type="button">current refresh</button></main>

</div></div></div>
<script>
window.wwToast=()=>{};
window.__WW_ADMIN_SHELL_STATUS__={server:'PRECONNECT',rooms:'0 ห้อง',players:'0 online',audit:'0 findings'};
window.__wwAdminSocket={disconnect(){window.__socketDisconnected=true;}};
window.WWAdminTabAuth={clear(){window.__cleared=true;}};
window.refreshDashboard=()=>window.__calls=(window.__calls||[]).concat('refreshDashboard');
window.loadAllPlayers=()=>window.__calls=(window.__calls||[]).concat('loadAllPlayers');
window.loadAccounts=()=>window.__calls=(window.__calls||[]).concat('loadAccounts');
window.loadRooms=()=>window.__calls=(window.__calls||[]).concat('loadRooms');
window.refreshServerStatus=()=>window.__calls=(window.__calls||[]).concat('refreshServerStatus');
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
        assert page.locator('#adminApp').count() == 1, 'Admin Control Center root missing'
        assert page.locator('.admin-sidebar-nav [data-admin-nav]').count() == 8, 'persistent sidebar navigation missing'
        assert page.locator('.admin-sidebar-nav [data-admin-nav=\"browser\"]').count() == 1, 'Internal Browser navigation missing from sidebar'
        assert page.locator('#adminShellServerStatus').inner_text() == 'PRECONNECT', 'pending status was not applied during shell initialization'
        page.evaluate("window.WWAdminShell.setStatus({server:'ONLINE',rooms:'2 ห้อง',players:'16 online',audit:'0 findings'})")
        assert page.locator('#adminShellServerStatus').inner_text() == 'ONLINE'
        assert page.locator('#adminShellRoomStatus').inner_text() == '2 ห้อง'
        assert page.locator('#adminShellPlayerStatus').inner_text() == '16 online'
        assert page.locator('#adminShellAuditStatus').inner_text() == '0 findings'

        page.locator('[data-admin-nav="all"]').click()
        page.wait_for_timeout(20)
        calls = page.evaluate('window.__calls || []')
        assert calls.count('switchTab:all') == 1, f'sidebar navigation dispatched more than once: {calls}'
        page.locator('[data-admin-nav="browser"]').click()
        page.wait_for_timeout(20)
        calls = page.evaluate('window.__calls || []')
        assert calls.count('switchTab:browser') == 1, f'Internal Browser sidebar navigation dispatched more than once: {calls}'
        page.locator('[data-admin-nav="versions"]').click()
        page.wait_for_timeout(20)
        calls = page.evaluate('window.__calls || []')
        assert calls.count('switchTab:versions') == 1, f'Versions sidebar navigation dispatched more than once: {calls}'


        page.keyboard.press('Control+K')
        assert page.locator('#adminCommandPalette').is_visible(), 'command palette did not open with Ctrl+K'
        page.locator('#adminCommandSearch').fill('reload')
        page.wait_for_timeout(30)
        assert page.locator('[data-command-id="server.reload.both"]').count() == 1, 'reload command missing from search'
        page.locator('[data-command-id="server.reload.both"]').click()
        page.wait_for_timeout(30)
        calls = page.evaluate('window.__calls || []')
        assert 'askForceReload:both' in calls, f'command registry did not dispatch to existing handler: {calls}'

        page.evaluate('window.WWAdminShell.setContext({type:"player",accountId:"a1",name:"Alice",status:"active",roomId:"ABC123"})')
        page.wait_for_timeout(20)
        assert page.evaluate('window.WWAdminShell.state.selected.name') == 'Alice', 'selection state bridge did not retain selected player'
        assert page.locator('.admin-context-panel').count() == 0, 'obsolete persistent context rail must be removed'

        page.locator('#adminAccountTrigger').click()
        assert page.locator('#adminAccountMenu').is_visible(), 'account menu did not open'
        page.locator('#adminAccountTrigger').click()
        assert not page.locator('#adminAccountMenu').is_visible(), 'account menu did not close'

        page.evaluate('window.WWAdminShell.setActiveTab("all")')
        page.locator('[data-shell-refresh-current]').click()
        page.wait_for_timeout(20)
        assert 'loadAllPlayers' in page.evaluate('window.__calls || []'), 'context-aware current-page refresh did not call the active page handler'

        page.set_viewport_size({'width': 390, 'height': 700})
        page.wait_for_timeout(40)
        pos = page.locator('.admin-sidebar').evaluate('(el)=>getComputedStyle(el).position')
        assert pos == 'fixed', f'mobile navigation should be fixed, got {pos}'
        assert page.locator('.admin-sidebar-nav [data-admin-nav]').count() == 8, 'mobile Admin navigation lost a section'
        overflow = page.evaluate('document.documentElement.scrollWidth > window.innerWidth + 1')
        assert not overflow, 'mobile Admin navigation must not create horizontal page overflow'
        browser.close()
    print('admin-shell-browser: PASS')

if __name__ == '__main__':
    main()
