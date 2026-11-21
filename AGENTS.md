# AGENTS.md — How an AI Agent Uses the Temp Mail API

You are an AI agent / automation that needs a disposable inbox for a signup,
a test, or a one-time password (OTP). Use this API. Follow this file exactly.

Do not guess endpoints. Do not invent parameters. Use only what is documented
below.

---

## 1. Facts — memorize these

| Item | Value |
|---|---|
| Base URL | `https://temp-mail.turjaun.workers.dev` |
| Domain | `turjaun.xyz` |
| Address format | `<name>@turjaun.xyz` |
| Auth | `Authorization: Bearer <token>` — one token per inbox |
| Inbox lifetime (TTL) | 24 hours. After that the address and its mail are deleted. |
| Content type | Send `Content-Type: application/json` on POSTs. Responses are JSON. |

Set these once at the start of your run:

```bash
BASE="https://temp-mail.turjaun.workers.dev"
DOMAIN="turjaun.xyz"
```

---

## 2. The workflow — do these steps in order

### Step 1 — Create an inbox

Call `POST /api/new_address`. Omit `name` for a random address, or supply a
`name` when the task needs a readable / repeatable one.

```bash
curl -s -X POST "$BASE/api/new_address" \
  -H "Content-Type: application/json" \
  -d "{\"domain\":\"$DOMAIN\"}"
```

Response:

```json
{ "address": "a1b2c3d4e5@turjaun.xyz", "token": "<token>", "jwt": "<token>", "expires_at": 0 }
```

### Step 2 — Save `address` and `token` immediately

Store both values in your task state before you do anything else.

- Lose the `token` and you lose authenticated access to that inbox.
- Never print the token in user-facing output, logs, commits, or chat.
- Never share one inbox's token with another task.

```bash
ADDRESS="a1b2c3d4e5@turjaun.xyz"   # from the response
TOKEN="<token from the response>"
```

### Step 3 — Give the address to the service

Enter `ADDRESS` as the email in the signup / test form. Submit the form so the
service sends its mail. Do not create a second inbox for the same signup —
reuse this one (see §6).

### Step 4 — Wait for mail with the long-poll endpoint. Do not spam polls.

Call `GET /api/wait` **once**. It holds the request open until new mail arrives
or the wait times out, then returns. That is the whole point of this endpoint:
one request replaces dozens of polls.

```bash
curl -s "$BASE/api/wait" \
  -H "Authorization: Bearer $TOKEN"
```

Rules for waiting:

- Make **at most 1 request per wait cycle**. When a `/api/wait` call returns,
  that cycle is over. Only then may you start the next cycle.
- Never loop `GET /api/mails` on a timer as a substitute for `/api/wait`.
- If `/api/wait` returns no new mail (timeout / empty result), wait one more
  cycle the same way. Give up after a small number of cycles appropriate to
  the task (for a normal signup OTP, 3–5 cycles), then report that no mail
  arrived — do not accelerate into rapid polling.
- Do not run two `/api/wait` calls for the same inbox in parallel.

### Step 5 — Read the OTP from the `otp` field

When mail arrives, read the message. Prefer the structured fields — do not
regex the whole body first if the field exists:

- OTP / verification code → the `otp` field on the message.
- If `otp` is null/absent, then and only then scan `subject`, then
  `text_body`, for a 4–8 digit code.

```bash
curl -s "$BASE/api/inboxes/$ADDRESS/messages" \
  -H "Authorization: Bearer $TOKEN"
```

Each message in `results` carries `id`, `sender`, `subject`, `text_body`,
`html_body`, `created_at`, and `otp`. Take the **newest** message from the
expected sender. Enter its `otp` into the service's verification field.

### Step 6 — Handle verification links the same way

If the service verifies by link instead of code:

1. Wait with `/api/wait` (Step 4).
2. Fetch the newest message (Step 5, or `GET /api/mail/<id>` for the full body).
3. Extract the verification URL from `text_body` first, then `html_body`.
   Pick the URL that belongs to the service you signed up for and that
   contains a verify / confirm / activate intent. Ignore unsubscribe,
   privacy-policy, and social links.
4. Open that exact URL once. Do not rewrite, shorten, or re-host it.
5. Treat the link as a secret: it usually contains a one-time token. Never
   print it in user-facing output or logs, and never reuse it after it has
   been consumed.

