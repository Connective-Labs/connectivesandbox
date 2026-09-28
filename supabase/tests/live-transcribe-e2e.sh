#!/usr/bin/env bash
# Connective Sandbox — live transcription pipeline e2e (headless, no mic).
#
# Simulates a discovery call by feeding synthetic transcript segments through
# the deployed `live-draft` Edge Function, asserting:
#   1. screening flags change-states at the right beats (draft / no-change),
#   2. drafts regenerate, validate server-side, and versions accumulate,
#   3. the rate guard holds (a burst produces bounded drafts),
#   4. publishing updates the workflow and the client login sees the spec.
#
# Secrets are read from the firstmate config store by PATH and are never
# printed. Run: bash supabase/tests/live-transcribe-e2e.sh
# Exits non-zero on the first failed assertion.

set -euo pipefail

SUPABASE_ENV="${SUPABASE_ENV:-/home/macbooklee/firstmate/config/supabase-sandbox.env}"
ADMIN_ENV="${ADMIN_ENV:-/home/macbooklee/firstmate/config/connectivesandbox-admin.env}"
# shellcheck disable=SC1090
source "$SUPABASE_ENV"
# shellcheck disable=SC1090
source "$ADMIN_ENV"

BASE="${SUPABASE_URL%/}/functions/v1"
APIKEY="$SUPABASE_ANON_KEY"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

PASS=0
fail() { echo "E2E FAIL: $1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }

post() { # path, body -> response body
  curl -sS --max-time 240 -b "$JAR" -c "$JAR" -X POST "$BASE$1" \
    -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "$2"
}
get() { curl -sS --max-time 60 -b "$JAR" -c "$JAR" "$BASE$1" -H "apikey: $APIKEY"; }
del() { curl -sS --max-time 60 -b "$JAR" -c "$JAR" -X DELETE "$BASE$1" -H "apikey: $APIKEY"; }

# --- 1. Mint an admin session (trusted-browser mint, phase 5 design) -------
MINTED="$(post /auth-code '{"role":"admin"}')"
echo "$MINTED" | jq -e '.role == "admin"' >/dev/null || fail "admin session not minted: $MINTED"
ok "admin session minted"

# --- 2. Ephemeral client + workflow ----------------------------------------
STAMP="$(date +%s)"
CODE="$((STAMP % 9000 + 1000))"
CLIENT="$(post /admin-api/clients "{\"name\":\"__live_e2e_$STAMP\",\"access_code\":\"$CODE\"}")"
CLIENT_ID="$(echo "$CLIENT" | jq -r '.client.id // empty')"
[ -n "$CLIENT_ID" ] || fail "client creation failed: $CLIENT"
WORKFLOW="$(post /admin-api/workflows "{\"client_id\":\"$CLIENT_ID\",\"name\":\"__live_e2e_workflow\"}")"
WORKFLOW_ID="$(echo "$WORKFLOW" | jq -r '.workflow.id // empty')"
[ -n "$WORKFLOW_ID" ] || fail "workflow creation failed: $WORKFLOW"
SESSION_ID="e2e-call-$STAMP"
ok "ephemeral client+workflow created"

cleanup() {
  # Try the admin-api gateway first, fall back to service_role (env only,
  # never printed) so a mid-run crash cannot orphan test tenants.
  curl -sS --max-time 60 -b "$JAR" -X DELETE "$BASE/admin-api/clients/$CLIENT_ID" \
    -H "apikey: $APIKEY" >/dev/null || true
  curl -sS --max-time 60 -X DELETE "${SUPABASE_URL%/}/rest/v1/clients?id=eq.$CLIENT_ID" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    >/dev/null || true
}
trap 'rm -f "$JAR"; cleanup' EXIT

# --- 3. Beat 1: the business pattern → material change, draft v1 ------------
R1="$(post /live-draft "{\"client_id\":\"$CLIENT_ID\",\"workflow_id\":\"$WORKFLOW_ID\",\"session_id\":\"$SESSION_ID\",\"transcript_digest\":\"Rep: tell me about your business. Client: my client is a curtain cleaning company handling delicate fabrics and heavy drapes.\",\"new_segments\":[{\"segment_index\":0,\"text\":\"my client is a curtain cleaning company handling delicate fabrics and heavy drapes.\"}]}")"
echo "$R1" | jq -e '.changed == true' >/dev/null || fail "beat 1 should be a material change: $R1"
V1="$(echo "$R1" | jq -r '.draft_version // empty')"
[ "$V1" = "1" ] || fail "expected draft v1 at beat 1, got: $R1"
echo "$R1" | jq -e '.draft_spec.judges | length >= 1' >/dev/null || fail "draft v1 has no judges: $R1"
echo "$R1" | jq -e '.draft_spec.dashboard.panels | length >= 1' >/dev/null || fail "draft v1 has no panels: $R1"
ok "beat 1: material change screened, validated draft v1 returned"

# --- 4. Beat 2: small talk → no change, no draft ----------------------------
R2="$(post /live-draft "{\"client_id\":\"$CLIENT_ID\",\"workflow_id\":\"$WORKFLOW_ID\",\"session_id\":\"$SESSION_ID\",\"transcript_digest\":\"...\",\"new_segments\":[{\"segment_index\":1,\"text\":\"thanks so much, that is really helpful, lovely weather this week isn't it\"}]}")"
echo "$R2" | jq -e '.changed == false' >/dev/null || fail "beat 2 should be no_change: $R2"
echo "$R2" | jq -e '.draft_spec == null' >/dev/null || fail "beat 2 must not draft: $R2"
ok "beat 2: small talk screened as no_change, no draft"

# --- 5. Beat 3: intake + escalation specifics → draft v2 (after cooldown) ---
sleep 16
R3="$(post /live-draft "{\"client_id\":\"$CLIENT_ID\",\"workflow_id\":\"$WORKFLOW_ID\",\"session_id\":\"$SESSION_ID\",\"transcript_digest\":\"curtain cleaning company, delicate fabrics.\",\"new_segments\":[{\"segment_index\":2,\"text\":\"customers send photos of the curtains through whatsapp and we decide whether we can quote straight away or need a site visit.\"},{\"segment_index\":3,\"text\":\"heavy staining or delicate silk means a human always looks at it before we commit to anything.\"}]}")"
echo "$R3" | jq -e '.changed == true' >/dev/null || fail "beat 3 should be a material change: $R3"
V3="$(echo "$R3" | jq -r '.draft_version // empty')"
[ "$V3" = "2" ] || fail "expected draft v2 at beat 3, got: $R3"
ok "beat 3: intake+escalation change screened, validated draft v2 returned"

# --- 6. Burst: rapid rambling → rate guard bounds drafts --------------------
for i in 1 2 3; do
  RB="$(post /live-draft "{\"client_id\":\"$CLIENT_ID\",\"workflow_id\":\"$WORKFLOW_ID\",\"session_id\":\"$SESSION_ID\",\"transcript_digest\":\"burst\",\"new_segments\":[{\"segment_index\":$((3+i)),\"text\":\"actually we also need to handle pickup scheduling and delivery notes for the curtains.\"}]}")"
  echo "$RB" | jq -e '(.draft_version == null) or (.draft_version <= 2)' >/dev/null || fail "burst produced an unexpected new draft v$(echo "$RB" | jq -r '.draft_version'): $RB"
done
DRAFTS="$(get "/live-draft?workflow_id=$WORKFLOW_ID")"
COUNT="$(echo "$DRAFTS" | jq '.drafts | length')"
[ "$COUNT" = "2" ] || fail "expected 2 drafts after burst, got $COUNT"
echo "$DRAFTS" | jq -e '[.drafts[].version] == [2, 1]' >/dev/null || fail "draft versions should be [2,1]: $DRAFTS"
ok "rate guard held: burst produced no extra drafts (versions [2,1])"

# --- 7. Publish draft v2 → client sees the published spec --------------------
SPEC_V2="$(echo "$DRAFTS" | jq -c '.drafts[] | select(.version == 2) | .spec')"
DRAFT_ID_V2="$(echo "$DRAFTS" | jq -r '.drafts[] | select(.version == 2) | .id')"
PUT="$(curl -sS --max-time 60 -b "$JAR" -X PUT "$BASE/admin-api/workflows/$WORKFLOW_ID/spec" \
  -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"spec\":$SPEC_V2}")"
