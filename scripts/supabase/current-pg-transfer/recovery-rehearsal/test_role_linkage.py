import csv
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from role_linkage import inspect_role_links
from verify_role_dump import inspect_dump


class RecoveryRoleLinks(unittest.TestCase):
    def setUp(self):
        self.data = {
            "app.collections": [dict(id="group", status="active")],
            "private.burimunsi_scopes": [dict(collection_id="group", enabled="t")],
            "app.users": [dict(id="principal", access_status="active")],
            "private.burimunsi_accounts": [dict(id="native", collection_id="group", principal_user_id="principal",
                                                role="staff", active="true", removed="f")],
            "private.burimunsi_device_grants": [dict(id="grant", collection_id="group", custodian_account_id="native")],
            "private.burimunsi_device_accounts": [dict(account_id="native", grant_id="grant", collection_id="group")],
            "app.admin_users": [dict(id="web", role="staff", status="active", burimunsi_phone_only=True)],
            "app.admin_principal_links": [dict(user_id="principal", admin_user_id="web")],
            "private.burimunsi_operator_approvals": [dict(collection_id="group", principal_user_id="principal",
                                                           admin_user_id="web", role="staff", active=1, identity_source="phone")],
            "auth.users": [], "auth.identities": [], "private.auth_principal_links": [],
            "app.admin_sessions": [], "private.bff_sessions": [],
        }

    def archive(self, root):
        tables = root / "tables"
        tables.mkdir()
        relations = []
        for index, (relation, records) in enumerate(self.data.items()):
            schema, name = relation.split(".")
            fields = list(records[0]) if records else ["id"]
            path = tables / f"{index:04}.csv"
            with path.open("w", newline="") as stream:
                csv.DictWriter(stream, fieldnames=fields).writerows(records)
            data = path.read_bytes()
            relations.append(dict(schema=schema, name=name, columns=[{"name": k} for k in fields],
                                  file=path.name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
        data = json.dumps({"relations": relations}).encode()
        (root / "postgres-copy-inventory.json").write_bytes(data)
        return hashlib.sha256(data).hexdigest()

    def test_verified_copy_archive_matches_aggregate_and_refuses_changed_bytes(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            digest = self.archive(root)
            self.assertEqual(inspect_dump(root, digest), self.report())
            with self.assertRaises(ValueError):
                inspect_dump(root, "0" * 64)
            path = root / "tables" / "0003.csv"
            path.write_bytes(path.read_bytes().replace(b"staff", b"admin"))
            with self.assertRaises(ValueError):
                inspect_dump(root, digest)

    def report(self):
        return inspect_role_links(self.data.__getitem__)

    def test_active_phone_only_staff_does_not_need_provider(self):
        found = self.report()
        self.assertEqual(found["activeNativeRoles"], {"staff": 1})
        self.assertEqual(found["phoneApprovalIdentityEvidence"], {"phoneOnlyMatchingRole": 1})
        self.assertEqual(found["activeNativeAccountsWithActivePrincipalCollectionAndScopeLink"], 1)
        self.assertEqual(found["brokenRelationships"], 0)

    def test_receiving_scope_is_independent_of_staff_principal_and_web_approval(self):
        self.data["private.burimunsi_scopes"][0]["enabled"] = "f"
        self.data["private.burimunsi_operator_approvals"][0]["identity_source"] = "native_staff"
        found = self.report()
        self.assertEqual(found["activeNativeAccountsWithActivePrincipalCollectionAndScopeLink"], 1)
        self.assertEqual(found["ofTheseWithReceivingScopeEnabled"], 0)
        self.assertEqual(found["activeNativeAccountsWithMatchingApprovalAndWebLink"], {"native_staff": 1})

    def test_existing_ids_from_a_different_group_do_not_bind(self):
        self.data["private.burimunsi_device_accounts"][0]["collection_id"] = "other"
        self.assertEqual(self.report()["brokenByType"], {"deviceAccount": 1, "deviceGrant": 1})

    def test_provider_matching_is_by_link_and_confirmed_identity(self):
        self.data["app.admin_users"][0].update(burimunsi_phone_only=False, email="TEST@example.invalid")
        self.data["auth.users"].append(dict(id="provider", email="test@example.invalid", email_confirmed_at="now"))
        self.data["auth.identities"].append(dict(user_id="provider"))
        self.data["private.auth_principal_links"].append(dict(user_id="principal", auth_user_id="provider"))
        self.data["app.admin_sessions"].append(dict(token_hash="sensitive-fixture"))
        self.data["private.bff_sessions"].append(dict(token_hash="sensitive-fixture", auth_user_id="provider"))
        found = self.report()
        self.assertEqual(found["phoneApprovalIdentityEvidence"], {"providerConfirmedMatchingEmail": 1})
        self.assertEqual(found["brokenRelationships"], 0)
        self.assertNotIn("example.invalid", json.dumps(found))
        self.assertNotIn("sensitive-fixture", json.dumps(found))
        self.data["auth.users"][0]["deleted_at"] = "later"
        self.assertEqual(self.report()["phoneApprovalIdentityEvidence"], {"phoneApprovalWithoutConfirmedMatchingProvider": 1})

    def test_historical_disabled_account_and_orphans_are_explicit(self):
        self.data["private.burimunsi_accounts"][0]["active"] = "f"
        self.data["private.auth_principal_links"].append(dict(user_id="missing", auth_user_id="missing"))
        self.data["private.bff_sessions"].append(dict(token_hash="absent", auth_user_id="missing"))
        found = self.report()
        self.assertEqual(found["activeNativeRoles"], {})
        self.assertEqual(found["brokenByType"], {"bffProviderAccount": 1, "bffWebSession": 1,
                                                "providerAccount": 1, "providerPrincipal": 1})


if __name__ == "__main__":
    unittest.main()
