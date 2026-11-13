"""Quality control, traceability, recalls and food-safety records."""

from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.audit import audit
from app.auth.access import require_access
from app.auth.models import User
from app.clock import local_today, utcnow
from app.crud import RecordOut, crud_router, get_or_404
from app.customers import Customer
from app.db import DB
from app.errors import AppError
from app.inventory.models import Batch, StockBalance, StockMovement
from app.inventory.service import fill_backorders
from app.listing import ListParams, Page, apply_filters, paginate
from app.numbering import next_number
from app.orders.models import Order, Shipment
from app.production.models import FoodSafetyRecord, ProductionOrder, QCCheck, QCTemplate, Recall
from app.products.models import Product
from app.purchasing.models import GoodsReceipt, GoodsReceiptLine
from app.suppliers import Supplier

VIEW, CREATE, EDIT = (require_access("quality", a) for a in ("view", "create", "edit"))


# ======================= QC =======================

class CheckDef(BaseModel):
    name: str
    type: Literal["pass_fail", "number", "text"] = "pass_fail"
    min: float | None = None  # thresholds, not money
    max: float | None = None
    unit: str | None = None


class TemplateIn(BaseModel):
    name: str = Field(min_length=1)
    stage: Literal["incoming", "production", "finished"]
    checks: list[CheckDef] = Field(min_length=1)


class TemplatePatch(BaseModel):
    name: str | None = None
    checks: list[CheckDef] | None = None


class TemplateOut(RecordOut):
    name: str
    stage: str
    checks: list[dict]


class ResultIn(BaseModel):
    name: str
    value: str | bool | Decimal | None = None
    passed: bool | None = None  # needed for text checks; worked out for numbers and pass/fail


class CheckIn(BaseModel):
    template_id: int | None = None
    stage: Literal["incoming", "production", "finished"]
    product_id: int | None = None
    batch_id: int | None = None
    production_order_id: int | None = None
    goods_receipt_id: int | None = None
    results: list[ResultIn] = Field(min_length=1)
    defects: str | None = None
    corrective_action: str | None = None


class CheckOut(RecordOut):
    template_id: int | None
    stage: str
    product_id: int | None
    batch_id: int | None
    production_order_id: int | None
    goods_receipt_id: int | None
    results: list[dict]
    result: str
    defects: str | None
    corrective_action: str | None
    created_by_id: int | None
    created_at: datetime


def evaluate(defs: dict[str, dict], r: ResultIn) -> dict:
    d = defs.get(r.name, {"type": "pass_fail" if isinstance(r.value, bool) else "text"})
    passed = r.passed
    if d["type"] == "pass_fail" and passed is None:
        passed = r.value is True or str(r.value).lower() in ("true", "pass", "yes", "ok")
    elif d["type"] == "number" and passed is None:
        try:
            v = Decimal(str(r.value))
        except (InvalidOperation, ValueError):
            raise AppError(422, "invalid_value", f"{r.name} needs a number")
        passed = ((d.get("min") is None or v >= Decimal(str(d["min"])))
                  and (d.get("max") is None or v <= Decimal(str(d["max"]))))
    elif passed is None:
        raise AppError(422, "passed_required", f"Say whether {r.name} passed")
    return {"name": r.name, "value": str(r.value) if r.value is not None else None, "passed": bool(passed),
            "unit": d.get("unit")}


qc = APIRouter(prefix="/qc", tags=["quality"])


