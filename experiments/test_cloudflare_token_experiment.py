"""Real RS256 signatures over synthetic claims; no real account or network."""
from copy import deepcopy
from email.message import Message
import json
from time import time
from unittest import TestCase
from unittest.mock import Mock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from experiments.cloudflare_token_experiment import AccessTokenVerifier
from experiments.owner_boundary import OwnerPolicy, handle_experiment


class AccessTokenExperimentTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.first = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.second = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.jwk1 = cls.as_jwk(cls.first, "key-one")
        cls.jwk2 = cls.as_jwk(cls.second, "key-two")

    @staticmethod
    def as_jwk(key, kid):
        result = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
        return {**result, "kid": kid, "use": "sig", "alg": "RS256"}

    def setUp(self):
        self.issuer = "https://test-team.cloudflareaccess.com"
        self.policy = OwnerPolicy(self.issuer, "owner-123", "test-aud", "https://pos.example")
        self.claims = {"iss": self.issuer, "aud": "test-aud", "sub": "owner-123", "nbf": int(time()) - 30, "exp": int(time()) + 300}
        self.backend = Mock(return_value=(200, b"synthetic"))

    def verifier(self, keys):
        return AccessTokenVerifier(self.issuer, "test-aud", "owner-123", {"keys": keys})

    def token(self, key=None, claims=None, kid="key-one"):
        return jwt.encode(self.claims if claims is None else claims, key or self.first, algorithm="RS256", headers={"kid": kid})

    def send(self, token, verifier, method="GET", path="/database-backup", origin="https://pos.example"):
        headers = Message()
        headers["Authorization"] = "Bearer " + token
        if origin is not None:
            headers["Origin"] = origin
        return handle_experiment(method, path, headers, b"synthetic", self.policy, verifier, self.backend)

    def test_signed_owner_reaches_fake_read_write_and_backup(self):
        verifier = self.verifier([self.jwk1])
        for method, path in (("GET", "/products"), ("POST", "/sales"), ("GET", "/database-backup")):
            self.assertEqual(self.send(self.token(), verifier, method, path), (200, b"synthetic"))
        self.assertEqual(self.backend.call_count, 3)

    def test_tampered_signature_wrong_claims_and_cross_origin_are_denied(self):
        verifier = self.verifier([self.jwk1])
        tokens = [self.token(key=self.other), self.token(kid="unknown"), "not-a-jwt"]
        for field, value in (("iss", "https://other.cloudflareaccess.com"), ("aud", "other"),
                             ("sub", "other"), ("exp", int(time()) - 10), ("nbf", int(time()) + 300),
                             ("exp", "9999999999"), ("nbf", True)):
            claims = dict(self.claims, **{field: value})
            tokens.append(self.token(claims=claims))
        for field in ("iss", "aud", "sub", "exp", "nbf"):
            claims = dict(self.claims)
            del claims[field]
            tokens.append(self.token(claims=claims))
        tokens.append(jwt.encode(self.claims, "x" * 64, algorithm="HS256", headers={"kid": "key-one"}))
        tokens.append(jwt.encode(self.claims, self.first, algorithm="RS256", headers={"kid": "key-one", "jku": "https://evil.example/keys"}))
        for token in tokens:
            with self.subTest(token=token[:20]):
                self.assertEqual(self.send(token, verifier)[0], 403)
        self.assertEqual(self.send(self.token(), verifier, "POST", "/sales", "https://evil.example")[0], 403)
        self.backend.assert_not_called()

    def test_rotation_uses_only_each_explicit_local_snapshot(self):
        first = self.verifier([self.jwk1])
        overlap = self.verifier([self.jwk1, self.jwk2])
        rotated = self.verifier([self.jwk2])
        one, two = self.token(), self.token(key=self.second, kid="key-two")
        self.assertIsNotNone(first(one))
        self.assertIsNone(first(two))
        self.assertIsNotNone(overlap(one))
        self.assertIsNotNone(overlap(two))
        self.assertIsNone(rotated(one))
        self.assertIsNotNone(rotated(two))

    def test_cloudflare_response_extra_cert_fields_are_ignored(self):
        verifier = AccessTokenVerifier(self.issuer, "test-aud", "owner-123", {
            "keys": [self.jwk1], "public_cert": {"kid": "unused", "cert": "not-a-key"},
            "public_certs": [{"kid": "other", "cert": "not-a-key"}],
        })
        self.assertIsNotNone(verifier(self.token()))
        self.assertIsNone(verifier(self.token(key=self.second, kid="other")))

    def test_bad_snapshots_and_remote_key_sources_fail_closed(self):
        duplicate = deepcopy(self.jwk1)
        invalids = ([], [self.jwk1, duplicate], [{**self.jwk1, "kty": "oct"}],
                    [{**self.jwk1, "d": "private"}], [{**self.jwk1, "alg": "HS256"}])
        for keys in invalids:
            with self.subTest(keys=len(keys)), self.assertRaises(ValueError):
                self.verifier(keys)
        for issuer in ("http://test-team.cloudflareaccess.com", "https://test-team.cloudflareaccess.com.evil.example",
                       "https://test-team.cloudflareaccess.com/path", "https://127.0.0.1"):
            with self.subTest(issuer=issuer), self.assertRaises(ValueError):
                AccessTokenVerifier(issuer, "test-aud", "owner-123", {"keys": [self.jwk1]})
        with self.assertRaises(ValueError):
            AccessTokenVerifier(self.issuer, "test-aud", "owner-123", {"url": "http://127.0.0.1"})
