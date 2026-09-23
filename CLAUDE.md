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
- `webauthn-credentials/<id>` — passkey public keys; `auth.js` and
  `login.html` are copied verbatim from `santa-rosa-beach-trip` (Face ID /
  Touch ID sign-in, password fallback). Keep them in sync if that pattern
  changes there.
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
five items — Overview, Itinerary, Chat, Packing, **More** (Budget, Watches,
Details) — the vacation app's own pattern; the desktop sidebar shows all
seven. The Overview has a tile for each.

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
   wider list meaning a noisier scan. `searchQueries()` takes no caller input, deliberately: an earlier
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
