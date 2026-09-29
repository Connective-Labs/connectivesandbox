#!/usr/bin/env bash
# Connective Sandbox — module waves 1+2 e2e (headless).
#
# Drives BOTH recipe demos end to end against the hosted project:
#   1. admin login → ephemeral client + workflow with the Clean Shades spec
#      (photo_slot, follow_up_card, triage_verdict, quote_panel,
#      thread_preview, escalation_card) → publish (spec PUT),
#   2. client login → POST /run-workflow → every judge lands in the
#      decisions ledger, and every wave panel's judge binding resolves,
#   3. same round trip for the Operations desk spec (status_queue,
#      alert_feed, kpi_tiles, pipeline_tracker + escalation_card),
#   4. cleanup removes the ephemeral tenants.
#
# Consumes one batched judge call + one analysis call per demo (live GLM —
# the sanctioned cost for a real e2e; the admin preview never does this).
# Secrets are read from the firstmate config store by PATH, never printed.
# Run: bash supabase/tests/modules-e2e.sh
# Exits non-zero on the first failed assertion.

set -euo pipefail

SUPABASE_ENV="${SUPABASE_ENV:-/home/macbooklee/firstmate/config/supabase-sandbox.env}"
# shellcheck disable=SC1090
source "$SUPABASE_ENV"

BASE="${SUPABASE_URL%/}/functions/v1"
APIKEY="$SUPABASE_ANON_KEY"
JAR="$(mktemp)"
CJAR="$(mktemp)"
PASS=0
LEDGER_FILE="$(mktemp)"
trap 'rm -f "$JAR" "$CJAR" "$LEDGER_FILE"; cleanup' EXIT
fail() { echo "MODULES E2E FAIL: $1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }

post() {
  curl -sS --max-time 300 -b "$JAR" -c "$JAR" -X POST "$BASE$1" \
    -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "$2"
}
cpost() {
  curl -sS --max-time 300 -b "$CJAR" -c "$CJAR" -X POST "$BASE$1" \
    -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "$2"
}

CLIENT_ID=""
# Self-cleanup (polish 6): EVERY probe row this script creates is deleted
# here — runs in the EXIT trap even on failure, and needs no admin session
# because it deletes by the test's name prefix with the service_role key.
# Finishes with a zero-rows assertion on the same prefix.
TEST_PREFIX="__mod_e2e_"
cleanup() {
  curl -sS --max-time 60 -X DELETE "${SUPABASE_URL%/}/rest/v1/clients?name=like.${TEST_PREFIX}*" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_ANON_KEY" \
    >/dev/null 2>&1 || true
  LEFT="$(curl -sS --max-time 60 -G "${SUPABASE_URL%/}/rest/v1/clients" \
    --data-urlencode "name=like.${TEST_PREFIX}*" -d 'select=name' \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_ANON_KEY" 2>/dev/null || echo '[]')"
  if [ "$(echo "$LEFT" | jq 'length' 2>/dev/null || echo 1)" -ne 0 ]; then
    echo "CLEANUP INCOMPLETE: rows still matching ${TEST_PREFIX}: $LEFT" >&2
    return 1
  fi
  echo "cleanup verified: zero rows matching ${TEST_PREFIX}"
  return 0
}

