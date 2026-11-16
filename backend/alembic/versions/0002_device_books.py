"""device books: PDF and conversion kept on the user's device (app), metadata synced

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-16 12:00:00
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table('books', schema=None) as batch_op:
        batch_op.add_column(sa.Column('storage_mode', sa.String(length=10), server_default='server', nullable=False))
        batch_op.create_check_constraint(op.f('ck_books_storage_mode'), "storage_mode IN ('server', 'device')")


def downgrade() -> None:
    with op.batch_alter_table('books', schema=None) as batch_op:
        batch_op.drop_constraint(op.f('ck_books_storage_mode'), type_='check')
        batch_op.drop_column('storage_mode')
