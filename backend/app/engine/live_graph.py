"""Per-analyst live investigation state — the StealthMole-backed twin of
`dataset.py` + `graph.py`, now with the discriminators that make real
attribution non-trivial:

  * REUSE-BREADTH WEIGHTING. A shared identifier only implies "same entity"
    if it is RARE. A widely-traded credential (present in hundreds of combo
    lists) shared by two machines is weak evidence — they may just both
    hold the same stolen cred. Each identifier's observed breadth (its CB /
    CDS `total` once queried) discounts every co-occurrence edge it sits on,
    via a rarity factor. This is what tells "operator's real identity across
    two boxes" (rare → merge) apart from "traded inventory on two boxes"
    (common → don't merge).

  * HANDLE SIMILARITY. Formulaic persona families (`billyvienneau420` ~
    `billyvienneau6969`, `ern.wet91` ~ `liz.wet91`) are auto-linked with a
    weak, forgeable `handle_similarity` observation, so an operator's
    synthetic-identity cluster coheres even before any external query.

Node ids are content-addressed so re-seeding the same identifier resolves
to the same node across requests.
"""

from __future__ import annotations

import hashlib
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field

from app.engine import stealthmole as sm
from app.engine.fusion import Fused, Observation, fuse

REACH_FLOOR = 0.15
MAX_HOPS = 6
MAX_NODES = 120

# handle-similarity auto-linking
SIM_THRESHOLD = 0.45   # min local-part LCS ratio to draw an edge

# rarity: how hard breadth discounts a co-occurrence. score is CB-dominant.
RARITY_S0 = 15.0
RARITY_P = 0.9


def node_id(qtype: str, value: str) -> str:
    return "n_" + hashlib.sha1(f"{qtype}:{value.lower()}".encode()).hexdigest()[:12]


def _pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


@dataclass
class LiveNode:
    id: str
    type: str  # email | domain | ip | url
    label: str
    sources: list[str] = field(default_factory=list)
    meta: dict[str, str] = field(default_factory=dict)
    # module_id -> total records seen for this identifier (learned when the
    # analyst fires that module on it). The reuse-breadth signal.
    breadth: dict[str, int] = field(default_factory=dict)


