from pathlib import Path
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: Python Playwright unavailable: {exc}')
    raise SystemExit(77)

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
ENGINE = (ROOT / 'utils/runtime-audit-engine.js').read_text()
AUDIT = (ROOT / 'public/js/runtime-audit.js').read_text()
REGISTRY = (ROOT / 'public/js/runtime-audit-action-registry.js').read_text()
ACTIONS = (ROOT / 'public/js/runtime-audit-actions.js').read_text()

FIXTURES = {
    'index': '''<body data-page="index"><input id="displayNameInput"><button id="nameBadge">profile</button><div id="wwUpdateOverlay" style="display:none"><button>update</button></div><button class="btn-host">host</button><button class="btn-player">player</button><script>document.querySelector('.btn-host').addEventListener('click',()=>location.hash='host');document.querySelector('.btn-player').addEventListener('click',()=>location.hash='player');</script></body>''',
    'player': '''<body data-page="player"><button id="playerRoomPickerTrigger">rooms</button><div id="playerRoomPickerOverlay" hidden style="width:220px;height:120px"></div><button id="playerRoomPickerCloseBtn">close</button><button id="playerRoomRefreshBtn">refresh</button><button class="filterChip active" data-filter="all">all</button><button class="filterChip" data-filter="alive">alive</button><button class="filterChip" data-filter="dead">dead</button><button id="tabGlobal">global</button><button id="maskBtn">role</button><div id="rolePopupOverlay" hidden style="width:220px;height:120px"></div><button id="rolePopupClose">close</button><script>
const crumbs=[]; window.__crumbs=crumbs; window.WWDiagnostic={getBreadcrumbs:()=>crumbs};
const add=(label,detail)=>crumbs.push({time:new Date().toISOString(),label,detail});
playerRoomPickerTrigger.onclick=()=>{playerRoomPickerOverlay.hidden=false}; playerRoomPickerCloseBtn.onclick=()=>{playerRoomPickerOverlay.hidden=true};
playerRoomRefreshBtn.onclick=()=>{add('emit:list_open_rooms_players',{operationId:'op-refresh'});setTimeout(()=>add('ack:list_open_rooms_players',{operationId:'op-refresh',ok:true,ackCode:'OK'}),120)};
for(const b of document.querySelectorAll('.filterChip')) b.onclick=()=>{for(const x of document.querySelectorAll('.filterChip'))x.classList.remove('active');b.classList.add('active')};
tabGlobal.onclick=()=>tabGlobal.classList.add('active'); maskBtn.onclick=()=>rolePopupOverlay.hidden=false; rolePopupClose.onclick=()=>rolePopupOverlay.hidden=true;
</script></body>''',
    'host': '''<body data-page="host"><button id="roomSettingsBtn">settings</button><div id="roomSettingsOverlay" hidden style="width:360px;height:260px"></div><button class="vote-modal-close">✕</button><button id="roleCollapseBtn" aria-expanded="true">collapse</button><button id="playerFocusBtn" aria-pressed="false">focus</button><button class="gridColsBtn active" data-cols="2">2</button><button class="gridColsBtn" data-cols="4">4</button><button class="gridColsBtn" data-cols="8">8</button><button id="viewModeGridBtn" class="active">grid</button><button id="viewModeSimpleBtn">simple</button><button class="filterChip active" data-filter="all">all</button><button class="filterChip" data-filter="alive">alive</button><button class="filterChip" data-filter="dead">dead</button><button id="tabGlobal">global</button><script>\nconst crumbs=[];window.__crumbs=crumbs;window.WWDiagnostic={getBreadcrumbs:()=>crumbs}; const add=(label,detail)=>crumbs.push({time:new Date().toISOString(),label,detail});
roomSettingsBtn.onclick=()=>roomSettingsOverlay.hidden=false; voteModalClose=document.querySelector('.vote-modal-close'); voteModalClose.onclick=()=>roomSettingsOverlay.hidden=true;
roleCollapseBtn.onclick=()=>roleCollapseBtn.setAttribute('aria-expanded',roleCollapseBtn.getAttribute('aria-expanded')!=='true'); playerFocusBtn.onclick=()=>playerFocusBtn.setAttribute('aria-pressed',playerFocusBtn.getAttribute('aria-pressed')!=='true');
for(const b of document.querySelectorAll('.gridColsBtn'))b.onclick=()=>{document.querySelectorAll('.gridColsBtn').forEach(x=>x.classList.remove('active'));b.classList.add('active')};
viewModeGridBtn.onclick=()=>{viewModeGridBtn.classList.add('active');viewModeSimpleBtn.classList.remove('active')}; viewModeSimpleBtn.onclick=()=>{viewModeSimpleBtn.classList.add('active');viewModeGridBtn.classList.remove('active')};
for(const b of document.querySelectorAll('.filterChip'))b.onclick=()=>{document.querySelectorAll('.filterChip').forEach(x=>x.classList.remove('active'));b.classList.add('active')}; tabGlobal.onclick=()=>tabGlobal.classList.add('active-global');\n</script></body>''',
    'maintenance': '''<body data-page="maintenance"><div id="rolesBox">roles</div></body>''',
    'admin': '''<body data-page="admin" data-admin-tab="overview"><button data-shell-refresh-current>refresh</button><div id="bugReplayAudit" class=""></div><button id="bugReplayAuditToggle">audit</button><button id="adminBrowserNewTabBtn">browser</button><button id="playerDetail" data-account-id="p1">p</button><button id="roomDetail" data-room-id="r1">r</button><div id="allPlayersContent"></div><div id="roomsContent"></div><button data-shell-command="diagnostics.refresh">diag</button><div id="accountDetailBody"></div><div id="roomDetailWorkspace"></div><div id="tab-tools"></div><script>
const panels=['overview','all','live','rooms','tools','versions','diagnostics','browser']; for(const p of panels){const n=document.createElement('button');n.dataset.adminNav=p; n.textContent=p; document.body.appendChild(n);const panel=document.createElement('section');panel.dataset.adminPanel=p; panel.textContent=p; document.body.appendChild(panel);n.onclick=()=>{document.body.dataset.adminTab=p;document.querySelectorAll('[data-admin-panel]').forEach(x=>x.hidden=x.dataset.adminPanel!==p)}};
allPlayersContent.appendChild(playerDetail); roomsContent.appendChild(roomDetail); adminBrowserNewTabBtn.onclick=()=>document.body.dataset.browserOpen='1'; bugReplayAuditToggle.onclick=()=>document.getElementById('bugReplayAudit').classList.toggle('is-open'); document.querySelector('[data-shell-refresh-current]').onclick=()=>{};
</script></body>''',
}

