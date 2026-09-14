import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("thumbnail_worker", ROOT / "thumbnail_worker.py")
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)

class MediaWorkerTests(unittest.TestCase):
    def command(self, thumbnails, manifest):
        return WORKER.helper_command(
            pathlib.Path("/helper.py"), pathlib.Path("/media"),
            pathlib.Path("/config/thumbnails"),
            pathlib.Path("/config/folderframe-data/library.json"),
            thumbnails, manifest, 480, 80,
        )

    def test_default_combined_command(self):
        self.assertEqual(self.command(True, True), [
            WORKER.sys.executable, str(pathlib.Path("/helper.py")), str(pathlib.Path("/media")), str(pathlib.Path("/config/thumbnails")),
            "--size", "480", "--quality", "80", "--manifest",
            str(pathlib.Path("/config/folderframe-data/library.json")),
        ])

    def test_thumbnail_only_command(self):
        command = self.command(True, False)
        self.assertIn(str(pathlib.Path("/config/thumbnails")), command)
        self.assertNotIn("--manifest", command)
        self.assertNotIn("--manifest-only", command)

    def test_manifest_only_command(self):
        self.assertEqual(self.command(False, True), [
            WORKER.sys.executable, str(pathlib.Path("/helper.py")), str(pathlib.Path("/media")), "--manifest",
            str(pathlib.Path("/config/folderframe-data/library.json")), "--manifest-only",
        ])

    def test_cache_and_status_paths_are_forwarded(self):
        command = WORKER.helper_command(
            pathlib.Path("/helper.py"), pathlib.Path("/media"),
            pathlib.Path("/config/thumbnails"),
            pathlib.Path("/config/folderframe-data/library.json"),
            True, True, 480, 80,
            pathlib.Path("/config/folderframe-data/thumbnail-failures.json"),
            pathlib.Path("/config/folderframe-data/worker-status.json"),
        )
        self.assertIn("--failure-cache", command)
        self.assertIn(str(pathlib.Path("/config/folderframe-data/thumbnail-failures.json")), command)
        self.assertIn("--status-file", command)
        self.assertIn(str(pathlib.Path("/config/folderframe-data/worker-status.json")), command)

    def test_both_disabled_settings_are_supported(self):
        with mock.patch.dict(WORKER.os.environ, {
            "FOLDERFRAME_THUMBNAILS": "false",
            "FOLDERFRAME_MANIFEST": "false",
        }, clear=True), mock.patch.object(WORKER.signal, "signal"):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(WORKER.main(), 0)
        self.assertIn("thumbnails and manifest are disabled", output.getvalue())

    def test_missing_and_invalid_manifest_are_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "library.json"
            for content, expected in [(None, "missing"), ("not json", "invalid")]:
                if content is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(content, encoding="utf-8")
                output = io.StringIO()
                with mock.patch.object(WORKER.subprocess, "run"), contextlib.redirect_stdout(output):
                    self.assertTrue(WORKER.run_once(["helper"], path))
                self.assertIn(expected, output.getvalue())
            path.write_text(json.dumps({"version": 1}), encoding="utf-8")
            self.assertEqual(WORKER.manifest_status(path), "valid")

    def test_helper_failure_is_nonfatal(self):
        output = io.StringIO()
        error = subprocess.CalledProcessError(1, ["helper"])
        with mock.patch.object(WORKER.subprocess, "run", side_effect=error), contextlib.redirect_stdout(output):
            self.assertFalse(WORKER.run_once(["helper"], None))
        self.assertIn("gallery remains available", output.getvalue())

    def test_partial_thumbnail_failure_is_reported_as_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            status_path = pathlib.Path(directory) / "worker-status.json"
            status_path.write_text(json.dumps({
                "version": 1,
                "outcome": "complete_with_warnings",
                "mediaFiles": 10248,
                "thumbnailsGenerated": 12,
                "previewFailures": 3,
                "unchangedFailuresSkipped": 8,
            }), encoding="utf-8")
            output = io.StringIO()
            with mock.patch.object(WORKER.subprocess, "run"), contextlib.redirect_stdout(output):
                self.assertTrue(WORKER.run_once(["helper"], None, status_path))
            self.assertIn("scan complete with preview warnings", output.getvalue())
            self.assertIn("10248 media files", output.getvalue())
            self.assertIn("3 preview failures", output.getvalue())
            self.assertNotIn("scan failed", output.getvalue())

    def test_helper_failure_writes_failed_status(self):
        with tempfile.TemporaryDirectory() as directory:
            status_path = pathlib.Path(directory) / "worker-status.json"
            error = subprocess.CalledProcessError(1, ["helper"])
            with mock.patch.object(WORKER.subprocess, "run", side_effect=error):
                self.assertFalse(WORKER.run_once(["helper"], None, status_path))
            status = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(status["outcome"], "failed")

if __name__ == "__main__":
    unittest.main()
