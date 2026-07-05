"""Log-odds evidence fusion.

We never store a "merge". Instead every ordered pair of identifiers has a
`same_entity` probability computed on demand by summing independent
evidence in log-odds space:

    logit(P) = PRIOR_LOGIT + Σ_active  eff_weight(m) · LLR(raw)

    eff_weight(m) = weight · (1 − FORGE_DISCOUNT · forgeability)
    LLR(raw)      = LLR_SCALE · (2·raw − 1)      # raw 1 → +, 0 → −

Positive and negative evidence live in the same frame: a module that
argues "different person" emits raw < 0.5, contributing a negative LLR
that *pulls the edge down*. That is what lets a later contradiction
(a stylometry break, a timezone shift) undo an earlier strong link.

Time is a first-class input. Each observation may carry a `frm`/`to`
validity window; only observations valid at the query time `asof` are
summed, so the edge probability is a function of time, S(x, y, t).

If *no* evidence is active at `asof`, the edge returns P = 0 (not the
prior) — a deliberately "broken" link the UI dims, distinct from a weak
but live link.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.engine.modules import MODULES

PRIOR_LOGIT = -1.1  # base rate P(same) ≈ 0.25 with zero evidence
LLR_SCALE = 4.2
FORGE_DISCOUNT = 0.6  # forgeability=1 → effective weight cut by 60%


def sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def eff_weight(module_key: str, weight_override: float | None = None) -> float:
    m = MODULES[module_key]
    w = m.weight if weight_override is None else weight_override
    return w * (1.0 - FORGE_DISCOUNT * m.forgeability)


def llr(raw: float) -> float:
    return LLR_SCALE * (2.0 * raw - 1.0)


@dataclass
class Observation:
    """A single timestamped piece of evidence about one identifier pair."""

    module: str
    raw: float
    source: str
    frm: int | None = None  # valid-from (unix), None = −∞
    to: int | None = None  # valid-to   (unix), None = +∞
    note: str = ""

    def active_at(self, asof: int | None) -> bool:
        if asof is None:
            return True
        if self.frm is not None and asof < self.frm:
            return False
        if self.to is not None and asof >= self.to:
            return False
        return True


@dataclass
class Contribution:
    module: str
    label: str
    raw: float
    source: str
    note: str
    frm: int | None
    to: int | None
    active: bool
    forgeability: float
    eff_weight: float
    llr: float
    contrib: float  # eff_weight · llr — signed push on the logit


@dataclass
class Fused:
    p: float
    logit: float
    active_count: int
    contested: bool  # a live observation argues "different person" (raw < 0.5)
    contributions: list[Contribution]


def fuse(
    observations: list[Observation],
    *,
    asof: int | None = None,
    disabled: set[str] | None = None,
    weights: dict[str, float] | None = None,
    ignore_time: bool = False,
) -> Fused:
    """Fuse all observations for one pair into P(same_entity) at `asof`.

    disabled — module keys to ablate (dropped entirely).
    weights  — per-module base-weight overrides (module toggling/ablation).
    ignore_time — treat every observation as active (used for the
                  time-independent reachability probability, p_ever).
    """
    disabled = disabled or set()
    weights = weights or {}

    logit = PRIOR_LOGIT
    active_count = 0
    contested = False
    contribs: list[Contribution] = []

    for obs in observations:
        m = MODULES[obs.module]
        active = True if ignore_time else obs.active_at(asof)
        ablated = obs.module in disabled
        ew = eff_weight(obs.module, weights.get(obs.module))
        signal = llr(obs.raw)
        contrib = ew * signal
        counts = active and not ablated
        if counts:
            logit += contrib
            active_count += 1
            if obs.raw < 0.5:
                contested = True
        contribs.append(
            Contribution(
                module=obs.module,
                label=m.label,
                raw=obs.raw,
                source=obs.source,
                note=obs.note,
                frm=obs.frm,
                to=obs.to,
                active=counts,
                forgeability=m.forgeability,
                eff_weight=ew,
                llr=signal,
                contrib=contrib,
            )
        )

    # No live evidence → a broken link, not the prior.
    if active_count == 0 and not ignore_time:
        return Fused(
            p=0.0, logit=logit, active_count=0, contested=False,
            contributions=contribs,
        )

    return Fused(
        p=sigmoid(logit),
        logit=logit,
        active_count=active_count,
        contested=contested,
        contributions=contribs,
    )
