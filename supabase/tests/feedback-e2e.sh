#!/usr/bin/env bash
# Connective Sandbox — feedback channel e2e (headless).
#
# Drives the dual-output feedback pipeline end to end:
#   1. client login → sends a labelled feedback set (>=10 samples) covering
#      wording / structure / accuracy / feature_request / bug / question,
#      reports classification accuracy,
#   2. wording + structure produce versioned drafts (source='feedback');
#      the other classes never do,
#   3. the rate guard bounds planner calls per client per hour,
#   4. rep login → thread list with unread badges → open thread → reply,
#   5. Publish a draft → client sees the change + the rep's reply; Discard works,
#   6. a second client cannot read the first client's thread (gateway scope).
#
# Secrets are read from the firstmate config store by PATH and are never
# printed. Run: bash supabase/tests/feedback-e2e.sh
# Exits non-zero on the first failed assertion.

set -euo pipefail

SUPABASE_ENV="${SUPABASE_ENV:-/home/macbooklee/firstmate/config/supabase-sandbox.env}"
# shellcheck disable=SC1090
source "$SUPABASE_ENV"

BASE="${SUPABASE_URL%/}/functions/v1"
APIKEY="$SUPABASE_ANON_KEY"
JAR="$(mktemp)"
CJAR="$(mktemp)"
BJAR="$(mktemp)"
trap 'rm -f "$JAR" "$CJAR" "$BJAR"; cleanup' EXIT

PASS=0
fail() { echo "FEEDBACK E2E FAIL: $1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }

post() { # path, body -> response body
  curl -sS --max-time 240 -b "$JAR" -c "$JAR" -X POST "$BASE$1" \
    -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "$2"
}
cpost() { # client-jar post
  curl -sS --max-time 240 -b "$CJAR" -c "$CJAR" -X POST "$BASE$1" \
    -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "$2"
}
get() { curl -sS --max-time 60 -b "$JAR" -c "$JAR" "$BASE$1" -H "apikey: $APIKEY"; }
cget() { curl -sS --max-time 60 -b "$CJAR" -c "$CJAR" "$BASE$1" -H "apikey: $APIKEY"; }
bget() { curl -sS --max-time 60 -b "$BJAR" -c "$BJAR" "$BASE$1" -H "apikey: $APIKEY"; }

# --- 1. Mint an admin session ----------------------------------------------
MINTED="$(post /auth-code '{"role":"admin"}')"
echo "$MINTED" | jq -e '.role == "admin"' >/dev/null || fail "admin session not minted: $MINTED"
ok "admin session minted"

# --- 2. Ephemeral clients + workflow with a real spec -----------------------
STAMP="$(date +%s)"
CODE="$((STAMP % 9000 + 1000))"
B_CODE="$(((STAMP + 7) % 9000 + 1000))"
CLIENT="$(post /admin-api/clients "{\"name\":\"__fb_e2e_a_$STAMP\",\"access_code\":\"$CODE\"}")"
CLIENT_ID="$(echo "$CLIENT" | jq -r '.client.id // empty')"
[ -n "$CLIENT_ID" ] || fail "client A creation failed: $CLIENT"
CLIENT_B="$(post /admin-api/clients "{\"name\":\"__fb_e2e_b_$STAMP\",\"access_code\":\"$B_CODE\"}")"
CLIENT_B_ID="$(echo "$CLIENT_B" | jq -r '.client.id // empty')"
[ -n "$CLIENT_B_ID" ] || fail "client B creation failed: $CLIENT_B"
WORKFLOW="$(post /admin-api/workflows "{\"client_id\":\"$CLIENT_ID\",\"name\":\"__fb_e2e_workflow\"}")"
WORKFLOW_ID="$(echo "$WORKFLOW" | jq -r '.workflow.id // empty')"
[ -n "$WORKFLOW_ID" ] || fail "workflow creation failed: $WORKFLOW"

SPEC='{"name":"Curtain quote desk","description":"Photo intake for curtain cleaning quotes","intake":{"components":[{"type":"file_upload","id":"photo_slot","label":"Photos of the curtains","accept":["image/jpeg","image/png"],"multiple":true,"instructions":"Upload clear photos of the curtains."},{"type":"chat","id":"intake_chat","placeholder":"Describe the job…","opening_message":"Tell us about the curtains and attach photos."}]},"judges":[{"id":"decision_judge","state_from":["photo_slot","intake_chat"],"question":"Based on what the client submitted, what is the disposition?","question_type":"choice","options":["quotable","one_ask","site_visit","uncertain"],"thresholds":{"auto":0.9,"review":0.5}}],"dashboard":{"panels":[{"type":"confidence_meter","id":"confidence_decision_judge","judge_id":"decision_judge","label":"Decision confidence"},{"type":"analysis","id":"summary","title":"Summary","source":"llm"}]}}'
PUT="$(curl -sS --max-time 60 -b "$JAR" -X PUT "$BASE/admin-api/workflows/$WORKFLOW_ID/spec" \
  -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"spec\":$SPEC}")"
