from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, utcnow


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    user_agent: Mapped[str] = mapped_column(String(255), default="")

    user: Mapped[User] = relationship()


class Channel(Base):
    __tablename__ = "channels"
    __table_args__ = (UniqueConstraint("owner_id", "slug", name="uq_channel_owner_slug"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    slug: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(300), default="")
    icon: Mapped[str] = mapped_column(String(32), default="hash")
    color: Mapped[str] = mapped_column(String(7), default="#5eead4")
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Webhook(Base):
    __tablename__ = "webhooks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # The id that appears in the public URL; random, not derived from anything.
    public_id: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("channels.id"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(300), default="")
    icon: Mapped[str] = mapped_column(String(32), default="bot")
    color: Mapped[str] = mapped_column(String(7), default="#5eead4")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # SHA-256 of the secret; NULL means the credential was revoked. The secret itself is never stored.
    secret_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    secret_hint: Mapped[str] = mapped_column(String(16), default="")  # last 4 characters, for recognition
    secret_rotated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    channel: Mapped[Channel] = relationship()


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_owner_channel_id", "owner_id", "channel_id", "id"),
        # Partial unique index: two concurrent retries with the same key can't both be stored.
        Index(
            "uq_messages_webhook_idem",
            "webhook_id",
            "idempotency_key",
            unique=True,
            sqlite_where=text("idempotency_key IS NOT NULL"),
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("channels.id"), index=True)
    webhook_id: Mapped[int | None] = mapped_column(
        ForeignKey("webhooks.id", ondelete="SET NULL"), nullable=True, index=True
    )
    request_id: Mapped[str] = mapped_column(String(40), index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)

    kind: Mapped[str] = mapped_column(String(16))  # text | rich | json | file
    status: Mapped[str | None] = mapped_column(String(16), nullable=True)  # info | success | warning | error
    sender_name: Mapped[str] = mapped_column(String(80))
    sender_icon: Mapped[str] = mapped_column(String(32), default="bot")
    sender_color: Mapped[str] = mapped_column(String(7), default="#5eead4")
    sender_avatar_url: Mapped[str | None] = mapped_column(String(2048), nullable=True)

    content: Mapped[str] = mapped_column(Text, default="")
    embeds: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    data: Mapped[Any] = mapped_column(JSON, nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    search_text: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    attachments: Mapped[list[Attachment]] = relationship(
        back_populates="message", cascade="all, delete-orphan", order_by="Attachment.position"
    )
    webhook: Mapped[Webhook | None] = relationship()


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # random hex; also the storage key
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    filename: Mapped[str] = mapped_column(String(160))
    content_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    is_image: Mapped[bool] = mapped_column(Boolean, default=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    message: Mapped[Message] = relationship(back_populates="attachments")


class Delivery(Base):
    """One row per request to a known webhook, accepted or not. Payloads are not stored here."""

    __tablename__ = "deliveries"
    __table_args__ = (Index("ix_deliveries_webhook_time", "webhook_id", "received_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[str] = mapped_column(String(40), index=True)
    webhook_id: Mapped[int] = mapped_column(ForeignKey("webhooks.id", ondelete="CASCADE"))
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[int | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"), nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    status_code: Mapped[int] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    error_detail: Mapped[str | None] = mapped_column(String(300), nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    body_bytes: Mapped[int] = mapped_column(Integer, default=0)
    content_type: Mapped[str] = mapped_column(String(100), default="")
    source_ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(200), default="")
    attachment_count: Mapped[int] = mapped_column(Integer, default=0)
    duplicate: Mapped[bool] = mapped_column(Boolean, default=False)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    actor: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(48), index=True)
    target_type: Mapped[str] = mapped_column(String(32), default="")
    target_id: Mapped[str] = mapped_column(String(64), default="")
    details: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    source_ip: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
