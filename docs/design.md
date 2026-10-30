# Waitlist — backend design

The design decisions for this backend (decided 6–9 Oct 2026, with later additions as dated). This file
is the **master copy** of the backend design; `docs/api.md` is the contract. The React frontend lives
in a separate repository and calls exactly the endpoints in `docs/api.md`. Section numbers are stable:
code comments cite them. Section 14 (open product questions) is kept outside this repository.

## 1. The problem

Busy street restaurants in Coimbatore, mostly on weekend evenings. Up to 10–15 groups wait at one
time. Waits are 30–40 minutes at famous places, about 10 minutes at small ones. Staff write the
name and group size on paper. When a table frees, they read the list from the top and take the
first group that fits.

## 2. Scope

| Step | What | Status |
|---|---|---|
| 1 | Staff tool for one restaurant. Replaces the paper list. | **Build now** |
| 2 | Guests join that restaurant's queue by QR code, **only at the restaurant**. | **Build now** |
| 3 | Many restaurants; guest app across restaurants. | Later. The design is ready for it. |

Rules for Steps 1–2:
- A guest can join only by scanning the QR code at the restaurant. No remote join.
- A guest (one phone number) can be in **one active queue only**, across all restaurants.
- No OTP. The guest is in the restaurant and staff can see them.

## 3. Architecture

**Serverless, at (almost) zero rupees.** The workload is spiky (weekend evenings) and idle most of
the week. That is the Lambda fit. It must also be on the internet so real restaurants can use it.

**Repositories (decided 30 Oct).** This repository holds the Lambda handlers, `infra/template.yaml`
(SAM), the tests and the contract. The frontend (React + Vite + TypeScript, a single-page app) is a
separate repository.

| Part | Runs on | Why |
|---|---|---|
| Frontend | **React + Vite + TypeScript**, built to static files in a **private S3 bucket**, served by **CloudFront** | The industry pattern for a single-page app. CloudFront caches near the user (edge locations in India). |
| API | One Lambda (arm64), with a **Function URL** (no API Gateway), **behind CloudFront** | Short requests only. Free at this volume. arm64 uses less energy. |
| Database | **Neon Postgres** (free tier, pooled connection string) | Transactions and conditional updates decide every race. |
| Push sender | Lambda on an **SQS standard queue** | Event-driven. FIFO is not needed: each milestone push is idempotent. **Honest reason (9 Oct):** at Steps 1–2 the API could send the 1–2 pushes itself. SQS is kept to separate the slow, unreliable push service from the staff's tap, to get retries and a dead-letter queue, and for practice. At Step 3 (many pushes per change) it becomes necessary. |
| Outbox sweeper | Lambda on an **EventBridge schedule**, every minute | Safety net for events that the fast path did not publish. |
| Integrity job | Lambda on a schedule | Checks the invariants (section 9). Reports, never auto-corrects. |
| Push delivery | **Web Push** with VAPID keys, through the browser's push service | Free. No SNS: SNS push is for native apps. Works on Android Chrome; on iPhone only from the Home Screen, so iPhone guests use WhatsApp (section 15). |
| WhatsApp webhook | A **second Lambda** with its own public Function URL (`AuthType NONE`), **not** behind CloudFront | Meta cannot send `x-amz-content-sha256`, so a request from Meta cannot pass CloudFront's signing. The `x-hub-signature-256` check is the protection (section 15). |
| WhatsApp sender | Lambda on the same SQS queue | Sends the milestone messages to guests who joined on WhatsApp. Idempotent, like the push sender. |

Local development: the same handlers run behind a small `node:http` server, against local Postgres.
`localhost` is a secure context, so the service worker and push work locally.

**How a request is served** (one address, so no CORS and a simple session cookie):

```
Phone ─HTTPS─► CloudFront (d123.cloudfront.net)
                 ├─ /api/*    → origin: API Lambda Function URL (AuthType AWS_IAM, signed by
                 │              CloudFront Origin Access Control: nobody can skip CloudFront)
                 └─ any other → origin: private S3 bucket (Origin Access Control); a path that is
                                not a file (/staff, /q/abc) gets index.html, and the frontend's
                                router shows the page
```

- **Body hash:** Origin Access Control signs requests to the Function URL but does not hash request
  bodies. The browser sends `x-amz-content-sha256` on POST, PATCH and DELETE.
- **Backend deploy:** `sam build` + `sam deploy` (the Lambdas, the queue, the schedules, the bucket and
  the distribution are one CloudFormation stack).
- No custom domain for now: `d123.cloudfront.net` is free, and the QR code hides it.

