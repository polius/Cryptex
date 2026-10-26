# Privacy notice (draft)

> **Draft for legal review.** Written to match how Cryptex 3.0 works. Each operator (the company running a server) adapts the bracketed parts and is the data controller for their instance. Shown at `/privacy`, linked from the footer and the demo banner.

## What this service is

[Acme] runs this Cryptex server at [vault.acme.com] so people can send and request secrets, such as passwords and files, through one-time links.

## What we can't see

Secrets are encrypted in your browser before they're uploaded. The key is in the part of the link after `#`, which browsers don't send to us. We can't read what you send, its title, its file names or who it's from, and neither can anyone who gets a copy of our database.

## What we store, and for how long

| Data | Why | Kept |
|---|---|---|
| Encrypted secret and its size | To deliver it | Until it's opened the allowed number of times, destroyed, or expires (at most [7 days]) |
| When it was created, opened or destroyed | So the sender can see what happened | [7 days] after the secret is gone |
| An allowed recipient's email address, encrypted | To send them a code, if the sender chose “only a specific email” | Deleted with the secret |
| Your name and email, if you sign in | To let you send and to show the sender's name to recipients | While your account exists |
| An audit log of events (never contents) | Security and accountability | [365 days] |
| A session cookie, if you sign in | To keep you signed in | 14 days |

We don't use analytics, advertising or third-party scripts, and we don't set cookies for people who only open links.

## IP addresses

Your IP address is used briefly to limit abuse (for example, too many attempts) and isn't stored with secrets or in the audit log. [Our hosting provider may keep standard access logs for [n] days.]

## A limit you should know about

Like every web-based encryption tool, this one relies on the code our server sends to your browser. If you need protection even from the people running this server, use the Cryptex command-line tool, which encrypts on your own computer.

## Public demo

If this is the public demo: don't send real secrets. Everything is deleted within an hour and the whole service is wiped every night.

## Contact

[privacy@acme.example] · [Company name, address] · [Data protection officer, if required]
