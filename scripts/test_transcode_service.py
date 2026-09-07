import asyncio
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import quote
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('transcode_service', ROOT / 'transcode_service.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


@unittest.skipUnless(os.name == 'posix' and Path('/proc/self/fd').exists(), 'Linux descriptor containment required')
class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.media = self.root / 'media'
        self.media.mkdir()
        self.service = api.TranscodeService(self.media, startup_timeout=2, stall_timeout=2)
        self.server = await asyncio.start_server(self.service.handle, '127.0.0.1', 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.original = self.media / 'tiny.mov'
        self.original.write_bytes(b'\x00\x00\x00\x18ftypqt  ' + bytes(12))

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        await self.service.close()
        self.temp.cleanup()

    async def connect(self, path, extra=''):
        reader, writer = await asyncio.open_connection('127.0.0.1', self.port)
        writer.write(f'GET {path} HTTP/1.1\r\nHost: localhost\r\n{extra}\r\n'.encode())
        await writer.drain()
        return reader, writer

    async def request(self, path):
        reader, writer = await self.connect(path)
        result = await asyncio.wait_for(reader.read(), 5)
        writer.close()
        await writer.wait_closed()
        return result

    async def test_capability_and_disable(self):
        result = await self.request('/folderframe-api/capabilities')
        self.assertIn(b'"videoTranscode": true', result)
        self.assertIn(b'Cache-Control: no-store', result)
        self.service.enabled = False
        self.assertIn(b'"videoTranscode": false', await self.request('/folderframe-api/capabilities'))
        self.assertIn(b'404', await self.request('/folderframe-api/transcode?path=tiny.mov'))

    async def test_paths_and_protocols_are_rejected_without_internal_details(self):
        outside = self.root / 'outside.mov'
        outside.write_bytes(self.original.read_bytes())
        (self.media / 'link.mov').symlink_to(outside)
        (self.media / 'directory').mkdir()
        for name in ['../../etc/passwd', '/etc/passwd', 'file:///etc/passwd',
                     'http://example.com/video.mp4', 'https://example.com/video.mp4',
                     'pipe:1', 'concat:a|b', 'directory', 'missing.mov', 'link.mov',
                     'a/../tiny.mov', 'a\\b', '\x00bad']:
            result = await self.request('/folderframe-api/transcode?path=' + quote(name, safe=''))
            self.assertNotIn(b'200 OK', result, name)
            self.assertNotIn(str(self.root).encode(), result)
            self.assertEqual(self.service.active, 0)
        self.assertIn(b'400', await self.request('/folderframe-api/transcode?path=%2e%2e%2fetc%2fpasswd'))
        self.assertIn(b'400', await self.request('/folderframe-api/transcode?path=%ZZ'))
        (self.media / 'playlist.mov').write_text('file /etc/passwd')
        self.assertIn(b'415', await self.request('/folderframe-api/transcode?path=playlist.mov'))

    async def test_nested_special_names_preserve_descriptor_identity(self):
        for name in ['nested/space here.mov', '日本/été.mp4', "nested/O'Brien (copy).mov"]:
            path = self.media / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.original.read_bytes())
            fd = api.open_media(self.media, name)
            try:
                self.assertEqual(api.input_format(fd), 'mov')
                self.assertEqual(os.pread(fd, 64, 0), self.original.read_bytes())
            finally:
                os.close(fd)

    async def test_busy_launch_failure_and_no_cache(self):
        self.service.active = self.service.limit
        self.assertIn(b'503', await self.request('/folderframe-api/transcode?path=tiny.mov'))
        self.service.active = 0
        self.service.executable = '/no-such-folderframe-ffmpeg'
        result = await self.request('/folderframe-api/transcode?path=tiny.mov')
        self.assertIn(b'502', result)
        self.assertNotIn(b'/no-such', result)
        self.assertEqual(self.service.active, 0)
        self.assertEqual(list(self.media.iterdir()), [self.original])

    async def test_startup_timeout_reaps_process(self):
        real_spawn = asyncio.create_subprocess_exec
        processes = []
        async def stalled(*args, **kwargs):
            proc = await real_spawn('sleep', '60', **kwargs)
            processes.append(proc)
            return proc
        self.service.startup_timeout = 0.05
        with patch.object(api.asyncio, 'create_subprocess_exec', stalled):
            self.assertIn(b'504', await self.request('/folderframe-api/transcode?path=tiny.mov'))
        self.assertIsNotNone(processes[0].returncode)
        self.assertEqual(self.service.active, 0)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required for real streaming test')
    async def test_real_ffmpeg_stream_decodes_and_disconnect_stops_process(self):
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=24',
            '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2',
            '-c:v', 'mpeg4', '-c:a', 'aac', str(self.original)], check=True)
        before = {p.name: p.read_bytes() for p in self.media.iterdir()}
        response = await self.request('/folderframe-api/transcode?path=tiny.mov')
        header, chunks = response.split(b'\r\n\r\n', 1)
        self.assertIn(b'200 OK', header)
        self.assertIn(b'Accept-Ranges: none', header)
        payload = bytearray()
        while chunks:
            line, chunks = chunks.split(b'\r\n', 1)
            size = int(line, 16)
            if not size:
                break
            payload.extend(chunks[:size])
            chunks = chunks[size + 2:]
        result = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error',
            '-i', 'pipe:0', '-f', 'null', '-'], input=payload, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.media.iterdir()})

        # Loop the tiny source in real FFmpeg: headers must arrive before the
        # (infinite) conversion completes, then disconnect must reap its process.
        original_command = api.ffmpeg_command
        def looping(*args, **kwargs):
            command = original_command(*args, **kwargs)
            pos = command.index('-i')
            return command[:pos] + ['-stream_loop', '-1', '-re'] + command[pos:]
        with patch.object(api, 'ffmpeg_command', looping):
            reader, writer = await self.connect('/folderframe-api/transcode?path=tiny.mov', 'Range: bytes=0-\r\n')
            header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 5)
            self.assertIn(b'200 OK', header)
            processes = list(self.service.processes)
            self.assertTrue(processes)
            self.assertIsNone(processes[0].returncode)
            writer.close()
            await writer.wait_closed()
            for _ in range(40):
                if not self.service.active:
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(self.service.active, 0)
            self.assertIsNotNone(processes[0].returncode)

    async def test_full_stdout_pipe_cleanup_drains_and_escalates(self):
        # Force the real failure: a full reader buffer and a child that needs
        # SIGKILL. Waiting without draining used to hang after that kill.
        process = await asyncio.create_subprocess_exec(sys.executable, '-c',
            'import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); '
            'os.write(1, b"x" * 1048576); time.sleep(60)',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=65536)
        try:
            for _ in range(100):
                if process.stdout._paused:
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(process.stdout._paused, 'Test did not fill the pipe')
            await asyncio.wait_for(api.terminate(process), 6)
            self.assertIsNotNone(process.returncode)
            self.assertTrue(process.stdout.at_eof())
        finally:
            # Also clean up when run against the old, deadlocking implementation.
            if process.returncode is None:
                process.kill()
            while await process.stdout.read(65536):
                pass
            await process.wait()

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required for real streaming test')
    async def test_repeated_full_hd_disconnects_release_every_slot(self):
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-t', '2',
            '-c:v', 'mpeg4', str(self.original)], check=True)
        # More cancellations than the available slots; the next request must
        # still be admitted. No realtime throttling: reproduce buffered output.
        for _ in range(self.service.limit + 2):
            reader, writer = await self.connect('/folderframe-api/transcode?path=tiny.mov')
            header = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
            self.assertIn(b'200 OK', header)
            processes = list(self.service.processes)
            writer.transport.abort()
            for _ in range(120):
                if not self.service.active:
                    break
                await asyncio.sleep(0.05)
            self.assertEqual(self.service.active, 0)
            self.assertFalse(self.service.processes)
            self.assertTrue(all(p.returncode is not None for p in processes))


if __name__ == '__main__':
    unittest.main()
