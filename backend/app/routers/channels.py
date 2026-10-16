from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..broker import broker
from ..db import get_db, utcnow
from ..deps import ApiError, app_state, audit, current_user
from ..models import Channel, Message, User, Webhook
from ..serialize import channel_out
from ..services import delete_messages, unique_slug

router = APIRouter(prefix="/api/app/channels", tags=["channels"])

ICON = r"^[a-z0-9-]{1,32}$"
COLOR = r"^#[0-9a-fA-F]{6}$"


class ChannelIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    icon: str = Field(default="hash", pattern=ICON)
    color: str = Field(default="#5eead4", pattern=COLOR)


class ChannelPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=300)
    icon: str | None = Field(default=None, pattern=ICON)
    color: str | None = Field(default=None, pattern=COLOR)
    position: int | None = Field(default=None, ge=0, le=10000)


class HistoryAction(BaseModel):
    action: str = Field(pattern=r"^(archive|delete|mark_read)$")


def owned_channel(db: Session, user: User, channel_id: int) -> Channel:
    c = db.get(Channel, channel_id)
    if c is None or c.owner_id != user.id:
        raise ApiError(404, "not_found", "Channel not found.")
    return c


def channel_counts(db: Session, owner_id: int) -> dict[int, tuple[int, int]]:
    live = (Message.owner_id == owner_id) & Message.archived_at.is_(None)
    total = dict(db.execute(select(Message.channel_id, func.count()).where(live).group_by(Message.channel_id)).all())
    unread = dict(
        db.execute(
            select(Message.channel_id, func.count())
            .where(live & Message.read_at.is_(None))
            .group_by(Message.channel_id)
        ).all()
    )
    return {cid: (unread.get(cid, 0), total.get(cid, 0)) for cid in set(total) | set(unread)}


def list_channels(db: Session, user: User) -> list[dict]:
    counts = channel_counts(db, user.id)
    rows = db.scalars(select(Channel).where(Channel.owner_id == user.id).order_by(Channel.position, Channel.id))
    return [channel_out(c, *counts.get(c.id, (0, 0))) for c in rows]


def notify_channels(user_id: int) -> None:
    broker.publish(user_id, "channels.changed", {})


@router.get("")
def get_channels(db: Session = Depends(get_db), user: User = Depends(current_user)):
    return {"channels": list_channels(db, user)}


@router.post("", status_code=201)
def create_channel(
    body: ChannelIn, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    if (db.scalar(select(func.count()).select_from(Channel).where(Channel.owner_id == user.id)) or 0) >= 100:
        raise ApiError(400, "limit_reached", "You can have at most 100 channels.")
    pos = (db.scalar(select(func.max(Channel.position)).where(Channel.owner_id == user.id)) or 0) + 1
    c = Channel(
        owner_id=user.id,
        name=body.name.strip(),
        slug=unique_slug(db, user.id, body.name),
        description=body.description.strip(),
        icon=body.icon,
        color=body.color.lower(),
        position=pos,
    )
    db.add(c)
    db.flush()
    audit(db, request, user, "channel.created", "channel", c.id, name=c.name)
    db.commit()
    notify_channels(user.id)
    return {"channel": channel_out(c)}


@router.patch("/{channel_id}")
def patch_channel(
    channel_id: int,
    body: ChannelPatch,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    c = owned_channel(db, user, channel_id)
    changes = body.model_dump(exclude_none=True)
    if "name" in changes:
        c.name = changes["name"].strip()
        c.slug = unique_slug(db, user.id, c.name, exclude_id=c.id)
    for key in ("description", "icon", "position"):
        if key in changes:
            setattr(c, key, changes[key])
    if "color" in changes:
        c.color = changes["color"].lower()
    audit(db, request, user, "channel.updated", "channel", c.id, fields=sorted(changes))
    db.commit()
    notify_channels(user.id)
    return {"channel": channel_out(c)}


@router.delete("/{channel_id}")
def delete_channel(
    channel_id: int,
    request: Request,
    move_to: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    c = owned_channel(db, user, channel_id)
    hooks = db.scalar(select(func.count()).select_from(Webhook).where(Webhook.channel_id == c.id)) or 0
    msgs = db.scalar(select(func.count()).select_from(Message).where(Message.channel_id == c.id)) or 0
    if move_to is not None:
        target = owned_channel(db, user, move_to)
        if target.id == c.id:
            raise ApiError(400, "invalid_target", "Pick a different channel to move into.")
        db.execute(update(Webhook).where(Webhook.channel_id == c.id).values(channel_id=target.id))
        db.execute(update(Message).where(Message.channel_id == c.id).values(channel_id=target.id))
    elif hooks:
        raise ApiError(
            409,
            "channel_in_use",
            f"{hooks} webhook(s) post to this channel. Move them first.",
            details={"webhooks": hooks, "messages": msgs},
        )
    else:
        db.commit()
        delete_messages(db, app_state().storage, Message.channel_id == c.id)
    db.delete(c)
    audit(
        db,
        request,
        user,
        "channel.deleted",
        "channel",
        channel_id,
        name=c.name,
        moved_to=move_to,
        messages=msgs,
        webhooks=hooks,
    )
    db.commit()
    notify_channels(user.id)
    broker.publish(user.id, "webhooks.changed", {})
    return {"ok": True}


@router.post("/{channel_id}/history")
def channel_history(
    channel_id: int,
    body: HistoryAction,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
):
    """Bulk actions on a channel's history. Pinned messages survive archive and delete."""
    c = owned_channel(db, user, channel_id)
    scope = (Message.channel_id == c.id) & (Message.owner_id == user.id)
    if body.action == "mark_read":
        n = db.execute(update(Message).where(scope & Message.read_at.is_(None)).values(read_at=utcnow())).rowcount
    elif body.action == "archive":
        n = db.execute(
            update(Message)
            .where(scope & Message.archived_at.is_(None) & Message.pinned.is_(False))
            .values(archived_at=utcnow(), read_at=func.coalesce(Message.read_at, utcnow()))
        ).rowcount
    else:
        n = delete_messages(db, app_state().storage, scope & Message.pinned.is_(False))
    if body.action != "mark_read":
        audit(db, request, user, f"history.{body.action}", "channel", c.id, name=c.name, count=n)
    db.commit()
    notify_channels(user.id)
    broker.publish(user.id, "messages.bulk", {"channel_id": c.id, "action": body.action})
    return {"ok": True, "affected": n}
