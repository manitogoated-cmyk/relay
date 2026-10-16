from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..broker import broker
from ..db import get_db, utcnow
from ..deps import ApiError, app_state, audit, current_user, public_base
from ..models import Delivery, Message, User, Webhook
from ..payloads import WebhookPayload, normalize
from ..security import new_public_id, new_request_id, new_webhook_secret, sha256_hex
from ..serialize import delivery_out, webhook_out
from ..services import create_message, delete_messages, publish_message, webhook_stats
from .channels import COLOR, ICON, notify_channels, owned_channel

router = APIRouter(prefix="/api/app/webhooks", tags=["webhooks"])


class WebhookIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    icon: str = Field(default="bot", pattern=ICON)
    color: str = Field(default="#5eead4", pattern=COLOR)
    channel_id: int


class WebhookPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    icon: str | None = Field(default=None, pattern=ICON)
    color: str | None = Field(default=None, pattern=COLOR)
    channel_id: int | None = None
    enabled: bool | None = None


def owned_webhook(db: Session, user: User, webhook_id: int) -> Webhook:
    w = db.get(Webhook, webhook_id)
    if w is None or w.owner_id != user.id:
        raise ApiError(404, "not_found", "Webhook not found.")
    return w


def _set_secret(w: Webhook) -> str:
    secret = new_webhook_secret()
    w.secret_hash = sha256_hex(secret)
    w.secret_hint = secret[-4:]
    w.secret_rotated_at = utcnow()
    return secret


def _out(db: Session, request: Request, w: Webhook) -> dict:
    return webhook_out(w, public_base(request), webhook_stats(db, [w.id]).get(w.id))


def _changed(user: User) -> None:
    broker.publish(user.id, "webhooks.changed", {})


@router.get("")
def list_webhooks(request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)):
    hooks = list(db.scalars(select(Webhook).where(Webhook.owner_id == user.id).order_by(Webhook.created_at)))
    stats = webhook_stats(db, [w.id for w in hooks])
    base = public_base(request)
    return {"webhooks": [webhook_out(w, base, stats.get(w.id)) for w in hooks], "base_url": base}


@router.post("", status_code=201)
def create_webhook(
    body: WebhookIn, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    owned_channel(db, user, body.channel_id)
    if (db.scalar(select(func.count()).select_from(Webhook).where(Webhook.owner_id == user.id)) or 0) >= 200:
        raise ApiError(400, "limit_reached", "You can have at most 200 webhooks.")
    w = Webhook(
        public_id=new_public_id(),
        owner_id=user.id,
        channel_id=body.channel_id,
        name=body.name.strip(),
        description=body.description.strip(),
        icon=body.icon,
        color=body.color.lower(),
    )
    secret = _set_secret(w)
    db.add(w)
    db.flush()
    audit(db, request, user, "webhook.created", "webhook", w.id, name=w.name, channel_id=w.channel_id)
    db.commit()
    _changed(user)
    # The only response that ever contains this secret.
    return {"webhook": _out(db, request, w), "secret": secret}


@router.get("/{webhook_id}")
def get_webhook(webhook_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return {"webhook": _out(db, request, owned_webhook(db, user, webhook_id))}


@router.patch("/{webhook_id}")
def patch_webhook(
    webhook_id: int,
    body: WebhookPatch,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    w = owned_webhook(db, user, webhook_id)
    changes = body.model_dump(exclude_none=True)
    if "channel_id" in changes:
        owned_channel(db, user, changes["channel_id"])
    for key, value in changes.items():
        if isinstance(value, str):
            value = value.strip().lower() if key == "color" else value.strip()
        setattr(w, key, value)
    if "enabled" in changes:
        audit(db, request, user, "webhook.enabled" if w.enabled else "webhook.disabled", "webhook", w.id, name=w.name)
    other = sorted(set(changes) - {"enabled"})
    if other:
        audit(db, request, user, "webhook.updated", "webhook", w.id, name=w.name, fields=other)
    db.commit()
    _changed(user)
    return {"webhook": _out(db, request, w)}


@router.post("/{webhook_id}/rotate")
def rotate_secret(webhook_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)):
    w = owned_webhook(db, user, webhook_id)
    had = w.secret_hash is not None
    secret = _set_secret(w)
    audit(db, request, user, "webhook.secret_rotated" if had else "webhook.secret_issued", "webhook", w.id, name=w.name)
    db.commit()
    _changed(user)
    return {"webhook": _out(db, request, w), "secret": secret}


@router.post("/{webhook_id}/revoke")
def revoke_secret(webhook_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)):
    w = owned_webhook(db, user, webhook_id)
    w.secret_hash = None
    w.secret_hint = ""
    audit(db, request, user, "webhook.secret_revoked", "webhook", w.id, name=w.name)
    db.commit()
    _changed(user)
    return {"webhook": _out(db, request, w)}


@router.post("/{webhook_id}/regenerate-url")
def regenerate_url(
    webhook_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    w = owned_webhook(db, user, webhook_id)
    old = w.public_id
    w.public_id = new_public_id()
    audit(db, request, user, "webhook.url_regenerated", "webhook", w.id, name=w.name, old_public_id=old)
    db.commit()
    _changed(user)
    return {"webhook": _out(db, request, w)}


@router.delete("/{webhook_id}")
def delete_webhook(
    webhook_id: int,
    request: Request,
    delete_messages_too: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    w = owned_webhook(db, user, webhook_id)
    name = w.name
    removed = 0
    if delete_messages_too:
        removed = delete_messages(db, app_state().storage, Message.webhook_id == w.id)
    else:
        db.execute(update(Message).where(Message.webhook_id == w.id).values(webhook_id=None))
    db.delete(w)
    audit(db, request, user, "webhook.deleted", "webhook", webhook_id, name=name, messages_deleted=removed)
    db.commit()
    _changed(user)
    notify_channels(user.id)
    return {"ok": True, "messages_deleted": removed}


@router.get("/{webhook_id}/deliveries")
def deliveries(
    webhook_id: int,
    limit: int = 50,
    errors_only: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    w = owned_webhook(db, user, webhook_id)
    q = select(Delivery).where(Delivery.webhook_id == w.id)
    if errors_only:
        q = q.where(Delivery.status_code >= 400)
    rows = db.scalars(q.order_by(Delivery.id.desc()).limit(max(1, min(limit, 200))))
    return {"deliveries": [delivery_out(d) for d in rows]}


@router.post("/{webhook_id}/test", status_code=201)
def send_test(webhook_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Post a sample message through the same storage path, from the dashboard (no secret needed)."""
    w = owned_webhook(db, user, webhook_id)
    payload = WebhookPayload.model_validate(
        {
            "title": "Test message",
            "message": f"**{w.name}** is connected. Messages sent to its URL arrive here.",
            "status": "success",
            "fields": [
                {"name": "Webhook", "value": w.name, "inline": True},
                {"name": "Sent from", "value": "Webhook Center", "inline": True},
            ],
            "tags": ["test"],
        }
    )
    rid = new_request_id()
    msg = create_message(db, app_state().storage, w, normalize(payload), [], rid, None)
    db.commit()
    db.refresh(msg)
    publish_message(msg)
    return {"ok": True, "message_id": msg.id, "request_id": rid}
