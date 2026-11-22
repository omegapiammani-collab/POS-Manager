"""Opt-in local test adapter; not a deployable remote access configuration.

The server still binds loopback. No tunnel, login, trusted proxy, session
revocation or production account setup is provided by this module.
"""
from email.message import Message
import time
from urllib.parse import urlsplit

from experiments.cloudflare_jwks_experiment import PinnedAccessKeys, RotatingAccessVerifier
from experiments.owner_boundary import OwnerPolicy, allow_request


class OwnerAccessAdapter:
    def __init__(self, issuer, audience, owner_subject, origin, *, _clock=time.monotonic):
        self._policy = OwnerPolicy(issuer, owner_subject, audience, origin)
        self._keys = PinnedAccessKeys(issuer)
        self._verifier = RotatingAccessVerifier(issuer, audience, owner_subject, self._keys, clock=_clock)

    def authorize(self, method, target, request_headers):
        """Verify an Access assertion before any asset, backup, or API route."""
        try:
            parsed = urlsplit(target)
            path = parsed.path
            if (parsed.scheme or parsed.netloc or parsed.fragment or not path.startswith("/")
                    or path.startswith("//") or "\\" in path or "%" in path
                    or any(ord(char) < 32 or ord(char) == 127 for char in target)
                    or any(part in (".", "..") for part in path.split("/"))):
                return False
            assertions = request_headers.get_all("Cf-Access-Jwt-Assertion", [])
            if len(assertions) != 1:
                return False
            headers = Message()
            headers["Authorization"] = "Bearer " + assertions[0]
            for origin in request_headers.get_all("Origin", []):
                headers["Origin"] = origin
            return allow_request(method, headers, self._policy, self._verifier)
        except Exception:
            return False
