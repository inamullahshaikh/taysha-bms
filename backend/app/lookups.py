"""Small reference lists any logged-in user may read (dropdowns in forms)."""

from fastapi import APIRouter
from sqlalchemy import select

from app.auth.deps import CurrentUser
from app.company import Branch, Department, TaxRate, Unit
from app.db import DB
from app.expenses import CostCentre, ExpenseCategory
from app.products.models import PriceList, ProductCategory, SalesChannel

router = APIRouter(tags=["lookups"])


def _rows(db, model, *cols):
    q = select(model).where(model.archived_at.is_(None)).order_by(model.id)
    return [{c: getattr(r, c) for c in ("id", *cols)} for r in db.scalars(q)]


@router.get("/lookups")
def lookups(_: CurrentUser, db: DB):
    return {
        "sales_channels": _rows(db, SalesChannel, "code", "name"),
        "price_lists": _rows(db, PriceList, "code", "name", "customer_id"),
        "units": _rows(db, Unit, "code", "name", "dimension"),
        "tax_rates": _rows(db, TaxRate, "name", "rate", "is_default"),
        "branches": _rows(db, Branch, "code", "name"),
        "departments": _rows(db, Department, "name"),
        "product_categories": _rows(db, ProductCategory, "name", "parent_id"),
        "expense_categories": _rows(db, ExpenseCategory, "name", "parent_id"),
        "cost_centres": _rows(db, CostCentre, "code", "name"),
    }

routers = [router]
