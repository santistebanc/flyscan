"""The check page is tidied per source: consent accepted, everything but the captcha hidden."""

from pathlib import Path
from unittest import mock

import pytest

from flight_scraper import challenge
from flight_scraper.challenge_page import check_page_script

FIXTURE = Path(__file__).parent / "fixtures" / "momondo-security-check-reference.html"


def test_only_sources_with_a_custom_method_get_a_script():
    assert "accept all" in check_page_script("momondo")
    assert check_page_script("ff-kayak") is None


def test_solve_installs_the_script_before_opening_the_check(tmp_path):
    events = []
    page = mock.Mock(url="https://www.momondo.ie/home")
    page.goto.side_effect = lambda *a, **k: events.append("goto")
    context = mock.Mock(pages=[page], cookies=lambda: [])
    context.add_init_script.side_effect = lambda script: events.append("script")
    playwright = mock.MagicMock()
    playwright.__enter__.return_value.chromium.launch_persistent_context.return_value = context
    module = mock.Mock(sync_playwright=lambda: playwright)
    with mock.patch.dict("sys.modules", {"playwright": mock.Mock(), "playwright.sync_api": module}):
        challenge.solve(
            "momondo",
            "https://www.momondo.ie/security/check",
            store=challenge.ChallengeStore(tmp_path),
            wait_seconds=1,
        )
    assert events[:2] == ["script", "goto"]


def test_script_accepts_consent_and_hides_all_but_the_captcha():
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as driver:
        try:
            browser = driver.chromium.launch(headless=True)
        except Exception as exc:  # no browser installed
            pytest.skip(str(exc))
        page = browser.new_page()
        page.add_init_script(check_page_script("momondo"))
        page.goto(FIXTURE.as_uri())  # a local file: no network
        page.wait_for_timeout(300)
        visible = {
            name: page.is_visible(f"#{name}")
            for name in ("chrome", "side", "promo", "foot", "check", "captcha", "robot", "go")
        }
        assert page.evaluate("window.accepted") == 1
        browser.close()
    assert [k for k, v in visible.items() if v] == ["check", "captcha", "robot", "go"]