**Compatibility rules (version skew).** A canary deploy runs the old and the new Lambda version at the
same time, and phones keep old pages open for hours. So two versions of the code always meet. There is
no `/v1/` in the URLs: we own the only client, so we keep every change compatible instead of numbering
the API.

1. **Add before you remove (expand, then contract).** Deploy 1 adds the new field or column and the
   code accepts both the old and the new form. Deploy 2 (the frontend) starts using the new one.
   Deploy 3 removes the old one, only after no old page can still be open (see rule 4).
2. **API responses only grow.** A new field is fine. Never rename or remove a field, or change what
   it means, in the same deploy that stops using it. The frontend ignores fields it does not know;
   the backend accepts requests with fields missing, and uses a default.
3. **Database changes follow rule 1.** Never rename or drop a column in one step. A migration must
   work with the old code and the new code, because both run during the canary.
4. **Deploy order: API first, then the frontend.** The frontend switches for everyone at once, but
   the API shifts slowly. The frontend's old files stay available for 30 days, so a page that is still
   open keeps working. Remove an old field only after those 30 days.
5. **SQS messages carry `"version": 1`.** A message can wait in the queue past a deploy, so the new
   sender reads old messages and the old sender may read new ones. Readers ignore unknown fields and
   treat a missing field as the default. A new shape gets a new `version` number, and the reader
   supports the old and the new one until the queue is drained. The queue is **standard, not FIFO**:
   order does not matter, because each push is idempotent (`notifications_sent`).
6. **The push payload (`PushPayload`) follows rule 2.** The service worker in an old tab runs old code.
7. **Test it:** deploy while k6 sends a steady flow, and check that no request fails and no message is lost.

## 4. Live updates — "pull on view, push on milestone"

The browser cannot know when the queue changes. Only the server knows. So:

**Guest page**
- **Auto refresh while the page is open:** every 60 s, only while the page is visible
  (Page Visibility API). A hidden page sends nothing.
- **Version check:** `GET /api/q/:token/status?v=41`. If the restaurant's `queue_version` is still
  41, the reply is `304 Not Modified` with no body and no queue read. Else `200` with
  `{ v, ticket, position, etaMin, status, nextRefreshSec }`.
- The server sets `nextRefreshSec`, so it can slow everyone down on a busy night.
- When a push arrives while the page is open, the service worker tells the page to refresh at once.
- The page shows "Updated N minutes ago".
- **The estimate (decided 26 Oct).** The page shows a **range** ("40–60 min", ±20% rounded to 5), and the
  place in line as a fact ("5th in line"). It never says "you are next": groups are called by table
  size (section 8), so a group of 5 waits while a free 2-seat table goes to a smaller group behind it.
  How the server computes `etaMin`:
  1. **From day one (no history):** a restaurant setting, "typical stay, minutes" (default 40). Run the
     allocation rule forward over the queue, using only the tables that fit your group. Each table's
     minutes until free (`state_since` is already stored):
     - free: 0; cleaning: about 5;
     - occupied: typical stay − minutes already seated, never below 5 (a table past its typical stay is not
       "free now");
     - held: a full stay (the called group is about to sit).
     Each group ahead takes the table that frees first, and that table is busy again for a full stay. Your
     `etaMin` is the earliest free time left after the groups ahead have taken theirs.
     Case: five 4-seat tables seated 25, 20, 10, 5 and 0 minutes ago, stay 40 → free in 15, 20, 30, 35, 40.
     Nobody ahead: 15 min. Five groups ahead: they take those five, which are busy again at 55, 60, 70, 75,
     80, so you wait 55. The crude rule (groups ahead + 1) × stay ÷ tables = 48 is only a fallback.
  2. **With history:** the typical stay comes from `seated_at` and `ended_at` by table size and
     hour, instead of the one default.
  3. **Later:** the server sends the range itself, from the spread of real stays (a contract change in
     `docs/api.md`).

**Push at milestones (Web Push)**
- "You are 3rd in line. About N minutes."
- "Your table is ready. Please come to the desk within 3 minutes."
- Ask for permission **after** the guest taps Join, with our own screen first. Never on page load.

**Fallbacks.** Push is best effort: a guest can block it, iPhone Safari supports it only from the
home screen (so iPhone guests are served through WhatsApp, section 15), and battery savers delay it.
So **the final call always has three paths**: the push, the ticket number called aloud, and a staff
phone call if needed. The 3-minute hold protects the table.

**Staff board:** checks every 10 s while visible, with the same version check. A staff action
returns the new board in its response, so the acting screen updates at once.

