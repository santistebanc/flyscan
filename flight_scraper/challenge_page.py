"""Per-source tidying of the check page a person is about to clear.

Some sources wrap their check in a cookie-consent popup and a full site chrome. For those
the person sees only what is needed: the consent is accepted for them and everything that is
not the captcha is hidden. Hiding is cosmetic — the captcha and its Continue button are left
untouched and the person still clears it. A source without an entry is shown as it is, and
when the page is not recognised nothing is hidden.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Dict, Optional, Tuple


@dataclass(frozen=True)
class CheckPageTweak:
    #: Button labels (case-insensitive, whole text) that accept the cookie consent.
    consent_buttons: Tuple[str, ...] = ()
    #: CSS selectors that find the captcha; the first present one anchors the page.
    captcha_selectors: Tuple[str, ...] = ()
    #: Label of the button that submits the check, kept visible with the captcha.
    continue_button: str = "continue"
    #: Browser zoom for the check window. The check is shown scaled down in a viewer, so it is
    #: drawn larger here (the captcha's own image grid included).
    scale: float = 1.3


#: Momondo's check and the Kayak engine's (FlightsFinder) are the same page: a consent popup over
#: "Security Check", a reCAPTCHA box and Continue.
_KAYAK_ENGINE_CHECK = CheckPageTweak(
    consent_buttons=("accept all",),
    captcha_selectors=(
        'iframe[src*="recaptcha"]',
        ".g-recaptcha",
        '[class*="captcha" i]',
        'input[type="checkbox"]',
    ),
)

CHECK_PAGE_TWEAKS: Dict[str, CheckPageTweak] = {
    "momondo": _KAYAK_ENGINE_CHECK,
    "ff-kayak": _KAYAK_ENGINE_CHECK,
}

_SCRIPT = r"""
(() => {
  const cfg = __CONFIG__;
  const HIDDEN = "data-fs-hidden";
  const FILLED = "data-fs-filled";
  const consent = new RegExp("^\\s*(" + cfg.consent_buttons.join("|") + ")\\s*$", "i");
  const cont = new RegExp("^\\s*" + cfg.continue_button + "\\s*$", "i");
  const clicked = new WeakSet();
  const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);

  // Every element, descending through open shadow roots.
  const all = (root) => {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) out.push(...all(el.shadowRoot));
    }
    return out;
  };
  const text = (el) => (el.innerText || el.textContent || el.value || "").trim();

  const acceptConsent = () => {
    if (!cfg.consent_buttons.length) return;
    for (const el of all(document)) {
      if (el.matches && el.matches('button, [role="button"], input[type="button"]')
          && !clicked.has(el) && consent.test(text(el))) {
        clicked.add(el);
        el.click();
      }
    }
  };

  const findCaptcha = () => {
    for (const selector of cfg.captcha_selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  };

  // The captcha together with the check's own button: the smallest ancestor holding both.
  // Until the button has rendered there is no telling what belongs to the check, so nothing is
  // hidden yet (null); the next pass tries again.
  const CLICKABLE = 'button, a, [role="button"], input[type="submit"], input[type="button"]';
  const findKeeper = (captcha) => {
    for (let el = captcha; el && el !== document.body; el = el.parentElement) {
      for (const button of el.querySelectorAll(CLICKABLE)) {
        if (cont.test(text(button))) return el;
      }
    }
    return null;
  };

  // A challenge the captcha opens (image grid) lives in its own frame; never hide that.
  const holdsCaptchaFrame = (el) =>
    el.matches('iframe[src*="captcha"]') || Boolean(el.querySelector('iframe[src*="captcha"]'));

  const tidy = () => {
    const captcha = findCaptcha();
    if (!captcha) return;
    const keeper = findKeeper(captcha);
    if (!keeper) return;
    for (let el = keeper; el && el !== document.documentElement; el = el.parentElement) {
      const parent = el.parentElement;
      if (!parent) break;
      for (const sibling of parent.children) {
        if (sibling === el || SKIP.has(sibling.tagName) || sibling.hasAttribute(HIDDEN)) continue;
        if (holdsCaptchaFrame(sibling)) continue;
        sibling.setAttribute(HIDDEN, "");
        sibling.style.setProperty("display", "none", "important");
      }
    }
    fill(keeper);
  };

  // What is left is small: centre it on a plain page, rather than leave it in the corner
  // of the site's own layout (a purple page with a white content block).
  const fill = (keeper) => {
    if (document.documentElement.hasAttribute(FILLED)) return; // once, never nested
    document.documentElement.setAttribute(FILLED, "");
    for (const el of [document.documentElement, document.body]) {
      el.style.setProperty("background", "#fff", "important");
      el.style.setProperty("margin", "0", "important");
    }
    const style = {
      position: "fixed", inset: "0", display: "flex", "flex-direction": "column",
      "align-items": "center", "justify-content": "center", margin: "0", padding: "16px",
      width: "auto", height: "auto", "max-width": "none", "min-height": "0",
      background: "#fff", "z-index": "1",
    };
    for (const [name, value] of Object.entries(style)) keeper.style.setProperty(name, value, "important");
  };

  const run = () => { try { acceptConsent(); tidy(); } catch (_) {} };
  const start = () => {
    run();
    new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(run, 1000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
"""


def check_page_script(source: str) -> Optional[str]:
    """JavaScript to run on every page of ``source``'s check, or None if it is shown as is."""
    tweak = CHECK_PAGE_TWEAKS.get(source)
    if tweak is None:
        return None
    config = {
        "consent_buttons": list(tweak.consent_buttons),
        "captcha_selectors": list(tweak.captcha_selectors),
        "continue_button": tweak.continue_button,
    }
    return _SCRIPT.replace("__CONFIG__", json.dumps(config))
