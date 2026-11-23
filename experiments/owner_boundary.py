"""Offline authorization experiment; never imported by the POS server.

The injected verifier is a *trusted server-side component*. It must verify a
credential's signature, issuer, audience, validity and revocation as required
by its provider. This file contains no credential verifier or login flow.
It must not be used as an Internet-facing security boundary.
"""
from dataclasses import dataclass
import math
import re
from time import time
from urllib.parse import urlsplit


@dataclass(frozen=True)
class VerifiedIdentity:
    issuer: str
    subject: str
    audience: str
    expires_at: float


@dataclass(frozen=True)
class OwnerPolicy:
    issuer: str
    subject: str
    audience: str
    origin: str

    def __post_init__(self):
        if not all(isinstance(value, str) and value.strip() == value and value for value in
                   (self.issuer, self.subject, self.audience, self.origin)):
            raise ValueError("All owner policy values are required")
        parsed = urlsplit(self.origin)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment or parsed.netloc != parsed.netloc.lower()):
            raise ValueError("Origin must be an exact HTTPS origin")


def allow_request(method, headers, policy, verifier, now=time):
    """Fail closed. `headers` must retain duplicate values via get_all()."""
    if not isinstance(policy, OwnerPolicy) or not callable(verifier):
        return False
    if method not in ("GET", "POST"):
        return False
    try:
        origins = headers.get_all("Origin", [])
        if len(origins) > 1 or (origins and origins[0] != policy.origin):
            return False
        if method != "GET" and origins != [policy.origin]:
            return False
        authorization = headers.get_all("Authorization", [])
        if len(authorization) != 1 or len(authorization[0]) > 8192:
            return False
        match = re.fullmatch(r"Bearer ([A-Za-z0-9._~-]+)", authorization[0])
        if not match:
            return False
        identity = verifier(match.group(1))
        if not isinstance(identity, VerifiedIdentity):
            return False
        expiry = identity.expires_at
        if isinstance(expiry, bool) or not isinstance(expiry, (float, int)) or not math.isfinite(expiry):
            return False
        return (identity.issuer == policy.issuer and identity.subject == policy.subject
                and identity.audience == policy.audience and expiry > now())
    except Exception:
        return False


def handle_experiment(method, path, headers, body, policy, verifier, backend, now=time):
    """Test-only pipeline: deny before the backend for every route and method."""
    if not allow_request(method, headers, policy, verifier, now):
        return 403, b"Forbidden"
    return backend(method, path, body)
