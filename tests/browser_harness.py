"""Shared browser-test bootstrap.

Browser tests are part of Bug Replay, so missing test infrastructure must be a
SKIP (exit code 77), not a product failure. When Chromium is available at a
known system path we use it; otherwise we let Playwright try its managed
browser installation before classifying launch failure as infrastructure.
"""

import os
import shutil


def _candidate_executables():
    values = [
        os.environ.get("WW_CHROMIUM_PATH"),
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
    ]
    unique = []
    seen = set()
    for value in values:
        if not value:
            continue
        if value in seen:
            continue
        seen.add(value)
        unique.append(value)
    # None means: let Playwright resolve its own installed browser.
    unique.append(None)
    return unique


def launch_chromium(playwright, **kwargs):
    """Launch Chromium or raise RuntimeError so callers can SKIP infrastructure."""
    errors: list[str] = []
    for executable_path in _candidate_executables():
        options = {"headless": True, "args": ["--no-sandbox"], **kwargs}
        if executable_path:
            options["executable_path"] = executable_path
        try:
            return playwright.chromium.launch(**options)
        except Exception as exc:  # pragma: no cover - environment-specific
            label = executable_path or "Playwright-managed Chromium"
            errors.append(f"{label}: {exc}")
    detail = " | ".join(errors[-3:])
    raise RuntimeError(f"Chromium browser unavailable: {detail}")
