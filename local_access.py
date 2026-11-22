"""Local-only request policy; this does not authenticate an owner.

Do not use forwarded headers to infer a client identity. Remote access needs a
separately designed and authenticated boundary before it can be enabled.
"""
from ipaddress import ip_address


def allows_local_request(headers, peer_address, port):
    """Accept only one local Host and a direct loopback peer."""
    hosts = headers.get_all("Host", [])
    if len(hosts) != 1 or hosts[0] not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
        return False
    try:
        return ip_address(peer_address).is_loopback
    except (TypeError, ValueError):
        return False
