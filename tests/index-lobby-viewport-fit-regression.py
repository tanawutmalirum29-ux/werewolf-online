#!/usr/bin/env python3
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / 'public' / 'index.html'
CSS = ROOT / 'public' / 'css' / 'index.css'

VIEWPORTS = [
    ('portrait-small', 320, 568),
    ('portrait-compact', 360, 640),
    ('portrait-phone', 390, 844),
    ('portrait-tall-phone', 375, 667),
    ('landscape-phone', 568, 320),
    ('landscape-tablet', 844, 390),
    ('tablet-portrait', 768, 1024),
    ('desktop-short', 960, 540),
    ('desktop', 1366, 768),
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
    body = body.replace('<body data-page="index">', '<body data-page="index">')
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head>{body}</html>'''


def main():
    index_html = INDEX.read_text()
    assert '<img src=\"\"' not in index_html, 'Index boot gate must not use an empty image src'
    assert '<div class=\"wwIndexBootIcon\" aria-hidden=\"true\"></div>' in index_html, 'Index boot gate must use a non-resource icon container before server state is known'
    assert 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=' not in index_html, 'Index boot gate must not use the retired 1x1 data-image placeholder'
    fixture = build_fixture()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium')
        page = browser.new_page(device_scale_factor=1)
        page.set_content(fixture, wait_until='domcontentloaded')
        page.add_style_tag(content='''
            #wwIndexServerBoot,#wwUpdateOverlay,#gameActionStatus,#accountRecreateOverlay,#statsModal{display:none!important}
            .name-badge{display:none!important}
        ''')

        for label, width, height in VIEWPORTS:
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(30)
            metrics = page.evaluate('''() => {
                const root = document.documentElement;
                const body = document.body;
                const lobby = document.getElementById('lobbyPage');
                const layout = document.querySelector('.lobby-layout');
                const card = document.querySelector('.card');
                const rect = card ? card.getBoundingClientRect() : null;
                const visible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.top >= -1 && r.left >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
                };
                return {
                    innerWidth, innerHeight,
                    rootScrollHeight: root.scrollHeight,
                    bodyScrollHeight: body.scrollHeight,
                    rootClientHeight: root.clientHeight,
                    bodyClientHeight: body.clientHeight,
                    lobbyScrollHeight: lobby ? lobby.scrollHeight : 0,
                    layoutScrollHeight: layout ? layout.scrollHeight : 0,
                    cardScrollHeight: card ? card.scrollHeight : 0,
                    cardClientHeight: card ? card.clientHeight : 0,
                    cardGap: card ? getComputedStyle(card).gap : '',
                    cardRect: rect ? {top:rect.top,left:rect.left,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height} : null,
                    brandVisible: visible(document.querySelector('.lobby-brand-block')),
                    controlsVisible: visible(document.querySelector('.lobby-controls')),
                    hostVisible: visible(document.querySelector('.btn-host')),
                    playerVisible: visible(document.querySelector('.btn-player')),
                    bodyOverflowY: getComputedStyle(body).overflowY,
                    grid: card ? getComputedStyle(card).gridTemplateColumns : ''
                };
            }''')

            assert_true(metrics['rootScrollHeight'] <= metrics['rootClientHeight'] + 1,
                        f'{label}: document scrolls vertically: {metrics}')
            assert_true(metrics['bodyScrollHeight'] <= metrics['bodyClientHeight'] + 1,
                        f'{label}: body scrolls vertically: {metrics}')
            assert_true(metrics['brandVisible'] and metrics['controlsVisible'],
                        f'{label}: main lobby content is not fully visible: {metrics}')
            assert_true(metrics['hostVisible'] and metrics['playerVisible'],
                        f'{label}: primary actions are not visible: {metrics}')
            assert_true(metrics['cardRect'] and metrics['cardRect']['bottom'] <= height + 1,
                        f'{label}: lobby card extends below viewport: {metrics}')

            if width > height and width <= 959 and height <= 600:
                columns = metrics['grid']
                assert_true(columns.count(' ') >= 1,
                            f'{label}: compact landscape did not use two columns: {columns}')

            gap = float(metrics['cardGap'].replace('px', '') or 0)
            if label in {'desktop-short', 'desktop', 'tablet-portrait', 'portrait-phone'}:
                assert_true(gap >= 9, f'{label}: lobby sections are visually too tightly coupled: gap={metrics["cardGap"]}')
            if label in {'portrait-small', 'portrait-compact', 'portrait-tall-phone'}:
                assert_true(gap <= 1, f'{label}: compact portrait spacing must stay collapsed to protect viewport fit: gap={metrics["cardGap"]}')
            if label in {'landscape-phone', 'landscape-tablet'}:
                assert_true(gap >= 7, f'{label}: landscape lobby needs a visible section separation: gap={metrics["cardGap"]}')

        browser.close()

    print('index-lobby-viewport-fit-regression: PASS')


if __name__ == '__main__':
    main()
