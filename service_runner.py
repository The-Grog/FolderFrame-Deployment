#!/usr/bin/env python3
"""Supervise Caddy and optional workers; reap and terminate process groups."""
import os
import signal
import subprocess
import sys
import time


def main():
    stopping = False
    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    children = []
    try:
        api = subprocess.Popen(['python3', '/usr/share/folderframe/transcode_service.py'], start_new_session=True)
        children.append(api)
        if os.environ.get('FOLDERFRAME_THUMBNAILS', 'true') == 'true' or os.environ.get('FOLDERFRAME_MANIFEST', 'true') == 'true':
            children.append(subprocess.Popen(['python3', '/usr/share/folderframe/thumbnail_worker.py'], start_new_session=True))
        web = subprocess.Popen(sys.argv[1:], start_new_session=True)
        children.append(web)
        while not stopping and web.poll() is None and api.poll() is None:
            for child in children:
                child.poll()
            time.sleep(0.2)
        return web.returncode or api.returncode or 0
    finally:
        # Signal whole groups, including a thumbnail generator still scanning.
        for child in children:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for child in children:
            try:
                child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == '__main__':
    raise SystemExit(main())
