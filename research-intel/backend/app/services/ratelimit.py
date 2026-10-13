"""Failed-login throttling.

Counts failed logins per (email) and per (client IP) in a fixed window. Redis is used so
limits hold across API processes; if Redis is unreachable an in-process counter is used
(single-process dev / tests) rather than failing open silently.
"""

import time
from threading import Lock

import redis

from app.config import get_settings


class _Memory:
    def __init__(self):
        self._d: dict[str, tuple[int, float]] = {}
        self._lock = Lock()

    def incr(self, key: str, window: int) -> int:
        now = time.monotonic()
        with self._lock:
            count, expires = self._d.get(key, (0, now + window))
            if now >= expires:
                count, expires = 0, now + window
            count += 1
            self._d[key] = (count, expires)
            return count

    def get(self, key: str) -> int:
        with self._lock:
            count, expires = self._d.get(key, (0, 0.0))
            return count if time.monotonic() < expires else 0

    def delete(self, key: str) -> None:
        with self._lock:
            self._d.pop(key, None)


class _Redis:
    def __init__(self, url: str):
        self.r = redis.Redis.from_url(url, socket_timeout=1, socket_connect_timeout=1)

    def incr(self, key: str, window: int) -> int:
        pipe = self.r.pipeline()
        pipe.incr(key)
        pipe.expire(key, window, nx=True)
        return int(pipe.execute()[0])

    def get(self, key: str) -> int:
        v = self.r.get(key)
        return int(v) if v else 0

    def delete(self, key: str) -> None:
        self.r.delete(key)


_backend = None


def _store():
    global _backend
    if _backend is None:
        s = get_settings()
        if s.rate_limit_backend == "redis":
            try:
                candidate = _Redis(s.redis_url)
                candidate.r.ping()
                _backend = candidate
            except redis.RedisError:
                _backend = _Memory()
        else:
            _backend = _Memory()
    return _backend


def reset() -> None:
    global _backend
    _backend = None


def _keys(email: str, ip: str | None) -> list[str]:
    keys = [f"rip:login:email:{email.lower()}"]
    if ip:
        keys.append(f"rip:login:ip:{ip}")
    return keys


def login_blocked(email: str, ip: str | None) -> bool:
    s = get_settings()
    st = _store()
    email_key, *ip_key = _keys(email, ip)
    if st.get(email_key) >= s.login_max_failures:
        return True
    # an IP gets a larger budget (many users behind one NAT)
    return bool(ip_key) and st.get(ip_key[0]) >= s.login_max_failures * 5


def record_failure(email: str, ip: str | None) -> None:
    window = get_settings().login_window_seconds
    for k in _keys(email, ip):
        _store().incr(k, window)


def record_success(email: str) -> None:
    _store().delete(_keys(email, None)[0])
