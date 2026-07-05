"""Shared query-string parsing for the module-config params both /api/graph
and /api/live/* accept (`disabled`, `weights`) — factored out so live.py
doesn't reach into graph.py's internals."""

from __future__ import annotations

from fastapi import HTTPException

from app.engine.modules import MODULES


def parse_disabled(disabled: str | None) -> set[str]:
    if not disabled:
        return set()
    keys = {k.strip() for k in disabled.split(",") if k.strip()}
    unknown = keys - set(MODULES)
    if unknown:
        raise HTTPException(422, f"unknown module(s): {', '.join(sorted(unknown))}")
    return keys


def parse_weights(weights: str | None) -> dict[str, float]:
    if not weights:
        return {}
    out: dict[str, float] = {}
    for pair in weights.split(","):
        pair = pair.strip()
        if not pair:
            continue
        try:
            k, v = pair.split(":", 1)
            k = k.strip()
            val = float(v)
        except ValueError:
            raise HTTPException(422, f"bad weight spec: {pair!r}") from None
        if k not in MODULES:
            raise HTTPException(422, f"unknown module: {k}")
        out[k] = max(0.0, min(1.0, val))
    return out
