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
    ROOT / "Dockerfile",
    ROOT / "Caddyfile",
    ROOT / "docker-entrypoint.sh",
    ROOT / "thumbnail_worker.py",
]
PRIVATE_MARKERS = (
    "grogpool",
    "/mnt/user/1/",
    "3e019c86-88d1-4b53-ac3c-2b03c9ee041f",
    "test-media",
    "folderframe-test",
)
UNRAID_OVERRIDES = {
    "Source Label": "FOLDERFRAME_SOURCE_LABEL",
    "Starting View": "FOLDERFRAME_STARTING_VIEW",
    "Default Sort": "FOLDERFRAME_DEFAULT_SORT",
    "Slideshow Interval": "FOLDERFRAME_SLIDESHOW_INTERVAL",
    "Image Display Mode": "FOLDERFRAME_IMAGE_MODE",
    "Start Automatically": "FOLDERFRAME_AUTOPLAY",
    "Shuffle by Default": "FOLDERFRAME_SHUFFLE",
    "Gallery Refresh Interval": "FOLDERFRAME_GALLERY_REFRESH_INTERVAL",
    "Embed Refresh Interval": "FOLDERFRAME_EMBED_REFRESH_INTERVAL",
    "Remember Browser Preferences": "FOLDERFRAME_REMEMBER_PREFERENCES",
}
THUMBNAIL_OVERRIDES = {
    "Generate Thumbnails": ("FOLDERFRAME_THUMBNAILS", "true"),
    "Persistent Media Manifest": ("FOLDERFRAME_MANIFEST", "true"),
    "Thumbnail Scan Interval": ("FOLDERFRAME_THUMBNAIL_INTERVAL", "3600"),
}


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
        self.assertEqual(configs["Appdata Configuration"]["Target"], "/config")
        self.assertEqual(configs["Appdata Configuration"]["Mode"], "rw")
        self.assertEqual(
            configs["Appdata Configuration"]["Default"],
            "/mnt/user/appdata/folderframe",
        )

    def test_unraid_template_has_exact_supported_overrides(self):
        root = ET.parse(ROOT / "templates" / "folderframe.xml").getroot()
        configs = {node.attrib["Name"]: node.attrib for node in root.findall("Config")}
        actual = {
            name: attrs["Target"]
            for name, attrs in configs.items()
            if attrs["Type"] == "Variable" and name not in THUMBNAIL_OVERRIDES
        }
        self.assertEqual(actual, UNRAID_OVERRIDES)
        for name in UNRAID_OVERRIDES:
            with self.subTest(name=name):
                self.assertEqual(configs[name]["Default"], "")
                self.assertEqual(configs[name]["Required"], "false")
        for name, (target, default) in THUMBNAIL_OVERRIDES.items():
            with self.subTest(name=name):
                self.assertEqual(configs[name]["Target"], target)
                self.assertEqual(configs[name]["Default"], default)

    def test_community_apps_profile_is_complete(self):
        root = ET.parse(ROOT / "ca_profile.xml").getroot()
        self.assertTrue((root.findtext("Profile") or "").strip())
        self.assertTrue((root.findtext("Icon") or "").startswith("https://"))
        self.assertTrue((root.findtext("WebPage") or "").startswith("https://"))

    def test_compose_uses_persistent_config_and_read_only_media(self):
        text = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("source: ${MEDIA_PATH:?", text)
        self.assertIn("target: /media", text)
        self.assertIn("read_only: true", text)
        self.assertIn("source: ${CONFIG_PATH:-./config}", text)
        self.assertIn("target: /config", text)
        for variable in UNRAID_OVERRIDES.values():
            with self.subTest(variable=variable):
                self.assertIn(f"{variable}:", text)
        self.assertIn('FOLDERFRAME_THUMBNAILS: "${FOLDERFRAME_THUMBNAILS:-true}"', text)
        self.assertIn('FOLDERFRAME_MANIFEST: "${FOLDERFRAME_MANIFEST:-true}"', text)
        self.assertIn('FOLDERFRAME_THUMBNAIL_INTERVAL: "${FOLDERFRAME_THUMBNAIL_INTERVAL:-3600}"', text)
        self.assertNotIn("privileged:", text)

    def test_container_serves_generated_config(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        caddyfile = (ROOT / "Caddyfile").read_text(encoding="utf-8")
        entrypoint = (ROOT / "docker-entrypoint.sh").read_text(encoding="utf-8")
        self.assertIn('VOLUME ["/config"]', dockerfile)
        self.assertIn('ENTRYPOINT ["/usr/bin/folderframe-entrypoint"]', dockerfile)
        self.assertIn("handle /folderframe.config.json", caddyfile)
        self.assertIn("handle_path /thumbnails/*", caddyfile)
        self.assertIn("FOLDERFRAME_THUMBNAIL_PATH:/config/thumbnails", caddyfile)
        self.assertIn("handle /folderframe-data/library.json", caddyfile)
        self.assertIn("rewrite * /library.json", caddyfile)
        self.assertIn("handle_path /folderframe-data/library.d/*", caddyfile)
        self.assertNotIn("handle_path /config/*", caddyfile)
        self.assertIn("root * /run/folderframe", caddyfile)
        self.assertIn("config_dir=/config", entrypoint)
        self.assertIn('persistent_config="$config_dir/folderframe.config.json"', entrypoint)
        self.assertIn("runtime_dir=/run/folderframe", entrypoint)
        self.assertIn('runtime_config="$runtime_dir/folderframe.config.json"', entrypoint)
        for variable in UNRAID_OVERRIDES.values():
            with self.subTest(variable=variable):
                self.assertIn(variable, entrypoint)
        self.assertIn("FOLDERFRAME_THUMBNAILS", entrypoint)
        self.assertIn("FOLDERFRAME_MANIFEST", entrypoint)
        self.assertIn('manifestPath = "folderframe-data/library.json"', entrypoint)
        self.assertIn("del(.thumbnailPath)", entrypoint)
        self.assertIn("del(.manifestPath)", entrypoint)
        self.assertIn("thumbnail_worker.py", entrypoint)
        self.assertIn("COPY upstream/generate_thumbnails.py", dockerfile)
        self.assertIn("pillow-heif==1.5.0", dockerfile)


if __name__ == "__main__":
    unittest.main()