### Step 7 — Finish

- Confirm the signup / test outcome from the service, not from the inbox.
- Delete individual messages you no longer need with
  `DELETE /api/mail/<id>` (see §4).
- Let the inbox expire on its 24-hour TTL. Do not create replacement inboxes
  to extend a task past the TTL — start a fresh task instead.

---

## 3. Authentication rules

- Authenticate as the inbox: send `Authorization: Bearer <token>` where
  `<token>` is the token returned when **that** inbox was created.
- The token identifies exactly one address. A token from inbox A does not
  authorize inbox B.
- Endpoints that require auth: `GET /api/mails`, `GET /api/wait`,
  `DELETE /api/mail/<id>`. Send the header on all inbox/message calls anyway —
  it costs nothing and avoids ambiguous failures.
- No auth is required for: `GET /api/health`, `GET /api/config`,
  `POST /api/new_address`.
- There is no username, password, API key, or login flow. Do not ask the user
  for credentials for this API.
- On `401`, stop. Check that you sent the header, that the token matches the
  inbox, and that the inbox has not expired. Do not retry with random tokens
  and do not brute-force.

---

## 4. Endpoint table — every endpoint, with curl

Base URL for all examples: `https://temp-mail.turjaun.workers.dev`

| # | Method & path | Auth | Purpose |
|---|---|---|---|
| 1 | `GET /api/health` | No | Liveness check |
| 2 | `GET /api/config` | No | List domains + TTL |
| 3 | `POST /api/new_address` | No | Create an inbox, returns `address` + `token` |
| 4 | `GET /api/mails` | Yes | List mail for the authenticated inbox (paginated summaries) |
| 5 | `GET /api/inboxes/:address/messages` | Yes* | List full messages for a specific address |
| 6 | `GET /api/mail/:id` | Yes* | Fetch one full message, includes `otp` |
| 7 | `DELETE /api/mail/:id` | Yes | Delete one message from your inbox |
| 8 | `GET /api/wait` | Yes | Long-poll: block until new mail arrives or the wait times out |

\* Send the Bearer header on these calls too (see §3).

### 1 — Health

```bash
curl -s "$BASE/api/health"
# {"ok":true,"service":"temp-mail","domain":["turjaun.xyz"],"time":"..."}
```

Call this at most once at the start of a run if you need to confirm the
service is up. Do not health-check in a loop.

### 2 — Config

```bash
curl -s "$BASE/api/config"
# {"domains":["turjaun.xyz"],"ttl_hours":24}
```

Use it to confirm the domain before creating an inbox. Do not hard-code a
different domain than the one returned here.

### 3 — Create inbox

Random address:

```bash
curl -s -X POST "$BASE/api/new_address" \
  -H "Content-Type: application/json" \
  -d "{\"domain\":\"$DOMAIN\"}"
```

Chosen name:

```bash
curl -s -X POST "$BASE/api/new_address" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"signup-test-01\",\"domain\":\"$DOMAIN\"}"
# {"address":"signup-test-01@turjaun.xyz","token":"...","jwt":"...","expires_at":0}
```

Notes: `name` may contain letters, digits, `.`, `_`, `-` (it is lower-cased and
sanitized server-side). Creating an address that already exists returns that
address with its existing token and `"reused":true` — treat that as success,
not an error.

### 4 — List mail for your inbox

```bash
curl -s "$BASE/api/mails?limit=20&offset=0" \
  -H "Authorization: Bearer $TOKEN"
# {"address":"...@turjaun.xyz","count":1,"results":[{"id":1,"sender":"...","subject":"...","preview":"...","created_at":0}]}
```

`limit` defaults to 20, maximum 50. `offset` defaults to 0. Results are
newest first and are summaries (subject + preview). Use endpoint 6 for a full
body.

### 5 — List full messages for an address

```bash
curl -s "$BASE/api/inboxes/$ADDRESS/messages?limit=20" \
  -H "Authorization: Bearer $TOKEN"
# {"address":"...@turjaun.xyz","count":1,"results":[{"id":1,"sender":"...","subject":"...","text_body":"...","html_body":"...","created_at":0,"otp":"123456"}]}
```

