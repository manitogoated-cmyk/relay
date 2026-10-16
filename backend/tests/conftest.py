from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

PASSWORD = "correct horse battery"


def _configure(tmp_path: Path, **overrides: str) -> None:
    env = {
        "RELAY_ENVIRONMENT": "test",
        "RELAY_DATABASE_URL": f"sqlite:///{(tmp_path / 'relay.db').as_posix()}",
        "RELAY_STORAGE_DIR": str(tmp_path / "uploads"),
        "RELAY_FRONTEND_DIST": str(tmp_path / "no-dist"),
        "RELAY_PUBLIC_BASE_URL": "",
        **overrides,
    }
    os.environ.update(env)
    from app.config import get_settings
    from app.db import reset_engine
    from app.deps import reset_app_state

    get_settings.cache_clear()
    reset_engine()
    reset_app_state()


@pytest.fixture
def make_app(tmp_path, monkeypatch):
    """Build a fresh app (own database and storage) with optional RELAY_* overrides."""
    clients: list[TestClient] = []
    for key in list(os.environ):
        if key.startswith("RELAY_"):
            monkeypatch.delenv(key)

    def factory(**overrides: str) -> TestClient:
        for key in overrides:
            monkeypatch.setenv(key, overrides[key])
        _configure(tmp_path, **overrides)
        from app.main import create_app

        client = TestClient(create_app(), headers={"X-Relay-Request": "1"})
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)
    for key in list(os.environ):
        if key.startswith("RELAY_"):
            os.environ.pop(key)
    from app.config import get_settings
    from app.db import reset_engine

    get_settings.cache_clear()
    reset_engine()


def create_account(username: str = "owner") -> None:
    from app.db import session_factory
    from app.routers.auth import create_user

    db = session_factory()()
    try:
        create_user(db, username, PASSWORD)
        db.commit()
    finally:
        db.close()


def login(client: TestClient, username: str = "owner") -> TestClient:
    r = client.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture
def client(make_app) -> TestClient:
    c = make_app()
    create_account()
    return login(c)


def first_channel(client: TestClient) -> dict:
    return client.get("/api/app/channels").json()["channels"][0]


def make_webhook(client: TestClient, name: str = "Build bot", channel_id: int | None = None) -> tuple[dict, str]:
    if channel_id is None:
        channel_id = first_channel(client)["id"]
    r = client.post("/api/app/webhooks", json={"name": name, "channel_id": channel_id, "icon": "rocket"})
    assert r.status_code == 201, r.text
    body = r.json()
    return body["webhook"], body["secret"]


def ingest_path(hook: dict) -> str:
    return f"/api/webhooks/{hook['public_id']}"


def bearer(secret: str) -> dict:
    return {"Authorization": f"Bearer {secret}"}


PNG_1x1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)
