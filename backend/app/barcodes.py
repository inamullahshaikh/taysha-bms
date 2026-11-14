"""Barcode lookup (scanning), barcode/QR images and label PDFs.

Internal codes: batches print as  B<id>  and locations as  L<id>  (Code 128) unless the location has its own
barcode. Products use their EAN/UPC barcode, or the SKU if they have none.
"""

import base64
import io
from typing import Literal

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.auth.access import require_access
from app.auth.deps import CurrentUser
from app.auth.models import User
from app.clock import local_today
from app.crud import get_or_404
from app.db import DB
from app.errors import AppError, not_found
from app.inventory.models import Batch, Location, Warehouse
from app.pdf import pdf_response, render_pdf
from app.products.models import PriceList, Product, ProductUnit
from app.products.pricing import resolve_price

router = APIRouter(tags=["barcodes"])


def svg(value: str, symbology: str = "code128") -> str:
    """SVG markup for a barcode or QR code."""
    import barcode  # imported on use (pulls in Pillow); most requests never draw one
    import segno
    from barcode.writer import SVGWriter

    if symbology == "qr":
        buf = io.BytesIO()
        segno.make(value, error="m").save(buf, kind="svg", scale=4, border=1)
        return buf.getvalue().decode()
    if symbology == "ean13" and not (value.isdigit() and len(value) == 13):
        symbology = "code128"
    try:
        code = barcode.get(symbology, value, writer=SVGWriter())
    except Exception:
        raise AppError(422, "invalid_barcode_value", f"Can't encode {value!r} as {symbology}")
    buf = io.BytesIO()
    code.write(buf, options={"module_height": 8, "font_size": 6, "text_distance": 3, "quiet_zone": 2})
    return buf.getvalue().decode()


def data_uri(markup: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(markup.encode()).decode()


@router.get("/barcodes/lookup")
def lookup(code: str, db: DB, _: CurrentUser):
    """What did the scanner just read? Returns the record type and ids."""
    code = code.strip()
    p = db.scalar(select(Product).where(Product.barcode == code)) or db.scalar(select(Product).where(Product.sku == code))
    if p:
        return {"type": "product", "product_id": p.id, "name": p.name, "sku": p.sku}
    pack = db.scalar(select(ProductUnit).where(ProductUnit.barcode == code))
    if pack:
        p = db.get(Product, pack.product_id)
        return {"type": "pack", "product_id": p.id, "name": p.name, "sku": p.sku, "pack": pack.name,
                "factor": pack.factor}
    if code[:1] in ("B", "L") and code[1:].isdigit():
        if code[0] == "B" and (b := db.get(Batch, int(code[1:]))):
            p = db.get(Product, b.product_id)
            return {"type": "batch", "batch_id": b.id, "batch": b.number, "product_id": p.id, "name": p.name,
                    "expiry_date": b.expiry_date, "status": b.status}
        if code[0] == "L" and (loc := db.get(Location, int(code[1:]))):
            return {"type": "location", "location_id": loc.id, "warehouse_id": loc.warehouse_id, "code": loc.code}
    loc = db.scalar(select(Location).where(Location.barcode == code))
    if loc:
        return {"type": "location", "location_id": loc.id, "warehouse_id": loc.warehouse_id, "code": loc.code}
    raise not_found("Nothing with that barcode")


@router.get("/barcodes/image")
def image(value: str, _: CurrentUser, symbology: Literal["code128", "ean13", "qr"] = "code128"):
    # QR values can carry secrets (the 2FA otpauth URI), so they are never cached
    cache = "no-store" if symbology == "qr" else "private, max-age=86400"
    return Response(svg(value, symbology), media_type="image/svg+xml", headers={"Cache-Control": cache})


class LabelItem(BaseModel):
    id: int
    copies: int = Field(1, ge=1, le=500)


class LabelsIn(BaseModel):
    kind: Literal["product", "batch", "location"]
    items: list[LabelItem] = Field(min_length=1)
    layout: Literal["a4_3x8", "thermal_50x25"] = "a4_3x8"
    show_price: bool = False


@router.post("/labels")
def labels(body: LabelsIn, db: DB, user: User = require_access("products", "view")):
    """Printable label sheet: A4 with 24 labels (3 x 8), or one 50 x 25 mm label per page for thermal printers."""
    out = []
    retail = db.scalar(select(PriceList).where(PriceList.code == "retail")) if body.show_price else None
    for it in body.items:
        if body.kind == "product":
            p = get_or_404(db, Product, it.id, "Product")
            value = p.barcode or p.sku
            sym = "ean13" if p.barcode and p.barcode.isdigit() and len(p.barcode) == 13 else "code128"
            price = None
            if retail:
                pp = resolve_price(db, p.id, retail.id, local_today())
                price = pp.price if pp else None
            label = {"title": p.name, "lines": [p.sku] + ([f"Rs {price:,.0f}"] if price is not None else []),
                     "code": data_uri(svg(value, sym))}
        elif body.kind == "batch":
            b = get_or_404(db, Batch, it.id, "Batch")
            p = db.get(Product, b.product_id)
            lines = [f"Batch {b.number}"]
            if b.mfg_date:
                lines.append(f"MFG {b.mfg_date:%d %b %Y}")
            if b.expiry_date:
                lines.append(f"EXP {b.expiry_date:%d %b %Y}")
            label = {"title": p.name, "lines": lines, "code": data_uri(svg(f"B{b.id}"))}
        else:
            loc = get_or_404(db, Location, it.id, "Location")
            wh = db.get(Warehouse, loc.warehouse_id)
            label = {"title": loc.code, "lines": [wh.name] + ([loc.name] if loc.name else []),
                     "code": data_uri(svg(loc.barcode or f"L{loc.id}"))}
        out += [label] * it.copies
    data = render_pdf(db, "labels.html", labels=out, layout=body.layout)
    return pdf_response(data, f"labels-{body.kind}.pdf")


routers = [router]
