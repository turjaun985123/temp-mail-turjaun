#!/usr/bin/env python3
"""python-client.py — stdlib-only mini client for the Temp Mail API.

Mirrors the API documented in AGENTS.md (and the Node SDK in
``packages/node-client``) using nothing outside the Python 3 standard
library — ``urllib`` for HTTP, ``json`` for payloads. No pip installs.

    Base URL : https://temp-mail.turjaun.workers.dev
    Domain   : turjaun.xyz
    Auth     : Authorization: Bearer <token>   (one token per inbox)
    TTL      : inboxes and their mail are deleted after 24 hours

Run it as a demo (creates an inbox, long-polls for an OTP for up to
120 seconds, prints the OTP):

    python3 examples/python-client.py [inbox-name]

Exit codes: 0 = OTP received, 1 = no OTP within the timeout,
2 = the API could not be used (details on stderr).

The inbox token is never printed. The OTP is printed because that is
the point of the demo — treat the output as a secret.
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://temp-mail.turjaun.workers.dev"
DEFAULT_DOMAIN = "turjaun.xyz"

# Same fallback rule the server / Node client use: a standalone
# 4-8 digit run. The server-provided ``otp`` field is always preferred.
_OTP_RE = re.compile(r"\b(\d{4,8})\b")
_OTP_KEYWORD_RE = re.compile(
    r"(?:code|otp|verification|verify|pin|passcode)[^0-9]{0,24}(\d{4,8})\b",
    re.IGNORECASE,
)


def _to_mail_list(payload) -> list:
    """Normalise the API's list shapes into a plain list of mails."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("results", "mails"):
            if isinstance(payload.get(key), list):
                return payload[key]
        for key in ("mail", "result"):
            if isinstance(payload.get(key), dict):
                return [payload[key]]
    return []


def _extract_otp(text: str):
    """Best-effort OTP from free text (keyword-near code first)."""
    if not text:
        return None
    match = _OTP_KEYWORD_RE.search(text) or _OTP_RE.search(text)
    return match.group(1) if match else None


def _otp_from_mail(mail: dict):
    """OTP for one mail: server ``otp`` field first, local scan second."""
    if not isinstance(mail, dict):
        return None
    if mail.get("otp"):
        return str(mail["otp"])
    return _extract_otp(
        "\n".join(
            str(mail.get(field) or "")
            for field in ("subject", "text_body", "preview")
        )
    )


