"""Release policy is enforced below the UI, using no live providers."""

import base64
import importlib.util
import io
import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from werkzeug.security import generate_password_hash

from flyscan import __version__, deployment
from flyscan.models import SearchQuery
from flyscan.scheduler import Scheduler, reset_default_scheduler
from flyscan.sources import REGISTRY, build
from flyscan.sources.base import ChallengeRequired, Source
from flyscan.web import create_app, parse_params

PASSWORD_AUTH = {"Authorization": "Bearer " + base64.b64encode(b"test-password").decode()}


class Deployment(unittest.TestCase):
    def setUp(self):
        reset_default_scheduler()
        self.addCleanup(reset_default_scheduler)
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.edition = patch.object(deployment, "EDITION", "development")
        self.edition.start()
        self.addCleanup(self.edition.stop)

    def test_public_policy_cannot_be_widened_by_the_enabled_list(self):
        os.environ.update(
            FLYSCAN_EDITION="public", FLYSCAN_ENABLED_SOURCES="ff-sky,ff-kayak,momondo"
        )
        self.assertEqual(deployment.allowed_sources(REGISTRY), ["ff-sky"])
        self.assertEqual([s.name for s in build()], ["ff-sky"])
        with self.assertRaises(ValueError):
            build(["ff-kayak"])

    def test_private_policy_and_frozen_public_build(self):
        os.environ["FLYSCAN_EDITION"] = "private"
        self.assertEqual(deployment.allowed_sources(REGISTRY), list(REGISTRY))
        with patch.object(deployment, "EDITION", "public"), patch("sys.frozen", True, create=True):
            self.assertNotIn("momondo", deployment.allowed_sources(REGISTRY))

    def test_web_defaults_to_public_but_private_web_can_use_all_sources(self):
        os.environ["FLYSCAN_MODE"] = "web"
        self.assertNotIn("ff-kayak", deployment.allowed_sources(REGISTRY))
        os.environ["FLYSCAN_EDITION"] = "private"
        self.assertIn("ff-kayak", deployment.allowed_sources(REGISTRY))

    def test_unknown_configuration_fails_closed(self):
        os.environ["FLYSCAN_ENABLED_SOURCES"] = "typo"
        with self.assertRaises(ValueError):
            create_app()

    def test_scheduler_rejects_disabled_sources_before_any_work(self):
        os.environ["FLYSCAN_EDITION"] = "public"
        scheduler = Scheduler(db_path=None)
        self.addCleanup(scheduler.shutdown)
        with self.assertRaises(ValueError):
            scheduler.submit(REGISTRY["momondo"](), SearchQuery("BER", "LHR", date(2027, 1, 1)))
        self.assertEqual(scheduler.snapshot()["running"], 0)

    def test_hosted_api_rejects_direct_source_requests_and_administration(self):
        os.environ.update(FLYSCAN_MODE="web", FLYSCAN_EDITION="public")
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
        os.environ.update(FLYSCAN_MODE="web", FLYSCAN_EDITION="public")
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

    def test_metadata_identifies_all_editions_and_modes(self):
        for name in ["development", "public", "private"]:
            for mode in ["desktop", "web"]:
                os.environ.update(
                    FLYSCAN_EDITION=name,
                    FLYSCAN_MODE=mode,
                    FLYSCAN_SESSION_SECRET="test-secret",
                    FLYSCAN_PRIVATE_PASSWORD_HASH=generate_password_hash(
                        "test-password", method="pbkdf2:sha256:1000"
                    ),
                )
                client = create_app().test_client()
                if name == "private" and mode == "web":
                    with client.session_transaction() as session:
                        session["private_access"] = True
                self.assertEqual(
                    client.get("/v1/version").json,
                    {"version": __version__, "edition": name, "mode": mode},
                )

    def test_private_web_requires_configuration_and_password(self):
        os.environ.update(FLYSCAN_MODE="web", FLYSCAN_EDITION="private")
        with self.assertRaises(ValueError):
            create_app()
        os.environ.update(
            FLYSCAN_SESSION_SECRET="test-secret",
            FLYSCAN_PRIVATE_PASSWORD_HASH=generate_password_hash(
                "test-password", method="pbkdf2:sha256:1000"
            ),
        )
        client = create_app().test_client()
        self.assertEqual(client.get("/").status_code, 302)
        self.assertEqual(client.get("/v1/sources").status_code, 401)
        self.assertIn(
            b"Password not accepted", client.post("/login", data={"password": "wrong"}).data
        )
        self.assertEqual(client.post("/login", data={"password": "test-password"}).status_code, 302)
        response = client.get("/v1/sources")
        self.assertEqual(response.status_code, 200)
        self.assertIn("momondo", [source["name"] for source in response.json])
        self.assertEqual(response.headers["Cache-Control"], "no-store")

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


