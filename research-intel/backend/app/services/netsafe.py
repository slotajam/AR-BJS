"""SSRF-resistant HTTP fetching for user- or provider-supplied URLs.

* Only http/https on default ports (80/443).
* Every hostname is resolved and *all* resulting addresses must be public.
* Redirects are followed manually; each hop is re-validated.
* The connection is pinned to the validated IP to defeat DNS rebinding.
* Response size is capped while streaming.
"""

import ipaddress
import socket
import time
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from app.config import get_settings
from app.connectors.base import parse_retry_after


class UnsafeURL(Exception):
    pass


class FetchError(Exception):
    def __init__(self, message: str, *, retryable: bool = False, retry_after: float | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after


@dataclass
class FetchResult:
    final_url: str
    status_code: int
    content_type: str | None
    body: bytes
    redirects: list[str]



def _default_resolver(host: str) -> list[str]:
    try:
        return list({ai[4][0] for ai in socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)})
    except socket.gaierror as e:
        raise UnsafeURL(f"DNS resolution failed for {host}: {e}") from e


# Overridable hooks (tests inject a mock transport / resolver here).
RESOLVER = _default_resolver
TRANSPORT: httpx.BaseTransport | None = None


def is_public_ip(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return not (
        addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
        or addr.is_reserved or addr.is_unspecified or not addr.is_global
    )


def validate_url(url: str, resolver=None) -> tuple[str, str]:
    """Return (host, pinned_ip) or raise UnsafeURL."""
    resolver = resolver or RESOLVER
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise UnsafeURL(f"scheme not allowed: {parts.scheme!r}")
    if parts.username or parts.password:
        raise UnsafeURL("credentials in URL are not allowed")
    host = (parts.hostname or "").lower()
    if not host:
        raise UnsafeURL("missing host")
    if parts.port not in (None, 80, 443):
        raise UnsafeURL(f"port not allowed: {parts.port}")
    allow = {h.lower() for h in get_settings().ssrf_allow_hosts}
    try:
        ipaddress.ip_address(host)
        ips = [host]
    except ValueError:
        ips = resolver(host)
    if not ips:
        raise UnsafeURL(f"no addresses for {host}")
    if host not in allow:
        bad = [ip for ip in ips if not is_public_ip(ip)]
        if bad:
            raise UnsafeURL(f"{host} resolves to non-public address {bad[0]}")
    return host, ips[0]


def safe_get(
    url: str,
    *,
    max_bytes: int | None = None,
    max_redirects: int | None = None,
    timeout: float | None = None,
    resolver=None,
    transport: httpx.BaseTransport | None = None,
    accept: str = "application/pdf",
) -> FetchResult:
    s = get_settings()
    resolver = resolver or RESOLVER
    transport = transport or TRANSPORT
    max_bytes = max_bytes or s.pdf_max_bytes
    max_redirects = s.pdf_max_redirects if max_redirects is None else max_redirects
    timeout = timeout or s.http_timeout_seconds
    redirects: list[str] = []
    current = url
    started = time.monotonic()
    for _ in range(max_redirects + 1):
        host, ip = validate_url(current, resolver)
        parts = urlsplit(current)
        # Pin connection to the validated IP; keep Host header + SNI for the original name.
        pinned = current
        extensions = {}
        if transport is None and parts.hostname != ip:
            netloc = f"[{ip}]" if ":" in ip else ip
            if parts.port:
                netloc += f":{parts.port}"
            pinned = parts._replace(netloc=netloc).geturl()
            extensions = {"sni_hostname": host}
        headers = {"Host": parts.netloc.rsplit("@", 1)[-1], "Accept": accept,
                   "User-Agent": "ResearchIntelPlatform/0.1 (+rights-aware PDF fetch)"}
        with httpx.Client(timeout=timeout, follow_redirects=False, transport=transport) as client:
            try:
                req = client.build_request("GET", pinned, headers=headers, extensions=extensions)
                resp = client.send(req, stream=True)
            except httpx.TimeoutException as e:
                raise FetchError(f"timeout fetching {current}", retryable=True) from e
            except httpx.TransportError as e:
                raise FetchError(f"transport error fetching {current}: {e}", retryable=True) from e
            try:
                if resp.status_code in (301, 302, 303, 307, 308):
                    loc = resp.headers.get("Location")
                    if not loc:
                        raise FetchError("redirect without Location")
                    current = urljoin(current, loc)
                    redirects.append(current)
                    continue
                if resp.status_code == 429 or resp.status_code >= 500:
                    raise FetchError(
                        f"HTTP {resp.status_code}", retryable=True,
                        retry_after=parse_retry_after(resp.headers.get("Retry-After")),
                    )
                if resp.status_code in (401, 402, 403):
                    raise FetchError(f"HTTP {resp.status_code}: access controlled; not bypassed")
                if resp.status_code >= 400:
                    raise FetchError(f"HTTP {resp.status_code}")
                declared = resp.headers.get("Content-Length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise FetchError(f"file too large ({declared} bytes)")
                buf = bytearray()
                for chunk in resp.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        raise FetchError(f"file exceeds {max_bytes} bytes")
                    if time.monotonic() - started > timeout * 6:
                        raise FetchError("download exceeded total time budget", retryable=True)
                return FetchResult(current, resp.status_code, resp.headers.get("Content-Type"), bytes(buf),
                                   redirects)
            finally:
                resp.close()
    raise FetchError(f"too many redirects (> {max_redirects})")
