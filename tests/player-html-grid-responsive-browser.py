from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PLAYER_HTML = (ROOT / 'public' / 'player.html').read_text()
PLAYER_CSS = (ROOT / 'public' / 'css' / 'player.css').read_text()
PLAYER_JS = (ROOT / 'public' / 'js' / 'player.main.js').read_text()


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    assert_true('<div id="players"></div>' in PLAYER_HTML, 'player.html #players hook missing')
    assert_true('<div class="card hidden" id="playersCard">' in PLAYER_HTML, 'player.html #playersCard missing')
    for needle, label in [
        ('window.addEventListener("pageshow", refit, { passive: true });', 'pageshow'),
        ('window.addEventListener("orientationchange", refit, { passive: true });', 'orientationchange'),
        ('document.addEventListener("visibilitychange"', 'visibilitychange'),
        ('window.visualViewport.addEventListener("resize", () => scheduleFitPlayerGrid(true)', 'visualViewport resize'),
    ]:
        assert_true(needle in PLAYER_JS, f'Player grid {label} lifecycle hook missing')

    start = PLAYER_JS.find('function computePlayerGridLayout')
    end = PLAYER_JS.find('// ===== px (อ้างอิงการ์ดดีฟอลต์ 88px) -> cqw', start)
    assert_true(start >= 0 and end > start, 'cannot extract Player grid controller')
    controller = PLAYER_JS[start:end]

    harness = f'''<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>{PLAYER_CSS}</style>
<style>
html,body{{margin:0;width:100%;height:100%;overflow:hidden}}
body{{display:block !important}}
.app.game-visible{{width:100% !important;max-width:none !important;height:100% !important;margin:0 !important;padding:0 !important;display:block !important;overflow:hidden !important}}
#playersCard{{display:flex !important;flex-direction:column !important;box-sizing:border-box !important;position:relative !important;width:100% !important;height:100% !important;margin:0 !important;min-height:0 !important;flex:none !important;opacity:1 !important;pointer-events:auto !important;transform:none !important}}
.players-card-head{{flex:0 0 32px !important}}
#playersCard > #playersSub{{flex:0 0 20px !important;margin:0 !important}}
#players{{flex:1 1 auto !important;width:100% !important;min-height:0 !important;min-width:0 !important}}
.player{{box-sizing:border-box !important}}
</style>
</head>
<body data-page="player" class="is-day">
<div class="app game-visible">
  <div class="card" id="playersCard">
    <div class="players-card-head"><h3 id="phaseTitle"><span id="phaseText">ผู้เล่นในห้อง</span></h3><div class="player-filter-chips"></div></div>
    <p class="sub" id="playersSub"><span id="playersSubThreshold"></span><span id="playersSubCountdown"></span></p>
    <div id="players"></div>
  </div>
</div>
<script>
{controller}
</script>
</body>
</html>'''

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path="/usr/bin/chromium", args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 360, "height": 640}, device_scale_factor=2)
        page.set_content(harness, wait_until='load')

        page.evaluate('''() => {
            window.__test = {
                addPlayers(count) {
                    const el = document.getElementById('players');
                    el.innerHTML = '';
                    for (let i = 0; i < count; i++) {
                        const d = document.createElement('div');
                        d.className = 'player';
                        d.dataset.pid = 'p' + i;
                        d.dataset.alive = '1';
                        d.innerHTML = '<div class=\"pname\">P' + i + '</div>';
                        el.appendChild(d);
                    }
                },
                metrics(expected) {
                    const el = document.getElementById('players');
                    const er = el.getBoundingClientRect();
                    const cards = [...el.querySelectorAll('.player[data-pid]:not(.search-hidden)')];
                    const rects = cards.map(c => c.getBoundingClientRect());
                    const overflow = Math.max(0, ...rects.map(r => Math.max(
                        er.left - r.left, r.right - er.right,
                        er.top - r.top, r.bottom - er.bottom, 0
                    )));
                    const visible = rects.filter(r => r.width > 0 && r.height > 0).length;
                    const cs = getComputedStyle(el);
                    const contentLeft = er.left + (parseFloat(cs.paddingLeft) || 0);
                    const firstLeft = rects.length ? rects[0].left - contentLeft : 0;
                    return {
                        expected,
                        count: cards.length,
                        visible,
                        overflow,
                        firstLeft,
                        width: er.width,
                        height: er.height,
                        columns: Number(el.dataset.gridColumns || 0),
                        rows: Number(el.dataset.gridRows || 0),
                        scrollOverflow: Math.max(0, el.scrollHeight - el.clientHeight),
                    };
                }
            };
        }''')

        def wait_grid():
            page.wait_for_timeout(90)

        def check(label, expected):
            wait_grid()
            m = page.evaluate("expected => window.__test.metrics(expected)", expected)
            assert_true(m['count'] == expected, f'{label}: player count mismatch {m}')
            assert_true(m['visible'] == expected, f'{label}: hidden/missing card {m}')
            assert_true(m['overflow'] <= 0.75, f'{label}: card overflow {m}')
            assert_true(m['scrollOverflow'] <= 0.75, f'{label}: #players internal overflow {m}')
            assert_true(m['firstLeft'] <= 1.0, f'{label}: first/last row not left anchored {m}')
            assert_true(m['columns'] >= 1 and m['rows'] >= 1, f'{label}: invalid grid dimensions {m}')
            return m

        scenarios = [
            ('mobile', 360, 640, 340, 470, [1, 5, 6, 12, 18, 30]),
            ('tablet', 834, 1112, 540, 760, [1, 5, 8, 12, 18, 24, 30]),
            ('desktop', 1440, 900, 760, 720, [1, 5, 8, 12, 18, 24, 30]),
        ]
        results = []
        for name, vw, vh, cw, ch, counts in scenarios:
            page.set_viewport_size({"width": vw, "height": vh})
            page.locator('#playersCard').evaluate('(el, dims) => { el.style.width=dims[0]+"px"; el.style.height=dims[1]+"px"; }', [cw, ch])
            for count in counts:
                page.evaluate('count => window.__test.addPlayers(count)', count)
                m = check(f'{name} players={count}', count)
                results.append((name, f'players={count}', m))

            # Live add/remove: no reload, exactly like a Socket.IO player list update.
            for count in (10, 3, 17, 2, 19):
                page.evaluate('count => window.__test.addPlayers(count)', count)
                m = check(f'{name} live players={count}', count)
                results.append((name, f'live={count}', m))

            # Rotate the available Player-grid area and fire the same lifecycle event as the app.
            page.locator('#playersCard').evaluate('(el, dims) => { el.style.width=dims[0]+"px"; el.style.height=dims[1]+"px"; }', [ch, cw])
            page.evaluate('''() => {
                window.dispatchEvent(new Event('orientationchange'));
            }''')
            page.evaluate('count => window.__test.addPlayers(count)', 11)
            m = check(f'{name} rotate', 11)
            results.append((name, 'rotate', m))

        # Screenshot-like wide/few-player check: a wide panel with only 12 players must use a
        # balanced number of columns and keep card/name sizes visibly readable.
        page.set_viewport_size({"width": 1440, "height": 900})
        page.locator('#playersCard').evaluate('(el) => { el.style.width="720px"; el.style.height="730px"; }')
        page.evaluate('count => window.__test.addPlayers(count)', 12)
        wait_grid()
        wide = page.evaluate('''() => {
            const el = document.getElementById('players');
            const cards = [...el.querySelectorAll('.player[data-pid]')];
            return {
                columns:Number(el.dataset.gridColumns||0),
                rows:Number(el.dataset.gridRows||0),
                sizes:cards.map(c=>c.getBoundingClientRect().width),
                textSizes:cards.map(c=>getComputedStyle(c.querySelector('.pname')).fontSize),
            };
        }''')
        assert_true(wide['columns'] <= 6, f'wide few-player grid has too many columns: {wide}')
        assert_true(min(wide['sizes']) >= 140, f'wide few-player cards are still too small: {wide}')
        assert_true(all(float(x.replace('px','')) >= 10 for x in wide['textSizes']), f'wide few-player text collapsed: {wide}')

        # Transient-layout protection: start with an unrealistically short grid, then let the panel
        # expand. The controller must not permanently keep the transient tiny-card measurement.
        page.locator('#playersCard').evaluate('(el) => { el.style.height="40px"; }')
        page.evaluate('count => window.__test.addPlayers(count)', 12)
        page.wait_for_timeout(35)
        page.locator('#playersCard').evaluate('(el) => { el.style.height="730px"; }')
        page.wait_for_timeout(140)
        settled = page.evaluate('''() => {
            const el = document.getElementById('players');
            const cards = [...el.querySelectorAll('.player[data-pid]')];
            return { columns:Number(el.dataset.gridColumns||0), sizes:cards.map(c=>c.getBoundingClientRect().width), status:el.dataset.gridFitStatus||'' };
        }''')
        assert_true(settled['columns'] <= 6, f'transient small measurement left too many columns: {settled}')
        assert_true(min(settled['sizes']) >= 140, f'transient small measurement left tiny cards: {settled}')
        assert_true(settled['status'] in ('fit','guarded'), f'transient state remained unresolved: {settled}')

        # Background -> foreground: corrupt the exact inline template, then rely on the real lifecycle hooks.
        page.locator('#playersCard').evaluate('(el) => { el.style.width="500px"; el.style.height="680px"; }')
        page.evaluate('count => window.__test.addPlayers(count)', 9)
        check('before-background', 9)
        page.evaluate("document.getElementById('players').style.setProperty('--player-grid-template','repeat(99, 1px)')")
        page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
        page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted:true }))")
        page.evaluate("window.dispatchEvent(new Event('orientationchange'))")
        m = check('background-foreground restore', 9)
        assert_true(m['columns'] < 99, f'background restore did not refit grid: {m}')
        results.append(('lifecycle', 'background→foreground', m))

        browser.close()

    print('player-html-grid-responsive-browser: PASS')
    print(f'checked states: {len(results)}')


if __name__ == '__main__':
    main()
