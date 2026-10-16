"""Admin commands. Run from backend/:  ..\\.venv\\Scripts\\python -m app.cli <command>"""

from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select

from .db import run_migrations, session_factory
from .deps import app_state
from .models import AuthSession, User
from .security import hash_password
from .services import purge_expired


def _password(args) -> str:
    if args.password_stdin:
        pw = sys.stdin.readline().rstrip("\n")
    else:
        pw = getpass.getpass("Password (10+ characters): ")
        if getpass.getpass("Repeat: ") != pw:
            sys.exit("Passwords don't match.")
    if len(pw) < 10:
        sys.exit("Password must be at least 10 characters.")
    return pw


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="relay")
    sub = parser.add_subparsers(dest="cmd", required=True)
    cu = sub.add_parser("create-user", help="create a dashboard account")
    cu.add_argument("username")
    cu.add_argument("--display-name", default="")
    cu.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    rp = sub.add_parser("reset-password", help="set a new password and sign out all sessions")
    rp.add_argument("username")
    rp.add_argument("--password-stdin", action="store_true")
    sub.add_parser("list-users")
    sub.add_parser("purge", help="apply the retention policy now")
    sub.add_parser("migrate", help="apply database migrations")
    args = parser.parse_args(argv)

    run_migrations()
    db = session_factory()()
    try:
        if args.cmd == "create-user":
            from .routers.auth import create_user

            if db.scalar(select(User).where(User.username == args.username)):
                sys.exit(f"User {args.username!r} already exists.")
            user = create_user(db, args.username, _password(args), args.display_name)
            db.commit()
            print(f"Created {user.username} (id {user.id}) with the default channels.")
        elif args.cmd == "reset-password":
            user = db.scalar(select(User).where(User.username == args.username))
            if user is None:
                sys.exit(f"No user {args.username!r}.")
            user.password_hash = hash_password(_password(args))
            for s in db.scalars(select(AuthSession).where(AuthSession.user_id == user.id)):
                db.delete(s)
            db.commit()
            print("Password updated; all sessions signed out.")
        elif args.cmd == "list-users":
            for u in db.scalars(select(User).order_by(User.id)):
                print(f"{u.id}\t{u.username}\t{u.display_name}\tlast login {u.last_login_at or 'never'}")
        elif args.cmd == "purge":
            print(purge_expired(db, app_state().storage))
        elif args.cmd == "migrate":
            print("Migrations applied.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
