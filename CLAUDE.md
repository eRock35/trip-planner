# For Claude: this repo

Research, plan, and monitor upcoming trips — flights, hotels, Airbnbs — in
one place, with Claude helping via chat. When a trip is booked, "lock it in"
and it becomes a settled itinerary instead of an active research target.

The **GitHub repo is public** (Erik's explicit choice — it holds no secrets,
no PII, no credentials; those all live in Secret Manager and env vars). The
**deployed app** has a narrower gate than the repo's visibility implies —
see "Sign-in" below: anyone can browse it, but saving anything costs
Anthropic tokens, so that's login-gated.

## The core idea: one app, many trips

Unlike `santa-rosa-beach-trip` (a bespoke, hand-built app for one specific
trip), this app is generic and data-driven: every trip is a Firestore
document (`trips/<id>`), and the page renders any trip from that data. A new
trip never needs a new repo, a new Cloud Run service, or a new Firestore
database — it's just a new document. That was a deliberate choice: spinning
up new infrastructure per trip would need a live-infrastructure approval
from Erik every time; a Firestore write needs none. Keep it this way — don't
let a future "give each trip its own page" request turn into "give each trip
its own deploy."

**Locking in a trip** (`POST /api/trips/:id/lock`) is *just* a status flip
(`status: "planning" -> "locked"`, `lockedAt` set) — not a data migration,
not a new document, not a new anything. A locked trip:
- Drops out of `/api/cron/check-watches` (a booked trip isn't being shopped
  for anymore — see "Watches" below).
- Gets a "Locked in" badge instead of "Planning" in the trips list.
- Stays fully editable — chat, itinerary, notes all still work. Locking
  isn't a snapshot or a freeze; it's just "this one's decided."
- Can be unlocked (`POST /api/trips/:id/unlock`) if plans change.

If Erik ever wants a *specific* locked trip promoted to its own bespoke app
(styled and customized the way `santa-rosa-beach-trip` is), that's a
separate, explicit, manual step someone (Claude, working with him) does on
request — not something this app automates. Don't build that without being
asked; the whole point of the shared-app design is that most trips never
need it.

## Data model (Firestore)