**Green KPI:** requests per seated guest. Target about 10 (fixed 10 s polling ≈ 180).

**Why not WebSocket:** at 1,000 restaurants, version-checked polling costs about the same as
API Gateway WebSocket (~$10–16 vs ~$22 a month), and WebSocket still cannot reach a locked phone.
Switch to push only when a feature needs sub-second updates (for example several staff devices on
one live table map) or when measured cost says so. Every change already emits one `queue_changed`
event, so a push channel can be added later without changing the core.

## 5. Joining — the rotating QR code

- The staff screen shows a QR code that changes every 3 minutes:
  `/j/<restaurant_id>/<window>/<sig>`, where `window = floor(now / 180 s)` and
  `sig = HMAC(secret, restaurant_id + window)`. The server accepts the current and the previous window.
- A printed QR code is a fallback. Joins from it are marked `verified = false`, and staff confirm
  them at the desk.
- **Two ways in (decided 24 Oct).** The QR page shows *Join on WhatsApp* (opens a chat with the join
  message typed; the guest taps Send) and *Join here* (the form). The form path keeps working for guests
  without WhatsApp and for the expiry check. Details: section 15.
- On the form path the guest enters name, phone number, and group size.
- The join request carries an **idempotency key** from the page, so a double tap creates one entry.
- The server returns a **ticket number** (for example `A-17`, per restaurant per day) and a
  **long random token**. The status page is `/q/<token>`. The token is the proof of identity
  (a capability URL). The database stores only a **hash** of the token.
- The phone number is used only for "one active queue" and for staff to call the guest.
  **Status is never shown by phone number.**
- Lost browser: the guest tells staff the ticket or name; staff show a "reclaim" QR for that entry.

## 6. Data model (Postgres)

```
restaurants      id, name, timezone, queue_version bigint, hold_minutes (3),
                 long_wait_warn_min (20), prefer_good_fit bool (false),
                 typical_stay_min (40, 5–240),
                 staff_pin_hash, qr_secret, created_at
dining_tables    id, restaurant_id, label, seats (> 0), combine_set null,
                 state (free | held | occupied | cleaning), group_id null,
                 held_until null, state_since, updated_at
                 UNIQUE (restaurant_id, label)
groups          id, restaurant_id, ticket, name, phone_e164, size (1–20),
                 status (waiting | called | seated | no_show | left | removed),
                 source (qr | qr_printed | staff | whatsapp), verified bool,
                 token_hash, idempotency_key, table_id null,
                 joined_at, called_at, seated_at, ended_at,
                 checked_in_at null            -- for Step 3 remote join
                 UNIQUE (restaurant_id, idempotency_key)
                 UNIQUE (phone_e164) WHERE status IN ('waiting','called')   -- one active queue
                 INDEX (restaurant_id, status, joined_at)
daily_counters   restaurant_id, day, last_ticket          -- ticket numbers
outbox           id, restaurant_id, type, payload jsonb, created_at, published_at null
push_subscriptions  group_id PK, endpoint, p256dh, auth, created_at   -- deleted when the group ends
wa_chats            wa_id PK (the guest's number), restaurant_id, group_id null, pending_until null,
                    last_inbound_at, opted_out bool   -- null group_id while we wait for the size answer
wa_events           wamid PK, received_at             -- webhook idempotency; delete after 7 days
notifications_sent  group_id, milestone, channel (webpush | whatsapp), sent_at,
                    PK (group_id, milestone, channel)  -- idempotent delivery
allocation_events   id, restaurant_id, table_id, group_id, suggested_group_id,
                    override_reason null, actor, at       -- audit + owner summary
```

`restaurant_id` is on every row and in every query, from day one (Step 3 readiness and tenancy).
`typical_stay_min` is the owner's "Typical stay" in Setup (added 28 Oct), the starting value of the
estimate in section 4: `INT NOT NULL DEFAULT 40 CHECK (typical_stay_min BETWEEN 5 AND 240)`.

## 7. The staff web app

- **Setup:** tables with seats; which tables can be pushed together.
- **Board:** tables with their state, and the queue (ticket, name, size, time waited).
- **Table states:** Free → Held (system, on Call) → Occupied (Seated) → Cleaning (Guests left) → Free.
- **When a table is free:** the app suggests a group. Staff tap **Call**, or pick another group
  (the override reason is logged). Then **Seated** or **No-show**.
