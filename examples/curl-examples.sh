#!/usr/bin/env bash
# curl-examples.sh — every Temp Mail API endpoint, in curl.
#
# API:  https://temp-mail.turjaun.workers.dev   Domain: turjaun.xyz
# Auth: Authorization: Bearer <token>  (one token per inbox, from creation)
#
# Usage:
#   bash examples/curl-examples.sh
#
# The script walks the endpoints in the order an automation uses them:
# health -> config -> create inbox -> list -> wait -> read -> delete.
# Sections 6-8 only act when mail has actually arrived.
#
# Secrets rule (mandatory): the inbox token is NEVER echoed in full —
# not here, not in your own scripts, not in logs. The only place it
# appears in this file is inside Authorization headers sent to the API.

set -euo pipefail

BASE="https://temp-mail.turjaun.workers.dev"
DOMAIN="turjaun.xyz"

# Small helper: pull one field out of a JSON document on stdin.
# (python3 is used instead of jq so the example has no extra deps.)
json_field() {
  python3 -c 'import sys, json; d = json.load(sys.stdin); print(d.get(sys.argv[1], ""))' "$1"
}

# ===========================================================================
# 1. GET /api/health — liveness check (no auth)
#    Call at most once at the start of a run. Do not health-check in a loop.
# ===========================================================================
echo "== 1. Health =="
curl -s "$BASE/api/health"
echo

# ===========================================================================
# 2. GET /api/config — domains + inbox TTL (no auth)
#    Confirm the domain here instead of hard-coding a different one.
# ===========================================================================
echo "== 2. Config =="
curl -s "$BASE/api/config"
echo

# ===========================================================================
# 3. POST /api/new_address — create an inbox (no auth)
#    Returns {"address": "...", "token": "...", "jwt": "...", ...}.
#    Save BOTH address and token immediately; the token is per-inbox.
# ===========================================================================
echo "== 3. Create inbox (random address) =="
RESP=$(curl -s -X POST "$BASE/api/new_address" \
  -H "Content-Type: application/json" \
  -d "{\"domain\":\"$DOMAIN\"}")

ADDRESS=$(printf '%s' "$RESP" | json_field address)
TOKEN=$(printf '%s' "$RESP" | json_field token)
echo "Address: $ADDRESS"
# Token is stored in $TOKEN for the calls below — never printed in full.
echo "Token:   saved (not shown)"

# --- 3b. Create an inbox with a chosen name (alternative to section 3) -----
# Creating a name that already exists returns the same inbox and token
# with "reused":true — treat that as success.
#
#   curl -s -X POST "$BASE/api/new_address" \
#     -H "Content-Type: application/json" \
#     -d "{\"name\":\"signup-test-01\",\"domain\":\"$DOMAIN\"}"
#   # {"address":"signup-test-01@turjaun.xyz","token":"...","jwt":"..."}
#
# `name` may contain letters, digits, '.', '_' and '-' (lower-cased and
# sanitised server-side). An invalid domain returns:
#   400 {"error":"Invalid domain","allowed":["turjaun.xyz"]}

# ===========================================================================
# 4. GET /api/mails — list mail for the authenticated inbox (auth required)
#    Summaries only (id, sender, subject, preview, created_at), newest
#    first. `limit` defaults to 20, maximum 50; `offset` defaults to 0.
#    A 200 with "count":0 just means no mail yet — it is not an error.
# ===========================================================================
echo "== 4. List mails for this inbox =="
curl -s "$BASE/api/mails?limit=20&offset=0" \
  -H "Authorization: Bearer $TOKEN"
echo

# ===========================================================================
# 5. GET /api/inboxes/:address/messages — full messages for an address
#    (send the Bearer header too, per AGENTS.md)
#    Full records: id, sender, subject, text_body, html_body, created_at,
#    and `otp` when the server extracted a code. Use this after /api/wait
#    tells you mail has arrived; read the `otp` field before regex-ing
#    the body yourself.
# ===========================================================================
echo "== 5. Full messages for $ADDRESS =="
MSGS=$(curl -s "$BASE/api/inboxes/$ADDRESS/messages?limit=20" \
  -H "Authorization: Bearer $TOKEN")
