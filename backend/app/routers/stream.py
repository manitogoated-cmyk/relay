"""Live updates over Server-Sent Events. The browser's EventSource reconnects on its own and sends
Last-Event-ID; events still in memory are replayed, otherwise the client is told to resync."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse

from ..broker import broker
from ..db import session_factory
from ..deps import ApiError, _session_from_cookie

router = APIRouter(prefix="/api/app", tags=["stream"])

HEARTBEAT_SECONDS = 15.0
SESSION_RECHECK_SECONDS = 60.0


def _user_id(request: Request) -> int | None:
    db = session_factory()()
    try:
        sess = _session_from_cookie(request, db)
        return sess.user_id if sess else None
    finally:
        db.close()


@router.get("/stream")
async def stream(request: Request):
    user_id = await run_in_threadpool(_user_id, request)
    if user_id is None:
        raise ApiError(401, "not_signed_in", "Sign in to continue.")

    last_id_header = request.headers.get("last-event-id") or request.query_params.get("last_event_id")
    queue = broker.subscribe(user_id)

    async def events():
        try:
            yield "retry: 3000\n\n"
            yield f"event: hello\ndata: {json.dumps({'connections': broker.subscriber_count(user_id)})}\n\n"
            if last_id_header and last_id_header.isdigit():
                missed = broker.replay_since(user_id, int(last_id_header))
                if missed is None:
                    yield "event: resync\ndata: {}\n\n"
                else:
                    for ev in missed:
                        yield ev.encode()
            loop = asyncio.get_running_loop()
            next_check = loop.time() + SESSION_RECHECK_SECONDS
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    if await request.is_disconnected():
                        return
                    yield ": keep-alive\n\n"
                    ev = False
                if ev is None:  # server shutting down
                    return
                if ev:
                    yield ev.encode()
                if loop.time() >= next_check:
                    next_check = loop.time() + SESSION_RECHECK_SECONDS
                    if await run_in_threadpool(_user_id, request) != user_id:
                        yield "event: signed_out\ndata: {}\n\n"
                        return
        finally:
            broker.unsubscribe(user_id, queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )
