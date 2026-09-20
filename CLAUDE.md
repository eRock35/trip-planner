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

## Sign-in: open registration, approval-gated AI

**This app is multi-user.** Anyone can register (email + password, at least 10
characters); a passkey can be added afterwards from inside the app for Face ID.
Accounts live in `users/<uid>`, where `uid` is the base64url of the lowercased
email — deterministic, so `create()` fails on a duplicate rather than needing a
uniqueness index Firestore doesn't have.

The access model is Erik's explicit call, and the reason matters:

- **Everyone who signs up gets the free features immediately** — create trips,
  edit them, add and schedule watches, lock and unlock. None of that costs
  anything.
- **Anything that calls Claude requires `aiAccess === 'approved'`**, which only
  the admin grants by hand. A user asks via `POST /api/ai-access/request` (with
  an optional note); the admin sees pending requests in the app and approves or
  denies. States: `none` → `pending` → `approved` | `denied`.

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

Without that second gate, any stranger who found the URL could run Sonnet 5
with web search on Erik's API key. **Never put an Anthropic call behind
`requireLogin` alone** — it goes behind `requireAiAccess`, and the cron sweep
checks the trip owner's approval with `accounts.isApprovedUid()`. There are
exactly two call sites (trip chat, and `runWatchCheck`); all three paths to
them are gated.

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

## Chat can draft or edit the itinerary

Same confirm-before-save shape as `santa-rosa-beach-trip`: `/api/trips/:id/chat`
gives Claude `web_search` plus a `propose_schedule_change` tool. When asked
to plan or change the day-by-day itinerary, the model proposes the complete
`days` array with a one-line summary; the frontend renders it as an
Apply/Discard card, and only `POST /api/trips/:id/schedule/apply` (fired by
the user's own tap) actually saves it. Keep this shape if you touch this
flow — deliberate, not something to let an LLM silently rewrite.

Runs on `claude-sonnet-5` (tool use + web search).

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
`requireAiAccess`, `requireBudget`, and `loadOwnedTrip`'s 404 — must stay
*above* the `streamedJson` call, and the frontend checks
`!res.ok || data.error`. The cron sweep is untouched: nothing is waiting on
it, so it keeps ordinary status codes.

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
  `CRON_SECRET`, `ADMIN_EMAIL` (secret `trip-planner-admin-email`).
  `SITE_LOGIN_USERNAME` / `SITE_LOGIN_PASSWORD` are **dead** since the move to
  multi-user — nothing reads them. They're still mounted on the service; drop
  them (and their secrets) on a future deploy.
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

  A mapping cannot be created by the deployer service account — every API
  attempt fails with "Caller is not authorized to administer the domain" even
  though the domain is verified. It needs a real Google user identity via the
  Cloud Run console, so this is one of the few steps Erik does by hand.

## Still to do

- Runtime service account: same known compromise as the other two apps
  (currently runs as the broad-privilege deployer account
  `cover-sheet-deployer@`, not a scoped-down one) — see
  `college-football-app`'s CLAUDE.md for the right fix and why it's not done
  yet.
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
