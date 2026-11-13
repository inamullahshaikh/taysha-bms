import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Response
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.auth.models import User, UserSession
from app.config import settings
from app.errors import AppError

_ph = PasswordHasher()
MIN_PASSWORD = 10


def now() -> datetime:
    return datetime.now(UTC)


def hash_password(password: str) -> str:
    if len(password) < MIN_PASSWORD:
        raise AppError(422, "weak_password", f"Password must be at least {MIN_PASSWORD} characters",
                       {"password": "too short"})
    return _ph.hash(password)


def verify_password(user: User, password: str) -> bool:
    try:
        _ph.verify(user.password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False
    if _ph.check_needs_rehash(user.password_hash):
        user.password_hash = _ph.hash(password)
    return True


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def start_session(db: Session, user: User, response: Response, ip: str | None, ua: str | None,
                  mfa_pending: bool = False) -> None:
    token = secrets.token_urlsafe(32)
    t = now()
    db.add(UserSession(user_id=user.id, token_hash=sha256(token), last_seen_at=t, mfa_pending=mfa_pending,
                       expires_at=t + timedelta(days=settings.session_absolute_days), ip=ip,
                       user_agent=(ua or "")[:255]))
    response.set_cookie(settings.cookie_name, token, max_age=settings.session_absolute_days * 86400,
                        httponly=True, secure=settings.cookie_secure, samesite="lax", path="/")


def end_all_sessions(db: Session, user_id: int, except_hash: str | None = None) -> None:
    q = delete(UserSession).where(UserSession.user_id == user_id)
    if except_hash:
        q = q.where(UserSession.token_hash != except_hash)
    db.execute(q)
