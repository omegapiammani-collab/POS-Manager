"""Disposable loopback-only integration experiment, not a deployable server.

No CLI, external listener, persistent database path, proxy or login flow is
provided. Do not put this experiment behind a tunnel or reverse proxy.
"""
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import time

import inventory_api as api
from experiments.cloudflare_jwks_experiment import PinnedAccessKeys  # Shared class also patched by test fixtures.
from experiments.owner_access_adapter import OwnerAccessAdapter


@contextmanager
def isolated_access_server(issuer, audience, owner_subject, origin, *, _clock=time.monotonic):
    """Create and clean up a disposable local-only server and empty database.

    This intentionally has no path, bind-address or port configuration. The
    verifier may fetch keys from the pinned issuer; tests mock that fetch.
    """
    owner_access = OwnerAccessAdapter(issuer, audience, owner_subject, origin, _clock=_clock)
    with TemporaryDirectory(prefix="pos-isolated-access-") as directory:
        database = Path(directory) / "synthetic.sqlite3"
        shell = api.checkout_shell()
        server = api.make_server(database, 0, shell=shell, owner_access=owner_access)
        worker = None
        started = False
        try:
            if server.socket.getsockname()[0] != "127.0.0.1":
                raise ValueError("Experiment must bind loopback")
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            started = True
            yield server
        finally:
            if started:
                server.shutdown()
                worker.join(timeout=5)
            server.server_close()
