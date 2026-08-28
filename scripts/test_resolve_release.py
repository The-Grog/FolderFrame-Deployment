import unittest
import urllib.error
from resolve_release import resolve

class ReleaseTests(unittest.TestCase):
    def test_published_release_resolves_commit(self):
        def fetch(path):
            return {"tag_name": "v0.1.0", "draft": False, "prerelease": False} if path == "/releases/latest" else {"sha": "a" * 40}
        self.assertEqual(resolve(fetch), {"tag": "v0.1.0", "sha": "a" * 40})

    def test_no_release_checks_repository_access(self):
        calls = []
        def fetch(path):
            calls.append(path)
            if path:
                raise urllib.error.HTTPError(path, 404, "Not found", {}, None)
            return {"full_name": "The-Grog/FolderFrame"}
        self.assertIsNone(resolve(fetch))
        self.assertEqual(calls, ["/releases/latest", ""])

    def test_auth_failure_is_not_no_release(self):
        def fetch(path):
            raise urllib.error.HTTPError(path, 403, "Forbidden", {}, None)
        with self.assertRaises(urllib.error.HTTPError):
            resolve(fetch)

    def test_drafts_prereleases_and_unsafe_tags_rejected(self):
        for release in [
            {"tag_name": "v1", "draft": True},
            {"tag_name": "v1", "prerelease": True},
            {"tag_name": "v1\nsha=evil"},
        ]:
            with self.subTest(release=release), self.assertRaises(ValueError):
                resolve(lambda path: release)

    def test_non_commit_ref_rejected(self):
        with self.assertRaises(ValueError):
            resolve(lambda path: {"tag_name": "v1"} if path == "/releases/latest" else {"sha": "main"})

if __name__ == "__main__":
    unittest.main()
