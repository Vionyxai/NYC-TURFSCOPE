#!/usr/bin/env bash
# Runs supabase/001_team_tracking.sql + the security tests against a throwaway Postgres.
# Needs psql and a Postgres you can create databases on (PGHOST/PGUSER/PGPASSWORD as usual).
# Usage: npm run test:sql
set -euo pipefail
cd "$(dirname "$0")/.."
DB="turfscope_rls_test_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/supabase_stub.sql
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/001_team_tracking.sql
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/rls_test.sql
