"""End-to-end loopback experiment; synthetic keys, DB and mocked key retrieval."""
from http.client import HTTPConnection
from pathlib import Path
from time import time
from unittest import TestCase
from unittest.mock import patch
import json
import sqlite3

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from experiments.isolated_access_server import isolated_access_server


class IsolatedAccessServerTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = [rsa.generate_private_key(public_exponent=65537, key_size=2048) for _ in range(2)]
        cls.jwks = []
        for index, key in enumerate(cls.keys):
            public = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
            cls.jwks.append({**public, "kid": "key-" + str(index), "use": "sig", "alg": "RS256"})

    def setUp(self):
        self.issuer = "https://test-team.cloudflareaccess.com"
        self.origin = "https://pos.example"
        self.clock = 1000

    def token(self, index=0, **overrides):
        claims = {"iss": self.issuer, "aud": "aud", "sub": "owner", "nbf": int(time()) - 30, "exp": int(time()) + 300}
        claims.update(overrides)
        return jwt.encode(claims, self.keys[index], algorithm="RS256", headers={"kid": "key-" + str(index)})

    def request(self, server, method, path, headers=None, body=None):
        connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        try:
            connection.request(method, path, headers=headers or {}, body=body)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_signed_identity_reaches_pos_and_rotation_outage_fails_closed(self):
        snapshots = [
            {"keys": [self.jwks[0]], "public_cert": {"cert": "ignored"}, "public_certs": []},
            {"keys": self.jwks}, {"keys": [self.jwks[1]]}, OSError("synthetic outage"),
        ]
        with patch("experiments.isolated_access_server.PinnedAccessKeys.fetch", side_effect=snapshots) as fetch:
            with isolated_access_server(self.issuer, "aud", "owner", self.origin, _clock=lambda: self.clock) as server:
                self.assertEqual(server.socket.getsockname()[0], "127.0.0.1")
                database = Path(server.RequestHandlerClass.keywords["database"])
                old = {"Cf-Access-Jwt-Assertion": self.token(), "Origin": self.origin}
                new = {"Cf-Access-Jwt-Assertion": self.token(1), "Origin": self.origin}
                for path in ("/checkout", "/checkout.js", "/products", "/database-backup"):
                    self.assertEqual(self.request(server, "GET", path)[0], 403)
                self.assertEqual(fetch.call_count, 0)
                self.assertEqual(self.request(server, "GET", "/checkout", old)[0], 200)
                self.assertEqual(self.request(server, "GET", "/checkout.js", old)[0], 200)
                self.assertEqual(self.request(server, "GET", "/database-backup", old)[0], 200)
                body = json.dumps({"code": "T", "name": "Synthetic", "base_unit": "piece", "price": "1"})
                write = {**old, "Content-Type": "application/json"}
                self.assertEqual(self.request(server, "POST", "/products", write, body)[0], 201)
                spoof = {"X-Owner": "owner", "Authorization": "Bearer " + self.token(), "Origin": self.origin}
                self.assertEqual(self.request(server, "GET", "/database-backup", spoof)[0], 403)
                self.assertEqual(self.request(server, "GET", "/products", {**old, "Cf-Access-Jwt-Assertion": self.token(exp=int(time()) - 1)})[0], 403)
                self.assertEqual(self.request(server, "GET", "/products", {**old, "Cf-Access-Jwt-Assertion": self.token(sub="other")})[0], 403)
                self.assertEqual(self.request(server, "GET", "/products", {**old, "Cf-Access-Jwt-Assertion": "invalid"})[0], 403)
                self.assertEqual(self.request(server, "GET", "/../checkout", old)[0], 403)
                self.assertEqual(self.request(server, "POST", "/products", {**write, "Origin": "https://evil.example"}, body)[0], 403)
                self.assertEqual(self.request(server, "GET", "/products", new)[0], 403)
                self.assertEqual(fetch.call_count, 1)
                self.clock += 31
                self.assertEqual(self.request(server, "GET", "/products", new)[0], 200)
                self.assertEqual(self.request(server, "GET", "/products", old)[0], 200)
                self.clock += 301
                self.assertEqual(self.request(server, "GET", "/products", new)[0], 200)
                self.assertEqual(self.request(server, "GET", "/database-backup", old)[0], 403)
                self.clock += 301
                self.assertEqual(self.request(server, "GET", "/products", new)[0], 403)
                self.assertEqual(self.request(server, "GET", "/database-backup", new)[0], 403)
                self.assertEqual(self.request(server, "POST", "/products", {**new, "Content-Type": "application/json"}, body)[0], 403)
                self.assertEqual(fetch.call_count, 4)
                with sqlite3.connect(database) as db:
                    self.assertEqual(db.execute("SELECT COUNT(*) FROM products").fetchone()[0], 1)
                    self.assertEqual(db.execute("SELECT quantity FROM products WHERE code = 'T'").fetchone()[0], "0")
            self.assertFalse(database.exists())
            self.assertEqual(server.socket.fileno(), -1)

    def test_configuration_requires_pinned_https_issuer_and_https_origin(self):
        with self.assertRaises(ValueError):
            with isolated_access_server("http://127.0.0.1", "aud", "owner", self.origin):
                self.fail("must not open a listener")
        with self.assertRaises(ValueError):
            with isolated_access_server(self.issuer, "aud", "owner", "http://pos.example"):
                self.fail("must not open a listener")
