from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.clock import local_today
from app.numbering import NumberSequence, next_number


def test_format_and_sequence(db):
    year = local_today().year
    assert next_number(db, "invoice") == f"INV-{year}-00001"
    assert next_number(db, "invoice") == f"INV-{year}-00002"
    assert next_number(db, "order") == f"SO-{year}-00001"  # independent per type


def test_rollback_returns_number(db):
    sp = db.begin_nested()
    next_number(db, "quotation")
    sp.rollback()
    assert next_number(db, "quotation").endswith("-00001")


def test_concurrent_numbers_are_unique_and_gap_free(engine):
    """Real commits from 50 parallel sessions (not inside the per-test transaction)."""

    def take(_):
        with Session(engine) as s, s.begin():
            return next_number(s, "receipt")

    try:
        with ThreadPoolExecutor(10) as pool:
            numbers = list(pool.map(take, range(50)))
        assert sorted(int(n.rsplit("-", 1)[1]) for n in numbers) == list(range(1, 51))
    finally:
        with Session(engine) as s, s.begin():
            s.execute(delete(NumberSequence).where(NumberSequence.doc_type == "receipt"))
