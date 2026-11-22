"""Disposable loopback-only integration experiment, not a deployable server.

No CLI, external listener, persistent database path, proxy or login flow is
provided. Do not put this experiment behind a tunnel or reverse proxy.
"""
from contextlib import contextmanager
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import time

import inventory_api as api
from experiments.access_handler_experiment import ExperimentalAccessHandler
from experiments.cloudflare_jwks_experiment import PinnedAccessKeys, RotatingAccessVerifier
from experiments.owner_boundary import OwnerPolicy


class _IsolatedHandler(ExperimentalAccessHandler):
    """Allow the experimental guard to handle only loopback test sockets."""
    def __init__(self, request, client_address, server, **kwargs):
        if server.socket.getsockname()[0] != "127.0.0.1" or client_address[0] != "127.0.0.1":
            raise ValueError("Only loopback test connections are allowed")
        # Bypass only the memory-transport restriction, not the auth guard.
        api.InventoryHandler.__init__(self, request, client_address, server, **kwargs)


@contextmanager
def isolated_access_server(issuer, audience, owner_subject, origin, *, _clock=time.monotonic):
    """Create and clean up a disposable local-only server and empty database.

    This intentionally has no path, bind-address or port configuration. The
    verifier may fetch keys from the pinned issuer; tests mock that fetch.
    """
    policy = OwnerPolicy(issuer, owner_subject, audience, origin)
    keys = PinnedAccessKeys(issuer)
    verifier = RotatingAccessVerifier(issuer, audience, owner_subject, keys, clock=_clock)
    with TemporaryDirectory(prefix="pos-isolated-access-") as directory:
        database = Path(directory) / "synthetic.sqlite3"
        shell = api.checkout_shell()
        server = api.make_server(database, 0, shell=shell)
        worker = None
        started = False
        try:
            if server.socket.getsockname()[0] != "127.0.0.1":
                raise ValueError("Experiment must bind loopback")
            server.test_owner_policy = policy
            server.test_token_verifier = verifier
            server.RequestHandlerClass = partial(_IsolatedHandler, database=database, shell=shell)
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            started = True
            yield server
        finally:
            if started:
                server.shutdown()
                worker.join(timeout=5)
            server.server_close()
