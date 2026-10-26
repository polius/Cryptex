"""Email over SMTP_URL. Templates are design/v3/copy/emails.md.

No email ever contains a secret, its title or a link that reveals anything.
Sending happens on a background thread so a slow SMTP server never delays a response.
"""
from __future__ import annotations

import html
import logging
import queue
import smtplib
import ssl
import threading
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import make_msgid
from urllib.parse import unquote, urlparse

from . import state

log = logging.getLogger("cryptex.mail")
_q: queue.Queue[EmailMessage | None] = queue.Queue()
_thread: threading.Thread | None = None
sent: list[EmailMessage] = []  # last messages, for the test suite only (kept short)


def _smtp_send(msg: EmailMessage) -> None:
    u = urlparse(state.env().smtp_url or "")
    host, user, pw = u.hostname or "localhost", unquote(u.username or ""), unquote(u.password or "")
    if u.scheme == "smtps":
        s: smtplib.SMTP = smtplib.SMTP_SSL(host, u.port or 465, timeout=20, context=ssl.create_default_context())
    else:
        s = smtplib.SMTP(host, u.port or (587 if u.scheme == "smtp+starttls" else 25), timeout=20)
        if u.scheme == "smtp+starttls":
            s.starttls(context=ssl.create_default_context())
    try:
        if user:
            s.login(user, pw)
        s.send_message(msg)
    finally:
        s.quit()


def _worker() -> None:
    while True:
        msg = _q.get()
        if msg is None:
            return
        try:
            _smtp_send(msg)
        except Exception as e:  # never log addresses or bodies
            log.error("email delivery failed: %s", type(e).__name__)
        finally:
            _q.task_done()


def start() -> None:
    global _thread
    if _thread is None or not _thread.is_alive():
        _thread = threading.Thread(target=_worker, name="mailer", daemon=True)
        _thread.start()


def flush(timeout: float = 10) -> None:
    """Wait until queued messages are handed to SMTP (tests and shutdown)."""
    end = time.time() + timeout
    while _q.unfinished_tasks and time.time() < end:
        time.sleep(0.02)


def when(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%-d %b %Y, %H:%M UTC")


def _compose(to: str, subject: str, paragraphs: list[str], button: tuple[str, str] | None, footer: str | None) -> EmailMessage:
    e = state.env()
    brand = state.brand_name()
    host = urlparse(state.public_url()).netloc or state.public_url()
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = e.smtp_from or f"{brand} <no-reply@{(urlparse(state.public_url()).hostname or 'localhost')}>"
    msg["To"] = to
    msg["Message-ID"] = make_msgid(domain="cryptex")
    text = "\n\n".join(p.replace("**", "") for p in paragraphs)
    if button:
        text += f"\n\n{button[0]}: {button[1]}"
    if footer:
        text += f"\n\n{footer}"
    text += f"\n\n— {brand} · {host}\n"
    msg.set_content(text)

    def para(p: str) -> str:
        parts = html.escape(p).split("**")
        return "".join(f"<strong>{x}</strong>" if i % 2 else x for i, x in enumerate(parts))
    body = "".join(f'<p style="margin:0 0 16px;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111">{para(p)}</p>' for p in paragraphs)
    if button:
        body += (f'<p style="margin:24px 0"><a href="{html.escape(button[1])}" style="display:inline-block;background:#111;color:#fff;'
                 f'text-decoration:none;padding:12px 18px;border-radius:10px;font:600 15px -apple-system,Segoe UI,Roboto,sans-serif">{html.escape(button[0])}</a></p>')
    if footer:
        body += f'<p style="margin:24px 0 0;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#555">{html.escape(footer)}</p>'
    msg.add_alternative(
        f'<!doctype html><html><body style="margin:0;background:#f5f5f2;padding:32px 16px">'
        f'<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;border:1px solid #e6e5df">'
        f'<p style="margin:0 0 24px;font:700 17px -apple-system,Segoe UI,Roboto,sans-serif;color:#111">{html.escape(brand)} '
        f'<span style="font-weight:400;color:#555">Secure share</span></p>{body}</div>'
        f'<p style="text-align:center;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#777;margin:16px 0 0">{html.escape(host)}</p>'
        f"</body></html>",
        subtype="html",
    )
    return msg


def send(to: str, subject: str, paragraphs: list[str], button: tuple[str, str] | None = None, footer: str | None = None) -> None:
    if not state.env().smtp_enabled:
        return
    msg = _compose(to, subject, paragraphs, button, footer)
    sent.append(msg)
    del sent[:-50]
    start()
    _q.put(msg)


# ------------------------------------------------------------- the five templates
def opened(to: str, item_id: str, at: int) -> None:
    brand = state.brand_name()
    send(to, f"Your {brand} link was opened", [
        f"Your secure link {item_id[:4]}… was opened {when(at)}. It’s now deleted from the server.",
        "If you didn’t expect it to be opened yet, someone else may have the link. Change what you shared and send a new link.",
    ], ("See the receipt", f"{state.public_url()}/r/{item_id}"),
        "You get this because you chose “Tell me when it’s opened”.")


def answered(to: str, item_id: str, at: int, kept_until: int) -> None:
    brand = state.brand_name()
    send(to, f"Someone answered your {brand} request", [
        f"Your request {item_id[:4]}… was answered {when(at)}. Open Your links on the device you used to create it to reveal the answer.",
    ], ("Open Your links", f"{state.public_url()}/links"), f"The answer is kept until {when(kept_until)}.")


def code(to: str, sender: str, code_: str) -> None:
    brand = state.brand_name()
    send(to, f"{code_} is your code for {brand}", [
        f"{sender} sent you something through {brand} that only you can open.",
        f"Your code is **{code_}**. It works for 10 minutes.",
        "If you weren’t expecting this, you can ignore this email; nothing will be opened.",
    ])


def destroyed(to: str, at: int) -> None:
    brand = state.brand_name()
    send(to, f"Your {brand} link was destroyed", [
        f"Someone with your link entered the wrong passphrase 5 times, so the secret was destroyed {when(at)}. It was never revealed.",
        "If that wasn’t the person you sent it to, the link may have been shared further. Send a new link if it’s still needed.",
    ])


def test(to: str) -> None:
    host = urlparse(state.public_url()).netloc
    send(to, f"Test email from {state.brand_name()}", [
        f"Email is working for {host}. People can now choose “Tell me when it’s opened” and email-only links.",
    ])