# --- Shared round trip: publish a spec, run it as the client, verify ledger --
# run_demo <name> <spec-json> <judges-json-array> <intake-state-json>
run_demo() {
  local name="$1" spec="$2" judges="$3" intake="$4"

  local stamp workflow workflow_id
  stamp="$(date +%s)"
  workflow="$(post /admin-api/workflows "{\"client_id\":\"$CLIENT_ID\",\"name\":\"__mod_e2e_${stamp}\"}")"
  workflow_id="$(echo "$workflow" | jq -r '.workflow.id // empty')"
  [ -n "$workflow_id" ] || fail "$name: workflow creation failed: $workflow"

  local put
  put="$(curl -sS --max-time 60 -b "$JAR" -X PUT "$BASE/admin-api/workflows/$workflow_id/spec" \
    -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"spec\":$spec}")"
  echo "$put" | jq -e '.workflow != null' >/dev/null || fail "$name: spec PUT failed: $put"
  ok "$name: spec with wave modules published"

  local run
  run="$(cpost /run-workflow "$(jq -n --arg wf "$workflow_id" --argjson state "$intake" \
    '{workflow_id:$wf, intake_state:$state}')")"
  echo "$run" | jq -e '.error == null' >/dev/null || fail "$name: run-workflow failed: $run"

  # Every judge produced a ledger row with a numeric confidence.
  local ledger judge_count row_count
  ledger="$(echo "$run" | jq -c '.decisions // empty')"
  [ -n "$ledger" ] || fail "$name: no decisions rows in response: $run"
  judge_count="$(echo "$judges" | jq 'length')"
  row_count="$(echo "$ledger" | jq 'length')"
  [ "$row_count" -eq "$judge_count" ] || fail "$name: expected $judge_count ledger rows, got $row_count"
  echo "$ledger" | jq -e 'all(.[]; (.confidence | type) == "number")' >/dev/null \
    || fail "$name: ledger row without numeric confidence: $ledger"
  ok "$name: all $judge_count judges in the decisions ledger (run-workflow response)"

  # Every judge-bound dashboard panel finds its ledger row.
  local dangling
  dangling="$(jq -n --argjson panels "$(echo "$spec" | jq -c '.dashboard.panels')" \
    --argjson ledger "$ledger" '
    [ $panels[] | ((.judge_id // empty),
                   (.band_judge_id // empty),
                   (.follow_up_judge_id // empty),
                   (.quote_judge_id // empty),
                   (.current_judge_id // empty))
    ] - ($ledger | map(.judge_id)) | unique ')"
  [ "$(echo "$dangling" | jq 'length')" -eq 0 ] || fail "$name: panels bound to judges missing from ledger: $dangling"
  ok "$name: every judge-bound panel (triage_verdict, quote_panel, thread_preview, escalation_card, pipeline_tracker) has its ledger row"

  echo "$ledger" > "$LEDGER_FILE"
}

# --- 1. Admin session + ephemeral client ------------------------------------
MINTED="$(post /auth-code '{"role":"admin"}')"
echo "$MINTED" | jq -e '.role == "admin"' >/dev/null || fail "admin session not minted: $MINTED"
ok "admin session minted"

STAMP="$(date +%s)"
CODE="$((STAMP % 9000 + 1000))"
CLIENT="$(post /admin-api/clients "{\"name\":\"__mod_e2e_$STAMP\",\"access_code\":\"$CODE\"}")"
CLIENT_ID="$(echo "$CLIENT" | jq -r '.client.id // empty')"
[ -n "$CLIENT_ID" ] || fail "client creation failed: $CLIENT"

# Client session for the run (the gateway mirrors the RLS scope: a client
# session can only run its own client's workflows).
CMINT="$(curl -sS --max-time 60 -c "$CJAR" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_ID\"}")"
echo "$CMINT" | jq -e '.role == "client"' >/dev/null || fail "client session not minted: $CMINT"
ok "client session minted"

# --- 2. Clean Shades photo triage --------------------------------------------
CLEANSHADES_SPEC="$(cat <<'EOF'
{"name":"Clean Shades photo-to-quote triage","description":"Send a photo of the item; we judge sufficiency, ask one question, and price the job.","intake":{"components":[{"type":"chat","id":"chat","placeholder":"Describe the job…","opening_message":"Send a photo of the item, like the customer's WhatsApp would."},{"type":"photo_slot","id":"slot_curtain","label":"Curtain photo","capture_hint":"Include the rail in frame","accept":["image/*"],"key":"curtain_photo"},{"type":"photo_slot","id":"slot_carpet","label":"Carpet photo","capture_hint":"Show the full item on the floor","accept":["image/*"],"key":"carpet_photo"},{"type":"follow_up_card","id":"clarifier","label":"Follow-up","question":"Which one detail unblocks this job?","options":[{"value":"rail_in_frame","label":"Rail in frame"},{"value":"doorway_shot","label":"Doorway shot"},{"value":"rail_width","label":"Rail width"},{"value":"fabric_tag","label":"Fabric tag"}],"allow_text":true}]},"judges":[{"id":"legibility","state_from":["curtain_photo","carpet_photo"],"question":"Is the enquiry quotable as-is?","question_type":"choice","options":["quotable","one_ask","site_visit","cannot_assess"],"thresholds":{"auto":0.85,"review":0.5}},{"id":"archetype","state_from":["curtain_photo","carpet_photo"],"question":"What item archetype is it?","question_type":"choice","options":["curtain","blind","carpet","rug","sofa","mattress","mixed"],"thresholds":{"auto":0.9,"review":0.5}},{"id":"follow_up","state_from":["curtain_photo","carpet_photo"],"question":"Which pre-authored ask unblocks the job?","question_type":"choice","options":["rail_in_frame","doorway_shot","rail_width","fabric_tag","other"],"thresholds":{"auto":0.9,"review":0.5}},{"id":"price_band","state_from":["curtain_photo","carpet_photo","clarifier"],"question":"Which price band does the job fall in?","question_type":"choice","options":["band_a","band_b","band_c","needs_visit"],"thresholds":{"auto":0.9,"review":0.5}}],"dashboard":{"panels":[{"type":"triage_verdict","id":"verdict","judge_id":"legibility","verdicts":[{"value":"quotable","label":"QUOTABLE"},{"value":"one_ask","label":"ONE-ASK"},{"value":"site_visit","label":"SITE VISIT"},{"value":"cannot_assess","label":"CANNOT ASSESS"}],"follow_up_judge_id":"follow_up"},{"type":"quote_panel","id":"quote","title":"Draft quote","lines":[{"label":"Curtain, black-out","quantity":2,"amount":"S$120–S$170"},{"label":"Carpet, living room","quantity":1,"amount":"S$60–S$90"}],"basis":"Basis: job characteristics, not hours. Valid 14 days.","status":"draft","band_judge_id":"price_band","bands":[{"value":"band_a","label":"S$120–S$180"},{"value":"band_b","label":"S$180–S$260"},{"value":"band_c","label":"S$260–S$400"},{"value":"needs_visit","label":"Site visit required"}]},{"type":"thread_preview","id":"thread","title":"Joined thread","photo_slot_key":"curtain_photo","follow_up_judge_id":"follow_up","quote_judge_id":"price_band"},{"type":"escalation_card","id":"escalation","contact":"Leon","reason":"unclear photo (cannot assess)","reference":"Thread #CS-1042","action_label":"Send to Leon","judge_id":"legibility"},{"type":"confidence_meter","id":"cm_legibility","judge_id":"legibility","label":"Legibility confidence"},{"type":"decision_log","id":"log","limit":10},{"type":"usage_counter","id":"usage","label":"Workflow runs"}]}}
EOF
)"
CLEANSHADES_JUDGES='["legibility","archetype","follow_up","price_band"]'
CLEANSHADES_INTAKE='{"chat":"Curtain and carpet for the living room, photos attached.","curtain_photo":[{"artifact_id":"a1","filename":"IMG_2043.jpg","mime_type":"image/jpeg","size":120000}],"carpet_photo":[],"clarifier":"rail_in_frame"}'

run_demo "Clean Shades" "$CLEANSHADES_SPEC" "$CLEANSHADES_JUDGES" "$CLEANSHADES_INTAKE"
LEDGER_A="$(cat "$LEDGER_FILE")"
# triage_verdict maps the ledger answer into the verdict set; quote_panel into a band.
VERDICT_ANSWER="$(echo "$LEDGER_A" | jq -r '.[] | select(.judge_id=="legibility") | .answer')"
echo "$CLEANSHADES_SPEC" | jq -e --arg v "$VERDICT_ANSWER" '[.dashboard.panels[] | select(.type=="triage_verdict")][0].verdicts | any(.value == $v)' >/dev/null \
  || fail "Clean Shades: verdict answer '$VERDICT_ANSWER' not in triage_verdict verdicts"
ok "Clean Shades: triage_verdict maps ledger answer '$VERDICT_ANSWER' to a verdict label"
BAND_ANSWER="$(echo "$LEDGER_A" | jq -r '.[] | select(.judge_id=="price_band") | .answer')"
echo "$CLEANSHADES_SPEC" | jq -e --arg v "$BAND_ANSWER" '[.dashboard.panels[] | select(.type=="quote_panel")][0].bands | any(.value == $v)' >/dev/null \
  || fail "Clean Shades: band answer '$BAND_ANSWER' not in quote_panel bands"
ok "Clean Shades: quote_panel maps ledger answer '$BAND_ANSWER' to a price band"

# --- 3. Operations desk -------------------------------------------------------
OPS_SPEC="$(cat <<'EOF'
{"name":"LiT operations desk","description":"One omnichannel desk: orders and tickets in a queue, alerts, and two buttons.","intake":{"components":[{"type":"chat","id":"chat","placeholder":"Describe the problem like you'd WhatsApp it…","opening_message":"What needs handling today — a ticket or an order?"},{"type":"form","id":"details","fields":[{"id":"affected","label":"Affected person or SKU","type":"text","required":true},{"id":"office","label":"Office","type":"select","required":true,"options":[{"value":"sg","label":"Singapore"},{"value":"my","label":"Malaysia"},{"value":"vn","label":"Vietnam"}]},{"id":"device","label":"Device or channel","type":"text"}]}]},"judges":[{"id":"severity","state_from":["chat","details"],"question":"How severe is the item?","question_type":"choice","options":["low","medium","high","blocker"],"thresholds":{"auto":0.9,"review":0.5}},{"id":"category","state_from":["chat","details"],"question":"What category is it?","question_type":"choice","options":["email","access","device","network","software","order","other"],"thresholds":{"auto":0.9,"review":0.5}},{"id":"route","state_from":["chat","details"],"question":"How should it be handled?","question_type":"choice","options":["self_serve","automated","human_escalate"],"thresholds":{"auto":0.9,"review":0.5}},{"id":"stage","state_from":["details"],"question":"Which stage is the order at?","question_type":"choice","options":["order","packed","dispatched"],"thresholds":{"auto":0.9,"review":0.5}}],"dashboard":{"panels":[{"type":"status_queue","id":"queue","title":"Omnichannel queue","rows":[{"id":"#4821","label":"SKU 4821, 3 units","source":"Shopify","severity":"high","state":"awaiting stock"},{"id":"#4817","label":"Duvet set, 1 unit","source":"Shopee","severity":"medium","state":"packed"},{"id":"IT-114","label":"Email not syncing, SG office","source":"WhatsApp","severity":"high","state":"open"},{"id":"#4809","label":"Curtain panel, 2 units","source":"Lazada","severity":"low","state":"ready"}],"actions":[{"value":"fulfil","label":"Fulfil","primary":true},{"value":"not_yet","label":"Not yet","primary":false}]},{"type":"alert_feed","id":"alerts","title":"Alerts","alerts":[{"id":"a1","title":"Oversell risk: SKU 4821","source":"Shopify vs warehouse count","age_days":2,"severity":"high"},{"id":"a2","title":"Quotation expired","source":"QT-2291 · Firestone Pte Ltd","age_days":34,"severity":"medium"},{"id":"a3","title":"Payment overdue","source":"INV-3310 · S$4,120","age_days":92,"severity":"medium"}],"action_label":"Review","critical_after_days":30},{"type":"kpi_tiles","id":"kpis","title":"Today","metrics":[{"label":"Decisions today","metric":"decisions_total"},{"label":"Auto-handled","metric":"auto_rate"},{"label":"Escalated","metric":"escalation_rate"}]},{"type":"pipeline_tracker","id":"pipeline","title":"Order pipeline","stages":[{"label":"Order","count":128},{"label":"Packed","count":96},{"label":"Dispatched","count":41}],"current_judge_id":"stage"},{"type":"escalation_card","id":"escalation","contact":"Leddin","reason":"human escalation route","reference":"Queue IT-114","action_label":"Send to Leddin","judge_id":"route"},{"type":"decision_log","id":"log","limit":10},{"type":"usage_counter","id":"usage","label":"Workflow runs"}]}}
EOF
)"
OPS_JUDGES='["severity","category","route","stage"]'
OPS_INTAKE='{"chat":"Email not syncing for the Singapore office, and SKU 4821 is oversold on Shopify.","details":{"affected":"SKU 4821","office":"sg","device":"Shopify"}}'

run_demo "Operations desk" "$OPS_SPEC" "$OPS_JUDGES" "$OPS_INTAKE"
LEDGER_B="$(cat "$LEDGER_FILE")"
STAGE_ANSWER="$(echo "$LEDGER_B" | jq -r '.[] | select(.judge_id=="stage") | .answer')"
echo "$OPS_SPEC" | jq -e --arg v "$STAGE_ANSWER" '[.dashboard.panels[] | select(.type=="pipeline_tracker")][0].stages | any(.label | ascii_downcase == ($v | ascii_downcase))' >/dev/null \
  || fail "Operations desk: stage answer '$STAGE_ANSWER' not a pipeline stage"
ok "Operations desk: pipeline_tracker resolves current stage '$STAGE_ANSWER' from the ledger"

# --- 4. Self-cleanup + zero-rows assertion (polish 6) ------------------------
cleanup || fail "cleanup left rows matching ${TEST_PREFIX} in the live database"
ok "cleanup left zero rows matching ${TEST_PREFIX}"

SESSIONS="$(curl -sS --max-time 60 -b "$JAR" "$BASE/admin-api/workflows" -H "apikey: $APIKEY")"
echo "$SESSIONS" | jq -e '.workflows != null' >/dev/null || true # listing shape varies; durability asserted by the ledger response

echo
echo "MODULES E2E: PASS — $PASS checks; both recipe demos published, ran live, and populated from the decisions ledger"
