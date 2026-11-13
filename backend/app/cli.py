"""Admin commands: python -m app.cli create-owner --name "..." --email ..."""

import argparse
import getpass

from sqlalchemy import select

from app import models  # noqa: F401
from app.audit import audit
from app.auth.models import User
from app.auth.security import hash_password
from app.db import SessionLocal


def create_owner(name: str, email: str) -> None:
    password = getpass.getpass("Password: ")
    if password != getpass.getpass("Repeat password: "):
        raise SystemExit("Passwords do not match")
    with SessionLocal.begin() as db:
        if db.scalar(select(User).where(User.email == email.lower())):
            raise SystemExit("A user with that email already exists")
        user = User(name=name, email=email.lower(), password_hash=hash_password(password), is_owner=True)
        db.add(user)
        db.info["source"] = "system"
        audit(db, "create", user)
    print(f"Owner {email} created")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-owner")
    c.add_argument("--name", required=True)
    c.add_argument("--email", required=True)
    args = p.parse_args()
    if args.cmd == "create-owner":
        create_owner(args.name, args.email)


if __name__ == "__main__":
    main()
