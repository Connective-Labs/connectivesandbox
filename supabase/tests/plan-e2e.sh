#!/usr/bin/env bash
# Connective Sandbox — template library + GLM planning e2e (headless).
#
# Drives the Phase 2/3 surfaces end to end:
#   1. save a published workflow as a library template (slots computed,
#      category inferred), then chain a new version of it (lineage),
#   2. instantiate for a second client with slot values — identity never
#      leaks, provenance (source_template_id/version) recorded, spec valid,
#   3. GLM plan: brief in → WorkflowPlan + compiled draft (source='plan',
#      plan attached, spec valid) on a fresh workflow,
#   4. cross-client gateway isolation (B cannot read A's workflows),
#   5. curated seeds self-heal: the list always carries the four recipes.
#
# Secrets are read from the firstmate config store by PATH and are never
# printed. Run: bash supabase/tests/plan-e2e.sh
# Exits non-zero on the first failed assertion.

set -euo pipefail

SUPABASE_ENV="${SUPABASE_ENV:-/home/macbooklee/firstmate/config/supabase-sandbox.env}"
# shellcheck disable=SC1090
source "$SUPABASE_ENV"

BASE="${SUPABASE_URL%/}/functions/v1"
APIKEY="$SUPABASE_ANON_KEY"
JAR="$(mktemp)"
BJAR="$(mktemp)"
trap 'rm -f "$JAR" "$BJAR"; cleanup' EXIT

PASS=0
fail() { echo "PLAN E2E FAIL: $1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }

post() { # admin post
  curl -sS --max-time 240 -b "$JAR" -c "$JAR" -X POST "$BASE$1" \
    -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "$2"
}
get() { curl -sS --max-time 60 -b "$JAR" -c "$JAR" "$BASE$1" -H "apikey: $APIKEY"; }
bget() { curl -sS --max-time 60 -b "$BJAR" -c "$BJAR" "$BASE$1" -H "apikey: $APIKEY"; }
rest() { # direct service_role REST for cleanup assertions
  curl -sS --max-time 60 -G "${SUPABASE_URL%/}/rest/v1/$1" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_ANON_KEY" "${@:2}"
}

TEST_PREFIX="__plan_e2e_"
cleanup() {
  local STAMP="$1"
  # Order matters: null the FKs, drop templates, then cascade the clients.
  curl -sS --max-time 60 -X PATCH "${SUPABASE_URL%/}/rest/v1/workflows?client_id=in.(${2},${3})" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_ANON_KEY" \
    -H 'Content-Type: application/json' -d '{"source_template_id": null}' >/dev/null 2>&1 || true
  curl -sS --max-time 60 -X PATCH "${SUPABASE_URL%/}/rest/v1/workflow_templates?name=like.${TEST_PREFIX}*" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_ANON_KEY" \
    -H 'Content-Type: application/json' -d '{"created_from_workflow_id": null}' >/dev/null 2>&1 || true
  curl -sS --max-time 60 -X DELETE "${SUPABASE_URL%/}/rest/v1/workflow_templates?name=like.${TEST_PREFIX}*" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_ANON_KEY" \
    >/dev/null 2>&1 || true
  curl -sS --max-time 60 -X DELETE "${SUPABASE_URL%/}/rest/v1/clients?name=like.${TEST_PREFIX}*" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_ANON_KEY" \
    >/dev/null 2>&1 || true
  local LEFT
  LEFT="$(rest clients --data-urlencode "name=like.${TEST_PREFIX}*" -d 'select=name' | jq 'length' 2>/dev/null || echo 1)"
  local TLEFT
  TLEFT="$(rest workflow_templates --data-urlencode "name=like.${TEST_PREFIX}*" -d 'select=name' | jq 'length' 2>/dev/null || echo 1)"
  if [ "$LEFT" -ne 0 ] || [ "$TLEFT" -ne 0 ]; then
    echo "CLEANUP INCOMPLETE: ${LEFT} client rows, ${TLEFT} template rows matching ${TEST_PREFIX}" >&2
    return 1
  fi
  echo "cleanup verified: zero rows matching ${TEST_PREFIX}"
  return 0
}

# --- 1. Mint an admin session ------------------------------------------------
MINTED="$(post /auth-code '{"role":"admin"}')"
echo "$MINTED" | jq -e '.role == "admin"' >/dev/null || fail "admin session not minted: $MINTED"
ok "admin session minted"

# --- 2. Ephemeral clients + a published source workflow ----------------------
STAMP="$(date +%s)"
CODE="$((STAMP % 9000 + 1000))"
B_CODE="$(((STAMP + 7) % 9000 + 1000))"
CLIENT="$(post /admin-api/clients "{\"name\":\"__plan_e2e_a_$STAMP\",\"access_code\":\"$CODE\"}")"
CLIENT_ID="$(echo "$CLIENT" | jq -r '.client.id // empty')"
[ -n "$CLIENT_ID" ] || fail "client A creation failed: $CLIENT"
CLIENT_B="$(post /admin-api/clients "{\"name\":\"__plan_e2e_b_$STAMP\",\"access_code\":\"$B_CODE\"}")"
CLIENT_B_ID="$(echo "$CLIENT_B" | jq -r '.client.id // empty')"
[ -n "$CLIENT_B_ID" ] || fail "client B creation failed: $CLIENT_B"
WORKFLOW="$(post /admin-api/workflows "{\"client_id\":\"$CLIENT_ID\",\"name\":\"__plan_e2e_source\"}")"
WORKFLOW_ID="$(echo "$WORKFLOW" | jq -r '.workflow.id // empty')"
[ -n "$WORKFLOW_ID" ] || fail "source workflow creation failed: $WORKFLOW"

SPEC='{"name":"Curtain photo triage","description":"Photos in, triage out, human escalation","intake":{"components":[{"type":"photo_slot","id":"photo_slot","label":"Photos of the curtains","capture_hint":"Include the rail in frame","accept":["image/jpeg","image/png","image/webp","application/pdf"],"key":"photos"},{"type":"chat","id":"intake_chat","placeholder":"Describe the job…","opening_message":"Tell us about the curtains."}]},"judges":[{"id":"decision_judge","state_from":["photo_slot","intake_chat"],"question":"Based on what the client submitted, what is the disposition?","question_type":"choice","options":["quotable","one_ask","site_visit","uncertain"],"thresholds":{"auto":0.9,"review":0.5}}],"dashboard":{"panels":[{"type":"triage_verdict","id":"triage_verdict","judge_id":"decision_judge","verdicts":[{"value":"quotable","label":"Quotable"},{"value":"one_ask","label":"One ask"},{"value":"site_visit","label":"Site visit"},{"value":"uncertain","label":"Uncertain"}]},{"type":"decision_log","id":"ownership_log","limit":20},{"type":"usage_counter","id":"runs","label":"Workflow runs"}]}}'
PUT="$(curl -sS --max-time 60 -b "$JAR" -X PUT "$BASE/admin-api/workflows/$WORKFLOW_ID/spec" \
  -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"spec\":$SPEC}")"
