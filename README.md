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

Thumbnail generation is enabled by default. Persistent 480px WebP previews are
written to the mounted configuration directory under `thumbnails/`; originals
remain read-only. Add `-e FOLDERFRAME_THUMBNAILS=false` to disable generation.
Optional tuning variables are `FOLDERFRAME_THUMBNAIL_INTERVAL` (default 3600
seconds), `FOLDERFRAME_THUMBNAIL_SIZE` (480), and
`FOLDERFRAME_THUMBNAIL_QUALITY` (80).

## Quick start with Docker Compose

Copy `.env.example` to `.env`, set `MEDIA_PATH` to an absolute existing directory, and optionally set `CONFIG_PATH` or common FolderFrame overrides. Then run:

```sh
docker compose up -d
```

The default `CONFIG_PATH` is `./config`. The container creates `folderframe.config.json` there on first start.
Compose enables persistent thumbnail generation by default. Set
`FOLDERFRAME_THUMBNAILS=false` in `.env` to disable it; interval, size, and
quality examples are included in `.env.example`.

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
| Thumbnail cache | `/config/thumbnails` | Generated WebP previews, created automatically inside the persistent configuration mount. |

FolderFrame requires no database, privileged mode, host networking, PUID, or
PGID. The appdata/configuration directory contains administrator-managed
configuration and, by default, generated thumbnail cache files.

Common settings can be supplied with the environment variables documented in [Unraid installation](UNRAID.md). Blank variables defer to `/config/folderframe.config.json`; explicit variables override the corresponding JSON values without rewriting that file.

## Automatic thumbnails

The container scans `/media` in the background and generates missing or
changed grid previews sequentially. FolderFrame remains usable during the
initial scan: missing previews fall back to original media until their WebP is
ready. Current previews are skipped on later scans.

- `FOLDERFRAME_THUMBNAILS`: `true` by default; set `false` to stop
  generation and omit the automatic `thumbnailPath` runtime setting.
- `FOLDERFRAME_THUMBNAIL_INTERVAL`: seconds between scans, default `3600`
  (accepted range `60`–`86400`).
- `FOLDERFRAME_THUMBNAIL_SIZE`: maximum edge, default `480` pixels
  (accepted range `64`–`2048`).
- `FOLDERFRAME_THUMBNAIL_QUALITY`: WebP quality, default `80`
  (accepted range `1`–`100`).
- `FOLDERFRAME_THUMBNAIL_DELAY_MS`: pause after each generated preview,
  default `50` ms.
- `FOLDERFRAME_THUMBNAIL_PRUNE_GRACE`: minimum age before removing an
  orphaned preview, default `86400` seconds.

JPEG, PNG, WebP, GIF, HEIC, and HEIF inputs are supported through libvips and
libheif. Unsupported or damaged files are logged and FolderFrame falls back to
their originals. Orphan cleanup runs only after a complete media scan; a failed
or interrupted mount scan never clears the cache.

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