class LiveSession:
    """One analyst's in-progress live investigation. Ephemeral, in-memory."""

    def __init__(self) -> None:
        self.nodes: dict[str, LiveNode] = {}
        self.pair_obs: dict[tuple[str, str], list[Observation]] = defaultdict(list)
        self.adj: dict[str, set[str]] = defaultdict(set)
        self.fired: set[tuple[str, str]] = set()
        self.fire_log: list[dict] = []
        self.seed_root: str | None = None
        self.touched = time.time()

    # ---- persistence (snapshot ⇄ Case) -------------------------------------

    def to_snapshot(self) -> dict:
        """Serialize the whole investigation for durable storage."""
        return {
            "seed_root": self.seed_root,
            "nodes": [
                {"id": n.id, "type": n.type, "label": n.label,
                 "sources": n.sources, "meta": n.meta, "breadth": n.breadth}
                for n in self.nodes.values()
            ],
            "obs": [
                {"a": a, "b": b, "module": o.module, "raw": o.raw,
                 "source": o.source, "frm": o.frm, "to": o.to, "note": o.note}
                for (a, b), lst in self.pair_obs.items()
                for o in lst
            ],
            "fired": [list(x) for x in self.fired],
            "fire_log": self.fire_log,
        }

    @classmethod
    def from_snapshot(cls, snap: dict) -> LiveSession:
        s = cls()
        for n in snap.get("nodes", []):
            s.nodes[n["id"]] = LiveNode(
                id=n["id"], type=n["type"], label=n["label"],
                sources=list(n.get("sources", [])), meta=dict(n.get("meta", {})),
                breadth=dict(n.get("breadth", {})),
            )
        # restore observations directly (handle_similarity ones are stored too,
        # so we must NOT re-run _link_similar — that's why nodes were added raw)
        for o in snap.get("obs", []):
            s.add_observation(
                o["a"], o["b"],
                Observation(module=o["module"], raw=o["raw"], source=o["source"],
                            frm=o.get("frm"), to=o.get("to"), note=o.get("note", "")),
            )
        s.fired = {tuple(x) for x in snap.get("fired", [])}
        s.fire_log = list(snap.get("fire_log", []))
        s.seed_root = snap.get("seed_root")
        return s

    # ---- graph construction -------------------------------------------------

    def ensure_node(
        self, qtype: str, value: str, source: str, ref: str | None = None
    ) -> str:
        nid = node_id(qtype, value)
        n = self.nodes.get(nid)
        if n is None:
            n = LiveNode(id=nid, type=qtype, label=value, sources=[source])
            self.nodes[nid] = n
            self._link_similar(n)  # auto handle-similarity vs existing personas
        elif source not in n.sources:
            n.sources.append(source)
        if ref and "ref" not in n.meta:
            n.meta["ref"] = ref  # sha256 for later /tt/node drill-down
        if self.seed_root is None:
            self.seed_root = nid
        return nid

    def _link_similar(self, node: LiveNode) -> None:
        """Draw weak handle_similarity edges from a new email/handle node to
        existing ones with a similar local part (an operator's persona
        family). Cheap O(n) — n is small."""
        if node.type not in ("email", "handle"):
            return
        for other in self.nodes.values():
            if other.id == node.id or other.type not in ("email", "handle"):
                continue
            s = sm.handle_similarity(node.label, other.label)
            if s < SIM_THRESHOLD:
                continue
            raw = min(0.95, 0.45 + 0.5 * s)
            obs = Observation(
                module="handle_similarity", raw=raw, source="derived:handle",
                note=f"작명 패턴 유사 ({node.label} ~ {other.label}, {s:.0%})",
            )
            self.add_observation(node.id, other.id, obs)

    def add_observation(self, a_id: str, b_id: str, obs: Observation) -> None:
        if a_id == b_id:
            return
        self.pair_obs[_pair_key(a_id, b_id)].append(obs)
        self.adj[a_id].add(b_id)
        self.adj[b_id].add(a_id)

    def set_breadth(self, node_id_: str, module_id: str, total: int) -> None:
        n = self.nodes.get(node_id_)
        if n is not None:
            n.breadth[module_id] = total

    # ---- reuse-breadth rarity ----------------------------------------------

    def reuse_factor(self, nid: str) -> float:
        """1.0 for a rare/unknown identifier, decaying toward 0 as it proves
        widely traded. An ip (a machine) is never discounted — its record
        count is machine size, not shared-ness."""
        n = self.nodes.get(nid)
        if n is None or n.type == "ip" or not n.breadth:
            return 1.0
        cb = n.breadth.get("cb", 0)
        cl = n.breadth.get("cl", 0)
        cds = n.breadth.get("cds", 0)
        score = cb + 0.3 * cl + 0.02 * max(0, cds - 3)
        if score <= 0:
            return 1.0
        return 1.0 / (1.0 + (score / RARITY_S0) ** RARITY_P)

    # ---- fusion-backed views (mirrors engine/graph.py) ---------------------

    def _fuse_edge(
        self, a: str, b: str, *, asof, disabled, weights,
    ) -> tuple[Fused, Fused, float]:
        """Returns (display_fuse, effective_fuse, rarity). display keeps the
        original raws for the inspector breakdown; effective applies the
        min-endpoint rarity discount and is what drives p."""
        obs = self.pair_obs.get(_pair_key(a, b), [])
        disp = fuse(obs, asof=asof, disabled=disabled, weights=weights)
        rarity = min(self.reuse_factor(a), self.reuse_factor(b))
        if rarity >= 0.999:
            return disp, disp, 1.0
        # pull each raw toward the neutral 0.5 by the rarity factor
        disc = [
            Observation(module=o.module, raw=0.5 + (o.raw - 0.5) * rarity,
                        source=o.source, frm=o.frm, to=o.to, note=o.note)
            for o in obs
        ]
        eff = fuse(disc, asof=asof, disabled=disabled, weights=weights)
        return disp, eff, rarity

    def _p_ever(self, a: str, b: str) -> float:
        obs = self.pair_obs.get(_pair_key(a, b), [])
        return fuse(obs, ignore_time=True).p

    def _contribs(self, f: Fused) -> list[dict]:
        return [
            {
                "module": c.module, "label": c.label, "raw": round(c.raw, 3),
                "source": c.source, "note": c.note, "frm": c.frm, "to": c.to,
                "active": c.active, "forgeability": c.forgeability,
                "eff_weight": round(c.eff_weight, 3), "llr": round(c.llr, 3),
                "contrib": round(c.contrib, 3),
            }
            for c in f.contributions
        ]

    def _node_json(self, n: LiveNode, hop: int) -> dict:
        return {
            "id": n.id, "type": n.type, "label": n.label, "anchor": False,
            "sources": list(n.sources), "meta": n.meta, "seed_hop": hop,
            "breadth": n.breadth, "reuse_factor": round(self.reuse_factor(n.id), 3),
        }

    def graph(self, *, asof=None, disabled=None, weights=None) -> dict:
        if self.seed_root is None or self.seed_root not in self.nodes:
            return {"seed": None, "asof": asof, "nodes": [], "edges": []}

        visited = {self.seed_root}
        order = [(self.seed_root, 0)]
        q: deque[tuple[str, int]] = deque([(self.seed_root, 0)])
        reach_edges: set[tuple[str, str]] = set()

        while q and len(visited) < MAX_NODES:
            cur, hop = q.popleft()
            if hop >= MAX_HOPS:
                continue
            for nb in self.adj.get(cur, ()):
                if self._p_ever(cur, nb) < REACH_FLOOR:
                    continue
                reach_edges.add(_pair_key(cur, nb))
                if nb not in visited:
                    visited.add(nb)
                    order.append((nb, hop + 1))
                    q.append((nb, hop + 1))

        edges = []
        for a, b in reach_edges:
            disp, eff, rarity = self._fuse_edge(a, b, asof=asof, disabled=disabled, weights=weights)
            edges.append({
                "a": a, "b": b,
                "p": round(eff.p, 4), "p_ever": round(self._p_ever(a, b), 4),
                "active": eff.active_count > 0, "contested": eff.contested,
                "rarity": round(rarity, 3),
                "discounted": rarity < 0.85,
                "contributions": self._contribs(disp),
            })

        nodes = [self._node_json(self.nodes[nid], hop) for nid, hop in order]
        return {"seed": self.seed_root, "asof": asof, "nodes": nodes, "edges": edges}

    def edge_detail(self, a, b, *, asof=None, disabled=None, weights=None) -> dict:
        disp, eff, rarity = self._fuse_edge(a, b, asof=asof, disabled=disabled, weights=weights)
        return {
            "a": a, "b": b, "p": round(eff.p, 4), "p_ever": round(self._p_ever(a, b), 4),
            "logit": round(eff.logit, 3), "active": eff.active_count > 0,
            "contested": eff.contested, "rarity": round(rarity, 3),
            "contributions": self._contribs(disp),
        }
