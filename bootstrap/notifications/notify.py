#!/usr/bin/env python3
"""Best-effort Cline CLI lifecycle webhook; never forwards task content."""
import json
import os
import sys
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def notification(event):
    status = {"agent_end": "completed", "agent_error": "error"}.get(event.get("hookName"))
    if status is None:
        return None
    return {
        "source": "cline-cli",
        "status": status,
        "message": "Cline work completed." if status == "completed" else "Cline encountered an error.",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def send(payload, endpoint):
    url = urlsplit(endpoint)
    if (url.scheme not in ("http", "https") or not url.hostname
            or url.username is not None or url.password is not None or url.query or url.fragment
            or not url.path.startswith("/api/webhook/") or not url.path.removeprefix("/api/webhook/")):
        raise ValueError("Invalid webhook endpoint")
    request = Request(endpoint, data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
    # No redirects/retries: avoid leaking the webhook identifier or duplicating alerts.
    try:
        with build_opener(NoRedirect()).open(request, timeout=3) as response:
            if not 200 <= response.status < 300:
                raise ValueError("Webhook rejected")
    except HTTPError as error:
        error.close()
        raise ValueError("Webhook rejected") from None


def main():
    try:
        raw = sys.stdin.read(1048577)
        if len(raw) > 1048576:
            raise ValueError("Hook payload too large")
        event = json.loads(raw)
        if not isinstance(event, dict):
            raise ValueError("Expected hook event")
        payload = notification(event)
        if payload is not None:
            if os.environ.get("CLINE_NOTIFY_DRY_RUN") == "1":
                print(json.dumps(payload), file=sys.stderr)
            elif endpoint := os.environ.get("CLINE_NOTIFY_WEBHOOK_URL"):
                send(payload, endpoint)
    except Exception:
        # Exceptions can contain the secret URL or private event data; never print them.
        print("Cline notification skipped: invalid event or webhook delivery failed.", file=sys.stderr)
    # Hook protocol: never add context, block the run, or turn delivery failure into a tool error.
    print("{}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
