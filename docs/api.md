# API contract

**This file is the master copy.** This repository (the backend) implements it; the React frontend, in a
separate repository, calls exactly these endpoints. The frontend holds the same contract twice more:
`web/src/types.ts` (as TypeScript types) and `web/src/mock/mock.ts` (a fake, in-browser version for
its demo mode, which is **not** the backend). A change here changes those two in the same session.

## General rules

- JSON in, JSON out. Times are ISO 8601 strings in UTC.
- Errors: HTTP status + `{ "code": "SOME_CODE", "message": "Readable text" }`.
- **Version check:** endpoints that take `?v=` return `304 Not Modified` (no body) when the
  restaurant's `queue_version` equals `v`. Otherwise `200` with the data, including the new `v`.
- **Staff actions return the full board** (same shape as `GET /api/staff/board`), so the acting
  screen updates at once without a second request.
- Staff endpoints need the session cookie from login. Without it: `401 { code: "NOT_LOGGED_IN" }`.
- Write requests that create something carry an `idempotencyKey` (a random string made by the page).
- **All requests arrive through CloudFront.** POST, PATCH and DELETE carry the header
  `x-amz-content-sha256` (the SHA-256 of the body, hex), because CloudFront's Origin Access Control
  signs requests to the Lambda Function URL but does not hash bodies. The pages add it (`web/src/lib/api.ts`).

## Pages

One React app (`web/`), served by CloudFront from S3. These paths are React Router routes: any path
that is not a file returns `index.html`, and the app shows the page.

| Path | Page component |
|---|---|
| `/` | `Home` |
| `/staff/login` | `Login` |
| `/staff` | `board/Board` |
| `/staff/setup` | `Setup` |
| `/staff/summary` | `Summary` |
| `/display/:code` | `Display` (waiting-area screen; the secret code in the link is the access, no login) |
| `/j/:restaurantId/:window/:sig` | `Join` |
| `/q/:token` | `Status` |
| `/sw.js` | The service worker file (served from the root, so its scope covers `/q/`) |

## Staff

### `POST /api/staff/login`
Body `{ restaurantId, pin }` → `204` and a session cookie (`HttpOnly; Secure; SameSite=Lax`).
Wrong PIN → `401 { code: "BAD_PIN" }`. Add a rate limit (Day 49).

### `POST /api/staff/logout` → `204`

### `GET /api/staff/board?v=41`
`304`, or:
```json
{
  "v": 42,
  "now": "2026-10-10T14:05:00Z",
  "refreshSec": 10,
  "restaurant": { "id": "r1", "name": "Demo Mess", "holdMinutes": 3, "longWaitWarnMin": 20, "occupiedReminderMin": 50, "typicalStayMin": 40 },
  "tables": [
    { "id": "t1", "label": "T1", "seats": 2, "state": "free", "stateSince": "…",
      "group": null, "heldUntil": null,
      "suggestion": { "groupId": "p6", "ticket": "A-6", "name": "Priya", "size": 2 } },
    { "id": "t2", "label": "T2", "seats": 4, "state": "held", "stateSince": "…",
      "group": { "id": "p7", "ticket": "A-7", "name": "Kumar", "size": 4 },
      "heldUntil": "2026-10-10T14:07:41Z", "suggestion": null }
  ],
  "queue": [
    { "id": "p5", "ticket": "A-5", "name": "Ravi", "size": 6, "phone": "+919800000000",
      "joinedAt": "…", "source": "qr", "verified": true, "warn": true }
  ]
}
```
- `state`: `free | held | occupied | cleaning`.
- `suggestion` is set only on free tables (the allocation rule, design.md section 8). One group is
  suggested for at most one table.
- `queue` holds only `waiting` groups, oldest first. `warn` = waited more than `longWaitWarnMin`
  and no free table fits.

### `GET /api/staff/display-link` → `{ "url": "/display/d-8f3k…" }`
The link for the waiting-area screen. Made on first use, then the same each time.
### `POST /api/staff/display-link/rotate` → `{ "url": "/display/<new code>" }`
Makes a new code. The old link stops working at once (the screen then gets `404 DISPLAY_LINK_INVALID`).