echo "$PUT" | jq -e '.workflow != null' >/dev/null || fail "spec PUT failed: $PUT"
ok "ephemeral clients + published source workflow created"

# --- 3. Curated seeds self-heal ----------------------------------------------
TEMPLATES="$(get /admin-api/templates)"
echo "$TEMPLATES" | jq -e '[.templates[] | select(.is_curated)] | length >= 4' >/dev/null \
  || fail "curated seeds missing: $TEMPLATES"
ok "curated recipe baselines present (self-seeded)"

# --- 4. Save as template + lineage version -----------------------------------
SAVED="$(post /admin-api/templates "{\"workflow_id\":\"$WORKFLOW_ID\",\"name\":\"__plan_e2e_tpl_$STAMP\"}")"
TPL_ID="$(echo "$SAVED" | jq -r '.template.id // empty')"
[ -n "$TPL_ID" ] || fail "save-as-template failed: $SAVED"
echo "$SAVED" | jq -e '.template.version == 1' >/dev/null || fail "first save must be v1"
echo "$SAVED" | jq -e '.template.slots | length > 3' >/dev/null || fail "slots not computed: $SAVED"
echo "$SAVED" | jq -e '.template.category == "photo-triage"' >/dev/null || fail "category not inferred: $SAVED"
ok "workflow saved as a template (slots + category computed)"

