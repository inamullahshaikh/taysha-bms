from decimal import Decimal

from fastapi import FastAPI, encoders
from fastapi.middleware.cors import CORSMiddleware

from app import attachments, audit_router, company, customers, errors, lookups, models, suppliers  # noqa: F401
from app.auth import mfa_router, router as auth_router, users_router
from app.config import settings
from app.products import router as products

# Money must never become a float in JSON: plain-dict responses get Decimal -> "1200.00" like pydantic models do
encoders.ENCODERS_BY_TYPE[Decimal] = str

app = FastAPI(title="Taysha BMS")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
errors.install(app)

MODULES = (auth_router, mfa_router, users_router, audit_router, attachments, company, lookups, products, customers,
           suppliers)
for module in MODULES:
    for r in module.routers:
        app.include_router(r)


@app.get("/health")
def health():
    return {"status": "ok"}
