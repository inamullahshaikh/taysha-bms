from datetime import timedelta
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import select

from app.auth.models import User, UserSession
from app.auth.security import now, sha256
from app.config import settings
from app.db import DB
from app.errors import AppError

NOT_AUTH = AppError(401, "not_authenticated", "Please log in")


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def session_from_cookie(request: Request, db: DB, allow_mfa_pending: bool = False) -> UserSession:
    token = request.cookies.get(settings.cookie_name)
    if not token:
        raise NOT_AUTH
    s = db.scalar(select(UserSession).where(UserSession.token_hash == sha256(token)))
    t = now()
    if (
        s is None
        or s.expires_at < t
        or s.last_seen_at < t - timedelta(minutes=settings.session_idle_minutes)
        or (s.mfa_pending and not allow_mfa_pending)
    ):
        raise NOT_AUTH
    return s


def current_user(request: Request, db: DB) -> User:
    s = session_from_cookie(request, db)
    user = db.get(User, s.user_id)
    if user is None or not user.is_active:
        raise NOT_AUTH
    t = now()
    if t - s.last_seen_at > timedelta(minutes=1):  # avoid a write on every request
        s.last_seen_at = t
    db.info["user_id"] = user.id
    db.info["ip"] = client_ip(request)
    return user


CurrentUser = Annotated[User, Depends(current_user)]