Use this after `/api/wait` tells you mail has arrived.

### 6 — Fetch one message

```bash
curl -s "$BASE/api/mail/1" \
  -H "Authorization: Bearer $TOKEN"
# {"id":1,"address":"...","sender":"...","subject":"...","text_body":"...","html_body":"...","created_at":0,"otp":"123456"}
```

Read `otp` first (Step 5 of the workflow). Use `text_body` / `html_body` for
verification links.

### 7 — Delete one message

```bash
curl -s -X DELETE "$BASE/api/mail/1" \
  -H "Authorization: Bearer $TOKEN"
# {"ok":true}
```

Delete only message IDs that belong to your inbox and that you have already
consumed. Deletion is permanent.

### 8 — Wait for new mail (long-poll)

```bash
curl -s "$BASE/api/wait" \
  -H "Authorization: Bearer $TOKEN"
```

Behavior: the request stays open until new mail for your inbox arrives or the
server-side wait expires, then it returns a JSON result describing what
arrived (or an empty / timeout result if nothing did). One call = one wait
cycle. See the waiting rules in §2 Step 4 and §6 — they are mandatory.

---

## 5. Errors — what they mean and what you do

| Status | Meaning (as returned) | Your action |
|---|---|---|
| `400` | Invalid domain — e.g. `{"error":"Invalid domain","allowed":["turjaun.xyz"]}`. Also returned for an invalid/empty `name`. | Fix the request: set `domain` to `turjaun.xyz` (or omit it to use the default) and use a valid `name`. Then retry **once**. Do not cycle through other domains. |
| `401` | Unauthorized — missing, malformed, or wrong Bearer token, e.g. `{"error":"Unauthorized"}`. | Stop. Verify the `Authorization: Bearer <token>` header and that the token belongs to this inbox and has not expired (24 h TTL). Do not retry blindly, do not try other tokens. If the inbox is expired, create a new inbox and restart the signup. |
| `404` | Not found — the message ID (or path) does not exist, e.g. `{"error":"Not found"}`. | Do not retry the same ID. Re-list with `/api/mails` or `/api/inboxes/:address/messages` and pick a current ID. Check you did not typo the path. |
| `200` with empty `results` / `count: 0` | Not an error — the inbox simply has no mail yet. | Go back to `/api/wait` for another cycle (respecting §6). Do not treat empty as failure and do not switch to rapid polling. |

General error rules:

- Parse the JSON `error` field and act on it. Do not ignore error bodies.
- Never retry a failed request in a tight loop. One corrected retry for a
  `400`; for `401`/`404`, fix the cause first as described above.
- If health (`/api/health`) does not return `"ok":true`, report the service
  as unavailable and stop. Do not keep creating inboxes against a down service.

---

## 6. Rate and etiquette rules — mandatory

1. **Use `/api/wait`. Never poll faster than the wait endpoint's cycle.**
   One outstanding wait request per inbox, one request per cycle. No
   fixed-interval polling of `/api/mails`, no parallel waits, no
   sub-second or few-second retry loops anywhere in this API.
2. **Reuse the inbox.** One inbox per signup / task. Reuse it for resends:
   if the service offers "resend code", use it with the same inbox instead of
   creating a new address. Creating an existing name again returns the same
   inbox — prefer that over random duplicates.
3. **Create sparingly.** Do not pre-create pools of inboxes. Create one when
   the task starts, not before, and not "just in case".
4. **Respect the 24-hour TTL.** Addresses and mail are deleted after 24 hours.
   Finish the task inside that window. Do not design flows that need mail
   after 24 hours, and do not expect an expired inbox or message to be
   recoverable — it is not.
5. **Keep requests small.** Use the default `limit` (20) unless you truly
   need more; the maximum is 50. Fetch full bodies one message at a time.
6. **Protect secrets.** Tokens, OTPs, and verification links are secrets.
   Never commit them, paste them into public logs, or send them anywhere
   except the service that asked for them.
7. **Clean up what you consumed.** Delete messages you have used when the
   task is done. Leave no automation running against an inbox after the task
   ends — cancel any pending wait when you finish or abandon the task.
8. **Use this only for legitimate signups and testing** — your own accounts,
   your own services, QA, and flows you are authorized to automate. Do not use
   disposable inboxes to evade bans, spam controls, or abuse protections.

