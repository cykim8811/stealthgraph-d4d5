"""Live StealthMole-backed investigation — the real-data twin of /api/graph.

Same fusion engine, same node/edge shape, but the corpus grows one `fire`
(one real API call) at a time instead of being pre-authored. GET-only so
anonymous visitors can explore it (mutations here are "make one more real
network call", not app state that needs an identity — the platform gate's
anonymous-mutation redirect is for POST/PUT/PATCH/DELETE, so GET keeps this
usable without forcing a sign-in for a demo reviewer), sandboxed per
browser via a client-generated `?s=` session id.

Nothing here calls StealthMole except in direct response to /fire — /state
only re-fuses whatever has already been fetched, so scrubbing the timeline
or toggling a module never spends rate-limit budget.
"""

from __future__ import annotations

import time
from collections import OrderedDict

from fastapi import APIRouter, HTTPException, Query

from app.engine import stealthmole
from app.engine.live_graph import LiveSession
from app.engine.modules import MODULE_ORDER, MODULES
from app.routes._query_parsing import parse_disabled as _parse_disabled
from app.routes._query_parsing import parse_weights as _parse_weights

router = APIRouter(prefix="/api/live", tags=["live"])

MAX_SESSIONS = 200
SESSION_TTL = 3600 * 3

_sessions: OrderedDict[str, LiveSession] = OrderedDict()


def _session(sid: str) -> LiveSession:
    if not sid or len(sid) > 64:
        raise HTTPException(400, "invalid session id")
    now = time.time()
    for k in list(_sessions):
        if now - _sessions[k].touched > SESSION_TTL:
            del _sessions[k]
    s = _sessions.get(sid)
    if s is None:
        s = LiveSession()
        _sessions[sid] = s
        while len(_sessions) > MAX_SESSIONS:
            _sessions.popitem(last=False)
    s.touched = now
    _sessions.move_to_end(sid)
    return s


def get_session(sid: str) -> LiveSession:
    """Public accessor for other routers (cases) — same create-or-get."""
    return _session(sid)


def put_session(sid: str, sess: LiveSession) -> None:
    """Replace a live session (used when re-opening a saved case)."""
    sess.touched = time.time()
    _sessions[sid] = sess
    _sessions.move_to_end(sid)
    while len(_sessions) > MAX_SESSIONS:
        _sessions.popitem(last=False)


def _modules_payload() -> list[dict]:
    return [
        {"id": m.id, "code": m.code, "label": m.label, "kind": m.kind, "accepts": list(m.accepts)}
        for m in stealthmole.MODULES.values()
    ]


async def _quota_snapshot() -> dict | None:
    try:
        return await stealthmole.quotas()
    except Exception:
        return None


def _queryable(sess: LiveSession) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for n in sess.nodes.values():
        avail = [
            {"id": m.id, "code": m.code, "label": m.label}
            for m in stealthmole.MODULES.values()
            if n.type in m.accepts and (m.id, f"{n.type}:{n.label}") not in sess.fired
        ]
        if avail:
            out[n.id] = {"type": n.type, "value": n.label, "modules": avail}
    return out


async def _state(
    sess: LiveSession, *, asof: int | None, disabled: set[str], weights: dict[str, float],
    last: dict | None = None, quota: dict | None = None,
) -> dict:
    g = sess.graph(asof=asof, disabled=disabled, weights=weights)
    if quota is None:
        quota = await _quota_snapshot()
    return {
        **g,
        "modules": [
            {
                "key": k, "label": MODULES[k].label, "weight": MODULES[k].weight,
                "forgeability": MODULES[k].forgeability, "description": MODULES[k].description,
            }
            for k in MODULE_ORDER
        ],
        "queryable": _queryable(sess),
        "fire_log": sess.fire_log[-12:],
        "last_fire": last,
        "quotas": quota,
        "configured": stealthmole.configured(),
    }


@router.get("/meta")
async def meta() -> dict:
    return {"modules": _modules_payload(), "configured": stealthmole.configured()}


@router.get("/state")
async def state(
    s: str = Query(...),
    asof: int | None = Query(default=None),
    disabled: str | None = Query(default=None),
    weights: str | None = Query(default=None),
) -> dict:
    sess = _session(s)
    return await _state(sess, asof=asof, disabled=_parse_disabled(disabled), weights=_parse_weights(weights))


@router.get("/seed")
async def seed(
    s: str = Query(...),
    query: str = Query(...),
    asof: int | None = Query(default=None),
) -> dict:
    sess = _session(s)
    parsed = stealthmole.parse_seed(query)
    if parsed is None:
        raise HTTPException(400, "email:/domain:/ip:/url: 형식 또는 인식 가능한 값이 아님")
    qtype, value = parsed
    sess.ensure_node(qtype, value, source="분석관 지정")
    return await _state(
        sess, asof=asof, disabled=set(), weights={},
        last={"kind": "seed", "query": f"{qtype}:{value}"},
    )