echo "$PUT" | jq -e '.workflow != null' >/dev/null || fail "spec PUT failed: $PUT"
ok "ephemeral clients+workflow created, spec loaded"

# Self-cleanup (polish 6): delete by the test's name prefix with the
# service_role key — runs in the EXIT trap even on failure, no admin session
# needed — then assert zero rows remain matching the prefix.
TEST_PREFIX="__fb_e2e_"
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

# --- 3. Client session -------------------------------------------------------
CMINT="$(curl -sS --max-time 60 -c "$CJAR" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_ID\"}")"
echo "$CMINT" | jq -e '.role == "client"' >/dev/null || fail "client session not minted: $CMINT"
ok "client session minted"

# --- 4. Labelled classification set (>=10 samples) ---------------------------
# body|expected_class|must_draft (wording/structure samples drive the planner)
LABELLED=(
  "The 'Photos of the curtains' label is confusing — please call it 'Upload photos of the affected area' instead.|wording|yes"
  "Reword the opening message, it sounds too formal for our customers.|wording|yes"
  "The intake should start with a short text field asking for the pickup address before the photos.|structure|yes"
  "Please add a step where we can upload supporting documents like invoices.|structure|yes"
  "It classified my submission wrong — this was clearly quotable, not one_ask.|accuracy|no"
  "The decision last week was wrong; it should have been approved, not escalated.|accuracy|no"
  "Can the system also email me a copy of the quote report when it is ready?|feature_request|no"
  "The upload button does nothing when I click it — the page just sits there.|bug|no"
  "How long does a typical quote take once we submit photos?|question|no"
  "Thanks for the quick turnaround on last Friday's request.|question|no"
  "Where do I find the old quotations you prepared for us?|question|no"
)

TOTAL=0
CORRECT=0
RESULTS=""
i=0
for row in "${LABELLED[@]}"; do
  body="${row%%|*}"
  rest="${row#*|}"
  expected="${rest%%|*}"
  must_draft="${rest##*|}"
  i=$((i + 1))
  RESPONSE="$(cpost /feedback "$(jq -n --arg body "$body" --arg wf "$WORKFLOW_ID" '{body:$body, workflow_id:$wf}')")"
  classification="$(echo "$RESPONSE" | jq -r '.classification // "MISSING"')"
  [ "$classification" != "MISSING" ] || fail "sample $i got no classification: $RESPONSE"
  if [ "$classification" = "$expected" ]; then CORRECT=$((CORRECT + 1)); fi
  TOTAL=$((TOTAL + 1))
  RESULTS="$RESULTS
  sample $i: expected=$expected got=$classification"
  # Dual-output discipline: drafts ONLY for wording/structure, and even then
  # the rate guard may hold one back (planner_suppressed).
  draft_version="$(echo "$RESPONSE" | jq -r '.draft.version // empty')"
  suppressed="$(echo "$RESPONSE" | jq -r '.planner_suppressed // false')"
  case "$classification" in
    wording|structure)
      if [ "$draft_version" = "" ] && [ "$suppressed" != "true" ]; then
        fail "sample $i ($classification) produced no draft and no suppression: $RESPONSE"
      fi
      if [ "$must_draft" != "yes" ]; then
        echo "note: sample $i misclassified as $classification (counted in accuracy)"
      fi
      ;;
    *)
      [ "$draft_version" = "" ] || fail "sample $i ($classification) must NOT produce a draft: $RESPONSE"
      ;;
  esac
