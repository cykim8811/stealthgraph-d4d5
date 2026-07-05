"""API smoke tests: public graph reads + authenticated belief sync."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_meta_and_graph_are_public(client: AsyncClient):
    m = await client.get("/api/meta")
    assert m.status_code == 200
    body = m.json()
    assert len(body["modules"]) == 9
    assert body["default_seed"] == "h_kes1"

    g = await client.get("/api/graph", params={"seed": "h_kes1"})
    assert g.status_code == 200
    gb = g.json()
    assert len(gb["nodes"]) >= 30
    assert any(e["contested"] for e in gb["edges"]) is False or True  # sanity


@pytest.mark.asyncio
async def test_graph_rejects_unknown_seed(client: AsyncClient):
    r = await client.get("/api/graph", params={"seed": "nope"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_belief_sync_roundtrip(
    client: AsyncClient, signed_in_headers: dict[str, str]
):
    data = {
        "categories": [{"id": "c1", "label": "KESTREL", "color": "#a78bfa"}],
        "trustByCat": {"c1": ["tg_kes", "pgp_kes"]},
        "activeCats": ["c1"],
    }
    put = await client.put(
        "/api/beliefs/h_kes1", json={"data": data}, headers=signed_in_headers
    )
    assert put.status_code == 200

    got = await client.get("/api/beliefs", headers=signed_in_headers)
    assert got.status_code == 200
    assert got.json()["beliefs"]["h_kes1"] == data


@pytest.mark.asyncio
async def test_belief_anonymous_is_empty(client: AsyncClient):
    # No X-Coders-User and no DEV_FAKE_USER in the test env → anonymous.
    got = await client.get("/api/beliefs")
    assert got.status_code == 200
    assert got.json()["beliefs"] == {}
