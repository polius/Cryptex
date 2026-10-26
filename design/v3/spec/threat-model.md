# Threat model

## Assets

1. Secret contents (notes, fields, files) and their titles and sender names.
2. Link keys (URL fragments), passphrases, request private keys.
3. Capability tokens (reveal, upload, manage, answer, read sessions) and sessions.
4. Metadata: who sent what to whom, and when.
5. Availability of the service and its disk.

## Adversaries and what they get

| Adversary | Can | Can't | Mitigations |
|---|---|---|---|
| Stranger on the internet | Guess IDs, send requests | Read, burn, destroy or add to any item (needs tokens) | Capability tokens, uniform 404, per-IP limits incl. IPv6 /64, failed-token blocking |
| Someone who sees a link in transit (chat history, forwarded email) | Reveal it if it's still unopened and access is “anyone” | Reveal email-only or org-only links; reveal after it was opened; stay unnoticed | Access rules, one-time views, sender sees “Opened” immediately with the time |
| Link scanners and previews | Load the sealed page | Consume the secret | Nothing changes on load; reveal is a POST after a click |
| Recipient's device later | Read the browser history | Recover a revealed secret | Fragment removed from the URL bar, page auto-clears, nothing stored |
| Database or backup thief | Read all tables and chunks | Decrypt anything; recover emails without `ENC_KEY` | E2E format, token hashes only, `ENC_KEY` kept apart |
| Curious server owner | See counts, sizes, times, signed-in senders' emails, audit log | Read contents or titles; reveal or destroy others' items | No admin bypass in the API; events hold no content |
| Malicious server operator (changes the code) | Serve JavaScript that leaks keys | Affect CLI users or past secrets | Strict CSP, no third-party code, published release hashes, CLI for high-risk use. **Residual risk, stated in the privacy notice.** |
| Abuser of a public instance | Host files or phishing for an hour | Keep content up, use it at scale | Demo limits, banner on recipient pages, proof of work, reports, breakers |
| Sender's stolen laptop | See Your links titles and statuses | Open links already opened or expired | Link keys deleted at final status, “Clear this device” |

## Out of scope

Compromised recipient or sender devices (malware, keyloggers); recipients who copy a secret elsewhere after revealing it; traffic analysis by a network observer; denial of service beyond rate limits and breakers.

## Security requirements traced to tests

Every row above has at least one test in `api/tests/security/` or the Playwright suite, named after the row, for example `test_stranger_cannot_destroy_by_id` and `e2e_scanner_load_does_not_consume`.
