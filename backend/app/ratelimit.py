"""In-process token buckets.

Limits are per process: run one worker (the default) or put a shared limiter in front if you scale out.
"""

from __future__ import annotations

import math
import threading
import time


class TokenBucketLimiter:
    def __init__(self, rate_per_minute: float, burst: int) -> None:
        self.rate = rate_per_minute / 60.0
        self.burst = float(burst)
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()
        self._last_prune = time.monotonic()

    def hit(self, key: str, cost: float = 1.0) -> tuple[bool, int]:
        """Take `cost` tokens. Returns (allowed, retry_after_seconds)."""
        now = time.monotonic()
        with self._lock:
            tokens, stamp = self._buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - stamp) * self.rate)
            if tokens >= cost:
                self._buckets[key] = (tokens - cost, now)
                allowed, retry = True, 0
            else:
                self._buckets[key] = (tokens, now)
                allowed = False
                retry = max(1, math.ceil((cost - tokens) / self.rate)) if self.rate > 0 else 60
            if now - self._last_prune > 300:
                self._prune(now)
        return allowed, retry

    def peek(self, key: str, cost: float = 1.0) -> bool:
        """Whether `cost` tokens are available, without taking them."""
        now = time.monotonic()
        with self._lock:
            tokens, stamp = self._buckets.get(key, (self.burst, now))
        return min(self.burst, tokens + (now - stamp) * self.rate) >= cost

    def _prune(self, now: float) -> None:
        full_after = self.burst / self.rate if self.rate > 0 else 3600
        self._buckets = {k: v for k, v in self._buckets.items() if now - v[1] < full_after}
        self._last_prune = now

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


class Limiters:
    def __init__(self, settings) -> None:
        self.webhook = TokenBucketLimiter(settings.webhook_rate_per_minute, settings.webhook_burst)
        self.ip = TokenBucketLimiter(settings.ip_rate_per_minute, settings.ip_burst)
        self.auth_failures = TokenBucketLimiter(settings.auth_failures_per_minute, settings.auth_failures_per_minute)
        self.login = TokenBucketLimiter(settings.login_attempts_per_5min / 5, settings.login_attempts_per_5min)
