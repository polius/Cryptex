import base64
import re
import secrets
import shutil
import time

from fastapi import APIRouter, HTTPException, Depends

from .. import database as db
from ..models import LinkCreate, LinkUpdate
from .auth import check_auth

router = APIRouter(prefix="/links", tags=["Links"])


@router.post("/create")
async def create_link(link_data: LinkCreate, _=Depends(check_auth)):
    """Create a new link"""
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    expires_at = now + link_data.expires_in if link_data.expires_in > 0 else 0
    password = base64.b64encode(secrets.token_bytes(24)).decode()

    new_link = await db.create_link(
        token=token, label=link_data.label, created_at=now,
        expires_at=expires_at, max_uses=1, password=password,
    )
    return new_link


@router.get("/list")
async def list_links(_=Depends(check_auth)):
    """List all links (including expired) for the admin panel."""
    return await db.get_all_links()


@router.delete("/delete/{token}")
async def delete_link(token: str, delete_data: bool = False, _=Depends(check_auth)):
    """Delete a link and optionally its associated cryptex."""
    deleted_cryptex = False
    link = await db.get_link(token)

    if delete_data and link and link.get("cryptex_id"):
        cryptex_id = link["cryptex_id"]
        if re.match(r'^[a-z]{3}-[a-z]{4}-[a-z]{3}$', cryptex_id):
            await db.delete_cryptex(cryptex_id)
            cryptex_dir = db.FILES_DIR / cryptex_id
            if cryptex_dir.exists():
                shutil.rmtree(cryptex_dir)
            deleted_cryptex = True

    await db.delete_link(token)
    return {"success": True, "deleted_cryptex": deleted_cryptex}


@router.put("/update/{token}")
async def update_link(token: str, update_data: LinkUpdate, _=Depends(check_auth)):
    """Update a link's label"""
    found = await db.update_link_label(token, update_data.label)
    if not found:
        raise HTTPException(status_code=404, detail="Link not found")
    return {"success": True}


@router.post("/validate/{token}")
async def validate_link(token: str):
    """Validate and consume a link token (public endpoint)"""
    link = await db.get_link(token)
    if not link:
        raise HTTPException(status_code=404, detail="Invalid link token")

    now = int(time.time())
    if link["expires_at"] > 0 and link["expires_at"] < now:
        raise HTTPException(status_code=410, detail="Link has expired")
    if link["uses"] >= link["max_uses"]:
        raise HTTPException(status_code=410, detail="Link has reached maximum uses")

    return {"valid": True, "label": link["label"]}


@router.get("/check/{token}")
async def check_link(token: str):
    """Check if a link is valid without consuming it (public endpoint)"""
    link = await db.get_link(token)
    if not link:
        return {"valid": False, "reason": "Invalid token"}

    if link.get("cryptex_id"):
        return {"valid": False, "reason": "Used"}

    now = int(time.time())
    if link["expires_at"] > 0 and link["expires_at"] < now:
        return {"valid": False, "reason": "Expired"}
    if link["uses"] >= link["max_uses"]:
        return {"valid": False, "reason": "Max uses reached"}

    return {
        "valid": True,
        "label": link["label"],
        "password": link.get("password"),
        "has_password": bool(link.get("password")),
    }
