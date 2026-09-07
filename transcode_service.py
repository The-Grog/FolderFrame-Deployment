#!/usr/bin/env python3
"""Optional loopback-only, bounded FFmpeg stdout streaming. No output files."""
import asyncio
import json
import os
from pathlib import Path
import re
import signal
import stat
from urllib.parse import parse_qs, urlsplit


class RequestError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def open_media(root, name):
    """Resolve beneath the root and open each component without following links.

    The final descriptor is inherited by FFmpeg, preventing path replacement
    between validation and launch. Filenames never become shell commands.
    """
    if not name or len(name.encode('utf-8')) > 4096 or name.startswith('/') or ':' in name or '\\' in name or any(ord(c) < 32 for c in name):
        raise RequestError(400, 'Invalid media path')
    parts = name.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise RequestError(400, 'Invalid media path')
    try:
        resolved_root = Path(root).resolve(strict=True)
        candidate = (resolved_root / name).resolve(strict=True)
        if not candidate.is_relative_to(resolved_root):
            raise RequestError(403, 'Media path is not allowed')
        parent = os.open(resolved_root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent)
                parent = child
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally:
            os.close(parent)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise RequestError(400, 'Media must be a regular file')
        return fd
    except FileNotFoundError:
        raise RequestError(404, 'Media not found') from None
    except (OSError, ValueError, RuntimeError):
        raise RequestError(403, 'Media path is not allowed') from None


def input_format(fd):
    header = os.pread(fd, 64, 0)
    if len(header) >= 8 and header[4:8] in (b'ftyp', b'moov', b'mdat', b'wide', b'free', b'skip'):
        return 'mov'
    if header.startswith(b'\x1a\x45\xdf\xa3'):
        return 'matroska'
    raise RequestError(415, 'Unsupported video container')