- Firestore, **Native mode**, database `trip-planner` in `us-central1` (not
  `(default)` — see the same note in `santa-rosa-beach-trip`'s CLAUDE.md for
  why: that project's `(default)` database is legacy Datastore mode).
- `webauthn-credentials/<id>` — passkey public keys. Written by
  `accounts.js`, which carries a `uid` naming the account and an `rpID`
  naming the host it was registered on.

  **`auth.js` in this repo is dead code** — nothing requires it; `server.js`
  loads `accounts.js` only. It is the single-account module copied from
  `santa-rosa-beach-trip`, left behind when this app went multi-user. Safe to
  delete; don't extend it, and don't read it as describing how this app
  signs people in.

  The old "keep it in sync with `college-football-app`" instruction no longer
  holds either: that app's `auth.js` forked on 2026-09-20 when it gained
  per-email accounts and a research allowlist of its own. The three apps'
  auth is now independent by design, not by accident.
- `trips/<id>` — `{name, destination, dateRange, notes, status
  ("planning"|"locked"), days, createdAt, updatedAt, lockedAt}`. `days` is
  the itinerary once one exists — same shape as `santa-rosa-beach-trip`'s
  (`title`, `date` as an ISO string when known, `dateLabel`, `blocks` as
  `[time, plan]` pairs, `tip`).
  - `trips/<id>/messages/<auto>` — chat history: `{question, answer,
    proposedChange, askedAt, answeredAt}`.
  - `trips/<id>/watches/<auto>` — monitored listings: `{kind
    (flight|hotel|airbnb|other), label, criteria, url, intervalHours,
    lastCheckedAt, lastResult, history}`. `history` is capped at 20 entries.
- `control/watch-cron` — single doc, `{lastRunAt, checked}` from the most
  recent batch run.

## Sign-in: open registration, metered AI

**This app is multi-user.** Anyone can register (email + password, at least 10
characters); a passkey can be added afterwards from inside the app for Face ID.
Accounts live in `users/<uid>`, where `uid` is the base64url of the lowercased
email — deterministic, so `create()` fails on a duplicate rather than needing a
uniqueness index Firestore doesn't have.

The access model is Erik's explicit call, and the reason matters:

- **Everyone who signs up gets the free features immediately** — create trips,
  edit them, add and schedule watches, lock and unlock. None of that costs
  anything.
- **Anything that calls Claude is metered, not approved** — see "Spending is
  metered, not approved" below. It used to require `aiAccess === 'approved'`,
  granted by the admin by hand.

### Forgetting a password

There is **no email service on this project**, so a reset cannot arrive as a
link. Two doors instead, and the reason for each:

- **Passkey.** `POST /api/auth/password` takes the current password *or* a
  session proved by passkey. The session cookie carries `via`
  (`'password' | 'passkey'`) for exactly this; a passkey is at least as strong
  a proof as the password it is replacing. Without this door, anyone who
  forgets their password waits on the admin even though they can still prove
  who they are. A password-proved session gets no such shortcut — it must
  produce the current password, or a stolen session could take the account.
- **Admin.** `POST /api/auth/reset-request` flags the account
  (`resetRequestedAt`), the admin sees it in the same panel as AI-access
  requests, and `POST /api/admin/reset-password` issues a temporary password
  returned **exactly once** and never stored in the clear. It sets
  `mustChangePassword`, which the auth bar surfaces until they change it.

`reset-request` answers identically whether or not the account exists —
otherwise it tells a stranger which emails are registered.

The gap this leaves, deliberately: a user with no passkey who forgets their
password depends on the admin. That is the price of having no mail sender,
and it is the right trade at this size — adding one is a standing monthly
cost for a handful of users.

### Spending is metered, not approved (2026-09-21)

**This reverses the rule that used to sit here**, which said an Anthropic call
must never be behind `requireLogin` alone and had to go behind
`requireAiAccess`. That rule was right when it was written and is wrong now,
and the difference is worth being precise about rather than quietly dropping.

It was written when "ask Erik" was the *only* thing standing between a
stranger and Sonnet 5 with web search on Erik's key. Since then two controls
exist that did not:

- **`identity.requireBudget`** — every account has a dollar allowance
  (`FREE_ALLOWANCE_USD`, $2), every model call is priced and charged to it,
  and an exhausted one gets a 402 carrying a top-up link. A human approving
  people one at a time is a worse version of this: slower, and it never
  actually bounded anything.
- **`identity.requireDailyCap`** — a ceiling on what the **free tier** spends
  in a day, across everyone. **Deliberately switched off here**: the variable
  is unset, and that is the decision rather than an oversight.

  It was briefly $2/day, which was wrong in a way worth recording. The
  per-user free allowance is *also* $2, so the first person to use their whole
  trial consumed the entire day's free tier and the next signup that day was
  refused before their first answer — two numbers that happened to be equal
  turned the free tier into a lottery, invisibly. The per-user allowance is
  the real control; this exists only for the thing it cannot do, which is
  someone registering throwaway accounts to farm the free $2 repeatedly.

  If it is ever switched on, set `FREE_TIER_DAILY_CAP_USD` to a **multiple**
  of `FREE_ALLOWANCE_USD`, or it caps how many people may try the apps each
  day rather than capping the money.

So the gate on both call sites (trip chat, `runWatchCheck`) is now
`requireLogin, requireBudget, requireDailyCap`, and the cron sweep asks
`ownerAccount()` whether the owner has credit rather than whether the admin
approved them. **The replacement rule: never put an Anthropic call behind
`requireLogin` alone — it goes behind `requireBudget` AND `requireDailyCap`.**
The instinct the old rule encoded is still correct; only the mechanism moved.

When it is on, a ceiling meant to stop strangers draining the key must not
lock out the person paying for it, so everyone who pays — by the month, by
topping up, or by bringing their own key — is outside it in both directions:
their spend is not counted and they are not blocked.

### What the money buys (2026-09-21)

- **Browse anything** without an account. No app makes a model call for a
  signed-out visitor — DataViz's samples look like the exception and are not,
  because each carries a baked column mapping and serves with no model call at
  all.
- **Sign up free** and get `FREE_ALLOWANCE_USD` ($2) of AI, *once*, across
  every app on the domain — the ledger is `spentUsd` on the shared identity
  record, not per app.
- **Past that, the membership is the gate**, and it is a platform fee rather
  than a bundle of tokens: it buys the better model, the bigger search budget,
  and the right to put either money or your own key behind the apps. Credit is
  sold separately at what the calls actually cost; a key covers its own
  tokens. `paysPlatformFee()` in identity is the single definition, and
  `budgetFor`, `apiKeyFor`, the byok route and DataViz's own-data gate all ask
  it, so a lapsed membership cannot leave one of them still saying yes.
- **Stopping there is free and fine.** Someone who spends their $2 and never
  pays keeps every feature that is not a model call, for as long as they like,
  and costs essentially nothing to serve. There is no reason to push them off
  and no attempt to.

`accounts.requireAiAccess` still exists and is on no route. Do not put it back
in front of a model call.

`aiAccess` is still written and still shown in the admin panel, and it no
longer gates anything. Leaving the field costs nothing and removing it would
rewrite every existing record for no gain.

### The shared account can grant AI access here (2026-09-20)

This app kept its own `aiAccess` flag from when it was the only gate, and the
domain-wide admin panel grew a second one (`access['trip-planner']` on the
shared identity record). They never spoke, so **a grant made in the shared
panel did nothing here** — the visible symptom was the owner's own second
address being told to request permission for an app he runs, on an account
the dashboard already listed as having access.

`grantedByIdentity()` fixes the direction that matters: identity can say
**yes** — the owner flag, or a `trip-planner` grant — and this app's own
`aiAccess === 'approved'` still stands on its own. Identity deliberately
cannot say **no**, so nothing that worked before stops working.

`ownerMaySpend()` is the same question for the hourly watch sweep, which asks
by uid rather than by request. Without it a watch owned by someone the shared
panel approved would be skipped every hour with nothing saying why.

The admin is whichever account registers with the email in `ADMIN_EMAIL`. That
account starts approved and is the only one that can see `/api/admin/*` — which
returns **404**, not 403, to everyone else, so the admin surface isn't
advertised.

### Trips are no longer publicly browsable

The old single-account version let anyone view trips, on the reasoning that
reads cost nothing. That no longer holds: trips belong to a user now, so an
open GET would leak one person's trips to another. Every `/api/trips*` route
requires a session and goes through `loadOwnedTrip()`, which 404s (not 403s) on
someone else's trip so the API won't confirm an id exists.

`accounts.js` is this app's own auth module. **`auth.js` was deliberately left
alone** — it is shared verbatim with `santa-rosa-beach-trip` and
`college-football-app`, and both are still single-account. Don't fork it here;
this app outgrew it.

Needs a composite index on `trips`: `ownerId ASC, updatedAt DESC`.

### Credit is bought here, not in DataViz (2026-09-22)

Pressing "AI credit" used to be a link to `dataviz.…/?topup=1`, because DataViz
was the only service holding the Stripe keys. What it sold was never DataViz's
— the $5 membership covers every app and the balance spends in every app — so
the reader was landing in a chart app they were not using, styled like a
different product, to manage an account that has nothing to do with it.

The checkout routes live in the shared account module now and this app mounts
identity at `/api/auth`, so they are `GET /api/auth/billing`, `POST
/api/auth/billing/{membership,credit,portal}`. The sheet is this app's own;
only the money is shared. `success_url` is built from **this** app's origin, so
a purchase started here ends here (`?member=1`, `?credited=1`).

**The webhook is not here and must not be moved here.** Stripe delivers to one
endpoint — DataViz — and `STRIPE_WEBHOOK_SECRET` has no reason to exist on five
services to serve one of them. Only creating a checkout session spreads.

`?topup=1` opens the sheet, because identity's 402 link is relative when the
serving app can take the payment. When it cannot — no `STRIPE_SECRET_KEY`
mounted — the link and the sheet's `elsewhere` field both name a service that
can, so the button is never a dead end. That fallback is not what is live:
`stripe-secret-key` and `stripe-member-price` were bound to
`trip-planner-run@` on 2026-09-22 and both env vars are mounted, so this app
sells for itself. The fallback stays as the answer to a service booted without
them.

The key is a **restricted** Stripe key (`rk_live_`), which is what makes it
reasonable for five services to hold one. If it is ever replaced, replace it
with another restricted key.

**Nothing has been bought through it yet** — the live account had no Checkout
Session at all as of 2026-09-22 — so the key's *write* permission is unproven;
`/api/stripe/health` on DataViz only proves it can read a Price. The first
purchase is the test.

## Chat can draft or edit the itinerary

Same confirm-before-save shape as `santa-rosa-beach-trip`: `/api/trips/:id/chat`
gives Claude `web_search` plus a `propose_schedule_change` tool. When asked
to plan or change the day-by-day itinerary, the model proposes the complete
`days` array with a one-line summary; the frontend renders it as an
Apply/Discard card, and only `POST /api/trips/:id/schedule/apply` (fired by
the user's own tap) actually saves it. Keep this shape if you touch this
flow — deliberate, not something to let an LLM silently rewrite.

The proposed `days` array is **validated before it is offered**, not only on
apply (`schedule.js`, a copy of `santa-rosa-beach-trip`'s minus the seed):
it comes out of a model, so a day with no `blocks` or a date that is not a
date would render as a broken Itinerary tab needing a deploy to fix. An Apply
button that leads to a 400 is worse than a proposal never made. `apply`
returns the saved days and the page draws those rather than the proposal, so
what you see is what a reload will show.

Runs on `claude-sonnet-5` (tool use + web search).

### What became of a proposal is stored, not remembered (2026-09-23)

Reported as "after applying to itinerary it stays". Apply saved the
itinerary, but "applied" was a flag in the page's memory, so the next load of
the chat from the server — reopening the trip, coming back to the app — drew
the Apply card again with live buttons. Discard had the same flaw.

It was worse than untidy. A proposal is a **complete replacement** `days`
array, so pressing a resurrected card would put back a plan from before any
later change. The vacation app had the identical trap (see its CLAUDE.md,
"Two phones, one plan").

- `POST /schedule/apply` takes `messageId` and writes `changeState:
  'applied'` on that message; `POST /messages/:mid/discard` writes
  `'discarded'`. The page draws a decided card as its outcome, from the
  server's field, so it survives any reload.
- Each proposal carries `basedOn` — the trip's **`daysUpdatedAt`**, not
  `updatedAt`, because every chat turn, rename and lock moves `updatedAt` and a
  guard keyed to it would refuse proposals for nothing. Apply sets
  `daysUpdatedAt`; a proposal whose `basedOn` no longer matches is refused with
  **409**, the current itinerary attached, and the message marked `'stale'`.
- `basedOn` and `messageId` are optional, so cards from before this still
  apply as they always did.

`test/proposal-state.js` holds it: applied survives a reload, a proposal made
before another was applied is refused and the first survives, discard is
remembered, a lock or rename does not make a suggestion stale, and nobody else
can mark your proposals.

### Long answers stream whitespace

Chat and the manual watch check (`POST /api/trips/:id/watches/:wid/check`)
both take two or three minutes when the model searches the web, and for all
of it nothing crosses the wire. iOS Safari on a mobile network drops a
connection that idle, so a working request looks like a broken app. This was
measured on `santa-rosa-beach-trip` — 176 seconds for one good answer — and
the fix is copied here verbatim.

`streamedJson(res)` sends headers plus one space immediately, then a space
every five seconds until the body is ready. Leading whitespace is legal JSON,
so the client still uses a plain `res.json()`.

**The contract:** headers go out before the outcome is known, so failures on
those two routes come back as `200` with an `{ error }` body, never a 500.
Everything that fails with a status — the 400, `requireLogin`,
`requireBudget`, `requireDailyCap` and `loadOwnedTrip`'s 404 — must stay
*above* the `streamedJson` call, and the frontend checks
`!res.ok || data.error`. The cron sweep is untouched: nothing is waiting on
it, so it keeps ordinary status codes.

## The trip Overview (2026-09-23)

Erik asked for a trip to open "more rich like the Santa Rosa [app] with the
overview, weather etc". A trip now opens on an **Overview** tab — tabs are
Overview, Itinerary, Chat, Watches, Details — styled on the vacation app's own
components (the weather gradient, the dark countdown, the grouped booking
cards) so the two read as related. That app is hand-built for one trip; this
one draws every section from the trip's data, and each section hides or turns
into a next step when it has nothing to show.

- **Dates** — `tripdates.js`. The itinerary's ISO dates win; otherwise "When"
  is parsed ("Sep 23-26, 2026", "March 27", "December 2026"). A month-only
  answer is `precision: 'month'` and the page says "about", never ticks down
  to a midnight nobody chose. Months match as whole words only: "maybe next
  year" was once read as May. Every trip response carries `dates`.
- **Weather** — `weather.js`, `GET /api/trips/:id/weather`. **MET Norway**
  for the forecast and **OpenStreetMap Nominatim** for the place, both free
  for commercial use with attribution (printed on the card). **Not
  Open-Meteo**: its free tier is non-commercial, and this site sells
  memberships. The place is geocoded once and stored on the trip (`geo`),
  redone only when the destination text changes; a search that found nothing
  is remembered, one that failed is not. Nominatim is limited to one request a
  second app-wide, per its policy. No model call, so no budget. Every failure
  is a 200 saying there is no weather — decoration must not break a page.
  Forecast covers ~9 days; further out the card says when it opens. Days whose
  afternoon the forecast does not cover are dropped (they read "73 / 73").
- **Bookings** — `bookings.js`, `trip.bookings` + `bookingsUpdatedAt`. They
  had nowhere to go but free-text notes. They arrive from Gmail import, from
  **Find in Gmail** on a trip (`POST /api/trips/:id/gmail-bookings`, filed
  into Chat as a proposal), and from chat's `propose_bookings` tool. All three
  are someone else's text, so `validate()` runs on every one — only https
  becomes a link, only a phone number becomes `tel:`, markup stripped — and on
  import too, because the browser hands the scan result back. Apply / Discard
  and the stale guard are the itinerary's, on their own clock
  (`bookingsState` on the message). Delete is a direct tap, no model.
- **Things to do** — `ideas.js`, `POST /api/trips/:id/ideas`. Web search,
  metered, saved on the trip so drawing the Overview never buys it again.
  Saved without an Apply: it is a labelled list of suggestions, not a
  decision.
- The example trip has bookings and ideas too, with plainly made-up
  confirmation codes; its edit buttons are hidden.

Tests: `tripdates.js`, `weather.js`, `bookings.js`, `trip-bookings.js`,
`trip-ideas.js`. Rendered at phone and desktop width before shipping.

## Packing and Budget (2026-09-23)

The vacation app's other two tabs, for every trip. On a phone the bar keeps
five items — Overview, Itinerary, Chat, Packing, **More** (Budget, Memories,
Crawls, Watches, Details) — the vacation app's own pattern; the desktop
sidebar shows all of them. The Overview has a tile for each.

- **Stored one document per row** — `trips/<id>/packing/<item>` and
  `trips/<id>/budget/<line>` — not as an array on the trip. These are the
  lists two people edit at once; with one array, the second phone's save
  writes back a list without the first phone's tick. `test/trip-packing-budget.js`
  ticks two items concurrently and checks both stick. (The vacation app's
  packing list is per-phone localStorage; this one is shared.)
- **A model only suggests.** `/packing/suggest` and `/budget/suggest` return
  rows unsaved; the page shows them ticked, and adds what is still ticked on a
  tap. A suggestion never removes or unticks anything, and packing skips what
  is already on the list. Both see the trip through `tripContext()` — place,
  dates, notes (who is going), itinerary, bookings, and the forecast. Budget
  uses web search; packing does not need it.
- **Money** goes through `budget.money()`: "$1,240.50" reads as 1240.5,
  "about $40" as 40, and anything without a digit as *no figure* — "free" once
  came out as $0.00, because `Number("")` is 0.
- **Bookings carry an optional `total`**, and the Budget counts those as
  booked money, so a suggested budget is told not to count them twice.
- The example trip has read-only packing and budget (`demo.DEMO_PACKING`,
  `DEMO_BUDGET`).

## Receipts, card statements and Memories (2026-09-23)

Three ways to get the trip itself into the app while it is happening: what it
cost, and what it looked like. The helpers are shared with the vacation app
(`eriks-projects/shared/`, synced — **do not edit the copies here**):
`receipts.js`, `statement.js`, `photostore.js`, `public/photo-tools.js`.

**No bank connection, by design.** Erik chose a receipt photo and the CSV
every card's website already offers over an aggregator like Plaid. Nothing here
holds a bank login or a standing link to anyone's account, there is no
aggregator fee, and both files are read in the request and dropped. The price
is a download step, which the Budget tab explains in one line.

- **A receipt** — `POST /api/trips/:id/budget/receipt`, body
  `{image:{mediaType,data}}`. A model call, so `requireLogin, requireBudget,
  requireDailyCap` like every other. The page shrinks the photo to ~1600px
  first (`PhotoTools.receipt`); `receipts.request()` refuses a bad image with a
  400 **before** anything is spent; the model is forced through one tool;
  `receipts.read()` checks the answer. It returns a *proposed* line
  (`source: 'receipt'`) and a `currency`, and the page shows an editable card —
  a euro receipt says so rather than being counted as dollars. **The photo is
  read once by the model and never stored**: not in Firestore, not in the
  photo bucket. Unreadable is a 422. Not streamed: 5–15 s is far short of the
  silence that drops a phone, and plain status codes read better here.
- **A card statement** — `POST /api/trips/:id/budget/statement`, body `{csv}`.
  No model call, so login only. `statement.parse` reads it against the trip's
  own dates (`tripDates()`, a day of slack either side; no dates, no window),
  skips payments and refunds, and `markDuplicates` flags — never drops — a
  charge that matches an existing line's amount within three days (the dinner
  scanned at the table). Kinds map to this budget's categories in
  `budget.KIND_CATEGORY`. It returns `{transactions, skipped, window, room}`
  and saves nothing; the page lists them ticked (duplicates unticked, "Maybe
  already added"), and adds the ticked ones in one `/budget/lines` call with
  `source: 'card'`.
- **Lines remember where their number came from.** `budget.line()` keeps an
  optional `date` (a real ISO day or null) and `source` (`manual | receipt |
  card | estimate`, default manual). The list shows the date and a Receipt /
  Card badge. Claude's estimates are stamped `estimate` by the server, whatever
  the model claims. Older lines read back as undated manual lines. A full
  budget (`MAX_LINES`, 100) now says how many more fit.

**Memories** — a tab (under More on a phone, in the sidebar on a desktop) and
an Overview tile. Photos filed under the itinerary's days
(`PhotoTools.groupByDay`), played back as a full-screen picture show.

- **Photos are never public and are served through the app.** They live in a
  private bucket (`PHOTOS_BUCKET`, public access prevention enforced) at
  `trips/<tripId>/<photoId>.jpg` and `…-thumb.jpg`, and every image request —
  `GET /api/trips/:id/photos/:pid/thumb|full` — passes `requireLogin` and
  `loadOwnedTrip`, exactly like the trip. **No signed URLs, no public links:**
  a link is a bearer token, and these are people's holiday photos. The list
  (`GET /photos`) carries no paths or URLs; the page builds its own. Served
  `private, max-age=31536000, immutable` (ids are never reused, bytes never
  change) with `nosniff`, and only the types `imageBuffer()` admits.
- **The phone strips location.** `PhotoTools.prepare` redraws each photo at
  2048px (plus a 480px thumbnail) through a canvas, which drops its EXIF,
  GPS included; only `takenAt` is read first and sent as a plain field. The
  tab says so in one quiet line.
- **Upload** `POST /photos` `{full, thumb, takenAt, width, height, caption}`:
  both checked by their bytes (`imageBuffer`), a thumbnail required, both
  objects written **before** the Firestore record so a record never points at a
  missing photo (and the objects are removed if the record fails). Ids are 12
  random bytes. `PATCH /photos/:pid` edits the caption; `DELETE` removes the
  objects, then the record — if storage fails the record stays, so a retry can
  finish. Deleting a trip removes its photos too, awaited (see "Billed per
  request") but never allowed to fail the delete.
- The page uploads **one at a time** with "Adding 3 of 12…" — a phone decoding
  a dozen photos at once runs out of memory, and one bad file must not stop the
  rest. It re-fetches the list when the tab opens and when the app comes back
  to the foreground: two phones, one trip.
- Without `PHOTOS_BUCKET` the list answers `{available:false}` and writes 503
  — unavailable rather than half-working, like Gmail. The example trip lists
  none and explains that photos are for your own trips.

**Limits.** The app-wide JSON parser keeps Express's 100 KB default; only the
three file routes skip it and mount their own (receipt 8 MB, statement
2.5 MB, photo 12 MB — each a little over its decoded ceiling in the module),
**after** the sign-in and ownership checks, so a stranger's 12 MB is never
read. A body too large is a JSON 413. Photos: 8 MB full, 600 KB thumbnail,
500 per trip. Receipts: 5 MB. Statements: 2 MB, 5,000 rows.

**Infrastructure.** The bucket is `metal-celerity-236019-trip-photos`
(created 2026-09-23: uniform access, public access prevention enforced), with
`roles/storage.objectUser` for `trip-planner-run@` — get, create, delete and
the list that deleting a trip's photos needs. See
`eriks-projects/docs/phase4-runtime-service-accounts.md`. The service needs
`PHOTOS_BUCKET` set to that name; check it is on the revision before relying
on Memories. The token comes from the metadata server; no key.

Tests: `test/trip-receipts.js`, `test/trip-photos.js` (Cloud Storage faked at
`global.fetch`). Rendered at 390px and 1280px before shipping.

## Brewery crawls (2026-09-23)

Erik loves the crawl planner in Hopscotch (`eRock35/beer-app`) and asked for
it "really improved" and brought into trips: "dig into the breweries, the
menus, the routes and any other cool features". A **Crawls** tab (under More
on a phone, in the sidebar on a desktop) and an Overview tile.

**What came from Hopscotch**, ported to CommonJS in `crawl.js`: `haversineKm`,
`planRoute` (nearest-neighbour then 2-opt, optional fixed start) and
`describeRoute`, and the Open Brewery DB normalising. **What is new:**

- **A clock.** Hopscotch said "12 min walk". A crawl here has a start time and
  a stay per stop (crawl default, overridable per stop, 20–180 min), so every
  stop has arrive/leave times, and the page can say "Leave by 5:10 for Musa".
- **Legs along streets.** Haversine is the straight line; each leg is that
  times `STREET_FACTOR` (1.25 — city grids run 1.2–1.4×). Walking at 4.5 km/h.
- **A ride for one leg.** In walk mode a leg over 1.6 km (~20 min) is a *ride*
  with a drive estimate (30 km/h + 5 min pickup) and an Uber link for that leg
  alone, instead of Hopscotch's all-or-nothing "you will want a car". Drive
  mode makes every leg a drive estimate.
- **The best start.** `bestRoute` tries every stop as the start; nearest-
  neighbour from the first-ticked stop is rarely shortest. Checked against brute
  force in `test/crawl.js`. Mid-crawl, "Shortest order" keeps visited stops
  where they were walked and routes the rest from the last one; an added stop
  goes where it adds the least distance, ahead of anything visited.
- **Warnings**, in words: a stop closed or closing before you would leave it,
  a crawl running past midnight, a leg that needs a ride, and something already
  in the itinerary during the crawl ("Dinner at 7:30 PM").

**Route legs are computed on every read, never stored.** Reorder, remove a
stop, change the start: nothing stale to forget to update.

### Data

- `trips/<id>/crawls/<cid>` — `{name, date, startTime, dwellMinutes, mode,
  stops: [{id (Open Brewery DB), name, type, street, city, state, lat, lng,
  phone, website, dwellMinutes}], visits: {<stopId>: ISO|null}, preferences,
  picks: {<stopId>: {order, why}}, picksNote, itineraryAdded, createdBy, …}`.
  Max 10 stops, 20 crawls a trip. Each stop is read back with `visitedAt` from
  `visits` — **check-ins are a merge-write of one key**, not a rewrite of the
  stops array, so two phones checking in at once (or one checking in while the
  other reorders) both stick. The packing list's lesson, applied again.
- `trips/<id>/crawls/<cid>/pours/<auto>` — `{stopId, beer, style, rating
  (1–5|null), note, by, at}`. **One document per pour**, same reason. 300 a crawl.
  Removing a stop removes its pours (the page says so first); deleting a crawl
  removes all of them.
- `breweries/<Open Brewery DB id>` — the **shared menu cache**: `{name, city,
  menu, fetchedAt}`.

### Finding breweries: Open Brewery DB

`breweries.js`, `GET /api/trips/:id/breweries/nearby[?near=]`. Free, no key,
community-run; it knows names, types, addresses, coordinates, phones and
websites — **not hours, menus or food**. Centred on the trip's stored `geo`
(the same geocode-once helper the weather uses) or `near` through the same
one-a-second Nominatim path. Identifying User-Agent, results cached in memory
for an hour, types with no taproom (planning, closed, contract, proprietor) and
rows without coordinates skipped. No model call, so no budget. Every failure
is a sentence (503), never a 500. The sandbox cannot reach it — tests fake it.

### Menus: a metered lookup, shared for 48 hours

`POST /crawls/:cid/menus` — `requireLogin, requireBudget, requireDailyCap`,
`streamedJson`. The stops with no fresh shared menu (max 6 a call) go to one
model call with the plan's web search and a `record_menus` tool: current tap
list, food, hours on the crawl's date, `closesAt`, weekly closing times,
kid/dog friendliness, a highlight, sources, confidence, asOf. The prompt says
plainly not to invent beers — **an empty list with confidence "low" beats a
guess**, because someone will cross town for it.

Cached for everyone at `breweries/<id>` for 48 hours, like the football app's
`fan/<team>`: whoever's crawl first needs a brewery pays, the next crawl
through it reads free and makes **no model call**. An older menu is still
shown, marked "may be out of date". The cache key is an id the browser sends,
so an entry is only reused for a stop **of the same name** — one crawl cannot
file a menu under a real brewery's id and serve it to everyone else.

`crawlmenu.validate()` runs on everything before it is stored or drawn: tags
stripped, lengths bounded, 40 beers max, ABV 0–20 or null, https-only sources,
`closesAt` HH:MM or nothing, a future asOf becomes today, no beers can't be
"high" confidence. A `closesAt` answers only for the date it was looked up for
(`closesOn`); weekly hours answer for any date — the cache is shared across
crawls on different days.

**Picks** — `POST /crawls/:cid/picks`, same gates, streamed, no web search
(reads the cached menus), forced through `record_picks`. What to order at each
stop, from its menu by name, plus a short practical pacing note ("not a
lecture"). The person's `preferences` are saved first. Picks for stop ids that
are not the crawl's are dropped.

### Into the itinerary

`POST /crawls/:cid/itinerary {basedOn}` puts one `🍺 <Brewery> — <pick>` block
per stop into the day with the crawl's date (a new day, in date order, if
none), sorted by time among the day's blocks, and saves through the chat's own
path — `schedule.toStore`, `daysUpdatedAt`, and the **409 stale guard** when
`basedOn` no longer matches (the page redraws the itinerary it gets back and
asks for the tap again). A person's tap is the confirmation; nothing here is a
model proposal. Adding again **replaces** the crawl's blocks (matched by the
tag plus one of its stop names, current or previously added — so a second crawl
on the same day, or a beer emoji someone typed, is left alone); a changed date
moves them, and a day the crawl created and left empty goes. `schedule/apply`
now returns `daysUpdatedAt` so the page's next guarded write is not refused.

### Map and links

**Leaflet 1.9.4 is vendored** in `public/vendor/leaflet/` (BSD-2-Clause, with
its LICENSE), not loaded from a CDN, and only fetched the first time the Crawls
tab opens. Tiles are OpenStreetMap's own (`tile.openstreetmap.org`), as in
Hopscotch, with the © OpenStreetMap attribution always visible — the OSM tile
policy asks for light use, attribution, an app that does not prefetch or bulk
download; this map loads what is on screen and nothing more. If usage ever
grows past "light", move to a tile provider with terms for it. The map is
fitted when the stops change, not on every refresh, and isolated
(`isolation: isolate`) so Leaflet's z-indexes stay under the nav bar and sheets.

**Links rather than a routing API**: one Google Maps directions link for the
whole route (stops as waypoints — Google's mobile app honours only three, the
web nine), per-stop Apple Maps directions walking or driving as the leg is, and
an Uber universal link on ride legs. No key, no cost, and the phone's own maps
app does turn-by-turn better than anything drawn here.

### On the day

- **Live mode** on the crawl's date: a sticky card with the current stop (the
  first not checked in whose window has started — "behind the plan" when its
  leave time has passed), "Leave by 5:10 for Musa — 12 min walk", Check in,
  Directions, and Ride on a ride leg. The Overview tile says "Now: X, next Y at
  5:10 PM". The time is the phone's, which is where the crawl is.
- **Check-ins** stamp the stop and the trip's **passport** strip (breweries
  checked in across its crawls, beers logged, average rating, best beer).
  **Log a beer** — chips from the stop's menu, 1–5 stars, a note, and on a
  shared trip whose it was (`whoAsked`). **Photo** uploads through the Memories
  route, captioned "<Brewery> · <beer>".
