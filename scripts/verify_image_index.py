#!/usr/bin/env python3
"""Verify that an OCI/Docker image index has exactly the required FolderFrame platforms."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REQUIRED_PLATFORMS = {("linux", "amd64"), ("linux", "arm64")}


def platforms(payload: dict) -> set[tuple[str, str]]:
    result = set()
    for manifest in payload.get("manifests", []):
        platform = manifest.get("platform") if isinstance(manifest, dict) else None
        if not isinstance(platform, dict):
            continue
        os_name = platform.get("os")
        architecture = platform.get("architecture")
        if isinstance(os_name, str) and isinstance(architecture, str):
            result.add((os_name, architecture))
    return result


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify_image_index.py IMAGE_INDEX.json")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    found = platforms(payload)
    missing = REQUIRED_PLATFORMS - found
    if missing:
        rendered = ", ".join(f"{os_name}/{architecture}" for os_name, architecture in sorted(missing))
        raise SystemExit(f"image index is missing required platforms: {rendered}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
