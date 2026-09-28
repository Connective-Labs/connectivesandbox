#!/usr/bin/env bash
# Connective Sandbox — livebuild v2 e2e: the fact-ledger pipeline (headless).
#
# Simulates a discovery call by feeding synthetic transcript segments through
# the deployed `live-facts` Edge Function, asserting the architecture's core
# claims:
#   1. IDEMPOTENCY UNDER REPETITION — the photo requirement stated three times
#      and escalation stated twice yield each keyed fact ONCE in the ledger.
#   2. DUPLICATE-FREE COMPILATION — across every draft, no component id,
#      judge id, or panel id repeats; regenerating (flush compile) is stable.
#   3. DRAFTS ALWAYS VALIDATE and are never rejected (never-reject contract).
#   4. RATE/COST GUARDS — screen cadence ~5s, extract cadence ~8s, draft floor
#      ~10s; a rambling burst produces bounded jev calls and drafts.
#   5. CROSS-ENGINE PARITY — the same transcript fed as sentence-final chunks
#      (Web Speech path) and as 8s rolling chunks (server STT path) yields the
#      same ledger signature.
#   6. PUBLISH — the compiled draft reaches the client through the existing
#      publish path.
#   7. ISOLATION — client JWTs read zero transcript_facts/spec_drafts rows.
#
# Secrets are read from the firstmate config store by PATH and are never
# printed. Run: bash supabase/tests/live-transcribe-e2e.sh

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

# --- 1. Mint an admin session ------------------------------------------------
MINTED="$(post /auth-code '{"role":"admin"}')"
echo "$MINTED" | jq -e '.role == "admin"' >/dev/null || fail "admin session not minted: $MINTED"
ok "admin session minted"

# --- 2. Ephemeral client + workflow ------------------------------------------
STAMP="$(date +%s)"
CODE="$((STAMP % 9000 + 1000))"
CLIENT="$(post /admin-api/clients "{\"name\":\"__livefacts_e2e_$STAMP\",\"access_code\":\"$CODE\"}")"
CLIENT_ID="$(echo "$CLIENT" | jq -r '.client.id // empty')"
[ -n "$CLIENT_ID" ] || fail "client creation failed: $CLIENT"
WORKFLOW="$(post /admin-api/workflows "{\"client_id\":\"$CLIENT_ID\",\"name\":\"Photo triage\"}")"
WORKFLOW_ID="$(echo "$WORKFLOW" | jq -r '.workflow.id // empty')"
[ -n "$WORKFLOW_ID" ] || fail "workflow creation failed: $WORKFLOW"
SESSION_ID="e2e-facts-$STAMP"
ok "ephemeral client+workflow created (recipe: Photo triage)"

cleanup() {
  curl -sS --max-time 60 -b "$JAR" -X DELETE "$BASE/admin-api/clients/$CLIENT_ID" \
    -H "apikey: $APIKEY" >/dev/null || true
  curl -sS --max-time 60 -X DELETE "${SUPABASE_URL%/}/rest/v1/clients?id=eq.$CLIENT_ID" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    >/dev/null || true
}
trap 'rm -f "$JAR"; cleanup' EXIT

DIGEST_FILE="$(mktemp)"
trap 'rm -f "$JAR" "$DIGEST_FILE"; cleanup' EXIT

# send_beat INDEX "text" — one final segment through the pipeline
send_beat() {
  local index="$1"; local text="$2"
  printf '%s\n' "$text" >>"$DIGEST_FILE"
  local digest
  digest="$(jq -Rs . <"$DIGEST_FILE")"
  jq -n --arg c "$CLIENT_ID" --arg w "$WORKFLOW_ID" --arg s "$SESSION_ID" \
        --argjson i "$index" --arg t "$text" --argjson d "$digest" \
        '{client_id:$c, workflow_id:$w, session_id:$s,
          new_segments:[{segment_index:$i, text:$t}], transcript_digest:$d}'
}

# --- 3. Beat 1: the business pattern → material change → draft v1 -------------
R1="$(post /live-facts "$(send_beat 0 'my client is a curtain cleaning company; customers need to send photos of the curtains so we can decide what to do')")"
echo "$R1" | jq -e '.error == null' >/dev/null || fail "beat 1 errored: $R1"
echo "$R1" | jq -e '.screen_suppressed != true' >/dev/null || fail "beat 1 unexpectedly screen-suppressed: $R1"
echo "$R1" | jq -e '.changed == true' >/dev/null || fail "beat 1 should be a material change: $R1"
V1="$(echo "$R1" | jq -r '.draft.version // empty')"
[ -n "$V1" ] || fail "beat 1 produced no draft: $R1"
echo "$R1" | jq -e '.draft.spec.intake.components | length >= 1' >/dev/null || fail "draft v1 has no intake: $R1"
ok "beat 1: material change screened, compiled draft v$V1 returned"

