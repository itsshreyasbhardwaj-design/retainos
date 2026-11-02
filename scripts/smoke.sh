#!/usr/bin/env bash
# Request every route and report anything that is not 200.
#
# Catches the class of bug a typechecker and a unit test cannot: a server
# component that renders fine in isolation but fails at runtime — for example
# passing a null-prototype database row to a client component.
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
EMAIL="${EMAIL:-demo@retainos.example}"

# The dev server reads apps/web/.env.local; this script runs outside it, so
# without this the session secret differs and every authenticated route 302s
# to the login page while looking like an auth bug.
# Only the secret is taken from that file: its RETAINOS_DB_PATH is relative to
# apps/web and would point nowhere from here.
ENV_FILE="${ENV_FILE:-apps/web/.env.local}"
if [ -z "${RETAINOS_SESSION_SECRET:-}" ] && [ -f "$ENV_FILE" ]; then
  secret=$(grep -m1 '^RETAINOS_SESSION_SECRET=' "$ENV_FILE" | cut -d= -f2-)
  [ -n "$secret" ] && export RETAINOS_SESSION_SECRET="$secret"
fi

PUBLIC=(/ /features /pricing /docs /integrations /demo /privacy /terms /login /signup /api/v1/health)
PRIVATE=(
  /command /dashboard /alerts
  /analytics /analytics/events /analytics/funnels /activation /retention /revenue /health
  /feedback /feedback/requests /feedback/roadmap
  /friction /opportunities
  /improvements /playbooks /releases /changelog /onboarding-builder
  /impact /revenue/impact /experiments
  /ai /reports
  /settings /settings/sdk /settings/instrumentation /settings/sources /settings/team
  /settings/integrations /settings/privacy /settings/billing
)

fail=0
check() {
  local route="$1" cookie="${2:-}"
  local code
  if [ -n "$cookie" ]; then
    code=$(curl -s -o /dev/null -w "%{http_code}" -b "retainos_session=$cookie" "$BASE$route")
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE$route")
  fi
  if [ "$code" = "200" ]; then
    printf "  ok   %s\n" "$route"
  else
    printf "  FAIL %s  (%s)\n" "$route" "$code"
    fail=$((fail + 1))
  fi
}

echo "Public routes"
for r in "${PUBLIC[@]}"; do check "$r"; done

TOKEN=$(node --experimental-strip-types scripts/smoke-session.ts "$EMAIL") || {
  echo "Could not mint a session. Run 'pnpm db:seed' first."
  exit 1
}

echo
echo "Authenticated routes"
for r in "${PRIVATE[@]}"; do check "$r" "$TOKEN"; done

# Detail routes need a real id, and they are where the interesting runtime
# failures live: they render the most data and the most nested structures.
echo
echo "Detail routes"
DETAILS=$(node --experimental-strip-types scripts/smoke-details.ts) || DETAILS=""
if [ -z "$DETAILS" ]; then
  echo "  skip (no improvement, friction case or account in the database yet)"
else
  while IFS= read -r r; do [ -n "$r" ] && check "$r" "$TOKEN"; done <<< "$DETAILS"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All $(( ${#PUBLIC[@]} + ${#PRIVATE[@]} )) routes returned 200."
else
  echo "$fail route(s) failed."
  echo
  echo "If every authenticated route returned 307, the dev server is holding a"
  echo "handle to a database file that has since been replaced. Restart it."
fi
exit "$fail"