@router.get("/fire")
async def fire(
    s: str = Query(...),
    module: str = Query(...),
    node: str = Query(...),
    asof: int | None = Query(default=None),
    disabled: str | None = Query(default=None),
    weights: str | None = Query(default=None),
) -> dict:
    sess = _session(s)
    dis = _parse_disabled(disabled)
    wts = _parse_weights(weights)
    if module not in stealthmole.MODULES:
        raise HTTPException(404, "unknown StealthMole module")
    origin = sess.nodes.get(node)
    if origin is None:
        raise HTTPException(400, "unknown node")
    mod = stealthmole.MODULES[module]
    if origin.type not in mod.accepts:
        raise HTTPException(400, f"{mod.code}는 {origin.type} 식별자를 지원하지 않음")

    query_key = f"{origin.type}:{origin.label}"
    if (module, query_key) in sess.fired:
        return await _state(
            sess, asof=asof, disabled=dis, weights=wts,
            last={"kind": "cached", "module": mod.code, "query": query_key,
                  "note": "이미 조회함 — 저장된 결과 재사용(재호출 없음)"},
        )

    try:
        # limit is page size within ONE query → still a single quota unit
        # (queryCost 50), so we fetch a full page to light up the machine.
        res = await stealthmole.search(module, origin.type, origin.label, limit=40)
    except stealthmole.RateLimited as e:
        return await _state(sess, asof=asof, disabled=dis, weights=wts,
                             last={"kind": "ratelimited", "module": mod.code, "query": query_key, "note": str(e)})
    except stealthmole.QuotaExceeded as e:
        return await _state(sess, asof=asof, disabled=dis, weights=wts,
                             last={"kind": "quota", "module": mod.code, "query": query_key, "note": str(e)})
    except stealthmole.StealthMoleError as e:
        return await _state(sess, asof=asof, disabled=dis, weights=wts,
                             last={"kind": "error", "module": mod.code, "query": query_key, "note": str(e)})

    sess.fired.add((module, query_key))
    # record how broadly this identifier is seen (reuse-breadth): a high CB
    # total means it's a widely-traded credential, which discounts its edges.
    sess.set_breadth(origin.id, module, res.total)
    added = 0
    for other_type, other_value, obs, ref in stealthmole.to_observations(
        module, origin.type, origin.label, res
    ):
        other_id = sess.ensure_node(
            other_type, other_value, source=f"StealthMole {mod.code}", ref=ref
        )
        was_new = other_id not in sess.adj or origin.id not in sess.adj.get(other_id, set())
        sess.add_observation(origin.id, other_id, obs)
        if was_new:
            added += 1

    breadth_note = ""
    if module in ("cb", "cl") and res.total > 0:
        breadth_note = f" · 재사용폭 {mod.code}={res.total} (재고성 ↑)"
    last = {
        "kind": "fired", "module": mod.code, "query": query_key,
        "total": res.total, "cost": res.cost, "added": added,
        "note": (f"{res.total:,}건 관측 · 식별자 {len(res.identifiers)}개 추출{breadth_note}"
                 if res.total else "결과 없음 (0건)"),
    }
    sess.fire_log.append(last)
    stealthmole.invalidate_quota_cache()
    quota = await _quota_snapshot()
    return await _state(sess, asof=asof, disabled=dis, weights=wts, last=last, quota=quota)


@router.get("/compare")
async def compare(
    s: str = Query(...),
    a: str = Query(...),
    b: str = Query(...),
    asof: int | None = Query(default=None),
    disabled: str | None = Query(default=None),
    weights: str | None = Query(default=None),
) -> dict:
    """Adversarial verify an edge: drill both accounts' messages and compare
    writing style. Emits a `stylometry` observation (negative if they diverge)
    onto the a–b edge — the automated GANOSEC-style refutation."""
    sess = _session(s)
    dis = _parse_disabled(disabled)
    wts = _parse_weights(weights)
    na, nb = sess.nodes.get(a), sess.nodes.get(b)
    if na is None or nb is None:
        raise HTTPException(400, "unknown node")
    ref_a, ref_b = na.meta.get("ref"), nb.meta.get("ref")
    if not ref_a or not ref_b:
        return await _state(sess, asof=asof, disabled=dis, weights=wts,
                            last={"kind": "error", "note": "두 노드 모두 드릴 가능한 텔레그램 노드여야 함(ref 없음)"})
    try:
        prof_a = await stealthmole.node_style(ref_a)
        prof_b = await stealthmole.node_style(ref_b)
    except stealthmole.StealthMoleError as e:
        return await _state(sess, asof=asof, disabled=dis, weights=wts,
                            last={"kind": "error", "note": str(e)})
    obss = stealthmole.style_observations(prof_a, prof_b)
    for obs in obss:
        sess.add_observation(a, b, obs)
    if obss:
        o = obss[0]
        verdict = "반증(다른 주체)" if o.raw < 0.5 else "지지(동일 주체)"
        note = f"문체 비교: {verdict} · raw={o.raw} · {o.note}"
    else:
        note = "텍스트 부족으로 문체 판정 보류"
    last = {"kind": "compared", "a": na.label, "b": nb.label, "note": note}
    sess.fire_log.append(last)
    stealthmole.invalidate_quota_cache()
    return await _state(sess, asof=asof, disabled=dis, weights=wts, last=last)


@router.get("/reset")
async def reset(s: str = Query(...)) -> dict:
    if not s or len(s) > 64:
        raise HTTPException(400, "invalid session id")
    _sessions[s] = LiveSession()
    return await _state(_sessions[s], asof=None, disabled=set(), weights={})
