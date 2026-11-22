"""Experimental pinned Access key retrieval. Not imported by the POS server.

No user-controlled URL, proxy, redirect, stale cache fallback or production
integration. Real provider, revocation and operational tests remain necessary.
"""
import http.client
import ipaddress
import json
import re
import socket
import ssl
import threading
import time

import jwt

from experiments.cloudflare_token_experiment import AccessTokenVerifier


ISSUER = re.compile(r"https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com)")
CERT_PATH = "/cdn-cgi/access/certs"
MAX_BYTES = 65536


def public_addresses(records):
    addresses = []
    for record in records:
        address = record[4][0]
        try:
            if not ipaddress.ip_address(address).is_global:
                raise ValueError("Non-public DNS result")
        except (TypeError, ValueError) as exc:
            raise ValueError("Non-public DNS result") from exc
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise ValueError("No public DNS result")
    return addresses


class _PinnedConnection(http.client.HTTPSConnection):
    def connect(self):
        addresses = public_addresses(socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM))
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Key request timed out during DNS")
        raw = socket.create_connection((addresses[0], 443), timeout=min(self.timeout, remaining))
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


class PinnedAccessKeys:
    """Fetch only the configured Access cert path using direct verified TLS."""
    def __init__(self, issuer, timeout=5):
        match = ISSUER.fullmatch(issuer) if isinstance(issuer, str) else None
        if not match or not isinstance(timeout, (int, float)) or not 0 < timeout <= 10:
            raise ValueError("Invalid Access issuer or timeout")
        self._host, self._timeout = match.group(1), timeout
        self._inflight = threading.Lock()

    def fetch(self):
        # DNS can ignore socket timeouts. One bounded daemon worker prevents a
        # stuck resolver from creating unbounded threads or blocking callers.
        if not self._inflight.acquire(blocking=False):
            raise TimeoutError("Key request already running")
        done, result = threading.Event(), []
        deadline = time.monotonic() + self._timeout

        def worker():
            connection = None
            try:
                context = ssl.create_default_context()
                connection = _PinnedConnection(self._host, port=443, timeout=self._timeout, context=context)
                connection.deadline = deadline
                connection.request("GET", CERT_PATH, headers={"Accept": "application/json", "Accept-Encoding": "identity"})
                if time.monotonic() >= deadline:
                    raise TimeoutError("Key request timed out")
                response = connection.getresponse()
                if response.status != 200 or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                    raise ValueError("Invalid key response")
                if response.getheader("Content-Encoding", "identity").lower() != "identity":
                    raise ValueError("Compressed key responses are unsupported")
                length = response.getheader("Content-Length")
                if length is not None and (not length.isdecimal() or int(length) > MAX_BYTES):
                    raise ValueError("Key response too large")
                body = response.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES or time.monotonic() >= deadline:
                    raise ValueError("Key response invalid or timed out")
                def unique_object(pairs):
                    obj = {}
                    for name, value in pairs:
                        if name in obj:
                            raise ValueError("Duplicate JSON key")
                        obj[name] = value
                    return obj
                result.append((True, json.loads(body, object_pairs_hook=unique_object)))
            except Exception as exc:
                result.append((False, exc))
            finally:
                if connection is not None:
                    connection.close()
                self._inflight.release()
                done.set()

        threading.Thread(target=worker, daemon=True).start()
        if not done.wait(self._timeout):
            raise TimeoutError("Key request timed out")
        if not result[0][0]:
            raise ValueError("Unable to retrieve verified Access keys") from result[0][1]
        return result[0][1]


class RotatingAccessVerifier:
    """Short-lived key cache; unknown kid refreshes are throttled and fail closed."""
    def __init__(self, issuer, audience, owner_subject, source, ttl=300, cooldown=30, clock=time.monotonic):
        if not ISSUER.fullmatch(issuer) or not callable(getattr(source, "fetch", None)):
            raise ValueError("Invalid issuer or source")
        if not 0 < cooldown <= ttl <= 300:
            raise ValueError("Invalid cache limits")
        self._issuer, self._audience, self._subject = issuer, audience, owner_subject
        self._source, self._ttl, self._cooldown, self._clock = source, ttl, cooldown, clock
        self._last_attempt, self._expires, self._verifier = float("-inf"), 0, None
        self._lock = threading.Lock()

    def __call__(self, token):
        if not isinstance(token, str) or not 1 <= len(token) <= 8192:
            return None
        try:
            header = jwt.get_unverified_header(token)
            kid = header.get("kid")
            if header.get("alg") != "RS256" or not isinstance(kid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", kid):
                return None
        except Exception:
            return None
        with self._lock:
            now = self._clock()
            needs_refresh = self._verifier is None or now >= self._expires or not self._verifier.knows_key(kid)
            if needs_refresh:
                if now - self._last_attempt < self._cooldown:
                    return None
                self._last_attempt = now
                self._verifier, self._expires = None, 0
                try:
                    snapshot = self._source.fetch()
                    self._verifier = AccessTokenVerifier(self._issuer, self._audience, self._subject, snapshot)
                    self._expires = self._clock() + self._ttl
                except Exception:
                    return None
            return self._verifier(token)