- **Walk-in by hand:** for a guest with no smartphone (`source = staff`).
- Edit a group's size, remove a group, show the rotating QR.
- **Reminder (later):** a small note on the table tile, such as "50 min, still here?", when a table has
  been occupied far past the typical stay. Staff forget "Guests left", and the table then stays occupied.
  The estimate does not depend on it (section 4 floors an overdue table at 5 minutes).
- **End-of-day summary:** served, average wait, no-shows, left, overrides.
- **Login:** one staff PIN per restaurant (stored as a hash), then a session cookie.
- **CSRF (three layers).** A browser attaches the cookie to any request to our address, even one started
  by another website, so the cookie alone cannot prove the staff member meant the action.
  (1) The cookie is `SameSite=Lax`, so browsers leave it off cross-site POSTs.
  (2) The frontend sends JSON and a custom header, which makes a cross-site request need a CORS
  preflight, and we send no CORS headers, so it is blocked. This one is a side effect of how the
  frontend is written, not a server rule.
  (3) The server checks `Origin` on every POST, PATCH and DELETE: if `Origin` is present it must equal
  `ALLOWED_ORIGIN`; if it is absent, `Sec-Fetch-Site` must be `same-origin`; otherwise `403 BAD_ORIGIN`.
  A missing header is a failure, never a pass. GET is never checked, because no GET changes state.
  CloudFront drops `Origin` by default, so the `/api/*` behaviour needs an origin request policy that
  forwards `Origin` and `Sec-Fetch-Site`, with caching off. `ALLOWED_ORIGIN` is a SAM parameter set on
  the second deploy (the Lambda and the CloudFront domain depend on each other); locally it is
  `http://localhost:5173`. Browsers add these headers themselves.

## 8. The allocation rule

Matches what staff do on paper: read the list from the top and take the first group that fits.

When a table with **C** seats becomes free (if several are free, fill the **smallest** first, and
suggest each group for at most one table):
1. Consider groups with status `waiting` and size ≤ C, oldest first.
2. **Default:** suggest the first one (first fit in queue order).
3. **Optional setting `prefer_good_fit`:** prefer the oldest group with size C or C − 1. Off by
   default; switch it on only if data shows wasted seats.
4. **No starvation:** if a group that did not fit has waited more than `long_wait_warn_min`,
   warn staff: hold the next table that fits, or push two tables together.
5. Staff can always override. Every override is logged with its reason.

