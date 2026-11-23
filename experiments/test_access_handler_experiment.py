"""Real POS HTTP handler + temporary SQLite, synthetic signatures, no sockets."""
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory
from time import time
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4
import json

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

import inventory_api as api
from experiments.access_handler_experiment import ExperimentalAccessHandler, MemoryTransport
from experiments.cloudflare_token_experiment import AccessTokenVerifier
from experiments.owner_boundary import OwnerPolicy


class AccessHandlerExperimentTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key1 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.key2 = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.jwk1 = cls.jwk(cls.key1, "key-one")
        cls.jwk2 = cls.jwk(cls.key2, "key-two")

    @staticmethod
    def jwk(key, kid):
        return {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())), "kid": kid, "alg": "RS256", "use": "sig"}

    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "synthetic.sqlite3"
        with closing(api.connect(self.database)) as db:
            for schema in (api.SALES_SCHEMA, api.DEBT_SCHEMA, api.CORRECTION_SCHEMA, api.COUNT_SCHEMA,
                           api.EXPENSE_SCHEMA, api.DRAWER_SCHEMA, api.BINDING_SCHEMA):
                db.executescript(schema)
            db.execute("INSERT OR IGNORE INTO store_identity (singleton, id) VALUES (1, ?)", (str(uuid4()),))
            api.ensure_binding(db)
        self.issuer = "https://test-team.cloudflareaccess.com"
        self.policy = OwnerPolicy(self.issuer, "test-owner", "test-aud", "https://pos.example")
        self.verifier = self.make_verifier([self.jwk1])
        self.shell = api.checkout_shell()

    def make_verifier(self, keys):
        return AccessTokenVerifier("https://test-team.cloudflareaccess.com", "test-aud", "test-owner", {"keys": keys})

    def token(self, key=None, kid="key-one", **changes):
        claims = {"iss": self.issuer, "aud": "test-aud", "sub": "test-owner", "nbf": int(time()) - 30, "exp": int(time()) + 300}
        claims.update(changes)
        return jwt.encode(claims, key or self.key1, algorithm="RS256", headers={"kid": kid})

    def request(self, method, target, headers=(), body=b"", verifier=None, peer="127.0.0.1"):
        header_lines = [f"{name}: {value}\r\n" for name, value in headers]
        raw = (f"{method} {target} HTTP/1.1\r\n" + "".join(header_lines)
               + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode("ascii") + body
        transport = MemoryTransport(raw)
        server = SimpleNamespace(server_port=8765, test_owner_policy=self.policy,
                                 test_token_verifier=self.verifier if verifier is None else verifier)
        ExperimentalAccessHandler(transport, (peer, 12345), server, database=self.database, shell=self.shell)
        head, _, data = bytes(transport.sent).partition(b"\r\n\r\n")
        return int(head.split(b" ", 2)[1]), data

    def good_headers(self, token=None):
        return [("Host", "localhost:8765"), ("Cf-Access-Jwt-Assertion", token or self.token()), ("Origin", "https://pos.example")]

    def test_unsigned_spoofed_and_missing_assertions_never_reach_assets_or_database(self):
        headers = [("Host", "localhost:8765"), ("Authorization", "Bearer " + self.token()),
                   ("X-Owner", "test-owner"), ("X-Forwarded-User", "test-owner"), ("X-POS-Store-ID", "test-owner")]
        routes = [("GET", path) for path in api.WEB_ASSETS] + [
            ("GET", "/products"), ("GET", "/database-backup"), ("GET", "/payment-qr?amount=1"),
            ("POST", "/sales"), ("POST", "/products"), ("POST", "/customers")]
        with patch("inventory_api.connect", side_effect=AssertionError("must not access database")), \
             patch.object(ExperimentalAccessHandler, "serve_asset", side_effect=AssertionError("must not serve asset")), \
             patch.object(ExperimentalAccessHandler, "send_database_backup", side_effect=AssertionError("must not back up")):
            for method, path in routes:
                with self.subTest(method=method, path=path):
                    self.assertEqual(self.request(method, path, headers)[0], 403)

    def test_real_handler_reads_writes_assets_and_backup_only_with_signed_owner(self):
        headers = self.good_headers()
        self.assertEqual(self.request("GET", "/checkout", headers)[0], 200)
        self.assertEqual(self.request("GET", "/products", headers)[0], 200)
        body = json.dumps({"code": "TEST", "name": "Synthetic", "base_unit": "piece", "price": "1"}).encode()
        self.assertEqual(self.request("POST", "/products", headers + [("Content-Type", "application/json")], body)[0], 201)
        status, backup = self.request("GET", "/database-backup", headers)
        self.assertEqual(status, 200)
        self.assertTrue(backup.startswith(b"SQLite format 3\x00"))

    def test_token_claims_tampering_rotation_and_verifier_failure_deny(self):
        bad_tokens = [self.token(key=self.key2), self.token(sub="other"), self.token(aud="other"),
                      self.token(iss="https://other.cloudflareaccess.com"), self.token(exp=int(time()) - 1),
                      self.token(nbf=int(time()) + 300)]
        for token in bad_tokens:
            with self.subTest(token=token[:20]), patch("inventory_api.connect", side_effect=AssertionError("database reached")):
                self.assertEqual(self.request("GET", "/products", self.good_headers(token))[0], 403)
        token2 = self.token(key=self.key2, kid="key-two")
        self.assertEqual(self.request("GET", "/products", self.good_headers(token2))[0], 403)
        overlap = self.make_verifier([self.jwk1, self.jwk2])
        self.assertEqual(self.request("GET", "/products", self.good_headers(token2), verifier=overlap)[0], 200)
        rotated = self.make_verifier([self.jwk2])
        self.assertEqual(self.request("GET", "/products", self.good_headers(), verifier=rotated)[0], 403)
        self.assertEqual(self.request("GET", "/products", self.good_headers(), verifier=lambda token: None)[0], 403)

    def test_host_origin_path_and_duplicate_headers_fail_closed(self):
        good = self.good_headers()
        cases = [
            ("POST", "/products", good[:-1]),
            ("POST", "/products", good[:-1] + [("Origin", "https://evil.example")]),
            ("POST", "/products", good[:-1] + [("Origin", "null")]),
            ("GET", "/checkout", good + [("Origin", "https://evil.example")]),
            ("GET", "/checkout", good + [("Origin", "https://pos.example")]),
            ("GET", "/checkout", good + [("Cf-Access-Jwt-Assertion", self.token())]),
            ("GET", "/checkout", good + [("Host", "evil.example")]),
            ("GET", "/checkout", good[1:]),
            ("GET", "/checkout", [("Host", "evil.example"), *good[1:]]),
            ("GET", "http://evil.example/checkout", good),
            ("GET", "/../checkout", good),
            ("GET", "/%2e%2e/checkout", good),
            ("OPTIONS", "/products", good),
        ]
        for method, path, headers in cases:
            with self.subTest(method=method, path=path, headers=len(headers)):
                self.assertEqual(self.request(method, path, headers)[0], 403)
        self.assertEqual(self.request("GET", "/checkout", good, peer="192.0.2.1")[0], 403)

    def test_cannot_instantiate_with_real_socket_or_missing_verifier(self):
        with self.assertRaises(TypeError):
            ExperimentalAccessHandler(object(), ("127.0.0.1", 1), SimpleNamespace(server_port=8765), database=self.database, shell=self.shell)
        self.assertEqual(self.request("GET", "/products", self.good_headers(), verifier=False)[0], 403)