def run_page(browser, page_name, html):
    page = browser.new_page(viewport={'width': 1180, 'height': 682})
    page.set_content('<!doctype html><html>' + html + '</html>', wait_until='load')
    page.evaluate('window.__WW_RUNTIME_AUDIT_FORCE__=true')
    page.add_script_tag(content=ENGINE)
    page.add_script_tag(content=REGISTRY)
    page.add_script_tag(content=AUDIT)
    page.add_script_tag(content=ACTIONS)
    page.wait_for_timeout(250)
    result = page.evaluate('''async () => { const r=await window.WWRuntimeAuditActions.runSafe({gapMs:40}); return {r, snapshot:window.WWRuntimeAuditActions.engineSnapshot()}; }''')
    page.close()
    return result


def main():
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f'SKIP: {exc}')
            raise SystemExit(77)
        for page_name, html in FIXTURES.items():
            result = run_page(browser, page_name, html)
            r=result['r']; cov=r['coverage']
            assert r['ok'], f'{page_name}: safe action audit failed: {cov}'
            accounted = cov['passed'] + cov['skipped'] + cov['blocked']
            assert cov['attempted'] == accounted, f'{page_name}: action accounting mismatch: {cov}'
            assert cov['failed'] == 0 and cov['timedOut'] == 0, f'{page_name}: unexpected failed/timeout action: {cov}'
        browser.close()
    print('runtime-audit-browser-actions-regression: PASS (index/player/host/admin/maintenance safe actions)')

if __name__ == '__main__':
    main()
