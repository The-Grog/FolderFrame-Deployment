import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("refresh_control", ROOT / "refresh_control.py")
CONTROL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROL)


class RefreshControlTests(unittest.TestCase):
    def test_requests_coalesce_and_active_scan_allows_one_follow_up(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "refresh.json"
            self.assertEqual(CONTROL.request(path, "request_one"), ("request_one", False))
            self.assertEqual(CONTROL.request(path, "request_two"), ("request_one", True))
            first = CONTROL.claim(path)
            self.assertEqual(first["requestId"], "request_one")
            self.assertEqual(CONTROL.request(path, "request_two"), ("request_one", True))
            self.assertEqual(CONTROL.request(path, "request_four"), ("request_four", False))
            self.assertEqual(CONTROL.request(path, "request_three"), ("request_four", True))
            CONTROL.finish(path, first["runId"], "complete", "2026-10-04T12:00:00Z")
            self.assertEqual(CONTROL.request(path, "request_one"), ("request_one", True))
            second = CONTROL.claim(path)
            self.assertEqual(second["requestId"], "request_four")
            CONTROL.finish(path, second["runId"], "complete", "2026-10-04T12:01:00Z")
            self.assertEqual(CONTROL.request(path, "request_one"), ("request_one", True))
            self.assertEqual(CONTROL.status(path, "request_one")["outcome"], "complete")

    def test_lost_coalesced_ack_reuses_alias_without_queueing_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "refresh.json"
            self.assertEqual(CONTROL.request(path, "request_one"), ("request_one", False))
            self.assertEqual(CONTROL.request(path, "request_two"), ("request_one", True))
            active = CONTROL.claim(path)
            self.assertEqual(CONTROL.request(path, "request_two"), ("request_one", True))
            running = CONTROL.status(path, "request_two")
            self.assertEqual(running["requestId"], "request_two")
            self.assertEqual(running["acceptedRequestId"], "request_one")
            self.assertEqual(running["state"], "running")
            self.assertIsNone(CONTROL.claim(path))
            CONTROL.finish(path, active["runId"], "complete", "2026-10-04T12:00:00Z")
            completed = CONTROL.status(path, "request_two")
            self.assertEqual(completed["requestId"], "request_two")
            self.assertEqual(completed["acceptedRequestId"], "request_one")
            self.assertEqual(completed["state"], "complete")

    def test_recover_requeues_an_interrupted_accepted_request(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "refresh.json"
            CONTROL.request(path, "request_one")
            CONTROL.claim(path)
            CONTROL.request(path, "request_two")
            CONTROL.recover(path)
            recovered = CONTROL.claim(path)
            self.assertEqual(recovered["requestId"], "request_one")
            CONTROL.finish(path, recovered["runId"], "failed", "2026-10-04T12:02:00Z")
            self.assertEqual(CONTROL.status(path, "request_one")["state"], "failed")
            self.assertEqual(CONTROL.claim(path)["requestId"], "request_two")


if __name__ == "__main__":
    unittest.main()