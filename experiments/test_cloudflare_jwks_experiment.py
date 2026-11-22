"""No live network or provider account: synthetic keys and mocked transport."""
import json
from time import time
from unittest import TestCase
from unittest.mock import Mock, patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from experiments.cloudflare_jwks_experiment import (CERT_PATH, MAX_BYTES, PinnedAccessKeys,
                                                      RotatingAccessVerifier, _PinnedConnection, public_addresses)


class JwksExperimentTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = [rsa.generate_private_key(public_exponent=65537, key_size=2048) for _ in range(2)]
        cls.jwks = []
        for number, key in enumerate(cls.keys):
            jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
            cls.jwks.append({**jwk, "kid": "key-" + str(number), "alg": "RS256", "use": "sig"})

    def setUp(self):
        self.issuer = "https://test-team.cloudflareaccess.com"
        self.clock_value = 1000
        self.clock = lambda: self.clock_value
        self.claims = {"iss": self.issuer, "aud": "aud", "sub": "owner", "nbf": int(time()) - 30, "exp": int(time()) + 300}

    def token(self, number):
        return jwt.encode(self.claims, self.keys[number], algorithm="RS256", headers={"kid": "key-" + str(number)})

    def test_explicit_cache_and_rotation_fail_closed(self):
        source = Mock()
        source.fetch.side_effect = [
            {"keys": [self.jwks[0]], "public_cert": {"cert": "ignored"}, "public_certs": []},
            {"keys": self.jwks}, {"keys": [self.jwks[1]]}, RuntimeError("offline"),
        ]
        verifier = RotatingAccessVerifier(self.issuer, "aud", "owner", source, ttl=100, cooldown=10, clock=self.clock)
        old, new = self.token(0), self.token(1)
        self.assertIsNotNone(verifier(old))
        self.assertIsNone(verifier(new))  # cooldown prevents an unknown-kid flood
        self.assertEqual(source.fetch.call_count, 1)
        self.clock_value += 11
        self.assertIsNotNone(verifier(new))
        self.assertIsNotNone(verifier(old))  # overlap retains prior key
        self.clock_value += 101
        self.assertIsNotNone(verifier(new))  # expiry fetch removes old key
        self.assertIsNone(verifier(old))
        self.clock_value += 101
        self.assertIsNone(verifier(new))  # failed refresh does not use stale keys
        self.assertIsNone(verifier(new))  # failure is throttled
        self.assertEqual(source.fetch.call_count, 4)

    def test_bad_key_response_does_not_leave_old_key_active(self):
        source = Mock()
        source.fetch.side_effect = [{"keys": [self.jwks[0]]}, {"keys": [self.jwks[0], self.jwks[0]]}]
        verifier = RotatingAccessVerifier(self.issuer, "aud", "owner", source, ttl=60, cooldown=10, clock=self.clock)
        self.assertIsNotNone(verifier(self.token(0)))
        self.clock_value += 61
        self.assertIsNone(verifier(self.token(0)))
        self.assertIsNone(verifier(self.token(0)))

    def test_public_dns_only_and_tls_uses_pinned_host(self):
        public = [(None, None, None, None, ("1.1.1.1", 443))]
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "192.0.2.1"):
            with self.subTest(address=address), self.assertRaises(ValueError):
                public_addresses(public + [(None, None, None, None, (address, 443))])
        context, raw = Mock(), Mock()
        with patch("socket.getaddrinfo", return_value=public), patch("socket.create_connection", return_value=raw) as connect:
            conn = _PinnedConnection("test-team.cloudflareaccess.com", port=443, timeout=3, context=context)
            import time as clock_module
            conn.deadline = clock_module.monotonic() + 3
            conn.connect()
        self.assertEqual(connect.call_args[0][0], ("1.1.1.1", 443))
        self.assertEqual(context.wrap_socket.call_args[1]["server_hostname"], "test-team.cloudflareaccess.com")

    def test_fixed_endpoint_and_bad_responses_fail_without_following_redirects(self):
        response = Mock()
        response.status = 200
        response.getheader.side_effect = lambda name, default=None: {"Content-Type": "application/json"}.get(name, default)
        response.read.return_value = b'{"keys":[],"public_certs":[]}'
        connection = Mock()
        connection.getresponse.return_value = response
        source = PinnedAccessKeys(self.issuer)
        with patch("experiments.cloudflare_jwks_experiment._PinnedConnection", return_value=connection) as factory:
            self.assertEqual(source.fetch(), {"keys": [], "public_certs": []})
            self.assertEqual(factory.call_args[0][0], "test-team.cloudflareaccess.com")
            self.assertEqual(connection.request.call_args[0], ("GET", CERT_PATH))
            response.status = 302
            with self.assertRaises(ValueError): source.fetch()
            response.status = 200
            response.read.return_value = b'x' * (MAX_BYTES + 1)
            with self.assertRaises(ValueError): source.fetch()
            response.read.return_value = b'{"keys":[],"keys":[]}'
            with self.assertRaises(ValueError): source.fetch()

    def test_issuer_cannot_be_a_private_url_or_redirect_target(self):
        for issuer in ("http://test-team.cloudflareaccess.com", "https://127.0.0.1", "https://test-team.cloudflareaccess.com.evil.example",
                       "https://test-team.cloudflareaccess.com:443", "https://test-team.cloudflareaccess.com/path"):
            with self.subTest(issuer=issuer), self.assertRaises(ValueError):
                PinnedAccessKeys(issuer)
