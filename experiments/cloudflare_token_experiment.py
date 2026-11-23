"""Offline Access JWT verification experiment; not used by the POS server.

Only locally supplied JWKS snapshots are accepted. No network, discovery,
authentication flow, session, revocation or production integration is present.
"""
import math
import re

import jwt

from experiments.owner_boundary import VerifiedIdentity


class AccessTokenVerifier:
    def __init__(self, issuer, audience, owner_subject, jwks):
        if not isinstance(issuer, str) or not re.fullmatch(r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com", issuer):
            raise ValueError("An exact Access issuer is required")
        if not all(isinstance(value, str) and value and value.strip() == value for value in (audience, owner_subject)):
            raise ValueError("An audience and owner subject are required")
        if not isinstance(jwks, dict) or not isinstance(jwks.get("keys"), list) or not 1 <= len(jwks["keys"]) <= 10:
            raise ValueError("A bounded local JWKS snapshot is required")
        keys = {}
        for data in jwks["keys"]:
            if not isinstance(data, dict):
                raise ValueError("Invalid JWK")
            kid = data.get("kid")
            if (not isinstance(kid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", kid)
                    or kid in keys or data.get("kty") != "RSA" or data.get("use", "sig") != "sig"
                    or data.get("alg", "RS256") != "RS256" or any(name in data for name in ("d", "p", "q", "dp", "dq", "qi", "oth"))):
                raise ValueError("Invalid or duplicate public signing key")
            try:
                key = jwt.PyJWK.from_dict(dict(data), algorithm="RS256").key
                if key.key_size < 2048:
                    raise ValueError("RSA key is too small")
            except Exception as exc:
                raise ValueError("Invalid RSA signing key") from exc
            keys[kid] = key
        self._issuer, self._audience, self._subject, self._keys = issuer, audience, owner_subject, keys

    def knows_key(self, kid):
        return isinstance(kid, str) and kid in self._keys

    def __call__(self, token):
        if not isinstance(token, str) or not 1 <= len(token) <= 8192:
            return None
        try:
            header = jwt.get_unverified_header(token)
            if (not isinstance(header, dict) or not set(header).issubset({"alg", "kid", "typ"})
                    or header.get("alg") != "RS256" or header.get("typ", "JWT") != "JWT"
                    or not isinstance(header.get("kid"), str)):
                return None
            key = self._keys.get(header["kid"])
            if key is None:
                return None
            claims = jwt.decode(token, key=key, algorithms=["RS256"], issuer=self._issuer,
                                audience=self._audience,
                                options={"require": ["iss", "aud", "sub", "exp", "nbf"]})
            for name in ("exp", "nbf"):
                value = claims[name]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    return None
            if claims["sub"] != self._subject:
                return None
            return VerifiedIdentity(self._issuer, self._subject, self._audience, claims["exp"])
        except Exception:
            return None
