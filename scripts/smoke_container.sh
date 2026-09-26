#!/usr/bin/env bash
set -euo pipefail

image=${1:?image tag is required}
platform=${2:?platform is required}
expected_machine=${3:?expected machine is required}
app_sha=${4:?app revision is required}
suffix=${platform#linux/}
name="folderframe-smoke-${suffix//\//-}"
work=$(mktemp -d)
config="$work/config"
library="$work/library"
archive="$work/archive"
mkdir -p "$config" "$library" "$archive"

cleanup() {
  docker logs "$name" 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

actual_arch=$(docker image inspect "$image" --format '{{.Architecture}}')
test "$actual_arch" = "${platform#linux/}"

docker run --rm --platform "$platform" -i --entrypoint python3 \
  -v "$library:/work" "$image" <<'PY'
from pathlib import Path
from PIL import Image, features
import pillow_heif

assert features.check("jpg")
assert features.check("webp")
pillow_heif.register_heif_opener()
extensions = Image.registered_extensions()
assert extensions.get(".heic") == "HEIF"
assert extensions.get(".heif") == "HEIF"
image = Image.new("RGB", (32, 24), (40, 120, 200))
exif = Image.Exif()
exif[306] = "2025:01:02 03:04:05"
exif[315] = "FolderFrame multiarch smoke"
image.save("/work/library.jpg", exif=exif)
image.save("/work/library.heic", format="HEIF", quality=80)
with Image.open("/work/library.heic") as decoded:
    decoded.load()
    assert decoded.size == (32, 24)
Path("/work/original-marker.txt").write_text("read-only originals\n", encoding="utf-8")
PY

docker run --rm --platform "$platform" -i --entrypoint python3 \
  -v "$archive:/work" "$image" <<'PY'
import base64
from pathlib import Path
Path("/work/archive.png").write_bytes(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
))
PY

docker run --rm --platform "$platform" --entrypoint sh \
  -v "$archive:/work" "$image" -c \
  'ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=64x48:rate=24 -f lavfi -i sine=frequency=440 -t 1 -c:v mpeg4 -c:a aac /work/fallback.mov'

before_library=$(sha256sum "$library/library.jpg" "$library/library.heic" "$library/original-marker.txt")
before_archive=$(sha256sum "$archive/archive.png" "$archive/fallback.mov")

docker run -d --name "$name" --platform "$platform" -p 127.0.0.1::8080 \
  -v "$config:/config" \
  -v "$library:/media/Library:ro" \
  -v "$archive:/media/Archive:ro" \
  -e FOLDERFRAME_SOURCE_LABEL=Gallery \
  -e FOLDERFRAME_STARTING_VIEW=all \
  -e FOLDERFRAME_DEFAULT_SORT=oldest \
  -e FOLDERFRAME_SLIDESHOW_INTERVAL=10 \
  -e FOLDERFRAME_IMAGE_MODE=original \
  -e FOLDERFRAME_AUTOPLAY=true \
  -e FOLDERFRAME_SHUFFLE=true \
  -e FOLDERFRAME_GALLERY_REFRESH_INTERVAL=77 \
  -e FOLDERFRAME_EMBED_REFRESH_INTERVAL=88 \
  -e FOLDERFRAME_REMEMBER_PREFERENCES=false \
  "$image" >/dev/null

machine=$(docker exec "$name" uname -m)
test "$machine" = "$expected_machine"
docker exec -i "$name" python3 - <<'PY'
from PIL import Image, features
import pillow_heif
assert features.check("jpg") and features.check("webp")
pillow_heif.register_heif_opener()
assert Image.registered_extensions().get(".heic") == "HEIF"
PY

host_port=$(docker port "$name" 8080/tcp | awk -F: 'NR == 1 { print $NF }')
base="http://127.0.0.1:$host_port"
curl --retry 30 --retry-all-errors --retry-delay 1 --retry-max-time 60 \
  --connect-timeout 2 --max-time 5 --fail "$base/" -o "$work/index.html"
for asset in docs/images/folderframe-logo.png docs/images/folderframe-logo-back.png docs/images/folderframe-icon.png styles.css app.js settings.js resilience.js vendor/heic-to-1.5.2/heic-to.js THIRD_PARTY_NOTICES.md; do
  curl --fail "$base/$asset" -o "$work/asset"
  test -s "$work/asset"
done
curl --fail "$base/photos/" -o "$work/listing.html"
grep -q 'Library' "$work/listing.html"
grep -q 'Archive' "$work/listing.html"
! grep -Eq 'cdrom|floppy|usb' "$work/listing.html"
curl --fail "$base/photos/Library/" -o "$work/library-listing.html"
curl --fail "$base/photos/Archive/" -o "$work/archive-listing.html"
grep -q 'library.jpg' "$work/library-listing.html"
grep -q 'library.heic' "$work/library-listing.html"
grep -q 'archive.png' "$work/archive-listing.html"
grep -q 'fallback.mov' "$work/archive-listing.html"
curl --fail "$base/app.js?v=smoke-${app_sha}" -o "$work/deployed-app.js"
curl --fail "$base/index.html?v=smoke-${app_sha}" -o "$work/deployed-index.html"
grep -q 'function cycleGridDensity' "$work/deployed-app.js"
grep -q 'function setScanProgressBar' "$work/deployed-app.js"
grep -q 'id="btn-grid-density"' "$work/deployed-index.html"
grep -q 'id="scan-progress-track"' "$work/deployed-index.html"
curl --fail "$base/folderframe.config.json" -o "$work/runtime-config.json"
docker exec -i "$name" python3 - <<'PY'
import json
c = json.load(open("/run/folderframe/folderframe.config.json", encoding="utf-8"))
assert c["sources"][0]["label"] == "Gallery"
assert c["sources"][0]["thumbnailPath"] == "thumbnails/"
assert c["sources"][0]["manifestPath"] == "folderframe-data/library.json"
assert c["defaults"]["gridDensity"] == "comfortable"
expected = {
    "view": "all", "sort": "oldest", "interval": 10,
    "imageMode": "original", "autoplay": True,
    "shuffle": True, "rememberPreferences": False,
}
for key, value in expected.items():
    assert c["defaults"].get(key) == value, (key, c["defaults"].get(key), value)
assert c["index"]["refreshInterval"] == 77
assert c["embed"]["refreshInterval"] == 88
PY

for attempt in $(seq 1 90); do
  if docker exec "$name" python3 -c 'import json; s=json.load(open("/config/folderframe-data/worker-status.json")); raise SystemExit(0 if s.get("outcome") in {"complete", "complete_with_warnings"} else 1)' 2>/dev/null; then
    break
  fi
  sleep 1
done

test -s "$config/thumbnails/Library/library.jpg.webp"
test -s "$config/thumbnails/Library/library.heic.webp"
test -s "$config/thumbnails/Archive/archive.png.webp"
test -s "$config/folderframe-data/exif.d/Library/library.jpg.json"
test -s "$config/folderframe-data/library.json"
docker exec -i "$name" python3 - <<'PY'
import json
from pathlib import Path
root = Path("/config/folderframe-data")
s = json.loads((root / "worker-status.json").read_text(encoding="utf-8"))
assert s["outcome"] in {"complete", "complete_with_warnings"}, s
assert s["mediaFiles"] == 4, s
assert s["thumbnailsGenerated"] >= 3, s
m = json.loads((root / "library.json").read_text(encoding="utf-8"))
assert m["version"] == 1
assert set(m["chunks"]) == {"Archive", "Library"}
records = {}
for descriptor in m["chunks"].values():
    chunk = json.loads((root / descriptor["file"]).read_text(encoding="utf-8"))
    for directory in chunk["directories"].values():
        records.update({record["path"]: record for record in directory["files"]})
assert {"Archive/archive.png", "Archive/fallback.mov", "Library/library.jpg", "Library/library.heic"} <= set(records)
assert records["Library/library.jpg"]["exifPath"] == "exif.d/Library/library.jpg.json"
PY

jpg_thumb_before=$(stat -c %Y "$config/thumbnails/Library/library.jpg.webp")
heic_thumb_before=$(stat -c %Y "$config/thumbnails/Library/library.heic.webp")
docker exec "$name" python3 /usr/share/folderframe/generate_thumbnails.py \
  /media /config/thumbnails \
  --manifest /config/folderframe-data/library.json \
  --failure-cache /config/folderframe-data/thumbnail-failures.json \
  --thumbnail-cache /config/folderframe-data/thumbnail-cache.json \
  --status-file /config/folderframe-data/worker-status.json
test "$(stat -c %Y "$config/thumbnails/Library/library.jpg.webp")" = "$jpg_thumb_before"
test "$(stat -c %Y "$config/thumbnails/Library/library.heic.webp")" = "$heic_thumb_before"
docker exec -i "$name" python3 - <<'PY'
import json
s = json.load(open("/config/folderframe-data/worker-status.json", encoding="utf-8"))
assert s["outcome"] == "complete", s
assert s["thumbnailsGenerated"] == 0, s
assert s["thumbnailsCurrent"] >= 3, s
assert s["metadataReused"] >= 3, s
PY

curl --fail "$base/thumbnails/Library/library.jpg.webp" -o "$work/library-thumb.webp"
curl --fail "$base/thumbnails/Library/library.heic.webp" -o "$work/heic-thumb.webp"
curl --fail "$base/folderframe-data/exif.d/Library/library.jpg.json" -o "$work/library-exif.json"
test -s "$work/library-thumb.webp"
test -s "$work/heic-thumb.webp"
docker exec "$name" python3 -c 'import json; assert json.load(open("/config/folderframe-data/exif.d/Library/library.jpg.json", encoding="utf-8"))["captureDate"]'
curl --fail --max-time 60 "$base/folderframe-api/transcode?path=Archive%2Ffallback.mov" -o "$work/fallback.mp4"
docker run --rm --platform "$platform" -i --entrypoint ffmpeg "$image" \
  -hide_banner -loglevel error -i pipe:0 -f null - < "$work/fallback.mp4"

if docker exec "$name" sh -c 'touch /media/Library/should-not-write'; then
  echo 'read-only media mount accepted a write' >&2
  exit 1
fi
after_library=$(sha256sum "$library/library.jpg" "$library/library.heic" "$library/original-marker.txt")
after_archive=$(sha256sum "$archive/archive.png" "$archive/fallback.mov")
test "$before_library" = "$after_library"
test "$before_archive" = "$after_archive"

docker restart "$name" >/dev/null
host_port=$(docker port "$name" 8080/tcp | awk -F: 'NR == 1 { print $NF }')
base="http://127.0.0.1:$host_port"
curl --retry 60 --retry-all-errors --retry-delay 1 --retry-max-time 60 --fail \
  "$base/folderframe.config.json" -o "$work/restarted-config.json"
cmp "$work/runtime-config.json" "$work/restarted-config.json"
test -s "$config/folderframe-data/library.json"
if docker run --rm --platform "$platform" -e FOLDERFRAME_STARTING_VIEW=invalid "$image" true; then
  echo 'invalid override unexpectedly succeeded' >&2
  exit 1
fi
if docker run --rm --platform "$platform" -e FOLDERFRAME_THUMBNAIL_INTERVAL=invalid "$image" true; then
  echo 'invalid thumbnail interval unexpectedly succeeded' >&2
  exit 1
fi
for path in .git/config MONETIZATION.md TODO_PRIVATE.md Dockerfile Caddyfile folderframe-data/secret.txt config/folderframe.config.json; do
  test "$(curl -s -o /dev/null -w '%{http_code}' "$base/$path")" = 404
done
