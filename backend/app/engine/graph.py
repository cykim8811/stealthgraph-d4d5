"""Graph operations over the belief store.

The graph is *derived*: nodes are identifiers, and an edge between two of
them is the fused `same_entity` probability from all evidence about that
pair (fusion.py). Nothing here mutates state.

Key design choices:

  * Reachability is TIME-INDEPENDENT. A bounded BFS from the seed expands
    along any pair whose `p_ever` (fusion with every observation active,
    ignoring time) clears a floor. So the *set of nodes* on screen does
    not flicker as the analyst scrubs the timeline — only edge weights do.

  * Edge probabilities are reported at the query time `asof`, under the
    current module configuration (disabled set + weight overrides). That
    is what makes ablation and time-scrubbing live.

  * A "virtual entity" (cluster) at threshold θ is just a connected
    component of the graph restricted to edges with p ≥ θ at `asof`.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass

from app.engine.dataset import (
    EDGES,
    NODES_BY_ID,
    T_DEFAULT,
    T_END,
    T_START,
    T_TRANSFER,
)
from app.engine.fusion import Fused, Observation, fuse

# BFS bounds
REACH_FLOOR = 0.20  # expand along a pair only if p_ever ≥ this
MAX_HOPS = 6
MAX_NODES = 80


def _pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


# pair -> observations (deduped, undirected)
_PAIR_OBS: dict[tuple[str, str], list[Observation]] = {}
for _e in EDGES:
    _PAIR_OBS.setdefault(_pair_key(_e.a, _e.b), []).extend(_e.obs)

# adjacency for BFS
_ADJ: dict[str, set[str]] = defaultdict(set)
for (_a, _b) in _PAIR_OBS:
    _ADJ[_a].add(_b)
    _ADJ[_b].add(_a)


@dataclass
class EdgeView:
    a: str
    b: str
    p: float
    p_ever: float
    active: bool
    contested: bool
    contributions: list[dict]


def _fuse_pair(
    a: str,
    b: str,
    *,
    asof: int | None,
    disabled: set[str] | None,
    weights: dict[str, float] | None,
    ignore_time: bool = False,
) -> Fused:
    obs = _PAIR_OBS[_pair_key(a, b)]
    return fuse(obs, asof=asof, disabled=disabled, weights=weights,
               ignore_time=ignore_time)


def _contribs_to_dicts(f: Fused) -> list[dict]:
    return [
        {
            "module": c.module,
            "label": c.label,
            "raw": round(c.raw, 3),
            "source": c.source,
            "note": c.note,
            "frm": c.frm,
            "to": c.to,
            "active": c.active,
            "forgeability": c.forgeability,
            "eff_weight": round(c.eff_weight, 3),
            "llr": round(c.llr, 3),
            "contrib": round(c.contrib, 3),
        }
        for c in f.contributions
    ]


def subgraph(
    seed: str,
    *,
    asof: int | None = None,
    disabled: set[str] | None = None,
    weights: dict[str, float] | None = None,
) -> dict:
    """Bounded BFS from `seed`. Returns nodes + edge views.

    Node membership uses p_ever (time-independent). Edge p is reported at
    `asof` under the given module config.
    """
    if seed not in NODES_BY_ID:
        raise KeyError(seed)

    # --- reachability (time-independent) ---
    visited: set[str] = {seed}
    order: list[tuple[str, int]] = [(seed, 0)]
    q: deque[tuple[str, int]] = deque([(seed, 0)])
    reach_edges: set[tuple[str, str]] = set()

    while q and len(visited) < MAX_NODES:
        cur, hop = q.popleft()
        if hop >= MAX_HOPS:
            continue
        for nb in _ADJ[cur]:
            p_ever = _fuse_pair(
                cur, nb, asof=None, disabled=None, weights=None,
                ignore_time=True,
            ).p
            if p_ever < REACH_FLOOR:
                continue
            reach_edges.add(_pair_key(cur, nb))
            if nb not in visited:
                visited.add(nb)
                order.append((nb, hop + 1))
                q.append((nb, hop + 1))

    # --- build edge views at asof ---
    edges: list[EdgeView] = []
    for (a, b) in reach_edges:
        if a not in visited or b not in visited:
            continue
        at = _fuse_pair(a, b, asof=asof, disabled=disabled, weights=weights)
        ev = _fuse_pair(a, b, asof=None, disabled=None, weights=None,
                        ignore_time=True)
        edges.append(
            EdgeView(
                a=a,
                b=b,
                p=round(at.p, 4),
                p_ever=round(ev.p, 4),
                active=at.active_count > 0,
                contested=at.contested,
                contributions=_contribs_to_dicts(at),
            )
        )

    nodes = []
    hop_by_id = {nid: hop for nid, hop in order}
    for nid, hop in order:
        n = NODES_BY_ID[nid]
        nodes.append(
            {
                "id": n.id,
                "type": n.type,
                "label": n.label,
                "anchor": n.anchor,
                "sources": list(n.sources),
                "meta": n.meta,
                "seed_hop": hop,  # graph-distance from seed (reachability)
            }
        )

    return {
        "seed": seed,
        "asof": asof,
        "nodes": nodes,
        "edges": [e.__dict__ for e in edges],
    }


def edge_detail(
    a: str,
    b: str,
    *,
    asof: int | None = None,
    disabled: set[str] | None = None,
    weights: dict[str, float] | None = None,
) -> dict:
    """Full module-by-module breakdown for a single edge (inspector)."""
    if _pair_key(a, b) not in _PAIR_OBS:
        raise KeyError(f"{a}~{b}")
    at = _fuse_pair(a, b, asof=asof, disabled=disabled, weights=weights)
    ev = _fuse_pair(a, b, asof=None, disabled=None, weights=None, ignore_time=True)
    return {
        "a": a,
        "b": b,
        "p": round(at.p, 4),
        "p_ever": round(ev.p, 4),
        "logit": round(at.logit, 3),
        "active": at.active_count > 0,
        "contested": at.contested,
        "contributions": _contribs_to_dicts(at),
    }


def time_bounds() -> dict:
    return {
        "start": T_START,
        "end": T_END,
        "transfer": T_TRANSFER,
        "default": T_DEFAULT,
    }
