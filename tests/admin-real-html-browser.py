from pathlib import Path
import re
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: python Playwright unavailable: {exc}')
    raise SystemExit(77)

ROOT = Path(__file__).resolve().parents[1]
ADMIN_HTML = (ROOT / 'public' / 'admin.html').read_text()
SHELL_CSS = (ROOT / 'public' / 'css' / 'admin-shell.css').read_text()
DEPENDENCIES = {
    'error-reporter.js': (ROOT / 'public' / 'js' / 'error-reporter.js').read_text(),
    'runtime-audit-engine.js': (ROOT / 'public' / 'js' / 'runtime-audit-engine.js').read_text(),
    'admin-auth-tab.js': (ROOT / 'public' / 'js' / 'admin-auth-tab.js').read_text(),
    'admin-command-registry.js': (ROOT / 'public' / 'js' / 'admin-command-registry.js').read_text(),
    'admin-shell.js': (ROOT / 'public' / 'js' / 'admin-shell.js').read_text(),
    'runtime-audit.js': (ROOT / 'public' / 'js' / 'runtime-audit.js').read_text(),
    'ww-ui.js': (ROOT / 'public' / 'js' / 'ww-ui.js').read_text(),
}


def make_browser_html():
    html = ADMIN_HTML
    assert '<script src="/js/admin-shell.js?v=20260925-1"></script>' in html, 'real admin page must load Admin Shell script'
    assert '<script src="/js/admin-auth-tab.js?v=20260925-1"></script>' in html, 'real admin page must load tab auth script'
    assert '<script src="/js/admin-command-registry.js?v=20260925-1"></script>' in html, 'real admin page must load command registry'
    html = html.replace('<link rel="stylesheet" href="/css/admin-shell.css?v=1">', f'<style>{SHELL_CSS}</style>', 1)
    socket_stub = '''<script>(function(){window.io=function(){const h={};const s={connected:false,on(e,f){(h[e]??=[]).push(f);return s},once(e,f){return s.on(e,f)},emit(e,p,cb){if(typeof cb==='function')cb(e==='admin_list_accounts'?{ok:true,accounts:[]}:e==='admin_list_rooms'?{ok:true,rooms:[]}:({ok:true}));return s},connect(){if(s.connected)return s;s.connected=true;(h.connect||[]).forEach(f=>f());return s},disconnect(){if(!s.connected)return s;s.connected=false;(h.disconnect||[]).forEach(f=>f());return s}};return s};})();</script>'''
    html = html.replace('<script src="/socket.io/socket.io.js"></script>', socket_stub, 1)
    for filename, code in DEPENDENCIES.items():
        pattern = re.compile(r'<script\s+src="/js/' + re.escape(filename) + r'(?:\?[^\"]*)?"></script>')
        html, count = pattern.subn(lambda _m: '<script>' + code + '\n</script>', html, count=1)
        assert count == 1, f'could not inline {filename}'
    # The Admin page only needs JSON-shaped responses for this DOM execution test.
    fetch_stub = '''<script>window.fetch=async function(url,init){const u=String(url||'');let body={ok:true};if(u.includes('/api/admin/session'))body={ok:true,required:false,authenticated:false,passwordEnabled:false,googleEnabled:false};else if(u.includes('/api/config'))body={ok:true,serverOpen:true,appVersion:'inline-test'};else if(u.includes('/api/admin/players'))body={ok:true,players:[]};else if(u.includes('/api/admin/diagnostics'))body={ok:true,events:[]};return {ok:true,status:200,headers:new Headers(),json:async()=>body,text:async()=>JSON.stringify(body)};};</script>'''
    html = html.replace('<style>', fetch_stub + '<style>', 1)
    return html


def main():
    html = make_browser_html()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1024, 'height': 720})
        page_errors = []
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.set_content(html, wait_until='load')
        page.wait_for_timeout(700)

        assert page.locator('#adminShellRoot').count() == 1, 'real admin.html did not create shell'
        assert page.locator('#adminGameSurface').count() == 1, 'real Index surface missing'
        assert page.locator('#adminGameSurface').get_attribute('src') == '/index.html?embedded=admin'
        assert page.locator('.admin-bottom-dock').get_attribute('hidden') == '', 'legacy tabs should be hidden'
        assert page.locator('#adminCommandPalette').count() == 1, 'command palette missing'
        assert page.locator('#adminShellServerStatus').count() == 1, 'live shell status strip missing'
        assert page.evaluate('Boolean(window.WWAdminShell && window.WWAdminTabAuth && window.WWAdminCommandRegistry)')
        page.keyboard.press('Control+K')
        assert page.locator('#adminCommandPalette').is_visible(), 'real admin page command palette did not open'
        page.keyboard.press('Escape')
        assert not page.locator('#adminCommandPalette').is_visible(), 'command palette Escape did not close'
        page.set_viewport_size({'width': 390, 'height': 700})
        page.wait_for_timeout(50)
        assert page.locator('.admin-shell-rail').evaluate('(el)=>getComputedStyle(el).position') == 'fixed'
        assert not page_errors, page_errors
        browser.close()
    print('admin-real-html-browser: PASS')


if __name__ == '__main__':
    main()
