from pathlib import Path
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: python Playwright unavailable: {exc}')
    raise SystemExit(77)

ROOT = Path(__file__).resolve().parents[1]

def main():
    engine_source = (ROOT / 'utils/runtime-audit-engine.js').read_text()
    audit_source = (ROOT / 'public/js/runtime-audit.js').read_text()
    html = '''<!doctype html>
<html><body data-page="player" style="margin:0;width:300px;height:300px;overflow:hidden">
<div id="players" style="width:240px;height:100px;overflow:hidden;position:relative;display:flex;gap:4px">
  <div class="player" data-pid="p1" style="width:80px;height:40px"><span class="pname">P1</span></div>
  <div class="player" data-pid="p2" style="width:80px;height:40px"><span class="pname">P2</span></div>
  <div class="player" data-pid="p3" style="width:180px;height:160px;transform:translate(1000px,1000px)"><span class="pname">P3</span></div>
</div>
<script>
window.__reports=[];
window.WWReportError=(kind,detail)=>window.__reports.push({kind,detail});
window.WWDiagnostic={getBreadcrumbs:()=>window.__fakeCrumbs||[],sessionId:'test-session'};
window.__WW_RUNTIME_STATE_PROVIDER__=()=>({roomId:'ABC',started:true,isNight:true,players:[{id:'p1',alive:true},{id:'p2',alive:true}],maxPlayers:10});
</script>
</body></html>'''
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        page = browser.new_page(viewport={'width':390,'height':390})
        page.set_content(html, wait_until='load')
        page.evaluate('window.__WW_RUNTIME_AUDIT_FORCE__ = true')
        page.add_script_tag(content=engine_source)
        page.add_script_tag(content=audit_source)
        page.wait_for_timeout(350)
        page.evaluate("console.error('live-audit-console-error')")
        page.evaluate("setTimeout(() => Promise.reject(new Error('live-audit-unhandled')), 0)")
        page.wait_for_timeout(180)
        page.evaluate('''() => { window.__fakeCrumbs = [
          {time:new Date().toISOString(), type:'socket', label:'ack.timeout', traceId:'t', detail:{eventName:'vote',operationId:'op1'}},
          {time:new Date().toISOString(), type:'socket', label:'ack.duplicate:vote', traceId:'t', detail:{operationId:'op2'}}
        ]; }''')
        page.wait_for_timeout(380)
        page.evaluate('''() => { const a=document.createElement('div'); a.className='player'; a.dataset.pid='p4'; a.innerHTML='<span class="pname">P4</span>'; a.style.width='70px'; a.style.height='40px'; document.getElementById('players').appendChild(a); }''')
        page.evaluate('''() => window.WWRuntimeAudit.check()''')
        result = page.evaluate('''() => window.WWRuntimeAudit.snapshot()''')
        reports = page.evaluate('''() => window.__reports.map(x => x.kind)''')
        codes = [x['code'] for x in result['findings']]
        for required in ['CONSOLE_ERROR','UNHANDLED_REJECTION','SOCKET_ACK_TIMEOUT','SOCKET_DUPLICATE_ACK','DOM_COUNT_DESYNC']:
            assert required in codes, f'missing finding {required}: {codes}'
        assert 'runtime_audit_finding' in reports, reports
        browser.close()
    print('runtime-audit-live-browser: PASS')

if __name__ == '__main__':
    main()
