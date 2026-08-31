#!/usr/bin/env python3
"""Maintain FolderFrame's optional persistent thumbnail tree."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path


SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"}
STOP = False


def log(message: str) -> None:
    print(f"FolderFrame thumbnails: {message}", flush=True)


def stop_worker(_signum: int, _frame: object) -> None:
    global STOP
    STOP = True


def integer_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise SystemExit(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise SystemExit(f"{name} must be between {minimum} and {maximum}")
    return value


def generate_thumbnail(source: Path, target: Path, size: int, quality: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp.webp")
    try:
        subprocess.run(
            [
                "vipsthumbnail",
                str(source),
                "--size",
                f"{size}x{size}",
                "--rotate",
                "-o",
                f"{temporary}[Q={quality},strip]",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=180,
        )
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def scan_once(
    media_root: Path,
    thumbnail_root: Path,
    size: int,
    quality: int,
    delay_ms: int,
    prune_grace: int,
) -> tuple[int, int, int, int]:
    created = current = failed = removed = 0
    expected: set[Path] = set()
    walk_failed = False

    def walk_error(error: OSError) -> None:
        nonlocal walk_failed
        walk_failed = True
        log(f"could not scan {error.filename or 'a media directory'}: {error}")

    for root, directories, files in os.walk(media_root, topdown=True, onerror=walk_error, followlinks=False):
        if STOP:
            break
        root_path = Path(root)
        directories[:] = sorted(
            name for name in directories
            if not name.startswith(".") and not (root_path / name).is_symlink()
        )
        for name in sorted(files):
            if STOP:
                break
            source = root_path / name
            if name.startswith(".") or source.is_symlink() or source.suffix.lower() not in SUPPORTED:
                continue
            relative = source.relative_to(media_root)
            target = thumbnail_root / (str(relative) + ".webp")
            expected.add(target)
            try:
                if target.is_file() and target.stat().st_mtime_ns >= source.stat().st_mtime_ns:
                    current += 1
                    continue
                generate_thumbnail(source, target, size, quality)
                created += 1
            except (OSError, subprocess.SubprocessError) as error:
                failed += 1
                detail = getattr(error, "stderr", None) or str(error)
                log(f"skipped {relative}: {detail.strip()}")
            if delay_ms and not STOP:
                time.sleep(delay_ms / 1000)

    # Never remove cached previews after an interrupted or incomplete source scan.
    if not STOP and not walk_failed:
        cutoff = time.time() - prune_grace
        for target in thumbnail_root.rglob("*.webp"):
            if target in expected or target.is_symlink():
                continue
            try:
                if target.stat().st_mtime <= cutoff:
                    target.unlink()
                    removed += 1
            except OSError as error:
                failed += 1
                log(f"could not remove stale preview {target}: {error}")
        for directory in sorted(
            (path for path in thumbnail_root.rglob("*") if path.is_dir()),
            key=lambda path: len(path.parts),
            reverse=True,
        ):
            try:
                directory.rmdir()
            except OSError:
                pass
    return created, current, failed, removed


def main() -> int:
    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)
    media_root = Path(os.environ.get("FOLDERFRAME_MEDIA_PATH", "/media")).resolve()
    thumbnail_root = Path(os.environ.get("FOLDERFRAME_THUMBNAIL_PATH", "/config/thumbnails")).resolve()
    interval = integer_setting("FOLDERFRAME_THUMBNAIL_INTERVAL", 3600, 60, 86400)
    size = integer_setting("FOLDERFRAME_THUMBNAIL_SIZE", 480, 64, 2048)
    quality = integer_setting("FOLDERFRAME_THUMBNAIL_QUALITY", 80, 1, 100)
    delay_ms = integer_setting("FOLDERFRAME_THUMBNAIL_DELAY_MS", 50, 0, 10000)
    prune_grace = integer_setting("FOLDERFRAME_THUMBNAIL_PRUNE_GRACE", 86400, 0, 2592000)
    if not media_root.is_dir():
        log(f"media directory is unavailable: {media_root}")
        return 1
    thumbnail_root.mkdir(parents=True, exist_ok=True)
    log(
        f"enabled; output={thumbnail_root}, interval={interval}s, "
        f"size={size}px, quality={quality}"
    )
    while not STOP:
        started = time.monotonic()
        created, current, failed, removed = scan_once(
            media_root, thumbnail_root, size, quality, delay_ms, prune_grace
        )
        elapsed = time.monotonic() - started
        log(
            f"scan complete in {elapsed:.1f}s; generated={created}, "
            f"current={current}, failed={failed}, removed={removed}"
        )
        deadline = time.monotonic() + interval
        while not STOP and time.monotonic() < deadline:
            time.sleep(min(1, max(0, deadline - time.monotonic())))
    log("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
