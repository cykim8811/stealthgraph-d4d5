"""Read-only graph API — the derived view over the belief store.

All endpoints are public GETs: exploring the graph needs no identity
(only *saving* trust does, see beliefs.py). Every request re-runs fusion
under the caller's live configuration:

    seed      — investigation start node
    asof      — timeline position (unix seconds); omit → all evidence live
    disabled  — comma-separated module keys to ablate
    weights   — comma-separated `module:weight` base-weight overrides

θ (the entity threshold) is NOT a query param: node membership is
time/threshold-independent, and clusters/tiers are a pure client-side
function of the returned edge probabilities, so the θ slider stays
instant without a round-trip.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.engine.dataset import DEFAULT_SEED, SEEDS
from app.engine.graph import edge_detail, subgraph, time_bounds
from app.engine.modules import MODULE_ORDER, MODULES
from app.engine.fusion import FORGE_DISCOUNT, LLR_SCALE, PRIOR_LOGIT, eff_weight
from app.routes._query_parsing import parse_disabled as _parse_disabled
from app.routes._query_parsing import parse_weights as _parse_weights

router = APIRouter(prefix="/api", tags=["graph"])


def _modules_payload() -> list[dict]:
    return [
        {
            "key": k,
            "label": MODULES[k].label,
            "weight": MODULES[k].weight,
            "forgeability": MODULES[k].forgeability,
            "eff_weight": round(eff_weight(k), 3),
            "description": MODULES[k].description,
        }
        for k in MODULE_ORDER
    ]


@router.get("/meta")
async def meta() -> dict:
    """Static engine metadata: seeds, modules, fusion constants, timeline."""
    return {
        "seeds": SEEDS,
        "default_seed": DEFAULT_SEED,
        "modules": _modules_payload(),
        "time": time_bounds(),
        "constants": {
            "prior_logit": PRIOR_LOGIT,
            "llr_scale": LLR_SCALE,
            "forge_discount": FORGE_DISCOUNT,
        },
    }


@router.get("/graph")
async def graph(
    seed: str = Query(default=DEFAULT_SEED),
    asof: int | None = Query(default=None),
    disabled: str | None = Query(default=None),
    weights: str | None = Query(default=None),
) -> dict:
    dis = _parse_disabled(disabled)
    wts = _parse_weights(weights)
    try:
        g = subgraph(seed, asof=asof, disabled=dis, weights=wts)
    except KeyError:
        raise HTTPException(404, f"unknown seed: {seed}") from None
    g["modules"] = _modules_payload()
    g["time"] = time_bounds()
    return g


@router.get("/edge")
async def edge(
    a: str = Query(...),
    b: str = Query(...),
    asof: int | None = Query(default=None),
    disabled: str | None = Query(default=None),
    weights: str | None = Query(default=None),
) -> dict:
    dis = _parse_disabled(disabled)
    wts = _parse_weights(weights)
    try:
        return edge_detail(a, b, asof=asof, disabled=dis, weights=wts)
    except KeyError:
        raise HTTPException(404, f"no edge between {a} and {b}") from None
