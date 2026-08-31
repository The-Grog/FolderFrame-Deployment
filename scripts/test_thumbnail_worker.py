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

if __name__ == "__main__":
    unittest.main()
