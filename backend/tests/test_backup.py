from app.backup import restore_check, run_backup
from tests.conftest import TEST_URL


def test_backup_and_restore_check(engine, tmp_path):
    msg = run_backup(TEST_URL, str(tmp_path))
    assert msg.startswith("taysha-") and list(tmp_path.glob("*.dump"))
    assert "restored OK" in restore_check(TEST_URL, str(tmp_path))