@qc.post("/checks", response_model=CheckOut, status_code=201)
def record_check(body: CheckIn, db: DB, _: User = CREATE):
    """Record a QC check. On a batch: pass releases a held batch, fail rejects the batch."""
    defs = {}
    if body.template_id:
        t = get_or_404(db, QCTemplate, body.template_id, "QC template")
        defs = {c["name"]: c for c in t.checks}
        missing = set(defs) - {r.name for r in body.results}
        if missing:
            raise AppError(422, "missing_checks", f"Missing results: {', '.join(sorted(missing))}")
    results = [evaluate(defs, r) for r in body.results]
    result = "pass" if all(r["passed"] for r in results) else "fail"
    if result == "fail" and not body.defects:
        raise AppError(422, "defects_required", "Describe the defects", {"defects": "required"})
    batch_id, product_id = body.batch_id, body.product_id
    if body.production_order_id and batch_id is None:
        batch_id = get_or_404(db, ProductionOrder, body.production_order_id, "Production order").batch_id
    if batch_id:
        b = get_or_404(db, Batch, batch_id, "Batch")
        product_id = product_id or b.product_id
        if result == "pass" and b.status == "hold":
            b.status = "available"
            for (wh,) in db.execute(select(StockBalance.warehouse_id).where(StockBalance.batch_id == b.id,
                                                                          StockBalance.quantity > 0).distinct()):
                fill_backorders(db, b.product_id, wh)
        elif result == "fail":
            b.status = "rejected"
    c = QCCheck(template_id=body.template_id, stage=body.stage, product_id=product_id, batch_id=batch_id,
                production_order_id=body.production_order_id, goods_receipt_id=body.goods_receipt_id,
                results=results, result=result, defects=body.defects, corrective_action=body.corrective_action)
    db.add(c)
    audit(db, "qc", entity_type="batches" if batch_id else "qc_checks", entity_id=batch_id or None,
          after={"result": result})
    db.flush()
    return c


@qc.get("/checks", response_model=Page[CheckOut])
def list_checks(db: DB, p: Annotated[ListParams, Depends()], stage: str | None = None, result: str | None = None,
                batch_id: int | None = None, product_id: int | None = None, _: User = VIEW):
    q = apply_filters(select(QCCheck), QCCheck, p, (QCCheck.defects,), {})
    for k, v in (("stage", stage), ("result", result), ("batch_id", batch_id), ("product_id", product_id)):
        if v is not None:
            q = q.where(getattr(QCCheck, k) == v)
    return paginate(db, q, p, CheckOut)


@qc.get("/checks/{check_id}", response_model=CheckOut)
def read_check(check_id: int, db: DB, _: User = VIEW):
    return get_or_404(db, QCCheck, check_id, "QC check")


# ======================= traceability =======================

def batch_info(db: Session, b: Batch) -> dict:
    p = db.get(Product, b.product_id)
    return {"batch_id": b.id, "batch": b.number, "product_id": p.id, "product": p.name, "status": b.status,
            "mfg_date": b.mfg_date, "expiry_date": b.expiry_date,
            "supplier": db.get(Supplier, b.supplier_id).name if b.supplier_id else None,
            "supplier_batch_no": b.supplier_batch_no}


def forward(db: Session, batch_id: int, seen: set[int] | None = None) -> dict:
    """Where did this batch go: production orders that used it (and their batches), and sales."""
    seen = seen or set()
    seen.add(batch_id)
    b = db.get(Batch, batch_id)
    node = {**batch_info(db, b), "used_in": [], "sales": []}
    used = db.execute(select(StockMovement.reference_id, func.sum(-StockMovement.quantity))
                      .where(StockMovement.batch_id == batch_id, StockMovement.reason == "production_out",
                             StockMovement.reference_type == "production_order")
                      .group_by(StockMovement.reference_id)).all()
    for po_id, qty in used:
        po = db.get(ProductionOrder, po_id)
        child = forward(db, po.batch_id, seen) if po.batch_id and po.batch_id not in seen else None
        node["used_in"].append({"production_order_id": po.id, "number": po.number, "quantity_used": qty,
                                "output_batch": child})
    sold = db.execute(select(StockMovement.reference_id, func.sum(-StockMovement.quantity))
                      .where(StockMovement.batch_id == batch_id, StockMovement.reason == "sale",
                             StockMovement.reference_type == "shipment").group_by(StockMovement.reference_id)).all()
    for sh_id, qty in sold:
        sh = db.get(Shipment, sh_id)
        o = db.get(Order, sh.order_id)
        c = db.get(Customer, o.customer_id) if o.customer_id else None
        node["sales"].append({"order_id": o.id, "order": o.number, "shipment": sh.number,
                              "date": sh.dispatched_at, "quantity": qty, "customer_id": o.customer_id,
                              "customer": o.customer_name, "phone": c.phone if c else o.customer_phone})
    return node


