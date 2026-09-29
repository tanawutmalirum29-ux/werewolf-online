"""Browser-level regression for the user display-name input policy."""
from pathlib import Path
import re
import sys

try:
    from playwright.sync_api import sync_playwright
except Exception as exc:
    print(f"SKIP: Playwright unavailable: {exc}")
    raise SystemExit(77)

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_harness import launch_chromium  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "public/js/index.main.js").read_text(encoding="utf-8")
start = SOURCE.index('const NAME_MAX_LENGTH = 24;')
end = SOURCE.index('const indexSocket = io();', start)
POLICY = SOURCE[start:end]

assert 'event.key === " " || event.code === "Space"' in POLICY
assert 'input.addEventListener("input"' in POLICY

HTML = f'''<!doctype html><html><body>
<input id="name" type="text" maxlength="24">
<script>{POLICY}
window.bindNameInputRestrictions(document.getElementById("name"));
</script>
</body></html>'''

with sync_playwright() as pw:
    try:
        browser = launch_chromium(pw)
    except RuntimeError as exc:
        print(f"SKIP: {exc}")
        raise SystemExit(77)
    try:
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.set_content(HTML)
        page.locator("#name").fill("Alice")
        page.locator("#name").press("Space")
        page.locator("#name").type("Bob")
        assert page.locator("#name").input_value() == "AliceBob"

        page.locator("#name").evaluate("el => { el.value = 'Foo\\tBar Baz'; el.dispatchEvent(new Event('input', {bubbles:true})); }")
        assert page.locator("#name").input_value() == "FooBarBaz"

        assert page.evaluate("isReservedTesterNameInput('Player')") is True
        assert page.evaluate("isReservedTesterNameInput('PLAYER42')") is True
        assert page.evaluate("isReservedTesterNameInput('p l a y e r 7')") is True
        assert page.evaluate("isReservedTesterNameInput('ผู้เล่น')") is True
        assert page.evaluate("isReservedTesterNameInput('ผู้เล่น12')") is True
        assert page.evaluate("isReservedTesterNameInput('PlayerX')") is False
        print("name-policy-browser-regression: PASS")
    finally:
        browser.close()
