# Unraid installation test

Template: templates/folderframe.xml

This template is not yet tested in the Unraid form or submitted to Community Apps.

Copy the XML to /boot/config/plugins/dockerMan/templates-user/my-folderframe.xml on Unraid, without overwriting an existing file. Then open Docker > Add Container and select folderframe.

Before Apply, choose an existing dedicated Media Folder and confirm the Web Port is unused. Port 8088 is currently used by folderframe-test: stop that container first or use a different verified port. The new container is named folderframe.

The /media mount is read-only. Do not mount an entire share, repository, private files or symlinks. Anyone who reaches this service can download its media. No authentication or TLS is configured. No appdata mount or privileged mode is needed.

Use WebUI after installing and verify photos, albums, video seeking and restart behavior.

The image is pinned to v0.6.1, so future app releases require changing the image tag. Choose a moving stable channel before Community Apps submission if desired. The release workflow never updates running containers.

Community Apps submission still requires repository profile metadata, validation and installation testing.
