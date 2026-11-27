"""Count restored BuriMunsi identity relationships without emitting identifying data.

Supply an iterator of row dictionaries per named relation from the same verified
snapshot. Both native database types and PostgreSQL COPY text are accepted.
This is an offline structural check. It never authenticates or uses a credential.
"""
from collections import Counter


def enabled(value):
    return str(value).lower() in {"true", "t", "1"}


def inspect_role_links(rows):
    """Return aggregate counts and an explicit count of broken stored relationships."""
    def index(relation, key, *fields):
        return {r[key]: {name: r.get(name) for name in fields} for r in rows(relation)}

    users = index("app.users", "id", "access_status")
    groups = index("app.collections", "id", "status")
    scopes = index("private.burimunsi_scopes", "collection_id", "enabled")
    accounts = index("private.burimunsi_accounts", "id", "id", "collection_id", "principal_user_id",
                     "role", "phone", "active", "removed")
    grants = index("private.burimunsi_device_grants", "id", "collection_id", "custodian_account_id")
    web = index("app.admin_users", "id", "role", "status", "burimunsi_phone_only", "email")
    auth = index("auth.users", "id", "email", "email_confirmed_at", "deleted_at")
    web_pairs = {(r["user_id"], r["admin_user_id"]) for r in rows("app.admin_principal_links")}
    auth_links = {r["user_id"]: r["auth_user_id"] for r in rows("private.auth_principal_links")}
    sessions = {r["token_hash"] for r in rows("app.admin_sessions")}
    issues = Counter()
    active_roles = Counter()
    approvals_by_source = Counter()
    supported_identities = Counter()
    active_with_group = set()
    gateway_enabled = set()
    active_by_principal = {}
    matching_approvals = Counter()

    for group in scopes:
        issues["scopeGroup"] += group not in groups
    for account in accounts.values():
        principal, group, role = account["principal_user_id"], account["collection_id"], account["role"]
        issues["nativePrincipal"] += principal not in users
        issues["nativeScope"] += group not in scopes
        issues["nativeRole"] += role not in {"admin", "staff"}
        if enabled(account["active"]) and not enabled(account["removed"]):
            active_roles[role if role in {"admin", "staff"} else "unknown"] += 1
            active_by_principal.setdefault((group, principal), []).append(account)
            if (group in scopes and groups.get(group, {}).get("status") == "active"
                    and users.get(principal, {}).get("access_status") == "active"):
                active_with_group.add(account["id"])
                if enabled(scopes[group]["enabled"]):
                    gateway_enabled.add(account["id"])
    for grant in grants.values():
        group, custodian = grant["collection_id"], grant.get("custodian_account_id")
        issues["deviceScope"] += group not in scopes
        if custodian:
            issues["deviceCustodian"] += accounts.get(custodian, {}).get("collection_id") != group
    device_links = 0
    for r in rows("private.burimunsi_device_accounts"):
        device_links += 1
        group = r["collection_id"]
        issues["deviceAccount"] += accounts.get(r["account_id"], {}).get("collection_id") != group
        issues["deviceGrant"] += grants.get(r["grant_id"], {}).get("collection_id") != group
    for principal, admin in web_pairs:
        issues["webPrincipal"] += principal not in users
        issues["webAccount"] += admin not in web
    for principal, identity in auth_links.items():
        issues["providerPrincipal"] += principal not in users
        issues["providerAccount"] += identity not in auth
    for r in rows("auth.identities"):
        issues["providerIdentity"] += r["user_id"] not in auth
    for r in rows("private.burimunsi_operator_approvals"):
        group, principal, admin = r["collection_id"], r["principal_user_id"], r["admin_user_id"]
        source = r["identity_source"]
        issues["approvalScope"] += group not in scopes
        issues["approvalPrincipal"] += principal not in users
        issues["approvalWebAccount"] += admin not in web
        if enabled(r["active"]):
            approvals_by_source[source if source in {"phone", "shared", "native_staff"} else "unknown"] += 1
            operator = web.get(admin, {})
            for account in active_by_principal.get((group, principal), ()):
                if ((principal, admin) in web_pairs and operator.get("status") == "active"
                        and account["id"] in active_with_group):
                    role_matches = (account["role"] == "staff" and enabled(operator.get("burimunsi_phone_only"))
                                    if source == "native_staff" else
                                    account["role"] == r["role"] and account.get("phone") == r.get("phone"))
                    if role_matches:
                        matching_approvals[source if source in {"phone", "shared", "native_staff"} else "unknown"] += 1
            if source == "phone":
                if (principal, admin) not in web_pairs:
                    supported_identities["phoneApprovalWithoutWebPair"] += 1
                elif enabled(operator.get("burimunsi_phone_only")):
                    supported_identities["phoneOnlyMatchingRole" if operator.get("role") == r["role"]
                                         else "phoneOnlyRoleDiffers"] += 1
                else:
                    identity = auth.get(auth_links.get(principal), {})
                    email = identity.get("email")
                    matching = (email and operator.get("email") and email.casefold() == operator["email"].casefold()
                                and identity.get("email_confirmed_at") and not identity.get("deleted_at"))
                    supported_identities["providerConfirmedMatchingEmail" if matching
                                         else "phoneApprovalWithoutConfirmedMatchingProvider"] += 1
    bff = 0
    for r in rows("private.bff_sessions"):
        bff += 1
        issues["bffProviderAccount"] += r["auth_user_id"] not in auth
        issues["bffWebSession"] += r["token_hash"] not in sessions
    return {
        "nativeAccounts": len(accounts), "activeNativeRoles": dict(sorted(active_roles.items())),
        "activeNativeAccountsWithActivePrincipalCollectionAndScopeLink": len(active_with_group),
        "ofTheseWithReceivingScopeEnabled": len(gateway_enabled),
        "activeNativeAccountsWithMatchingApprovalAndWebLink": dict(sorted(matching_approvals.items())),
        "deviceGrants": len(grants), "deviceAccountLinks": device_links, "webPrincipalLinks": len(web_pairs),
        "providerPrincipalLinks": len(auth_links), "bffSessionLinks": bff,
        "activeApprovalsByIdentitySource": dict(sorted(approvals_by_source.items())),
        "phoneApprovalIdentityEvidence": dict(sorted(supported_identities.items())),
        "brokenRelationships": sum(issues.values()),
        "brokenByType": {k: n for k, n in sorted(issues.items()) if n},
    }
