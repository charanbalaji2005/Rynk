#!/bin/sh
# Any command works as long as it listens on the port Rynk gives it.
exec python3 -m http.server "${PORT:-8000}" --bind "${HOST:-0.0.0.0}"
