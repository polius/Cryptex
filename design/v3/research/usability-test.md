# Usability test plan (prototype, before the Phase 2 UI freeze)

**Goal:** confirm that first-time senders and recipients complete the core flows without help, and that recipients understand what “opens once” and “sealed” mean before they press Reveal.

**When:** in parallel with Phase 1 (weeks 2–3). Findings feed the Phase 2 issues CX-20, CX-30 and CX-51. **It doesn't block starting any phase.**

**Who:** 5 people. 2 senders who share credentials at work (engineer, IT admin), 3 recipients who don't (finance, sales, a contractor). At least 3 sessions on a phone.

**Setup:** the prototype pages (`proto/*.html`) linked in order on a shared screen or phone, 30 minutes each, recorded with consent, think-aloud. The moderator never explains the product.

## Tasks

| # | Task (read aloud) | Screens | Success | Watch for |
|---|---|---|---|---|
| 1 | “Send this database login to a colleague so it can only be opened once.” | A1 → A2 → A5 | Reaches A5 and says where they'd paste the link | Do they notice the fields were detected? Do they look for options? |
| 2 | “Make sure only lisa@globex.example can open it, and that it lasts an hour.” | A3 | Picks the email option and 1 hour | Is “Change” found within 10 seconds? |
| 3 | (recipient) “You got this link from IT. Get the password.” | D1 → D4 | Presses Reveal and copies the password | Do they hesitate at “Opens once”? Can they explain what will happen? |
| 4 | (recipient) “You open the link again tomorrow.” | D5 | Explains it was already opened and what to do | Do they think the site is broken? |
| 5 | “Ask a vendor for their API keys.” | C1 → C2 | Creates the request link | Is the request mode found from the Send screen? |
| 6 | (vendor) “Answer this request.” | C3 → C4 | Sends the answer | Trust: do they recognize who's asking? |
| 7 | “Did your colleague open the login you sent this morning?” | B1 → B2 | Finds the status and time | Do they understand “Needs you”? |

## Measures

Task success (yes / with hesitation / no), time on task, and one sentence per participant on what “sealed” means. After the session: “How sure are you that only the right person saw it?” (1–5).

## Decision rules

- Any task failed by 2 or more people: redesign before CX-20/30/51 start.
- “Change” not found by 2 or more people in task 2: show the options panel open by default on desktop.
- Recipients unable to explain “opens once”: add one sentence above the Reveal button.
