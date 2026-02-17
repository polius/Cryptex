<div align="center">
<img src="web/assets/logo.svg" alt="Cryptex Logo" width="80">
<h1 align="center">Cryptex</h1>

**Lock down your data. Send it securely.**

<p align="center">
<a href="https://github.com/polius/cryptex/actions/workflows/release.yml"><img src="https://github.com/polius/cryptex/actions/workflows/release.yml/badge.svg"></a>&nbsp;<a href="https://github.com/polius/cryptex/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/polius/cryptex"></a>&nbsp;<a href="https://hub.docker.com/r/poliuscorp/cryptex"><img alt="Docker Pulls" src="https://img.shields.io/docker/pulls/poliuscorp/cryptex"></a>
</p>

<br>

<p align="center">
<b>Cryptex</b> is a self-hosted platform for sharing text and files securely.
</p>

<br>

![Cryptex](web/assets/cryptex.png?v=2.0.0)

</div>

## Features

- **Self-hosted** — deploy with a single Docker command. Your data stays on your server.
- **Simple secure sharing** — share text and files with optional password protection.
- **Password protection** — protect access with a password, or generate one automatically.
- **Self-destruct** — optionally destroy a cryptex automatically after it's been opened.
- **Expiration** — set a time limit (minutes, hours, or days) after which the cryptex is permanently deleted.
- **Public / Private mode** — run open to anyone, or require an invite link to create a cryptex.
- **Invite links** — create shareable invite links that allow others to create Cryptexs, even in private mode.
- **Admin panel** — monitor active Cryptexs, manage invite links, configure limits, and enable two-factor authentication.
- **Multipart file uploads** — large files are uploaded in chunks for reliability.
- **QR code sharing** — generate a QR code for easy mobile access.
- **API support** — fully documented API with API key authentication for programmatic access.

## Quick Start

### Docker CLI

```bash
docker run -d \
  --name cryptex \
  -p 80:80 \
  -v ./data:/cryptex/data \
  --restart unless-stopped \
  poliuscorp/cryptex
```

### Docker Compose

```yaml
services:
  cryptex:
    image: poliuscorp/cryptex
    container_name: cryptex
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - ./data:/cryptex/data
```

Then open [http://localhost](http://localhost).

> The `./data` volume persists the database and uploaded files across container restarts. Replace it with any host path you prefer.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MODE` | `public` | `public` allows anyone to create a cryptex. `private` restricts creation to authenticated users or valid invite links |
| `ADMIN_PASSWORD` | — | Bcrypt hash used to override the default admin password (`admin`) |
| `MAX_MESSAGE_LENGTH` | `1000` | Max characters per cryptex |
| `MAX_FILE_COUNT` | `3` | Max file attachments per cryptex |
| `MAX_FILE_SIZE` | `100mb` *(100 MB)* | Max size per file (`500kb`, `10mb`, `1gb`) |
| `MAX_EXPIRATION` | `1d` *(1 day)* | Max expiration time (`30m`, `24h`, `30d`) |
| `RATE_LIMIT` | `30` | Max requests per minute per IP for create/open endpoints |

## Admin Panel

Manage Cryptexs, invite links, settings, and 2FA at [http://localhost/login](http://localhost/login).

**Default password:** `admin` — change it in production.

Generate a custom password hash:

```bash
pip install bcrypt
python3 -c "import bcrypt, getpass; p = getpass.getpass('Enter password: '); print(bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode())"
```

Then set `ADMIN_PASSWORD` in your environment:

```yaml
environment:
  - ADMIN_PASSWORD=$2b$12$LJ3m4ys3uz0Cb6PEhV7hXOBFg7b6I1MeZaYvLYEPYj5KzKIO/3Cxm
```

**Note:** If you're using the Docker CLI (`-e` flag), wrap the hash in **single quotes**:

```bash
-e ADMIN_PASSWORD='$2b$12$LJ3m4ys3uz0Cb6PEhV7hXOBFg7b6I1MeZaYvLYEPYj5KzKIO/3Cxm'
```

## Upgrading

### Docker CLI

```bash
docker pull poliuscorp/cryptex
docker stop cryptex && docker rm cryptex
docker run -d \
  --name cryptex \
  -p 80:80 \
  -v ./data:/cryptex/data \
  --restart unless-stopped \
  poliuscorp/cryptex
```

### Docker Compose

```bash
docker compose pull
docker compose up -d
```

The `./data` volume preserves your database and files across upgrades.

## License

This project is licensed under the [MIT License](LICENSE).