### `GET /api/display/:code?v=41`
For the waiting-area screen (`/display/:code`). **No login and no cookie**: the long random code
(at least 128 bits) in the link is the access, like a guest's ticket token. The response is
small: **no names and no phone numbers**, only tickets and table labels (privacy), so a leaked link
shows what the TV already shows. Unknown or replaced code: `404 { code: "DISPLAY_LINK_INVALID" }`.
`304`, or:
```json
{ "v": 42, "refreshSec": 10, "restaurantName": "Demo Mess",
  "called": [ { "ticket": "A-7", "tableLabel": "T2", "heldUntil": "2026-10-10T14:07:41Z" } ],
  "waitingCount": 5, "nextUp": ["A-8", "A-9", "A-10", "A-11"] }
```
- `called` = tables in state `held`, oldest first. A group leaves the list when it is seated,
  marked no-show, or leaves. `nextUp` = the first (at most 4) waiting tickets, in queue order.

### Table actions → board
| Endpoint | Body | Transition |
|---|---|---|
| `POST /api/staff/tables/:id/call` | `{ groupId, overrideReason? }` | free → held, group waiting → called |
| `POST /api/staff/tables/:id/seat` | — | held → occupied, group called → seated |
| `POST /api/staff/tables/:id/no-show` | — | held → free, group called → no_show |
| `POST /api/staff/tables/:id/left` | — | occupied → cleaning, group seated → (ended) |
| `POST /api/staff/tables/:id/free` | — | cleaning → free |

`overrideReason` is required when `groupId` is not the suggested group.
A transition from the wrong state → `409 { code: "STATE_CHANGED", message: "T2 was just assigned." }`.

### Group actions → board
| Endpoint | Body |
|---|---|
| `POST /api/staff/groups` | `{ name, phone, size, idempotencyKey }` (walk-in, `source = staff`) |
| `PATCH /api/staff/groups/:id` | `{ size }` |
| `POST /api/staff/groups/:id/remove` | — |
| `POST /api/staff/groups/:id/confirm` | — (marks a printed-QR join as verified) |

Phone already in an active queue → `409 { code: "ALREADY_IN_QUEUE" }`.

### `POST /api/staff/groups/:id/reclaim` → `{ "url": "/q/<new token>" }`
Creates a new token for the group (the old one stops working) and returns its status URL.

### `GET /api/staff/qr` → `{ "url": "/j/r1/9634512/ab12…", "expiresAt": "…" }`
The signed join URL for the current 3-minute window.

### Setup
| Endpoint | Body / result |
|---|---|
| `GET /api/staff/setup` | `{ restaurant: {…settings}, tables: [{ id, label, seats, combineSet }] }` |
| `POST /api/staff/setup/tables` | `{ label, seats, combineSet?, idempotencyKey }` → setup. The same key again returns the setup without a second table |
| `PATCH /api/staff/setup/tables/:id` | `{ label?, seats?, combineSet? }` → setup |
| `DELETE /api/staff/setup/tables/:id` | → setup. Only a free table: else `409 { code: "TABLE_IN_USE" }` |
| `PATCH /api/staff/setup/settings` | `{ name?, holdMinutes?, longWaitWarnMin?, occupiedReminderMin?, typicalStayMin?, preferGoodFit? }` → setup. `typicalStayMin`: 5 to 240, default 40, the starting value of the wait estimate (design.md section 4) |

### `GET /api/staff/summary?day=2026-10-10`
```json
{ "day": "2026-10-10", "joined": 41, "seated": 35, "noShow": 2, "left": 3, "removed": 1,
  "avgWaitMin": 23, "overrides": 2,
  "byHour": [ { "hour": 19, "joined": 12, "avgWaitMin": 31 } ] }
```

## Guest