class TempMailClient:
    """Minimal Temp Mail API client (stdlib only).

    >>> client = TempMailClient()
    >>> inbox = client.create_inbox()          # {'address': ..., 'token': ...}
    >>> otp = client.wait_for_otp(inbox["token"], timeout=120)
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, request_timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.request_timeout = request_timeout

    # -- transport ---------------------------------------------------------

    def _request(self, path, method="GET", token=None, body=None, timeout=None):
        """One JSON request. Returns parsed JSON (None for 204/empty).

        Raises RuntimeError on any non-2xx response, carrying the HTTP
        status and the server's ``error`` field when it sent one.
        """
        url = self.base_url + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(
                req, timeout=timeout if timeout is not None else self.request_timeout
            ) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            detail = raw
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and parsed.get("error"):
                    detail = str(parsed["error"])
            except json.JSONDecodeError:
                pass
            raise RuntimeError(f"TempMail API {method} {path} failed: {exc.code} {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"TempMail API {method} {path} failed: {exc.reason}") from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw

    # -- public endpoints ----------------------------------------------------

    def health(self):
        """GET /api/health -> {'ok': True, 'service': ..., ...}"""
        return self._request("/api/health")

    def config(self):
        """GET /api/config -> {'domains': [...], 'ttl_hours': 24}"""
        return self._request("/api/config")

    def create_inbox(self, name=None, domain=None):
        """POST /api/new_address — create (or re-claim) an inbox.

        ``name`` is the local part (omit for a random address); ``domain``
        defaults to the server's first configured domain. Returns the
        full response dict with ``address`` and ``token`` normalised so
        ``token`` is set even if the server only sent ``jwt``.
        """
        payload = {}
        if name:
            payload["name"] = str(name)
        if domain:
            payload["domain"] = str(domain)
        data = self._request("/api/new_address", method="POST", body=payload)
        if not isinstance(data, dict) or not data.get("address"):
            raise RuntimeError("TempMail API: create_inbox returned no address")
        data = dict(data)
        data["token"] = data.get("token") or data.get("jwt")
        data["jwt"] = data.get("jwt") or data.get("token")
        return data

    def list_mails(self, token, limit=20, offset=0):
        """GET /api/mails — mail summaries for the token's inbox.

        Returns a list of mail dicts, newest first (each with ``id``,
        ``sender``, ``subject``, ``preview``, ``created_at``).
        """
        if not token:
            raise ValueError("list_mails: token is required")
        query = urllib.parse.urlencode({"limit": limit, "offset": offset})
        data = self._request(f"/api/mails?{query}", token=token)
        return _to_mail_list(data)

    def list_messages(self, address, token=None, limit=20):
        """GET /api/inboxes/:address/messages — full messages for an address.

        Full records include ``text_body``/``html_body`` and the
        server-extracted ``otp`` when present. Send the token when you
        have it (AGENTS.md: send the header on message calls anyway).
        """
        if not address or "@" not in address:
            raise ValueError("list_messages: a full address is required")
        query = urllib.parse.urlencode({"limit": limit})
        path = f"/api/inboxes/{urllib.parse.quote(address, safe='')}/messages?{query}"
        return _to_mail_list(self._request(path, token=token))

    def get_mail(self, mail_id, token=None):
        """GET /api/mail/:id — one full message, including ``otp``."""
        path = f"/api/mail/{urllib.parse.quote(str(mail_id), safe='')}"
        return self._request(path, token=token)

    def delete_mail(self, token, mail_id):
        """DELETE /api/mail/:id — permanently delete one of your mails."""
        if not token:
            raise ValueError("delete_mail: token is required")
        path = f"/api/mail/{urllib.parse.quote(str(mail_id), safe='')}"
        return self._request(path, method="DELETE", token=token)

    def wait(self, token, timeout=None):
        """GET /api/wait — ONE long-poll cycle.

        The server holds the request open until new mail arrives or its
        own wait expires, then returns what arrived (possibly nothing).
        One call is one cycle — never run two for the same inbox in
        parallel, and never replace this with a fast polling loop.
        Returns a list of mail dicts (possibly empty).
        """
        if not token:
            raise ValueError("wait: token is required (/api/wait needs the inbox token)")
        data = self._request("/api/wait", token=token, timeout=timeout)
        return _to_mail_list(data)

    # -- waiting for an OTP --------------------------------------------------

    def wait_for_otp(self, token, timeout=120, since_id=0):
        """Wait until a mail carrying an OTP arrives; return the OTP.

        Strategy, per AGENTS.md: one ``GET /api/wait`` long-poll per
        cycle. Each cycle's result is checked for an OTP; code-less
        mails (welcome messages, receipts) are skipped by advancing
        ``since_id`` past them instead of ending the wait. If
        ``/api/wait`` is unavailable on the deployment (404/501/network
        error — e.g. a v1 Worker), it falls back to listing the inbox
        once per cycle for the remaining time.

        ``timeout`` is the overall deadline in seconds (default 120).
        Returns the OTP string, or None when the deadline passes.
        """
        deadline = time.monotonic() + timeout
        use_long_poll = True

        def newest_new(mails):
            fresh = [
                m for m in mails
                if not isinstance(m.get("id"), int) or m["id"] > since_id
            ]
            return fresh[0] if fresh else None

        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            mails = []

            if use_long_poll:
                try:
                    # Grace margin so a server-held request is not cut
                    # off just before it would have returned.
                    mails = self.wait(token, timeout=remaining + 5)
                except RuntimeError:
                    # No /api/wait on this deployment (or a transport
                    # failure): fall back to one list per cycle.
                    use_long_poll = False
                    if time.monotonic() >= deadline:
                        return None
                except TimeoutError:
                    if time.monotonic() >= deadline:
                        return None

            if not use_long_poll:
                try:
                    mails = self.list_mails(token, limit=20)
                except RuntimeError:
                    mails = []
                if not mails:
                    # One list per cycle, spaced out — never a fast loop.
                    time.sleep(min(5.0, max(0.0, deadline - time.monotonic())))
                    continue

            mail = newest_new(mails)
            if mail is None:
                # Empty long-poll cycle = server-side wait expired;
                # loop straight into the next cycle (the server held
                # the request, so this is not busy polling).
                continue

            otp = _otp_from_mail(mail)
            if not otp and mail.get("id") is not None:
                # List payloads can be truncated; the detail route
                # carries the full body and the server-extracted otp.
                try:
                    full = self.get_mail(mail["id"], token=token)
                    otp = _otp_from_mail(full) if isinstance(full, dict) else None
                except RuntimeError:
                    otp = None
            if otp:
                return otp

            # Code-less mail: move past it and keep waiting.
            if isinstance(mail.get("id"), int) and mail["id"] > since_id:
                since_id = mail["id"]
            else:
                time.sleep(min(5.0, max(0.0, deadline - time.monotonic())))

        return None


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    client = TempMailClient()

    try:
        health = client.health()
        if not isinstance(health, dict) or health.get("ok") is not True:
            print("Temp Mail service is not up — stopping.", file=sys.stderr)
            return 2

        inbox = client.create_inbox(name=argv[0] if argv else None)
    except RuntimeError as exc:
        print(f"Temp Mail API error: {exc}", file=sys.stderr)
        return 2

    address, token = inbox["address"], inbox["token"]
    print(f"Inbox created: {address}")
    print()
    print("Next step: use this address in the signup form you are testing,")
    print("then submit the form so the service sends its verification mail.")
    print("Waiting up to 120s for an OTP (long-poll, do not interrupt)...")

    try:
        otp = client.wait_for_otp(token, timeout=120)
    except RuntimeError as exc:
        print(f"Temp Mail API error: {exc}", file=sys.stderr)
        return 2

    if not otp:
        print(f"No OTP arrived for {address} within 120s.", file=sys.stderr)
        print("Check the signup was submitted to the address above, then re-run.",
              file=sys.stderr)
        return 1

    print(f"OTP for {address}: {otp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