def backward(db: Session, batch_id: int, seen: set[int] | None = None) -> dict:
    """Where did this batch come from: supplier receipt, or the production order and its input batches."""
    seen = seen or set()
    seen.add(batch_id)
    b = db.get(Batch, batch_id)
    node = {**batch_info(db, b), "received": [], "made_by": None}
    for gl, g in db.execute(select(GoodsReceiptLine, GoodsReceipt).join(GoodsReceipt)
                            .where(GoodsReceiptLine.batch_id == batch_id)):
        node["received"].append({"goods_receipt": g.number, "date": g.received_date, "quantity": gl.quantity,
                                 "supplier": db.get(Supplier, g.supplier_id).name, "qc_result": gl.qc_result})
    po = db.scalar(select(ProductionOrder).where(ProductionOrder.batch_id == batch_id))
    if po:
        inputs = db.execute(select(StockMovement.batch_id, StockMovement.product_id, func.sum(-StockMovement.quantity))
                            .where(StockMovement.reference_type == "production_order",
                                   StockMovement.reference_id == po.id,
                                   StockMovement.reason.in_(("production_out", "production_return")))
                            .group_by(StockMovement.batch_id, StockMovement.product_id)).all()
        node["made_by"] = {"production_order_id": po.id, "number": po.number, "completed_at": po.completed_at,
                           "inputs": [backward(db, bid, seen) | {"quantity_used": q} if bid and bid not in seen
                                      else {"product": db.get(Product, pid).name, "batch": None, "quantity_used": q}
                                      for bid, pid, q in inputs]}
    return node


def flatten(node: dict, orders: dict, batches: dict) -> None:
    batches[node["batch_id"]] = {k: node[k] for k in ("batch_id", "batch", "product", "status")}
    for s in node.get("sales", []):
        orders[s["order_id"]] = s
    for u in node.get("used_in", []):
        if u["output_batch"]:
            flatten(u["output_batch"], orders, batches)


trace = APIRouter(prefix="/trace", tags=["quality"])


@trace.get("/batches/{batch_id}")
def trace_batch(batch_id: int, db: DB, direction: Literal["forward", "backward"] = "forward", _: User = VIEW):
    get_or_404(db, Batch, batch_id, "Batch")
    if direction == "backward":
        return backward(db, batch_id)
    tree = forward(db, batch_id)
    orders, batches = {}, {}
    flatten(tree, orders, batches)
    return {"tree": tree, "affected_batches": list(batches.values()), "affected_orders": list(orders.values()),
            "affected_customers": len({o["customer_id"] or o["customer"] for o in orders.values()})}


# ======================= recalls =======================

class RecallIn(BaseModel):
    batch_id: int
    reason: str = Field(min_length=3)


class RecallClose(BaseModel):
    disposal_decision: str = Field(min_length=3)


class RecallOut(RecordOut):
    number: str
    batch_id: int
    reason: str
    status: str
    affected: dict
    disposal_decision: str | None
    closed_at: datetime | None
    created_at: datetime


recalls = APIRouter(prefix="/recalls", tags=["quality"])


