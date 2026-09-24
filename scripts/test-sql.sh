#!/usr/bin/env bash
# Runs every supabase/NNN_*.sql migration + the security tests against a throwaway Postgres.
# Needs psql and a Postgres you can create databases on (PGHOST/PGUSER/PGPASSWORD as usual).
# Usage: npm run test:sql
set -euo pipefail
cd "$(dirname "$0")/.."
DB="turfscope_rls_test_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/supabase_stub.sql
for f in supabase/[0-9][0-9][0-9]_*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done   # every migration, in order
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/rls_test.sql
