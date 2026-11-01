#!/usr/bin/env bash
# Request every route and report anything that is not 200.
#
# Catches the class of bug a typechecker and a unit test cannot: a server
# component that renders fine in isolation but fails at runtime — for example
# passing a null-prototype database row to a client component.
set -uo pipefail

BASE="${BASE:-http://localhost:3000}"
EMAIL="${EMAIL:-demo@retainos.example}"

PUBLIC=(/ /features /pricing /docs /integrations /demo /privacy /terms /login /signup /api/v1/health)
PRIVATE=(
  /dashboard /analytics /analytics/events /analytics/funnels /activation /retention /revenue
  /feedback /feedback/requests /feedback/roadmap /improvements /impact /experiments
  /releases /changelog /onboarding-builder /ai /reports
  /settings /settings/sdk /settings/team /settings/integrations /settings/privacy /settings/billing
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

echo
if [ "$fail" -eq 0 ]; then
  echo "All $(( ${#PUBLIC[@]} + ${#PRIVATE[@]} )) routes returned 200."
else
  echo "$fail route(s) failed."
fi
exit "$fail"
