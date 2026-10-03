#!/usr/bin/env python3
"""Auth + page-render smoke test against a running dev server.

    python3 scripts/e2e-smoke.py [--base http://localhost:3000] [--shots-dir DIR]

Reads E2E_USER_EMAIL / E2E_USER_PASSWORD from ../.env.local (or env).
Logs in through the real /auth/login password form, then visits every major
page in light and dark mode, failing on console errors or error text.
"""
import argparse
import os
import re
import sys

from playwright.sync_api import sync_playwright

ROUTES = [
    ("/", "dashboard"),
    ("/analytics", "analytics"),
    ("/leads", "leads"),
    ("/journeys", "journeys"),
    ("/journeys/builder", "builder"),
    ("/settings", "settings"),
    ("/settings/ai-agents", "ai-agents"),
    ("/settings/custom-fields", "custom-fields"),
    ("/suppressions", "suppressions"),
    ("/operations", "operations"),
    ("/errors", "errors"),
    ("/audit", "audit"),
    ("/leads/import", "csv-import"),
]

# Benign noise we don't fail on (3rd-party, favicons, aborted fetches on nav).
IGNORE = re.compile(r"favicon|net::ERR_ABORTED|hydration|Download the React DevTools", re.I)


def load_env():
    path = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    if os.path.exists(path):
        for line in open(path):
            m = re.match(r"^([A-Z0-9_]+)=(.*)$", line.strip())
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:3000")
    ap.add_argument("--shots-dir", default=None, help="Save per-page screenshots here")
    args = ap.parse_args()

    load_env()
    email = os.environ.get("E2E_USER_EMAIL")
    password = os.environ.get("E2E_USER_PASSWORD")
    if not email or not password:
        print("E2E_USER_EMAIL / E2E_USER_PASSWORD not set (seed with scripts/seed-e2e-user.mjs)")
        return 1

    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        console_errors = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" and not IGNORE.search(m.text) else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        # --- Login through the real form ---
        page.goto(f"{args.base}/auth/login", wait_until="networkidle")
        page.fill("#login-email", email)
        page.fill("#login-password", password)
        page.click("button[type=submit]")
        try:
            page.wait_for_url(f"{args.base}/", timeout=15000)
        except Exception:
            body = page.inner_text("body")[:300]
            print(f"LOGIN FAILED — still on {page.url}\n{body}")
            return 1
        print(f"Login OK as {email}")

        for theme in ("light", "dark"):
            page.evaluate(
                "t => { localStorage.setItem('theme', t); document.documentElement.classList.toggle('dark', t === 'dark') }",
                theme,
            )
            for route, name in ROUTES:
                console_errors.clear()
                try:
                    page.goto(f"{args.base}{route}", wait_until="networkidle", timeout=30000)
                except Exception as e:
                    failures.append(f"{theme} {route}: navigation failed ({e})")
                    continue
                if "/auth/login" in page.url:
                    failures.append(f"{theme} {route}: bounced to login (session lost)")
                    continue
                body = page.inner_text("body")
                for marker in ("Application error", "Unhandled Runtime Error", "This page could not be found"):
                    if marker in body:
                        failures.append(f"{theme} {route}: page shows '{marker}'")
                if console_errors:
                    failures.append(f"{theme} {route}: console errors: {console_errors[:2]}")
                if args.shots_dir:
                    os.makedirs(args.shots_dir, exist_ok=True)
                    page.screenshot(path=os.path.join(args.shots_dir, f"{name}_{theme}.png"))
                print(f"  ok {theme:5s} {route}")
        browser.close()

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(" -", f)
        return 1
    print("\nAll pages rendered clean in both themes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
