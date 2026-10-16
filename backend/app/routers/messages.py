from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from ..broker import broker
from ..db import get_db, utcnow
from ..deps import ApiError, app_state, audit, current_user
from ..models import Attachment, AuditLog, Delivery, Message, User, Webhook
from ..serialize import audit_out, message_out
from ..services import delete_messages
from .channels import notify_channels

router = APIRouter(prefix="/api/app", tags=["messages"])


def _parse_dt(value: str | None, name: str, end_of_day: bool = False) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(400, "invalid_date", f"'{name}' must be an ISO date or date-time.") from None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    if end_of_day and len(value) == 10:
        dt = dt + timedelta(days=1)
    return dt


def _like(term: str) -> str:
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("/messages")
def list_messages(
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
    channel_id: int | None = None,
    webhook_id: int | None = None,
    q: str | None = Query(default=None, max_length=200),
    status: str | None = Query(default=None, max_length=60),
    kind: str | None = Query(default=None, max_length=60),
    has_attachments: bool | None = None,
    pinned: bool | None = None,
    unread: bool | None = None,
    archived: Literal["exclude", "include", "only"] = "exclude",
    since: str | None = None,
    until: str | None = None,
    before_id: int | None = None,
    after_id: int | None = None,
    limit: int = Query(default=50, ge=1, le=200),
):
    cond = [Message.owner_id == user.id]
    if channel_id is not None:
        cond.append(Message.channel_id == channel_id)
    if webhook_id is not None:
        cond.append(Message.webhook_id == webhook_id)
    if q and q.strip():
        for term in q.lower().split()[:8]:
            cond.append(
                or_(
                    Message.search_text.like(_like(term), escape="\\"),
                    func.lower(Message.sender_name).like(_like(term), escape="\\"),
                )
            )
    if status:
        cond.append(Message.status.in_([s for s in status.split(",") if s]))
    if kind:
        cond.append(Message.kind.in_([k for k in kind.split(",") if k]))
    if has_attachments is not None:
        has = select(Attachment.id).where(Attachment.message_id == Message.id).exists()
        cond.append(has if has_attachments else ~has)
    if pinned is not None:
        cond.append(Message.pinned.is_(pinned))
    if unread is not None:
        cond.append(Message.read_at.is_(None) if unread else Message.read_at.is_not(None))
    if archived == "exclude":
        cond.append(Message.archived_at.is_(None))
    elif archived == "only":
        cond.append(Message.archived_at.is_not(None))
    if (start := _parse_dt(since, "since")) is not None:
        cond.append(Message.created_at >= start)
    if (end := _parse_dt(until, "until", end_of_day=True)) is not None:
        cond.append(Message.created_at < end)

    query = select(Message).where(*cond).options(selectinload(Message.attachments))
    if after_id is not None:
        rows = list(db.scalars(query.where(Message.id > after_id).order_by(Message.id.asc()).limit(limit)))
        rows.reverse()
    else:
        if before_id is not None:
            query = query.where(Message.id < before_id)
        rows = list(db.scalars(query.order_by(Message.id.desc()).limit(limit + 1)))
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {"messages": [message_out(m) for m in rows], "has_more": has_more}


def owned_message(db: Session, user: User, message_id: int) -> Message:
    m = db.get(Message, message_id)
    if m is None or m.owner_id != user.id:
        raise ApiError(404, "not_found", "Message not found.")
    return m


