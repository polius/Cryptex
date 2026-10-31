"""Server management commands, run inside the container: `cryptex setup-code`, `cryptex temp-password [USERNAME]`,
`cryptex owner reset [USERNAME]`, `cryptex backup DEST`.

setup-code prints the code that claims a fresh install (the setup screen asks for it).
temp-password prints the temporary password someone asked for with "Forgot your password?" on the sign-in page.
owner reset is for owners locked out when a temporary password won't do: it signs that owner out everywhere and
prints a one-time invite link to set a new password and authenticator. Members ask an owner instead. On a server
left with no owner, it makes the person named an owner (or, with no accounts at all, reopens setup).
backup copies the database while the server runs (SQLite's online backup), with the chunks folder alongside.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import sys
from pathlib import Path

from . import account, db, security, state
from .account import clear_vault, forget_sign_ins
from .config import load_env
from .events import emit
from .routes.auth import issue_invite


def owner_reset(username: str | None) -> int:
    owners = db.all("SELECT * FROM users WHERE role = 'owner' ORDER BY created_at")
    if not owners:
        return _no_owner(username)
    user: sqlite3.Row | None
    if username is None:
        if len(owners) > 1:
            print("Several owners exist. Name one: cryptex owner reset USERNAME\n  " + "\n  ".join(o["username"] for o in owners), file=sys.stderr)
            return 1
        user = owners[0]
    else:
        user = next((o for o in owners if o["username"].lower() == username.strip().lower()), None)
        if user is None:
            print(f"No owner with the username {username}.", file=sys.stderr)
            return 1
    _reset(user["id"], user["username"])
    return 0


def _no_owner(username: str | None) -> int:
    """No owner left (the database was edited by hand, or restored from an odd backup)."""
    people = db.all("SELECT * FROM users ORDER BY username")
    if not people:
        if state.setup_needed():
            print("There are no owners yet. Open the server in a browser to run setup.", file=sys.stderr)
            return 1
        state.save("setup_completed", False)
        print(f"This server has no accounts. Setup is open again: open the server in a browser and enter this setup code:"
              f"\n\n  {state.setup_code()}\n")
        return 0
    if username is None:
        print("This server has no owner. Name the person to make one: cryptex owner reset USERNAME\n  "
              + "\n  ".join(p["username"] for p in people), file=sys.stderr)
        return 1
    user = next((p for p in people if p["username"].lower() == username.strip().lower()), None)
    if user is None:
        print(f"No one has the username {username}.", file=sys.stderr)
        return 1
    db.run("UPDATE users SET role = 'owner' WHERE id = ?", user["id"])
    emit("user.role_changed", actor="system", detail={"user_id": user["id"], "role": "owner"})
    _reset(user["id"], user["username"])
    return 0


def _reset(user_id: str, username: str) -> None:
    with db.tx() as c:
        c.execute("UPDATE users SET password_hash = NULL, totp_ct = NULL, totp_last_step = NULL WHERE id = ?", (user_id,))
        clear_vault(c, user_id)
        c.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        forget_sign_ins(c, user_id)  # a temporary password, half-done sign-in or reset link would get around the reset
        invite = issue_invite(c, user_id)
        emit("user.invited", actor="system", detail={"user_id": user_id, "role": "owner", "reset": True}, c=c)
    print(f"Sign-in for {username} reset, and their sessions were signed out. Open this link once, within 7 days,")
    print("to set a new password and authenticator app (if Cryptex has moved, use its current address):\n\n"
          f"  {state.raw('detected_url') or ''}{invite['invite_url']}\n")


def show_setup_code() -> int:
    if not state.setup_needed():
        print("Setup is already finished. There is no setup code any more.", file=sys.stderr)
        return 1
    print(state.setup_code())
    return 0


def show_temp_password(username: str | None) -> int:
    if username is None:
        waiting = [(u, pw) for u in sorted(p.name for p in (state.env().data_dir / state.TEMP_DIR).glob("[!.]*"))
                   if (pw := account.temp_password_waiting(u))]
        if not waiting:
            print("No one asked for a temporary password in the last 24 hours.", file=sys.stderr)
            return 1
        for u, pw in waiting:
            print(f"{u}  {pw}")
        return 0
    pw = account.temp_password_waiting(username.strip().lower())
    if pw is None:
        print(f"No temporary password waiting for {username}. They can ask for one with \"Forgot your password?\" "
              "on the sign-in page; it lasts 24 hours.", file=sys.stderr)
        return 1
    print(pw)
    return 0


BACKUP_PARTS = ("cryptex.db", "chunks", "brand", "enc.key")


def backup(dest: str) -> int:
    """DEST/cryptex.db (a consistent copy, taken while the server runs), DEST/chunks and DEST/enc.key (without it,
    nobody could sign in to the restored server). Chunks are copied after the
    database, so every chunk the copy refers to is there, unless its secret ended (expired, opened, destroyed) while
    the copy ran; extra ones belong to uploads the copy never saw. Everything written is for whoever runs the server
    only (folders 0700, files 0600). A copy that fails part-way is removed, so the same folder can be used again."""
    data, out = state.env().data_dir, Path(dest)
    if out.resolve() == data.resolve() or data.resolve() in out.resolve().parents:
        print("Choose a folder outside DATA_DIR.", file=sys.stderr)
        return 1
    if any((out / part).exists() for part in BACKUP_PARTS):
        print(f"{out} already holds a backup. Choose a new or empty folder.", file=sys.stderr)
        return 1
    made = not out.exists()
    try:
        out.mkdir(parents=True, exist_ok=True)
        out.chmod(0o700)
        target = out / "cryptex.db"
        dst = sqlite3.connect(target)
        try:
            db.conn().backup(dst)
            # The copy came out in WAL mode, like the live database: reading it (_missing_chunks, a restore check)
            # would leave cryptex.db-wal and -shm beside it. A backup is one file (audit N2).
            dst.execute("PRAGMA journal_mode = DELETE")
        finally:
            dst.close()
        target.chmod(0o600)
        _copy_folder(data / "chunks", out / "chunks")
        if (data / "brand").is_dir():
            _copy_folder(data / "brand", out / "brand")
        shutil.copyfile(data / "enc.key", out / "enc.key")
        (out / "enc.key").chmod(0o600)
        missing = _missing_chunks(out)
    except (OSError, sqlite3.Error) as err:
        _remove_partial(out, made)
        print(f"cryptex: the backup failed and its partial copy was removed ({err}). Fix the cause and run it again.",
              file=sys.stderr)
        return 1
    if missing:
        print(f"{missing} chunk(s) went while the copy ran: their secrets ended meanwhile (expired, opened or destroyed). "
              "Restored from this copy, those links still open but their download fails.")
    print(f"Backed up to {out}, with the server's key (enc.key): keep the copy as private as the server.")
    return 0


def _copy_folder(src: Path, dst: Path) -> None:
    """Copy a folder the server keeps changing. A file deleted meanwhile is skipped (cleanup purged its secret);
    temporary files of writes in progress aren't copied. Modes are never copied: 0700 folders and 0600 files."""
    dst.mkdir(mode=0o700, exist_ok=True)
    dst.chmod(0o700)
    try:
        entries = list(os.scandir(src))
    except FileNotFoundError:
        return
    for e in entries:
        if ".tmp" in e.name:
            continue
        try:
            if e.is_dir(follow_symlinks=False):
                _copy_folder(Path(e.path), dst / e.name)
            elif e.is_file(follow_symlinks=False):
                shutil.copyfile(e.path, dst / e.name)
                (dst / e.name).chmod(0o600)
        except FileNotFoundError:
            continue  # deleted while we copied (or its folder was)


