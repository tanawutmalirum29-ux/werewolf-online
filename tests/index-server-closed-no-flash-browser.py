import asyncio
import re
from pathlib import Path
from playwright.async_api import async_playwright

from browser_harness import launch_chromium

ROOT = Path(__file__).resolve().parents[1]
INDEX = (ROOT / 'public' / 'index.html').read_text(encoding='utf-8')

STYLE = re.search(r'<style id="wwIndexBootGateStyle">(.*?)</style>', INDEX, re.S)
SCRIPT = re.search(r'<script id="wwIndexServerBootGate">(.*?)</script>', INDEX, re.S)
BOOT = re.search(r'<div id="wwIndexServerBoot".*?</div>\n<script>', INDEX, re.S)
if not STYLE or not SCRIPT or not BOOT:
    raise SystemExit('could not extract index boot gate fixture')

BOOT_MARKUP = BOOT.group(0).split('\n<script>', 1)[0]


def make_page(fetch_body: str, delay_ms: int) -> str:
    fetch_script = (
        "window.fetch=function(){return new Promise(function(resolve){"
        f"setTimeout(function(){{resolve({{ok:true,status:200,json:async function(){{return {fetch_body};}}}});}},"
        f"{delay_ms});"
        "});};"
    )
    return (
        '<!doctype html><html><head>'
        f'<style>{STYLE.group(1)}</style>'
        f'<script>{fetch_script}{SCRIPT.group(1)}</script>'
        '</head><body data-page="index">'
        f'{BOOT_MARKUP}'
        '</body></html>'
    )


async def run():
    async with async_playwright() as pw:
        browser = await launch_chromium(pw)
        try:
            page = await browser.new_page(viewport={"width": 1180, "height": 682})

            # Closed: while the probe is pending, a real Lobby child would remain invisible.
            await page.set_content(make_page('{serverOpen:false,noticeMessage:"ปิดปรับปรุง",reopenAt:0,serverNow:Date.now(),imageBase:"https://s3.example.test",imageVersion:"epoch-1",serverIconUrl:"https://s3.example.test/icons-server.png?v=epoch-1"}', 500), wait_until='domcontentloaded')
            await page.wait_for_timeout(40)
            pending = await page.evaluate('''({pending:document.documentElement.classList.contains('ww-index-server-pending'), bootDisplay:getComputedStyle(document.getElementById('wwIndexServerBoot')).display})''')
            assert pending['pending'], 'boot gate must keep the document in pending state while probe is unresolved'
            assert pending['bootDisplay'] == 'flex', 'boot screen must be visible while probe is unresolved'
            await page.wait_for_timeout(560)
            closed = await page.evaluate('''({closed:document.documentElement.classList.contains('ww-index-server-closed'),pending:document.documentElement.classList.contains('ww-index-server-pending'),title:document.querySelector('.wwIndexBootTitle')?.textContent,icon:getComputedStyle(document.querySelector('.wwIndexBootIcon')).backgroundImage})''')
            assert closed['closed'], 'closed response must switch the document to closed state'
            assert not closed['pending'], 'closed state must end the pending gate'
            assert closed['title'] == 'เซิร์ฟเวอร์กำลังปิด', 'closed state must immediately update the first-paint message'
            assert 'https://s3.example.test/icons-server.png?v=epoch-1' in closed['icon'], 'closed first-paint icon must resolve to the S3 icons-server.png asset via background-image'

            # Open: the probe resolves and the boot layer disappears.
            await page.close()
            page = await browser.new_page(viewport={"width": 1180, "height": 682})
            await page.set_content(make_page('{serverOpen:true,serverNow:Date.now()}', 80), wait_until='domcontentloaded')
            await page.wait_for_timeout(120)
            opened = await page.evaluate('''({pending:document.documentElement.classList.contains('ww-index-server-pending'),closed:document.documentElement.classList.contains('ww-index-server-closed'),bootDisplay:getComputedStyle(document.getElementById('wwIndexServerBoot')).display,hidden:document.getElementById('wwIndexServerBoot').hidden})''')
            assert not opened['pending'], 'open response must release the first-paint gate'
            assert not opened['closed'], 'open response must not leave the document in closed state'
            assert opened['bootDisplay'] == 'none' or opened['hidden'], 'boot screen must be hidden after an open response'

            # Lifecycle bridge: the same handler used by visibilitychange/pagehide/freeze must
            # neutralize a previously closed screen before a navigation snapshot is captured.
            await page.close()
            page = await browser.new_page(viewport={"width": 1180, "height": 682})
            await page.set_content(make_page('{serverOpen:false,noticeMessage:"ปิดปรับปรุง",reopenAt:0,serverNow:Date.now()}', 0), wait_until='domcontentloaded')
            await page.wait_for_timeout(60)
            before = await page.evaluate("({closed:document.documentElement.classList.contains('ww-index-server-closed'),pending:document.documentElement.classList.contains('ww-index-server-pending')})")
            assert before['closed'] and not before['pending'], 'closed fixture must settle in closed state before lifecycle simulation'
            await page.evaluate("window.__WW_INDEX_BOOT_GATE__.prepareForNavigation()")
            neutral = await page.evaluate("({closed:document.documentElement.classList.contains('ww-index-server-closed'),pending:document.documentElement.classList.contains('ww-index-server-pending'),bootHidden:document.getElementById('wwIndexServerBoot').hidden})")
            assert neutral['pending'] and not neutral['closed'] and not neutral['bootHidden'], 'navigation lifecycle must neutralize the old closed visual state'

            print('index-server-closed-no-flash-browser: PASS')
        finally:
            await browser.close()


asyncio.run(run())