done
ACCURACY="$(jq -n --argjson c "$CORRECT" --argjson t "$TOTAL" '$c / $t')"
echo "classification accuracy: $CORRECT/$TOTAL = $ACCURACY"
echo "$RESULTS"
[ "$CORRECT" -ge 8 ] || fail "classification accuracy $CORRECT/$TOTAL below the 8/10 gate"
ok "labelled set classified: $CORRECT/$TOTAL correct, drafts only for wording/structure"

# --- 5. Rate guard: the hourly planner budget holds the next draft back ------
# The labelled wording/structure samples already consumed the budget's first
# slots; keep sending until the guard bites (max 3 extra to bound the run).
SUPPRESSED_HIT=false
for j in 1 2 3; do
  RB="$(cpost /feedback "$(jq -n --arg body "Also please reword the photo instructions, customers ignore them. (rate-guard probe $j)" --arg wf "$WORKFLOW_ID" '{body:$body, workflow_id:$wf}')")"
  if [ "$(echo "$RB" | jq -r '.planner_suppressed // false')" = "true" ]; then
    SUPPRESSED_HIT=true
    break
  fi
done
[ "$SUPPRESSED_HIT" = "true" ] || fail "rate guard never bit after 4+3 wording/structure messages"
ok "rate guard bounded the planner: a wording message came back planner_suppressed"

# --- 6. Rep: thread list, unread badges, thread open -------------------------
THREADS="$(get '/feedback?threads=1')"
UNREAD="$(echo "$THREADS" | jq --arg id "$CLIENT_ID" '.threads[] | select(.client_id == $id) | .unread')"
[ "${UNREAD:-0}" -ge 11 ] || fail "unread badge missing/low for client A thread: $THREADS"
echo "$THREADS" | jq -e --arg id "$CLIENT_ID" '.threads[] | select(.client_id == $id) | .latest_classification != null' >/dev/null \
  || fail "no classification chip on the thread list"
ok "rep inbox: thread listed with unread badge + classification chip"

THREAD="$(get "/feedback?client_id=$CLIENT_ID")"
MSG_COUNT="$(echo "$THREAD" | jq '.messages | length')"
[ "$MSG_COUNT" -ge 11 ] || fail "thread open returned too few messages: $MSG_COUNT"
DRAFT_COUNT="$(echo "$THREAD" | jq '[.drafts[] | select(.published == false)] | length')"
[ "$DRAFT_COUNT" -ge 1 ] || fail "no proposed drafts in the thread"
echo "$THREAD" | jq -e '.drafts[0].delta_summary | length > 0' >/dev/null || fail "draft has no plain-language diff"
echo "$THREAD" | jq -e '.drafts[0].spec.name | length > 0' >/dev/null || fail "draft spec invalid"
UNREAD_AFTER="$(echo "$THREADS" | jq --arg id "$CLIENT_ID" '.threads[] | select(.client_id == $id) | .unread')"
THREAD_AFTER="$(get "/feedback?threads=1")"
UNREAD_NOW="$(echo "$THREAD_AFTER" | jq --arg id "$CLIENT_ID" '.threads[] | select(.client_id == $id) | .unread')"
[ "$UNREAD_NOW" = "0" ] || fail "opening the thread did not mark it read (unread=$UNREAD_NOW, was $UNREAD_AFTER)"
ok "rep opened the thread: messages + $(echo "$THREAD" | jq '[.drafts[] | select(.published == false)] | length') proposed drafts, unread cleared"

# --- 7. Rep reply → client sees it -------------------------------------------
REPLY="$(post /feedback "{\"client_id\":\"$CLIENT_ID\",\"body\":\"Thanks — we will reword the labels this week and confirm here.\"}")"
echo "$REPLY" | jq -e '.message.direction == "rep"' >/dev/null || fail "rep reply not stored: $REPLY"
CSEEN="$(cget /feedback)"
echo "$CSEEN" | jq -e '[.messages[] | select(.direction == "rep")] | length >= 1' >/dev/null \
  || fail "client does not see the rep's reply: $CSEEN"
echo "$CSEEN" | jq -e '[.messages[] | select(.direction == "rep" and .read_by_client == true)] | length >= 1' >/dev/null \
  || fail "rep reply not marked read for the client"
