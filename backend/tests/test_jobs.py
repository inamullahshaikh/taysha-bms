from sqlalchemy import delete
from sqlalchemy.orm import Session

from app import jobs


def test_job_runs_once_per_interval(engine, monkeypatch):
    calls = []
    monkeypatch.setitem(jobs.JOBS, "test_job", (jobs.timedelta(hours=1), lambda db: calls.append(1) or "done"))
    monkeypatch.setattr(jobs, "SessionLocal", lambda: Session(engine))
    try:
        assert jobs.run_job("test_job") == "done"
        assert jobs.run_job("test_job") is None  # not due yet
        assert jobs.run_job("test_job", force=True) == "done"
        assert len(calls) == 2
    finally:
        with Session(engine) as s, s.begin():
            s.execute(delete(jobs.JobRun).where(jobs.JobRun.name == "test_job"))


def test_failing_job_is_recorded(engine, monkeypatch):
    def boom(db):
        raise RuntimeError("nope")

    monkeypatch.setitem(jobs.JOBS, "bad_job", (jobs.timedelta(hours=1), boom))
    monkeypatch.setattr(jobs, "SessionLocal", lambda: Session(engine))
    try:
        assert jobs.run_job("bad_job") is None
        with Session(engine) as s:
            row = s.get(jobs.JobRun, "bad_job")
            assert row.last_status == "error" and "nope" in row.last_message
    finally:
        with Session(engine) as s, s.begin():
            s.execute(delete(jobs.JobRun).where(jobs.JobRun.name == "bad_job"))
