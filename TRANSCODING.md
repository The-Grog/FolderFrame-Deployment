# Optional video compatibility streaming

Caddy continues serving images, original videos, thumbnails, and manifests.
A Python asyncio service listens only on loopback port 8081, reached through
Caddy's same-origin `/folderframe-api/*` route. No extra public port or user API
URL is needed. `service_runner.py` supervises Caddy, the API, and the existing
thumbnail worker, forwarding shutdown to their process groups and reaping them.

The browser tries every original natively. Only a MediaError decode/unsupported
source failure and a successful original HTTP check allow one fallback per
viewer load. Autoplay denial, missing files, network stalls, and timeouts do not
request conversion. Native-compatible MOV/MP4/HEVC files bypass FFmpeg entirely.
Static-only installations have no service and continue using normal recovery UI.

## Contract and settings

- `GET /folderframe-api/capabilities`: `{ "videoTranscode": true, "mediaPath": "/photos/" }`.
  Disabled service returns `videoTranscode: false`.
- `GET /folderframe-api/transcode?path=<URL-encoded path relative to /media>`:
  chunked fragmented MP4. Supports nested additional mounts under `/media/`.
- `FOLDERFRAME_VIDEO_TRANSCODE=true`: enable the optional fallback; `false`
  disables conversion and the endpoint returns 404.
- `FOLDERFRAME_TRANSCODE_JOBS=2`: maximum active jobs (1–8); excess requests get 503.
- `FOLDERFRAME_TRANSCODE_THREADS=2`: threads per FFmpeg decoder/encoder (1–16).
- Frontend `videoTranscodeFallback: "off"` can disable use per profile; default
  `"auto"` discovers the service without an API URL setting.

Every response uses `Cache-Control: no-store`. Errors before streaming use a
generic 400/403/404/415/502/503/504 response without host paths. Errors after
headers close an incomplete chunked response, leading to normal viewer recovery.

## FFmpeg command

The service invokes an argument array, not a shell. For ISO-BMFF/QuickTime the
command is equivalent to the following (the descriptor number is internal):

```sh
ffmpeg -hide_banner -loglevel error -nostdin \
  -threads 2 -protocol_whitelist file,pipe -f mov \
  -enable_drefs 0 -use_absolute_path 0 -i /proc/self/fd/FD \
  -map 0:v:0 -map '0:a:0?' -sn -dn -map_metadata -1 \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -vf 'scale=trunc(iw/2)*2:trunc(ih/2)*2' -threads 2 -g 48 \
  -c:a aac -b:a 128k -ac 2 \
  -movflags +frag_keyframe+empty_moov+default_base_moof \
  -frag_duration 1000000 -f mp4 pipe:1
```

WebM uses the Matroska demuxer and omits the MOV-specific dref options. Bytes
identify the container; extension alone never invokes conversion. No playlist
demuxers or external URL protocols are enabled. H.264/yuv420p + AAC stereo is
the compatibility output. Hardware acceleration is not implemented; no GPU
device/runtime or privileged mode is required. HDR/Dolby Vision color fidelity
is not guaranteed in this first compatibility path.

## Storage, load, seeking, and cleanup

FFmpeg streams stdout directly to the socket. It never creates converted files
in `/media`, `/config`, or appdata, and originals remain read-only. Only small
bounded pipe/socket buffers are used. The subprocess stream buffer is 64 KiB;
socket writes wait for backpressure. FFmpeg also has its own bounded codec
buffers; this is not a total process-memory guarantee.

Startup output has a 20-second deadline; stalled reads/writes have a 30-second
deadline. Disconnect detection runs concurrently with output reads. A client
leaving the viewer disconnects the request; the service terminates FFmpeg,
waits up to 2 seconds, then kills and reaps if needed. Container shutdown also
closes API handlers and stops the thumbnail worker and Caddy.

Transcoded output supports sequential playback, not arbitrary seeking/resume.
Range is ignored with a full 200 response and `Accept-Ranges: none`; the service
never fabricates byte ranges. Original-video seeking is unchanged. A paused
client that stops consuming output can time out and require Retry.

CPU and memory increase only while conversions are active. Two software jobs
can still be substantial for 4K iPhone media; set jobs to 1 on small machines.
Per-job threads and normal Docker CPU/memory controls can further limit load.

## Path protection

The query is decoded once as UTF-8. Absolute paths, traversal components,
control characters, backslashes, URLs, and protocol-like names are rejected.
The server canonicalizes beneath `/media`, rejects missing files/directories,
then opens each component with no-symlink flags. FFmpeg inherits the final
regular-file descriptor, closing the validation/open race. Symlinks are not
supported, even when they point inside `/media`. Spaces, Unicode, apostrophes,
parentheses, and nested folders remain valid.

The API has the same network visibility as the gallery. Existing advice to use
a trusted LAN or an authenticated external reverse proxy still applies.

## Packaging and validation

The pinned Caddy base remains unchanged; the tested FFmpeg package is pinned
to `8.0.1-r1` from Alpine 3.23. The image includes GPL/LGPL third-party components in addition to
MIT FolderFrame application code. `THIRD_PARTY_NOTICES.md` and `vendor/` include
the browser decoder's LGPL texts and corresponding source archives. Alpine
FFmpeg package/build sources are at https://gitlab.alpinelinux.org/alpine/aports
and FFmpeg source/license details at https://ffmpeg.org/legal.html.

Run `python3 -m unittest discover -s scripts -p 'test_*.py'` on Linux with FFmpeg
available, or inside the built image with `/work` mounted and its entrypoint
overridden. Tests generate synthetic video; no private user-media fixtures are
needed. Platform-specific Safari/Windows codec behavior needs device testing.

This deployment recipe requires the matching core release containing
`vendor/heic-to-1.5.2/` and the fallback client. Do not publish it against an older
release that still lacks those assets.
