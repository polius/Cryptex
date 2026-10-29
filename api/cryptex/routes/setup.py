"""First-run setup (screen F1). Nothing can be created until an owner exists, and only
someone holding the setup code (`cryptex setup-code`, also printed in the server log) can claim a fresh install.
The browser asks everything first; POST /setup then does it all at once, so a setup is either finished or not begun."""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Request, Response
from pydantic import Field

from .. import db, state
from ..account import B64_16, B64_32, Credentials, Username, set_credentials
from ..deps import caller
from ..errors import ApiError, invalid
from ..events import emit
from ..util import new_id, now, same
from .auth import Attempt, fresh_user, session_json, start_session
from .common import Body

router = APIRouter()


@router.get("/setup")
def get_setup() -> dict[str, Any]:
    e = state.env()
    return {"needed": state.setup_needed(), "brand_locked": "brand_name" in e.locked, "access_locked": "access" in e.locked,
            "code_command": state.cli_command("setup-code")}


class SetupCode(Body):
    setup_code: str = Field(min_length=1, max_length=64)


def check_setup_code(a: Attempt, code: str) -> None:
    """Setup still open, and the code right (a wrong one counts toward RATE_AUTH, like a wrong password)."""
    if not state.setup_needed() or state.owner_exists():
        raise ApiError("setup_done")
    if not same(code.strip().upper(), state.setup_code().upper()):
        raise a.wrong(invalid("setup_code", "That setup code isn’t right. Run cryptex setup-code on the server to see it."))


@router.post("/setup/check", status_code=204)
def setup_check(body: SetupCode, request: Request) -> Response:
    """The setup code alone, on the first step: a wrong one is caught before the rest is asked. POST /setup checks it
    again."""
    with Attempt(caller(request)) as a:
        check_setup_code(a, body.setup_code)
    return Response(status_code=204)


class Setup(Body):
    setup_code: str = Field(min_length=1, max_length=64)
    username: Username
    salt: str = Field(pattern=B64_16)
    auth_key: str = Field(pattern=B64_32)  # derived from the password in the browser; the password never arrives
    brand_name: str = Field(default="", max_length=40)
    access: Literal["anyone", "signed_in"]


@router.post("/setup")
def finish_setup(body: Setup, request: Request, response: Response) -> dict[str, Any]:
    """Finish: the owner account, the name recipients see, and who can create links. The owner is signed in here,
    and adds a logo and 2FA afterwards like any other change."""
    with Attempt(caller(request)) as a:
        check_setup_code(a, body.setup_code)
    uid = new_id(16)
    with db.tx() as conn:
        if conn.execute("SELECT 1 FROM users WHERE role = 'owner'").fetchone():
            raise ApiError("setup_done")
        conn.execute("INSERT INTO users(id, username, role, created_at) VALUES (?,?,?,?)", (uid, body.username, "owner", now()))
        set_credentials(conn, uid, Credentials(salt=body.salt, auth_key=body.auth_key))
    locked = state.env().locked
    if "brand_name" not in locked:
        state.save("brand_name", body.brand_name.strip(), uid)
    if "access" not in locked:
        state.save("access", body.access, uid)
    state.save("setup_completed", True, uid)
    state.forget_setup_code()
    # Only `cryptex owner reset`, which has no browser, needs the address: it prints its invite link with this one.
    state.save("detected_url", f"{request.url.scheme}://{request.url.netloc}")
    emit("setup.completed", actor="user", user_id=uid)
    csrf = start_session(uid, request, response)  # whoever sets up a server does it on their own computer
    return session_json(fresh_user(uid), csrf, False)
