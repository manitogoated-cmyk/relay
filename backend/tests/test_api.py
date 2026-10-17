from __future__ import annotations

import io
import json
import logging

from conftest import PNG_1x1, bearer, create_account, first_channel, ingest_path, login, make_webhook
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import session_factory
from app.models import Attachment, AuditLog, Delivery, Message, Webhook


def _db():
    return session_factory()()


def anon(client: TestClient) -> TestClient:
    return TestClient(client.app, headers={"X-Relay-Request": "1"})


# --- dashboard auth --------------------------------------------------------------------------


def test_dashboard_requires_sign_in(make_app):
    c = make_app()
    create_account()
    for path in ("/api/app/channels", "/api/app/webhooks", "/api/app/messages", "/api/app/overview",
                 "/api/app/stream", "/api/app/audit", "/api/app/config"):
        r = c.get(path)
        assert r.status_code == 401, path
        assert r.json()["error"]["code"] == "not_signed_in"


def test_login_logout_and_bad_password(make_app):
    c = make_app()
    create_account()
    r = c.post("/api/auth/login", json={"username": "owner", "password": "nope nope nope"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_login"
    r = c.post("/api/auth/login", json={"username": "ghost", "password": "nope nope nope"})
    assert r.status_code == 401
    login(c)
    cookie = c.cookies.get("relay_session")
    assert cookie and "relay_session" in c.get("/api/auth/state").headers.get("set-cookie", "relay_session")
    assert c.get("/api/auth/state").json()["user"]["username"] == "owner"
    c.post("/api/auth/logout")
    assert c.get("/api/app/channels").status_code == 401


def test_session_cookie_flags(make_app):
    c = make_app()
    create_account()
    r = c.post("/api/auth/login", json={"username": "owner", "password": "correct horse battery"})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_csrf_header_required_for_writes(client):
    r = client.post("/api/app/channels", json={"name": "x"}, headers={"X-Relay-Request": ""})
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed"
    r = client.post("/api/app/channels", json={"name": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_login_rate_limited(make_app):
    c = make_app(RELAY_LOGIN_ATTEMPTS_PER_5MIN="3")
    create_account()
    codes = [c.post("/api/auth/login", json={"username": "owner", "password": "wrong wrong"}).status_code
             for _ in range(5)]
    assert codes[:3] == [401, 401, 401] and codes[3] == 429


def test_setup_needs_token_when_remote(make_app):
    c = make_app(RELAY_SETUP_TOKEN="let-me-in-please")
    assert c.get("/api/auth/state").json()["setup_required"] is True
    body = {"username": "first", "password": "a strong password"}
    assert c.post("/api/auth/setup", json=body).status_code == 403
    r = c.post("/api/auth/setup", json={**body, "setup_token": "let-me-in-please"})
    assert r.status_code == 200
    assert len(c.get("/api/app/channels").json()["channels"]) == 5
    assert c.post("/api/auth/setup", json={**body, "setup_token": "let-me-in-please"}).status_code == 409


# --- webhook management -----------------------------------------------------------------------


def test_create_webhook_shows_secret_once_and_stores_hash(client):
    hook, secret = make_webhook(client)
    assert hook["url"].endswith(f"/api/webhooks/{hook['public_id']}")
    assert hook["has_secret"] and hook["secret_hint"] == secret[-4:]
    listing = client.get("/api/app/webhooks").text
    assert secret not in listing and secret not in client.get(f"/api/app/webhooks/{hook['id']}").text
    with _db() as db:
        row = db.get(Webhook, hook["id"])
        assert row.secret_hash and secret not in row.secret_hash and len(row.secret_hash) == 64
        actions = [a.action for a in db.scalars(select(AuditLog))]
        assert "webhook.created" in actions
        assert all(secret not in json.dumps(a.details) for a in db.scalars(select(AuditLog)))


def test_public_base_url_comes_from_config(make_app):
    c = make_app(RELAY_PUBLIC_BASE_URL="https://relay.example.org/")
    create_account()
    login(c)
    hook, _ = make_webhook(c)
    assert hook["url"] == f"https://relay.example.org/api/webhooks/{hook['public_id']}"


def test_rename_disable_enable_rotate_revoke_delete(client):
    hook, secret = make_webhook(client)
    path = ingest_path(hook)
    r = client.patch(f"/api/app/webhooks/{hook['id']}", json={"name": "Renamed", "enabled": False})
    assert r.json()["webhook"]["name"] == "Renamed" and not r.json()["webhook"]["enabled"]
    r = client.post(path, json={"message": "hi"}, headers=bearer(secret))
    assert r.status_code == 403 and r.json()["error"]["code"] == "webhook_disabled"
    client.patch(f"/api/app/webhooks/{hook['id']}", json={"enabled": True})
    assert client.post(path, json={"message": "hi"}, headers=bearer(secret)).status_code == 201

    new_secret = client.post(f"/api/app/webhooks/{hook['id']}/rotate").json()["secret"]
    assert new_secret != secret
    assert client.post(path, json={"message": "old"}, headers=bearer(secret)).status_code == 401
    assert client.post(path, json={"message": "new"}, headers=bearer(new_secret)).status_code == 201

    assert client.post(f"/api/app/webhooks/{hook['id']}/revoke").json()["webhook"]["has_secret"] is False
    assert client.post(path, json={"message": "x"}, headers=bearer(new_secret)).status_code == 401

    new_url = client.post(f"/api/app/webhooks/{hook['id']}/regenerate-url").json()["webhook"]
    assert new_url["public_id"] != hook["public_id"]

    assert client.delete(f"/api/app/webhooks/{hook['id']}").status_code == 200
    assert client.get(f"/api/app/webhooks/{hook['id']}").status_code == 404
    # Messages stay, detached from the deleted webhook.
    msgs = client.get("/api/app/messages").json()["messages"]
    assert len(msgs) == 2 and all(m["webhook_id"] is None for m in msgs)
    with _db() as db:
        actions = {a.action for a in db.scalars(select(AuditLog))}
    assert {"webhook.created", "webhook.disabled", "webhook.enabled", "webhook.secret_rotated",
            "webhook.secret_revoked", "webhook.url_regenerated", "webhook.deleted"} <= actions


# --- ingest -----------------------------------------------------------------------------------


def test_json_message_end_to_end(client, caplog):
    hook, secret = make_webhook(client)
    caplog.set_level(logging.DEBUG)
    r = client.post(
        ingest_path(hook),
        headers=bearer(secret),
        json={"title": "Agent Update", "message": "The task has completed successfully.", "status": "success"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["ok"] and body["request_id"].startswith("req_") and r.headers["x-request-id"] == body["request_id"]
    msg_id = body["message"]["id"]
    with _db() as db:
        m = db.get(Message, msg_id)
        assert m.embeds[0]["description"] == "The task has completed successfully." and m.status == "success"
        assert m.channel_id == hook["channel_id"] and m.webhook_id == hook["id"]
        d = db.scalar(select(Delivery).where(Delivery.message_id == msg_id))
        assert d.status_code == 201 and d.request_id == body["request_id"]
    listed = client.get("/api/app/messages", params={"channel_id": hook["channel_id"]}).json()["messages"]
    assert listed[0]["id"] == msg_id and listed[0]["embeds"][0]["title"] == "Agent Update"
    assert listed[0]["sender"]["name"] == "Build bot" and not listed[0]["read"]
    assert secret not in caplog.text
    assert client.get(f"/api/app/webhooks/{hook['id']}").json()["webhook"]["last_used_at"]


def test_x_relay_secret_header_and_text_plain(client):
    hook, secret = make_webhook(client)
    r = client.post(ingest_path(hook), content="plain text body", headers={"X-Relay-Secret": secret,
                                                                            "Content-Type": "text/plain"})
    assert r.status_code == 201
    assert client.get("/api/app/messages").json()["messages"][0]["content"] == "plain text body"


def test_credentials_rejected(client):
    hook, secret = make_webhook(client)
    path = ingest_path(hook)
    ext = anon(client)
    r = ext.post(path, json={"message": "x"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "missing_credentials"
    assert r.headers["www-authenticate"] == "Bearer"
    r = ext.post(path, json={"message": "x"}, headers=bearer("rls_wrong"))
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_credentials"
    unknown = ext.post("/api/webhooks/doesnotexist123", json={"message": "x"}, headers=bearer(secret))
    assert unknown.status_code == 401 and unknown.json()["error"] == r.json()["error"]
    # The secret only works as a header, never as a query parameter.
    assert ext.post(f"{path}?secret={secret}", json={"message": "x"}).status_code == 401
    # A session cookie doesn't authorise ingest either.
    assert client.post(path, json={"message": "x"}).status_code == 401
    assert client.get("/api/app/messages").json()["messages"] == []
    deliveries = client.get(f"/api/app/webhooks/{hook['id']}/deliveries").json()["deliveries"]
    assert deliveries[0]["error_code"] == "invalid_credentials"
    assert all(secret not in json.dumps(d) for d in deliveries)


def test_malformed_and_invalid_payloads(client):
    hook, secret = make_webhook(client)
    path, h = ingest_path(hook), bearer(secret)
    cases = [
        (dict(content="{not json", headers={**h, "Content-Type": "application/json"}), 400, "invalid_json"),
        (dict(content="[1,2]", headers={**h, "Content-Type": "application/json"}), 400, "invalid_json"),
        (dict(content="", headers={**h, "Content-Type": "application/json"}), 400, "empty_body"),
        (dict(json={}, headers=h), 400, "empty_message"),
        (dict(json={"message": "x", "url": "javascript:alert(1)"}, headers=h), 422, "validation_failed"),
        (dict(content="<x/>", headers={**h, "Content-Type": "application/xml"}), 415, "unsupported_media_type"),
        (dict(json={"message": "x"}, headers={**h, "Idempotency-Key": "has space"}), 400, "invalid_idempotency_key"),
    ]
    for kwargs, status, code in cases:
        r = client.post(path, **kwargs)
        assert (r.status_code, r.json()["error"]["code"]) == (status, code), r.text
    r = client.post(path, json={"message": "x", "color": "nope"}, headers=h)
    assert r.json()["error"]["details"][0]["field"] == "color"
    errors = client.get(f"/api/app/webhooks/{hook['id']}/deliveries", params={"errors_only": True}).json()
    assert len(errors["deliveries"]) == len(cases) + 1


def test_oversized_json_rejected(make_app):
    c = make_app(RELAY_MAX_JSON_BYTES="2048")
    create_account()
    login(c)
    hook, secret = make_webhook(c)
    r = c.post(ingest_path(hook), json={"message": "x" * 3000}, headers=bearer(secret))
    assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"
    assert c.get(f"/api/app/webhooks/{hook['id']}/deliveries").json()["deliveries"][0]["status_code"] == 413


def test_rate_limit_per_webhook(make_app):
    c = make_app(RELAY_WEBHOOK_BURST="3", RELAY_WEBHOOK_RATE_PER_MINUTE="1")
    create_account()
    login(c)
    hook, secret = make_webhook(c)
    codes = [c.post(ingest_path(hook), json={"message": str(i)}, headers=bearer(secret)) for i in range(5)]
    assert [r.status_code for r in codes] == [201, 201, 201, 429, 429]
    assert int(codes[3].headers["retry-after"]) >= 1
    assert codes[3].json()["error"]["code"] == "rate_limited"


def test_failed_auth_is_throttled_per_ip(make_app):
    c = make_app(RELAY_AUTH_FAILURES_PER_MINUTE="3")
    create_account()
    login(c)
    hook, secret = make_webhook(c)
    codes = [c.post(ingest_path(hook), json={"message": "x"}, headers=bearer("rls_bad")).status_code
             for _ in range(5)]
    assert codes == [401, 401, 401, 429, 429]


def test_idempotency_key_dedupes(client):
    hook, secret = make_webhook(client)
    h = {**bearer(secret), "Idempotency-Key": "job-42"}
    first = client.post(ingest_path(hook), json={"message": "once"}, headers=h)
    second = client.post(ingest_path(hook), json={"message": "once"}, headers=h)
    assert first.status_code == 201 and second.status_code == 200
    assert second.json()["duplicate"] and second.headers["idempotent-replayed"] == "true"
    assert first.json()["message"]["id"] == second.json()["message"]["id"]
    assert len(client.get("/api/app/messages").json()["messages"]) == 1


def test_rich_message_and_discord_payload(client):
    hook, secret = make_webhook(client)
    payload = {
        "username": "Deploy",
        "content": "Shipped **v2**",
        "embeds": [{"title": "Release", "url": "https://example.com/r", "color": 0x22C55E,
                    "fields": [{"name": "Env", "value": "prod", "inline": True}],
                    "thumbnail": {"url": "https://example.com/t.png"}, "timestamp": "2026-10-16T10:00:00Z"}],
        "data": {"commit": "abc123"},
    }
    assert client.post(ingest_path(hook), json=payload, headers=bearer(secret)).status_code == 201
    m = client.get("/api/app/messages").json()["messages"][0]
    assert m["kind"] == "rich" and m["sender"]["name"] == "Deploy"
    e = m["embeds"][0]
    assert e["color"] == "#22c55e" and e["thumbnail_url"] == "https://example.com/t.png"
    assert e["timestamp"] == "2026-10-16T10:00:00Z" and m["data"] == {"commit": "abc123"}


# --- files ------------------------------------------------------------------------------------


def _files(*items):
    return [("files", (name, io.BytesIO(data), ctype)) for name, data, ctype in items]


def test_multipart_upload_and_private_download(client, make_app):
    hook, secret = make_webhook(client)
    r = client.post(
        ingest_path(hook),
        headers=bearer(secret),
        data={"payload_json": json.dumps({"message": "Nightly report", "status": "info"})},
        files=_files(("../../shot.png", PNG_1x1, "image/png"), ("report.csv", b"a,b\n1,2\n", "text/csv")),
    )
    assert r.status_code == 201, r.text
    atts = r.json()["message"]["attachments"]
    assert [a["filename"] for a in atts] == ["shot.png", "report.csv"]
    m = client.get("/api/app/messages").json()["messages"][0]
    img, csv = m["attachments"]
    assert img["is_image"] and img["width"] == 1 and not csv["is_image"]

    r = client.get(img["url"])
    assert r.status_code == 200 and r.content == PNG_1x1 and r.headers["content-type"] == "image/png"
    assert r.headers["content-disposition"].startswith("inline") and r.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in r.headers["content-security-policy"]
    r = client.get(csv["url"])
    assert r.headers["content-disposition"].startswith("attachment") and r.content == b"a,b\n1,2\n"
    assert client.get(img["download_url"]).headers["content-disposition"].startswith("attachment")

    # Not signed in: refused. Other account: looks missing.
    assert anon(client).get(img["url"]).status_code == 401
    create_account("intruder")
    other = login(anon(client), "intruder")
    assert other.get(img["url"]).status_code == 404
    assert other.get(f"/api/app/messages/{m['id']}").status_code == 404

    with _db() as db:
        stored = db.get(Attachment, img["id"])
        assert stored.sha256 and stored.filename == "shot.png"


def test_multipart_individual_fields(client):
    hook, secret = make_webhook(client)
    r = client.post(ingest_path(hook), headers=bearer(secret),
                    data={"title": "Export", "status": "success", "fields": json.dumps([{"name": "rows", "value": 9}])},
                    files=_files(("export.json", b'{"ok":true}', "application/json")))
    assert r.status_code == 201, r.text
    m = client.get("/api/app/messages").json()["messages"][0]
    assert m["embeds"][0]["fields"][0]["value"] == "9" and m["attachments"][0]["content_type"] == "application/json"


def test_file_only_message(client):
    hook, secret = make_webhook(client)
    r = client.post(ingest_path(hook), headers=bearer(secret), files=_files(("a.txt", b"hello", "text/plain")))
    assert r.status_code == 201
    assert client.get("/api/app/messages").json()["messages"][0]["kind"] == "file"


def test_invalid_uploads(make_app):
    c = make_app(RELAY_MAX_FILE_BYTES="1024", RELAY_MAX_FILES="2")
    create_account()
    login(c)
    hook, secret = make_webhook(c)
    path, h = ingest_path(hook), bearer(secret)
    cases = [
        (_files(("tool.exe", b"MZ" + b"\x00" * 10, "application/octet-stream")), 415, "file_type_blocked"),
        (_files(("x.svg", b"<svg/>", "image/svg+xml")), 415, "file_type_blocked"),
        (_files(("photo.png", b"%PDF-1.4", "image/png")), 415, "file_type_mismatch"),
        (_files(("blob.dat", b"\x00\xff\x00", "application/octet-stream")), 415, "file_type_unsupported"),
        (_files(("big.txt", b"a" * 2000, "text/plain")), 413, "file_too_large"),
        (_files(*[(f"{i}.txt", b"x", "text/plain") for i in range(3)]), 400, "too_many_files"),
    ]
    for files, status, code in cases:
        r = c.post(path, headers=h, data={"message": "x"}, files=files)
        assert (r.status_code, r.json()["error"]["code"]) == (status, code), r.text
    assert c.get("/api/app/messages").json()["messages"] == []
    from app.config import get_settings

    uploads = get_settings().storage_dir
    assert not uploads.exists() or not [p for p in uploads.rglob("*") if p.is_file()]


def test_multipart_total_size_cap(make_app):
    c = make_app(RELAY_MAX_UPLOAD_BYTES="4096", RELAY_MAX_FILE_BYTES="100000")
    create_account()
    login(c)
    hook, secret = make_webhook(c)
    r = c.post(ingest_path(hook), headers=bearer(secret), files=_files(("big.txt", b"a" * 200_000, "text/plain")))
    assert r.status_code == 413


# --- feed features ----------------------------------------------------------------------------


def test_search_filters_read_pin_archive(client):
    hook, secret = make_webhook(client)
    p = ingest_path(hook)
    for body in ({"message": "disk almost full", "status": "warning"}, {"message": "deploy done", "status": "success"},
                 {"title": "Crash", "description": "null pointer", "status": "error", "tags": ["api"]}):
        assert client.post(p, json=body, headers=bearer(secret)).status_code == 201
    get = lambda **q: client.get("/api/app/messages", params=q).json()["messages"]  # noqa: E731
    assert [m["content"] for m in get(q="disk")] == ["disk almost full"]
    assert len(get(q="POINTER")) == 1 and len(get(q="api")) == 1
    assert len(get(q="100%")) == 0
    assert {m["status"] for m in get(status="error,warning")} == {"error", "warning"}
    assert len(get(since="2000-01-01", until="2999-01-01")) == 3 and get(until="2000-01-01") == []
    assert len(get(webhook_id=hook["id"])) == 3

    ch = first_channel(client)
    assert ch["unread"] == 3
    newest = get()[0]
    assert client.patch(f"/api/app/messages/{newest['id']}", json={"read": True, "pinned": True}).status_code == 200
    assert len(get(unread=True)) == 2 and [m["id"] for m in get(pinned=True)] == [newest["id"]]
    client.post("/api/app/messages/read", json={"channel_id": ch["id"]})
    assert first_channel(client)["unread"] == 0

    r = client.post(f"/api/app/channels/{ch['id']}/history", json={"action": "archive"})
    assert r.json()["affected"] == 2  # the pinned one stays
    assert [m["id"] for m in get()] == [newest["id"]] and len(get(archived="only")) == 2
    r = client.post(f"/api/app/channels/{ch['id']}/history", json={"action": "delete"})
    assert r.json()["affected"] == 2 and len(get(archived="include")) == 1


def test_pagination(client):
    hook, secret = make_webhook(client)
    for i in range(7):
        client.post(ingest_path(hook), json={"message": f"m{i}"}, headers=bearer(secret))
    page = client.get("/api/app/messages", params={"limit": 3}).json()
    assert [m["content"] for m in page["messages"]] == ["m6", "m5", "m4"] and page["has_more"]
    nxt = client.get("/api/app/messages", params={"limit": 3, "before_id": page["messages"][-1]["id"]}).json()
    assert [m["content"] for m in nxt["messages"]] == ["m3", "m2", "m1"]
    newer = client.get("/api/app/messages", params={"after_id": page["messages"][1]["id"]}).json()
    assert [m["content"] for m in newer["messages"]] == ["m6"]


def test_channels_crud_and_move(client):
    r = client.post("/api/app/channels", json={"name": "Billing Alerts", "icon": "zap", "color": "#FF00AA"})
    ch = r.json()["channel"]
    assert ch["slug"] == "billing-alerts" and ch["color"] == "#ff00aa"
    hook, secret = make_webhook(client, channel_id=ch["id"])
    client.post(ingest_path(hook), json={"message": "invoice"}, headers=bearer(secret))
    r = client.delete(f"/api/app/channels/{ch['id']}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "channel_in_use"
    general = first_channel(client)
    assert client.delete(f"/api/app/channels/{ch['id']}", params={"move_to": general["id"]}).status_code == 200
    assert client.get(f"/api/app/webhooks/{hook['id']}").json()["webhook"]["channel_id"] == general["id"]
    assert client.get("/api/app/messages", params={"channel_id": general["id"]}).json()["messages"][0][
        "content"] == "invoice"
    assert client.post("/api/app/channels", json={"name": "x", "color": "red"}).status_code == 422


def test_users_are_isolated(client):
    hook, secret = make_webhook(client)
    client.post(ingest_path(hook), json={"message": "private"}, headers=bearer(secret))
    msg = client.get("/api/app/messages").json()["messages"][0]
    create_account("other")
    other = login(anon(client), "other")
    assert other.get("/api/app/messages").json()["messages"] == []
    assert other.get("/api/app/webhooks").json()["webhooks"] == []
    assert other.get(f"/api/app/webhooks/{hook['id']}").status_code == 404
    assert other.post(f"/api/app/webhooks/{hook['id']}/rotate").status_code == 404
    assert other.patch(f"/api/app/messages/{msg['id']}", json={"pinned": True}).status_code == 404
    assert other.delete(f"/api/app/messages/{msg['id']}").status_code == 404
    assert other.get(f"/api/app/webhooks/{hook['id']}/deliveries").status_code == 404
    mine = {c["id"] for c in client.get("/api/app/channels").json()["channels"]}
    theirs = {c["id"] for c in other.get("/api/app/channels").json()["channels"]}
    assert mine.isdisjoint(theirs)
    r = other.post("/api/app/webhooks", json={"name": "sneaky", "channel_id": next(iter(mine))})
    assert r.status_code == 404
    assert other.get("/api/app/messages", params={"channel_id": hook["channel_id"]}).json()["messages"] == []


def test_test_message_stats_overview_audit(client):
    hook, secret = make_webhook(client)
    assert client.post(f"/api/app/webhooks/{hook['id']}/test").status_code == 201
    client.post(ingest_path(hook), json={"message": "ok"}, headers=bearer(secret))
    client.post(ingest_path(hook), json={}, headers=bearer(secret))
    stats = client.get(f"/api/app/webhooks/{hook['id']}").json()["webhook"]["stats"]
    assert stats["messages"] == 2 and stats["deliveries_24h"] == 2 and stats["errors_24h"] == 1
    assert stats["success_rate_24h"] == 50.0 and sum(stats["hourly"]) == 2
    ov = client.get("/api/app/overview").json()
    assert ov["messages_total"] == 2 and ov["unread"] == 2 and ov["errors_24h"] == 1
    entries = client.get("/api/app/audit").json()["entries"]
    assert any(e["action"] == "webhook.created" for e in entries)


def test_retention_purge_keeps_pinned(make_app):
    from datetime import timedelta

    from app.db import utcnow
    from app.deps import app_state
    from app.services import purge_expired

    c = make_app(RELAY_MESSAGE_RETENTION_DAYS="7")
    create_account()
    login(c)
    hook, secret = make_webhook(c)
    for text in ("old", "old pinned", "new"):
        c.post(ingest_path(hook), headers=bearer(secret), data={"message": text},
               files=_files(("a.txt", b"x", "text/plain")))
    with _db() as db:
        rows = {m.content: m for m in db.scalars(select(Message))}
        for key in ("old", "old pinned"):
            rows[key].created_at = utcnow() - timedelta(days=30)
        rows["old pinned"].pinned = True
        old_key = rows["old"].attachments[0].id
        db.commit()
        out = purge_expired(db, app_state().storage)
    assert out["messages"] == 1
    assert sorted(m["content"] for m in c.get("/api/app/messages").json()["messages"]) == ["new", "old pinned"]
    assert not app_state().storage.exists(old_key)


def test_security_headers_and_404_shape(client):
    r = client.get("/api/health")
    assert r.headers["x-frame-options"] == "DENY" and "frame-ancestors 'none'" in r.headers["content-security-policy"]
    r = client.get("/api/app/messages/999999")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found" and r.json()["request_id"]


def test_production_requires_https(make_app):
    c = make_app(RELAY_ENVIRONMENT="production", RELAY_PUBLIC_BASE_URL="https://relay.example.org")
    create_account()
    hook_secret = None
    r = TestClient(c.app, base_url="http://relay.example.org").post("/api/webhooks/abcdefgh12", json={})
    assert r.status_code == 403 and r.json()["error"]["code"] == "https_required"
    r = TestClient(c.app, base_url="http://relay.example.org").get("/", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "https://relay.example.org/"
    secure = TestClient(c.app, base_url="https://relay.example.org", headers={"X-Relay-Request": "1"})
    r = secure.post("/api/auth/login", json={"username": "owner", "password": "correct horse battery"})
    assert r.status_code == 200 and "secure" in r.headers["set-cookie"].lower()
    assert "strict-transport-security" in r.headers
    assert hook_secret is None


def test_production_refuses_to_start_without_https_base(make_app):
    import pytest

    with pytest.raises(RuntimeError, match="PUBLIC_BASE_URL"):
        make_app(RELAY_ENVIRONMENT="production", RELAY_PUBLIC_BASE_URL="")


def test_long_poll_events_fallback(client):
    from app.broker import broker

    start = client.get("/api/app/events").json()
    assert start["events"] == [] and isinstance(start["last_id"], int)
    hook, secret = make_webhook(client)
    client.post(ingest_path(hook), json={"message": "polled"}, headers=bearer(secret))
    got = client.get("/api/app/events", params={"after": start["last_id"], "wait": 0}).json()
    types = [e["type"] for e in got["events"]]
    assert "message.created" in types and got["last_id"] > start["last_id"]
    msg = next(e for e in got["events"] if e["type"] == "message.created")["data"]["message"]
    assert msg["content"] == "polled"
    # Nothing new: returns after the wait with the cursor unchanged.
    idle = client.get("/api/app/events", params={"after": got["last_id"], "wait": 0.2}).json()
    assert idle == {"last_id": got["last_id"], "events": [], "resync": False}
    # A cursor from before a restart (ahead of the server) asks the client to resync.
    assert client.get("/api/app/events", params={"after": broker.last_id + 1000, "wait": 0}).json()["resync"] is True
    # Other accounts never see these events; signed-out callers are refused.
    create_account("other")
    other = login(anon(client), "other")
    assert other.get("/api/app/events", params={"after": start["last_id"], "wait": 0}).json()["events"] == []
    assert anon(client).get("/api/app/events").status_code == 401
