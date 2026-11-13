from datetime import datetime

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr
from sqlalchemy import delete, select

from app.audit import audit, snapshot
from app.auth.access import UserAccess, access_map, can, require_access
from app.auth.features import FEATURES
from app.auth.models import User
from app.auth.security import end_all_sessions, hash_password
from app.db import DB
from app.errors import AppError, conflict, not_found
from app.listing import ListParams, Page, apply_filters, export_response, paginate

router = APIRouter(tags=["users"])
VIEW = require_access("access_management", "view")
EDIT = require_access("access_management", "edit")


class UserOut(BaseModel):
    model_config = {"from_attributes": True}
    id: int
    name: str
    email: str
    is_owner: bool
    is_active: bool
    totp_enabled: bool
    last_login_at: datetime | None


class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str
    is_owner: bool = False


class UserUpdate(BaseModel):
    name: str | None = None
    email: EmailStr | None = None
    is_owner: bool | None = None


class PasswordReset(BaseModel):
    new_password: str


class AccessIn(BaseModel):
    access: dict[str, list[str]]


def get_user(db: DB, user_id: int) -> User:
    u = db.get(User, user_id)
    if u is None:
        raise not_found("User")
    return u


def guard_target(actor: User, target: User) -> None:
    """Only owners may change owner accounts; nobody changes their own account status or access here."""
    if target.id == actor.id:
        raise AppError(403, "forbidden", "You can't change your own account or access here")
    if target.is_owner and not actor.is_owner:
        raise AppError(403, "forbidden", "Only an owner can change an owner account")


@router.get("/access/features")
def features(_: User = VIEW):
    return [{"key": k, "label": label, "actions": list(actions)} for k, (label, actions) in FEATURES.items()]


SEARCH = (User.name, User.email)
SORTS = {"name": User.name, "email": User.email, "last_login_at": User.last_login_at}


@router.get("/users", response_model=Page[UserOut])
def list_users(db: DB, p: Annotated[ListParams, Depends()], active: bool | None = None, _: User = VIEW):
    q = apply_filters(select(User), User, p, SEARCH, SORTS, User.name)
    if active is not None:
        q = q.where(User.is_active == active)
    return paginate(db, q, p, UserOut)


@router.get("/users/export")
def export_users(db: DB, p: Annotated[ListParams, Depends()], format: str = "csv",
                 _: User = require_access("access_management", "export")):
    q = apply_filters(select(User), User, p, SEARCH, SORTS, User.name)
    rows = [UserOut.model_validate(u).model_dump() for u in db.scalars(q)]
    cols = [("name", "Name"), ("email", "Email"), ("is_active", "Active"), ("is_owner", "Owner"),
            ("last_login_at", "Last login")]
    return export_response(db, rows, cols, format, "users", "users")


@router.get("/users/{user_id}", response_model=UserOut)
def read_user(user_id: int, db: DB, _: User = VIEW):
    return get_user(db, user_id)


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, db: DB, actor: User = EDIT):
    if body.is_owner and not actor.is_owner:
        raise AppError(403, "forbidden", "Only an owner can create an owner")
    email = body.email.lower()
    if db.scalar(select(User).where(User.email == email)):
        raise conflict("A user with that email already exists", "duplicate_email")
    u = User(name=body.name, email=email, password_hash=hash_password(body.password), is_owner=body.is_owner)
    db.add(u)
    audit(db, "create", u)
    return u


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, db: DB, actor: User = EDIT):
    u = get_user(db, user_id)
    guard_target(actor, u)
    if body.is_owner is not None and not actor.is_owner:
        raise AppError(403, "forbidden", "Only an owner can change owner status")
    before = snapshot(u)
    data = body.model_dump(exclude_unset=True)
    if "email" in data:
        data["email"] = data["email"].lower()
        if db.scalar(select(User).where(User.email == data["email"], User.id != u.id)):
            raise conflict("A user with that email already exists", "duplicate_email")
    for k, v in data.items():
        setattr(u, k, v)
    audit(db, "update", u, before=before)
    return u


@router.post("/users/{user_id}/deactivate", response_model=UserOut)
def deactivate(user_id: int, db: DB, actor: User = EDIT):
    u = get_user(db, user_id)
    guard_target(actor, u)
    u.is_active = False
    end_all_sessions(db, u.id)
    audit(db, "deactivate", entity_type="users", entity_id=u.id)
    return u


@router.post("/users/{user_id}/reactivate", response_model=UserOut)
def reactivate(user_id: int, db: DB, actor: User = EDIT):
    u = get_user(db, user_id)
    guard_target(actor, u)
    u.is_active = True
    audit(db, "reactivate", entity_type="users", entity_id=u.id)
    return u


@router.post("/users/{user_id}/reset-password", status_code=204)
def reset_password(user_id: int, body: PasswordReset, db: DB, actor: User = EDIT):
    u = get_user(db, user_id)
    guard_target(actor, u)
    u.password_hash = hash_password(body.new_password)
    end_all_sessions(db, u.id)
    audit(db, "reset_password", entity_type="users", entity_id=u.id)


@router.post("/users/{user_id}/reset-2fa", status_code=204)
def reset_2fa(user_id: int, db: DB, actor: User = EDIT):
    """For a user who lost their phone and recovery codes."""
    u = get_user(db, user_id)
    guard_target(actor, u)
    u.totp_enabled, u.totp_secret, u.recovery_codes = False, None, None
    end_all_sessions(db, u.id)
    audit(db, "2fa_reset", entity_type="users", entity_id=u.id)


@router.get("/users/{user_id}/access")
def read_access(user_id: int, db: DB, _: User = VIEW) -> dict[str, list[str]]:
    return access_map(db, get_user(db, user_id))


def replace_access(db: DB, actor: User, target: User, access: dict[str, list[str]]) -> dict[str, list[str]]:
    guard_target(actor, target)
    wanted: set[tuple[str, str]] = set()
    for feature, actions in access.items():
        if feature not in FEATURES:
            raise AppError(422, "unknown_feature", f"Unknown feature {feature}", {feature: "unknown"})
        for a in actions:
            if a not in FEATURES[feature][1]:
                raise AppError(422, "unknown_action", f"{feature} has no action {a}", {feature: a})
            wanted.add((feature, a))

    before = access_map(db, target)
    current = {(f, a) for f, acts in before.items() for a in acts}
    # A non-owner can only hand out (or take away) access they hold themselves
    for f, a in wanted ^ current:
        if not can(db, actor, f, a):
            raise AppError(403, "forbidden", f"You can't grant {a} on {FEATURES[f][0]} because you don't have it")

    db.execute(delete(UserAccess).where(UserAccess.user_id == target.id))
    db.add_all(UserAccess(user_id=target.id, feature=f, action=a, granted_by_id=actor.id) for f, a in wanted)
    db.flush()
    db.info.pop(("access", target.id), None)
    after = access_map(db, target)
    audit(db, "access_change", entity_type="users", entity_id=target.id, before=before, after=after)
    return after


@router.put("/users/{user_id}/access")
def put_access(user_id: int, body: AccessIn, db: DB, actor: User = EDIT) -> dict[str, list[str]]:
    return replace_access(db, actor, get_user(db, user_id), body.access)


@router.post("/users/{user_id}/access/copy-from/{source_id}")
def copy_access(user_id: int, source_id: int, db: DB, actor: User = EDIT) -> dict[str, list[str]]:
    source = get_user(db, source_id)
    if source.is_owner:
        raise AppError(422, "owner_source", "Owners have everything implicitly; make the user an owner instead")
    return replace_access(db, actor, get_user(db, user_id), access_map(db, source))

routers = [router]
