"""In-memory handler integration experiment. Never bind this to a network.

No trusted proxy, transport authentication, JWKS retrieval, login, session
revocation or production integration is provided. The ordinary POS server
does not import or enable this handler.
"""
from email.message import Message
from io import BytesIO
from urllib.parse import urlsplit

from inventory_api import InventoryHandler
from experiments.owner_boundary import allow_request


class MemoryTransport:
    """A byte buffer, not a socket; it cannot send or receive network data."""
    def __init__(self, request):
        self.incoming = BytesIO(request)
        self.sent = bytearray()

    def makefile(self, mode, *args, **kwargs):
        if mode != "rb":
            raise ValueError("Unexpected mode")
        return self.incoming

    def sendall(self, data):
        self.sent.extend(data)


class ExperimentalAccessHandler(InventoryHandler):
    """Require a verified synthetic Access assertion before real POS routing."""

    def __init__(self, request, *args, **kwargs):
        if type(request) is not MemoryTransport:
            raise TypeError("This experiment accepts only in-memory transport")
        super().__init__(request, *args, **kwargs)

    def log_message(self, *args):
        # Synthetic requests only; avoid logging test credentials.
        pass

    def handle_request(self):
        try:
            target = urlsplit(self.path)
            path = target.path
            # Only accept a simple origin-form request target in this experiment.
            if (target.scheme or target.netloc or target.fragment or not path.startswith("/")
                    or path.startswith("//") or "\\" in path or "%" in path
                    or any(ord(char) < 32 or ord(char) == 127 for char in self.path)
                    or any(part in (".", "..") for part in path.split("/"))):
                return self.send_json(403, {"error": "Forbidden"})
            assertions = self.headers.get_all("Cf-Access-Jwt-Assertion", [])
            if len(assertions) != 1:
                return self.send_json(403, {"error": "Forbidden"})
            # The verifier checks the signature. No identity header or cookie is
            # trusted. Preserve duplicate Origin values for the fail-closed check.
            headers = Message()
            headers["Authorization"] = "Bearer " + assertions[0]
            for origin in self.headers.get_all("Origin", []):
                headers["Origin"] = origin
            policy = getattr(self.server, "test_owner_policy", None)
            verifier = getattr(self.server, "test_token_verifier", None)
            if not allow_request(self.command, headers, policy, verifier):
                return self.send_json(403, {"error": "Forbidden"})
        except Exception:
            return self.send_json(403, {"error": "Forbidden"})
        # The real handler still enforces its existing local-only Host/peer policy.
        return super().handle_request()

    do_GET = handle_request
    do_POST = handle_request
    do_HEAD = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request
    do_OPTIONS = handle_request
    do_TRACE = handle_request
    do_CONNECT = handle_request
