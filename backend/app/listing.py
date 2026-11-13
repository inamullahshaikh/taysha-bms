"""Paging/sorting/search for list endpoints, and CSV/Excel export."""

import csv
import io
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Generic, TypeVar

from fastapi import Query
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from pydantic import BaseModel
from sqlalchemy import Select, func, or_, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.errors import AppError


T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class ListParams:
    def __init__(
        self,
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1, le=500),
        sort: str | None = Query(None, description="field or -field"),
        q: str | None = Query(None, description="text search"),
        include_archived: bool = False,
    ):
        self.page, self.page_size, self.sort, self.q, self.include_archived = (
            page, page_size, sort, q, include_archived)


def apply_filters(query: Select, model, p: ListParams, search: tuple = (), sorts: dict | None = None,
                  default_sort=None) -> Select:
    if p.q and search:
        like = f"%{p.q.strip()}%"
        query = query.where(or_(*(c.ilike(like) for c in search)))
    if hasattr(model, "archived_at") and not p.include_archived:
        query = query.where(model.archived_at.is_(None))
    if p.sort:
        sorts = sorts or {}
        key = p.sort.lstrip("-")
        if key not in sorts:
            raise AppError(422, "invalid_sort", f"Can't sort by {key}", {"sort": f"one of {sorted(sorts)}"})
        query = query.order_by(sorts[key].desc() if p.sort.startswith("-") else sorts[key].asc())
    query = query.order_by(default_sort if default_sort is not None else model.id.desc())
    return query


def paginate(db: Session, query: Select, p: ListParams, schema: type[BaseModel] | None = None) -> dict:
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    rows = db.scalars(query.offset((p.page - 1) * p.page_size).limit(p.page_size)).all()
    items = [schema.model_validate(r) for r in rows] if schema else rows
    return {"items": items, "total": total, "page": p.page, "page_size": p.page_size}


def _cell(v: Any):
    if isinstance(v, Decimal):
        return float(v)  # Excel number cell
    if isinstance(v, datetime):
        return v.replace(tzinfo=None)
    return v


def export_response(db: Session, rows: list[dict], columns: list[tuple[str, str]], fmt: str, name: str,
                    entity_type: str) -> StreamingResponse:
    """columns: [(key, header)]. Every export is written to the audit log."""
    audit(db, "export", entity_type=entity_type, note=f"{fmt}, {len(rows)} rows")
    stamp = date.today().isoformat()
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow([h for _, h in columns])
        for r in rows:
            w.writerow([r.get(k) for k, _ in columns])
        data, media, ext = buf.getvalue().encode("utf-8-sig"), "text/csv", "csv"
    elif fmt == "xlsx":
        wb = Workbook()
        ws = wb.active
        ws.append([h for _, h in columns])
        for r in rows:
            ws.append([_cell(r.get(k)) for k, _ in columns])
        out = io.BytesIO()
        wb.save(out)
        data, media, ext = out.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"
    else:
        raise AppError(422, "invalid_format", "Format must be csv or xlsx")
    return StreamingResponse(io.BytesIO(data), media_type=media,
                             headers={"Content-Disposition": f'attachment; filename="{name}-{stamp}.{ext}"'})
