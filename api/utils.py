import hashlib
import re
import secrets
import string

def parse_file_size(size_str: str) -> int:
    """Parse file size string with units (B, KB, MB, GB) to bytes.
    
    Examples:
        "10" -> 10 bytes
        "10mb" or "10MB" -> 10485760 bytes
        "5gb" or "5GB" -> 5368709120 bytes
        "500kb" or "500KB" -> 512000 bytes
    """
    size_str = str(size_str).strip()
    
    # Check if it's just a number (bytes)
    if size_str.isdigit():
        return int(size_str)
    
    # Parse with units
    match = re.match(r'^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$', size_str, re.IGNORECASE)
    if not match:
        raise ValueError(f"Invalid file size format: {size_str}")
    
    value = float(match.group(1))
    unit = match.group(2).lower()
    
    multipliers = {
        'b': 1,
        'kb': 1024 ** 1,
        'mb': 1024 ** 2,
        'gb': 1024 ** 3
    }
    
    return int(value * multipliers[unit])

def parse_time(time_str: str) -> int:
    """Parse time string with units (m, h, d) to seconds.
    
    Examples:
        "60" -> 60 seconds
        "30m" or "30M" -> 1800 seconds
        "24h" or "24H" -> 86400 seconds
        "30d" or "30D" -> 2592000 seconds
    """
    time_str = str(time_str).strip()
    
    # Check if it's just a number (seconds)
    if time_str.isdigit():
        return int(time_str)
    
    # Parse with units
    match = re.match(r'^(\d+(?:\.\d+)?)\s*(m|h|d)$', time_str, re.IGNORECASE)
    if not match:
        raise ValueError(f"Invalid time format: {time_str}")
    
    value = float(match.group(1))
    unit = match.group(2).lower()
    
    multipliers = {
        'm': 60,        # minutes to seconds
        'h': 3600,      # hours to seconds
        'd': 86400      # days to seconds
    }
    
    return int(value * multipliers[unit])

def hash_password(password: str) -> str:
    """Hash password using SHA-512 and return as hex string."""
    return hashlib.sha512(password.encode()).hexdigest()

def generate_random_id() -> str:
    """Generate a random cryptex ID in format: xxx-xxxx-xxx"""
    return '-'.join(''.join(secrets.choice(string.ascii_lowercase) for _ in range(n)) for n in [3, 4, 3])

def format_time(seconds: int) -> str:
    """Format seconds into human-readable time string"""
    seconds = max(0, int(seconds))
    d, r = divmod(seconds, 86400)
    h, r = divmod(r, 3600)
    m, s = divmod(r, 60)
    return f"{d} days, {h} hours, {m} minutes, {s} seconds"
