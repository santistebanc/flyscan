//! Decide whether navigation means that a human verification has completed.

use std::time::Duration;
use tauri::{webview::PageLoadEvent, Url};

const CHECK_PATH: &str = "/security/check";
const SETTLE_TIME: Duration = Duration::from_secs(2);

pub struct ChallengeNavigation {
    challenge: Url,
    loaded: Option<Url>,
    candidate: Option<(Url, Duration)>,
}

impl ChallengeNavigation {
    pub fn new(challenge: &Url) -> Self {
        Self {
            challenge: challenge.clone(),
            loaded: None,
            candidate: None,
        }
    }

    pub fn page_load(&mut self, url: &Url, event: PageLoadEvent) {
        self.loaded = match event {
            PageLoadEvent::Started => None,
            PageLoadEvent::Finished => Some(url.clone()),
        };
        self.candidate = None;
    }

    /// A blank/provisional/error page is never evidence of clearance. Require
    /// a finished load on the source site, outside the check, that stays put.
    pub fn observe(&mut self, current: &Url, elapsed: Duration) -> bool {
        let loaded = self
            .loaded
            .as_ref()
            .is_some_and(|url| url.origin() == current.origin() && url.path() == current.path());
        let on_check = current.path().trim_end_matches('/')
            == self.challenge.path().trim_end_matches('/')
            || current.path() == CHECK_PATH
            || current.path().starts_with("/security/check/");
        if !loaded || current.origin() != self.challenge.origin() || on_check {
            self.candidate = None;
            return false;
        }
        match &self.candidate {
            Some((url, since)) if url == current => elapsed.saturating_sub(*since) >= SETTLE_TIME,
            _ => {
                self.candidate = Some((current.clone(), elapsed));
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_blank_webview_does_not_complete_verification() {
        let challenge =
            Url::parse("https://www.momondo.ie/security/check?returnTo=%2Fflights").unwrap();
        let mut navigation = ChallengeNavigation::new(&challenge);
        assert!(
            !navigation.observe(&Url::parse("about:blank").unwrap(), Duration::ZERO),
            "The initial WebView page must not close the verification window"
        );
    }

    fn url(path: &str) -> Url {
        Url::parse(&format!("https://www.momondo.ie{path}")).unwrap()
    }

    #[test]
    fn slow_initial_navigation_and_the_loaded_check_stay_open() {
        let check = url("/security/check?returnTo=%2Fflights");
        let blank = Url::parse("about:blank").unwrap();
        let mut navigation = ChallengeNavigation::new(&check);
        navigation.page_load(&blank, PageLoadEvent::Finished);
        assert!(!navigation.observe(&blank, Duration::from_secs(3)));
        navigation.page_load(&check, PageLoadEvent::Started);
        assert!(!navigation.observe(&check, Duration::from_secs(5)));
        navigation.page_load(&check, PageLoadEvent::Finished);
        assert!(!navigation.observe(&check, Duration::from_secs(10)));
        assert!(!navigation.observe(&check, Duration::from_secs(120)));
    }

    #[test]
    fn completed_redirect_must_finish_loading_and_settle() {
        let check = url("/security/check");
        let destination = url("/flights/BER-LON");
        let mut navigation = ChallengeNavigation::new(&check);
        navigation.page_load(&check, PageLoadEvent::Finished);
        navigation.page_load(&destination, PageLoadEvent::Started);
        assert!(!navigation.observe(&destination, Duration::from_secs(5)));
        navigation.page_load(&destination, PageLoadEvent::Finished);
        assert!(!navigation.observe(&destination, Duration::from_secs(6)));
        assert!(!navigation.observe(&destination, Duration::from_millis(7999)));
        assert!(navigation.observe(&destination, Duration::from_secs(8)));
    }

    #[test]
    fn redirect_back_to_the_check_resets_completion() {
        let check = url("/security/check");
        let destination = url("/flights/BER-LON");
        let mut navigation = ChallengeNavigation::new(&check);
        navigation.page_load(&destination, PageLoadEvent::Finished);
        assert!(!navigation.observe(&destination, Duration::from_secs(1)));
        navigation.page_load(&check, PageLoadEvent::Started);
        assert!(!navigation.observe(&check, Duration::from_secs(2)));
        navigation.page_load(&check, PageLoadEvent::Finished);
        assert!(!navigation.observe(&check, Duration::from_secs(4)));
        navigation.page_load(&destination, PageLoadEvent::Finished);
        assert!(!navigation.observe(&destination, Duration::from_secs(5)));
        assert!(navigation.observe(&destination, Duration::from_secs(7)));
    }

    #[test]
    fn unrelated_sites_blank_and_error_pages_never_complete() {
        for address in [
            "about:blank",
            "chrome-error://chromewebdata/",
            "https://www.google.com/recaptcha/",
            "https://www.momondo.ie.example.org/flights",
            "http://www.momondo.ie/flights",
        ] {
            let current = Url::parse(address).unwrap();
            let mut navigation = ChallengeNavigation::new(&url("/security/check"));
            navigation.page_load(&current, PageLoadEvent::Finished);
            assert!(!navigation.observe(&current, Duration::ZERO), "{address}");
            assert!(
                !navigation.observe(&current, Duration::from_secs(10)),
                "{address}"
            );
        }
    }

    #[test]
    fn a_source_that_already_cleared_can_load_its_destination_directly() {
        let mut navigation = ChallengeNavigation::new(&url("/security/check"));
        let destination = url("/flights");
        navigation.page_load(&destination, PageLoadEvent::Finished);
        assert!(!navigation.observe(&destination, Duration::ZERO));
        assert!(navigation.observe(&destination, Duration::from_secs(2)));
    }

    #[test]
    fn new_navigation_cancels_a_settling_destination() {
        let mut navigation = ChallengeNavigation::new(&url("/security/check"));
        let destination = url("/flights");
        navigation.page_load(&destination, PageLoadEvent::Finished);
        assert!(!navigation.observe(&destination, Duration::ZERO));
        navigation.page_load(&destination, PageLoadEvent::Started);
        assert!(!navigation.observe(&destination, Duration::from_secs(3)));
    }
}
