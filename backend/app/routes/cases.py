"""Case persistence — turn an ephemeral live investigation into a durable,
re-openable, exportable work product.

Saving is a mutation → require_identity (the platform gate also gates it).
A case belongs to the analyst who saved it; all reads are scoped to them.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.core.identity import require_identity
from app.engine.live_graph import LiveSession
from app.models import Case
from app.routes.live import get_session as get_live_session
from app.routes.live import put_session
from app.routes.users import upsert_local_user

router = APIRouter(prefix="/api/live/cases", tags=["cases"])


def _seed_label(sess: LiveSession) -> str | None:
    if sess.seed_root and sess.seed_root in sess.nodes:
        n = sess.nodes[sess.seed_root]
        return f"{n.type}:{n.label}"
    return None


class SaveIn(BaseModel):
    s: str
    title: str = Field(min_length=1, max_length=160)


class UpdateIn(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    assessment: dict | None = None


@router.post("")
async def save_case(
    body: SaveIn,
    coders_id: UUID = Depends(require_identity),
    db: AsyncSession = Depends(get_session),
) -> dict:
    live = get_live_session(body.s)
    if live.seed_root is None:
        raise HTTPException(400, "빈 조사 — 시드를 투입한 뒤 저장하세요")
    user = await upsert_local_user(db, coders_id)
    case = Case(
        user_id=user.id,
        title=body.title.strip(),
        seed=_seed_label(live) or "?",
        snapshot=live.to_snapshot(),
        assessment={},
    )
    db.add(case)
    await db.flush()
    return {"id": str(case.id), "title": case.title, "seed": case.seed}


@router.get("")
async def list_cases(
    coders_id: UUID = Depends(require_identity),
    db: AsyncSession = Depends(get_session),
) -> dict:
    user = await upsert_local_user(db, coders_id)
    res = await db.execute(
        select(Case).where(Case.user_id == user.id).order_by(desc(Case.updated_at))
    )
    cases = res.scalars().all()
    return {
        "cases": [
            {
                "id": str(c.id),
                "title": c.title,
                "seed": c.seed,
                "nodes": len(c.snapshot.get("nodes", [])),
                "updated_at": c.updated_at.isoformat(),
            }
            for c in cases
        ]
    }


async def _owned(case_id: str, coders_id: UUID, db: AsyncSession) -> Case:
    try:
        cid = UUID(case_id)
    except ValueError:
        raise HTTPException(404, "case not found") from None
    user = await upsert_local_user(db, coders_id)
    res = await db.execute(
        select(Case).where(Case.id == cid, Case.user_id == user.id)
    )
    case = res.scalar_one_or_none()
    if case is None:
        raise HTTPException(404, "case not found")
    return case


@router.get("/{case_id}")
async def get_case(
    case_id: str,
    coders_id: UUID = Depends(require_identity),
    db: AsyncSession = Depends(get_session),
) -> dict:
    case = await _owned(case_id, coders_id, db)
    g = LiveSession.from_snapshot(case.snapshot).graph()
    return {
        "id": str(case.id),
        "title": case.title,
        "seed": case.seed,
        "assessment": case.assessment,
        "created_at": case.created_at.isoformat(),
        "updated_at": case.updated_at.isoformat(),
        "nodes": g["nodes"],
        "edges": g["edges"],
        "fire_log": case.snapshot.get("fire_log", []),
    }


@router.put("/{case_id}")
async def update_case(
    case_id: str,
    body: UpdateIn,
    coders_id: UUID = Depends(require_identity),
    db: AsyncSession = Depends(get_session),
) -> dict:
    case = await _owned(case_id, coders_id, db)
    if body.title is not None and body.title.strip():
        case.title = body.title.strip()
    if body.assessment is not None:
        case.assessment = body.assessment
    await db.flush()
    return {"ok": True}


@router.delete("/{case_id}")
async def delete_case(
    case_id: str,
    coders_id: UUID = Depends(require_identity),
    db: AsyncSession = Depends(get_session),
) -> dict:
    case = await _owned(case_id, coders_id, db)
    await db.delete(case)
    return {"ok": True}


@router.post("/{case_id}/open")
async def open_case(
    case_id: str,
    s: str = Query(...),
    coders_id: UUID = Depends(require_identity),
    db: AsyncSession = Depends(get_session),
) -> dict:
    """Rehydrate a saved case into live session `s` so the analyst can keep
    investigating (fire more modules, add trust) from where they left off."""
    case = await _owned(case_id, coders_id, db)
    put_session(s, LiveSession.from_snapshot(case.snapshot))
    return {"ok": True, "seed": case.seed}
