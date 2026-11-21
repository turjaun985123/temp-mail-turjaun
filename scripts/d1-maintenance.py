#!/usr/bin/env python3
"""D1 maintenance for Temp Mail v2: stats, export, and TTL cleanup.

Talks to the production D1 database only through the Cloudflare D1
query API:

    POST /accounts/{account_id}/d1/database/{database_id}/query
    body: {"sql": "...", "params": [...]}

Subcommands:
    stats            Row counts for ``addresses`` / ``mails`` plus the
                     oldest and newest mail rows. Read-only.
    export           Dump all ``addresses`` and ``mails`` rows to a
                     timestamped JSON file in ``backups/``. Read-only
                     against D1; writes one local file. NOTE: the dump
                     contains per-inbox tokens -- treat the file as a
                     secret and never commit it.
    cleanup-preview  Count mails older than the TTL (default 24h).
                     Read-only: issues a SELECT, never a DELETE.
    cleanup          DELETE mails older than the TTL (default 24h).
                     Refuses to run without the explicit ``--yes`` flag.

Security:
    * The API token is read ONLY from the ``CLOUDFLARE_API_TOKEN``
      environment variable. It is never hardcoded, never taken from a
      command-line argument, and never printed (not even partially).
    * If the token is missing, the script exits with a clear error
      before doing any network work.

Optional environment:
    CLOUDFLARE_ACCOUNT_ID   Cloudflare account id
                            (default: 079c053e14d1aa42628ca4b62f2b492a)

Usage:
    CLOUDFLARE_API_TOKEN=... python3 scripts/d1-maintenance.py stats
    CLOUDFLARE_API_TOKEN=... python3 scripts/d1-maintenance.py export
    CLOUDFLARE_API_TOKEN=... python3 scripts/d1-maintenance.py cleanup-preview
    CLOUDFLARE_API_TOKEN=... python3 scripts/d1-maintenance.py cleanup --yes

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
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# Constants (non-secret configuration for this project)
# --------------------------------------------------------------------------

DEFAULT_ACCOUNT_ID = "079c053e14d1aa42628ca4b62f2b492a"
D1_DATABASE_ID = "324a85a1-e2a8-417e-883b-4b23e060fbce"
API_BASE = "https://api.cloudflare.com/client/v4"
DEFAULT_TTL_HOURS = 24

# backups/ at the repository root (parent of scripts/).
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BACKUP_DIR = REPO_ROOT / "backups"


# --------------------------------------------------------------------------
# D1 query API
# --------------------------------------------------------------------------

class D1Error(RuntimeError):
    """A D1 query failed (transport, HTTP, or API-level error)."""


def d1_query(token: str, account_id: str, sql: str,
             params: list | None = None) -> tuple[list[dict], dict]:
    """Run one SQL statement via the D1 query API.

    Returns ``(rows, meta)`` where ``rows`` is the result list (empty
    for statements that return no rows, e.g. DELETE) and ``meta`` is
    the D1 result metadata (which carries e.g. ``changes`` for DELETE).

    The token is used only in the Authorization header and is never
    included in any exception message or output.
    """
    payload: dict = {"sql": sql}
    if params is not None:
        payload["params"] = params
    req = urllib.request.Request(
        f"{API_BASE}/accounts/{account_id}/d1/database/{D1_DATABASE_ID}/query",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise D1Error(f"D1 query failed: HTTP {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise D1Error(f"D1 query failed: network error: {exc.reason}") from None

    try:
        parsed = json.loads(raw)
    except ValueError:
        raise D1Error(f"D1 query failed: non-JSON response: {raw[:500]}") from None

    if not parsed.get("success"):
        errors = parsed.get("errors") or []
        detail = "; ".join(
            str(e.get("message", e)) if isinstance(e, dict) else str(e)
            for e in errors
        ) or raw[:500]
        raise D1Error(f"D1 query failed: {detail}")

    result = parsed.get("result") or []
    if not result or not isinstance(result[0], dict):
        return [], {}
    first = result[0]
    if not first.get("success", True):
        raise D1Error(f"D1 query failed: statement reported failure: {first}")
    return first.get("results") or [], first.get("meta") or {}


def require_token() -> str:
    """Return the API token from the environment, or exit clearly."""
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        print(
            "ERROR: CLOUDFLARE_API_TOKEN is not set.\n"
            "Set it in your environment (never commit it), e.g.:\n"
            "  export CLOUDFLARE_API_TOKEN=...   # token with D1 Edit permission\n"
            "Then re-run.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return token


def account_id() -> str:
    return os.environ.get("CLOUDFLARE_ACCOUNT_ID") or DEFAULT_ACCOUNT_ID


def format_ts(value) -> str:
    """Format a unixepoch-seconds value as ISO-8601 UTC, for display."""
    if value is None:
        return "-"
    try:
        ts = int(value)
    except (TypeError, ValueError):
        return str(value)
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def scalar_count(rows: list[dict]) -> int:
    if rows and isinstance(rows[0], dict):
        for key in ("count", "COUNT(*)", "n"):
            if key in rows[0]:
                return int(rows[0][key])
    return 0


def cutoff_for(hours: int) -> int:
    return int(time.time()) - hours * 3600


# --------------------------------------------------------------------------
# Subcommands
# --------------------------------------------------------------------------

def cmd_stats(token: str, acct: str, _args: argparse.Namespace) -> int:
    addr_rows, _ = d1_query(token, acct, "SELECT COUNT(*) AS count FROM addresses")
    mail_rows, _ = d1_query(token, acct, "SELECT COUNT(*) AS count FROM mails")
    oldest, _ = d1_query(
        token, acct,
        "SELECT id, address, sender, subject, created_at FROM mails "
        "ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    newest, _ = d1_query(
        token, acct,
        "SELECT id, address, sender, subject, created_at FROM mails "
        "ORDER BY created_at DESC, id DESC LIMIT 1",
    )

    print(f"Database : {D1_DATABASE_ID}")
    print(f"Addresses: {scalar_count(addr_rows)}")
    print(f"Mails    : {scalar_count(mail_rows)}")
    for label, rows in (("Oldest mail", oldest), ("Newest mail", newest)):
        if rows:
            row = rows[0]
            print(f"{label}: id={row.get('id')} "
                  f"created_at={row.get('created_at')} ({format_ts(row.get('created_at'))}) "
                  f"address={row.get('address')} subject={row.get('subject')!r}")
        else:
            print(f"{label}: none (mails table is empty)")
    return 0


def cmd_export(token: str, acct: str, args: argparse.Namespace) -> int:
    addresses, _ = d1_query(token, acct, "SELECT * FROM addresses ORDER BY id ASC")
    mails, _ = d1_query(token, acct, "SELECT * FROM mails ORDER BY id ASC")

    exported_at = datetime.now(timezone.utc)
    backup_dir = Path(args.output_dir) if args.output_dir else DEFAULT_BACKUP_DIR
    backup_dir.mkdir(parents=True, exist_ok=True)
    filename = f"temp-mail-backup-{exported_at.strftime('%Y%m%d-%H%M%S')}.json"
    out_path = backup_dir / filename

    dump = {
        "exported_at": exported_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "database_id": D1_DATABASE_ID,
        "counts": {"addresses": len(addresses), "mails": len(mails)},
        "addresses": addresses,
        "mails": mails,
    }
    out_path.write_text(json.dumps(dump, indent=2, ensure_ascii=False),
                        encoding="utf-8")

    print(f"Exported {len(addresses)} addresses and {len(mails)} mails")
    print(f"Written  : {out_path}")
    print("WARNING  : this file contains per-inbox tokens -- keep it "
          "private and do not commit it.")
    return 0


def expired_count(token: str, acct: str, cutoff: int) -> int:
    rows, _ = d1_query(
        token, acct,
        "SELECT COUNT(*) AS count FROM mails WHERE created_at < ?",
        params=[cutoff],
    )
    return scalar_count(rows)


def cmd_cleanup_preview(token: str, acct: str, args: argparse.Namespace) -> int:
    cutoff = cutoff_for(args.hours)
    count = expired_count(token, acct, cutoff)
    print(f"Mails older than {args.hours}h "
          f"(created_at < {cutoff}, {format_ts(cutoff)}): {count}")
    print("Preview only -- nothing was deleted. "
          "Run 'cleanup --yes' to delete these rows.")
    return 0


def cmd_cleanup(token: str, acct: str, args: argparse.Namespace) -> int:
    if not args.yes:
        print(
            "ERROR: cleanup deletes mail permanently and requires --yes.\n"
            "Run 'cleanup-preview' first to see how many rows would go, "
            "then re-run as:\n"
            "  python3 scripts/d1-maintenance.py cleanup --yes",
            file=sys.stderr,
        )
        return 2

    cutoff = cutoff_for(args.hours)
    count = expired_count(token, acct, cutoff)
    if count == 0:
        print(f"No mails older than {args.hours}h -- nothing to delete.")
        return 0

    _, meta = d1_query(
        token, acct,
        "DELETE FROM mails WHERE created_at < ?",
        params=[cutoff],
    )
    # D1 reports the affected-row count in meta as 'changes' (newer API
    # versions use 'rows_written'); fall back to the previewed count.
    deleted = meta.get("changes", meta.get("rows_written", count))
    remaining = expired_count(token, acct, cutoff)
    print(f"Deleted {deleted} mails older than {args.hours}h "
          f"(created_at < {cutoff}, {format_ts(cutoff)}).")
    print(f"Expired mails remaining: {remaining}")
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="D1 maintenance for Temp Mail v2: stats, export, "
                    "and TTL cleanup via the Cloudflare D1 query API.",
        epilog="The API token is read only from the CLOUDFLARE_API_TOKEN "
               "environment variable and is never printed.",
    )
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")

    sub.add_parser(
        "stats",
        help="Row counts for addresses/mails plus oldest/newest mail.",
        description="Show row counts for addresses and mails, and the "
                    "oldest and newest mail rows. Read-only.",
    )

    p_export = sub.add_parser(
        "export",
        help="Dump addresses + mails to a timestamped JSON file in backups/.",
        description="Dump all addresses and mails rows to a timestamped "
                    "JSON file. The file contains per-inbox tokens -- "
                    "keep it private.",
    )
    p_export.add_argument(
        "--output-dir",
        default=None,
        help="Directory for the backup file (default: backups/ at the "
             "repository root).",
    )

    for name, help_text, desc in (
        ("cleanup-preview",
         "Count mails older than the TTL without deleting anything.",
         "Count mails older than the TTL. Read-only: SELECT only, "
         "never DELETE."),
        ("cleanup",
         "DELETE mails older than the TTL (requires --yes).",
         "Delete mails older than the TTL. Refuses to run without --yes."),
    ):
        p = sub.add_parser(name, help=help_text, description=desc)
        p.add_argument(
            "--hours",
            type=int,
            default=DEFAULT_TTL_HOURS,
            help=f"Age threshold in hours (default: {DEFAULT_TTL_HOURS}).",
        )
        if name == "cleanup":
            p.add_argument(
                "--yes",
                action="store_true",
                help="Required confirmation: actually perform the delete.",
            )
    return parser


COMMANDS = {
    "stats": cmd_stats,
    "export": cmd_export,
    "cleanup-preview": cmd_cleanup_preview,
    "cleanup": cmd_cleanup,
}


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help(sys.stderr)
        print("\nERROR: a subcommand is required "
              "(stats, export, cleanup-preview, cleanup).", file=sys.stderr)
        return 2

    # Validate the destructive flag before any network work / token use,
    # so 'cleanup' without --yes fails fast and touches nothing.
    if args.command == "cleanup" and not args.yes:
        return cmd_cleanup("", account_id(), args)

    token = require_token()
    handler = COMMANDS[args.command]
    try:
        return handler(token, account_id(), args)
    except D1Error as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