def ffmpeg_command(fd, container, threads=2, executable='ffmpeg'):
    # Force a local media demuxer: playlists and alternate input protocols are
    # never interpreted, even if their file extensions look like a video.
    command = [executable, '-hide_banner', '-loglevel', 'error', '-nostdin',
               '-threads', str(threads), '-protocol_whitelist', 'file,pipe', '-f', container]
    if container == 'mov':
        command += ['-enable_drefs', '0', '-use_absolute_path', '0']
    return command + ['-i', f'/proc/self/fd/{fd}', '-map', '0:v:0', '-map', '0:a:0?',
        '-sn', '-dn', '-map_metadata', '-1', '-c:v', 'libx264', '-preset', 'veryfast',
        '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-threads', str(threads), '-g', '48', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1']


async def terminate(process):
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(process.wait(), 2)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        await process.wait()


class TranscodeService:
    def __init__(self, root='/media', enabled=True, limit=2, threads=2,
                 startup_timeout=20, stall_timeout=30, executable='ffmpeg'):
        self.root, self.enabled, self.limit, self.threads = root, enabled, limit, threads
        self.startup_timeout, self.stall_timeout = startup_timeout, stall_timeout
        self.executable = executable
        self.active = 0
        self.processes = set()
        self.tasks = set()

    async def reply(self, writer, status, value):
        body = json.dumps(value).encode()
        writer.write((f'HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\n'
                      f'Content-Length: {len(body)}\r\nCache-Control: no-store\r\n'
                      'Connection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n').encode() + body)
        await asyncio.wait_for(writer.drain(), 5)

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.tasks.add(task)
        process = None
        disconnected = None
        fd = None
        admitted = started = False
        try:
            header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
            if len(header) > 16384:
                raise RequestError(431, 'Request too large')
            method, target, version = header.split(b'\r\n', 1)[0].decode('ascii').split(' ')
            if method != 'GET' or not target.startswith('/') or target.startswith('//'):
                raise RequestError(405, 'GET required')
            parsed = urlsplit(target)
            if parsed.path == '/folderframe-api/capabilities':
                await self.reply(writer, 200, {'videoTranscode': self.enabled, 'mediaPath': '/photos/'})
                return
            if parsed.path != '/folderframe-api/transcode' or not self.enabled:
                raise RequestError(404, 'Service unavailable')
            # We provide sequential streams, not byte-addressable proxy files.
            # Ignore Range and always return a full 200 stream, never fake 206.
            if re.search(r'%(?![0-9a-fA-F]{2})', parsed.query):
                raise RequestError(400, 'Invalid media path')
            query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True, encoding='utf-8', errors='strict')
            if set(query) != {'path'} or len(query['path']) != 1:
                raise RequestError(400, 'One media path is required')
            if self.active >= self.limit:
                raise RequestError(503, 'Transcoder busy; try again later')
            fd = open_media(self.root, query['path'][0])
            container = input_format(fd)
            self.active += 1
            admitted = True
            disconnected = asyncio.create_task(reader.read(1))
            try:
                launch = asyncio.create_task(asyncio.create_subprocess_exec(
                    *ffmpeg_command(fd, container, self.threads, self.executable),
                    stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, pass_fds=(fd,), limit=65536))
                try:
                    process = await asyncio.shield(launch)
                except asyncio.CancelledError:
                    # Shutdown can race process creation. Capture the child so
                    # the finally block still terminates and reaps it.
                    process = await launch
                    raise
            except OSError:
                raise RequestError(502, 'Video converter could not start') from None
            self.processes.add(process)
            os.close(fd)
            fd = None
            while True:
                read = asyncio.create_task(process.stdout.read(65536))
                try:
                    done, _ = await asyncio.wait((read, disconnected),
                        timeout=self.stall_timeout if started else self.startup_timeout,
                        return_when=asyncio.FIRST_COMPLETED)
                    if disconnected in done:
                        return
                    if read not in done:
                        raise RequestError(504, 'Video conversion stalled')
                    chunk = read.result()
                finally:
                    if not read.done():
                        read.cancel()
                        await asyncio.gather(read, return_exceptions=True)
                if not chunk:
                    code = await asyncio.wait_for(process.wait(), 2)
                    if not started or code:
                        raise RequestError(502, 'Video could not be converted')
                    writer.write(b'0\r\n\r\n')
                    await asyncio.wait_for(writer.drain(), self.stall_timeout)
                    return
                if not started:
                    writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\n'
                                 b'Transfer-Encoding: chunked\r\nCache-Control: no-store\r\n'
                                 b'Accept-Ranges: none\r\nConnection: close\r\n'
                                 b'X-Content-Type-Options: nosniff\r\n\r\n')
                    started = True
                writer.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                await asyncio.wait_for(writer.drain(), self.stall_timeout)
        except RequestError as error:
            if not started:
                await self.reply(writer, error.status, {'error': error.message})
            # After headers, close the incomplete chunked response. The browser
            # reports a media error and the viewer never attempts fallback twice.
        except (ValueError, UnicodeError, asyncio.LimitOverrunError):
            if not started:
                await self.reply(writer, 400, {'error': 'Invalid request'})
        except (ConnectionError, asyncio.IncompleteReadError, asyncio.TimeoutError):
            pass
        finally:
            if disconnected:
                disconnected.cancel()
                await asyncio.gather(disconnected, return_exceptions=True)
            if process:
                await terminate(process)
                self.processes.discard(process)
            if fd is not None:
                os.close(fd)
            if admitted:
                self.active -= 1
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), 2)
            except (ConnectionError, asyncio.TimeoutError):
                pass
            self.tasks.discard(task)

    async def close(self):
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def integer_setting(name, default, maximum):
    value = int(os.environ.get(name, default))
    if not 1 <= value <= maximum:
        raise ValueError(f'{name} is outside its allowed range')
    return value


async def main():
    enabled = os.environ.get('FOLDERFRAME_VIDEO_TRANSCODE', 'true')
    if enabled not in ('true', 'false'):
        raise ValueError('FOLDERFRAME_VIDEO_TRANSCODE must be true or false')
    service = TranscodeService(enabled=enabled == 'true',
        limit=integer_setting('FOLDERFRAME_TRANSCODE_JOBS', 2, 8),
        threads=integer_setting('FOLDERFRAME_TRANSCODE_THREADS', 2, 16))
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    server = await asyncio.start_server(service.handle, '127.0.0.1', 8081, limit=16384)
    print('FolderFrame video fallback service ready', flush=True)
    async with server:
        await stopped.wait()
    await service.close()


if __name__ == '__main__':
    asyncio.run(main())