- **Recap** once every stop is checked in or the date has passed, and **Play the
  crawl**: the Memories photos taken during it (its date, start to end), each
  brewery a title card — by caption, else by the stop they were taken during.
- The open crawl is re-asked on foreground and every 60 s while on screen, and
  redrawn only when it changed: two phones on one crawl.

**Members** of a shared trip do everything the owner does with crawls —
create, edit, check in, log, delete (a crawl is the trip's, not one person's).
Whoever presses an AI button pays. Strangers get the usual 404 on every route.

**The example trip** has one read-only crawl in `demo.js` — real Lisbon craft
breweries (Oitava Colina, Musa, Lince, Dois Corvos in Marvila) at
**approximate** coordinates, with a ride leg across town, and menus and picks
that say they are examples (generic "House IPA" rows, no claims about what a
real business pours or when it shuts). Writes are refused like every demo write.

Tests: `test/crawl.js` (pure: geometry, the clock, warnings, links, directory
rows, the itinerary merge, menu and pick validation) and `test/trip-crawls.js`
(the routes, with Open Brewery DB, Nominatim and the model faked). Rendered at
390px and 1280px — picker, map, menus, picks, live mode, check-in and pour,
recap and picture show, Overview tile, the demo crawl — before shipping.

## Sharing a trip (2026-09-23)

