"""A real server on a real socket: webhook POST -> database -> SSE stream, plus reconnection replay."""

from __future__ import annotations

import json
import queue
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from conftest import PASSWORD, _configure, create_account


@pytest.fixture
def live_server(tmp_path, monkeypatch):
    for key in ("RELAY_PUBLIC_BASE_URL",):
        monkeypatch.delenv(key, raising=False)
    _configure(tmp_path)
    from app.main import create_app

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started:
        assert time.time() < deadline, "server did not start"
        time.sleep(0.05)
    create_account()
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(10)


def _signed_in(base: str) -> httpx.Client:
    c = httpx.Client(base_url=base, headers={"X-Relay-Request": "1"}, timeout=10)
    assert c.post("/api/auth/login", json={"username": "owner", "password": PASSWORD}).status_code == 200
    return c


def _read_events(base: str, cookies, out: queue.Queue, stop: threading.Event, last_id: str | None = None):
    headers = {"Last-Event-ID": last_id} if last_id else {}
    with httpx.Client(base_url=base, cookies=cookies, timeout=httpx.Timeout(10, read=30)) as c:
        with c.stream("GET", "/api/app/stream", headers=headers) as r:
            out.put(("status", r.status_code))
            event, data, eid = None, None, None
            for line in r.iter_lines():
                if stop.is_set():
                    return
                if line.startswith("event: "):
                    event = line[7:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
                elif line.startswith("id: "):
                    eid = line[4:]
                elif line == "" and event:
                    out.put((event, data, eid))
                    event, data, eid = None, None, None


def _wait_for(q: queue.Queue, kind: str, timeout: float = 10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            item = q.get(timeout=max(0.05, deadline - time.time()))
        except queue.Empty:
            break
        if item[0] == kind:
            return item
    raise AssertionError(f"no {kind!r} event within {timeout}s")


def test_webhook_to_live_dashboard(live_server):
    dash = _signed_in(live_server)
    channel = dash.get("/api/app/channels").json()["channels"][0]
    created = dash.post("/api/app/webhooks", json={"name": "Agent", "channel_id": channel["id"]}).json()
    url, secret = created["webhook"]["url"], created["secret"]
    assert url.startswith(live_server)

    events: queue.Queue = queue.Queue()
    stop = threading.Event()
    t = threading.Thread(target=_read_events, args=(live_server, dash.cookies, events, stop), daemon=True)
    t.start()
    assert _wait_for(events, "status")[1] == 200
    _wait_for(events, "hello")

    # An external app: separate client, no cookies, only the URL and secret.
    r = httpx.post(url, headers={"Authorization": f"Bearer {secret}"},
                   json={"title": "Agent Update", "message": "The task has completed successfully.",
                         "status": "success"})
    assert r.status_code == 201, r.text
    _, data, first_id = _wait_for(events, "message.created")
    msg = data["message"]
    assert msg["id"] == r.json()["message"]["id"] and msg["embeds"][0]["description"].startswith("The task")
    assert msg["channel_id"] == channel["id"] and msg["status"] == "success"
    assert dash.get("/api/app/messages").json()["messages"][0]["id"] == msg["id"]
    stop.set()

    # Disconnected: two messages arrive while no tab is listening.
    for text in ("missed one", "missed two"):
        assert httpx.post(url, headers={"Authorization": f"Bearer {secret}"}, json={"message": text}).status_code == 201

    # Reconnect with Last-Event-ID, as EventSource does: the missed messages are replayed in order.
    replay: queue.Queue = queue.Queue()
    stop2 = threading.Event()
    threading.Thread(target=_read_events, args=(live_server, dash.cookies, replay, stop2, first_id),
                     daemon=True).start()
    got = [_wait_for(replay, "message.created")[1]["message"]["content"] for _ in range(2)]
    assert got == ["missed one", "missed two"]
    stop2.set()


def test_stream_requires_session_and_rejects_bad_secret(live_server):
    assert httpx.get(f"{live_server}/api/app/stream").status_code == 401
    dash = _signed_in(live_server)
    channel = dash.get("/api/app/channels").json()["channels"][0]
    hook = dash.post("/api/app/webhooks", json={"name": "A", "channel_id": channel["id"]}).json()["webhook"]
    r = httpx.post(hook["url"], headers={"Authorization": "Bearer rls_guess"}, json={"message": "x"})
    assert r.status_code == 401
    assert dash.get("/api/app/messages").json()["messages"] == []
