from pathlib import Path
import json
import runpy
try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f'SKIP: Python Playwright unavailable: {exc}')
    raise SystemExit(77)

ROOT = Path(__file__).resolve().parents[1]
fixture = runpy.run_path(str(ROOT / 'tests' / 'admin-real-html-browser.py'), run_name='admin_fixture')
make_browser_html = fixture['make_browser_html']

REPORT_TEXT = """WEREWOLF BUG REPLAY FIRST FAILURE REPORT\n=========================================\nMode: first\nStatus: failed\nScenario: First failure\nTest: tests/example-failure.js\nStep: 1\nFailure: FIRST_FAILURE_SENTINEL\n\nDETAILS\n{\"code\":\"FIRST_FAILURE\",\"stage\":\"bug-replay\"}\n"""


def main():
    html = make_browser_html()
    with sync_playwright() as p:
        browser = fixture['launch_chromium'](p)
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        page_errors=[]
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.set_content(html, wait_until='load')
        page.wait_for_timeout(250)
        page.evaluate("switchTab('diagnostics')")
        page.wait_for_timeout(120)
        # Seed a compact but realistic Diagnostics payload.
        page.evaluate("""(reportText) => {
          const jsonUrl='data:application/json,'+encodeURIComponent(JSON.stringify({ok:true,reportText:reportText}));
          const textUrl='data:text/plain,'+encodeURIComponent(reportText);
          window.__diagTestReportUrl=jsonUrl;
          window.__diagTestTextUrl=textUrl;
          const nativeFetch=window.fetch;
          window.fetch=async (url,init)=>{ if(String(url)===textUrl) return new Response(reportText,{status:200,headers:{'Content-Type':'text/plain; charset=utf-8'}}); return nativeFetch(url,init); };
          renderDiagnostics({
            summary:{stored:3,serious:1,accessDenied:0},
            server:{uptimeSec:3720},
            githubBugReports:{configured:true,repository:'tanawutmalirum29-ux/werewolf-online'},
            permissions:{expected:[{action:'dynamodb:GetItem',reason:'อ่านข้อมูลผู้เล่น'}],observedFailures:[]},
            events:[
              {id:'evt-1',time:new Date().toISOString(),kind:'bug_replay_failure',source:'server',page:'admin',message:'FIRST_FAILURE_SENTINEL',action:'bug-replay:first',analysis:{rootCause:'ตัวอย่าง failure แรก',causeCode:'FIRST_FAILURE',failureStage:'bug-replay',rootCauseSource:'test',confidence:'high'},traceId:'trace-1'},
              {id:'evt-2',time:new Date().toISOString(),kind:'socket_error',source:'client',page:'player',message:'socket transport error'}
            ]
          });
          const card=document.getElementById('bugReplayCard');
          card.classList.add('is-collapsed');
          bugReplayRunId='replay-test';
          bugReplayFailureReportLinks = new Map();
          bugReplayFailureReportLinks.set('evt-1',{jsonReportUrl:window.__diagTestReportUrl,aiReportUrl:window.__diagTestReportUrl,reportUrl:window.__diagTestTextUrl});
          updateBugReplayUi({
            runId:'replay-test',status:'failed',mode:'first',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),
            currentScenarioIndex:0,currentScenarioId:'diagnostics',currentScenarioTitle:'Diagnostics Test',currentAction:'ตรวจ failure',currentStepIndex:0,currentTestPath:'tests/example-failure.js',
            totalScenarios:10,completedScenarios:1,totalSteps:30,completedSteps:1,passedSteps:0,failedSteps:1,remainingSteps:29,
            failureCount:1,failures:[{eventId:'evt-1',scenarioTitle:'Diagnostics Test',scenarioId:'diagnostics',testPath:'tests/example-failure.js',stepIndex:0,exitCode:7}],
            failure:{eventId:'evt-1',scenarioTitle:'Diagnostics Test',scenarioId:'diagnostics',testPath:'tests/example-failure.js',stepIndex:0,exitCode:7},
            report:{status:'ready',url:window.__diagTestReportUrl,jsonUrl:window.__diagTestReportUrl,aiUrl:window.__diagTestReportUrl,jsonDownloadUrl:window.__diagTestReportUrl,textDownloadUrl:window.__diagTestTextUrl}
          });
        }""", REPORT_TEXT)
        page.wait_for_timeout(900)
        assert page.locator('#tab-diagnostics.active').count()==1
        assert page.locator('#diag-hero').count()==0, 'old duplicate Diagnostics hero must be removed'
        assert page.locator('#adminPanelTitle').inner_text() == 'การตรวจสอบ', 'Diagnostics title must use the single Thai header'
        assert page.locator('#adminPanelKicker').is_hidden(), 'Diagnostics must not show the duplicate English kicker'
        assert page.locator('#adminDiagnosticsHeaderTools').is_visible(), 'Diagnostics header tools must be visible'
        assert page.locator('#diagGithubStatus').get_attribute('href') == 'https://github.com/tanawutmalirum29-ux/werewolf-online', 'GitHub repository link must point to the configured repository'
        assert page.locator('#diagGithubSubmitAllBtn').inner_text().find('ส่งรายงานทั้งหมดขึ้น GitHub') >= 0, 'batch GitHub action missing'
        assert not page.locator('#diagGithubSubmitAllBtn').is_disabled(), 'batch GitHub action should be enabled when events and GitHub are configured'
        assert page.locator('.admin-diagnostics-header-actions').evaluate("el=>getComputedStyle(el).flexWrap") == 'nowrap', 'Diagnostics actions must stay on one row'
        assert page.locator('.diag-safe-badge').count() == 0 or page.locator('.diag-safe-badge').evaluate_all("els=>els.every(el=>getComputedStyle(el).display==='none')"), 'removed safety phrase must not be visible in Diagnostics header'
        assert page.locator('.diag-header-section-jump button').count()==3, 'three Diagnostics section buttons must live in the sticky header'
        assert page.locator('.diag-header-section-jump').evaluate("el=>el.closest('#adminPageHeader')?.id") == 'adminPageHeader', 'section jumps must be inside page header'
        assert page.locator('#adminPageHeader').evaluate("el=>getComputedStyle(el).position") == 'sticky', 'page header must stay sticky'
        assert page.locator('.admin-page-actions > [data-shell-refresh-current]').count()==1, 'only one shell refresh button should exist in the page header'
        assert page.locator('#tab-diagnostics button[onclick*=\"loadDiagnostics()\"]').count()==0, 'Diagnostics must not have a second page refresh button'
        before=page.locator('#adminPageHeader').bounding_box()
        page.locator('#adminWorkspace').evaluate("el=>el.scrollTo({top:650,behavior:'auto'})")
        page.wait_for_timeout(80)
        after=page.locator('#adminPageHeader').bounding_box()
        assert before and after and abs(after['y']-before['y'])<=1, {'before':before,'after':after}
        assert page.locator('#bugReplayFirstBtn').count()==1
        assert page.locator('#bugReplayStartBtn').count()==1
        assert page.locator('#bugReplayTerminalReport').is_visible()
        assert 'FIRST_FAILURE_SENTINEL' in page.locator('#bugReplayTerminalText').input_value()
        expanded=page.locator('#bugReplayCard').evaluate("el=>!el.classList.contains('is-collapsed')")
        assert expanded, 'terminal report must auto-expand the replay card'
        assert page.locator('#bugReplayDownloadAggregateJsonBtn').count()==0 or page.locator('#bugReplayDownloadAggregateJsonBtn').count()==1

        # Diagnostics JSON is intentionally an option popup, not an immediate download.
        page.locator('#diagJsonOptionsBtn').click()
        page.wait_for_timeout(40)
        assert page.locator('#diagJsonOptionsOverlay').count()==1, 'JSON options popup did not open'
        popup_text=page.locator('#diagJsonOptionsOverlay').inner_text()
        assert 'รายการที่กำลังแสดง' in popup_text and 'รุนแรง' in popup_text and 'IAM/Role' in popup_text
        assert page.locator('#diagJsonOptionsOverlay button').all_inner_texts() == ['↗️ เปิด JSON','⬇️ ดาวน์โหลด','📋 คัดลอก','ปิด']
        page.locator('#diagJsonCloseBtn').click()

        # Batch GitHub action must submit exactly the currently rendered event IDs.
        page.evaluate("window.wwConfirm=async()=>true; window.ensureAdminLogin=async()=>true; window.__batchRequests=[]; window.adminFetchJson=async function(url,options){window.__batchRequests.push({url,body:options?.body||''}); return {response:{ok:true,status:200},data:{ok:true,requested:2,created:2,reused:0,failed:0,repository:'tanawutmalirum29-ux/werewolf-online',results:[]}};};")
        page.locator('#diagGithubSubmitAllBtn').click()
        page.wait_for_timeout(140)
        batch_requests=page.evaluate('window.__batchRequests')
        assert batch_requests and batch_requests[-1]['url'] == '/api/admin/diagnostics/github/all', batch_requests
        assert batch_requests[-1]['body'] == '{"eventIds":["evt-1","evt-2"]}', batch_requests

        # Ensure no horizontal overflow at the target desktop size.
        metrics=page.evaluate("""() => ({sw:document.documentElement.scrollWidth,vw:innerWidth,sh:document.documentElement.scrollHeight,vh:innerHeight})""")
        assert metrics['sw'] <= metrics['vw']+1, metrics
        page.screenshot(path=str(ROOT/'ADMIN-DIAGNOSTICS-PREVIEW-1440x900.png'), full_page=False)

        # Dedicated first-failure popup contract: inspect the actual DOM values used by
        # each action. This avoids relying on monkeypatched globals inside inline-script closures.
        popup_job = {
          'runId':'replay-popup-test','status':'failed','mode':'first','failureCount':1,
          'totalScenarios':10,'completedScenarios':1,'totalSteps':30,'completedSteps':2,'passedSteps':1,'failedSteps':1,
          'failure':{'eventId':'evt-1','scenarioTitle':'Diagnostics Test','scenarioId':'diagnostics','testPath':'tests/example-failure.js','stepIndex':1,'exitCode':7},
          'report':{'status':'ready','reportKind':'BUG_REPLAY_FIRST_FAILURE','url':'https://example.test/diagnostics/share/first','jsonUrl':'https://example.test/diagnostics/share/first.json','aiUrl':'https://example.test/diagnostics/share/first.json','jsonDownloadUrl':'https://example.test/api/admin/bug-replay/export?runId=replay-popup-test&reportScope=first_failure&format=json','textDownloadUrl':'https://example.test/api/admin/bug-replay/export?runId=replay-popup-test&reportScope=first_failure&format=text'}
        }
        popup = page.evaluate("""(job) => {
          bugReplayResultPopupRunId='';
          closeBugReplayResultPopup();
          showBugReplayResultPopup(job);
          return {
            title:document.getElementById('bugReplayResultTitle')?.textContent || '',
            openUrl:document.getElementById('bugReplayPopupOpenBtn')?.getAttribute('data-bug-replay-report-url') || '',
            copyUrl:document.getElementById('bugReplayPopupCopyBtn')?.getAttribute('data-bug-replay-copy-url') || '',
            jsonUrl:document.getElementById('bugReplayPopupJsonBtn')?.getAttribute('data-bug-replay-json-url') || ''
          };
        }""", popup_job)
        assert 'พบปัญหาแรกแล้ว' in popup['title'], popup
        assert popup['openUrl'] == popup_job['report']['url'], popup
        assert popup['copyUrl'] == popup_job['report']['textDownloadUrl'], popup
        assert popup['jsonUrl'] == popup_job['report']['jsonDownloadUrl'], popup
        page.locator('#bugReplayPopupCloseBtn').click()
        page.wait_for_timeout(40)

        for width,height in [(1180,682),(390,844)]:
            page.set_viewport_size({'width':width,'height':height})
            page.wait_for_timeout(80)
            metrics=page.evaluate("""() => ({sw:document.documentElement.scrollWidth,vw:innerWidth,sh:document.documentElement.scrollHeight,vh:innerHeight,terminalW:document.querySelector('#bugReplayTerminalReport')?.getBoundingClientRect().width||0})""")
            assert metrics['sw'] <= metrics['vw']+1, (width,height,metrics)
            page.screenshot(path=str(ROOT/f'ADMIN-DIAGNOSTICS-PREVIEW-{width}x{height}.png'), full_page=False)
        assert not page_errors, page_errors
        print('admin-diagnostics-browser-regression: PASS')

if __name__=='__main__':
    main()