Erik asked for this so his wife could use the same trips. A trip still has one
owner (`ownerId`); the owner can share it by email with up to 10 people
(`members: [{uid, email, addedAt}]` plus `memberIds: [uid]`, written
together — `memberIds` is what the trips list queries with `array-contains`,
`members` is what the page shows).

- **By email, not by link.** A uid is `base64url(lowercased email)`
  (`identity.uidFor`), so an address can be shared before its owner has an
  account: the moment they sign up or sign in with it, the trip is in their
  list. There is no mail service, so the sheet's "Send link" hands a message to
  the phone's share sheet (or copies it). That link opens the trip only for
  the account it was shared with; anyone else gets the usual 404.
- **Members can do everything except two things.** `loadOwnedTrip` now
  admits owner or member and returns `role`; every existing route therefore
  works for a member — chat, itinerary, packing, budget, receipts, statements,
  photos, lock. Deleting the trip and changing who it is shared with stay the
  owner's (403 for a member). A member can remove themselves (leave).
- **Never says whether an address has an account**, for the reason
  reset-request answers identically.
- **Money:** whoever presses an AI button pays, as everywhere. The hourly
  watch sweep still charges the owner (`ownerMaySpend` asks by `ownerId`).
- The list merges two queries (own by `ownerId` + `updatedAt` index, shared by
  `memberIds array-contains` with no orderBy, so no new index) and sorts in
  memory. Chat messages record `askedBy`, so a shared chat says whose question
  each was.

