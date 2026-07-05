"""initial schema: users + belief_states

Revision ID: 0001
Revises:
Create Date: 2026-07-04 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB


revision: str = "0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "coders_id", sa.UUID(as_uuid=True), unique=True, nullable=False
        ),
        sa.Column("display_name", sa.String(64), nullable=False),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("ix_users_coders_id", "users", ["coders_id"])

    op.create_table(
        "belief_states",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("seed", sa.String(64), nullable=False),
        sa.Column("data", JSONB, nullable=False, server_default="{}"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("user_id", "seed", name="uq_belief_user_seed"),
    )
    op.create_index("ix_belief_states_user_id", "belief_states", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_belief_states_user_id", table_name="belief_states")
    op.drop_table("belief_states")
    op.drop_index("ix_users_coders_id", table_name="users")
    op.drop_table("users")
