"""Server management commands, run inside the container: `cryptex owner reset [EMAIL]`.

For owners locked out of a password account (lost password or 2FA device). Prints a new
one-time password, turns 2FA off for that owner and signs them out everywhere.
"""
from __future__ import annotations

import argparse
import secrets
import sys

from . import db, security, state
from .config import load_env
from .events import emit


def owner_reset(email: str | None) -> int:
    owners = db.all("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at")
    if not owners:
        print("There are no owners yet. Open the server in a browser to run setup.", file=sys.stderr)
        return 1
    if email is None:
        if len(owners) > 1:
            print("Several owners exist. Name one: cryptex owner reset EMAIL\n  " + "\n  ".join(o["email"] for o in owners), file=sys.stderr)
            return 1
        user = owners[0]
    else:
        user = next((o for o in owners if o["email"].lower() == email.lower()), None)
        if user is None:
            print(f"No owner with the email {email}.", file=sys.stderr)
            return 1
    password = "-".join(secrets.token_urlsafe(6) for _ in range(3))
    with db.tx() as c:
        c.execute("UPDATE users SET password_hash = ?, totp_ct = NULL, totp_last_step = NULL WHERE id = ?",
                  (security.hash_password(password), user["id"]))
        c.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
        emit("setting.changed", actor="system", detail={"key": "owner_reset", "from": None, "to": user["email"]}, c=c)
    print(f"Password for {user['email']} reset. Sign in with this one-time password, then change it:\n\n  {password}\n")
    print("Two-step verification was turned off for this owner, and their sessions were signed out.")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="cryptex", description="Cryptex server management")
    sub = p.add_subparsers(dest="cmd", required=True)
    owner = sub.add_parser("owner", help="owner accounts")
    osub = owner.add_subparsers(dest="action", required=True)
    reset = osub.add_parser("reset", help="reset an owner's password and 2FA")
    reset.add_argument("email", nargs="?")
    a = p.parse_args(argv)
    env = load_env()
    state.init(env)
    db.configure(env.data_dir / "cryptex.db")
    if a.cmd == "owner" and a.action == "reset":
        return owner_reset(a.email)
    return 2


if __name__ == "__main__":
    sys.exit(main())