`test/trip-sharing.js` covers sharing before sign-up, what a member can and
cannot do, strangers still 404, removing and leaving, the cap, and the merged
list.

### Gmail connections end after seven days — by Google's rule

An OAuth app in **Testing** that asks for more than basic profile gets refresh
tokens that expire after **seven days**. `gmail.readonly` qualifies, so every
connection dies weekly. Refreshing then fails with `invalid_grant`, which both
apps now treat as "ended", not "failed": `gmail.js` throws it as a 401 marked
`expired`, the connection is recorded as `expiredAt`, the page stops saying
connected and says why, and reconnecting clears it (explicitly — a merge
write keeps nested fields it does not mention, and the test harness now merges
the way Firestore does so that would be caught).

**Published 2026-09-23.** Erik moved the OAuth app to **In production**
(unverified, no logo — a logo would force verification), which ends the
seven-day expiry, keeps the 100-user ceiling and the "unverified app" warning,
and drops the test-user allowlist: anyone with an account can now connect
their own Gmail. Publishing needed a public privacy policy and terms, now at
`strongtechnicalconsulting.com/privacy` and `/terms` (`eriks-projects/site/`).
**The Gmail section of that privacy policy describes this code** — the sender
list, the 40-message cap, bodies never stored, Anthropic as the extractor.
Change the behaviour and that page must change with it.