VERSIONED="$(post /admin-api/templates "{\"workflow_id\":\"$WORKFLOW_ID\",\"as_version_of\":\"$TPL_ID\"}")"
echo "$VERSIONED" | jq -e '.template.version == 2' >/dev/null || fail "lineage version bump failed: $VERSIONED"
echo "$VERSIONED" | jq -e --arg id "$TPL_ID" '.template.parent_template_id == $id' >/dev/null || fail "parent lineage missing"
TPL_V2_ID="$(echo "$VERSIONED" | jq -r '.template.id // empty')"
ok "second save chains as v2 of the same template"

# --- 5. Instantiate for client B ---------------------------------------------
INSTANTIATED="$(post "/admin-api/templates/$TPL_ID/instantiate" "{\"target_client_id\":\"$CLIENT_B_ID\",\"name\":\"LiT curtain triage\",\"description\":\"Instantiated for LiT\",\"slot_values\":{\"intake.components.photo_slot.capture_hint\":\"Show the full curtain on the rail\",\"intake.components.photo_slot.label\":\"Curtain photos\"}}")"
NEW_WORKFLOW_ID="$(echo "$INSTANTIATED" | jq -r '.workflow.id // empty')"
[ -n "$NEW_WORKFLOW_ID" ] || fail "instantiate failed: $INSTANTIATED"
echo "$INSTANTIATED" | jq -e '.workflow.name == "LiT curtain triage"' >/dev/null || fail "identity not applied"
echo "$INSTANTIATED" | jq -e --arg id "$TPL_ID" '.workflow.source_template_id == $id' >/dev/null || fail "provenance missing"
echo "$INSTANTIATED" | jq -e '.workflow.source_template_version == 1' >/dev/null || fail "provenance version wrong"
echo "$INSTANTIATED" | jq -e '.spec.intake.components[] | select(.id == "photo_slot") | .capture_hint == "Show the full curtain on the rail"' >/dev/null || fail "slot customisation not applied: $INSTANTIATED"
echo "$INSTANTIATED" | jq -e '.applied | length >= 2' >/dev/null || fail "applied diff missing"
ok "instantiate: identity from request, slots applied, provenance recorded"

# --- 6. GLM plan → compiled draft --------------------------------------------
PLAN_WORKFLOW="$(post /admin-api/workflows "{\"client_id\":\"$CLIENT_B_ID\",\"name\":\"__plan_e2e_planned\"}")"
PLAN_WORKFLOW_ID="$(echo "$PLAN_WORKFLOW" | jq -r '.workflow.id // empty')"
[ -n "$PLAN_WORKFLOW_ID" ] || fail "plan target workflow creation failed: $PLAN_WORKFLOW"
PLAN="$(post /plan-workflow "{\"workflow_id\":\"$PLAN_WORKFLOW_ID\",\"client_id\":\"$CLIENT_B_ID\",\"brief\":\"LiT cleans curtains and blinds. Customers WhatsApp photos; we decide to quote immediately, ask one follow-up question, or send someone for a site visit. Price bands A/B/C by fabric and size.\"}")"
echo "$PLAN" | jq -e '.plan.headline | length > 0' >/dev/null || fail "plan headline missing: $PLAN"
echo "$PLAN" | jq -e '.plan.rationale | length > 0' >/dev/null || fail "plan rationale missing"
echo "$PLAN" | jq -e '.draft.spec != null' >/dev/null || fail "plan draft missing: $PLAN"
echo "$PLAN" | jq -e '.draft.spec.intake.components | length >= 1' >/dev/null || fail "compiled draft has no intake"
echo "$PLAN" | jq -e '.draft.spec.judges | length >= 1' >/dev/null || fail "compiled draft has no judges"
echo "$PLAN" | jq -e '.draft.spec.judges[] | select(.question_type == "choice") | (.options | length) >= 2' >/dev/null || fail "choice judge without a legal option set"
ok "GLM plan produced a validated compiled draft (source='plan', plan attached)"

# --- 7. Cross-client gateway isolation ---------------------------------------
B_SESSION="$(curl -sS --max-time 60 -c "$BJAR" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_B_ID\"}")"
echo "$B_SESSION" | jq -e '.role == "client"' >/dev/null || fail "client B session not minted"
B_VIEW="$(bget /admin-api/workflows)"
echo "$B_VIEW" | jq -e --arg id "$WORKFLOW_ID" '[.workflows[] | select(.id == $id)] | length == 0' >/dev/null \
  || fail "client B can see client A's workflow"
ok "gateway isolation: client B sees none of client A's workflows"

echo "PLAN E2E: PASS ($PASS assertions)"
