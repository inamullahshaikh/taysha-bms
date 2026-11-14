from decimal import Decimal

from fastapi import FastAPI, encoders
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware

from app import (  # noqa: F401
    approvals,
    assets,
    attachments,
    audit_router,
    automation,
    backup,
    barcodes,
    company,
    crm,
    customers,
    errors,
    expenses,
    forecast,
    insights,
    jobs,
    lookups,
    marketing,
    models,
    notifications,
    partners,
    pos,
    receivables,
    records,
    reports,
    returns,
    rnd,
    suppliers,
    tasks,
    wholesale,
)
from app.accounting import router as accounting
from app.auth import mfa_router, users_router
from app.auth import router as auth_router
from app.config import settings
from app.documents import router as documents
from app.integrations import shopify
from app.inventory import router as inventory
from app.orders import router as orders
from app.production import quality
from app.production import router as production
from app.products import router as products
from app.purchasing import router as purchasing

# Money must never become a float in JSON: plain-dict responses get Decimal -> "1200.00" like pydantic models do
encoders.ENCODERS_BY_TYPE[Decimal] = str

app = FastAPI(
    title="Taysha BMS",
    docs_url="/docs" if settings.docs_enabled else None,
    redoc_url=None,
    openapi_url="/openapi.json" if settings.docs_enabled else None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# JSON shrinks 5-20x (less egress, faster on phones). Level 6 is nearly as small as 9 for a fraction of the CPU.
# PDFs and Excel files are already compressed inside, so they're sent as they are.
app.add_middleware(GZipMiddleware, minimum_size=1000, compresslevel=6, exclude_content_types=(
    *DEFAULT_EXCLUDED_CONTENT_TYPES, "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
errors.install(app)

MODULES = (
    auth_router, mfa_router, users_router, audit_router, attachments, company, lookups, products, customers,
    suppliers, orders, documents, jobs, expenses, reports, backup, inventory, purchasing, barcodes, notifications,
    returns, receivables, production, quality, shopify, pos, wholesale, marketing, crm, accounting, partners, tasks, approvals, records, assets, insights, forecast, rnd, automation,
)
for module in MODULES:
    for r in module.routers:
        app.include_router(r)


@app.get("/health")
def health():
    return {"status": "ok"}
