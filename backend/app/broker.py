"""Fan-out of live events to each user's open dashboard tabs (Server-Sent Events).

Events live in memory: one process (the default deployment) sees every event. Running several
workers would need a shared bus such as Redis pub/sub; see docs/DEPLOYMENT.md.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any


@dataclass
class Event:
    id: int
    owner_id: int
    type: str
    data: dict[str, Any]

    def encode(self) -> str:
        return f"id: {self.id}\nevent: {self.type}\ndata: {json.dumps(self.data, default=str)}\n\n"


class Broker:
    def __init__(self, history: int = 500, queue_size: int = 256) -> None:
        self._subs: dict[int, set[asyncio.Queue[Event | None]]] = {}
        self._history: deque[Event] = deque(maxlen=history)
        self._seq = itertools.count(1)
        self._lock = threading.Lock()
        self._queue_size = queue_size
        self.loop: asyncio.AbstractEventLoop | None = None

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop

    def subscribe(self, owner_id: int) -> asyncio.Queue[Event | None]:
        q: asyncio.Queue[Event | None] = asyncio.Queue(maxsize=self._queue_size)
        self._subs.setdefault(owner_id, set()).add(q)
        return q

    def unsubscribe(self, owner_id: int, q: asyncio.Queue) -> None:
        subs = self._subs.get(owner_id)
        if subs:
            subs.discard(q)
            if not subs:
                self._subs.pop(owner_id, None)

    def subscriber_count(self, owner_id: int | None = None) -> int:
        if owner_id is None:
            return sum(len(s) for s in self._subs.values())
        return len(self._subs.get(owner_id, ()))

    def replay_since(self, owner_id: int, last_id: int) -> list[Event] | None:
        """Events after `last_id`, or None if the history no longer reaches back that far."""
        with self._lock:
            events = [e for e in self._history if e.owner_id == owner_id]
            oldest = self._history[0].id if self._history else None
        if oldest is not None and last_id < oldest - 1:
            return None
        return [e for e in events if e.id > last_id]

    def publish(self, owner_id: int, type_: str, data: dict[str, Any]) -> None:
        """Safe to call from the event loop or from a worker thread."""
        with self._lock:
            event = Event(next(self._seq), owner_id, type_, data)
            self._history.append(event)
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self._deliver(event)
        else:
            loop.call_soon_threadsafe(self._deliver, event)

    def _deliver(self, event: Event) -> None:
        for q in list(self._subs.get(event.owner_id, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # A stalled client: tell it to resync instead of blocking everyone else.
                while not q.empty():
                    q.get_nowait()
                q.put_nowait(Event(event.id, event.owner_id, "resync", {}))

    def close_all(self) -> None:
        for subs in self._subs.values():
            for q in subs:
                try:
                    q.put_nowait(None)
                except asyncio.QueueFull:
                    pass


broker = Broker()
