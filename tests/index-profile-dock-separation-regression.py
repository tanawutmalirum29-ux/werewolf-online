#!/usr/bin/env python3
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / 'public' / 'index.html'
CSS = ROOT / 'public' / 'css' / 'index.css'
JS = ROOT / 'public' / 'js' / 'index.main.js'

# These are the layouts where the always-visible Profile dock is intentionally allowed.
VIEWPORTS = [
    ('dock-minimum', 1120, 560),
    ('ipad-landscape', 1180, 578),
    ('tablet-landscape', 1194, 834),
    ('desktop-medium', 1280, 800),
    ('desktop', 1366, 768),
    ('desktop-large', 1440, 900),
    ('desktop-wide', 1600, 900),
]


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def build_fixture():
    html = INDEX.read_text()
    css = CSS.read_text()
    start = html.index('<body data-page="index">')
    body = html[start:]
    body = body.split('<script src="js/index.main.js', 1)[0]
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head>{body}</html>'''


def main():
    html = INDEX.read_text()
    js = JS.read_text()
    css = CSS.read_text()

    assert_true('src=""' not in html, 'Index must not contain empty image sources')
    assert_true('(min-width: 1120px) and (min-height: 560px)' in js,
                'Profile dock breakpoint must remain space-based at 1000x560 or above')
    assert_true('--profile-dock-gap:34px;' in css,
                'Profile dock must reserve an explicit visual gutter')
    assert_true('padding-right:calc(var(--profile-dock-width, 320px) + var(--profile-dock-gap, 34px));' in css,
                'Index viewport-fit layer must preserve the Profile dock gutter')

    fixture = build_fixture()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium')
        page = browser.new_page(device_scale_factor=1)
        page.set_content(fixture, wait_until='domcontentloaded')
        page.add_style_tag(content='''
            #wwIndexServerBoot,#gameActionStatus,#accountRecreateOverlay{display:none!important}
            .name-badge{display:none!important}
        ''')

        for label, width, height in VIEWPORTS:
            page.set_viewport_size({'width': width, 'height': height})
            page.evaluate('''() => {
                document.body.classList.add('profile-docked');
                document.getElementById('statsModal').classList.remove('hidden');
            }''')
            page.wait_for_timeout(30)
            metrics = page.evaluate('''() => {
                const card = document.querySelector('.card');
                const profile = document.querySelector('#statsModal .stats-modal-box');
                const lobby = document.getElementById('lobbyPage');
                const r1 = card.getBoundingClientRect();
                const r2 = profile.getBoundingClientRect();
                const lr = lobby.getBoundingClientRect();
                return {
                    card: {left:r1.left,right:r1.right,top:r1.top,bottom:r1.bottom,width:r1.width,height:r1.height},
                    profile: {left:r2.left,right:r2.right,top:r2.top,bottom:r2.bottom,width:r2.width,height:r2.height},
                    lobby: {left:lr.left,right:lr.right,top:lr.top,bottom:lr.bottom,width:lr.width,height:lr.height},
                    gap: r2.left-r1.right,
                    viewportGapRight: innerWidth-r2.right,
                    rootSW: document.documentElement.scrollWidth,
                    rootSH: document.documentElement.scrollHeight,
                    rootCW: document.documentElement.clientWidth,
                    rootCH: document.documentElement.clientHeight,
                    bodySH: document.body.scrollHeight,
                    bodyCH: document.body.clientHeight,
                    profileDisplay:getComputedStyle(profile).display,
                    reserve:getComputedStyle(lobby).paddingRight,
                };
            }''')

            assert_true(metrics['gap'] >= 24,
                        f'{label}: Lobby and Profile are too close: {metrics}')
            assert_true(metrics['card']['right'] <= metrics['profile']['left'] - 24,
                        f'{label}: Lobby/Profile visual separation regressed: {metrics}')
            assert_true(metrics['profile']['right'] <= width + 1,
                        f'{label}: Profile extends past viewport: {metrics}')
            assert_true(metrics['card']['left'] >= -1 and metrics['card']['bottom'] <= height + 1,
                        f'{label}: Lobby card is not fully inside viewport: {metrics}')
            assert_true(metrics['rootSW'] <= metrics['rootCW'] + 1,
                        f'{label}: horizontal document overflow: {metrics}')
            assert_true(metrics['rootSH'] <= metrics['rootCH'] + 1,
                        f'{label}: vertical document overflow: {metrics}')
            assert_true(metrics['bodySH'] <= metrics['bodyCH'] + 1,
                        f'{label}: body overflow: {metrics}')

            page.evaluate('''() => {
                document.body.classList.remove('profile-docked');
                document.getElementById('statsModal').classList.add('hidden');
            }''')

        browser.close()

    print('index-profile-dock-separation-regression: PASS')


if __name__ == '__main__':
    main()
