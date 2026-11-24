SHELL := /bin/bash
.DEFAULT_GOAL := help
export NATIVE_OUTPUT

.PHONY: help check-source test-backend test-backend-operations test-backend-owned-pg test-admin admin-fixture admin-web-build native-build revolut-design-authority

help:
	@printf '%s\n' 'BuriMunsi commands' \
	  '  make check-source       Verify shared contracts, schema and public profile' \
	  '  make revolut-design-authority   Verify the Admin design authority' \
	  '  make test-backend       Run locked Edge type checks and source tests' \
	  '  make test-backend-operations  Run offline gateway, job and recovery proofs' \
	  '  make test-backend-owned-pg    Run owned PostgreSQL 17 receipt and custody proofs' \
	  '  make test-admin         Run React and Admin Worker tests' \
	  '  make admin-fixture      Build the local browser test fixture' \
	  '  make admin-web-build    Build the dedicated production Admin artifact' \
	  '  make native-build NATIVE_OUTPUT=/absolute/evidence/path'

check-source:
	@python3 scripts/generate_ui_copy.py --check
	@python3 scripts/generate_burimunsi_wire.py --check
	@python3 supabase/schema-src/generate_baseline.py --check
	@python3 -m unittest scripts.supabase.test_admin_build_config

revolut-design-authority:
	@python3 scripts/qa/revolut_design_authority.py

test-backend:
	@cd supabase/functions && deno task check && deno task test

test-backend-operations:
	@node scripts/supabase/testing/run_synthetic_ci.mjs operations

test-backend-owned-pg:
	@node scripts/supabase/testing/run_synthetic_ci.mjs owned-pg

test-admin:
	@cd admin-web && npm run typecheck && npm run lint && npm test
	@cd deploy/platform-admin && npm test

admin-fixture:
	@./scripts/admin_pwa_release_build.sh --fixture

admin-web-build:
	@python3 scripts/build_burimunsi_admin.py

native-build:
	@test -n "$$NATIVE_OUTPUT" || { printf '%s\n' 'Set NATIVE_OUTPUT to a fresh absolute evidence path.' >&2; exit 2; }
	@python3 native/burimunsi/scripts/native_pipeline.py build --output "$$NATIVE_OUTPUT"
