# Email templates

All emails are sent from `SMTP_FROM`, in a plain layout: the operator's logo and name at the top, one paragraph, one button at most, and a footer with the public address. Every template has a plain-text part identical in wording. **No email contains a secret, its title, or a link that reveals anything.**

Variables: `{brand}`, `{host}`, `{sender}`, `{when}` (local time of the recipient of the email, with time zone), `{receipt_url}`.

---

## 1. Your link was opened (to the sender, when `notify` is on)

**Subject:** Your {brand} link was opened

> Your secure link {short_id} was opened {when}. It’s now deleted from the server.
>
> If you didn’t expect it to be opened yet, someone else may have the link. Change what you shared and send a new link.
>
> **[See the receipt]({receipt_url})**
>
> You get this because you chose “Tell me when it’s opened”.

`{short_id}` is the first 4 characters of the ID, e.g. `k7Qp…`. Titles stay out of email on purpose.

---

## 2. Your request was answered (to the requester, when `notify` is on)

**Subject:** Someone answered your {brand} request

> Your request {short_id} was answered {when}. Open Your links on the device you used to create it to reveal the answer.
>
> **[Open Your links]({host}/links)**
>
> The answer is kept until {kept_until}.

---

## 3. Verification code (to the allowed recipient)

**Subject:** {code} is your code for {brand}

> {sender} sent you something through {brand} that only you can open.
>
> Your code is **{code}**. It works for 10 minutes.
>
> If you weren’t expecting this, you can ignore this email; nothing will be opened.

The code is in the subject so it shows in notification previews. `{sender}` is the sender's display name when signed in, otherwise “Someone”.

---

## 4. Destroyed after too many tries (to the sender)

**Subject:** Your {brand} link was destroyed

> Someone with your link entered the wrong passphrase 5 times, so the secret was destroyed {when}. It was never revealed.
>
> If that wasn’t the person you sent it to, the link may have been shared further. Send a new link if it’s still needed.

---

## 5. Test email (from Server, Notifications)

**Subject:** Test email from {brand}

> Email is working for {host}. People can now choose “Tell me when it’s opened” and email-only links.
