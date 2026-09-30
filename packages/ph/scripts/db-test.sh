#!/usr/bin/env bash
# BEAU PH — build the schema from its migrations into a throwaway Postgres and run
# the core contract suite against it.
#
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres packages/ph/scripts/db-test.sh
#
# Never point this at a database you care about: it installs beau_ph into it.
# Order: the Supabase surface the schema expects (roles, net, …) from
# sql/tests/_harness.sql, then every migration in filename order, then the suites.
set -u
export LC_ALL=C
: "${DATABASE_URL:?set DATABASE_URL (a throwaway Postgres, not production)}"
cd "$(dirname "$0")/.."
q() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q "$@"; }

echo "── harness";    out=$(q -f sql/tests/_harness.sql 2>&1) || { printf '%s\n' "$out"; echo "FAIL  harness"; exit 1; }
echo "── migrations"
n=0
for f in sql/migrations/*.sql; do
  out=$(q --single-transaction -f "$f" 2>&1) || { printf '%s\n' "$out" | tail -25; echo "FAIL  $f"; exit 1; }
  n=$((n + 1))
done
echo "      $n migration(s) applied"

echo "── suites"
status=0
for f in sql/tests/*_contract.sql; do
  out=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -X -q -f "$f" 2>&1)
  line=$(printf '%s\n' "$out" | grep -oE '[A-Z0-9_]+_TESTS ok=[0-9]+ fail=[0-9]+.*' | head -1)
  if [[ -n "$line" && "$line" == *" fail=0"* ]]; then echo "PASS  $f — $line"; else echo "FAIL  $f"; printf '%s\n' "$out" | tail -20; status=1; fi
done
exit $status
