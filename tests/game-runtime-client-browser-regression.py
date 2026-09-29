from pathlib import Path
try:
    from playwright.sync_api import sync_playwright
    from browser_harness import launch_chromium
except Exception as exc:
    print(f'SKIP: {exc}')
    raise SystemExit(77)

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = (ROOT / 'public/js/game-runtime-client.js').read_text()
HTML = '''<!doctype html><html lang="th"><body>
<div id="connBanner" class="hidden"></div>
<div id="gameActionStatus" class="runtime-action-status hidden"></div>
<div id="spectatorCard" class="hidden"></div>
<div id="gameTimeline"></div>
<script>__RUNTIME__</script>
<script>
window.__calls=[];
window.__handlers={};
window.__socket={
  connected:true,
  on(e,f){(window.__handlers[e] ||= []).push(f); return this;},
  off(){return this;},
  emit(e,p,cb){window.__calls.push({e,p}); window.__lastCb=cb; return this;}
};
window.__controller = WWGameRuntime.attach(window.__socket,{page:'player'});
</script></body></html>'''.replace('__RUNTIME__', RUNTIME)

with sync_playwright() as p:
    browser = launch_chromium(p)
    page = browser.new_page(viewport={'width': 390, 'height': 844})
    page.set_content(HTML)
    page.wait_for_timeout(30)
    page.evaluate("window.__socket.emit('cast_vote',{roomId:'ABC',targetId:'p2'}, window.__cb)")
    # The wrapper replaces the callback only when provided inline; repeat with actual callback.
    page.evaluate("window.__socket.emit('cast_vote',{roomId:'ABC',targetId:'p2'},()=>{window.__userCb=true})")
    page.wait_for_timeout(20)
    page.evaluate("window.__lastCb({ok:false,code:'INVALID_PHASE'})")
    assert 'ไม่สำเร็จ' in page.locator('#gameActionStatus').inner_text()
    page.evaluate("window.__socket.emit('select_target',{roomId:'ABC',targetId:'p3'})")
    page.evaluate("window.__handlers.room_update[0]({roomId:'ABC',stateVersion:2,timeline:[{type:'game_started',at:Date.now(),stateVersion:2},{type:'player_died',at:Date.now(),stateVersion:3,label:'ผู้เล่น 3'}]})")
    page.wait_for_timeout(20)
    assert 'สำเร็จ' in page.locator('#gameActionStatus').inner_text()
    page.evaluate("window.__handlers.disconnect[0]()")
    assert 'กำลังเชื่อมต่อใหม่' in page.locator('#connBanner').inner_text()
    page.evaluate("WWGameRuntime.renderTimeline('gameTimeline',[{type:'game_started',at:Date.now(),stateVersion:4},{type:'vote_started',at:Date.now(),stateVersion:5}])")
    assert page.locator('#gameTimeline .runtime-timeline-item').count() == 2
    page.evaluate("WWGameRuntime.renderSpectator({started:true,gameOver:false,isNight:true,players:[{isHost:true},{id:'me',alive:false},{id:'p2',alive:true}],timeline:[{type:'player_died'}]},{id:'me',alive:false})")
    assert page.locator('#spectatorCard').is_visible()
    assert 'คุณเสียชีวิตแล้ว' in page.locator('#spectatorCard').inner_text()
    browser.close()
print('PASS game-runtime-client-browser-regression')
