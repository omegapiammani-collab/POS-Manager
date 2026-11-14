"""Shared HTTP test helper for requests bound to a specific POS database."""
import json
from urllib.request import urlopen


def store_headers(origin):
    with urlopen(origin + "/store-identity", timeout=3) as response:
        store_id = json.load(response)["id"]
    return {"Content-Type": "application/json", "X-POS-Store-ID": store_id}