It is a rule, not AI: same input → same answer, explainable to a guest, under 1 ms, free, testable.
**AI is used to predict, not to decide:** the wait-time estimate (start with averages from the
restaurant's own history; default 40 min until data exists) and the owner's insight questions.

## 9. Concurrency — the core story

Two staff phones tap **Call** on the same table at the same moment. One transaction:

```sql
UPDATE dining_tables
SET state = 'held', group_id = $1, held_until = now() + make_interval(mins => $4)
WHERE id = $2 AND restaurant_id = $3 AND state = 'free';
-- 0 rows → "T2 was just assigned" (the other phone won)

UPDATE groups SET status = 'called', called_at = now(), table_id = $2
WHERE id = $1 AND restaurant_id = $3 AND status = 'waiting';
-- 0 rows → roll back the table update

UPDATE restaurants SET queue_version = queue_version + 1 WHERE id = $3;
INSERT INTO outbox (...) VALUES (... 'group_called' ...);
```

A compare-and-swap in SQL: no lock held across requests, so it fits Lambda.

**Invariants (checked by tests and by the integrity job):**
- A table holds at most one group; a held or occupied table has a group.
- A group is in exactly one status; a seated group has a table.
- A phone has at most one active entry (also enforced by the partial unique index).
- No hold is older than `hold_minutes` + 1 minute without being resolved.
- `queue_version` changes on every state change.

## 10. Hold and release (the saga)

Call → table Held for 3 minutes → guest arrives → **Seated**. If the guest does not come:
**No-show** (staff tap, or the hold expires) → the table returns to Free → the next suggestion.
The race "staff tap Seated at second 179 while the expiry runs" is solved the same way: each
transition is a conditional update on the current state, and the loser gets 0 rows.

## 11. Events

Every state change writes one `outbox` row in the same transaction and bumps `queue_version`.
Fast path: after commit, the API sends the event to SQS and sets `published_at`.
Safety net: the sweeper republishes rows still unpublished after 30 s.
The push sender is an idempotent consumer: `notifications_sent` makes each milestone push happen once.
The WhatsApp sender reads the same events and is idempotent in the same way (the `channel` column).

## 12. Privacy (India DPDP Act 2023)

- Collect only name, phone, and group size.
- Delete push subscriptions when the group ends. Delete or mask phone numbers after a short
  retention period (decide the number; for example 30 days, for the owner's statistics).
- No SMS in Steps 1–2 (SMS needs DLT registration in India, and it costs money).
- A WhatsApp number is personal data: stored as `phone_e164` with the same retention rule. The guest's
  own first message is the opt-in. Honour `STOP` (`wa_chats.opted_out`). Messages never contain
  other guests' names. WhatsApp itself keeps the message text; we keep only the number and the ticket.

## 13. Cost — zero rupees in AWS, with one written exception

Lambda, SQS, EventBridge: always-free at this volume (1 M requests and 400,000 GB-seconds a month
for Lambda). **CloudFront: always-free** up to 1 TB out and 10 M requests a month; S3 → CloudFront
and CloudFront → Lambda transfer is free; 1,000 invalidation paths a month are free. Neon free tier.
Web Push free. GitHub Actions free.

**The one exception (approved 9 Oct): S3.** S3 storage and requests are free only in a new account's
free period. The React build (~1 MB) and the SAM upload packages cost a fraction of a cent a month:
**less than ₹1 a month in total.** A lifecycle rule deletes old SAM packages after one day.

**Never create:** a NAT gateway, ALB, RDS, EC2, a public IPv4 address, an interface endpoint, a
customer-managed KMS key, or API Gateway. WhatsApp messages are the one running cost outside AWS, per
restaurant; the demo uses Meta's free test number.

One restaurant ≈ 150,000 requests a month with fixed polling, far fewer with this design.

## 15. WhatsApp channel (decided 24 Oct)

**Why.** Most guests use an iPhone. A locked page gets no updates (section 4), and Web Push on an
iPhone works only after "Add to Home Screen", which guests will not do. WhatsApp reaches a locked
iPhone, and the guest's own message proves their phone number. Web Push stays for Android. Making
guests keep the screen on (a wake lock) was tried and rejected: a bad flow for a 40-minute wait.

**The flow**
1. The guest scans the rotating QR code. The page `/j/...` shows *Join on WhatsApp* and *Join here*
   (the form).
2. *Join on WhatsApp* opens a chat with `JOIN <restaurant_id> <window>.<sig>` typed. The guest taps Send.
3. Meta calls our webhook. We check the signature, then the same HMAC and time window as section 5.
   A bad or old code gets "This code has expired. Please scan the code on the screen at the desk."
4. We save `wa_chats` (the guest's number, `pending_until` = now + 10 min) and ask for the group
   size with a list message (1–10). A typed number also works.
5. On the size answer we create the group in one transaction (section 9): name = the WhatsApp profile
   name, `phone_e164` = the sender's number, `source = whatsapp`, `verified = true`. The idempotency key
   is the message id. We reply: ticket, groups ahead, wait, the status link `/q/<token>`, and "Reply LEAVE to leave".
6. Milestone messages (position 3 or less; table ready, with the 3-minute hold; hold expired) are plain
   text inside the 24-hour window, so no template is needed. A wait never runs 24 hours.
7. Commands: `STATUS` (current position), `LEAVE` (the same conditional update as the leave endpoint),
   `STOP` (set `opted_out`, send nothing more).

**The status page stays.** It is the fallback for guests without WhatsApp, it is linked in the first
message for guests who like to watch, and the waiting-area screen (`/display/:code`, opened from a
secret link, no login) and the staff board are unchanged.

**The webhook**
- **Separate Lambda, public Function URL.** Meta cannot send `x-amz-content-sha256`, so its POST cannot
  pass CloudFront's Origin Access Control (section 3). The signature is the protection.
- **Verify before anything else:** `GET` returns the `hub.challenge` when `hub.verify_token` matches.
  `POST` checks `x-hub-signature-256` (HMAC-SHA256 of the raw body with the app secret, compared in
  constant time) before the body is parsed. A bad signature gets `401`, with no database access.
- **Answer `200` fast.** Meta retries failed calls for days, so every handler is idempotent on `wamid`
  (`wa_events`). Delivery-status events are logged. A failed delivery is the cue for a staff phone call.
- **Cap the cost.** Reserved concurrency on this Lambda, because the URL is public.

**Demo:** Meta's free test number sends to a few allowlisted phones, with no business verification
and no payment method. The webhook needs a public HTTPS address, so a real WhatsApp demo needs the
deployed backend (or a tunnel to a local server).

**Done when:** a locked iPhone gets "Your table is ready" after a staff Call, from a join made by
scanning the QR code, and the integrity job finds nothing wrong.
