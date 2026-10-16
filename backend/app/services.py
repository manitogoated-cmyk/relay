from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .broker import broker
from .config import get_settings
from .db import utcnow
from .models import Attachment, AuditLog, Channel, Delivery, Message, User, Webhook
from .security import new_attachment_id
from .serialize import message_out
from .storage import Storage
from .uploads import ValidatedFile

log = logging.getLogger("relay")

DEFAULT_CHANNELS = [
    ("General Notifications", "bell", "#5eead4", "Everything that doesn't belong anywhere else."),
    ("Application Logs", "terminal", "#a78bfa", "Deploys, jobs and service output."),
    ("AI Agent Updates", "spark", "#f0abfc", "Progress and results from your agents."),
    ("Errors and Warnings", "alert", "#f87171", "Failures that need a look."),
    ("File Transfers", "file", "#fbbf24", "Reports, exports and screenshots."),
]


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:60] or "channel"


def unique_slug(db: Session, owner_id: int, name: str, exclude_id: int | None = None) -> str:
    base = slugify(name)
    slug, n = base, 2
    while True:
        q = select(Channel.id).where(Channel.owner_id == owner_id, Channel.slug == slug)
        if exclude_id is not None:
            q = q.where(Channel.id != exclude_id)
        if db.scalar(q) is None:
            return slug
        slug, n = f"{base}-{n}", n + 1


def seed_default_channels(db: Session, user: User) -> list[Channel]:
    out = []
    for pos, (name, icon, color, desc) in enumerate(DEFAULT_CHANNELS):
        c = Channel(
            owner_id=user.id, name=name, slug=slugify(name), icon=icon, color=color, description=desc, position=pos
        )
        db.add(c)
        out.append(c)
    db.flush()
    return out


@dataclass
class IncomingFile:
    data: bytes
    meta: ValidatedFile


def create_message(
    db: Session,
    storage: Storage,
    webhook: Webhook,
    normalized: dict[str, Any],
    files: list[IncomingFile],
    request_id: str,
    idempotency_key: str | None,
) -> Message:
    msg = Message(
        owner_id=webhook.owner_id,
        channel_id=webhook.channel_id,
        webhook_id=webhook.id,
        request_id=request_id,
        idempotency_key=idempotency_key,
        kind="file" if files and normalized["kind"] == "text" and not normalized["content"] else normalized["kind"],
        status=normalized["status"],
        sender_name=normalized["username"] or webhook.name,
        sender_icon=webhook.icon,
        sender_color=webhook.color,
        sender_avatar_url=normalized["avatar_url"],
        content=normalized["content"],
        embeds=normalized["embeds"],
        data=normalized["data"],
        tags=normalized["tags"],
        search_text=(normalized["search_text"] + "\n" + "\n".join(f.meta.filename.lower() for f in files)).strip(),
    )
    stored_keys: list[str] = []
    try:
        for pos, f in enumerate(files):
            key = new_attachment_id()
            storage.put(key, f.data, f.meta.content_type)
            stored_keys.append(key)
            msg.attachments.append(
                Attachment(
                    id=key,
                    owner_id=webhook.owner_id,
                    position=pos,
                    filename=f.meta.filename,
                    content_type=f.meta.content_type,
                    size=len(f.data),
                    sha256=hashlib.sha256(f.data).hexdigest(),
                    is_image=f.meta.is_image,
                    width=f.meta.width,
                    height=f.meta.height,
                )
            )
        db.add(msg)
        webhook.last_used_at = utcnow()
        db.flush()
    except Exception:
        for key in stored_keys:
            try:
                storage.delete(key)
            except Exception:  # pragma: no cover
                log.exception("could not remove orphaned attachment")
        raise
    return msg


def publish_message(msg: Message) -> None:
    broker.publish(msg.owner_id, "message.created", {"message": message_out(msg)})


def delete_attachment_files(storage: Storage, keys: list[str]) -> None:
    for key in keys:
        try:
            storage.delete(key)
        except Exception:
            log.warning("attachment %s could not be removed from storage", key)


def delete_messages(db: Session, storage: Storage, where) -> int:
    """Delete messages matching `where` (a SQL condition) along with their stored files."""
    ids = list(db.scalars(select(Message.id).where(where)))
    if not ids:
        return 0
    total = 0
    for i in range(0, len(ids), 500):
        chunk = ids[i : i + 500]
        keys = list(db.scalars(select(Attachment.id).where(Attachment.message_id.in_(chunk))))
        db.execute(delete(Attachment).where(Attachment.message_id.in_(chunk)))
        db.execute(delete(Message).where(Message.id.in_(chunk)))
        db.commit()
        delete_attachment_files(storage, keys)
        total += len(chunk)
    return total


def purge_expired(db: Session, storage: Storage) -> dict[str, int]:
    s = get_settings()
    now = utcnow()
    out = {"messages": 0, "deliveries": 0, "audit": 0, "idempotency": 0}
    if s.message_retention_days > 0:
        cutoff = now - timedelta(days=s.message_retention_days)
        out["messages"] = delete_messages(db, storage, (Message.created_at < cutoff) & (Message.pinned.is_(False)))
    if s.delivery_retention_days > 0:
        cutoff = now - timedelta(days=s.delivery_retention_days)
        out["deliveries"] = db.execute(delete(Delivery).where(Delivery.received_at < cutoff)).rowcount or 0
    if s.audit_retention_days > 0:
        cutoff = now - timedelta(days=s.audit_retention_days)
        out["audit"] = db.execute(delete(AuditLog).where(AuditLog.created_at < cutoff)).rowcount or 0
    # Idempotency keys only need to live for the dedupe window.
    window = now - timedelta(hours=s.idempotency_window_hours)
    res = db.execute(
        Message.__table__.update()
        .where(Message.idempotency_key.is_not(None), Message.created_at < window)
        .values(idempotency_key=None)
    )
    out["idempotency"] = res.rowcount or 0
    db.commit()
    return out


def webhook_stats(db: Session, webhook_ids: list[int]) -> dict[int, dict[str, Any]]:
    if not webhook_ids:
        return {}
    since = utcnow() - timedelta(hours=24)
    stats: dict[int, dict[str, Any]] = {
        wid: {"messages": 0, "deliveries_24h": 0, "errors_24h": 0, "avg_ms_24h": None, "hourly": [0] * 24}
        for wid in webhook_ids
    }
    for wid, count in db.execute(
        select(Message.webhook_id, func.count()).where(Message.webhook_id.in_(webhook_ids)).group_by(Message.webhook_id)
    ):
        stats[wid]["messages"] = count
    rows = db.execute(
        select(Delivery.webhook_id, Delivery.status_code, Delivery.duration_ms, Delivery.received_at).where(
            Delivery.webhook_id.in_(webhook_ids), Delivery.received_at >= since
        )
    ).all()
    durations: dict[int, list[int]] = {}
    now = utcnow()
    for wid, code, ms, at in rows:
        st = stats[wid]
        st["deliveries_24h"] += 1
        if code >= 400:
            st["errors_24h"] += 1
        else:
            durations.setdefault(wid, []).append(ms)
        bucket = 23 - min(23, int((now - at).total_seconds() // 3600))
        st["hourly"][bucket] += 1
    for wid, ds in durations.items():
        stats[wid]["avg_ms_24h"] = round(sum(ds) / len(ds), 1)
    for st in stats.values():
        n = st["deliveries_24h"]
        st["success_rate_24h"] = None if n == 0 else round(100 * (n - st["errors_24h"]) / n, 1)
    return stats