def _missing_chunks(out: Path) -> int:
    """Chunks the copied database refers to that aren't in the copy: their secrets ended after the database copy."""
    c = sqlite3.connect(f"file:{out / 'cryptex.db'}?mode=ro", uri=True)
    try:
        keys = [r[0] for r in c.execute("SELECT blob_key FROM chunks")]
    finally:
        c.close()
    return sum(1 for k in keys if not (out / "chunks" / k[:2] / k).is_file())


def _remove_partial(out: Path, made: bool) -> None:
    """Undo a failed backup: what it wrote, and the folder itself if it made it."""
    for part in (*BACKUP_PARTS, "cryptex.db-wal", "cryptex.db-shm", "cryptex.db-journal"):
        p = out / part
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists():
            p.unlink(missing_ok=True)
    if made:
        shutil.rmtree(out, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="cryptex", description="Cryptex server management")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup-code", help="show the code that claims a fresh install")
    temp = sub.add_parser("temp-password", help="show a temporary password someone asked for")
    temp.add_argument("username", nargs="?")
    owner = sub.add_parser("owner", help="owner accounts")
    osub = owner.add_subparsers(dest="action", required=True)
    reset = osub.add_parser("reset", help="new invite link for a locked-out owner")
    reset.add_argument("username", nargs="?")
    bk = sub.add_parser("backup", help="copy the database and chunks to a folder, while the server runs")
    bk.add_argument("dest")
    a = p.parse_args(argv)
    # Everything a command writes (a backup's database, chunks and folders; a generated key or setup code) is for
    # whoever runs the server only, from the moment it exists.
    umask = os.umask(0o077)
    try:
        return _run(a)
    finally:
        os.umask(umask)


def _run(a: argparse.Namespace) -> int:
    try:
        env = load_env()
    except ValueError as err:
        print(f"cryptex: {err}", file=sys.stderr)
        return 1
    state.init(env)
    db.configure(env.data_dir / "cryptex.db")
    try:
        security.check_canary()
    except RuntimeError as err:
        print(f"cryptex: {err}", file=sys.stderr)
        return 1
    if a.cmd == "setup-code":
        return show_setup_code()
    if a.cmd == "temp-password":
        return show_temp_password(a.username)
    if a.cmd == "owner" and a.action == "reset":
        return owner_reset(a.username)
    if a.cmd == "backup":
        return backup(a.dest)
    return 2


if __name__ == "__main__":
    sys.exit(main())
