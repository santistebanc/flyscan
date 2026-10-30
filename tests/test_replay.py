"""Run every recorded search against its recording, and never the network.

Each case under `tests/recordings/` is one real search someone captured with
`flyscan capture`. Replaying it re-runs the parser over the exact bytes
the site sent, and checks both how many offers came out *and* a digest of what
was in them — markup that still parses but loses flight numbers is the failure
that a count alone waves through.
"""

import unittest
from pathlib import Path

from flyscan.capture import (
    Exchange,
    PlayerSession,
    Recording,
    RecordingMissing,
    digest_offers,
    replay,
)

RECORDINGS = Path(__file__).parent / "recordings"


def cases():
    return sorted(p for p in RECORDINGS.glob("*") if (p / "index.json").exists())


class Recordings(unittest.TestCase):
    """Every recording still parses to what it parsed to when it was taken."""

    def test_there_is_at_least_one_recording(self):
        self.assertTrue(cases(), f"no recordings under {RECORDINGS}")

    def test_each_recording_replays_to_its_recorded_outcome(self):
        for directory in cases():
            with self.subTest(case=directory.name):
                recording = Recording.load(directory)
                expected_error = recording.expect.get("error")

                if expected_error:
                    # A capture of a failure is worth keeping — it is the bytes
                    # that broke, which is the whole reason this exists. What
                    # it must do is fail the same way.
                    with self.assertRaises(Exception) as caught:
                        replay(recording)
                    self.assertEqual(
                        f"{type(caught.exception).__name__}: {caught.exception}",
                        expected_error,
                    )
                    continue

                offers = replay(recording)
                self.assertEqual(
                    len(offers),
                    recording.expect["offers"],
                    f"{directory.name}: offer count moved",
                )
                self.assertEqual(
                    digest_offers(offers),
                    recording.expect["digest"],
                    f"{directory.name}: the offers parsed differently — prices, "
                    f"flight numbers or times have changed",
                )

    def test_recorded_bodies_are_whole(self):
        """A clipped body replays as a parse error that looks like a bug."""
        for directory in cases():
            with self.subTest(case=directory.name):
                recording = Recording.load(directory)
                cut = [e.url for e in recording.exchanges if e.truncated]
                self.assertEqual(cut, [], "re-record these; they were truncated")


class Player(unittest.TestCase):
    """The player's contract: in order, no network, loud when it cannot answer."""

    def recording(self, exchanges, bodies) -> Recording:
        import tempfile

        directory = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: None)
        for name, body in bodies.items():
            (directory / name).write_bytes(body)
        return Recording(
            directory=directory,
            source="ff-sky",
            query={"origin": "BER", "destination": "CDG", "depart": "2026-09-21"},
            exchanges=exchanges,
        )

    def test_repeated_calls_walk_forward(self):
        """These sources poll one endpoint many times.

        Answering with the first recording every time would loop a poll until
        its deadline instead of reaching the response that ends it.
        """
        recording = self.recording(
            [
                Exchange("POST", "https://x/poll", body_file="a", bytes=1),
                Exchange("POST", "https://x/poll", body_file="b", bytes=1),
            ],
            {"a": b"first", "b": b"second"},
        )
        player = PlayerSession(recording)
        self.assertEqual(player.post("https://x/poll").content, b"first")
        self.assertEqual(player.post("https://x/poll").content, b"second")

    def test_running_out_is_an_error_not_a_repeat(self):
        recording = self.recording(
            [Exchange("POST", "https://x/poll", body_file="a", bytes=1)],
            {"a": b"only"},
        )
        player = PlayerSession(recording)
        player.post("https://x/poll")
        with self.assertRaises(RecordingMissing):
            player.post("https://x/poll")

    def test_an_unrecorded_url_never_reaches_the_network(self):
        recording = self.recording(
            [Exchange("GET", "https://x/page", body_file="a", bytes=1)],
            {"a": b"page"},
        )
        with self.assertRaises(RecordingMissing):
            PlayerSession(recording).get("https://somewhere-else/")

    def test_a_truncated_body_is_refused(self):
        """Replaying half a JSON body looks exactly like a scraper bug."""
        recording = self.recording(
            [Exchange("GET", "https://x/big", body_file="a", bytes=9_000_000, truncated=True)],
            {"a": b'{"results": [{"id"'},
        )
        with self.assertRaises(RecordingMissing) as caught:
            PlayerSession(recording).get("https://x/big")
        self.assertIn("truncated", str(caught.exception))


class DigestCatchesWhatCountsDoNot(unittest.TestCase):
    """The reason the expectation is not just a number.

    Markup that still parses but yields wrong prices or empty flight numbers is
    the failure worth catching, and it leaves the offer count untouched.
    """

    def tampered(self, replace, with_):
        """A copy of a real recording with one value altered."""
        import shutil
        import tempfile

        source = next(d for d in cases() if not Recording.load(d).expect.get("error"))
        copy = Path(tempfile.mkdtemp()) / source.name
        shutil.copytree(source, copy)
        recording = Recording.load(copy)

        for exchange in recording.exchanges:
            path = copy / exchange.body_file
            body = path.read_bytes()
            if replace in body:
                path.write_bytes(body.replace(replace, with_, 1))
                return recording
        self.skipTest(f"no {replace!r} in the recording to tamper with")

    def test_a_changed_price_moves_the_digest_but_not_the_count(self):
        recording = self.tampered(b'data-price="', b'data-price="9')
        offers = replay(recording)
        self.assertEqual(
            len(offers), recording.expect["offers"], "the count is exactly what fails to notice"
        )
        self.assertNotEqual(digest_offers(offers), recording.expect["digest"])


if __name__ == "__main__":
    unittest.main()