`invalid_grant` still happens (a revoke, a password change, six months
unused), so the expired handling stays; its wording no longer blames Testing.
Connections made while the app was in Testing may still carry the old expiry;
reconnecting once issues a lasting one.

## Reading Gmail for bookings (2026-09-21)

Trip Planner can look through someone's booking confirmations and offer to
turn them into trips. Consent is the feature, not the paperwork around it, and
three rules hold the shape together — each enforced in code rather than
promised in copy:

1. **The query is fixed.** `gmail.js` compiles it from `SENDER_GROUPS` — 102
   curated domains in nine groups (airlines, hotels & stays, car rentals,
   booking sites, trains & buses, cruises, tours & tickets, restaurants,
   parking), widened on 2026-09-23 at Erik's request — plus a 12-month window.
   One query per group, not one for everything: a single query over a hundred
   senders is ~1,700 characters, and a shared 40-message ceiling would let a
   run of restaurant reminders push out the one car-rental confirmation.
   `search()` takes the newest from each group in turn, and every query
   excludes `category:promotions` and `category:social`, which is what stops a
   wider list meaning a noisier scan. **Forwarded bookings** (2026-09-23): each
   group also has `subject:(fwd OR fw) ("<domain>" OR …)` — the same senders'
   mail forwarded in. Found because Erik's National rental agreement was
   booked at work and forwarded home, so its From was the work address and
   `from:` never matched. The privacy policy and both consent sheets say so.
   Forwards from work clients are often HTML-only, so `plainText()` now falls
   back to the HTML part with markup stripped instead of returning nothing.
   `searchQueries()` takes no caller input, deliberately: an earlier
   shape let a request add terms, which would have made the consent screen a
   lie the first time anyone used it. The account page prints that same
   constant, so the promise and the query cannot drift.
