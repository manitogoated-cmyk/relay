from __future__ import annotations

import hmac
from datetime import timedelta

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db, utcnow
from ..deps import SESSION_COOKIE, ApiError, app_state, audit, check_csrf, client_ip, current_user, optional_session
from ..middleware import LOCAL_HOSTS
from ..models import AuthSession, User
from ..security import DUMMY_PASSWORD_HASH, hash_password, new_session_token, sha256_hex, verify_password
from ..services import seed_default_channels

router = APIRouter(prefix="/api/auth", tags=["auth"])

USERNAME_PATTERN = r"^[A-Za-z0-9_.-]{3,64}$"


class SetupIn(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    password: str = Field(min_length=10, max_length=256)
    display_name: str = Field(default="", max_length=80)
    setup_token: str = Field(default="", max_length=256)


class LoginIn(BaseModel):
    username: str = Field(max_length=64)
    password: str = Field(max_length=256)


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(min_length=10, max_length=256)


def user_out(u: User) -> dict:
    return {"id": u.id, "username": u.username, "display_name": u.display_name}


def _setup_allowed(request: Request, token: str) -> bool:
    configured = get_settings().setup_token
    if configured:
        return hmac.compare_digest(token.encode(), configured.encode())
    return client_ip(request) in LOCAL_HOSTS


def create_user(db: Session, username: str, password: str, display_name: str = "") -> User:
    user = User(username=username, display_name=display_name or username, password_hash=hash_password(password))
    db.add(user)
    db.flush()
    seed_default_channels(db, user)
    return user


def start_session(db: Session, response: Response, request: Request, user: User) -> None:
    s = get_settings()
    token = new_session_token()
    db.add(
        AuthSession(
            token_hash=sha256_hex(token),
            user_id=user.id,
            expires_at=utcnow() + timedelta(days=s.session_days),
            user_agent=request.headers.get("user-agent", "")[:255],
        )
    )
    user.last_login_at = utcnow()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=s.session_days * 86400,
        httponly=True,
        secure=s.secure_cookies,
        samesite="lax",
        path="/",
    )


@router.get("/state")
def auth_state(request: Request, db: Session = Depends(get_db), sess=Depends(optional_session)):
    has_users = (db.scalar(select(func.count()).select_from(User)) or 0) > 0
    return {
        "setup_required": not has_users,
        "setup_needs_token": bool(get_settings().setup_token) or client_ip(request) not in LOCAL_HOSTS,
        "user": user_out(sess.user) if sess else None,
    }


@router.post("/setup")
def setup(body: SetupIn, request: Request, response: Response, db: Session = Depends(get_db)):
    check_csrf(request)
    if (db.scalar(select(func.count()).select_from(User)) or 0) > 0:
        raise ApiError(409, "already_set_up", "An account already exists. Sign in instead.")
    if not _setup_allowed(request, body.setup_token):
        raise ApiError(403, "setup_forbidden", "Setup from another machine needs RELAY_SETUP_TOKEN.")
    user = create_user(db, body.username, body.password, body.display_name)
    audit(db, request, user, "account.created", "user", user.id)
    start_session(db, response, request, user)
    db.commit()
    return {"user": user_out(user)}


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    check_csrf(request)
    limiter = app_state().limiters.login
    ip = client_ip(request)
    for key in (f"ip:{ip}", f"user:{body.username.lower()}"):
        allowed, retry = limiter.hit(key)
        if not allowed:
            raise ApiError(
                429,
                "rate_limited",
                "Too many sign-in attempts. Try again shortly.",
                headers={"Retry-After": str(retry)},
            )
    user = db.scalar(select(User).where(func.lower(User.username) == body.username.lower()))
    if not verify_password(body.password, user.password_hash if user else DUMMY_PASSWORD_HASH) or user is None:
        audit(db, request, None, "login.failed", "user", "", actor=body.username[:64] or "anonymous")
        db.commit()
        raise ApiError(401, "invalid_login", "Wrong username or password.")
    start_session(db, response, request, user)
    audit(db, request, user, "login.succeeded", "user", user.id)
    db.commit()
    return {"user": user_out(user)}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db), sess=Depends(optional_session)):
    check_csrf(request)
    if sess is not None:
        db.delete(sess)
        db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.post("/password")
def change_password(
    body: PasswordIn, request: Request, db: Session = Depends(get_db), user: User = Depends(current_user)
):
    if not verify_password(body.current_password, user.password_hash):
        raise ApiError(400, "invalid_password", "Current password is wrong.")
    user.password_hash = hash_password(body.new_password)
    # Sign out every other session.
    token_hash = sha256_hex(request.cookies.get(SESSION_COOKIE, ""))
    for s in db.scalars(select(AuthSession).where(AuthSession.user_id == user.id)):
        if s.token_hash != token_hash:
            db.delete(s)
    audit(db, request, user, "password.changed", "user", user.id)
    db.commit()
    return {"ok": True}
