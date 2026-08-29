# FolderFrame Deployment

Docker and Unraid packaging for [FolderFrame](https://github.com/The-Grog/FolderFrame), a folder-based photo and video gallery served by Caddy.

## Quick start with Docker

Choose an existing directory containing only media you intend to expose. The mount is read-only, but anyone who can reach FolderFrame can download those files.

```sh
docker run -d \
  --name folderframe \
  --restart unless-stopped \
  -p 8088:8080 \
  --mount type=bind,source=/absolute/path/to/media,target=/media,readonly \
  ghcr.io/the-grog/folderframe-deployment:stable
```

Open `http://SERVER-IP:8088/`. Change the host port if 8088 is already in use.

## Quick start with Docker Compose

Copy `.env.example` to `.env`, set `MEDIA_PATH` to an absolute existing directory, then run:

```sh
docker compose up -d
```

See [Unraid installation](UNRAID.md) for the Unraid template.

## Configuration

| Setting | Container value | Purpose |
| --- | --- | --- |
| HTTP port | `8080/tcp` | Map any unused host port to this container port. |
| Media path | `/media` | Bind-mount a dedicated host media directory read-only. |

FolderFrame requires no database, appdata directory, privileged mode, host networking, PUID, or PGID.

## Image tags

- `stable`: latest stable FolderFrame release that passed deployment tests. Recommended for normal installs.
- `vX.Y.Z`: immutable application version tag for pinning and rollback.
- `build-<app-sha>-<deployment-sha>`: identifies both the app and packaging revisions.
- `test`: most recently tested build; intended for deployment testing rather than normal installs.

Updates never modify a running container automatically. Pull the image and recreate the container, or use your platform's container update function. Read the [FolderFrame releases](https://github.com/The-Grog/FolderFrame/releases) before updating.

## Security and exposure

- There is no authentication or TLS inside this container.
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
