"""Test fixtures.

Wires up:
- a real Postgres (see TEST_DATABASE_URL) — we don't mock the DB because
  the app uses Postgres-specific things (ON CONFLICT, JSONB).
- an httpx AsyncClient against the FastAPI app via ASGITransport (no
  network round-trip).
- a `signed_in` helper that stamps `X-Coders-User` the way the gate would.

Each test starts with truncated tables. To keep asyncpg connections from
leaking across pytest-asyncio's per-test event loops (which surfaces as
"another operation is in progress"), every fixture opens a *fresh* engine
and disposes it before the loop closes.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.database import Base, engine as app_engine
from app.main import app

TEST_DATABASE_URL = os.getenv(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://app:app@localhost:5432/app",
)


@pytest_asyncio.fixture(autouse=True)
async def _clean_db() -> AsyncIterator[None]:
    """Ensure tables exist and start each test from empty. Uses a throwaway
    engine bound to *this* test's event loop, then disposes it."""
    engine = create_async_engine(TEST_DATABASE_URL, poolclass=None)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(
            text("TRUNCATE TABLE belief_states, users RESTART IDENTITY CASCADE")
        )
    await engine.dispose()
    yield
    # The app engine may have opened connections on this loop while serving
    # requests; drop them so the next test's loop starts clean.
    await app_engine.dispose()


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """ASGI client — no real network."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
def fake_user_id() -> UUID:
    return uuid4()


@pytest.fixture
def signed_in_headers(fake_user_id: UUID) -> dict[str, str]:
    """Stamp X-Coders-User the way the platform gate would."""
    return {"X-Coders-User": str(fake_user_id)}
