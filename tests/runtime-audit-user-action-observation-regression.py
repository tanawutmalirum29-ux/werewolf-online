from pathlib import Path
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: Python Playwright unavailable: {exc}')
    raise SystemExit(77)
from browser_harness import launch_chromium

ROOT=Path(__file__).resolve().parents[1]
ENGINE=(ROOT/'utils/runtime-audit-engine.js').read_text()
AUDIT=(ROOT/'public/js/runtime-audit.js').read_text()
REGISTRY=(ROOT/'public/js/runtime-audit-action-registry.js').read_text()
ACTIONS=(ROOT/'public/js/runtime-audit-actions.js').read_text()

HTML='''<!doctype html><body data-page="player">
<button id="playerRoomRefreshBtn">refresh</button>
<script>
window.__crumbs=[]; window.WWDiagnostic={getBreadcrumbs:()=>window.__crumbs};
window.emitRefresh=(ok)=>{ const op='user-op-1'; window.__crumbs.push({time:new Date().toISOString(),label:'emit:list_open_rooms_players',detail:{operationId:op}}); setTimeout(()=>window.__crumbs.push({time:new Date().toISOString(),label:'ack:list_open_rooms_players',detail:{operationId:op,ok,ackCode:ok?'OK':'SERVER_REJECT'}}),120); };
playerRoomRefreshBtn.onclick=()=>window.emitRefresh(window.__ackOk!==false);
</script></body>'''

with sync_playwright() as p:
    try: browser=launch_chromium(p)
    except RuntimeError as exc:
        print(f'SKIP: {exc}'); raise SystemExit(77)
    page=browser.new_page(viewport={'width':1180,'height':682})
    page.set_content(HTML, wait_until='load')
    page.evaluate('window.__WW_RUNTIME_AUDIT_FORCE__=true')
    for source in (ENGINE,REGISTRY,AUDIT,ACTIONS): page.add_script_tag(content=source)
    page.wait_for_timeout(220)
    page.click('#playerRoomRefreshBtn')
    page.wait_for_timeout(700)
    snap=page.evaluate('window.WWRuntimeAuditActions.engineSnapshot()')
    runs=[x for x in snap['actionCoverage']['recent'] if x['actionId']=='player.refresh-room-list']
    assert any(x['status']=='passed' and x['detail'].get('operationId')=='user-op-1' for x in runs), runs
    page.evaluate('window.__ackOk=false')
    page.click('#playerRoomRefreshBtn')
    page.wait_for_timeout(800)
    snap=page.evaluate('window.WWRuntimeAuditActions.engineSnapshot()')
    runs=[x for x in snap['actionCoverage']['recent'] if x['actionId']=='player.refresh-room-list']
    assert any(x['status']=='failed' and x['actual'].get('ackOk') is False for x in runs), runs
    browser.close()
print('runtime-audit-user-action-observation-regression: PASS')
