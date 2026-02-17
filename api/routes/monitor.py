import re
import shutil

from fastapi import APIRouter, HTTPException, Depends

from .. import database as db
from .auth import check_auth

router = APIRouter(prefix="/monitor", tags=["Monitor"])

@router.get("/stats")
async def get_monitor_stats(
    user = Depends(check_auth)
):
    """Get statistics about stored cryptex items.
    """
    files_dir = db.FILES_DIR

    all_cryptex = await db.list_all_cryptex()

    text_only = 0
    files_only = 0
    text_with_files = 0
    total_size = 0
    items = []

    for data in all_cryptex:
        has_text = data["has_text"]
        has_files = data["file_count"] > 0

        if has_text and has_files:
            text_with_files += 1
        elif has_text:
            text_only += 1
        elif has_files:
            files_only += 1

        total_size += data["total_size"]

        items.append({
            "id": data["id"],
            "created": data["created"],
            "has_text": has_text,
            "has_files": has_files,
            "file_count": data["file_count"],
            "total_size": data["total_size"],
            "expires_in": data["expires_in"],
            "encrypted": bool(data.get("password")),
            "autodestroy": data["autodestroy"],
            "views": data.get("views", 0),
        })

    # Disk usage is the only filesystem call — unavoidable.
    disk_usage = shutil.disk_usage(files_dir if files_dir.exists() else "/cryptex")

    return {
        "total_items": len(all_cryptex),
        "text_only": text_only,
        "files_only": files_only,
        "text_with_files": text_with_files,
        "total_size": total_size,
        "disk_total": disk_usage.total,
        "disk_used": disk_usage.used,
        "disk_free": disk_usage.free,
        "items": items
    }

@router.delete("/delete/{cryptex_id}")
async def delete_cryptex(
    cryptex_id: str,
    user = Depends(check_auth)
):
    """Delete a cryptex from admin panel."""
    
    # Validate cryptex_id format to prevent path traversal
    if not re.match(r'^[a-z]{3}-[a-z]{4}-[a-z]{3}$', cryptex_id):
        raise HTTPException(status_code=400, detail="Invalid cryptex ID format")
    
    files_dir = db.FILES_DIR
    
    # Delete from database
    await db.delete_cryptex(cryptex_id)
    
    # Delete folder from disk
    cryptex_dir = files_dir / cryptex_id
    if cryptex_dir.exists():
        shutil.rmtree(cryptex_dir)
    
    return {"message": "Cryptex deleted successfully"}

@router.delete("/delete-all")
async def delete_all_cryptex(
    user = Depends(check_auth)
):
    """Delete all cryptex items from admin panel."""
    
    files_dir = db.FILES_DIR
    
    if not files_dir.exists():
        return {"message": "No items to delete", "deleted": 0}
    
    # Delete all from database
    deleted_count = await db.delete_all_cryptex()
    
    # Delete all folders from disk
    for cryptex_dir in files_dir.iterdir():
        if cryptex_dir.is_dir():
            try:
                shutil.rmtree(cryptex_dir)
            except Exception as e:
                print(f"[Admin] Error deleting folder {cryptex_dir.name}: {e}")
    
    return {"message": f"Successfully deleted {deleted_count} items", "deleted": deleted_count}
