from pathlib import Path
import re
from playwright.sync_api import sync_playwright
from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
HOST_HTML = (ROOT / 'public' / 'host.html').read_text()
HOST_CSS = (ROOT / 'public' / 'css' / 'host.css').read_text()


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def build_harness():
    html = HOST_HTML
    html = re.sub(r'<script\b[^>]*src=["\'][^"\']*["\'][^>]*>\s*</script\s*>', '', html, flags=re.I)
    html = re.sub(r'<script\b[^>]*>.*?</script\s*>', '', html, flags=re.I | re.S)
    html = re.sub(r'<link\b[^>]*>', '', html, flags=re.I)
    html = html.replace('</head>', f'<style>{HOST_CSS}</style></head>')
    return html


def snapshot(page):
    return page.evaluate("""() => {
        const list = document.getElementById('list');
        const player = document.getElementById('playerCard');
        const toolbar = document.querySelector('.player-toolbar');
        const cards = [...list.querySelectorAll('.player[data-id]')];
        const lr = list.getBoundingClientRect();
        const pr = player.getBoundingClientRect();
        const tr = toolbar.getBoundingClientRect();
        const outside = cards.filter(c => {
            const r = c.getBoundingClientRect();
            return r.left < -0.75 || r.right > innerWidth + 0.75 || r.top < -0.75 || r.bottom > innerHeight + 0.75;
        });
        const zero = cards.filter(c => {
            const r = c.getBoundingClientRect();
            return r.width <= 0 || r.height <= 0;
        });
        const gcs = getComputedStyle(list);
        return {
            viewport: {w: innerWidth, h: innerHeight},
            playerCard: {x: pr.x, y: pr.y, w: pr.width, h: pr.height},
            toolbar: {x: tr.x, y: tr.y, w: tr.width, h: tr.height, scrollWidth: toolbar.scrollWidth, clientWidth: toolbar.clientWidth},
            list: {x: lr.x, y: lr.y, w: lr.width, h: lr.height, cols: gcs.gridTemplateColumns, rows: gcs.gridTemplateRows},
            count: cards.length,
            outside: outside.length,
            zero: zero.length,
            first: cards[0] ? (()=>{const r=cards[0].getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})() : null,
            last: cards.at(-1) ? (()=>{const r=cards.at(-1).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})() : null,
            bodyHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
        };
    }""")


def main():
    harness = build_harness()
    with sync_playwright() as p:
        try:
            browser = launch_chromium(p)
        except RuntimeError as exc:
            print(f'SKIP: {exc}')
            return 77

        page = browser.new_page(viewport={'width': 696, 'height': 601}, device_scale_factor=2)
        page.set_content(harness, wait_until='load')
        page.evaluate("""() => {
            document.body.className = 'is-day host-game-mode';
            document.querySelector('.layout')?.classList.add('role-hidden');
            document.getElementById('playerCard')?.classList.remove('hidden');
            ['testerModeBtn','botManagerBtn','closeRoomBtn','newRoomBtn','roomSettingsBtn'].forEach(id => document.getElementById(id)?.classList.remove('hidden'));
            const list = document.getElementById('list');
            list.innerHTML = '';
            for (let i = 0; i < 29; i++) {
                const card = document.createElement('div');
                card.className = 'player';
                card.dataset.id = `p${i}`;
                card.innerHTML = `<div class="player-inner"><div class="avatar">🐺</div><div class="pname">Player ${i+1}</div><div class="status">มีชีวิต</div></div>`;
                list.appendChild(card);
            }
        }""")
        page.wait_for_timeout(120)

        results = []
        for vw, vh in [(390,700),(480,700),(600,600),(696,601),(768,600),(834,600),(1024,601),(1180,682)]:
            page.set_viewport_size({'width': vw, 'height': vh})
            page.wait_for_timeout(90)
            m = snapshot(page)
            assert_true(m['count'] == 29, f'{vw}x{vh}: wrong card count {m}')
            assert_true(m['zero'] == 0, f'{vw}x{vh}: zero-size card {m}')
            assert_true(m['outside'] == 0, f'{vw}x{vh}: card outside viewport {m}')
            assert_true(m['list']['w'] <= vw + 0.75, f'{vw}x{vh}: list wider than viewport {m}')
            assert_true(m['toolbar']['scrollWidth'] <= m['toolbar']['clientWidth'] + 0.75, f'{vw}x{vh}: toolbar clipped/overflowing {m}')
            assert_true(m['first']['x'] >= 0 and m['last']['x'] + m['last']['w'] <= vw + 0.75, f'{vw}x{vh}: horizontal card bounds invalid {m}')
            results.append(m)

        # Live add/remove churn at the exact incident viewport.
        page.set_viewport_size({'width': 696, 'height': 601})
        for count in [1,5,12,20,29,28,29,15,29]:
            page.evaluate("""count => {
                const list = document.getElementById('list');
                list.innerHTML = '';
                for (let i = 0; i < count; i++) {
                    const card = document.createElement('div');
                    card.className = 'player'; card.dataset.id = `live-${i}`;
                    card.innerHTML = `<div class="player-inner"><div class="avatar">🐺</div><div class="pname">Live ${i+1}</div></div>`;
                    list.appendChild(card);
                }
            }""", count)
            page.wait_for_timeout(60)
            m = snapshot(page)
            assert_true(m['count'] == count, f'live count {count}: mismatch {m}')
            assert_true(m['outside'] == 0, f'live count {count}: outside card {m}')
            assert_true(m['zero'] == 0, f'live count {count}: zero-size card {m}')

        # Recreate 29 cards and emulate focus enter -> exit DOM state change.
        page.evaluate("""() => {
            const list = document.getElementById('list');
            list.innerHTML = '';
            for (let i = 0; i < 29; i++) {
                const card = document.createElement('div'); card.className='player'; card.dataset.id=`focus-${i}`;
                card.innerHTML='<div class="player-inner"><div class="avatar">🐺</div><div class="pname">Focus '+(i+1)+'</div></div>';
                list.appendChild(card);
            }
            document.documentElement.classList.add('host-player-focus');
            document.body.classList.add('host-player-focus');
        }""")
        page.wait_for_timeout(80)
        focus = snapshot(page)
        assert_true(focus['outside'] == 0, f'focus state layout invalid {focus}')
        page.evaluate("""() => {
            document.documentElement.classList.remove('host-player-focus');
            document.body.classList.remove('host-player-focus');
            document.querySelector('.app')?.scrollTo(0, 0);
            window.scrollTo(0, 0);
        }""")
        page.wait_for_timeout(100)
        exit_focus = snapshot(page)
        assert_true(exit_focus['count'] == 29, f'focus exit lost cards {exit_focus}')
        assert_true(exit_focus['outside'] == 0, f'focus exit produced offscreen cards {exit_focus}')

        browser.close()

    print('host-player-grid-29-viewport-browser: PASS')
    print(f'checked viewport states: {len(results)} + live-churn + focus-exit')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
