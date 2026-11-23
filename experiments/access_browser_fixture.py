"""Synthetic CI fixture only: disposable POS and signed tokens; no provider account."""
from contextlib import closing
from time import time
from unittest.mock import patch
import json
import sys

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

import inventory_api as api
from experiments.isolated_access_server import isolated_access_server


def main():
    issuer = "https://test-team.cloudflareaccess.com"
    origin = "https://pos.example"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update({"kid": "synthetic", "alg": "RS256", "use": "sig"})
    claims = {"iss": issuer, "aud": "aud", "sub": "owner", "nbf": int(time()) - 30, "exp": int(time()) + 600}
    valid = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "synthetic"})
    expired = jwt.encode({**claims, "exp": int(time()) - 1}, key, algorithm="RS256", headers={"kid": "synthetic"})
    with patch("experiments.isolated_access_server.PinnedAccessKeys.fetch", return_value={"keys": [jwk]}):
        with isolated_access_server(issuer, "aud", "owner", origin) as server:
            database = server.RequestHandlerClass.keywords["database"]
            with closing(api.connect(database)) as db:
                product_id, unit_id = api.add_product(db, "TEST", "น้ำดื่ม", "ขวด", "25")
                api.receive(db, product_id, unit_id, "1", "12")
            print(json.dumps({"port": server.server_port, "valid": valid, "expired": expired}), flush=True)
            sys.stdin.read()


if __name__ == "__main__":
    main()