2. **Message bodies are never written down.** Fetched, read once by the
   extractor, dropped with the request. The only durable record is a trip
   somebody chose to import.
3. **Nothing becomes a trip without a tap.** `/api/gmail/scan` proposes and
   `/api/gmail/import` writes — the same confirm-before-save shape as the
   itinerary chat, and for the same reason.

**The uncomfortable part is said out loud.** Google has no read scope narrower
than `gmail.readonly`, so the token we hold *can* read everything. The consent
sheet says exactly that — "Google's own screen will say read your email,
because that is the only permission it offers" — and then says what this app
actually does with it. Holding a capability we never exercise is a promise;
a promise a user cannot inspect is worth very little, so the limits are named,
numbered and served from the code that enforces them.

The refresh token is stored encrypted through `byok.js` (AES-256-GCM, uid as
additional authenticated data, so a row copied between accounts fails to
decrypt rather than quietly working). Disconnecting **revokes at Google
first**, then forgets locally — dropping our copy while Google still believes
the app has access is the dishonest version.

The OAuth `state` is HMAC-signed with `SESSION_SECRET`, carries the uid and
expires in ten minutes. Without it, a crafted callback link could hang someone
else's mailbox off your account.

### It cannot go past 100 users without a security assessment

`gmail.readonly` is a **restricted** scope. Offering it publicly requires
Google app verification *plus* an annual third-party security assessment
(CASA), which is a real recurring cost. So the OAuth app is **published but
unverified** (Testing until 2026-09-23): up to 100 users, who see an
"unverified app" warning once.

That ceiling is a product decision, not a bug. Do not try to lift it by
widening scopes or by asking users to work around the warning. If the feature
ever needs to be public, the honest path is the assessment — or a Google
Workspace *internal* app, which skips verification for users inside the
domain.

**It was never switched on (found 2026-09-22).** The code shipped on 09-21, but
the Gmail API was disabled on the project and no OAuth client existed, so the
feature has reported itself unavailable in production since the day it was
built — and nothing said so. The API was enabled on 09-22. The OAuth client
cannot be created by API (Google offers none for standard web clients); it is
a Cloud Console step for Erik, shared with `santa-rosa-beach-trip`: one Google
app, two redirect URIs, testing mode.

**Switched on 2026-09-23.** Erik created the client in Cloud Console ("Google
Auth Platform" — the 2025 rename of "OAuth consent screen"; External, since the
project has no Workspace organisation, left in Testing). Its ID and secret are
`google-oauth-client-id` / `google-oauth-client-secret` in Secret Manager,
bound to `trip-planner-run@` and `vacation-run@`, mounted as `GOOGLE_CLIENT_ID`
/ `GOOGLE_CLIENT_SECRET`. Google accepted the vacation app's `*.run.app`
redirect URI on the same client, so no custom domain was needed there.

While it was in Testing, only addresses under **Audience → Test users** could
connect. Since publishing, anyone can, up to the unverified-app cap.

`gmail.js` is now `eriks-projects/shared/gmail.js`, synced here and into the
vacation app, because `TRAVEL_SENDERS` is a consent-screen promise and two
copies would be two promises that drift.

- Env: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (Secret Manager),
  `GOOGLE_REDIRECT_URI` (`https://trip.strongtechnicalconsulting.com/api/gmail/callback`),
  and `BYOK_ENCRYPTION_KEY`, which the token vault shares with BYOK.
  Missing any of them and the feature reports itself unavailable rather than
  half-working.

## Watches: user sets the schedule without touching Cloud Scheduler

