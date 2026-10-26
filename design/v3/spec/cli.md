# CLI specification (`cryptex`)

Go, single static binary for Linux, macOS and Windows (amd64, arm64). Uses the same crypto format and must pass `vectors.json`. Published on GitHub Releases, Homebrew and as the `poliuscorp/cryptex-cli` image.

## Configuration

- `~/.config/cryptex/config.toml` (or `%APPDATA%\cryptex\config.toml`): `server = "https://vault.acme.com"`.
- The API token is stored in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service); `CRYPTEX_TOKEN` overrides it for CI.
- `CRYPTEX_SERVER` overrides the server.

## Commands

| Command | Does | Key flags |
|---|---|---|
| `cryptex login [server]` | Opens the browser to create a token (or reads one from stdin with `--with-token`) and stores it | `--with-token` |
| `cryptex logout` | Removes the stored token | |
| `cryptex send [file…]` | Encrypts stdin and/or files locally, uploads, prints the link | `--title`, `--once` (default) or `--views N`, `--ttl 1h\|1d\|7d`, `--email addr`, `--org`, `--passphrase` (prompts) or `--generate-passphrase`, `--notify`, `--fields` (parse stdin with the paste parser rules), `--copy` |
| `cryptex request TITLE` | Creates a request; keeps the private key in `~/.config/cryptex/keys/` (0600) | `--field NAME` (repeatable), `--files`, `--ttl`, `--keep`, `--message` |
| `cryptex open LINK` | Reveals a secret or reads a request answer and prints it | `--as text\|env\|json`, `--out DIR` for files, `--passphrase` |
| `cryptex status [ID…]` | Shows receipts created by this CLI | `--watch` (follows SSE) |
| `cryptex destroy ID` | Destroy now | |
| `cryptex ls` | Lists receipts created by this CLI | `--json` |

## Output and exit codes

- Human output by default; `--json` everywhere prints one JSON object per result.
- Secrets are never printed unless the command is `open`; `send` prints only the link (and the passphrase once, to stderr, when generated).
- Exit codes: `0` ok · `1` usage error · `2` network or server error · `3` not found or wrong token (the API's 404) · `4` gone (410) · `5` wrong passphrase · `6` rate limited · `7` link incomplete.

## Examples

```
$ cryptex send --title "Staging database" --ttl 1d < .env.staging
https://vault.acme.com/s/k7Qp2vR9mL#08hLdXPyTgClYg1aikN6PA

$ cryptex request "AWS read-only keys" --field "Access key ID" --field "Secret access key" --keep 7d
https://vault.acme.com/q/7hk2Vn4pXa#…

$ cryptex status --watch k7Qp2vR9mL
●──────○  sealed 14:01   waiting…
●──────●  opened 14:05   destroyed

$ cryptex open https://vault.acme.com/q/7hk2Vn4pXa --as env >> .env
```
