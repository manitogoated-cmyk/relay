from __future__ import annotations

from datetime import datetime
from typing import Any

from .models import Attachment, AuditLog, Channel, Delivery, Message, Webhook


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def channel_out(c: Channel, unread: int = 0, total: int = 0) -> dict[str, Any]:
    return {
        "id": c.id,
        "name": c.name,
        "slug": c.slug,
        "description": c.description,
        "icon": c.icon,
        "color": c.color,
        "position": c.position,
        "unread": unread,
        "total": total,
        "created_at": iso(c.created_at),
    }


def webhook_url(base: str, w: Webhook) -> str:
    return f"{base}/api/webhooks/{w.public_id}"


def webhook_out(w: Webhook, base: str, stats: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "id": w.id,
        "public_id": w.public_id,
        "url": webhook_url(base, w),
        "name": w.name,
        "description": w.description,
        "icon": w.icon,
        "color": w.color,
        "channel_id": w.channel_id,
        "enabled": w.enabled,
        "has_secret": w.secret_hash is not None,
        "secret_hint": w.secret_hint if w.secret_hash else "",
        "secret_rotated_at": iso(w.secret_rotated_at),
        "created_at": iso(w.created_at),
        "last_used_at": iso(w.last_used_at),
        "stats": stats or {},
    }


def attachment_out(a: Attachment) -> dict[str, Any]:
    return {
        "id": a.id,
        "filename": a.filename,
        "content_type": a.content_type,
        "size": a.size,
        "is_image": a.is_image,
        "width": a.width,
        "height": a.height,
        "url": f"/api/app/attachments/{a.id}",
        "download_url": f"/api/app/attachments/{a.id}?download=1",
    }


def message_out(m: Message) -> dict[str, Any]:
    return {
        "id": m.id,
        "channel_id": m.channel_id,
        "webhook_id": m.webhook_id,
        "request_id": m.request_id,
        "kind": m.kind,
        "status": m.status,
        "sender": {
            "name": m.sender_name,
            "icon": m.sender_icon,
            "color": m.sender_color,
            "avatar_url": m.sender_avatar_url,
        },
        "content": m.content,
        "embeds": m.embeds or [],
        "data": m.data,
        "tags": m.tags or [],
        "attachments": [attachment_out(a) for a in m.attachments],
        "created_at": iso(m.created_at),
        "read": m.read_at is not None,
        "pinned": m.pinned,
        "archived": m.archived_at is not None,
    }


def delivery_out(d: Delivery) -> dict[str, Any]:
    return {
        "id": d.id,
        "request_id": d.request_id,
        "webhook_id": d.webhook_id,
        "message_id": d.message_id,
        "received_at": iso(d.received_at),
        "status_code": d.status_code,
        "ok": 200 <= d.status_code < 300,
        "error_code": d.error_code,
        "error_detail": d.error_detail,
        "duration_ms": d.duration_ms,
        "body_bytes": d.body_bytes,
        "content_type": d.content_type,
        "source_ip": d.source_ip,
        "user_agent": d.user_agent,
        "attachment_count": d.attachment_count,
        "duplicate": d.duplicate,
    }


def audit_out(a: AuditLog) -> dict[str, Any]:
    return {
        "id": a.id,
        "actor": a.actor,
        "action": a.action,
        "target_type": a.target_type,
        "target_id": a.target_id,
        "details": a.details or {},
        "source_ip": a.source_ip,
        "created_at": iso(a.created_at),
    }
