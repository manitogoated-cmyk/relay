"""Shared request plumbing: errors, the signed-in user, CSRF, audit, client details."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db, utcnow
from .models import AuditLog, AuthSession, User
from .ratelimit import Limiters
from .security import sha256_hex
from .storage import Storage, build_storage

SESSION_COOKIE = "relay_session"
CSRF_HEADER = "x-relay-request"


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.details, self.headers = details, headers or {}


@dataclass
class AppState:
    limiters: Limiters
    storage: Storage


_state: AppState | None = None


def app_state() -> AppState:
    global _state
    if _state is None:
        settings = get_settings()
        _state = AppState(limiters=Limiters(settings), storage=build_storage(settings))
    return _state


def reset_app_state() -> None:
    global _state
    _state = None


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "")


def _session_from_cookie(request: Request, db: Session) -> AuthSession | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token or len(token) > 128:
        return None
    sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == sha256_hex(token)))
    if sess is None:
        return None
    now = utcnow()
    if sess.expires_at <= now:
        db.delete(sess)
        db.commit()
        return None
    if now - sess.last_seen_at > timedelta(minutes=5):
        sess.last_seen_at = now
        db.commit()
    return sess


def check_csrf(request: Request) -> None:
    """State-changing dashboard calls must carry a custom header (a cross-site form or image can't set
    one without a CORS preflight, which this server never grants) and, when sent, a same-origin Origin."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return
    if request.headers.get(CSRF_HEADER) != "1":
        raise ApiError(403, "csrf_failed", "Missing X-Relay-Request header.")
    origin = request.headers.get("origin")
    if origin:
        allowed = {f"{request.url.scheme}://{request.url.netloc}"}
        if get_settings().public_base_url:
            allowed.add(get_settings().public_base_url)
        if origin not in allowed:
            raise ApiError(403, "csrf_failed", "Cross-origin request refused.")


def optional_session(request: Request, db: Session = Depends(get_db)) -> AuthSession | None:
    return _session_from_cookie(request, db)


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    sess = _session_from_cookie(request, db)
    if sess is None:
        raise ApiError(401, "not_signed_in", "Sign in to continue.")
    check_csrf(request)
    request.state.user_id = sess.user_id
    return sess.user


def audit(
    db: Session,
    request: Request | None,
    user: User | None,
    action: str,
    target_type: str = "",
    target_id: str | int = "",
    **details: Any,
) -> None:
    db.add(
        AuditLog(
            owner_id=user.id if user else None,
            actor=user.username if user else details.pop("actor", "anonymous"),
            action=action,
            target_type=target_type,
            target_id=str(target_id),
            details=details,
            source_ip=client_ip(request) if request else "",
        )
    )


def public_base(request: Request) -> str:
    configured = get_settings().public_base_url
    if configured:
        return configured
    return f"{request.url.scheme}://{request.url.netloc}"
