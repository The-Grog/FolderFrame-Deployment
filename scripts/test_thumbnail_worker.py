import importlib.util
import os
import pathlib
import tempfile
import time
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "thumbnail_worker", ROOT / "thumbnail_worker.py"
)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class ThumbnailWorkerTests(unittest.TestCase):
    def setUp(self):
        WORKER.STOP = False

    def test_generates_nested_preview_and_skips_current_output(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            media = base / "media"
            output = base / "output"
            source = media / "year" / "photo.jpg"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"image")

            def fake_generate(_source, target, _size, _quality):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"webp")

            with mock.patch.object(WORKER, "generate_thumbnail", side_effect=fake_generate):
                result = WORKER.scan_once(media, output, 480, 80, 0, 86400)
                self.assertEqual(result, (1, 0, 0, 0))
                target = output / "year" / "photo.jpg.webp"
                self.assertEqual(target.read_bytes(), b"webp")
                future = time.time() + 2
                os.utime(target, (future, future))
                result = WORKER.scan_once(media, output, 480, 80, 0, 86400)
                self.assertEqual(result, (0, 1, 0, 0))

    def test_prunes_only_old_orphans_after_complete_scan(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            media = base / "media"
            output = base / "output"
            media.mkdir()
            output.mkdir()
            old = output / "removed.jpg.webp"
            fresh = output / "recent.jpg.webp"
            old.write_bytes(b"old")
            fresh.write_bytes(b"fresh")
            past = time.time() - 1000
            os.utime(old, (past, past))
            result = WORKER.scan_once(media, output, 480, 80, 0, 500)
            self.assertEqual(result, (0, 0, 0, 1))
            self.assertFalse(old.exists())
            self.assertTrue(fresh.exists())

    def test_generation_failure_keeps_original_and_scan_continues(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            media = base / "media"
            output = base / "output"
            media.mkdir()
            (media / "bad.heic").write_bytes(b"unsupported")
            with mock.patch.object(
                WORKER, "generate_thumbnail", side_effect=OSError("decode failed")
            ):
                result = WORKER.scan_once(media, output, 480, 80, 0, 86400)
            self.assertEqual(result, (0, 0, 1, 0))
            self.assertTrue((media / "bad.heic").exists())
            self.assertFalse((output / "bad.heic.webp").exists())

    def test_incomplete_media_scan_never_prunes_cached_previews(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            media = base / "media"
            output = base / "output"
            media.mkdir()
            output.mkdir()
            cached = output / "keep.jpg.webp"
            cached.write_bytes(b"keep")
            past = time.time() - 1000
            os.utime(cached, (past, past))

            def failed_walk(_root, **kwargs):
                kwargs["onerror"](OSError("mount unavailable"))
                return []

            with mock.patch.object(WORKER.os, "walk", side_effect=failed_walk):
                result = WORKER.scan_once(media, output, 480, 80, 0, 0)
            self.assertEqual(result, (0, 0, 0, 0))
            self.assertTrue(cached.exists())


if __name__ == "__main__":
    unittest.main()