echo "$PUT" | jq -e '.workflow != null' >/dev/null || fail "publish (PUT spec) failed: $PUT"
PATCHED="$(post /live-draft "{\"draft_id\":\"$DRAFT_ID_V2\",\"published\":true}" || true)"
# PATCH via -X is required (post() uses POST); do it explicitly:
PATCHED="$(curl -sS --max-time 60 -b "$JAR" -X PATCH "$BASE/live-draft" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"draft_id\":\"$DRAFT_ID_V2\",\"published\":true}")"
echo "$PATCHED" | jq -e '.draft.published == true' >/dev/null || fail "draft published flag not set: $PATCHED"

# Client session: mint with the client's code, then read its workflow.
CJAR="$(mktemp)"
CMINT="$(curl -sS --max-time 60 -c "$CJAR" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_ID\"}")"
echo "$CMINT" | jq -e '.role == "client"' >/dev/null || fail "client session not minted: $CMINT"
CWKF="$(curl -sS --max-time 60 -b "$CJAR" "$BASE/admin-api/workflows/$WORKFLOW_ID" -H "apikey: $APIKEY")"
echo "$CWKF" | jq -e --argjson spec "$SPEC_V2" '.workflow.spec.name == $spec.name and (.workflow.spec.intake.components | length >= 1)' >/dev/null || fail "client does not see the published spec: $CWKF"
rm -f "$CJAR"
ok "publish flow works: client login sees the published spec (v$(( $(echo "$DRAFTS" | jq '.drafts[0].version') )))"

# --- 8. Client isolation over the transcript pipeline ------------------------
CJAR="$(mktemp)"
curl -sS --max-time 60 -c "$CJAR" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_ID\"}" >/dev/null
LD="$(curl -sS --max-time 60 -b "$CJAR" "$BASE/live-draft?workflow_id=$WORKFLOW_ID" -H "apikey: $APIKEY")"
echo "$LD" | jq -e '(.error // "") | contains("Admin")' >/dev/null || fail "client JWT reached live-draft: $LD"
rm -f "$CJAR"
ok "client JWT is rejected by live-draft (admin session required)"

echo "LIVE TRANSCRIBE E2E: PASS ($PASS checks)"