@router.get("/messages/{message_id}")
def get_message(message_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    m = owned_message(db, user, message_id)
    out = message_out(m)
    delivery = db.scalar(select(Delivery).where(Delivery.message_id == m.id))
    out["delivery"] = (
        {
            "received_at": delivery.received_at.isoformat() + "Z",
            "duration_ms": delivery.duration_ms,
            "body_bytes": delivery.body_bytes,
            "content_type": delivery.content_type,
            "source_ip": delivery.source_ip,
            "user_agent": delivery.user_agent,
        }
        if delivery
        else None
    )
    return {"message": out}


class MessagePatch(BaseModel):
    read: bool | None = None
    pinned: bool | None = None
    archived: bool | None = None


@router.patch("/messages/{message_id}")
def patch_message(
    message_id: int, body: MessagePatch, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    m = owned_message(db, user, message_id)
    if body.read is not None:
        m.read_at = (m.read_at or utcnow()) if body.read else None
    if body.pinned is not None:
        m.pinned = body.pinned
    if body.archived is not None:
        m.archived_at = (m.archived_at or utcnow()) if body.archived else None
        if body.archived and m.read_at is None:
            m.read_at = utcnow()
    db.commit()
    out = message_out(m)
    broker.publish(user.id, "message.updated", {"message": out})
    notify_channels(user.id)
    return {"message": out}


class MarkRead(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=500)
    channel_id: int | None = None
    up_to_id: int | None = None


@router.post("/messages/read")
def mark_read(body: MarkRead, db: Session = Depends(get_db), user: User = Depends(current_user)):
    cond = [Message.owner_id == user.id, Message.read_at.is_(None)]
    if body.ids:
        cond.append(Message.id.in_(body.ids))
    elif body.channel_id is not None:
        cond.append(Message.channel_id == body.channel_id)
        if body.up_to_id is not None:
            cond.append(Message.id <= body.up_to_id)
    else:
        raise ApiError(400, "invalid_request", "Give message ids or a channel_id.")
    n = db.execute(update(Message).where(*cond).values(read_at=utcnow())).rowcount
    db.commit()
    if n:
        notify_channels(user.id)
        broker.publish(
            user.id, "messages.bulk", {"channel_id": body.channel_id, "action": "mark_read", "ids": body.ids or None}
        )
    return {"ok": True, "affected": n}


@router.delete("/messages/{message_id}")
def delete_message(
    message_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    m = owned_message(db, user, message_id)
    channel_id = m.channel_id
    delete_messages(db, app_state().storage, Message.id == m.id)
    audit(db, request, user, "message.deleted", "message", message_id)
    db.commit()
    broker.publish(user.id, "message.deleted", {"id": message_id, "channel_id": channel_id})
    notify_channels(user.id)
    return {"ok": True}


@router.get("/attachments/{attachment_id}")
def get_attachment(
    attachment_id: str, download: bool = False, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    a = db.get(Attachment, attachment_id) if len(attachment_id) == 32 else None
    # Someone else's attachment answers exactly like a missing one.
    if a is None or a.owner_id != user.id:
        raise ApiError(404, "not_found", "Attachment not found.")
    try:
        stream = app_state().storage.open(a.id)
        first = next(stream, b"")
    except (FileNotFoundError, OSError):
        raise ApiError(410, "attachment_missing", "The stored file is no longer available.") from None

    def body():
        yield first
        yield from stream

    inline = a.is_image and not download
    disposition = "inline" if inline else "attachment"
    ascii_name = a.filename.encode("ascii", "replace").decode().replace('"', "_").replace("?", "_")
    headers = {
        "Content-Disposition": f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(a.filename)}",
        "Content-Length": str(a.size),
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
    }
    media = a.content_type
    if media.startswith("text/") or media in ("application/json", "application/x-ndjson"):
        media += "; charset=utf-8"
    return StreamingResponse(body(), media_type=media, headers=headers)


@router.get("/overview")
def overview(db: Session = Depends(get_db), user: User = Depends(current_user)):
    since = utcnow() - timedelta(hours=24)
    own = Message.owner_id == user.id
    count = lambda q: db.scalar(q) or 0  # noqa: E731
    return {
        "messages_total": count(select(func.count()).select_from(Message).where(own)),
        "messages_24h": count(select(func.count()).select_from(Message).where(own, Message.created_at >= since)),
        "unread": count(
            select(func.count())
            .select_from(Message)
            .where(own, Message.read_at.is_(None), Message.archived_at.is_(None))
        ),
        "pinned": count(select(func.count()).select_from(Message).where(own, Message.pinned.is_(True))),
        "webhooks": count(select(func.count()).select_from(Webhook).where(Webhook.owner_id == user.id)),
        "webhooks_enabled": count(
            select(func.count()).select_from(Webhook).where(Webhook.owner_id == user.id, Webhook.enabled.is_(True))
        ),
        "deliveries_24h": count(
            select(func.count())
            .select_from(Delivery)
            .where(Delivery.owner_id == user.id, Delivery.received_at >= since)
        ),
        "errors_24h": count(
            select(func.count())
            .select_from(Delivery)
            .where(Delivery.owner_id == user.id, Delivery.received_at >= since, Delivery.status_code >= 400)
        ),
        "live_connections": broker.subscriber_count(user.id),
    }


@router.get("/audit")
def audit_log(
    limit: int = Query(default=100, ge=1, le=500),
    before_id: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    q = select(AuditLog).where(AuditLog.owner_id == user.id)
    if before_id is not None:
        q = q.where(AuditLog.id < before_id)
    rows = db.scalars(q.order_by(AuditLog.id.desc()).limit(limit))
    return {"entries": [audit_out(a) for a in rows]}