### `GET /api/join/:restaurantId/:window/:sig`
`200 { restaurantName, whatsappUrl }`, or `410 { code: "QR_EXPIRED" }`, or `400 { code: "QR_INVALID" }`.
`whatsappUrl` is a `wa.me` link with the join message already typed, for example
`https://wa.me/91XXXXXXXXXX?text=JOIN%20r1%209634512.ab12…`, or `null` when the restaurant has no
WhatsApp channel (the page then shows the form at once). The page shows two choices: *Join on
WhatsApp* (opens `whatsappUrl`) and *Join here* (the form below). See "WhatsApp channel".

### `POST /api/join/:restaurantId/:window/:sig`
Body `{ name, phone, size, idempotencyKey }` →
`201 { "ticket": "A-17", "statusUrl": "/q/<token>" }`.
Errors: `409 ALREADY_IN_QUEUE`, `410 QR_EXPIRED`, `400 BAD_INPUT`.
`phone` (here and in a walk-in): drop every non-digit, then drop a leading `0` from 11 digits. 10 digits
→ `+91` + digits; 12 digits starting `91` → `+` + digits; anything else → `400 BAD_INPUT`.
The same `idempotencyKey` again returns the same `201` body.

### `GET /api/q/:token/status?v=41`
`304`, or:
```json
{ "v": 42, "restaurantName": "Demo Mess", "ticket": "A-17", "status": "waiting",
  "position": 3, "etaMin": 15, "heldUntil": null, "tableLabel": null, "nextRefreshSec": 60 }
```
`status`: `waiting | called | seated | no_show | left | removed`.
When `called`: `heldUntil` and `tableLabel` are set. Unknown token → `404 { code: "NOT_FOUND" }`.

### `POST /api/q/:token/leave` → `{ "status": "left" }`
Only from `waiting` or `called`; else `409 STATE_CHANGED`.

### Push
- `GET /api/push/key` → `{ "publicKey": "<VAPID public key, base64url>" }`
- `POST /api/q/:token/push` body `{ subscription }` (the `PushSubscription` JSON) → `204`

Push message payload (what the sender sends, and `web/sw.js` shows):
`{ "title": "…", "body": "…", "url": "/q/<token>", "tag": "position|called|expired" }`

## WhatsApp channel

Meta calls these two endpoints. The pages never call them. They live on a **separate Lambda with its
own public Function URL**, not behind CloudFront, because Meta cannot send `x-amz-content-sha256`
(see `design.md` sections 3 and 15).

### `GET /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
`200` with the `hub.challenge` text when the verify token matches, else `403`.

### `POST /api/whatsapp/webhook`
Meta's event: incoming messages and delivery statuses. Header `x-hub-signature-256: sha256=<hex>`,
the HMAC-SHA256 of the raw body with the app secret. Check it first and compare in constant time;
a bad signature gets `401` and touches nothing. Otherwise answer `200` at once. Handle every
message once, keyed by its message id (`wamid`).

What the server does with an incoming message from number `wa_id`:

| Message | Result |
|---|---|
| `JOIN <restaurantId> <window>.<sig>` | Same checks as `GET /api/join/...`. Valid: ask for the group size (list 1–10). Invalid or old: reply that the code expired. |
| A number, or a list answer | Create the group (`source: "whatsapp"`, `verified: true`, the phone is `wa_id`). Reply with the ticket, the position, the wait, and the status link `/q/<token>`. Already in a queue: say so, with the link. |
| `STATUS` | Reply with the current position and wait. |
| `LEAVE` | The same action as `POST /api/q/:token/leave`. |
| `STOP` | Set `opted_out`. Send nothing more. |

Messages the server sends to the guest (plain text, inside the 24-hour window):
`ticket` (after joining), `position` ("You are 3rd. About 15 minutes."),
`called` ("Your table is ready. Please come to the desk within 3 minutes. Ticket A-17, table T3."),
`expired` ("We called you, but could not find you. Please speak to the staff at the desk.").
Each is sent once per group: `notifications_sent (group_id, milestone, channel)`.
