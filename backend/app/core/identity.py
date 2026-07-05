"""Identity dependency for FastAPI routes.

The coders.kr platform gate validates the visitor's `coders_session`
cookie *before* the request reaches this service, and stamps the
identity on the way in:

    X-Coders-User: <uuid>

This module trusts that header. The gate wouldn't be sending it
otherwise — the platform never forwards a value the visitor sets
themselves (gate strips inbound X-Coders-User unconditionally).

Two dependencies:
    require_identity  → 401 if anonymous (use on auth-required endpoints)
    optional_identity → None if anonymous (use on public-but-personalized)

You typically don't need `require_identity` on POST endpoints — the
platform gate already 302s anonymous mutations to /sso/login. It's
defense-in-depth for self-hosted local dev and a clearer contract.
"""

from __future__ import annotations

import urllib.parse
from uuid import UUID

from fastapi import Header, HTTPException

from app.core.config import settings


def _parse_uuid(value: str | None) -> UUID | None:
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


async def optional_identity(
    x_coders_user: str | None = Header(default=None),
) -> UUID | None:
    """Visitor UUID or None (anonymous)."""
    parsed = _parse_uuid(x_coders_user)
    if parsed is not None:
        return parsed
    # Local-dev fallback so curl works without the platform gate.
    return _parse_uuid(settings.dev_fake_user)


async def optional_display_name(
    x_coders_user_name: str | None = Header(default=None),
) -> str | None:
    """The visitor's opt-in display name, if they set one on coders.kr. The gate
    forwards it URL-encoded as `X-Coders-User-Name` (headers are ASCII; names may
    be Unicode), so we percent-decode it. None when they haven't chosen a name —
    fall back to a generated handle then."""
    if not x_coders_user_name:
        return None
    name = urllib.parse.unquote(x_coders_user_name).strip()
    return name or None


async def require_identity(
    x_coders_user: str | None = Header(default=None),
) -> UUID:
    """Same as optional_identity but raises 401 if anonymous."""
    cid = await optional_identity(x_coders_user)
    if cid is None:
        raise HTTPException(
            status_code=401,
            detail="sign in required",
        )
    return cid
