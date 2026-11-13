import secrets
from datetime import timedelta

import pyotp
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from app.audit import AuditLog, audit
from app.auth.deps import CurrentUser, client_ip, session_from_cookie
from app.auth.models import User
from app.auth.router import UserOut
from app.auth.security import now, sha256, verify_password
from app.config import settings
from app.db import DB
from app.errors import AppError, error_body

router = APIRouter(prefix="/auth/2fa", tags=["auth"])
ISSUER = "Taysha BMS"


class CodeIn(BaseModel):
    code: str


class PasswordIn(BaseModel):
    password: str


def check_code(user: User, code: str) -> bool:
    """TOTP code, or a one-time recovery code (consumed on use)."""
    code = code.strip().replace(" ", "")
    # ponytail: no TOTP replay protection within the 30s window; add last-used-step tracking if required
    if user.totp_secret and pyotp.TOTP(user.totp_secret).verify(code, valid_window=1):
        return True
    h = sha256(code.lower())
    if user.recovery_codes and h in user.recovery_codes:
        user.recovery_codes = [c for c in user.recovery_codes if c != h]
        return True
    return False


@router.post("/setup")
def setup(user: CurrentUser):
    if user.totp_enabled:
        raise AppError(409, "already_enabled", "Two-factor authentication is already on")
    user.totp_secret = pyotp.random_base32()
    return {"secret": user.totp_secret,
            "otpauth_uri": pyotp.TOTP(user.totp_secret).provisioning_uri(user.email, issuer_name=ISSUER)}


@router.post("/enable")
def enable(body: CodeIn, user: CurrentUser, db: DB):
    if not user.totp_secret or user.totp_enabled:
        raise AppError(409, "setup_required", "Start 2FA setup first")
    if not pyotp.TOTP(user.totp_secret).verify(body.code.strip(), valid_window=1):
        raise AppError(400, "invalid_code", "That code is not valid", {"code": "invalid"})
    codes = [secrets.token_hex(5) for _ in range(10)]
    user.recovery_codes = [sha256(c) for c in codes]
    user.totp_enabled = True
    audit(db, "2fa_enabled", entity_type="users", entity_id=user.id)
    return {"recovery_codes": codes}  # shown once


@router.post("/disable", status_code=204)
def disable(body: PasswordIn, user: CurrentUser, db: DB):
    if not verify_password(user, body.password):
        raise AppError(400, "invalid_password", "Password is wrong", {"password": "wrong"})
    user.totp_enabled, user.totp_secret, user.recovery_codes = False, None, None
    audit(db, "2fa_disabled", entity_type="users", entity_id=user.id)


@router.post("/verify")
def verify(body: CodeIn, request: Request, db: DB):
    """Second login step for users with 2FA."""
    s = session_from_cookie(request, db, allow_mfa_pending=True)
    user = db.get(User, s.user_id)
    db.info["ip"] = client_ip(request)
    since = now() - timedelta(minutes=settings.login_lockout_minutes)
    failures = db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "2fa_failed", AuditLog.entity_id == user.id, AuditLog.at >= since))
    if failures >= settings.login_max_failures:
        db.delete(s)
        return JSONResponse(error_body("too_many_attempts", "Too many failed attempts, try again later"), 429)
    if not s.mfa_pending:
        raise AppError(409, "not_pending", "Already verified")
    if not check_code(user, body.code):
        audit(db, "2fa_failed", entity_type="users", entity_id=user.id, user_id=user.id)
        return JSONResponse(error_body("invalid_code", "That code is not valid"), 401)
    s.mfa_pending = False
    user.last_login_at = now()
    audit(db, "login", entity_type="users", entity_id=user.id, user_id=user.id)
    return {"user": UserOut.model_validate(user)}

routers = [router]
