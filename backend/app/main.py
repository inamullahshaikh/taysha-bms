from decimal import Decimal

from fastapi import FastAPI, encoders
from fastapi.middleware.cors import CORSMiddleware

from app import (  # noqa: F401
    attachments, audit_router, backup, barcodes, company, customers, errors, expenses, jobs, lookups, models, notifications, receivables, reports, returns, suppliers,
)
from app.auth import mfa_router, router as auth_router, users_router
from app.config import settings
from app.documents import router as documents
from app.inventory import router as inventory
from app.orders import router as orders
from app.production import quality, router as production
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
errors.install(app)

MODULES = (auth_router, mfa_router, users_router, audit_router, attachments, company, lookups, products, customers,
           suppliers, orders, documents, jobs, expenses, reports, backup, inventory, purchasing, barcodes,
           notifications, returns, receivables, production, quality)
for module in MODULES:
    for r in module.routers:
        app.include_router(r)


@app.get("/health")
def health():
    return {"status": "ok"}