Each watch has its own `intervalHours` (6h / day / 3 days / week, chosen in
the UI when adding it). There is **one** Cloud Scheduler job for the whole
app, hitting `POST /api/cron/check-watches` on a fixed base tick (hourly is
plenty) — the route itself decides which watches are actually due by
comparing `intervalHours` against `lastCheckedAt`, and skips everything on a
locked trip. This is the whole point of the design: the user changes a
watch's cadence in the UI any time, with no deploy and no new scheduler job
ever needed. **Don't undo this** by creating per-frequency or per-trip
Scheduler jobs — that reintroduces exactly the "need infrastructure changes
for routine use" problem this app exists to avoid.

`MAX_CHECKS_PER_RUN` (20) caps how many watches one batch tick processes, so
a slow tick or a burst of due watches can't balloon into a large, unbounded
Anthropic bill.

Auth on that one route: `requireLoginOrCron` — either a normal session, or
the `X-Cron-Key` header matching the `cron-secret` Secret Manager value
(same pattern as `college-football-app`'s cron routes). The Scheduler job
itself still needs creating — see "Still to do" below; the deployer service
account has lacked `cloudscheduler.jobs.create` on every project so far.

## Deploy

Same pipeline as `santa-rosa-beach-trip` and `college-football-app`: no
`gcloud` CLI, no local Docker — a Python venv + service account key mints an
OAuth2 token, then direct REST calls (Cloud Build -> Artifact Registry ->
Cloud Run Admin API v2). See `college-football-app`'s
`docs/gcp-deployment.md` for the exact mechanics.

- GCP project `metal-celerity-236019`, region `us-central1`, same as the
  other two apps.
- Needs its own Cloud Run service (`trip-planner`), its own Firestore
  database (`trip-planner`, Native mode, `us-central1` — doesn't exist yet
  as of this writing), and its own Secret Manager secrets:
  `trip-planner-login-username`, `trip-planner-login-password`,
  `trip-planner-cron-secret`. `ANTHROPIC_API_KEY` is shared across all three
  apps, same as always.
- Env vars: `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID=trip-planner`,
  `SESSION_SECRET` (any long random string, signs session/challenge cookies),
  `CRON_SECRET`, `ADMIN_EMAIL` (secret `trip-planner-admin-email`),
  `FREE_TIER_DAILY_CAP_USD` (the free tier's daily ceiling; **deliberately
  unset** — see above).
  `SITE_LOGIN_USERNAME` / `SITE_LOGIN_PASSWORD` are **dead** since the move to
  multi-user — nothing reads them. They're still mounted on the service; drop
  them (and their secrets) on a future deploy.
- Runs as **`trip-planner-run@metal-celerity-236019.iam.gserviceaccount.com`**
  since 2026-09-21, not the shared deployer account. It holds
  `roles/datastore.user` conditioned to the `trip-planner` and `identity`
  databases, `secretAccessor` on the six secrets this service mounts, and
  `logging.logWriter` — nothing else. **Add a secret or a database here and you
  must bind it to that account**, or the next revision will not start: Cloud
  Run resolves secret env vars before it reports a revision ready. The deployer
  holds no IAM-admin rights, so that binding is Erik's to make. The record is
  in `eriks-projects/docs/phase4-runtime-service-accounts.md`.
- Custom domain `trip.strongtechnicalconsulting.com`, mapped 2026-09-20.

  This reverses an earlier note that said no custom domain, copying
  `santa-rosa-beach-trip`'s reasoning that a mapping publishes the hostname to
  public Certificate Transparency logs. That argument never really transferred
  to this app: the repo is public, the app is open to registration, and its
  `*.run.app` URL is already linked from the public landing page. There was no
  quiet URL here to protect. Erik asked for the subdomain and created the
  mapping himself.

  **That reasoning still holds for `santa-rosa-beach-trip`**, which is private,
  holds family PII, and is deliberately unlinked. Don't carry this change over
  to it.

  This note used to say a mapping cannot be created by the deployer service
  account, because every API attempt failed with "Caller is not authorized to
  administer the domain". That was never a user-vs-service-account rule: Cloud
  Run checks whether the caller is a *verified owner of the domain*, and the
  deployer was added as an Owner of the property in Google Search Console on
  2026-09-20. It has created mappings by API since — `acct` on 2026-09-21. See
  `eriks-projects/DEPLOY.md` -> "Domain mappings". Erik's step is the DNS
  record at the registrar, not the mapping.

## Still to do

- Once a real trip exists and is locked in, decide whether "promote to a
  bespoke app" is ever actually wanted before building it — see the note
  above.

## Deployed (2026-09-20)

- Cloud Run service `trip-planner` in `us-central1`, project
  `metal-celerity-236019`.
- URL: `https://trip-planner-u4h4ftn3fa-uc.a.run.app` (public to browse;
  writes gated — see "Sign-in" above). `allUsers` holds `roles/run.invoker`.
- Image: `us-central1-docker.pkg.dev/metal-celerity-236019/erik-projects/trip-planner`,
  pinned by digest in the service spec — a floating `:latest` tag does not
  trigger a new revision.
- Firestore database `trip-planner` (Native mode, `us-central1`) exists.
- Secrets in Secret Manager: `trip-planner-login-username`,
  `trip-planner-login-password`, `trip-planner-cron-secret`,
  `trip-planner-session-secret`. `ANTHROPIC_API_KEY` is the shared one.
- Cloud Scheduler job `trip-planner-check-watches` exists: hourly at `:00`
  America/New_York, POSTing to `/api/cron/check-watches` with the
  `X-Cron-Key` header. Verified end to end with a forced run — it returned
  clean and wrote `control/watch-cron` (`checked: 0`, no watches yet).

## Billed per request — never keep working after the response (2026-09-23)

This service runs with `cpuIdle: true`: Cloud Run bills only while a request
is in flight and throttles the CPU to near zero between requests. It used to
be billed for every second an instance was alive, which for this traffic was
~99% idle time. Anything that keeps working after the response has been sent
— respond first and process after, a `setInterval` sweep, a promise left
running past `res.json()` — now stalls until the next request arrives. Every
cron route here awaits its work before answering, and `streamedJson`'s
heartbeat runs inside the open request. Keep it that way. The full reasoning
and numbers are in `eriks-projects/DEPLOY.md` -> "Creating a service".

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
