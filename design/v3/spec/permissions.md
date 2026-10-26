# Who can do what

Roles: **Visitor** (no session), **Link holder** (has a capability token from a link), **Member** (signed in), **Owner** (signed-in member with the owner role), **API token** (acts as its member, limited by scopes).

| Action | Visitor | Link holder | Member | Owner | API token | Notes |
|---|---|---|---|---|---|---|
| Create a secret | if `ACCESS=anyone` | — | yes | yes | `send` scope | Rate-limited per IP for visitors |
| Create a request | if `ACCESS=anyone` | — | yes | yes | `request` scope | |
| See a secret's sealed page | — | reveal token | — | — | — | |
| Reveal | — | reveal token + access rule | — | — | — | Email rule: code; org rule: member of an allowed domain |
| Answer a request | — | answer token | — | — | — | Once |
| See status, destroy early | — | manage token | via synced receipts | via synced receipts | via its own receipts | Owners can't see or destroy other people's items |
| Sync receipts across devices | — | — | yes | yes | — | Statuses only; link keys stay on the device |
| Use “Only people at {brand}” | — | — | yes | yes | yes | Needs OIDC |
| Create own API tokens | — | — | yes | yes | — | Max 365 days |
| Open the Server tab | — | — | — | yes | — | |
| Change access, roles, tokens of others | — | — | — | yes + re-auth | — | Re-auth within 5 minutes |
| Change limits, branding, notifications | — | — | — | yes | — | |
| Export the audit log | — | — | — | yes | — | |
| Promote or demote owners | — | — | — | yes + re-auth | — | The last owner can't be demoted |

## Rules worth testing

1. Every row with “—” for a capability is a 404, never 403, so it can't be used to probe IDs.
2. An owner session never grants a reveal, answer or manage capability. There is no admin bypass.
3. API tokens can't call `/server/*` or `/auth/*`, even when they belong to an owner.
4. In `DEMO=true`, nobody can sign in; the Server tab is a read-only tour backed by fixtures.
