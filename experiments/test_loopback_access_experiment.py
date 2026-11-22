"""HTTP socket integration with synthetic owner on loopback only; no service is deployed."""
from functools import partial
from http.client import HTTPConnection
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from time import time
from unittest import TestCase
import json

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

import inventory_api as api
from experiments.access_handler_experiment import ExperimentalAccessHandler
from experiments.cloudflare_token_experiment import AccessTokenVerifier
from experiments.owner_boundary import OwnerPolicy


class _LoopbackTestHandler(ExperimentalAccessHandler):
    """Test-only handler: the inherited memory-only constructor is not used."""
    def __init__(self, request, client_address, server, **kwargs):
        if server.socket.getsockname()[0] != "127.0.0.1" or client_address[0] != "127.0.0.1":
            raise ValueError("Loopback only")
        api.InventoryHandler.__init__(self, request, client_address, server, **kwargs)


class LoopbackIntegrationTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(cls.key.public_key()))
        cls.jwk = {**jwk, "kid": "synthetic", "alg": "RS256", "use": "sig"}

    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.issuer = "https://test-team.cloudflareaccess.com"
        self.origin = "https://pos.example"
        self.server = api.make_server(Path(directory.name) / "synthetic.sqlite3", 0)
        self.addCleanup(self.server.server_close)
        self.server.test_owner_policy = OwnerPolicy(self.issuer, "owner", "aud", self.origin)
        self.server.test_token_verifier = AccessTokenVerifier(self.issuer, "aud", "owner", {"keys": [self.jwk]})
        self.server.RequestHandlerClass = partial(_LoopbackTestHandler, database=Path(directory.name) / "synthetic.sqlite3", shell=api.checkout_shell())
        worker = Thread(target=self.server.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(self.server.shutdown)

    def token(self, **overrides):
        claims = {"iss": self.issuer, "aud": "aud", "sub": "owner", "nbf": int(time()) - 30, "exp": int(time()) + 300}
        claims.update(overrides)
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": "synthetic"})

    def request(self, method, path, headers=None, body=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_signed_owner_over_loopback_reaches_real_pos_and_spoof_does_not(self):
        valid = {"Cf-Access-Jwt-Assertion": self.token(), "Origin": self.origin}
        for path in ("/checkout", "/checkout.js", "/products", "/database-backup"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 403)
                self.assertEqual(self.request("GET", path, valid)[0], 200)
        body = json.dumps({"code": "T", "name": "Synthetic", "base_unit": "piece", "price": "1"})
        spoof = {"Authorization": "Bearer " + self.token(), "X-Owner": "owner", "Origin": self.origin,
                 "Content-Type": "application/json"}
        self.assertEqual(self.request("POST", "/products", spoof, body)[0], 403)
        wrong_origin = {**valid, "Origin": "https://evil.example", "Content-Type": "application/json"}
        self.assertEqual(self.request("POST", "/products", wrong_origin, body)[0], 403)
        self.assertEqual(self.request("POST", "/products", {**valid, "Content-Type": "application/json"}, body)[0], 201)
        self.assertEqual(len(json.loads(self.request("GET", "/products", valid)[1])), 1)
        self.assertEqual(self.request("GET", "/products", {**valid, "Cf-Access-Jwt-Assertion": self.token(sub="other")})[0], 403)