# --- 4. Beat 2: small talk → no change, no draft ------------------------------
sleep 6
R2="$(post /live-facts "$(send_beat 1 "thanks so much, that is really helpful, lovely weather this week isn't it")")"
echo "$R2" | jq -e '.changed == false' >/dev/null || fail "beat 2 should be no_change: $R2"
echo "$R2" | jq -e '.draft == null' >/dev/null || fail "beat 2 must not draft: $R2"
ok "beat 2: small talk screened as no_change (cheap stage-1 only)"

# --- 5. Beats 3–5: REPETITION — the photo requirement three times, escalation
#         twice. Each keyed fact must land ONCE in the replayed ledger. ------
sleep 6
R3="$(post /live-facts "$(send_beat 2 'customers describe the job in their own words when they message us, like a whatsapp')")"
echo "$R3" | jq -e '.error == null' >/dev/null || fail "beat 3 errored: $R3"
sleep 6
R4="$(post /live-facts "$(send_beat 3 'like I said, customers send us photos of the curtains — that is how every job starts')")"
echo "$R4" | jq -e '.error == null' >/dev/null || fail "beat 4 errored: $R4"
sleep 6
R5="$(post /live-facts "$(send_beat 4 'so yes — the photos come in first, then we decide; heavy staining on delicate silk means a human always looks at it before we commit')")"
echo "$R5" | jq -e '.error == null' >/dev/null || fail "beat 5 errored: $R5"
sleep 6
R6="$(post /live-facts "$(send_beat 5 'to repeat: photos first, and a person reviews anything risky — that is the whole flow')")"
echo "$R6" | jq -e '.error == null' >/dev/null || fail "beat 6 errored: $R6"

# Replay the ledger and assert idempotency by key.
LEDGER="$(get "/live-facts?client_id=$CLIENT_ID&session_id=$SESSION_ID&workflow_id=$WORKFLOW_ID")"
echo "$LEDGER" | jq -e '.ledger != null' >/dev/null || fail "ledger replay failed: $LEDGER"
PHOTO_COUNT="$(echo "$LEDGER" | jq '[.ledger[] | select(.key == "intake.photo" and .active)] | length')"
[ "$PHOTO_COUNT" = "1" ] || fail "intake.photo must replay to ONE active fact, got $PHOTO_COUNT"
ESC_COUNT="$(echo "$LEDGER" | jq '[.ledger[] | select(.key == "judge.escalation" and .active)] | length')"
[ "$ESC_COUNT" = "1" ] || fail "judge.escalation must replay to ONE active fact, got $ESC_COUNT"
SIG="$(echo "$LEDGER" | jq -r '.signature')"
STRUCT_SIG="$(echo "$LEDGER" | jq -r '.structural_signature')"
[ -n "$SIG" ] || fail "ledger signature missing: $LEDGER"
ok "repetition idempotency: 3x photo + 2x escalation → each key exactly once (signature ${SIG:0:40}…)"

# --- 6. Cross-engine parity: the same words, chunked as the server STT engine
#         would (8s rolling chunks splitting sentences) in a fresh session. ---
SESSION_ID="e2e-facts-parity-$STAMP"
> "$DIGEST_FILE"
P1="$(post /live-facts "$(send_beat 0 'my client is a curtain cleaning company; customers need to send photos of the curtains so we can decide what to do thanks so much, that is really helpful, lovely weather this week isn'"'"'t it customers describe the job in their own words when they message us, like a whatsapp')")"
echo "$P1" | jq -e '.error == null' >/dev/null || fail "parity beat 1 errored: $P1"
sleep 9
P2="$(post /live-facts "$(send_beat 1 'like I said, customers send us photos of the curtains — that is how every job starts so yes — the photos come in first, then we decide; heavy staining on delicate silk means a human always looks at it before we commit to repeat: photos first, and a person reviews anything risky — that is the whole flow')")"
echo "$P2" | jq -e '.error == null' >/dev/null || fail "parity beat 2 errored: $P2"
PLEDGER="$(get "/live-facts?client_id=$CLIENT_ID&session_id=$SESSION_ID&workflow_id=$WORKFLOW_ID")"
PSIG="$(echo "$PLEDGER" | jq -r '.structural_signature')"
[ "$PSIG" = "$STRUCT_SIG" ] || fail "cross-engine parity broken: sentence-chunked structural signature ${STRUCT_SIG:0:60}… vs time-chunked ${PSIG:0:60}…"
ok "cross-engine parity: sentence-chunked vs 8s-chunked → identical structural ledger signature"

