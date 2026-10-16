"""ASGI middleware: request ids, security headers, HTTPS enforcement, body size caps."""

from __future__ import annotations

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import get_settings
from .security import new_request_id

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' https: data: blob:; connect-src 'self'; font-src 'self' data:; "
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "testserver"}


class BodyTooLarge(Exception):
    pass


def _json_response(status: int, code: str, message: str, rid: str) -> tuple[dict, bytes]:
    body = json.dumps({"ok": False, "error": {"code": code, "message": message}, "request_id": rid}).encode()
    start = {
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
    }
    return start, body


class RelayMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        s = get_settings()
        rid = new_request_id()
        scope.setdefault("state", {})["request_id"] = rid
        path: str = scope.get("path", "")
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        https = scope.get("scheme") == "https"
        host = headers.get("host", "").rsplit(":", 1)[0].strip("[]")

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                h = list(message.get("headers", []))
                present = {k.lower() for k, _ in h}
                defaults = [
                    (b"x-request-id", rid.encode()),
                    (b"x-content-type-options", b"nosniff"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"x-frame-options", b"DENY"),
                    (b"cross-origin-opener-policy", b"same-origin"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"content-security-policy", CSP.encode()),
                ]
                if https and s.is_production:
                    defaults.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                h += [(k, v) for k, v in defaults if k not in present]
                message["headers"] = h
            await send(message)

        # Production: plain HTTP only reaches the app through a misconfigured proxy. Redirect pages, refuse APIs.
        if s.https_required and not https and host not in LOCAL_HOSTS:
            if scope["method"] in ("GET", "HEAD") and not path.startswith("/api/") and s.public_base_url:
                qs = scope.get("query_string", b"").decode()
                location = s.public_base_url + path + (f"?{qs}" if qs else "")
                await send_wrapper(
                    {
                        "type": "http.response.start",
                        "status": 308,
                        "headers": [(b"location", location.encode()), (b"content-length", b"0")],
                    }
                )
                await send_wrapper({"type": "http.response.body", "body": b""})
                return
            if not path.startswith("/api/webhooks/"):  # the ingest route reports this itself, with a delivery log
                start, body = _json_response(403, "https_required", "HTTPS is required.", rid)
                await send_wrapper(start)
                await send_wrapper({"type": "http.response.body", "body": body})
                return

        limit: int | None = None
        if scope["method"] in ("POST", "PUT", "PATCH"):
            if path.startswith("/api/webhooks/"):
                ctype = headers.get("content-type", "")
                limit = s.max_upload_bytes + 64 * 1024 if ctype.startswith("multipart/") else s.max_json_bytes
            else:
                limit = 1024 * 1024  # dashboard API bodies are small

        if limit is None:
            await self.app(scope, receive, send_wrapper)
            return

        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit and not path.startswith("/api/webhooks/"):
            start, body = _json_response(413, "payload_too_large", "Request body too large.", rid)
            await send_wrapper(start)
            await send_wrapper({"type": "http.response.body", "body": body})
            return
        # The ingest route checks the credential first and then reads the body, so an oversized
        # request is reported (and logged) as a delivery of the webhook it was aimed at.
        if declared and declared.isdigit() and int(declared) > limit:
            scope["state"]["declared_too_large"] = True

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            if scope["state"].get("declared_too_large"):
                raise BodyTooLarge(f"Request body exceeds the {limit // 1024} KB limit.")
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise BodyTooLarge(f"Request body exceeds the {limit // 1024} KB limit.")
            return message

        await self.app(scope, limited_receive, send_wrapper)
