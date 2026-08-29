# Install FolderFrame on Unraid

The template is available at `templates/folderframe.xml`. It uses the tested `stable` image channel.

## Local template installation

Copy the template into Unraid's user-template directory:

```sh
mkdir -p /boot/config/plugins/dockerMan/templates-user
cp /path/to/FolderFrame-Deployment/templates/folderframe.xml \
  /boot/config/plugins/dockerMan/templates-user/my-folderframe.xml
```

In the Unraid WebGUI, open **Docker > Add Container**, select **folderframe** from the Template list, and review every field before applying.

## Required settings

- **Web Port:** an unused host port. The template suggests 8088 and maps it to container port 8080.
- **Media Folder:** an existing dedicated directory containing only media intended for this gallery. It is mounted at `/media` read-only.

No appdata mapping, database, privileged mode, host network, PUID, or PGID is required.

## Verify the installation

After applying the template:

1. Open **WebUI** from the container menu.
2. Confirm nested folders and images appear.
3. Test video playback and seeking with a browser-compatible sample.
4. Restart the container and confirm the same media returns.
5. Edit the container and verify the `/media` mapping still shows **Read Only**.

## Updating

The template uses `ghcr.io/the-grog/folderframe-deployment:stable`. Use **Docker > Check for Updates**, review the FolderFrame release notes, and update when ready. Unraid recreates the container while preserving the external media directory.

For rollback, edit the Repository field to a known version tag such as `ghcr.io/the-grog/folderframe-deployment:v0.6.3`, then Apply.

## Security

FolderFrame has no built-in authentication or TLS. Anyone who can reach it can download the mounted media. Keep it on a trusted network unless a separate access layer provides authentication and TLS. Never mount an entire share, repository, secrets, private files, or symlinks to private locations.

## Community Apps status

The repository includes template and profile metadata, but maintainers must still validate, scan, and complete review through the official Community Apps submission portal.
