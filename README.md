# FolderFrame Deployment

Docker and Unraid packaging for [FolderFrame](https://www.folderframe.com/), a folder-based photo and video gallery served by Caddy. Source code for the app is available in the [FolderFrame repository](https://github.com/The-Grog/FolderFrame).

## Quick start with Docker

Choose an existing directory containing only media you intend to expose, plus a persistent configuration directory. The media mount is read-only, but anyone who can reach FolderFrame can download those files.

```sh
mkdir -p /absolute/path/to/folderframe-config

docker run -d \
  --name folderframe \
  --restart unless-stopped \
  -p 8088:8080 \
  --mount type=bind,source=/absolute/path/to/media,target=/media,readonly \
  --mount type=bind,source=/absolute/path/to/folderframe-config,target=/config \
  ghcr.io/the-grog/folderframe-deployment:stable
```

Open `http://SERVER-IP:8088/`. Change the host port if 8088 is already in use.

Thumbnail generation and the persistent media manifest are enabled by default.
They are stored below `/config` and survive image updates. Originals stay
read-only. Use `-e FOLDERFRAME_THUMBNAILS=false` or
`-e FOLDERFRAME_MANIFEST=false` to disable either feature independently. Both
use `FOLDERFRAME_THUMBNAIL_INTERVAL` (default 3600 seconds).

## Quick start with Docker Compose

Copy `.env.example` to `.env`, set `MEDIA_PATH` to an absolute existing directory, and optionally set `CONFIG_PATH` or common FolderFrame overrides. Then run:

```sh
docker compose up -d
```

The default `CONFIG_PATH` is `./config`. The container creates `folderframe.config.json` there on first start.
Compose enables persistent thumbnails and the media manifest by default. Set
`FOLDERFRAME_THUMBNAILS=false` or `FOLDERFRAME_MANIFEST=false` in `.env` to
disable either one.

## Install from Unraid Community Apps

**Available in Unraid Community Apps.**

1. Open the **Apps** tab in Unraid and search for **FolderFrame**.
2. Select FolderFrame.
3. Choose the host media folder that FolderFrame should display. It is mounted read-only inside the container.
4. Keep the default appdata configuration path or choose another persistent directory.
5. Choose an unused host port for the WebUI.
6. Optionally set common FolderFrame defaults; blank fields use the persistent JSON configuration.
7. Click **Apply**, then open the FolderFrame WebUI.

See [Unraid installation](UNRAID.md) for field details, updates, and troubleshooting.

## Configuration

| Setting | Container value | Purpose |
| --- | --- | --- |
| HTTP port | `8080/tcp` | Map any unused host port to this container port. |
| Media path | `/media` | Bind-mount a dedicated host media directory read-only. |
| Configuration path | `/config` | Bind-mount a persistent directory read/write. The default JSON file is created on first start. |
| Thumbnail cache | `/config/thumbnails` | Generated WebP previews inside the persistent configuration mount. |
| Media manifest | `/config/folderframe-data/library.json` | Persistent root index; chunks are stored in `library.d/`. |

FolderFrame requires no database, privileged mode, host networking, PUID, or
PGID. The appdata/configuration directory contains administrator-managed
configuration and, by default, generated thumbnails and manifest files.

Common settings can be supplied with the environment variables documented in [Unraid installation](UNRAID.md). Blank variables defer to `/config/folderframe.config.json`; explicit variables override the corresponding JSON values without rewriting that file.

## Persistent thumbnails and media manifest

One background worker invokes the release-provided `generate_thumbnails.py`
helper at startup and at the configured interval.

- `FOLDERFRAME_THUMBNAILS`: `true` by default. Writes WebP previews under
  `/config/thumbnails` and adds `thumbnailPath: "thumbnails/"` at runtime.
- `FOLDERFRAME_MANIFEST`: `true` by default. Writes
  `/config/folderframe-data/library.json` plus `library.d/*.json` and adds
  `manifestPath: "folderframe-data/library.json"` at runtime.
- `FOLDERFRAME_THUMBNAIL_INTERVAL`: shared scan interval, default `3600`
  seconds (range `60`-`86400`).
- `FOLDERFRAME_THUMBNAIL_SIZE`: maximum edge, default `480` (range
  `64`-`4096`); `FOLDERFRAME_THUMBNAIL_QUALITY`: default `80`.

Both enabled uses one thumbnail-plus-manifest helper run. Manifest only uses
`--manifest-only`; thumbnails only omits manifest arguments. Unchanged
manifest directories are reused by directory mtime. New, changed, and deleted
folders appear on the next scan, and stale manifest chunks are removed. A
missing or invalid manifest causes a logged full rebuild. Helper failures are
logged but do not stop Caddy.

JPEG, PNG, WebP, GIF, HEIC, and HEIF thumbnails are supported through Pillow
and pillow-heif. Videos are indexed but do not receive generated thumbnails.
Original media is never modified.

For large Immich libraries, the first scan can take substantial time and
appdata space. Later runs reuse unchanged directory records. Use a conservative
interval for large arrays. `scanCache` remains a separate browser option and
is neither required nor replaced by this manifest.

To force a full manifest rebuild, stop the container, delete only
`/config/folderframe-data/library.json` and
`/config/folderframe-data/library.d/` from appdata, then start it. Deleting
all appdata also resets custom configuration and thumbnails; first startup
recreates defaults and performs a full scan.

Advanced overrides are `FOLDERFRAME_MEDIA_PATH`,
`FOLDERFRAME_THUMBNAIL_PATH`, and `FOLDERFRAME_MANIFEST_PATH`. Keep the
manifest filename `library.json`; public access is deliberately limited to
`/folderframe-data/library.json`, `/folderframe-data/library.d/*.json`, and
the thumbnail route.

## Image tags

- `stable`: latest stable FolderFrame release that passed deployment tests. Recommended for normal installs.
- `vX.Y.Z`: immutable application version tag for pinning and rollback.
- `build-<app-sha>-<deployment-sha>`: identifies both the app and packaging revisions.
- `test`: most recently tested build; intended for deployment testing rather than normal installs.

Updates never modify a running container automatically. Pull the image and recreate the container, or use your platform's container update function. Read the [FolderFrame releases](https://github.com/The-Grog/FolderFrame/releases) before updating.

## Security and exposure

- There is no authentication or TLS inside this container.
- The generated configuration is publicly readable by anyone who can reach the app. Never put secrets in it.
- Anyone who can reach the service can browse and download mounted media.
- Use a dedicated media directory. Do not mount a whole share, home directory, source repository, secrets, or symlinks to private locations.
- Read-only prevents writes from the container; it does not prevent downloads.
- Keep the service on a trusted network unless you add authentication and TLS through a separately managed reverse proxy or access layer.
- Do not run privileged or expose the Caddy admin API.

## What the image contains

The image contains Caddy plus an explicit allowlist of FolderFrame runtime assets fetched from a published release. It contains no sample media, personal paths, repository metadata, or private planning files.

## Support

Report packaging, Docker, and Unraid issues in [FolderFrame Deployment issues](https://github.com/The-Grog/FolderFrame-Deployment/issues). Report application behavior in [FolderFrame issues](https://github.com/The-Grog/FolderFrame/issues).

Maintainer release and verification procedures are documented in [MAINTAINERS.md](MAINTAINERS.md).
