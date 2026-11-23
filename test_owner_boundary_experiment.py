"""Exercise only the isolated fake-verifier experiment, not real login."""
from email.message import Message
from unittest import TestCase
from unittest.mock import Mock

from experiments.owner_boundary import OwnerPolicy, VerifiedIdentity, allow_request, handle_experiment


class OwnerBoundaryExperimentTests(TestCase):
    def setUp(self):
        self.policy = OwnerPolicy("https://issuer.example", "owner-123", "pos-app", "https://pos.example")
        self.owner = VerifiedIdentity("https://issuer.example", "owner-123", "pos-app", 2000)
        self.verifier = Mock(return_value=self.owner)
        self.backend = Mock(return_value=(200, b"fake data"))

    @staticmethod
    def headers(*pairs):
        result = Message()
        for name, value in pairs:
            result[name] = value
        return result

    def check(self, method, path, headers):
        return handle_experiment(method, path, headers, b"fake body", self.policy,
                                 self.verifier, self.backend, now=lambda: 1000)

    def test_all_paths_deny_before_backend_when_identity_is_missing_or_spoofed(self):
        for method, path in (("GET", "/products"), ("GET", "/database-backup"), ("POST", "/sales"), ("POST", "/customers")):
            with self.subTest(method=method, path=path):
                headers = self.headers(("Origin", self.policy.origin), ("X-Owner", "owner-123"),
                                       ("X-Forwarded-User", "owner-123"), ("X-POS-Store-ID", "owner-123"))
                self.assertEqual(self.check(method, path, headers)[0], 403)
        self.verifier.assert_not_called()
        self.backend.assert_not_called()

    def test_verified_owner_can_reach_fake_backend_for_read_write_and_backup(self):
        headers = self.headers(("Authorization", "Bearer test-token"), ("Origin", self.policy.origin))
        for method, path in (("GET", "/products"), ("GET", "/database-backup"), ("POST", "/sales")):
            self.assertEqual(self.check(method, path, headers), (200, b"fake data"))
        self.assertEqual(self.backend.call_count, 3)

    def test_wrong_claims_expiry_and_verifier_errors_deny(self):
        headers = self.headers(("Authorization", "Bearer test-token"), ("Origin", self.policy.origin))
        for identity in (
            VerifiedIdentity("https://other.example", "owner-123", "pos-app", 2000),
            VerifiedIdentity("https://issuer.example", "other", "pos-app", 2000),
            VerifiedIdentity("https://issuer.example", "owner-123", "other", 2000),
            VerifiedIdentity("https://issuer.example", "owner-123", "pos-app", 1000),
            VerifiedIdentity("https://issuer.example", "owner-123", "pos-app", float("nan")),
            VerifiedIdentity("https://issuer.example", "owner-123", "pos-app", True),
            {"subject": "owner-123"}, None,
        ):
            with self.subTest(identity=identity):
                self.verifier.return_value = identity
                self.assertEqual(self.check("GET", "/database-backup", headers)[0], 403)
        self.verifier.side_effect = RuntimeError("verification unavailable")
        self.assertEqual(self.check("POST", "/sales", headers)[0], 403)
        self.backend.assert_not_called()

    def test_cross_origin_duplicate_and_malformed_headers_deny(self):
        cases = (
            self.headers(("Authorization", "Bearer test-token"), ("Origin", "https://evil.example")),
            self.headers(("Authorization", "Bearer test-token")),
            self.headers(("Authorization", "Bearer test-token"), ("Authorization", "Bearer other"), ("Origin", self.policy.origin)),
            self.headers(("Authorization", "Bearer test-token"), ("Origin", self.policy.origin), ("Origin", self.policy.origin)),
            self.headers(("Authorization", "Bearer token extra"), ("Origin", self.policy.origin)),
        )
        for headers in cases:
            with self.subTest(headers=list(headers.items())):
                self.assertEqual(self.check("POST", "/sales", headers)[0], 403)
        self.assertEqual(self.check("GET", "/database-backup", cases[0])[0], 403)
        self.backend.assert_not_called()

    def test_missing_configuration_unknown_method_and_bad_origin_deny(self):
        headers = self.headers(("Authorization", "Bearer test-token"), ("Origin", self.policy.origin))
        self.assertFalse(allow_request("GET", headers, None, self.verifier, now=lambda: 1000))
        self.assertFalse(allow_request("GET", headers, self.policy, None, now=lambda: 1000))
        self.assertFalse(allow_request("DELETE", headers, self.policy, self.verifier, now=lambda: 1000))
        for origin in ("http://pos.example", "https://pos.example/path", "https://user@pos.example"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                OwnerPolicy("issuer", "subject", "audience", origin)
