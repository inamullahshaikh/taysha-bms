"""Price/cost resolution and tax maths. Prices are tax-inclusive: tax is extracted, never added."""

from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.company import TaxRate, default_tax_rate
from app.products.models import Product, ProductCost, ProductPrice

CENT = Decimal("0.01")


def money(v: Decimal) -> Decimal:
    return Decimal(v).quantize(CENT, rounding=ROUND_HALF_UP)


def split_tax(gross: Decimal, rate: Decimal) -> tuple[Decimal, Decimal]:
    """Tax-inclusive amount -> (net, tax). 1180 at 18% -> (1000.00, 180.00)."""
    tax = money(gross * rate / (100 + rate))
    return money(gross) - tax, tax


def tax_rate_of(db: Session, product: Product) -> Decimal:
    if product.tax_rate_id:
        return db.get(TaxRate, product.tax_rate_id).rate
    d = default_tax_rate(db)
    return d.rate if d else Decimal(0)


def resolve_price(db: Session, product_id: int, price_list_id: int, on: date) -> ProductPrice | None:
    return db.scalar(
        select(ProductPrice)
        .where(ProductPrice.product_id == product_id, ProductPrice.price_list_id == price_list_id,
               ProductPrice.effective_from <= on)
        .order_by(ProductPrice.effective_from.desc(), ProductPrice.id.desc())
        .limit(1)
    )


def current_cost(db: Session, product_id: int, on: date) -> ProductCost | None:
    return db.scalar(
        select(ProductCost)
        .where(ProductCost.product_id == product_id, ProductCost.effective_from <= on)
        .order_by(ProductCost.effective_from.desc(), ProductCost.id.desc())
        .limit(1)
    )


def margin(price_gross: Decimal, tax_rate: Decimal, cost: Decimal | None) -> dict:
    net, tax = split_tax(price_gross, tax_rate)
    if cost is None:
        return {"price": money(price_gross), "tax": tax, "net_price": net, "cost": None, "margin": None,
                "margin_pct": None}
    m = net - money(cost)
    return {"price": money(price_gross), "tax": tax, "net_price": net, "cost": money(cost), "margin": m,
            "margin_pct": (m / net * 100).quantize(CENT) if net else None}


def valid_gtin(code: str) -> bool:
    """Check digit for EAN-8, UPC-12, EAN-13, GTIN-14."""
    digits = [int(c) for c in code]
    body, check = digits[:-1], digits[-1]
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check