class PrivateUpdates(unittest.TestCase):
    def setUp(self):
        from flyscan import private_updates

        private_updates._attempts.clear()
        env = patch.dict(
            os.environ,
            {
                "FLYSCAN_MODE": "desktop",
                "FLYSCAN_PRIVATE_PASSWORD_HASH": generate_password_hash(
                    "test-password", method="pbkdf2:sha256:1000"
                ),
                "FLYSCAN_RELEASES_TOKEN": "test-upstream-token",
                "FLYSCAN_UPDATE_ORIGIN": "https://private.example.invalid",
            },
        )
        env.start()
        self.addCleanup(env.stop)
        self.client = create_app().test_client()

    def test_manifest_and_direct_installer_both_require_authentication(self):
        with patch("flyscan.private_updates.github_open") as upstream:
            for path in [
                "/updates/private/latest.json",
                "/updates/private/v1.2.3/Flyscan-Private-1.2.3-windows-x64-setup.exe",
            ]:
                self.assertEqual(self.client.get(path).status_code, 401)
                self.assertEqual(
                    self.client.get(path, headers={"Authorization": "Bearer wrong"}).status_code,
                    401,
                )
            upstream.assert_not_called()

    def test_manifest_points_only_to_authenticated_gateway(self):
        name = "Flyscan-Private-1.2.3-windows-x64-setup.exe"
        manifest = {
            "version": "1.2.3",
            "platforms": {
                "windows-x86_64": {
                    "url": "https://github.com/owner/private/releases/download/v1.2.3/" + name,
                    "signature": "signed",
                }
            },
        }
        release = {
            "tag_name": "v1.2.3",
            "assets": [
                {"name": "latest.json", "url": "https://api.github.com/manifest"},
                {"name": name, "url": "https://api.github.com/installer"},
            ],
        }
        with (
            patch("flyscan.private_updates.release", return_value=release),
            patch(
                "flyscan.private_updates.github_open",
                return_value=io.BytesIO(json.dumps(manifest).encode()),
            ),
        ):
            response = self.client.get(
                "/updates/private/latest.json",
                headers=PASSWORD_AUTH,
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json["platforms"]["windows-x86_64"]["url"],
            "https://private.example.invalid/updates/private/v1.2.3/" + name,
        )
        self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_invalid_asset_paths_cannot_be_used_as_an_open_proxy(self):
        response = self.client.get(
            "/updates/private/v1.2.3/other.exe",
            headers=PASSWORD_AUTH,
        )
        self.assertEqual(response.status_code, 404)

    def test_github_token_is_not_forwarded_to_release_asset_storage(self):
        from flyscan.private_updates import github_open

        calls = []

        class Opener:
            def open(self, request, timeout):
                calls.append(request)
                if len(calls) == 1:
                    raise HTTPError(
                        request.full_url,
                        302,
                        "Found",
                        {"Location": "https://release-assets.githubusercontent.com/installer"},
                        None,
                    )
                return io.BytesIO(b"installer")

        with patch("flyscan.private_updates.build_opener", return_value=Opener()):
            response = github_open(
                "https://api.github.com/repos/owner/private/releases/assets/1", binary=True
            )
            self.assertEqual(response.read(), b"installer")
        self.assertEqual(calls[0].get_header("Authorization"), "Bearer test-upstream-token")
        self.assertIsNone(calls[1].get_header("Authorization"))

    def test_password_authentication_is_required_even_for_a_valid_installer_path(self):
        name = "Flyscan-Private-1.2.3-windows-x64-setup.exe"
        upstream = io.BytesIO(b"signed-installer")
        upstream.headers = {"Content-Length": "16"}
        data = {"assets": [{"name": name, "url": "https://api.github.com/installer"}]}
        with (
            patch("flyscan.private_updates.release", return_value=data),
            patch("flyscan.private_updates.github_open", return_value=upstream),
        ):
            response = self.client.get(
                "/updates/private/v1.2.3/" + name,
                headers=PASSWORD_AUTH,
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, b"signed-installer")


class EditionPackaging(unittest.TestCase):
    def test_private_packaging_uses_separate_identity_and_protected_endpoint(self):
        spec = importlib.util.spec_from_file_location(
            "prepare_edition", Path(__file__).parents[1] / "packaging/prepare-edition.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "desktop/src-tauri").mkdir(parents=True)
            (root / "flyscan").mkdir()
            source = Path(__file__).parents[1] / "desktop/src-tauri/tauri.conf.json"
            (root / "desktop/src-tauri/tauri.conf.json").write_bytes(source.read_bytes())
            config = json.loads(
                module.prepare(root, "private", "https://private.example.invalid").read_text()
            )
            self.assertEqual(config["identifier"], "com.flyscan.private")
            self.assertEqual(
                config["plugins"]["updater"]["endpoints"],
                ["https://private.example.invalid/updates/private/latest.json"],
            )
            self.assertIn('EDITION = "private"', (root / "flyscan/_build.py").read_text())
            for origin in [
                "http://private.example.invalid",
                "https://private.example.invalid/path",
                "https://user:password@example.invalid",
            ]:
                with self.assertRaises(ValueError):
                    module.prepare(root, "private", origin)
