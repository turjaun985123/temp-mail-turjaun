#!/usr/bin/env python3
"""Deploy Temp Mail v2 Worker via the Cloudflare API (no wrangler needed).

Method (proven by the v1 deploy): a single multipart PUT to
    /accounts/{account_id}/workers/scripts/temp-mail
with a ``metadata`` JSON part (main_module, compatibility_date, bindings)
and the Worker source as the main module part, followed by a PUT to the
script's ``/schedules`` endpoint for the cron trigger. Afterwards the
public health endpoint is polled to verify the new code is live.

Security:
    * The API token is read ONLY from the ``CLOUDFLARE_API_TOKEN``
      environment variable. It is never hardcoded, never taken from a
      command-line argument, and never printed (not even partially).
    * If the token is missing (and this is not ``--dry-run``), the script
      exits with a clear error before doing any network work.

Usage:
    CLOUDFLARE_API_TOKEN=... python3 scripts/deploy-api.py
    python3 scripts/deploy-api.py --dry-run   # sizes only, no network, no token needed

Optional environment:
    CLOUDFLARE_ACCOUNT_ID   Cloudflare account id
                            (default: 079c053e14d1aa42628ca4b62f2b492a)

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

# --------------------------------------------------------------------------
# Constants (non-secret configuration for this project)
# --------------------------------------------------------------------------

DEFAULT_ACCOUNT_ID = "079c053e14d1aa42628ca4b62f2b492a"
SCRIPT_NAME = "temp-mail"
D1_DATABASE_ID = "324a85a1-e2a8-417e-883b-4b23e060fbce"
DOMAINS = "turjaun.xyz"
MAIL_TTL_HOURS = "24"
COMPATIBILITY_DATE = "2024-12-01"
CRON_SCHEDULE = "0 * * * *"
HEALTH_URL = "https://temp-mail.turjaun.workers.dev/api/health"
EXPECTED_VERSION = 2
HEALTH_ATTEMPTS = 10
HEALTH_INTERVAL_SECONDS = 3
API_BASE = "https://api.cloudflare.com/client/v4"

# src/worker-final.js relative to the repository root (parent of scripts/).
REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_PATH = REPO_ROOT / "src" / "worker-final.js"


def build_metadata() -> dict:
    """Metadata part for the multipart Worker upload."""
    return {
        "main_module": "worker.js",
        "compatibility_date": COMPATIBILITY_DATE,
        "bindings": [
            {"type": "d1", "name": "DB", "id": D1_DATABASE_ID},
            {"type": "plain_text", "name": "DOMAINS", "text": DOMAINS},
            {"type": "plain_text", "name": "MAIL_TTL_HOURS", "text": MAIL_TTL_HOURS},
        ],
    }


def build_multipart(metadata: dict, worker_code: str) -> tuple[bytes, str]:
    """Build a multipart/form-data body. Returns (body, boundary)."""
    boundary = "----TempMailDeploy" + uuid.uuid4().hex
    body = b""

    def add_part(name: str, content, filename: str | None = None,
                 content_type: str | None = None) -> None:
        nonlocal body
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        body += f"--{boundary}\r\n{disposition}\r\n".encode("utf-8")
        if content_type:
            body += f"Content-Type: {content_type}\r\n".encode("utf-8")
        body += b"\r\n"
        body += content if isinstance(content, bytes) else content.encode("utf-8")
        body += b"\r\n"

    add_part("metadata", json.dumps(metadata), content_type="application/json")
    add_part(
        "worker.js",
        worker_code,
        filename="worker.js",
        content_type="application/javascript+module",
    )
    body += f"--{boundary}--\r\n".encode("utf-8")
    return body, boundary


def api_request(token: str, method: str, path: str, data: bytes,
                content_type: str) -> tuple[int, str]:
    """One Cloudflare API request. Returns (status, response_text).

    The token is used only in the Authorization header and is never
    included in any output.
    """
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": content_type,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")


def result_summary(text: str) -> str:
    """Short, safe summary of an API response (no secrets live in it)."""
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return text[:500]
    if isinstance(parsed, dict):
        result = parsed.get("result")
        if isinstance(result, dict):
            keys = ("id", "deployment_id", "handlers", "modified_on", "schedules")
            picked = {k: result[k] for k in keys if k in result}
            return json.dumps(picked)[:1000]
        return json.dumps({"success": parsed.get("success"),
                           "errors": parsed.get("errors")})[:1000]
    return text[:500]


def poll_health() -> bool:
    """Poll HEALTH_URL up to HEALTH_ATTEMPTS times.

    PASS only when the JSON body has ``ok: true`` and the expected
    ``version`` (v2). Returns True on PASS, False otherwise.
    """
    print(f"Polling health: {HEALTH_URL} (up to {HEALTH_ATTEMPTS} attempts)")
    for attempt in range(1, HEALTH_ATTEMPTS + 1):
        try:
            req = urllib.request.Request(
                HEALTH_URL, headers={"Cache-Control": "no-cache"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
            ok = data.get("ok") is True
            version = data.get("version")
            print(f"  attempt {attempt}/{HEALTH_ATTEMPTS}: ok={ok} version={version!r}")
            if ok and version == EXPECTED_VERSION:
                print(f"PASS: health ok:true and version={version}")
                return True
        except Exception as exc:  # network error, non-JSON (e.g. old code), etc.
            print(f"  attempt {attempt}/{HEALTH_ATTEMPTS}: not ready ({exc})")
        if attempt < HEALTH_ATTEMPTS:
            time.sleep(HEALTH_INTERVAL_SECONDS)
    print(f"FAIL: health did not return ok:true with version={EXPECTED_VERSION} "
          f"after {HEALTH_ATTEMPTS} attempts")
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deploy Temp Mail v2 Worker via the Cloudflare API."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print payload sizes and metadata only; send nothing "
             "(no API token required).",
    )
    args = parser.parse_args(argv)

    # --- Load worker source -------------------------------------------------
    if not WORKER_PATH.is_file():
        print(f"ERROR: worker source not found: {WORKER_PATH}", file=sys.stderr)
        return 2
    worker_code = WORKER_PATH.read_text(encoding="utf-8")

    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or DEFAULT_ACCOUNT_ID
    metadata = build_metadata()
    body, boundary = build_multipart(metadata, worker_code)
    schedule_payload = json.dumps([{"cron": CRON_SCHEDULE}]).encode("utf-8")

    # --- Dry run: report sizes, send nothing --------------------------------
    if args.dry_run:
        print("DRY RUN - nothing will be sent")
        print(f"  worker source : {WORKER_PATH} ({len(worker_code.encode('utf-8'))} bytes)")
        print(f"  metadata JSON : {len(json.dumps(metadata).encode('utf-8'))} bytes")
        print(f"  multipart body: {len(body)} bytes (boundary {len(boundary)} chars)")
        print(f"  schedule body : {len(schedule_payload)} bytes -> [{CRON_SCHEDULE}]")
        print(f"  account id    : {account_id}")
        print(f"  script name   : {SCRIPT_NAME}")
        print(f"  upload target : PUT {API_BASE}/accounts/{account_id}/workers/scripts/{SCRIPT_NAME}")
        print(f"  schedule target: PUT {API_BASE}/accounts/{account_id}/workers/scripts/{SCRIPT_NAME}/schedules")
        print(f"  health check  : GET {HEALTH_URL} (expect ok:true, version={EXPECTED_VERSION})")
        print("DRY RUN OK")
        return 0

    # --- Token: env only, never hardcoded / printed --------------------------
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print(
            "ERROR: CLOUDFLARE_API_TOKEN is not set.\n"
            "Set it in your environment (never commit it), e.g.:\n"
            "  export CLOUDFLARE_API_TOKEN=...   # token with Workers Scripts Edit,\n"
            "                                     # D1 Edit and Email Routing permissions\n"
            "Then re-run. Or use --dry-run to preview payload sizes without a token.",
            file=sys.stderr,
        )
        return 2

    # --- 1. Upload the Worker ------------------------------------------------
    print(f"Deploying {SCRIPT_NAME} to account {account_id} ...")
    status, text = api_request(
        token,
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{SCRIPT_NAME}",
        body,
        f"multipart/form-data; boundary={boundary}",
    )
    print(f"Upload: HTTP {status} {result_summary(text)}")
    if status != 200:
        print("FAIL: Worker upload did not return HTTP 200", file=sys.stderr)
        return 1

    # --- 2. Set the cron schedule -------------------------------------------
    status, text = api_request(
        token,
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{SCRIPT_NAME}/schedules",
        schedule_payload,
        "application/json",
    )
    print(f"Schedule ({CRON_SCHEDULE}): HTTP {status} {result_summary(text)}")
    if status != 200:
        print("FAIL: schedule update did not return HTTP 200", file=sys.stderr)
        return 1

    # --- 3. Verify live ------------------------------------------------------
    return 0 if poll_health() else 1


if __name__ == "__main__":
    sys.exit(main())
