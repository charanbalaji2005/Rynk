"""`rynk` console script installed by `pip install rynk`."""

from __future__ import annotations

import os
import subprocess
import sys
from typing import List, Optional

from .client import RynkError
from .launcher import GUARD, node_cli


def main(argv: Optional[List[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        cmd = node_cli()
    except RynkError as e:
        print(e.explain(), file=sys.stderr)
        return 1
    env = dict(os.environ, **{GUARD: "1"})
    try:
        return subprocess.call([*cmd, *args], env=env)
    except KeyboardInterrupt:
        return 130
    except FileNotFoundError:
        print(RynkError("RUNTIME_UNAVAILABLE", "Couldn't run the Rynk CLI (%s)." % cmd[0], suggestions=["Install Node.js 22.13+ from https://nodejs.org"]).explain(), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