printf '%s\n' "$MSGS"

COUNT=$(printf '%s' "$MSGS" | json_field count)
COUNT="${COUNT:-0}"

# ===========================================================================
# 6. GET /api/wait — long-poll for new mail (auth required)
#    THE way to wait. The server holds this one request open until new
#    mail arrives or its own wait expires, then returns what arrived
#    (or an empty/timeout result). Rules, all mandatory:
#      - One request per wait cycle; never two waits in parallel.
#      - Never substitute a timer loop over GET /api/mails for this.
#      - An empty cycle just means "start the next cycle"; for a normal
#        signup OTP, give up after ~3-5 cycles and report no mail.
#    This section is opt-in so the example does not block by default:
#    run it with  RUN_WAIT=1 bash examples/curl-examples.sh
# ===========================================================================
if [ "${RUN_WAIT:-0}" = "1" ]; then
  echo "== 6. Wait for new mail (one long-poll cycle — this blocks) =="
  curl -s "$BASE/api/wait" \
    -H "Authorization: Bearer $TOKEN"
  echo
  # Refresh the full-message list after the wait, as in section 5:
  MSGS=$(curl -s "$BASE/api/inboxes/$ADDRESS/messages?limit=20" \
    -H "Authorization: Bearer $TOKEN")
  COUNT=$(printf '%s' "$MSGS" | json_field count)
  COUNT="${COUNT:-0}"
  echo "Messages now in inbox: $COUNT"
else
  echo "== 6. Wait (skipped — set RUN_WAIT=1 to run one long-poll cycle) =="
fi

# ===========================================================================
# 7. GET /api/mail/:id — fetch one full message (send the Bearer header)
#    Includes the server-extracted `otp`. Use text_body first, then
#    html_body, when you need a verification link instead of a code.
#    A wrong/expired id returns 404 {"error":"Not found"} — do not retry
#    the same id; re-list (sections 4/5) and pick a current one.
# ===========================================================================
MAIL_ID=""
if [ "$COUNT" -gt 0 ]; then
  MAIL_ID=$(printf '%s' "$MSGS" | python3 -c 'import sys, json; print(json.load(sys.stdin)["results"][0]["id"])')
  echo "== 7. Fetch newest message (id $MAIL_ID) =="
  curl -s "$BASE/api/mail/$MAIL_ID" \
    -H "Authorization: Bearer $TOKEN"
  echo
else
  echo "== 7. Fetch one message (skipped — inbox is empty) =="
  # Manual form, once you have an id from section 4 or 5:
  #   curl -s "$BASE/api/mail/1" -H "Authorization: Bearer $TOKEN"
fi

# ===========================================================================
# 8. DELETE /api/mail/:id — delete one message from your inbox (auth req.)
#    Permanent. Delete only ids that belong to your inbox and that you
#    have already consumed (e.g. after entering the OTP). The inbox itself
#    needs no deletion — it expires on its 24-hour TTL.
#    Opt-in like section 6:  RUN_DELETE=1 bash examples/curl-examples.sh
# ===========================================================================
if [ "${RUN_DELETE:-0}" = "1" ] && [ -n "$MAIL_ID" ]; then
  echo "== 8. Delete message $MAIL_ID =="
  curl -s -X DELETE "$BASE/api/mail/$MAIL_ID" \
    -H "Authorization: Bearer $TOKEN"
  echo
else
  echo "== 8. Delete (skipped — set RUN_DELETE=1 with mail present to run) =="
  # Manual form:
  #   curl -s -X DELETE "$BASE/api/mail/1" -H "Authorization: Bearer $TOKEN"
  #   # {"ok":true}
fi

# ===========================================================================
# Error reference (see AGENTS.md §5 for the full table)
#   400  Invalid domain / invalid name -> fix the request, retry once.
#   401  {"error":"Unauthorized"} -> stop; check the Bearer header, that
#        the token belongs to this inbox, and that it has not expired.
#        Never retry with random tokens.
#   404  Message/path not found -> re-list and pick a current id.
#   200 + count:0 -> not an error; go back to /api/wait for another cycle.
# ===========================================================================
echo "Done. Inbox $ADDRESS expires within 24h."
