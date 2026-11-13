from datetime import timedelta

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select

from app.audit import AuditLog, audit
from app.auth.deps import CurrentUser, client_ip, session_from_cookie
from app.auth.models import User
from app.auth.security import end_all_sessions, hash_password, now, sha256, start_session, verify_password
from app.config import settings
from app.db import DB
from app.errors import AppError, error_body

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


class UserOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    name: str
    email: str
    is_owner: bool
    is_active: bool
    totp_enabled: bool


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


def recent_failures(db: DB, email: str) -> int:
    since = now() - timedelta(minutes=settings.login_lockout_minutes)
    return db.scalar(
        select(func.count()).select_from(AuditLog).where(
            AuditLog.action == "login_failed", AuditLog.at >= since, AuditLog.after["email"].astext == email
        )
    )


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: DB):
    email = body.email.strip().lower()
    db.info["ip"] = client_ip(request)
    if recent_failures(db, email) >= settings.login_max_failures:
        return JSONResponse(error_body("too_many_attempts", "Too many failed attempts, try again later"), 429)

    user = db.scalar(select(User).where(User.email == email))
    if user is None or not user.is_active or not verify_password(user, body.password):
        # returned (not raised) so the failure record is committed
        audit(db, "login_failed", entity_type="users", entity_id=user.id if user else None,
              after={"email": email})
        return JSONResponse(error_body("invalid_login", "Wrong email or password"), 401)

    start_session(db, user, response, db.info["ip"], request.headers.get("user-agent"),
                  mfa_pending=user.totp_enabled)
    if user.totp_enabled:
        return {"mfa_required": True}
    user.last_login_at = now()
    audit(db, "login", entity_type="users", entity_id=user.id, user_id=user.id)
    return {"mfa_required": False, "user": UserOut.model_validate(user)}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: DB):
    try:
        s = session_from_cookie(request, db, allow_mfa_pending=True)
        db.delete(s)
        audit(db, "logout", entity_type="users", entity_id=s.user_id, user_id=s.user_id)
    except AppError:
        pass
    response.delete_cookie(settings.cookie_name, path="/")


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser):
    return user


@router.post("/change-password", status_code=204)
def change_password(body: ChangePasswordIn, request: Request, user: CurrentUser, db: DB):
    if not verify_password(user, body.current_password):
        raise AppError(400, "invalid_password", "Current password is wrong", {"current_password": "wrong"})
    user.password_hash = hash_password(body.new_password)
    end_all_sessions(db, user.id, except_hash=sha256(request.cookies[settings.cookie_name]))
    audit(db, "change_password", entity_type="users", entity_id=user.id)
