"""The public webhook endpoint: POST /api/webhooks/{public_id}."""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from starlette.datastructures import UploadFile

from ..config import get_settings
from ..db import session_factory
from ..deps import ApiError, app_state, client_ip, request_id
from ..middleware import BodyTooLarge
from ..models import Channel, Delivery, Message, Webhook
from ..payloads import WebhookPayload, format_validation_errors, has_content, normalize
from ..security import secret_matches
from ..services import IncomingFile, create_message, publish_message
from ..uploads import UploadRejected, validate_upload

router = APIRouter()
log = logging.getLogger("relay.ingest")

_IDEM_RE = re.compile(r"^[\x21-\x7e]{1,128}$")
_PUBLIC_ID_RE = re.compile(r"^[A-Za-z0-9]{8,32}$")


@dataclass
class HookRef:
    id: int
    owner_id: int
    enabled: bool


def _presented_secret(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip() or None
    alt = request.headers.get("x-relay-secret", "").strip()
    return alt or None


def _record(
    request: Request,
    hook: HookRef,
    status: int,
    started: float,
    *,
    error_code: str | None = None,
    error_detail: str | None = None,
    message_id: int | None = None,
    attachments: int = 0,
    duplicate: bool = False,
) -> None:
    db = session_factory()()
    try:
        db.add(
            Delivery(
                request_id=request_id(request),
                webhook_id=hook.id,
                owner_id=hook.owner_id,
                message_id=message_id,
                status_code=status,
                error_code=error_code,
                error_detail=(error_detail or "")[:300] or None,
                duration_ms=int((time.perf_counter() - started) * 1000),
                body_bytes=int(request.headers.get("content-length") or 0),
                content_type=request.headers.get("content-type", "")[:100].split(";")[0],
                source_ip=client_ip(request)[:64],
                user_agent=request.headers.get("user-agent", "")[:200],
                attachment_count=attachments,
                duplicate=duplicate,
            )
        )
        db.commit()
    finally:
        db.close()
    from ..broker import broker

    broker.publish(hook.owner_id, "delivery", {"webhook_id": hook.id, "status_code": status, "error_code": error_code})


def _lookup(public_id: str, secret: str) -> tuple[HookRef | None, bool]:
    """(the webhook if the id exists, whether the secret matched)."""
    db = session_factory()()
    try:
        hook = None
        if _PUBLIC_ID_RE.match(public_id):
            hook = db.scalar(select(Webhook).where(Webhook.public_id == public_id))
        if hook is None:
            secret_matches(secret, None)
            return None, False
        return HookRef(hook.id, hook.owner_id, hook.enabled), secret_matches(secret, hook.secret_hash)
    finally:
        db.close()


async def _parse_body(request: Request) -> tuple[dict, list[tuple[str | None, bytes]]]:
    s = get_settings()
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()

    if ctype in ("application/json", "") or ctype.endswith("+json"):
        raw = await request.body()
        if not raw.strip():
            raise ApiError(400, "empty_body", "The request body is empty.")
        if len(raw) > s.max_json_bytes:
            raise ApiError(413, "payload_too_large", f"JSON bodies are limited to {s.max_json_bytes // 1024} KB.")
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ApiError(
                400, "invalid_json", f"Body is not valid JSON: {exc.msg if hasattr(exc, 'msg') else 'bad encoding'}."
            ) from None
        if not isinstance(body, dict):
            raise ApiError(400, "invalid_json", "The JSON body must be an object.")
        return body, []

    if ctype == "text/plain":
        raw = await request.body()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ApiError(400, "invalid_body", "text/plain bodies must be UTF-8.") from None
        return {"message": text}, []

    if ctype == "multipart/form-data":
        try:
            form = await request.form(max_files=s.max_files + 1, max_fields=60, max_part_size=s.max_json_bytes)
        except BodyTooLarge:
            raise
        except Exception as exc:
            raise ApiError(400, "invalid_form", f"Could not parse multipart body: {str(exc)[:120]}") from None
        try:
            body: dict = {}
            files: list[tuple[str | None, bytes]] = []
            for key, value in form.multi_items():
                if isinstance(value, UploadFile):
                    if len(files) >= s.max_files:
                        raise ApiError(400, "too_many_files", f"At most {s.max_files} files per message.")
                    data = await value.read(s.max_file_bytes + 1)
                    files.append((value.filename, data))
                elif key == "payload_json":
                    try:
                        parsed = json.loads(value)
                    except json.JSONDecodeError as exc:
                        raise ApiError(400, "invalid_json", f"payload_json is not valid JSON: {exc.msg}.") from None
                    if not isinstance(parsed, dict):
                        raise ApiError(400, "invalid_json", "payload_json must be a JSON object.")
                    body.update(parsed)
                elif key in ("fields", "embeds", "data", "json", "tags"):
                    try:
                        body[key] = json.loads(value)
                    except json.JSONDecodeError:
                        raise ApiError(400, "invalid_json", f"Form field '{key}' must contain JSON.") from None
                else:
                    body[key] = value
            return body, files
        finally:
            await form.close()

    raise ApiError(
        415,
        "unsupported_media_type",
        "Send application/json, multipart/form-data or text/plain.",
    )


def _store(
    hook: HookRef,
    body: dict,
    raw_files: list[tuple[str | None, bytes]],
    rid: str,
    idem: str | None,
) -> tuple[dict, bool]:
    s = get_settings()
    try:
        payload = WebhookPayload.model_validate(body)
    except ValidationError as exc:
        raise ApiError(
            422, "validation_failed", "The payload has invalid fields.", details=format_validation_errors(exc)
        ) from None
    if not has_content(payload) and not raw_files:
        raise ApiError(400, "empty_message", "Include a message, title, description, embeds, data or a file.")

    files = []
    for name, data in raw_files:
        try:
            files.append(IncomingFile(data, validate_upload(name, data, s.max_file_bytes)))
        except UploadRejected as exc:
            status = 413 if exc.code == "file_too_large" else 415
            raise ApiError(status, exc.code, f"{exc.message} ({(name or 'file')[:60]})") from None

    st = app_state()
    db = session_factory()()
    try:
        webhook = db.get(Webhook, hook.id)
        if webhook is None:
            raise ApiError(401, "invalid_credentials", "Invalid webhook credentials.")
        if idem:
            existing = db.scalar(
                select(Message).where(Message.webhook_id == webhook.id, Message.idempotency_key == idem)
            )
            if existing is not None:
                return _accepted(db, existing), True
        msg = create_message(db, st.storage, webhook, normalize(payload), files, rid, idem)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.scalar(select(Message).where(Message.webhook_id == hook.id, Message.idempotency_key == idem))
            if existing is None:
                raise
            return _accepted(db, existing), True
        db.refresh(msg)
        out = _accepted(db, msg)
        publish_message(msg)
        return out, False
    finally:
        db.close()


def _accepted(db, msg: Message) -> dict:
    channel = db.get(Channel, msg.channel_id)
    return {
        "id": msg.id,
        "channel": {"id": channel.id, "name": channel.name} if channel else None,
        "created_at": msg.created_at.isoformat() + "Z",
        "attachments": [
            {"id": a.id, "filename": a.filename, "size": a.size, "content_type": a.content_type}
            for a in msg.attachments
        ],
    }


@router.post("/api/webhooks/{public_id}", status_code=201, tags=["webhooks"])
async def ingest(public_id: str, request: Request):
    started = time.perf_counter()
    s = get_settings()
    st = app_state()
    ip = client_ip(request)
    rid = request_id(request)

    allowed, retry = st.limiters.ip.hit(ip)
    if not allowed:
        raise ApiError(429, "rate_limited", "Too many requests from this address.", headers={"Retry-After": str(retry)})
    if s.https_required and request.url.scheme != "https":
        raise ApiError(403, "https_required", "Webhook requests must use HTTPS.")

    secret = _presented_secret(request)
    if secret is None:
        raise ApiError(
            401,
            "missing_credentials",
            "Send the webhook secret as 'Authorization: Bearer <secret>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    # Throttle credential guessing before touching the database.
    if not st.limiters.auth_failures.peek(f"probe:{ip}"):
        raise ApiError(429, "rate_limited", "Too many failed attempts.", headers={"Retry-After": "60"})

    hook, ok = await run_in_threadpool(_lookup, public_id, secret[:200])
    if not ok:
        st.limiters.auth_failures.hit(f"probe:{ip}")
        if hook is not None:
            await run_in_threadpool(_record, request, hook, 401, started, error_code="invalid_credentials")
        raise ApiError(
            401, "invalid_credentials", "Invalid webhook credentials.", headers={"WWW-Authenticate": "Bearer"}
        )
    assert hook is not None

    try:
        if not hook.enabled:
            raise ApiError(403, "webhook_disabled", "This webhook is disabled.")
        allowed, retry = st.limiters.webhook.hit(str(hook.id))
        if not allowed:
            raise ApiError(
                429, "rate_limited", "This webhook is sending too fast.", headers={"Retry-After": str(retry)}
            )

        idem = request.headers.get("idempotency-key") or request.headers.get("x-idempotency-key")
        if idem is not None and not _IDEM_RE.match(idem):
            raise ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1-128 printable ASCII characters.")

        try:
            body, raw_files = await _parse_body(request)
        except BodyTooLarge as exc:
            raise ApiError(413, "payload_too_large", str(exc)) from None

        result, duplicate = await run_in_threadpool(_store, hook, body, raw_files, rid, idem)
    except ApiError as err:
        await run_in_threadpool(
            _record, request, hook, err.status, started, error_code=err.code, error_detail=err.message
        )
        raise
    except Exception:
        log.exception("webhook %s: unexpected error (request %s)", hook.id, rid)
        await run_in_threadpool(_record, request, hook, 500, started, error_code="internal_error")
        raise

    await run_in_threadpool(
        _record,
        request,
        hook,
        200 if duplicate else 201,
        started,
        message_id=result["id"],
        attachments=len(result["attachments"]),
        duplicate=duplicate,
    )
    headers = {"Idempotent-Replayed": "true"} if duplicate else {}
    return JSONResponse(
        {"ok": True, "request_id": rid, "duplicate": duplicate, "message": result},
        status_code=200 if duplicate else 201,
        headers=headers,
    )
