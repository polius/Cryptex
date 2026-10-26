# cryptex: command-line client for Cryptex 3

`cryptex` encrypts on your machine and talks to a Cryptex server, which only ever sees ciphertext.
It implements [crypto format v1](../design/v3/spec/crypto-v1.md) and passes its test vectors.

## Install

```sh
go install github.com/polius/cryptex/cli/cmd/cryptex@latest
# or build a static binary:
cd cli && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/polius/cryptex/cli/internal/app.Version=3.0.0" -o cryptex ./cmd/cryptex
```

Go 1.25+. Builds for Linux, macOS and Windows on amd64 and arm64 with `CGO_ENABLED=0`.

## Set up

```sh
cryptex login https://vault.acme.com            # opens /tokens in the browser, then asks you to paste the token
cryptex login https://vault.acme.com --with-token < token.txt
```

The server goes to `config.toml` and the token goes to the OS keychain (macOS Keychain, Windows Credential
Manager, Secret Service). With no keychain, the token goes to `credentials.json` (0600) instead. Servers that
let anyone create links don't need a token.

| Setting | Where |
|---|---|
| Config directory | `$CRYPTEX_CONFIG_DIR`, else `%APPDATA%\cryptex` (Windows), else `$XDG_CONFIG_HOME/cryptex`, else `~/.config/cryptex` |
| Server | `--server`, else `CRYPTEX_SERVER`, else `server = "…"` in `config.toml` |
| API token | `CRYPTEX_TOKEN`, else the keychain, else `credentials.json` |
| Passphrase | `CRYPTEX_PASSPHRASE` (for `send --passphrase` and `open`) |
| No prompts | `CRYPTEX_NO_PROMPT=1` never reads from the terminal (CI) |
| No keychain | `CRYPTEX_KEYRING=file` |

The CLI keeps receipts (with manage tokens) in `receipts.json` and request private keys in `keys/<id>.pem`.
Both are 0600. Once an item is final (opened, expired, destroyed), its link key is removed from
`receipts.json`. A request's private key is deleted once its answer is gone.

## Commands

| Command | Does |
|---|---|
| `cryptex send [file…]` | Encrypts stdin and/or files, uploads them, and prints only the link. Flags: `--title`, `--once` (default) or `--views N`, `--ttl 1h\|1d\|7d`, `--email addr`, `--org`, `--passphrase` or `--generate-passphrase` (printed once, to stderr), `--notify`, `--fields` (parse stdin into fields), `--copy` |
| `cryptex request TITLE` | Creates a request link. Flags: `--field NAME` (repeatable), `--files`, `--ttl`, `--keep`, `--message`, `--notify`, `--copy` |
| `cryptex answer LINK [file…]` | Answers someone's request with stdin and/or files. If the request names fields, stdin is parsed as `KEY=value` or `key: value` lines; a single field takes the whole text. In a terminal, you're asked for each field |
| `cryptex open LINK\|ID` | Reveals a secret (this uses a view), or reads the answer to your request. Flags: `--as text\|env\|json`, `--out DIR` for files (default `.`), `--passphrase`, `--wait` (requests). For someone else's request link, it shows what they ask for |
| `cryptex status [ID…]` | Shows the server status of items created by this CLI. `--watch` follows live updates |
| `cryptex destroy ID` | Destroys a secret, or cancels a request, right now |
| `cryptex ls` | Lists local receipts (no network) |
| `cryptex logout` | Removes the stored token |

`--json` works on every command and prints one JSON object per result. Errors are printed as `{"error": {…}}`.
Flags may come before or after arguments.

```sh
cryptex send --title "Staging database" --ttl 1d < .env.staging
cryptex send --fields --views 3 < .env
cryptex request "AWS read-only keys" --field "Access key ID" --field "Secret access key" --keep 7d
printf 'Access key ID: AKIA…\nSecret access key: …\n' | cryptex answer 'https://vault.acme.com/q/7hk2Vn4pXa#…'
cryptex open 7hk2Vn4pXa --as env >> .env
cryptex status --watch k7Qp2vR9mL
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Usage error (bad flags, missing file, over a server limit, a passphrase needed without a terminal) |
| 2 | Network or server error, tampered data, an org-only link (open it in a browser) |
| 3 | Not found or wrong token (the API's 404); also `open` on a request with no answer yet |
| 4 | Gone: opened, expired, destroyed, cancelled or already answered (410) |
| 5 | Wrong passphrase (the message shows how many tries are left) |
| 6 | Rate limited (429) |
| 7 | Link incomplete: the key after `#` is missing or cut off. This is checked before any network call |

## Tests

```sh
go test ./...                                    # crypto vectors, paste parser, CLI helpers
CRYPTEX_IT=1 go test ./cmd/cryptex -run Integration -v
```

The integration test starts the real server from `../api` (it needs `../api/.venv`; `CRYPTEX_API_DIR`
overrides the path). It completes setup over HTTP, then runs every command against it, including a
`DEMO=true` server for proof of work.
