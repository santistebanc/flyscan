"""The check page is tidied per source: consent accepted, everything but the captcha hidden."""

from pathlib import Path
from unittest import mock

import pytest

from flight_scraper import challenge
from flight_scraper.challenge_page import check_page_script

FIXTURE = Path(__file__).parent / "fixtures" / "momondo-security-check-reference.html"


def test_only_sources_with_a_custom_method_get_a_script():
    assert "accept all" in check_page_script("momondo")
    assert check_page_script("ff-kayak") == check_page_script("momondo")
    assert check_page_script("ff-sky") is None


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
    args = playwright.__enter__.return_value.chromium.launch_persistent_context.call_args.kwargs[
        "args"
    ]
    assert (
        "--app=https://www.momondo.ie/security/check" in args
        and "--hide-crash-restore-bubble" in args
    )


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
        box = page.locator("#check").bounding_box()
        size = page.viewport_size
        # Centred on the page rather than stuck in the corner of the site's layout.
        assert abs((box["x"] + box["width"] / 2) - size["width"] / 2) < 2
        assert abs((box["y"] + box["height"] / 2) - size["height"] / 2) < 2
        browser.close()
    assert [k for k, v in visible.items() if v] == ["check", "captcha", "robot", "go"]


LATE = """<!doctype html><body><header>site</header>
<main><section id="check"><h1>Security Check:</h1><p id="intro">Please confirm you are a human.</p>
<label><input type="checkbox" id="robot"> I'm not a robot</label></section></main><footer>foot</footer>
<script>setTimeout(() => {
  const go = document.createElement("a"); go.id = "go"; go.textContent = "Continue";
  go.href = "#"; document.getElementById("check").append(go);
}, 2500);</script></body>"""


def test_nothing_is_hidden_until_the_continue_button_has_rendered(tmp_path):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as driver:
        try:
            browser = driver.chromium.launch(headless=True)
        except Exception as exc:  # no browser installed
            pytest.skip(str(exc))
        page = browser.new_page()
        page.add_init_script(check_page_script("momondo"))
        (tmp_path / "late.html").write_text(LATE)
        page.goto((tmp_path / "late.html").as_uri())
        page.wait_for_timeout(200)
        early = page.is_visible("#intro"), page.is_visible("footer")
        page.wait_for_timeout(4500)
        late = {n: page.is_visible(n) for n in ("#intro", "#robot", "#go", "footer", "header")}
        browser.close()
    assert early == (True, True)
    assert late == {"#intro": True, "#robot": True, "#go": True, "footer": False, "header": False}


def test_tidied_check_opens_zoomed_in_a_bare_window_of_an_explicit_size(tmp_path):
    page = mock.Mock(url="https://www.momondo.ie/home")
    context = mock.Mock(pages=[page], cookies=lambda: [])
    cdp = context.new_cdp_session.return_value
    cdp.send.side_effect = lambda method, params=None: {"windowId": 7} if "get" in method else {}
    playwright = mock.MagicMock()
    launch = playwright.__enter__.return_value.chromium.launch_persistent_context
    launch.return_value = context
    module = mock.Mock(sync_playwright=lambda: playwright)
    with mock.patch.dict("sys.modules", {"playwright": mock.Mock(), "playwright.sync_api": module}):
        challenge.solve(
            "ff-kayak",
            "https://www.flightsfinder.com/security/check",
            store=challenge.ChallengeStore(tmp_path),
            wait_seconds=1,
        )
    kwargs = launch.call_args.kwargs
    width, height = round(1280 / 1.3), round(900 / 1.3)
    assert "--app=https://www.flightsfinder.com/security/check" in kwargs["args"]
    assert "--force-device-scale-factor=1.3" in kwargs["args"]
    assert f"--window-size={width},{height}" in kwargs["args"]
    # The window, not an emulated viewport, sets the page size, so the zoom applies.
    assert kwargs.get("no_viewport") is True and "viewport" not in kwargs
    # Chromium's remembered app-window size is overridden explicitly.
    cdp.send.assert_any_call(
        "Browser.setWindowBounds",
        {
            "windowId": 7,
            "bounds": {
                "left": 0,
                "top": 0,
                "width": width,
                "height": height,
                "windowState": "normal",
            },
        },
    )


def test_an_untidied_check_keeps_an_ordinary_window(tmp_path):
    page = mock.Mock(url="https://x.test/home")
    context = mock.Mock(pages=[page], cookies=lambda: [])
    playwright = mock.MagicMock()
    launch = playwright.__enter__.return_value.chromium.launch_persistent_context
    launch.return_value = context
    module = mock.Mock(sync_playwright=lambda: playwright)
    with mock.patch.dict("sys.modules", {"playwright": mock.Mock(), "playwright.sync_api": module}):
        challenge.solve(
            "ff-sky",
            "https://x.test/security/check",
            store=challenge.ChallengeStore(tmp_path),
            wait_seconds=1,
        )
    kwargs = launch.call_args.kwargs
    assert not [a for a in kwargs["args"] if a.startswith(("--app=", "--force-device-scale"))]
    assert kwargs["viewport"] == {"width": 1280, "height": 900}
    context.new_cdp_session.assert_not_called()
