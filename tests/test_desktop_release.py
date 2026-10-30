"""Desktop release boundaries: authenticated IPC-to-HTTP sessions and WSGI."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flyscan.web import create_app, run_server


class DesktopSession(unittest.TestCase):
    def setUp(self):
        self.environment = mock.patch.dict(os.environ, {"FLYSCAN_API_KEY": "desktop-test-session"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.scheduler = mock.patch("flyscan.api.default_scheduler")
        self.scheduler.start().return_value.snapshot.return_value = {}
        self.addCleanup(self.scheduler.stop)
        self.client = create_app().test_client()

    def test_only_the_session_can_read_the_api(self):
        self.assertEqual(self.client.get("/v1/health").status_code, 401)
        self.assertEqual(
            self.client.get("/v1/health", headers={"Authorization": "Bearer wrong"}).status_code,
            401,
        )
        self.assertEqual(
            self.client.get(
                "/v1/health", headers={"Authorization": "Bearer desktop-test-session"}
            ).status_code,
            200,
        )
        self.assertEqual(
            self.client.get("/v1/health?api_key=desktop-test-session").status_code, 401
        )

    def test_eventsource_query_auth_is_scoped_to_read_only_streams(self):
        self.assertEqual(self.client.get("/v1/searches/missing/events").status_code, 401)
        # A missing job is a 404 after authentication, rather than a 401.
        self.assertEqual(
            self.client.get("/v1/searches/missing/events?api_key=desktop-test-session").status_code,
            404,
        )
        self.assertEqual(
            self.client.post("/v1/searches?api_key=desktop-test-session", json={}).status_code, 401
        )

    def test_preflight_does_not_require_the_secret_or_grant_api_access(self):
        response = self.client.options(
            "/v1/health",
            headers={
                "Origin": "http://tauri.localhost",
                "Access-Control-Request-Headers": "authorization",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("Authorization", response.headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.client.get("/v1/health").status_code, 401)

    def test_frozen_server_uses_waitress_and_binds_only_to_loopback(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            mock.patch.object(sys, "frozen", True, create=True),
            mock.patch("flyscan.web.default_scheduler"),
            mock.patch("flyscan.web.OUT_DIR", Path(directory)),
            mock.patch("waitress.serve") as serve,
        ):
            run_server(host="0.0.0.0", port=51234)
            self.assertEqual(serve.call_args.kwargs["host"], "127.0.0.1")
            self.assertEqual(serve.call_args.kwargs["port"], 51234)
            self.assertGreaterEqual(serve.call_args.kwargs["threads"], 8)
