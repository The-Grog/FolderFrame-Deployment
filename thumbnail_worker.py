#!/usr/bin/env python3
"""Schedule FolderFrame's persistent thumbnails and media manifest."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
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

def read_status(path: Path | None) -> dict | None:
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    return payload if isinstance(payload, dict) and payload.get("version") == 1 else None

def write_status(path: Path | None, payload: dict) -> None:
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    except OSError as error:
        log(f"could not update worker status: {error}")

def status_summary(status: dict) -> str:
    prefix = "scan complete with preview warnings" if status.get("outcome") == "complete_with_warnings" else "scan complete"
    parts = []
    if status.get("mediaFiles") is not None:
        parts.append(f"{status['mediaFiles']} media files")
    parts.extend([
        f"{status.get('thumbnailsGenerated', 0)} thumbnails generated",
        f"{status.get('previewFailures', 0)} preview failures",
        f"{status.get('unchangedFailuresSkipped', 0)} unchanged failures skipped",
    ])
    return f"{prefix} — {' · '.join(parts)}"

def helper_command(helper: Path, media_root: Path, thumbnail_root: Path,
        manifest_path: Path, thumbnails: bool, manifest: bool,
        size: int, quality: int, failure_cache_path: Path | None = None,
        status_path: Path | None = None) -> list[str]:
    command = [sys.executable, str(helper), str(media_root)]
    if thumbnails:
        command.extend([str(thumbnail_root), "--size", str(size), "--quality", str(quality)])
    if manifest:
        command.extend(["--manifest", str(manifest_path)])
        if not thumbnails:
            command.append("--manifest-only")
    if thumbnails and failure_cache_path is not None:
        command.extend(["--failure-cache", str(failure_cache_path)])
    if status_path is not None:
        command.extend(["--status-file", str(status_path)])
    return command

def run_once(command: list[str], manifest_path: Path | None,
        status_path: Path | None = None) -> bool:
    if manifest_path is not None:
        status = manifest_status(manifest_path)
        if status == "missing":
            log("persistent manifest is missing; helper will rebuild the full index")
        elif status == "invalid":
            log("persistent manifest is invalid; helper will rebuild the full index")
    try:
        subprocess.run(command, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        write_status(status_path, {
            "version": 1,
            "completedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "outcome": "failed",
            "error": str(error),
        })
        log(f"scan failed; gallery remains available: {error}")
        return False
    status = read_status(status_path)
    log(status_summary(status) if status else "scan complete")
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
    failure_cache_path = Path(os.environ.get(
        "FOLDERFRAME_THUMBNAIL_FAILURE_CACHE_PATH",
        "/config/folderframe-data/thumbnail-failures.json",
    )).resolve()
    status_path = Path(os.environ.get(
        "FOLDERFRAME_WORKER_STATUS_PATH", "/config/folderframe-data/worker-status.json"
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
    status_path.parent.mkdir(parents=True, exist_ok=True)
    command = helper_command(helper, media_root, thumbnail_root, manifest_path,
        thumbnails, manifest, size, quality,
        failure_cache_path if thumbnails else None, status_path)
    mode = "thumbnails+manifest" if thumbnails and manifest else (
        "thumbnails-only" if thumbnails else "manifest-only"
    )
    log(f"enabled; mode={mode}, interval={interval}s")
    while not STOP:
        run_once(command, manifest_path if manifest else None, status_path)
        deadline = time.monotonic() + interval
        while not STOP and time.monotonic() < deadline:
            time.sleep(min(1, max(0, deadline - time.monotonic())))
    log("stopped")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
