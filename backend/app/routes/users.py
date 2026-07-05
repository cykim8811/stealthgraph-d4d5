"""First-sight user upsert + /api/me.

The platform doesn't pre-create a row in the tenant DB. We do it lazily
on first sight, keyed on `coders_id` (the platform identity).
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.identity import optional_display_name, require_identity
from app.models import User

router = APIRouter(prefix="/api", tags=["users"])


async def upsert_local_user(
    session: AsyncSession, coders_id: UUID, platform_name: str | None = None
) -> User:
    """Insert-on-first-sight; otherwise bump last_seen_at. When the visitor set a
    display name on coders.kr (`platform_name`), use it and keep it in sync;
    otherwise fall back to a generated `user-<id8>` handle."""
    name = platform_name or f"user-{str(coders_id)[:8]}"
    stmt = pg_insert(User).values(coders_id=coders_id, display_name=name)
    if platform_name:
        stmt = stmt.on_conflict_do_update(
            index_elements=["coders_id"], set_={"display_name": platform_name}
        )
    else:
        stmt = stmt.on_conflict_do_nothing(index_elements=["coders_id"])
    await session.execute(stmt)
    res = await session.execute(select(User).where(User.coders_id == coders_id))
    user = res.scalar_one()
    # Touch last_seen_at (the onupdate trigger fires when we modify anything).
    user.display_name = user.display_name
    return user


@router.get("/me")
async def me(
    coders_id: UUID = Depends(require_identity),
    platform_name: str | None = Depends(optional_display_name),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Return the signed-in visitor's app-local user row.

    Anonymous → 401 (`require_identity`). Anyone who got here has a
    valid coders.kr session.
    """
    user = await upsert_local_user(session, coders_id, platform_name)
    return {
        "id": str(user.id),
        "coders_id": str(user.coders_id),
        "display_name": user.display_name,
        "first_seen_at": user.first_seen_at.isoformat(),
    }
