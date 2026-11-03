"""Release policy is enforced below the UI, using no live providers."""

import os
import unittest
from datetime import date
from unittest.mock import patch

from flyscan import __version__, deployment
from flyscan.models import SearchQuery
from flyscan.scheduler import Scheduler, reset_default_scheduler
from flyscan.sources import REGISTRY, build
from flyscan.sources.base import ChallengeRequired, Source
from flyscan.web import create_app, parse_params


class Deployment(unittest.TestCase):
    def setUp(self):
        reset_default_scheduler()
        self.addCleanup(reset_default_scheduler)
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_web_policy_cannot_be_widened_by_the_enabled_list(self):
        os.environ.update(FLYSCAN_MODE="web", FLYSCAN_ENABLED_SOURCES="ff-sky,ff-kayak,momondo")
        self.assertEqual(deployment.allowed_sources(REGISTRY), ["ff-sky"])
        self.assertEqual([s.name for s in build()], ["ff-sky"])
        with self.assertRaises(ValueError):
            build(["ff-kayak"])

    def test_desktop_uses_every_source_and_the_web_excludes_kayak_and_momondo(self):
        self.assertEqual(deployment.allowed_sources(REGISTRY), list(REGISTRY))
        os.environ["FLYSCAN_MODE"] = "web"
        sources = deployment.allowed_sources(REGISTRY)
        self.assertNotIn("ff-kayak", sources)
        self.assertNotIn("momondo", sources)

    def test_unknown_configuration_fails_closed(self):
        os.environ["FLYSCAN_ENABLED_SOURCES"] = "typo"
        with self.assertRaises(ValueError):
            create_app()

    def test_scheduler_rejects_disabled_sources_before_any_work(self):
        os.environ["FLYSCAN_MODE"] = "web"
        scheduler = Scheduler(db_path=None)
        self.addCleanup(scheduler.shutdown)
        with self.assertRaises(ValueError):
            scheduler.submit(REGISTRY["momondo"](), SearchQuery("BER", "LHR", date(2027, 1, 1)))
        self.assertEqual(scheduler.snapshot()["running"], 0)

    def test_hosted_api_rejects_direct_source_requests_and_administration(self):
        os.environ["FLYSCAN_MODE"] = "web"
        client = create_app().test_client()
        response = client.post("/v1/jobs", json={"source": "ff-kayak"})
        self.assertEqual(response.status_code, 400)
        for path in [
            "/v1/challenges/ff-sky/solve",
            "/v1/challenges/ff-sky/cookies",
            "/v1/jobs/1/retry",
            "/v1/maintenance/purge",
            "/v1/manual-offers",
        ]:
            self.assertEqual(client.post(path, json={}).status_code, 403, path)
        self.assertEqual(client.get("/v1/errors").status_code, 403)
        self.assertEqual(client.get("/v1/flights?db=secret.db").status_code, 400)
        self.assertEqual(client.post("/v1/queue/selection", json=None).status_code, 200)

    def test_hosted_queue_selection_is_resolved_without_reordering_the_queue(self):
        os.environ["FLYSCAN_MODE"] = "web"
        client = create_app().test_client()
        search = {"origin": "ber", "destination": "LHR", "start": "2027-01-01"}
        with patch.object(Scheduler, "select_query") as select:
            response = client.post("/v1/queue/selection", json=search)
        self.assertEqual(response.status_code, 200)
        selected = response.json["selected"]
        self.assertEqual((selected["origin"], selected["destination"]), ("BER", "LHR"))
        self.assertEqual((selected["start"], selected["end"]), ("2027-01-01", "2027-01-01"))
        select.assert_not_called()

    def test_hosted_input_is_bounded_and_uses_server_execution_policy(self):
        os.environ["FLYSCAN_MODE"] = "web"
        request = dict(
            origin="BER", destination="LHR", start="2027-01-01", refresh=True, cache_hours=0
        )
        params, error = parse_params(request)
        self.assertIsNone(error)
        self.assertFalse(params["refresh"])
        self.assertEqual(params["cache_hours"], 6)
        self.assertNotIn("momondo", params["sources"])
        self.assertIsNotNone(parse_params({**request, "end": "9999-01-01"})[1])
        self.assertIsNotNone(parse_params({**request, "sources": "ff-sky"})[1])

    def test_metadata_identifies_the_mode(self):
        for mode in ["desktop", "web"]:
            os.environ["FLYSCAN_MODE"] = mode
            self.assertEqual(
                create_app().test_client().get("/v1/version").json,
                {"version": __version__, "mode": mode},
            )

    def test_hosted_challenge_finishes_without_pausing_other_work_or_opening_browser(self):
        os.environ["FLYSCAN_MODE"] = "web"

        class Challenged(Source):
            name = "test-challenged"
            min_interval = 0
            calls = 0

            def run_once(self, query):
                self.calls += 1
                raise ChallengeRequired("https://example.invalid/check", self.name)

        scheduler = Scheduler(db_path=None)
        self.addCleanup(scheduler.shutdown)
        source = Challenged()
        query = SearchQuery("BER", "LHR", date(2027, 1, 1))
        with patch.object(scheduler.challenge_control, "start_recovery") as recover:
            result = scheduler.submit(source, query).result(timeout=2)
            self.assertIn("verification required", result.error)
            second = scheduler.submit(source, query, refresh=True).result(timeout=2)
            self.assertIn("unavailable", second.error)
            self.assertEqual(source.calls, 1)
            recover.assert_not_called()
