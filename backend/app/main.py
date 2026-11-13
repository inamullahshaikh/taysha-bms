from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import attachments, audit_router, company, errors, models  # noqa: F401
from app.auth import mfa_router, router as auth_router, users_router
from app.config import settings

app = FastAPI(title="Taysha BMS")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
errors.install(app)

for module in (auth_router, mfa_router, users_router, audit_router, attachments, company):
    app.include_router(module.router)
    for r in getattr(module, "crud_routers", ()):
        app.include_router(r)


@app.get("/health")
def health():
    return {"status": "ok"}
