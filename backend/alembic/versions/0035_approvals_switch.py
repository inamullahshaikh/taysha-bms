"""company switch for the approval workflow (off by default)

Revision ID: 0035
Revises: 0034
"""
from alembic import op
import sqlalchemy as sa


revision = '0035'
down_revision = '0034'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('company', sa.Column('approvals_required', sa.Boolean(), server_default='false', nullable=False))


def downgrade():
    op.drop_column('company', 'approvals_required')
