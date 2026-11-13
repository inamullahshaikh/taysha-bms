"""Order/invoice totals. Pure functions, no DB.

Prices are tax-inclusive. Discounts reduce the gross amount; tax is then extracted from what is left.
An order-level discount is spread over lines in proportion to their value so each line's tax stays right
when lines have different tax rates. Delivery is untaxed. The grand total is rounded to whole rupees.
"""

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from app.products.pricing import money, split_tax

ZERO = Decimal(0)


@dataclass
class LineCalc:
    quantity: Decimal
    unit_price: Decimal  # tax-inclusive
    tax_rate: Decimal  # percent
    discount_pct: Decimal = ZERO
    discount_amount: Decimal = ZERO
    # results
    gross: Decimal = ZERO  # qty * price
    line_discount: Decimal = ZERO
    order_discount_share: Decimal = ZERO
    total: Decimal = ZERO  # what the customer pays for this line (incl. tax)
    tax: Decimal = ZERO
    net: Decimal = ZERO


@dataclass
class Totals:
    lines: list[LineCalc]
    subtotal: Decimal = ZERO  # after line discounts, before order discount
    order_discount: Decimal = ZERO
    discount_total: Decimal = ZERO  # line + order discounts
    tax_total: Decimal = ZERO
    net_total: Decimal = ZERO
    delivery_charge: Decimal = ZERO
    rounding: Decimal = ZERO
    grand_total: Decimal = ZERO
    warnings: list[str] = field(default_factory=list)


def calculate(lines: list[LineCalc], order_discount_pct: Decimal = ZERO, order_discount_amount: Decimal = ZERO,
              delivery_charge: Decimal = ZERO, round_to_rupee: bool = True) -> Totals:
    t = Totals(lines=lines, delivery_charge=money(delivery_charge))
    for ln in lines:
        ln.gross = money(ln.quantity * ln.unit_price)
        ln.line_discount = min(ln.gross, money(ln.gross * ln.discount_pct / 100) + money(ln.discount_amount))
        ln.total = ln.gross - ln.line_discount
    t.subtotal = sum((ln.total for ln in lines), ZERO)

    t.order_discount = min(t.subtotal, money(t.subtotal * order_discount_pct / 100) + money(order_discount_amount))
    remaining = t.order_discount
    for i, ln in enumerate(lines):  # proportional allocation, last line takes the rounding remainder
        share = remaining if i == len(lines) - 1 else (
            money(t.order_discount * ln.total / t.subtotal) if t.subtotal else ZERO)
        share = min(share, ln.total)
        ln.order_discount_share = share
        remaining -= share
        ln.total -= share
        ln.net, ln.tax = split_tax(ln.total, ln.tax_rate)

    t.discount_total = sum((ln.line_discount for ln in lines), ZERO) + t.order_discount
    t.tax_total = sum((ln.tax for ln in lines), ZERO)
    goods = t.subtotal - t.order_discount
    t.net_total = goods - t.tax_total
    before_rounding = goods + t.delivery_charge
    t.grand_total = before_rounding.quantize(Decimal(1), rounding=ROUND_HALF_UP) if round_to_rupee \
        else before_rounding
    t.grand_total = money(t.grand_total)
    t.rounding = t.grand_total - before_rounding
    return t
