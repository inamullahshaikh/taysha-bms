"""Background jobs. Run by the `scheduler` container: python -m app.jobs --loop

Each job is idempotent and records its last run, so running it twice or late is harmless. A row lock means
two scheduler processes never run the same job at once.
"""

import argparse
import time
import traceback
from collections.abc import Callable
from datetime import datetime, timedelta

from fastapi import APIRouter
from sqlalchemy import DateTime, String, Text, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from app import models  # noqa: F401
from app.auth.access import require_access
from app.auth.models import User
from app.clock import utcnow
from app.db import DB, Base, SessionLocal


class JobRun(Base):
    __tablename__ = "job_runs"
    name: Mapped[str] = mapped_column(String(60), primary_key=True)
    last_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[str | None] = mapped_column(String(10))  # ok | error
    last_message: Mapped[str | None] = mapped_column(Text)


def _overdue_invoices(db: Session) -> str:
    from app.documents.service import mark_overdue

    return f"{mark_overdue(db)} invoices checked"


def _overdue_bills(db: Session) -> str:
    from app.purchasing.router import mark_overdue_bills

    return f"{mark_overdue_bills(db)} supplier bills checked"


def _alerts(db: Session) -> str:
    from app.notifications import check_alerts

    return check_alerts(db)


def _shopify(fn_name: str):
    def run(db: Session) -> str:
        from app.integrations import shopify

        return getattr(shopify, fn_name)(db)

    return run


def _recurring(db: Session) -> str:
    from app.wholesale import run_due_recurring

    return run_due_recurring(db)


def _loyalty(db: Session) -> str:
    from app.crm import award_points

    return award_points(db)


def _post_ledger(db: Session) -> str:
    from app.accounting.posting import post_pending

    return str(post_pending(db))


def _depreciation(db: Session) -> str:
    from app.assets import depreciate

    return depreciate(db)


def _scheduled_reports(db: Session) -> str:
    from app.insights import run_scheduled

    return run_scheduled(db)


def _automation(db: Session) -> str:
    from app.automation import run_all

    return run_all(db)


def _backup(db: Session) -> str:
    from app.backup import run_backup

    return run_backup()


def _restore_check(db: Session) -> str:
    from app.backup import restore_check

    return restore_check()


# name -> (interval, function(db) -> message). Modules add their jobs here.
JOBS: dict[str, tuple[timedelta, Callable[[Session], str]]] = {
    "overdue_invoices": (timedelta(hours=1), _overdue_invoices),
    "overdue_supplier_bills": (timedelta(hours=1), _overdue_bills),
    "alerts": (timedelta(minutes=30), _alerts),
    "recurring_orders": (timedelta(hours=1), _recurring),
    "loyalty_points": (timedelta(hours=6), _loyalty),
    "ledger_posting": (timedelta(minutes=5), _post_ledger),
    "depreciation": (timedelta(days=1), _depreciation),
    "scheduled_reports": (timedelta(hours=1), _scheduled_reports),
    "automation": (timedelta(minutes=10), _automation),
    "shopify_orders": (timedelta(minutes=15), _shopify("poll_orders")),
    "shopify_stock": (timedelta(minutes=10), _shopify("push_stock")),
    "shopify_fulfilments": (timedelta(minutes=10), _shopify("push_fulfilments")),
    "backup": (timedelta(days=1), _backup),
    "restore_check": (timedelta(days=7), _restore_check),
}


def run_job(name: str, force: bool = False) -> str | None:
    interval, fn = JOBS[name]
    with SessionLocal() as db:
        db.execute(insert(JobRun).values(name=name).on_conflict_do_nothing())
        db.commit()
        row = db.scalar(select(JobRun).where(JobRun.name == name).with_for_update(skip_locked=True))
        if row is None:  # another scheduler is running it right now
            return None
        if not force and row.last_finished_at and utcnow() - row.last_finished_at < interval:
            db.rollback()
            return None
        row.last_started_at = utcnow()
        db.info["source"] = "system"
        try:
            with db.begin_nested():
                msg = fn(db)
            row.last_status, row.last_message = "ok", msg
        except Exception:
            row.last_status, row.last_message = "error", traceback.format_exc()[-2000:]
            msg = None
        row.last_finished_at = utcnow()
        db.commit()
        return msg


def schema_ready() -> bool:
    """Jobs wait until the API has applied all migrations (they start at the same time on deploy)."""
    from alembic.config import Config
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    head = ScriptDirectory.from_config(Config("alembic.ini")).get_current_head()
    with SessionLocal() as db:
        return MigrationContext.configure(db.connection()).get_current_revision() == head


def run_due() -> None:
    if not schema_ready():
        return
    for name in JOBS:
        run_job(name)


router = APIRouter(prefix="/settings/jobs", tags=["settings"])


@router.get("")
def job_status(db: DB, _: User = require_access("settings", "view")):
    runs = {r.name: r for r in db.scalars(select(JobRun))}
    return [{"name": n, "interval_minutes": int(i.total_seconds() // 60),
             **({k: getattr(runs[n], k) for k in ("last_started_at", "last_finished_at", "last_status",
                                                   "last_message")} if n in runs else {})}
            for n, (i, _) in JOBS.items()]


routers = [router]


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--loop", action="store_true", help="keep running, checking every minute")
    p.add_argument("--run", help="run one job now")
    a = p.parse_args()
    if a.run:
        print(run_job(a.run, force=True))
    elif a.loop:
        while True:
            run_due()
            time.sleep(60)
    else:
        run_due()
