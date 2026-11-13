from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import errors, models  # noqa: F401
from app.audit_router import router as audit_router
from app.auth.mfa_router import router as mfa_router
from app.auth.router import router as auth_router
from app.auth.users_router import router as users_router
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

for r in (auth_router, mfa_router, users_router, audit_router):
    app.include_router(r)


@app.get("/health")
def health():
    return {"status": "ok"}
