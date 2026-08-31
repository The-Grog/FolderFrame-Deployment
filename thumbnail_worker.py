#!/usr/bin/env python3
"""Schedule FolderFrame's persistent thumbnails and media manifest."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

STOP = False

def log(message: str) -> None:
    print(f"FolderFrame media worker: {message}", flush=True)

def stop_worker(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True

def enabled_setting(name: str, default: bool) -> bool:
    value = os.environ.get(name, str(default).lower())
    if value not in {"true", "false"}:
        raise SystemExit(f"{name} must be true or false")
    return value == "true"

def integer_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise SystemExit(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise SystemExit(f"{name} must be between {minimum} and {maximum}")
    return value

def manifest_status(path: Path) -> str:
    if not path.is_file():
        return "missing"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return "invalid"
    return "valid" if isinstance(payload, dict) and payload.get("version") == 1 else "invalid"

def helper_command(helper: Path, media_root: Path, thumbnail_root: Path,
        manifest_path: Path, thumbnails: bool, manifest: bool,
        size: int, quality: int) -> list[str]:
    command = [sys.executable, str(helper), str(media_root)]
    if thumbnails:
        command.extend([str(thumbnail_root), "--size", str(size), "--quality", str(quality)])
    if manifest:
        command.extend(["--manifest", str(manifest_path)])
        if not thumbnails:
            command.append("--manifest-only")
    return command

def run_once(command: list[str], manifest_path: Path | None) -> bool:
    if manifest_path is not None:
        status = manifest_status(manifest_path)
        if status == "missing":
            log("persistent manifest is missing; helper will rebuild the full index")
        elif status == "invalid":
            log("persistent manifest is invalid; helper will rebuild the full index")
    try:
        subprocess.run(command, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        log(f"scan failed; gallery remains available: {error}")
        return False
    log("scan complete")
    return True

def main() -> int:
    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)
    thumbnails = enabled_setting("FOLDERFRAME_THUMBNAILS", True)
    manifest = enabled_setting("FOLDERFRAME_MANIFEST", True)
    if not thumbnails and not manifest:
        log("thumbnails and manifest are disabled")
        return 0
    media_root = Path(os.environ.get("FOLDERFRAME_MEDIA_PATH", "/media")).resolve()
    thumbnail_root = Path(os.environ.get("FOLDERFRAME_THUMBNAIL_PATH", "/config/thumbnails")).resolve()
    manifest_path = Path(os.environ.get(
        "FOLDERFRAME_MANIFEST_PATH", "/config/folderframe-data/library.json"
    )).resolve()
    helper = Path(os.environ.get(
        "FOLDERFRAME_HELPER_PATH", "/usr/share/folderframe/generate_thumbnails.py"
    )).resolve()
    interval = integer_setting("FOLDERFRAME_THUMBNAIL_INTERVAL", 3600, 60, 86400)
    size = integer_setting("FOLDERFRAME_THUMBNAIL_SIZE", 480, 64, 4096)
    quality = integer_setting("FOLDERFRAME_THUMBNAIL_QUALITY", 80, 1, 100)
    if not media_root.is_dir():
        log(f"media directory is unavailable: {media_root}")
        return 1
    if not helper.is_file():
        log(f"helper is unavailable: {helper}; gallery remains available")
        return 0
    if thumbnails:
        thumbnail_root.mkdir(parents=True, exist_ok=True)
    if manifest:
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
    command = helper_command(helper, media_root, thumbnail_root, manifest_path,
        thumbnails, manifest, size, quality)
    mode = "thumbnails+manifest" if thumbnails and manifest else (
        "thumbnails-only" if thumbnails else "manifest-only"
    )
    log(f"enabled; mode={mode}, interval={interval}s")
    while not STOP:
        run_once(command, manifest_path if manifest else None)
        deadline = time.monotonic() + interval
        while not STOP and time.monotonic() < deadline:
            time.sleep(min(1, max(0, deadline - time.monotonic())))
    log("stopped")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
