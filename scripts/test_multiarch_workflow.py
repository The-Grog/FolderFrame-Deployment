import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_image_index", ROOT / "scripts" / "verify_image_index.py")
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class MultiArchitectureWorkflowTests(unittest.TestCase):
    def test_required_platforms_are_exactly_amd64_and_arm64(self):
        self.assertEqual(VERIFY.REQUIRED_PLATFORMS, {("linux", "amd64"), ("linux", "arm64")})

    def test_index_verifier_accepts_required_platforms_and_ignores_attestations(self):
        payload = {
            "manifests": [
                {"platform": {"os": "linux", "architecture": "amd64"}},
                {"platform": {"os": "unknown", "architecture": "unknown"}},
                {"platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}},
            ]
        }
        self.assertEqual(VERIFY.platforms(payload), {
            ("linux", "amd64"), ("unknown", "unknown"), ("linux", "arm64")
        })

    def test_index_verifier_rejects_partial_platform_set(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "index.json"
            path.write_text(json.dumps({
                "manifests": [{"platform": {"os": "linux", "architecture": "amd64"}}]
            }), encoding="utf-8")
            with mock.patch.object(VERIFY.sys, "argv", ["verify_image_index.py", str(path)]):
                with self.assertRaisesRegex(SystemExit, "linux/arm64"):
                    VERIFY.main()

    def test_publish_workflow_tests_exact_candidates_before_promotion(self):
        workflow = (ROOT / ".github" / "workflows" / "publish.yml").read_text(encoding="utf-8")
        self.assertIn("docker/setup-qemu-action@", workflow)
        self.assertIn("docker/setup-buildx-action@", workflow)
        self.assertEqual(workflow.count("docker/build-push-action@"), 2)
        self.assertIn("platforms: linux/amd64", workflow)
        self.assertIn("platforms: linux/arm64", workflow)
        self.assertIn("cache-to: type=gha,mode=max,scope=folderframe-smoke-amd64", workflow)
        self.assertIn("cache-to: type=gha,mode=max,scope=folderframe-smoke-arm64", workflow)
        self.assertIn("steps.build_amd64.outputs.digest", workflow)
        self.assertIn("steps.build_arm64.outputs.digest", workflow)
        self.assertIn('scripts/smoke_container.sh "$image" linux/amd64', workflow)
        self.assertIn('scripts/smoke_container.sh "$image" linux/arm64', workflow)
        self.assertIn("Assemble and verify candidate image index", workflow)
        self.assertIn("Promote verified candidate to release tags", workflow)
        self.assertIn('imagetools create --tag "$image:$tag" "$image@$CANDIDATE_DIGEST"', workflow)
        self.assertIn('test "$digest" = "$CANDIDATE_DIGEST"', workflow)
        self.assertNotIn("--platform linux/amd64,linux/arm64 --push", workflow)
        self.assertNotIn("linux/arm/v7", workflow)

        build_amd64 = workflow.index("Build immutable amd64 candidate")
        smoke_amd64 = workflow.index("Smoke-test immutable amd64 candidate")
        build_arm64 = workflow.index("Build immutable arm64 candidate")
        smoke_arm64 = workflow.index("Smoke-test immutable arm64 candidate")
        verify = workflow.index("Assemble and verify candidate image index")
        promote = workflow.index("Promote verified candidate to release tags")
        self.assertLess(build_amd64, smoke_amd64)
        self.assertLess(smoke_amd64, build_arm64)
        self.assertLess(build_arm64, smoke_arm64)
        self.assertLess(smoke_arm64, verify)
        self.assertLess(verify, promote)

    def test_smoke_test_exercises_real_media_paths(self):
        smoke = (ROOT / "scripts" / "smoke_container.sh").read_text(encoding="utf-8")
        for expected in (
            'format="HEIF"', "library.heic.webp", "library.jpg.webp",
            "metadataReused", "worker-status.json", "folderframe-api/transcode",
            "read-only media mount accepted a write", "uname -m",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, smoke)


if __name__ == "__main__":
    unittest.main()
