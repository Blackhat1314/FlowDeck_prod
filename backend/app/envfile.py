"""Read KEY=VALUE lines from a .env file into the environment (no extra dependency).

Variables already set (for example by systemd's EnvironmentFile on the server) always win over the file.
"""
from __future__ import annotations

import os
from pathlib import Path


def load_env_file(*paths: Path) -> list[str]:
    """Load the first files that exist; returns the names of variables it set."""
    loaded = []
    for p in paths:
        try:
            text = p.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            key, value = line.split("=", 1)
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
                loaded.append(key)
    return loaded
