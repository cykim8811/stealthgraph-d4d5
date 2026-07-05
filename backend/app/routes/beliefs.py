"""Belief-store sync — the persistent side of trust.

The client keeps trust state in localStorage for instant, offline-first
interaction; when the visitor is signed in it *also* syncs to the DB so
the same analyst sees their trust across devices. Both endpoints are
best-effort from the client's point of view — a failure just means it
keeps working from localStorage.

    GET  /api/beliefs            → all seeds' belief blobs for this user
    PUT  /api/beliefs/{seed}     → upsert one seed's belief blob

Writes require identity (PUT is a mutation → the platform gate already
gates anonymous callers; require_identity is defense-in-depth).
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.identity import optional_identity, require_identity
from app.models import BeliefState
from app.routes.users import upsert_local_user

router = APIRouter(prefix="/api", tags=["beliefs"])


class BeliefIn(BaseModel):
    # Free-form blob mirroring the client's localStorage shape:
    # {categories, trustByCat, activeCats}. Validated loosely on purpose.
    data: dict = Field(default_factory=dict)


@router.get("/beliefs")
async def list_beliefs(
    coders_id: UUID | None = Depends(optional_identity),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """All belief blobs for the signed-in analyst, keyed by seed.

    Anonymous → empty (they work purely from localStorage).
    """
    if coders_id is None:
        return {"beliefs": {}}
    user = await upsert_local_user(session, coders_id)
    res = await session.execute(
        select(BeliefState).where(BeliefState.user_id == user.id)
    )
    return {"beliefs": {b.seed: b.data for b in res.scalars().all()}}


@router.put("/beliefs/{seed}")
async def put_belief(
    seed: str,
    payload: BeliefIn,
    coders_id: UUID = Depends(require_identity),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Upsert this analyst's belief blob for one seed."""
    user = await upsert_local_user(session, coders_id)
    stmt = (
        pg_insert(BeliefState)
        .values(user_id=user.id, seed=seed, data=payload.data)
        .on_conflict_do_update(
            index_elements=["user_id", "seed"],
            set_={"data": payload.data},
        )
    )
    await session.execute(stmt)
    return {"ok": True, "seed": seed}