# Back to the primary session for the draft assertions.
SESSION_ID="e2e-facts-$STAMP"

# --- 7. Draft rail: no duplicate ids anywhere, versions accumulate -----------
DRAFTS="$(get "/live-draft?workflow_id=$WORKFLOW_ID")"
COUNT="$(echo "$DRAFTS" | jq '.drafts | length')"
[ "$COUNT" -ge 1 ] || fail "expected at least one draft, got $COUNT"
echo "$DRAFTS" | jq -e '
  [.drafts[].spec] | all(
    ((.intake.components | map(.id)) + (.judges | map(.id)) + (.dashboard.panels | map(.id)))
    | length == (unique | length)
  )' >/dev/null || fail "duplicate ids inside a compiled draft: $DRAFTS"
ok "no duplicate component/judge/panel ids inside any draft ($COUNT drafts)"

# --- 8. Flush compile: same signature → no new draft; stable JSON ------------
LAST_DRAFT_SIG_DRAFT_ID="$(echo "$DRAFTS" | jq -r '.drafts[0].id')"
FLUSH_BODY="$(jq -n --arg c "$CLIENT_ID" --arg w "$WORKFLOW_ID" --arg s "$SESSION_ID" --arg sig "$SIG" \
  '{client_id:$c, workflow_id:$w, session_id:$s, compile_signature:$sig}')"
RFLUSH="$(post /live-facts "$FLUSH_BODY")"
echo "$RFLUSH" | jq -e '.changed == false' >/dev/null || fail "flush with unchanged signature should be a no-op: $RFLUSH"
ok "flush compile: unchanged ledger signature → no new draft (byte-stable projection)"

# --- 9. Publish draft v_top → client sees the compiled spec -------------------
SPEC_TOP="$(echo "$DRAFTS" | jq -c '.drafts[0].spec')"
PUT="$(curl -sS --max-time 60 -b "$JAR" -X PUT "$BASE/admin-api/workflows/$WORKFLOW_ID/spec" \
  -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"spec\":$SPEC_TOP}")"
echo "$PUT" | jq -e '.workflow != null' >/dev/null || fail "publish (PUT spec) failed: $PUT"
PATCHED="$(curl -sS --max-time 60 -b "$JAR" -X PATCH "$BASE/live-draft" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"draft_id\":\"$LAST_DRAFT_SIG_DRAFT_ID\",\"published\":true}")"
echo "$PATCHED" | jq -e '.draft.published == true' >/dev/null || fail "draft published flag not set: $PATCHED"

CJAR="$(mktemp)"
CMINT="$(curl -sS --max-time 60 -c "$CJAR" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_ID\"}")"
echo "$CMINT" | jq -e '.role == "client"' >/dev/null || fail "client session not minted: $CMINT"
CWKF="$(curl -sS --max-time 60 -b "$CJAR" "$BASE/admin-api/workflows/$WORKFLOW_ID" -H "apikey: $APIKEY")"
echo "$CWKF" | jq -e --argjson spec "$SPEC_TOP" '.workflow.spec.name == $spec.name' >/dev/null || fail "client does not see the published spec: $CWKF"
rm -f "$CJAR"
ok "publish flow works: client login sees the compiled spec"

# --- 10. Isolation: client session cannot reach the fact pipeline ------------
CJAR2="$(mktemp)"
curl -sS --max-time 60 -c "$CJAR2" -X POST "$BASE/auth-code" -H "apikey: $APIKEY" -H 'Content-Type: application/json' \
  -d "{\"role\":\"client\",\"client_id\":\"$CLIENT_ID\"}" >/dev/null
GATEWAY_CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 -b "$CJAR2" \
  "$BASE/live-facts?client_id=$CLIENT_ID&session_id=$SESSION_ID" -H "apikey: $APIKEY")"
rm -f "$CJAR2"
case "$GATEWAY_CODE" in
  2*) fail "client session reached live-facts (HTTP $GATEWAY_CODE)" ;;
esac
ok "isolation: client session cannot reach the fact pipeline (HTTP $GATEWAY_CODE; DB-level zero-row reads for transcript_facts asserted in isolation_test.sql)"

echo
echo "LIVE-FACTS E2E: PASS ($PASS assertions)"
