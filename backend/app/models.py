import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class User(Base):
    """App-local user, keyed on the platform's coders_id.

    coders.kr already knows who this visitor is (they signed in via
    `mcp.coders.kr/sso/login`); we keep a row the first time we see them
    so belief state can FK against a stable local UUID.
    """

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    coders_id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), unique=True, nullable=False, index=True
    )
    display_name: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
    )

    beliefs: Mapped[list["BeliefState"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class BeliefState(Base):
    """Per-analyst, per-seed belief store — the persistent side of the
    active-exploration model.

    STEALTHGRAPH stores no "merges"; what it *does* persist is the
    analyst's evolving judgement: which identifiers they have chosen to
    trust into an identity, grouped by hypothesis (category). This mirrors
    the client's localStorage shape exactly so the two can round-trip:

        data = {
          categories: [{id, label, color}],       # competing hypotheses (ACH)
          trustByCat: { [catId]: [nodeId, ...] },  # nodes trusted per hypothesis
          activeCats: [catId, ...]                 # which hypotheses are shown
        }

    One row per (user, seed): switching seeds shows only that seed's
    trust, and returning restores it. Seed-scoped because trust is a
    statement made *relative to* a starting identity.
    """

    __tablename__ = "belief_states"
    __table_args__ = (
        sa.UniqueConstraint("user_id", "seed", name="uq_belief_user_seed"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # The investigation's starting identifier (dataset node id).
    seed: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
    )

    user: Mapped[User] = relationship(back_populates="beliefs")


class Case(Base):
    """A saved live investigation — the durable work product.

    A live session is ephemeral (in-memory, per-browser, 3h TTL); an analyst
    can't hand a browser tab to their boss or law enforcement. A Case snapshots
    the whole investigation (identifiers, evidence, fire log, reuse-breadth)
    plus the analyst's written assessment, so it survives, re-opens, and
    exports to an intel report.

        snapshot   — serialized LiveSession (see live_graph.to_snapshot)
        assessment — { bluf, confidence, recommendations, notes } authored by
                     the analyst (the human judgement the graph can't produce)
    """

    __tablename__ = "cases"

    id: Mapped[uuid.UUID] = mapped_column(
        sa.UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(sa.String(160), nullable=False)
    seed: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    assessment: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now()
    )

    user: Mapped[User] = relationship()
