from datetime import datetime
from decimal import Decimal
from typing import Annotated

from fastapi import Depends
from sqlalchemy import BigInteger, DateTime, ForeignKey, MetaData, Numeric, create_engine, event, func
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, declared_attr, mapped_column, sessionmaker

from app.config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)

# Column types used everywhere: money never as float
Money = Annotated[Decimal, mapped_column(Numeric(14, 2))]
Qty = Annotated[Decimal, mapped_column(Numeric(14, 3))]


class Base(DeclarativeBase):
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


class Entity:
    """Standard columns for business records: id, timestamps, who changed it, soft-archive."""

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @declared_attr
    def created_by_id(cls) -> Mapped[int | None]:
        return mapped_column(BigInteger, ForeignKey("users.id"))

    @declared_attr
    def updated_by_id(cls) -> Mapped[int | None]:
        return mapped_column(BigInteger, ForeignKey("users.id"))


@event.listens_for(Session, "before_flush")
def _stamp_user(session: Session, *_):
    """Fill created_by/updated_by from the user that the auth dependency put on the session."""
    user_id = session.info.get("user_id")
    if user_id is None:
        return
    for obj in session.new:
        if isinstance(obj, Entity):
            obj.created_by_id = obj.created_by_id or user_id
            obj.updated_by_id = user_id
    for obj in session.dirty:
        if isinstance(obj, Entity):
            obj.updated_by_id = user_id


def get_db():
    """One transaction per request: commits after the endpoint returns, rolls back on any error."""
    from app.errors import KeepChangesError

    db = SessionLocal()
    try:
        yield db
        db.commit()
    except KeepChangesError:
        db.commit()
        raise
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


# scope="function": commit happens before the response is sent, so a failed commit is a 500, never a fake 200
DB = Annotated[Session, Depends(get_db, scope="function")]
