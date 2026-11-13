"""Database + uploads backups, and an automatic restore test.

Jobs (see app.jobs): `backup` daily, `restore_check` weekly. The restore check loads the newest dump into a
scratch database and checks it, so we know backups actually restore. Copy BACKUP_DIR off the server
(e.g. rclone to cloud storage) for disaster recovery; see README.
"""

import subprocess
import sys
import tarfile
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.auth.access import require_access
from app.auth.models import User
from app.config import settings

RESTORE_DB = "taysha_restore_check"


def libpq(url: str) -> str:
    return make_url(url).set(drivername="postgresql").render_as_string(hide_password=False)


def run_backup(url: str | None = None, backup_dir: str | None = None) -> str:
    out = Path(backup_dir or settings.backup_dir)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dump = out / f"taysha-{stamp}.dump"
    subprocess.run(["pg_dump", "--format=custom", "--no-owner", f"--file={dump}", libpq(url or settings.database_url)],
                   check=True, capture_output=True, text=True)
    uploads = Path(settings.upload_dir)
    if uploads.exists():
        with tarfile.open(out / f"uploads-{stamp}.tar.gz", "w:gz") as tar:
            tar.add(uploads, arcname="uploads")
    cutoff = datetime.now() - timedelta(days=settings.backup_retention_days)
    for f in out.glob("*-*.*"):
        if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
            f.unlink()
    return f"{dump.name} ({dump.stat().st_size // 1024} KB)"


def latest_dump(backup_dir: str | None = None) -> Path | None:
    dumps = sorted(Path(backup_dir or settings.backup_dir).glob("taysha-*.dump"))
    return dumps[-1] if dumps else None


def restore_check(url: str | None = None, backup_dir: str | None = None) -> str:
    """Restore the newest dump into a scratch database and sanity-check it."""
    dump = latest_dump(backup_dir)
    if dump is None:
        raise RuntimeError("No backup found to test")
    base = make_url(url or settings.database_url)
    admin = create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{RESTORE_DB}" WITH (FORCE)'))
            c.execute(text(f'CREATE DATABASE "{RESTORE_DB}"'))
        target = base.set(database=RESTORE_DB)
        restored = libpq(target.render_as_string(hide_password=False))
        subprocess.run(["pg_restore", "--no-owner", "--exit-on-error", f"--dbname={restored}", str(dump)],
                       check=True, capture_output=True, text=True)
        eng = create_engine(target)
        with eng.connect() as c:
            version = c.execute(text("select version_num from alembic_version")).scalar()
            users = c.execute(text("select count(*) from users")).scalar()
            tables = c.execute(text("select count(*) from information_schema.tables where table_schema='public'")
                               ).scalar()
        eng.dispose()
        if not version or tables < 10:
            raise RuntimeError(f"Restored database looks wrong: version={version}, tables={tables}")
        return f"{dump.name} restored OK: schema {version}, {tables} tables, {users} users"
    finally:
        with admin.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{RESTORE_DB}" WITH (FORCE)'))
        admin.dispose()


router = APIRouter(prefix="/settings/backups", tags=["settings"])


@router.get("")
def list_backups(_: User = require_access("settings", "view")):
    files = sorted(Path(settings.backup_dir).glob("*-*.*"), reverse=True) if Path(settings.backup_dir).exists() else []
    return [{"file": f.name, "size_kb": f.stat().st_size // 1024,
             "created_at": datetime.fromtimestamp(f.stat().st_mtime)} for f in files]


routers = [router]

def restore(dump: str) -> None:
    """Replace the live database with a dump. Stop the api and scheduler first."""
    base = make_url(settings.database_url)
    admin = create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as c:
        c.execute(text(f'DROP DATABASE IF EXISTS "{base.database}" WITH (FORCE)'))
        c.execute(text(f'CREATE DATABASE "{base.database}"'))
    admin.dispose()
    subprocess.run(["pg_restore", "--no-owner", "--exit-on-error", f"--dbname={libpq(settings.database_url)}", dump],
                   check=True)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "backup"
    if cmd == "backup":
        print(run_backup())
    elif cmd == "restore-check":
        print(restore_check())
    elif cmd == "restore" and len(sys.argv) == 4 and sys.argv[3] == "--yes":
        restore(sys.argv[2])
        print("Restored", sys.argv[2])
    else:
        sys.exit("usage: python -m app.backup [backup | restore-check | restore <file.dump> --yes]")
