import pathlib
import unittest
import xml.etree.ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
PUBLIC_TEXT = [
    ROOT / "README.md",
    ROOT / "UNRAID.md",
    ROOT / "MAINTAINERS.md",
    ROOT / "compose.yaml",
    ROOT / ".env.example",
    ROOT / "templates" / "folderframe.xml",
    ROOT / "ca_profile.xml",
]
PRIVATE_MARKERS = (
    "grogpool",
    "/mnt/user/1/",
    "3e019c86-88d1-4b53-ac3c-2b03c9ee041f",
    "test-media",
    "folderframe-test",
)

class PublicMetadataTests(unittest.TestCase):
    def test_public_files_have_no_local_setup_markers(self):
        for path in PUBLIC_TEXT:
            text = path.read_text(encoding="utf-8").lower()
            for marker in PRIVATE_MARKERS:
                with self.subTest(path=path.name, marker=marker):
                    self.assertNotIn(marker, text)

    def test_unraid_template_is_general_and_safe(self):
        root = ET.parse(ROOT / "templates" / "folderframe.xml").getroot()
        self.assertEqual(root.findtext("Repository"), "ghcr.io/the-grog/folderframe-deployment:stable")
        self.assertEqual(root.findtext("Privileged"), "false")
        configs = {node.attrib["Name"]: node.attrib for node in root.findall("Config")}
        self.assertEqual(configs["Media Folder"]["Target"], "/media")
        self.assertEqual(configs["Media Folder"]["Mode"], "ro")
        self.assertEqual(configs["Media Folder"]["Default"], "")
        self.assertEqual(configs["Web Port"]["Target"], "8080")

    def test_community_apps_profile_is_complete(self):
        root = ET.parse(ROOT / "ca_profile.xml").getroot()
        self.assertTrue((root.findtext("Profile") or "").strip())
        self.assertTrue((root.findtext("Icon") or "").startswith("https://"))
        self.assertTrue((root.findtext("WebPage") or "").startswith("https://"))

    def test_compose_uses_external_read_only_media(self):
        text = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("source: ${MEDIA_PATH:?", text)
        self.assertIn("target: /media", text)
        self.assertIn("read_only: true", text)
        self.assertNotIn("privileged:", text)

if __name__ == "__main__":
    unittest.main()
