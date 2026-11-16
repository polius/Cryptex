# Security policy

## Reporting a vulnerability

Please report it privately, through GitHub: **[Report a vulnerability](https://github.com/polius/Cryptex/security/advisories/new)**
(Security › Advisories). Don't open a public issue. Say what you found, how to reproduce it, and which version.

You'll get an answer within a week. Fixes are released as soon as they're ready, and the advisory credits you
unless you'd rather it didn't.

## Supported versions

| Version | Supported |
|---|---|
| 3.x, latest release | Yes: fixes ship as a new 3.x release |
| 3.x, older releases | Update to the latest 3.x |
| 2.x | No. Version 3 is a rewrite with a new format; start it with an empty data folder |

What Cryptex protects against, and what it doesn't, is in [docs/threat-model.md](docs/threat-model.md). The
encryption format is in [docs/crypto.md](docs/crypto.md).

## Verify what you run

Every release publishes the image with an SBOM and build provenance, and a `SHA256SUMS` of the web files inside it
with its own provenance. A web page is only as trustworthy as the server that serves it: these let you check that a
server runs the files a release built.

**The image** came from this repository's release workflow ([GitHub CLI](https://cli.github.com)):

```sh
gh attestation verify oci://index.docker.io/poliuscorp/cryptex:3.1.1 --repo polius/Cryptex
```

**Pin it by digest**, so a tag that moves can't change what you run:

```sh
docker buildx imagetools inspect poliuscorp/cryptex:3.1.1 --format '{{json .Manifest}}' | jq -r .digest
# then, in the compose file: image: poliuscorp/cryptex:3.1.1@sha256:<that digest>
```

**A live server's web files** match the release's (here `https://cryptex.example.com`):

```sh
curl -fsSLO https://github.com/polius/Cryptex/releases/download/v3.1.1/SHA256SUMS
gh attestation verify SHA256SUMS --repo polius/Cryptex
grep -v '\.\(br\|gz\)$' SHA256SUMS | while read -r sum file; do
  [ "$(curl -fsS "https://cryptex.example.com/${file#./}" | sha256sum | cut -d' ' -f1)" = "$sum" ] || echo "differs: $file"
done
```

No output after the attestation check means every file matches.
