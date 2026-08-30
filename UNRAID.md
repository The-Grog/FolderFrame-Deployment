# Install FolderFrame on Unraid

FolderFrame is available in Unraid Community Apps and uses the tested `stable` image channel.

## Install from Community Apps

1. Open the **Apps** tab and search for **FolderFrame**.
2. Select FolderFrame.
3. Choose an existing dedicated **Media Folder** containing only media intended for this gallery.
4. Keep the default **Appdata Configuration** path or choose another persistent directory.
5. Choose an unused **Web Port**.
6. Optionally set any FolderFrame defaults. Leave an override blank to use `folderframe.config.json`.
7. Click **Apply**, then open the FolderFrame WebUI.

The media directory is mounted at `/media` read-only. Configuration is stored separately at `/config`.

## Persistent configuration

On first start, the container creates:

```text
/mnt/user/appdata/folderframe/folderframe.config.json
```

Edit that file for the complete FolderFrame configuration. It remains outside the image and survives container updates. The file is served to browsers, so do not put passwords, tokens, private filesystem paths, or other secrets in it.

The Unraid fields below provide optional overrides for common settings:

| Unraid field | Environment variable | JSON setting | Accepted values |
| --- | --- | --- | --- |
| Source Label | `FOLDERFRAME_SOURCE_LABEL` | `sources[0].label` | Any non-empty display label |
| Starting View | `FOLDERFRAME_STARTING_VIEW` | `defaults.view` | `folders`, `all` |
| Default Sort | `FOLDERFRAME_DEFAULT_SORT` | `defaults.sort` | `filename`, `newest`, `oldest` |
| Slideshow Interval | `FOLDERFRAME_SLIDESHOW_INTERVAL` | `defaults.interval` | `3`, `5`, `10`, `15`, `30`, `60`, `300`, `900`, `3600` |
| Image Display Mode | `FOLDERFRAME_IMAGE_MODE` | `defaults.imageMode` | `fit`, `original` |
| Start Automatically | `FOLDERFRAME_AUTOPLAY` | `defaults.autoplay` | `true`, `false` |
| Shuffle by Default | `FOLDERFRAME_SHUFFLE` | `defaults.shuffle` | `true`, `false` |
| Gallery Refresh Interval | `FOLDERFRAME_GALLERY_REFRESH_INTERVAL` | `index.refreshInterval` | Integer seconds from `1` to `86400` |
| Embed Refresh Interval | `FOLDERFRAME_EMBED_REFRESH_INTERVAL` | `embed.refreshInterval` | Integer seconds from `1` to `86400` |
| Remember Browser Preferences | `FOLDERFRAME_REMEMBER_PREFERENCES` | `defaults.rememberPreferences` | `true`, `false` |

Blank override fields defer to the persistent JSON file. Explicit overrides are applied to a generated runtime copy; the persistent JSON file is never rewritten.

FolderFrame resolves startup settings in this order: packaged defaults, persistent JSON, explicit container overrides, saved browser preferences, then URL parameters. If a changed default appears to have no effect, set **Remember Browser Preferences** to `false`, clear that browser's saved FolderFrame preferences, or test with `?remember=0`.

## Existing installations

Existing containers created before persistent configuration was added continue to run with packaged defaults. To customize them persistently, edit the container and add:

| Setting | Value |
| --- | --- |
| Config Type | Path |
| Name | Appdata Configuration |
| Container Path | `/config` |
| Host Path | `/mnt/user/appdata/folderframe` |
| Access Mode | Read/Write |

The default JSON file is created after the container starts. Existing containers might not automatically gain newer optional environment fields; add them manually or reinstall from the current Community Apps template if needed.

## Local template installation

For development or template testing, copy the XML into Unraid's user-template directory:

```sh
mkdir -p /boot/config/plugins/dockerMan/templates-user
cp /path/to/FolderFrame-Deployment/templates/folderframe.xml \
  /boot/config/plugins/dockerMan/templates-user/my-folderframe.xml
```

In the Unraid WebGUI, open **Docker > Add Container**, select **folderframe** from the Template list, and review every field before applying.

## Verify the installation

After applying the template:

1. Open **WebUI** from the container menu.
2. Confirm `/mnt/user/appdata/folderframe/folderframe.config.json` was created.
3. Confirm nested folders and images appear.
4. Change one container override, apply the edit, and verify it changes the startup default.
5. Restart the container and confirm the configuration and media return.
6. Edit the container and verify the `/media` mapping still shows **Read Only**.

## Updating

The template uses `ghcr.io/the-grog/folderframe-deployment:stable`. Use **Docker > Check for Updates**, review the FolderFrame release notes, and update when ready. Unraid recreates the container while preserving the external media and appdata directories.

For rollback, edit the Repository field to a known version tag such as `ghcr.io/the-grog/folderframe-deployment:v0.6.3`, then Apply.

## Security

FolderFrame has no built-in authentication or TLS. Anyone who can reach it can browse and download mounted media and read the served configuration. Keep it on a trusted network unless a separate access layer provides authentication and TLS. Never mount an entire share, repository, secrets, private files, or symlinks to private locations.