ok "rep reply stored; client sees it in their Feedback thread (marked read)"

# --- 8. Publish a proposed draft → client sees the change ---------------------
DRAFT_ID="$(echo "$THREAD" | jq -r '[.drafts[] | select(.published == false)] | sort_by(.created_at) | reverse | .[0].id')"
DRAFT_SPEC="$(echo "$THREAD" | jq -c "[.drafts[] | select(.id == \"$DRAFT_ID\")][0].spec")"
PUT_DRAFT="$(curl -sS --max-time 60 -b "$JAR" -X PUT "$BASE/admin-api/workflows/$WORKFLOW_ID/spec" \
  -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"spec\":$DRAFT_SPEC}")"
echo "$PUT_DRAFT" | jq -e '.workflow != null' >/dev/null || fail "publishing the draft failed: $PUT_DRAFT"
PATCHED="$(curl -sS --max-time 60 -b "$JAR" -X PATCH "$BASE/live-draft" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"draft_id\":\"$DRAFT_ID\",\"published\":true}")"
echo "$PATCHED" | jq -e '.draft.published == true' >/dev/null || fail "draft published flag not set: $PATCHED"
CWKF="$(curl -sS --max-time 60 -b "$CJAR" "$BASE/admin-api/workflows/$WORKFLOW_ID" -H "apikey: $APIKEY")"
echo "$CWKF" | jq -e --argjson spec "$DRAFT_SPEC" '.workflow.spec.name == $spec.name' >/dev/null \
  || fail "client does not see the published draft: $CWKF"
ACTIVITY="$(get "/feedback?client_id=$CLIENT_ID")"
echo "$ACTIVITY" | jq -e --arg id "$DRAFT_ID" '[.drafts[] | select(.id == $id and .published == true)] | length == 1' >/dev/null \
  || fail "published draft missing from the change log"
ok "publish flow works: client sees the change; change log carries the approved draft"

# --- 9. Discard path ----------------------------------------------------------
BEFORE_DISCARD="$(get "/feedback?client_id=$CLIENT_ID" | jq '[.drafts[] | select(.published == false)] | length')"
DISCARD_ID="$(get "/feedback?client_id=$CLIENT_ID" | jq -r '[.drafts[] | select(.published == false)] | sort_by(.created_at) | reverse | .[0].id')"
if [ -n "$DISCARD_ID" ] && [ "$DISCARD_ID" != "null" ]; then
  DEL="$(curl -sS --max-time 60 -b "$JAR" -X DELETE "$BASE/live-draft?draft_id=$DISCARD_ID" -H "apikey: $APIKEY")"
  echo "$DEL" | jq -e '.ok == true' >/dev/null || fail "discard failed: $DEL"
  AFTER_DISCARD="$(get "/feedback?client_id=$CLIENT_ID" | jq '[.drafts[] | select(.published == false)] | length')"
  [ "$AFTER_DISCARD" = "$((BEFORE_DISCARD - 1))" ] || fail "discard did not remove the draft ($BEFORE_DISCARD -> $AFTER_DISCARD)"
  ok "discard path works ($BEFORE_DISCARD -> $AFTER_DISCARD proposed drafts)"
else
  ok "discard path: no unpublished draft left to discard (all consumed by publish)"
fi

# --- 11. Gateway isolation between clients ------------------------------------
BMINT="$(curl -sS --max-time 60 -c "$BJAR" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_B_ID\"}")"
echo "$BMINT" | jq -e '.role == "client"' >/dev/null || fail "client B session not minted: $BMINT"
BVIEW="$(bget /feedback)"
echo "$BVIEW" | jq -e '[.messages[] | select(.client_id != '"\"$CLIENT_B_ID\""')] | length == 0' >/dev/null \
  || fail "client B can read client A's feedback thread: $BVIEW"
ok "gateway isolation: client B sees zero of client A's feedback rows"

# --- 11. Self-cleanup + zero-rows assertion (polish 6; also runs in the trap) -
cleanup || fail "cleanup left rows matching ${TEST_PREFIX} in the live database"
ok "cleanup left zero rows matching ${TEST_PREFIX}"

echo "FEEDBACK E2E: PASS ($PASS checks)"
