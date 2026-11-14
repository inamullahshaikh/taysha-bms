"""Server-side PDFs: Jinja2 HTML templates rendered by WeasyPrint, branded from company settings."""

import base64
from datetime import date, datetime
from decimal import Decimal
from functools import cache
from pathlib import Path

from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.attachments import read_file
from app.clock import TZ
from app.company import get_company


def _money(v) -> str:
    return "" if v is None else f"{Decimal(v):,.2f}"


def _qty(v) -> str:
    return "" if v is None else f"{Decimal(v).normalize():f}"


def _date(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        v = v.astimezone(TZ)
    return v.strftime("%d %b %Y")


def _address(a: dict | None) -> str:
    if not a:
        return ""
    parts = [a.get("line1"), a.get("line2"), a.get("area"), a.get("city"), a.get("postal_code")]
    return ", ".join(p for p in parts if p)


def _label(v) -> str:
    """cod_pending -> COD pending"""
    return "" if not v else v.replace("_", " ").capitalize().replace("Cod", "COD")


@cache
def env():
    """Template environment, built on first print (Jinja2 isn't needed by most requests)."""
    from jinja2 import Environment, FileSystemLoader, select_autoescape

    e = Environment(loader=FileSystemLoader(Path(__file__).parent / "templates"), autoescape=select_autoescape())
    e.filters.update(money=_money, qty=_qty, date=_date, address=_address, label=_label)
    return e


def render_pdf(db: Session, template: str, **ctx) -> bytes:
    from weasyprint import HTML  # heavy import, only when printing

    company = get_company(db)
    logo = None
    if company.logo_key:
        logo = f"data:{company.logo_content_type};base64,{base64.b64encode(read_file(company.logo_key)).decode()}"
    html = env().get_template(template).render(company=company, logo=logo, brand=company.brand_color or "#5b3a29",
                                             today=date.today(), **ctx)
    return HTML(string=html).write_pdf()


def pdf_response(data: bytes, filename: str, download: bool = False) -> Response:
    disp = "attachment" if download else "inline"
    return Response(data, media_type="application/pdf", headers={"Content-Disposition": f'{disp}; filename="{filename}"'})