@recalls.post("", response_model=RecallOut, status_code=201)
def start_recall(body: RecallIn, db: DB, _: User = EDIT):
    """Puts the batch and everything made from it on hold, and records who received it."""
    get_or_404(db, Batch, body.batch_id, "Batch")
    t = trace_batch(body.batch_id, db, "forward")
    for b in t["affected_batches"]:
        db.get(Batch, b["batch_id"]).status = "hold"
    affected = {"batches": t["affected_batches"],
                "orders": [{k: (str(v) if isinstance(v, (Decimal, datetime, date)) else v) for k, v in o.items()}
                           for o in t["affected_orders"]]}
    r = Recall(number=next_number(db, "recall"), batch_id=body.batch_id, reason=body.reason, affected=affected)
    db.add(r)
    audit(db, "create", r)
    db.flush()
    return r


@recalls.get("", response_model=Page[RecallOut])
def list_recalls(db: DB, p: Annotated[ListParams, Depends()], _: User = VIEW):
    return paginate(db, apply_filters(select(Recall), Recall, p, (Recall.number, Recall.reason), {}), p, RecallOut)


@recalls.get("/{recall_id}", response_model=RecallOut)
def read_recall(recall_id: int, db: DB, _: User = VIEW):
    return get_or_404(db, Recall, recall_id, "Recall")


@recalls.post("/{recall_id}/close", response_model=RecallOut)
def close_recall(recall_id: int, body: RecallClose, db: DB, _: User = EDIT):
    r = get_or_404(db, Recall, recall_id, "Recall")
    if r.status != "open":
        raise AppError(409, "closed", "Recall already closed")
    r.status, r.disposal_decision, r.closed_at = "closed", body.disposal_decision, utcnow()
    audit(db, "close", entity_type="recalls", entity_id=r.id, note=body.disposal_decision)
    return r


# ======================= food safety =======================

FSKind = Literal["procedure", "cleaning", "inspection", "temperature", "pest_control", "training", "other"]


class FoodSafetyIn(BaseModel):
    kind: FSKind
    title: str = Field(min_length=1)
    record_date: date
    performed_by: str | None = None
    area: str | None = None
    result: Literal["ok", "issue", "n/a"] | None = None
    notes: str | None = None
    next_due_date: date | None = None


class FoodSafetyPatch(BaseModel):
    title: str | None = None
    result: Literal["ok", "issue", "n/a"] | None = None
    notes: str | None = None
    next_due_date: date | None = None


class FoodSafetyOut(RecordOut, FoodSafetyIn):
    created_at: datetime


fs_extra = APIRouter(prefix="/food-safety", tags=["quality"])


@fs_extra.get("/due")
def due(db: DB, days: int = 7, _: User = VIEW):
    """Recurring checks (cleaning, pest control, ...) due within `days`, latest record per title."""
    latest = (select(FoodSafetyRecord.title, func.max(FoodSafetyRecord.id).label("id"))
              .where(FoodSafetyRecord.archived_at.is_(None)).group_by(FoodSafetyRecord.title).subquery())
    rows = db.scalars(select(FoodSafetyRecord).join(latest, latest.c.id == FoodSafetyRecord.id).where(
        FoodSafetyRecord.next_due_date <= local_today() + timedelta(days=days)).order_by(FoodSafetyRecord.next_due_date))
    return [FoodSafetyOut.model_validate(r) for r in rows]


crud_routers = [
    crud_router(QCTemplate, prefix="/qc/templates", feature="quality", create=TemplateIn, update=TemplatePatch,
                out=TemplateOut, search=(QCTemplate.name,), filters={"stage": QCTemplate.stage},
                default_sort=QCTemplate.name, tags=["quality"]),
    crud_router(FoodSafetyRecord, prefix="/food-safety", feature="quality", create=FoodSafetyIn,
                update=FoodSafetyPatch, out=FoodSafetyOut, search=(FoodSafetyRecord.title, FoodSafetyRecord.notes),
                sorts={"record_date": FoodSafetyRecord.record_date}, filters={"kind": FoodSafetyRecord.kind,
                                                                              "result": FoodSafetyRecord.result},
                default_sort=FoodSafetyRecord.record_date.desc(), tags=["quality"]),
]
routers = [qc, trace, recalls, fs_extra, *crud_routers]
