from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_harness import launch_chromium
ROOT=Path(__file__).resolve().parents[1]
ADMIN=(ROOT/'public/admin.html').read_text(encoding='utf-8')
SHELL=(ROOT/'public/css/admin-shell.css').read_text(encoding='utf-8')

def main():
    assert 'id="accountOverlay"' not in ADMIN and 'id="roomDetailOverlay"' not in ADMIN
    assert 'id="playerDetailWorkspace"' in ADMIN and 'id="roomDetailWorkspace"' in ADMIN
    assert '.admin-detail-workspace' in SHELL and '.room-inspector-content-grid' in SHELL
    assert 'position:fixed' not in SHELL[SHELL.index('.admin-detail-workspace'):SHELL.index('.admin-detail-workspace')+500]
    with sync_playwright() as p:
        browser=launch_chromium(p); page=browser.new_page(viewport={'width':1180,'height':682})
        fixture=f'''<!doctype html><html><head><style>{SHELL}</style></head><body data-page="admin"><div class="admin-app-shell"><header class="admin-topbar"><div>ADMIN</div></header><div class="admin-layout-grid" style="grid-template-columns:minmax(0,1fr)"><main class="admin-workspace"><div class="admin-page-stack"><section class="admin-detail-workspace" id="detail"><div class="admin-detail-breadcrumb">Players › Alice</div><div class="admin-detail-header"><div><span class="admin-detail-kicker">PLAYER DETAIL</span><h2>Alice</h2></div></div><div class="admin-detail-body"><div style="height:1000px"></div></div></section></div></main></div></div></body></html>'''
        page.set_content(fixture,wait_until='domcontentloaded')
        for width,height in [(390,844),(1180,682),(1440,900),(1800,1000)]:
            page.set_viewport_size({'width':width,'height':height}); page.wait_for_timeout(20); top=page.locator('.admin-topbar').bounding_box(); detail=page.locator('#detail').bounding_box(); work=page.locator('.admin-workspace').bounding_box(); inner=page.locator('.admin-workspace').evaluate("e=>e.clientWidth-parseFloat(getComputedStyle(e).paddingLeft)-parseFloat(getComputedStyle(e).paddingRight)"); assert top and detail and work and detail['y'] >= top['y'] + top['height'] - 1 and detail['width']>=inner-2,(width,height,top,detail,work,inner); overflow=page.evaluate('document.documentElement.scrollWidth-document.documentElement.clientWidth'); assert overflow<=1,(width,height,overflow)
        browser.close()
    print('admin-popup-header-boundary-regression: PASS')
if __name__=='__main__': main()
