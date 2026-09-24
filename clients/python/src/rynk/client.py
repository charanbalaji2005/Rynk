"""Dependency-free client for the local Rynk daemon API."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


class RynkError(Exception):
    """An error from Rynk, with likely causes and suggested fixes."""

    def __init__(self, code: str, message: str, causes: Optional[List[str]] = None, suggestions: Optional[List[str]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.causes = causes or []
        self.suggestions = suggestions or []

    def explain(self) -> str:
        lines = ["✗ " + self.message]
        if self.causes:
            lines += ["", "Possible causes:"] + ["  • " + c for c in self.causes]
        if self.suggestions:
            lines += ["", "Try:"] + ["  " + s for s in self.suggestions]
        return "\n".join(lines)


def rynk_home() -> Path:
    """Same rules as the Node side: RYNK_HOME, then the per-platform default."""
    if os.environ.get("RYNK_HOME"):
        return Path(os.environ["RYNK_HOME"]).expanduser().resolve()
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Rynk"
    return Path.home() / ".rynk"


@dataclass
class DaemonState:
    pid: int
    host: str
    port: int
    token: str
    version: str
    proxy_port: int

    @classmethod
    def load(cls, path: Optional[Path] = None) -> Optional["DaemonState"]:
        path = path or rynk_home() / "daemon.json"
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return cls(pid=raw["pid"], host=raw["host"], port=raw["port"], token=raw["token"], version=raw.get("version", "?"), proxy_port=raw.get("proxyPort", 7777))


class RynkClient:
    """Low-level HTTP client. Most code should use :class:`rynk.Rynk`."""

    def __init__(self, state: DaemonState, timeout: float = 15.0):
        if state.host not in ("127.0.0.1", "localhost", "::1"):
            raise RynkError("DAEMON_UNREACHABLE", "Refusing to send the daemon token to a non-loopback host.")
        self.state = state
        self.timeout = timeout

    @classmethod
    def from_disk(cls) -> "RynkClient":
        state = DaemonState.load()
        if state is None:
            raise RynkError("DAEMON_UNREACHABLE", "The Rynk daemon isn't running.", suggestions=["rynk daemon start"])
        return cls(state)

    def request(self, method: str, path: str, body: Any = None, timeout: Optional[float] = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request("http://%s:%d%s" % (self.state.host, self.state.port, path), data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.state.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as res:
                text = res.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode()).get("error", {})
            except ValueError:
                err = {}
            raise RynkError(err.get("code", "INTERNAL"), err.get("message", "HTTP %d" % e.code), err.get("causes"), err.get("suggestions")) from None
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            raise RynkError("DAEMON_UNREACHABLE", "The Rynk daemon isn't responding.", [str(e)], ["rynk daemon restart", "rynk doctor"]) from None

    @staticmethod
    def q(value: str) -> str:
        return urllib.parse.quote(value, safe="")
