"""Standard list/get/create/update/archive/restore/export endpoints for simple master-data tables."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import JSONB

from app.audit import audit, snapshot
from app.auth.access import require_access
from app.auth.features import FEATURES
from app.auth.models import User
from app.db import DB
from app.errors import AppError, not_found
from app.listing import ListParams, Page, apply_filters, export_response, paginate


class RecordOut(BaseModel):
    """Base for output schemas of Entity tables."""

    model_config = {"from_attributes": True}
    id: int
    archived_at: datetime | None = None


def get_or_404(db, model, id_: int, what: str | None = None):
    obj = db.get(model, id_)
    if obj is None:
        raise not_found(what or model.__name__)
    return obj


def equality_filters(query, request: Request, filters: dict):
    """?name=value for each allowed filter; ?name=a,b matches either. JSONB list columns match when they contain
    the value."""
    for name, col in filters.items():
        raw = request.query_params.get(name)
        if raw is None or raw == "":
            continue
        if isinstance(col.type, JSONB):
            query = query.where(col.contains([raw]))
            continue
        try:
            conv = col.type.python_type
            values = [conv(v) if conv is not bool else v.lower() == "true" for v in raw.split(",")]
        except (ValueError, TypeError):
            raise AppError(422, "invalid_filter", f"Invalid value for {name}", {name: "invalid"})
        query = query.where(col == values[0] if len(values) == 1 else col.in_(values))
    return query


def crud_router(
    model,
    *,
    prefix: str,
    feature: str,
    create: type[BaseModel],
    update: type[BaseModel],
    out: type[BaseModel],
    search: tuple = (),
    sorts: dict | None = None,
    filters: dict | None = None,
    default_sort=None,
    tags: list[str] | None = None,
) -> APIRouter:
    r = APIRouter(prefix=prefix, tags=tags or [prefix.strip("/").split("/")[-1]])
    actions = FEATURES[feature][1]

    def need(a: str, fallback: str):  # e.g. "settings" has only view/edit: creating a branch needs edit
        return require_access(feature, a if a in actions else fallback)

    view, add, edit = need("view", "view"), need("create", "edit"), need("edit", "edit")
    arch, exp = need("archive", "edit"), need("export", "view")
    sorts, filters = sorts or {}, filters or {}

    def query(p: ListParams, request: Request):
        q = apply_filters(select(model), model, p, search, sorts, default_sort)
        return equality_filters(q, request, filters)

    @r.get("", response_model=Page[out])
    def list_(db: DB, p: Annotated[ListParams, Depends()], request: Request, _: User = view):
        return paginate(db, query(p, request), p, out)

    @r.get("/export")
    def export(db: DB, p: Annotated[ListParams, Depends()], request: Request, format: str = "csv",
               _: User = exp):
        rows = [out.model_validate(o).model_dump() for o in db.scalars(query(p, request)).all()]
        cols = [(k, k.replace("_", " ").title()) for k in out.model_fields]
        return export_response(db, rows, cols, format, prefix.strip("/").replace("/", "-"), model.__tablename__)

    @r.get("/{id}", response_model=out)
    def read(id: int, db: DB, _: User = view):
        return get_or_404(db, model, id)

    @r.post("", response_model=out, status_code=201)
    def create_(body: create, db: DB, _: User = add):  # type: ignore[valid-type]
        obj = model(**body.model_dump())
        db.add(obj)
        audit(db, "create", obj)
        return obj

    @r.patch("/{id}", response_model=out)
    def update_(id: int, body: update, db: DB, _: User = edit):  # type: ignore[valid-type]
        obj = get_or_404(db, model, id)
        before = snapshot(obj)
        for k, v in body.model_dump(exclude_unset=True).items():
            setattr(obj, k, v)
        audit(db, "update", obj, before=before)
        return obj

    @r.post("/{id}/archive", response_model=out)
    def archive(id: int, db: DB, _: User = arch):
        obj = get_or_404(db, model, id)
        obj.archived_at = func.now()
        audit(db, "archive", obj)
        db.flush()
        db.refresh(obj)
        return obj

    @r.post("/{id}/restore", response_model=out)
    def restore(id: int, db: DB, _: User = arch):
        obj = get_or_404(db, model, id)
        obj.archived_at = None
        audit(db, "restore", obj)
        return obj

    return r