---

## 7. Complete worked example — get an OTP for a signup (bash)

Scenario: a service asks for an email, then sends a 6-digit code. This script
creates the inbox, waits correctly, and prints only whether a code was found.
Fill in the signup step where marked — everything around it is complete.

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="https://temp-mail.turjaun.workers.dev"
DOMAIN="turjaun.xyz"

# --- 0. (Optional, once) Confirm the service is up -------------------------
curl -s "$BASE/api/health" | grep -q '"ok":true' || {
  echo "Temp Mail service is not up — stop." >&2; exit 1; }

# --- 1. Create the inbox ---------------------------------------------------
RESP=$(curl -s -X POST "$BASE/api/new_address" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"signup-example\",\"domain\":\"$DOMAIN\"}")

ADDRESS=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["address"])')
TOKEN=$(printf '%s' "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
echo "Inbox created: $ADDRESS"   # never echo $TOKEN

# --- 2. Give ADDRESS to the service ---------------------------------------
# >>> YOUR SIGNUP STEP HERE <<<
# Enter "$ADDRESS" as the email in the service's signup form and submit it,
# so the service sends its verification mail. For example, with a form API:
# curl -s -X POST "https://service.example/signup" -d "email=$ADDRESS"
echo "Now submit the signup form for $ADDRESS, then press Enter."
read -r _

# --- 3. Wait for the mail — one long-poll request per cycle ----------------
for cycle in 1 2 3 4 5; do
  echo "Wait cycle $cycle ..."
  curl -s "$BASE/api/wait" -H "Authorization: Bearer $TOKEN" >/dev/null || true

  MSGS=$(curl -s "$BASE/api/inboxes/$ADDRESS/messages?limit=5" \
    -H "Authorization: Bearer $TOKEN")
  COUNT=$(printf '%s' "$MSGS" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("count",0))')
  [ "$COUNT" -gt 0 ] && break
done

[ "${COUNT:-0}" -gt 0 ] || { echo "No mail arrived after 5 wait cycles — report and stop." >&2; exit 1; }

# --- 4. Read the OTP from the otp field of the newest message --------------
OTP=$(printf '%s' "$MSGS" | python3 -c '
import sys, json
results = json.load(sys.stdin).get("results", [])
print(results[0].get("otp") or "")')

if [ -z "$OTP" ]; then
  echo "Mail arrived but no otp field — inspect the message body manually:" >&2
  printf '%s\n' "$MSGS" | python3 -m json.tool | head -40
  exit 1
fi

echo "OTP received (entering it into the service next)."
# >>> YOUR VERIFY STEP HERE <<<
# Enter "$OTP" into the service's verification field. Do not print $OTP.

# --- 5. Clean up: delete the consumed message ------------------------------
MSG_ID=$(printf '%s' "$MSGS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["results"][0]["id"])')
curl -s -X DELETE "$BASE/api/mail/$MSG_ID" \
  -H "Authorization: Bearer $TOKEN" >/dev/null
echo "Done. Message $MSG_ID deleted; inbox $ADDRESS expires within 24h."
```

Expected flow: health OK → inbox created → signup submitted → mail arrives
during a wait cycle → `otp` read from the message → code entered → message
deleted. If any step fails, apply the error table in §5 instead of improvising.

---

## 8. Quick reference

```text
Create   POST   /api/new_address                 {name?, domain:"turjaun.xyz"} -> {address, token}
Wait     GET    /api/wait                        Bearer <token>   (1 request per cycle, never poll)
List     GET    /api/mails?limit=20&offset=0     Bearer <token>
Messages GET    /api/inboxes/<address>/messages  Bearer <token>
Read     GET    /api/mail/<id>                   Bearer <token>   -> use .otp, .text_body, .html_body
Delete   DELETE /api/mail/<id>                   Bearer <token>
Info     GET    /api/health                      -> {"ok":true,...}
         GET    /api/config                      -> {"domains":["turjaun.xyz"],"ttl_hours":24}
```

Base URL: `https://temp-mail.turjaun.workers.dev` · Domain: `turjaun.xyz` ·
TTL: 24 hours · Auth: per-inbox Bearer token.
