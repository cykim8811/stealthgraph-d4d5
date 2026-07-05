"""Locks in the four canonical demo behaviours.

These are pure-engine assertions (no DB) — they guard the hand-tuned
evidence corpus so a later edit can't silently break a scenario.
"""

from __future__ import annotations

from app.engine.dataset import DEFAULT_SEED, T_END, T_TRANSFER
from app.engine.graph import edge_detail, subgraph

BEFORE = T_TRANSFER - 86_400
AFTER = T_TRANSFER + 86_400


def test_reachability_is_time_independent():
    """Node set must not change as the timeline moves."""
    n_before = {n["id"] for n in subgraph(DEFAULT_SEED, asof=BEFORE)["nodes"]}
    n_after = {n["id"] for n in subgraph(DEFAULT_SEED, asof=AFTER)["nodes"]}
    assert n_before == n_after
    assert len(n_before) >= 30  # whole corpus reachable from the seed


def test_overmerge_bridge_is_weak():
    """KESTREL↔VIPER joined only by a weak, forgeable bridge (~0.5)."""
    d = edge_detail("h_kes1", "h_vip1", asof=T_END)
    assert 0.45 < d["p"] < 0.65
    # a high θ keeps them apart; a θ below the bridge fuses them
    assert d["p"] < 0.75


def test_time_separation_of_transferred_account():
    """crow_walker↔sable_kite: strong before the sale, contested after."""
    before = edge_detail("h_crow", "h_sable", asof=BEFORE)
    after = edge_detail("h_crow", "h_sable", asof=AFTER)
    assert before["p"] > 0.9
    assert after["p"] < 0.15
    assert after["contested"] is True
    assert before["contested"] is False


def test_module_ablation_drops_soft_link():
    """night_raven survives on soft evidence; ablating it drops below θ≈0.75."""
    full = edge_detail("forum_raven", "h_kes1", asof=T_END)
    ablated = edge_detail(
        "forum_raven", "h_kes1", asof=T_END, disabled={"stylometry", "timezone"}
    )
    assert full["p"] > 0.75
    assert ablated["p"] < 0.6


def test_immutable_anchor_holds_renamed_handle():
    """kestrel_ops→k3strel: handles barely match, but the Telegram UID does."""
    handle_only = edge_detail("h_kes1", "h_kes2", asof=T_END)
    via_uid = edge_detail("h_kes2", "tg_kes", asof=T_END)
    assert handle_only["p"] < 0.4  # string similarity alone is weak
    assert via_uid["p"] > 0.9  # the anchor holds identity together


def test_broken_link_returns_zero_not_prior():
    """An edge with no live evidence at asof reads 0, not the base rate."""
    # tg_sable only becomes valid at/after the transfer.
    d = edge_detail("h_sable", "tg_sable", asof=BEFORE)
    assert d["p"] == 0.0
    assert d["active"] is False
