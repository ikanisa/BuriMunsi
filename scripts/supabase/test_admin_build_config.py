import tempfile
import unittest
from pathlib import Path

from .admin_build_config import (BASELINE, BURIMUNSI_ADMIN_ORIGIN, PROJECT_ORIGIN,
                                 burimunsi_admin_profile, configuration)
from .deployment_profile import canonical_profile, legacy_profile, profile_sha256


class AdminBuildConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.migration = self.root / "supabase/migrations" / BASELINE
        self.migration.parent.mkdir(parents=True)
        self.migration.write_text("-- synthetic build fixture\nselect 1;\n")
        self.profile = burimunsi_admin_profile()
        self.env = self.profile_environment(self.profile)

    @staticmethod
    def profile_environment(profile):
        return {
            "SUPABASE_PUBLISHABLE_KEY": "sb_publishable_public_fixture_only",
            "COLLECT_DEPLOYMENT_PROFILE": canonical_profile(profile),
            "COLLECT_DEPLOYMENT_PROFILE_SHA256": profile_sha256(profile),
        }

    def test_burimunsi_build_binds_project_profile_and_same_origin(self):
        env = self.env | {"SUPABASE_SERVICE_ROLE_KEY": "private-fixture"}
        defines, metadata = configuration(env, self.root)
        self.assertEqual(metadata["deployment_profile"], self.profile)
        self.assertEqual(defines["SUPABASE_URL"], PROJECT_ORIGIN)
        self.assertEqual(defines["SUPABASE_AUTH_ISSUER"], PROJECT_ORIGIN + "/auth/v1")
        self.assertEqual(defines["APP_ENVIRONMENT"], "production")
        for key in ("APP_PUBLIC_URL", "ADMIN_APP_URL", "SUPABASE_API_URL", "SUPABASE_ADMIN_API_URL"):
            self.assertEqual(defines[key], BURIMUNSI_ADMIN_ORIGIN)
        self.assertEqual(defines["GOOGLE_AUTH_ENABLED"], "false")
        self.assertEqual(metadata["backend"], "supabase")
        self.assertEqual(metadata["supabase_hosting"], "managed")
        self.assertEqual(metadata["authentication"], "burimunsi_phone_passcode_cookie")
        self.assertEqual(metadata["supabase_project_ref"], PROJECT_ORIGIN.split(".")[0].removeprefix("https://"))
        self.assertFalse(metadata["supabase_qualification_complete"])
        self.assertFalse(metadata["operating_actions_available"])
        self.assertEqual(len(metadata["supabase_schema_sha256"]), 64)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", defines)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", metadata)

    def test_requires_explicit_dedicated_profile(self):
        for profile in (legacy_profile(), legacy_profile(qualification=True),
                        self.profile | {"member_api_origin": "https://collect.ikanisa.com"},
                        self.profile | {"id": "collect-managed-production"}):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                configuration(self.profile_environment(profile), self.root)
        with self.assertRaises(ValueError):
            configuration({"SUPABASE_PUBLISHABLE_KEY": self.env["SUPABASE_PUBLISHABLE_KEY"]}, self.root)

    def test_rejects_mismatched_origin_issuer_digest_backend_and_key(self):
        for changes in ({"COLLECT_DEPLOYMENT_PROFILE_SHA256": "0" * 64},
                        {"SUPABASE_URL": "https://another-project.supabase.co"},
                        {"SUPABASE_AUTH_ISSUER": "https://another-project.supabase.co/auth/v1"},
                        {"APP_PUBLIC_URL": "https://collect.ikanisa.com"},
                        {"ADMIN_APP_URL": "https://platform-admin.collect.ikanisa.com"},
                        {"SUPABASE_ADMIN_API_URL": PROJECT_ORIGIN},
                        {"SUPABASE_API_URL": "https://platform-admin.collect.ikanisa.com"},
                        {"COLLECT_BACKEND": "cloudflare"},
                        {"SUPABASE_PUBLISHABLE_KEY": "sb_secret_private_fixture"},
                        {"APP_ENVIRONMENT": "qualification"},
                        {"GOOGLE_AUTH_ENABLED": "true"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                configuration(self.env | changes, self.root)

    def test_empty_or_changed_migration_cannot_reuse_identity(self):
        _, before = configuration(self.env, self.root)
        self.migration.write_text("-- changed fixture\nselect 2;\n")
        _, after = configuration(self.env, self.root)
        self.assertNotEqual(before["supabase_schema_sha256"], after["supabase_schema_sha256"])
        self.migration.write_text("")
        with self.assertRaises(ValueError):
            configuration(self.env, self.root)

    def test_additive_migrations_are_bound_and_empty_or_symlink_sources_refused(self):
        _, before = configuration(self.env, self.root)
        additional = self.migration.parent / '20261020135932_collect_runtime_role_and_function_paths.sql'
        additional.write_text('-- synthetic additive fixture\nselect 2;\n')
        _, after = configuration(self.env, self.root)
        self.assertEqual(before['supabase_schema_sha256'], after['supabase_schema_sha256'])
        self.assertNotEqual(before['supabase_migration_chain_sha256'], after['supabase_migration_chain_sha256'])
        self.assertEqual([item['name'] for item in after['supabase_migrations']], [BASELINE, additional.name])
        additional.write_text('')
        with self.assertRaises(ValueError):
            configuration(self.env, self.root)
        additional.unlink()
        additional.symlink_to(self.migration)
        with self.assertRaises(ValueError):
            configuration(self.env, self.root)

    def test_stale_captcha_public_configuration_cannot_enable_it(self):
        stale = self.env | {"AUTH_CAPTCHA_ENABLED": "true", "AUTH_CAPTCHA_PROVIDER": "turnstile",
                            "AUTH_CAPTCHA_SITE_KEY": "synthetic_public_site_key"}
        disabled, _ = configuration(stale, self.root)
        self.assertEqual(disabled["AUTH_CAPTCHA_ENABLED"], "false")
        self.assertEqual(disabled["AUTH_CAPTCHA_PROVIDER"], "")
        self.assertEqual(disabled["AUTH_CAPTCHA_SITE_KEY"], "")
