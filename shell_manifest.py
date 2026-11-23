"""Generate or check the committed checkout shell release manifest."""
import argparse
import hashlib
import json
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent / "web"
SHELL_FILES = ("backup.html", "backup.js", "checkout.html", "checkout.js", "inventory.css", "offline-store.js", "sw.js")
MANIFEST = "shell-manifest.json"


def manifest_bytes(directory):
    hashes = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in SHELL_FILES}
    return (json.dumps({"version": 1, "sha256": hashes}, indent=2, sort_keys=True) + "\n").encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail if the committed manifest is stale")
    args = parser.parse_args()
    expected = manifest_bytes(WEB_DIR)
    target = WEB_DIR / MANIFEST
    if args.check:
        if not target.exists() or target.read_bytes() != expected:
            parser.exit(1, "Checkout shell manifest is stale. Run python3 shell_manifest.py and commit it with the shell files.\n")
    else:
        target.write_bytes(expected)


if __name__ == "__main__":
    main()
