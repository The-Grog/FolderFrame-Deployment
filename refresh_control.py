#!/usr/bin/env python3
"""Atomic, bounded hand-off between the refresh API and media worker."""
from __future__ import annotations

try:
    import fcntl
except ImportError:  # Windows test hosts; production images use POSIX locking.
    fcntl = None
import threading
import json
import os
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

_LOCAL_LOCK = threading.Lock()


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {"version": 1}
    return value if isinstance(value, dict) and value.get("version") == 1 else {"version": 1}


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


@contextmanager
def locked(path: Path):
    lock_path = path.with_name(path.name + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        if fcntl is None:
            with _LOCAL_LOCK:
                yield
            return
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def request(path: Path, request_id: str) -> tuple[str, bool]:
    """Queue at most one pending pass; retries/tabs share that request."""
    with locked(path):
        state = _read(path)
        active = state.get("active")
        recovered = state.get("recovered")
        pending = state.get("pending")
        outcomes = [item for item in state.get("outcomes", []) if isinstance(item, dict)]
        known_ids = {item.get("requestId") for item in (active, recovered, pending, *outcomes)
                     if isinstance(item, dict)}
        aliases = [item for item in state.get("aliases", []) if isinstance(item, dict)]
        alias = next((item for item in reversed(aliases)
                      if item.get("clientRequestId") == request_id), None)
        if alias and alias.get("requestId") in known_ids:
            return alias["requestId"], True
        if alias:
            aliases = [item for item in aliases if item.get("clientRequestId") != request_id]
            state["aliases"] = aliases
        if request_id in known_ids:
            if alias:
                _write(path, state)
            return request_id, True
        if isinstance(pending, dict) and isinstance(pending.get("requestId"), str):
            aliases = [item for item in aliases if item.get("clientRequestId") != request_id]
            aliases.append({"clientRequestId": request_id, "requestId": pending["requestId"]})
            state["aliases"] = aliases[-32:]
            _write(path, state)
            return pending["requestId"], True
        state["pending"] = {"requestId": request_id}
        _write(path, state)
        return request_id, False


def claim(path: Path) -> dict | None:
    with locked(path):
        state = _read(path)
        pending = state.pop("recovered", None)
        if not isinstance(pending, dict):
            pending = state.pop("pending", None)
        if not isinstance(pending, dict):
            return None
        active = {"requestId": pending["requestId"], "runId": uuid4().hex}
        state["active"] = active
        _write(path, state)
        return active


def finish(path: Path, run_id: str, outcome: str, completed_at: str | None = None) -> None:
    with locked(path):
        state = _read(path)
        if state.get("active", {}).get("runId") == run_id:
            active = state.pop("active", None)
            if isinstance(active, dict):
                outcomes = [item for item in state.get("outcomes", []) if isinstance(item, dict)]
                outcomes = [item for item in outcomes if item.get("requestId") != active.get("requestId")]
                outcomes.append({"requestId": active.get("requestId"), "runId": run_id,
                    "outcome": outcome, "completedAt": completed_at})
                state["outcomes"] = outcomes[-16:]
            _write(path, state)


def status(path: Path, request_id: str) -> dict | None:
    with locked(path):
        state = _read(path)
        canonical_id = request_id
        alias = next((item for item in reversed(state.get("aliases", []))
                      if isinstance(item, dict) and item.get("clientRequestId") == request_id), None)
        if alias and isinstance(alias.get("requestId"), str):
            canonical_id = alias["requestId"]
        for key, request_state in (("active", "running"), ("recovered", "queued"), ("pending", "queued")):
            item = state.get(key)
            if isinstance(item, dict) and item.get("requestId") == canonical_id:
                result = {"requestId": request_id, "state": request_state, "runId": item.get("runId")}
                if canonical_id != request_id:
                    result["acceptedRequestId"] = canonical_id
                return result
        for item in reversed(state.get("outcomes", [])):
            if isinstance(item, dict) and item.get("requestId") == canonical_id:
                result = {**item, "requestId": request_id,
                    "state": "failed" if item.get("outcome") == "failed" else "complete"}
                if canonical_id != request_id:
                    result["acceptedRequestId"] = canonical_id
                return result
        return None


def recover(path: Path) -> None:
    """An interrupted accepted run becomes pending after worker restart."""
    with locked(path):
        state = _read(path)
        active = state.pop("active", None)
        if isinstance(active, dict):
            recovered = {"requestId": active.get("requestId") or uuid4().hex}
            if isinstance(state.get("pending"), dict):
                state["recovered"] = recovered
            else:
                state["pending"] = recovered
        _write(path, state)