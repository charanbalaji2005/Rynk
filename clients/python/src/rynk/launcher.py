"""Find and run the Node.js Rynk CLI."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import List

from .client import RynkError

GUARD = "RYNK_PY_LAUNCHER"


def _is_self(path: str) -> bool:
    """True if `path` is this Python launcher (its console script) rather than the Node CLI."""
    try:
        head = Path(path).read_bytes()[:400]
    except OSError:
        return False
    return b"python" in head.lower() and b"rynk.cli" in head or Path(path).resolve() == Path(sys.argv[0]).resolve()


def node_cli() -> List[str]:
    """Command prefix for the Node CLI: a global `rynk` install, else `npx --yes rynk`."""
    override = os.environ.get("RYNK_NODE_CLI")
    if override:
        return override.split()
    if not os.environ.get(GUARD):
        for directory in os.environ.get("PATH", "").split(os.pathsep):
            for name in ("rynk.cmd", "rynk") if os.name == "nt" else ("rynk",):
                candidate = os.path.join(directory, name)
                if os.path.isfile(candidate) and os.access(candidate, os.X_OK) and not _is_self(candidate):
                    return [candidate]
    npx = shutil.which("npx")
    if npx:
        return [npx, "--yes", "rynk"]
    raise RynkError(
        "RUNTIME_UNAVAILABLE",
        "Rynk needs Node.js 22.13 or newer.",
        causes=["The Python package launches the Rynk engine, which runs on Node.js."],
        suggestions=["Install Node.js from https://nodejs.org", "Then run: rynk"],
    )
