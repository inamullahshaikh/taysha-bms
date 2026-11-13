from datetime import datetime

from fastapi import Depends
from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.auth.deps import current_user
from app.auth.features import FEATURES
from app.auth.models import User
from app.db import DB, Base
from app.errors import AppError


class UserAccess(Base):
    __tablename__ = "user_access"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    feature: Mapped[str] = mapped_column(String(50), primary_key=True)
    action: Mapped[str] = mapped_column(String(20), primary_key=True)
    granted_by_id: Mapped[int | None] = mapped_column(BigInteger)
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


def grants(db: Session, user: User) -> set[tuple[str, str]]:
    """The user's (feature, action) pairs, loaded once per request."""
    key = ("access", user.id)
    if key not in db.info:
        rows = db.execute(select(UserAccess.feature, UserAccess.action).where(UserAccess.user_id == user.id))
        db.info[key] = {(f, a) for f, a in rows}
    return db.info[key]


def can(db: Session, user: User, feature: str, action: str = "view") -> bool:
    return user.is_owner or (feature, action) in grants(db, user)


def require_access(feature: str, action: str = "view"):
    """Endpoint dependency: 403 unless the user has this grant. Use as `user: User = require_access(...)`."""
    if action not in FEATURES[feature][1]:
        raise ValueError(f"{feature} has no action {action}")  # fails at import, catches typos

    def dep(db: DB, user: User = Depends(current_user)) -> User:
        if not can(db, user, feature, action):
            raise AppError(403, "forbidden", f"You don't have {action} access to {FEATURES[feature][0]}")
        return user

    return Depends(dep)


def ensure(db: Session, user: User, feature: str, action: str = "view") -> None:
    if not can(db, user, feature, action):
        raise AppError(403, "forbidden", f"You don't have {action} access to {FEATURES[feature][0]}")


def access_map(db: Session, user: User) -> dict[str, list[str]]:
    if user.is_owner:
        return {f: list(actions) for f, (_, actions) in FEATURES.items()}
    out: dict[str, list[str]] = {}
    for f, a in sorted(grants(db, user)):
        if f in FEATURES and a in FEATURES[f][1]:
            out.setdefault(f, []).append(a)
    return out
