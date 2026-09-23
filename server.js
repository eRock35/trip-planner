const express = require('express');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { createAccounts } = require('./accounts');
const crypto = require('crypto');
const gmailLib = require('./gmail');
const byokLib = require('./byok');
const identityLib = require('./identity');
const identityStore = require('./identity-store');
const analytics = require('./analytics');
const schedule = require('./schedule');
const { tripDates } = require('./tripdates');
const bookingsLib = require('./bookings');
const ideasLib = require('./ideas');
const packingLib = require('./packing');
const budgetLib = require('./budget');
const weatherLib = require('./weather');
const demo = require('./demo');

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const FIRESTORE_DB = process.env.FIRESTORE_DATABASE_ID || 'trip-planner';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
// The one account allowed to approve AI access. Set at deploy time.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const db = new Firestore({ projectId: PROJECT_ID, databaseId: FIRESTORE_DB });

const app = express();
app.use(express.json());

// Only the landing page may put this app in a frame - it shows a live
// preview you can swipe through. Nothing else should be able to: a gated app
// inside a hostile page is the setup for clickjacking a signed-in session.
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  next();
});

// ---------------------------------------------------------------------------
// Auth. This app is multi-user: anyone can register, every signed-in user
// gets the free features, and anything that spends Anthropic tokens needs
// aiAccess === 'approved', which only the admin grants. See accounts.js.
//
// Note the deliberate change from the old single-account shape: trips are no
// longer publicly browsable. They belong to a user now, so an open GET would
// leak one person's trips to another. Every /api/trips* route below requires
// a session and is scoped by ownerId.
// ---------------------------------------------------------------------------
const accounts = createAccounts({
  db,
  sessionSecret: SESSION_SECRET,
  rpName: 'Trip Planner',
  adminEmail: ADMIN_EMAIL,
});

const { requireLogin } = accounts;
// `accounts.requireAiAccess` still exists and is deliberately on no route -
// see "Spending is metered, not approved" in CLAUDE.md. Do not put it back in
// front of a model call: the budget and the daily ceiling are the gate now.

app.get('/healthz', (req, res) => res.status(200).send('ok'));
// Cloud Run's edge swallows /healthz: in production it returns a 404 with no
// Server header, on the run.app URL and the custom domain alike, while every
// other path - including ones the app does not define - reaches the app. It
// works locally, which is why it went unnoticed: CI and boot checks were
// testing a route no external monitor could ever reach. /api/health is the
// same handler on a path the edge leaves alone.
app.get('/api/health', (req, res) => res.status(200).send('ok'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// Every request gets req.user (or null) before any gate runs.
// Analytics. Mounted BEFORE the gate below: a gated /analytics.js is a 401,
// so the sign-in page - the page every visitor actually sees - would be the
// one page that never measures. Serves an inert file unless
// GA_MEASUREMENT_ID is set on the service.
analytics.mount(app, 'trip-planner');

// The shared account, mounted at /api/auth - where this app's pages already
// post - so register, login, logout, password and the Face ID routes keep
// their URLs. It is registered BEFORE accounts.mount, so identity wins every
// path the two both define and this app's own copies are never reached.
//
// This app keeps its OWN users/<uid> record for what identity has no opinion
// about: aiAccess (who may spend Anthropic tokens), isAdmin, and the reset
// request flag. The uid is unchanged - both derive base64url of the lowercased
// email - so every existing trip stays owned by the same person.
const identity = identityLib.create({
  store: identityStore.store,
  secret: () => process.env.IDENTITY_SESSION_SECRET || '',
  app: 'trip-planner',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Trip Planner',
  mountPath: '/api/auth',
});

/** Does the SHARED account already say this person may spend tokens?
 *
 *  This app had its own aiAccess flag from when it was the only gate, and the
 *  two stopped agreeing the moment access could also be granted from the
 *  domain-wide admin panel: a grant made there did nothing here. The visible
 *  symptom was the owner's own second address being told to request
 *  permission for an app he runs, on an account the dashboard listed as
 *  already having it.
 *
 *  So identity wins where it says yes. It cannot say no: this app's own
 *  approval still stands on its own, so nothing that worked before stops. */
function grantedByIdentity(user) {
  return identityLib.hasAccess(user, 'trip-planner');
}

/** Identity says who; this app's own record says what they may do here.
 *  `uid` is kept alongside `id` because every route in this file reads
 *  req.user.uid, and renaming it would touch ownership checks on live data. */
async function attachProfile(req, _res, next) {
  if (req.user) {
    req.user.uid = req.user.id;
    // hasAccess is true for the owner whatever the access map says, so this
    // covers both "is the owner" and "was granted trip-planner".
    const shared = grantedByIdentity(req.user);
    const owner = req.user.admin === true;
    const own = await db.collection('users').doc(req.user.id).get().catch(() => null);
    if (own && own.exists) {
      const d = own.data();
      req.user.aiAccess = shared ? 'approved' : (d.aiAccess || 'none');
      req.user.isAdmin = owner || !!d.isAdmin;
      req.user.mustChangePassword = !!d.mustChangePassword;
      req.user.displayName = d.displayName || req.user.email;
    } else {
      // First sight of this account on this app. Give it a record so the
      // admin panel can see it and grant AI access.
      req.user.isAdmin = owner || Boolean(ADMIN_EMAIL && req.user.email === ADMIN_EMAIL);
      req.user.aiAccess = (shared || req.user.isAdmin) ? 'approved' : 'none';
      await db.collection('users').doc(req.user.id).set({
        email: req.user.email,
        aiAccess: req.user.aiAccess,
        isAdmin: req.user.isAdmin,
        createdAt: new Date().toISOString(),
      }, { merge: true }).catch(() => {});
    }
  }
  next();
}

/**
 * May this account spend, and on which tier? Returns null when it may not.
 *
 * The sweep's version of the gate the routes use, asked by uid rather than by
 * request - and it has to be the same question, or a watch would be checked
 * hourly for someone the app would refuse to their face.
 *
 * That question is now "is there credit left", not "did the admin approve
 * them". A watch runs on its owner's own allowance and stops when that is
 * gone, which is a limit that enforces itself every hour without anyone
 * deciding anything. The shared record is loaded either way, so the sweep can
 * tier a watch the same way the app tiers a request its owner made by hand.
 */
async function ownerAccount(uid) {
  if (!uid) return null;
  const shared = await identityStore.store.get('users', uid).catch(() => null);
  const account = shared ? { id: uid, ...shared } : { id: uid };
  const budget = identityLib.budgetFor(account);
  if (budget.unlimited || budget.remainingUsd > 0) return account;
  return null;
}

// Registered before identity.mount so it wins /api/auth/me: the page needs
// aiAccess and isAdmin, which are this app's business, not identity's.
app.get('/api/auth/me', identity.attachUser, attachProfile, (req, res) => {
  if (!req.user) return res.json({ signedIn: false });
  res.json({
    signedIn: true,
    uid: req.user.id,
    email: req.user.email,
    via: req.user.via,
    displayName: req.user.displayName || req.user.email,
    aiAccess: req.user.aiAccess || 'none',
    isAdmin: !!req.user.isAdmin,
    mustChangePassword: !!req.user.mustChangePassword,
    // This route shadows identity's own /me (registered first, on purpose -
    // aiAccess and isAdmin are this app's business). Anything identity
    // reports that the page needs has to be repeated here or it is invisible.
    budget: identityLib.budgetFor(req.user),
    byok: {
      supported: identity.byokEnabled(),
      present: Boolean(req.user.byok && req.user.byok.blob),
      last4: (req.user.byok && req.user.byok.last4) || null,
      addedAt: (req.user.byok && req.user.byok.addedAt) || null,
    },
  });
});

identity.mount(app);
app.use(attachProfile);
// Every Anthropic call through this client is now priced and recorded.
identity.meter(anthropic);

// The admin reset door, moved onto the identity record because that is where
// the password lives now. Registered before accounts.mount so these win over
// this app's originals, which would otherwise write a password nobody reads.
//
// There is still no mail sender on this project, so this and a Face ID session
// remain the only two ways back in for someone who forgets their password -
// see the reasoning in CLAUDE.md.
app.post('/api/auth/reset-request', async (req, res) => {
  try {
    const uid = identityLib.uidFor((req.body || {}).email);
    const user = await identityStore.store.get('users', uid);
    if (user) {
      // The flag lives on THIS app's record: it is what the admin panel here
      // lists, and it is this app's workflow, not identity's.
      await db.collection('users').doc(uid).set({ resetRequestedAt: new Date().toISOString() }, { merge: true });
    }
  } catch (err) {
    console.error('POST /api/auth/reset-request', err);
  }
  // The same answer either way, or this tells a stranger which addresses are
  // registered.
  res.json({ ok: true });
});

app.post('/api/admin/reset-password', requireLogin, accounts.requireAdmin, async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const target = await identityStore.store.get('users', userId);
    if (!target) return res.status(404).json({ error: 'No such user.' });

    // Returned exactly once and never stored in the clear.
    const password = require('crypto').randomBytes(9).toString('base64url');
    await identityStore.store.set('users', userId, {
      ...target,
      password: identityLib.makeHash(password),
      passwordChangedAt: new Date().toISOString(),
    });
    await db.collection('users').doc(userId).set({
      mustChangePassword: true,
      resetRequestedAt: null,
    }, { merge: true });
    await identity.log('password.admin-reset', req, { uid: userId, email: target.email });
    res.json({ ok: true, password, email: target.email });
  } catch (err) {
    console.error('POST /api/admin/reset-password', err);
    res.status(500).json({ error: 'Could not reset that password.' });
  }
});

accounts.mount(app);

function requireLoginOrCron(req, res, next) {
  const key = req.get('X-Cron-Key');
  if (CRON_SECRET && key && key === CRON_SECRET) {
    req.isCron = true;
    return next();
  }
  return requireLogin(req, res, next);
}

// Loads the trip and refuses unless it belongs to the caller. Every route that
// touches a specific trip goes through this - that is what keeps one user's
// trips invisible to another. 404 rather than 403 on someone else's trip, so
// the API doesn't confirm that an id exists.
/** A trip as the page and the model expect it: `days` back in [time, plan]
 *  pairs, whatever shape the document is in. Applied at every read, because a
 *  trip written by toStore() and handed out raw would render an itinerary of
 *  blank rows. */
function tripOut(id, data) {
  const out = { id, ...data };
  if (Array.isArray(data && data.days) && data.days.length) {
    try { out.days = schedule.fromStore(data.days); } catch (e) { out.days = []; }
  }
  // When the trip is, worked out once here so the Overview's countdown and
  // weather agree with each other. null when "When" gives nothing to go on.
  out.dates = tripDates(out);
  return out;
}

async function loadOwnedTrip(req, res) {
  // The example trip is served from code (see demo.js) and every route that
  // would change a trip comes through here, so this one check covers all of
  // them: chat, lock, watches, the itinerary, the details form.
  if (req.params.id === demo.DEMO_ID) {
    res.status(403).json({ error: "That's the example trip. Sign in and start your own to change anything.", demo: true });
    return null;
  }
  const ref = db.collection('trips').doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) {
    res.status(404).json({ error: 'Trip not found.' });
    return null;
  }
  const data = doc.data();
  if (!req.user || data.ownerId !== req.user.uid) {
    res.status(404).json({ error: 'Trip not found.' });
    return null;
  }
  return { ref, doc, data };
}

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Weather for the Overview ----------
 * No model call, so no budget: login and ownership only. See weather.js for
 * the sources and why. Every failure is an ordinary 200 saying there is no
 * weather, because the Overview must never look broken over decoration. */
const weather = weatherLib.create();

// Nominatim's usage policy: no more than one request a second, from the whole
// application. Volume here is tiny, but the policy is not about volume.
let geocodeChain = Promise.resolve();
function geocodePolitely(query) {
  const run = geocodeChain.then(() => weather.geocode(query));
  geocodeChain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}

/** A trip's place: stored on the trip, looked up again only when the
 *  destination text changes. A search that found nothing is remembered too
 *  (`none`), so a vague destination does not re-ask on every visit; a search
 *  that FAILED is not, so a network blip does not stick. */
async function placeFor(ref, data) {
  const dest = String((data && data.destination) || '').trim();
  if (!dest) return null;
  if (data.geo && data.geo.query === dest) return data.geo.none ? null : data.geo;
  const geo = await geocodePolitely(dest);
  if (ref) await ref.update({ geo: geo || { query: dest, none: true } }).catch(() => {});
  return geo;
}

async function weatherFor(ref, data) {
  try {
    const geo = await placeFor(ref, data);
    return await weather.forTrip(geo, tripDates(tripOut('', data)));
  } catch (err) {
    console.error('trip weather', err.message);
    return { status: 'unavailable', attribution: weatherLib.ATTRIBUTION };
  }
}

// The example trip is served from code, so its place lives in memory.
let demoGeo;
app.get(`/api/trips/${demo.DEMO_ID}/weather`, async (req, res) => {
  const data = demo.DEMO_TRIP;
  try {
    if (demoGeo === undefined) demoGeo = await geocodePolitely(data.destination);
    res.json(await weather.forTrip(demoGeo, tripDates(data)));
  } catch (err) {
    res.json({ status: 'unavailable', attribution: weatherLib.ATTRIBUTION });
  }
});

app.get('/api/trips/:id/weather', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  res.set('Cache-Control', 'private, max-age=600');
  res.json(await weatherFor(owned.ref, owned.data));
});



// ---------------------------------------------------------------------------
// Trips - the core data model. One document per trip; chat history and
// watched listings live in subcollections underneath it.
// ---------------------------------------------------------------------------
function tripSummary(id, data) {
  return {
    id,
    name: data.name || 'Untitled trip',
    destination: data.destination || '',
    dateRange: data.dateRange || '',
    status: data.status || 'planning',
    dayCount: Array.isArray(data.days) ? data.days.length : 0,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    lockedAt: data.lockedAt || null,
  };
}

app.get('/api/trips', requireLogin, async (req, res) => {
  try {
    const snap = await db.collection('trips')
      .where('ownerId', '==', req.user.uid)
      .orderBy('updatedAt', 'desc').limit(100).get();
    res.json(snap.docs.map((d) => tripSummary(d.id, d.data())));
  } catch (err) {
    console.error('GET /api/trips', err);
    res.status(500).json({ error: 'Failed to load trips.' });
  }
});

app.post('/api/trips', requireLogin, async (req, res) => {
  try {
    const { name, destination, dateRange, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const now = new Date().toISOString();
    const ref = await db.collection('trips').add({
      name: String(name).slice(0, 120),
      destination: typeof destination === 'string' ? destination.slice(0, 200) : '',
      dateRange: typeof dateRange === 'string' ? dateRange.slice(0, 120) : '',
      notes: typeof notes === 'string' ? notes.slice(0, 4000) : '',
      status: 'planning',
      days: [],
      ownerId: req.user.uid,
      createdAt: now,
      updatedAt: now,
      lockedAt: null,
    });
    const doc = await ref.get();
    res.json(tripOut(doc.id, doc.data()));
  } catch (err) {
    console.error('POST /api/trips', err);
    res.status(500).json({ error: 'Could not create trip.' });
  }
});

// Anyone may look at the example trip - no session, no account. It is what
// the sign-in wall used to hide: what the app actually does.
app.get(`/api/trips/${demo.DEMO_ID}`, (req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.json(Object.assign({ id: demo.DEMO_ID, demo: true }, demo.DEMO_TRIP, { dates: tripDates(demo.DEMO_TRIP) }));
});
app.get(`/api/trips/${demo.DEMO_ID}/messages`, (req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.json(demo.DEMO_MESSAGES.map((m, i) => Object.assign({ id: 'demo-' + i }, m)));
});
app.get(`/api/trips/${demo.DEMO_ID}/watches`, (req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.json(demo.DEMO_WATCHES.map((w, i) => Object.assign({ id: 'demo-' + i }, w)));
});

// Copy the example into an account. The demo is the best introduction this
// app has, and the shortest path from browsing it to using it is not making
// someone retype five days of plan. Everything comes across except what
// belongs to the example: it arrives as a fresh trip in planning, with the
// chat and the watch history left behind.
app.post(`/api/trips/${demo.DEMO_ID}/copy`, requireLogin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const doc = await db.collection('trips').add({
      name: demo.DEMO_TRIP.name,
      destination: demo.DEMO_TRIP.destination,
      dateRange: demo.DEMO_TRIP.dateRange,
      notes: demo.DEMO_TRIP.notes,
      // The example's itinerary goes through toStore like any other: written
      // raw, the nested arrays make "Start my own from this" fail with the
      // same INVALID_ARGUMENT that broke Apply.
      days: schedule.toStore(demo.DEMO_TRIP.days),
      status: 'planning',
      ownerId: req.user.uid,
      copiedFrom: demo.DEMO_ID,
      createdAt: now,
      updatedAt: now,
    });
    // The watches come too - they are the part people would not think to
    // recreate, and they are what makes the app do something while you sleep.
    for (const w of demo.DEMO_WATCHES) {
      await doc.collection('watches').add({
        kind: w.kind, label: w.label, criteria: w.criteria, url: w.url,
        intervalHours: w.intervalHours,
        lastCheckedAt: null, lastResult: null, history: [],
      });
    }
    identity.log('trip.copied', req, { detail: demo.DEMO_ID });
    res.json({ id: doc.id, ok: true });
  } catch (err) {
    console.error('POST /api/trips/demo/copy', err);
    res.status(500).json({ error: 'Could not copy the example.' });
  }
});

app.get('/api/trips/:id', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    res.json(tripOut(owned.doc.id, owned.data));
  } catch (err) {
    console.error('GET /api/trips/:id', err);
    res.status(500).json({ error: 'Failed to load trip.' });
  }
});

app.patch('/api/trips/:id', requireLogin, async (req, res) => {
  try {
    const { name, destination, dateRange, notes } = req.body || {};
    const patch = { updatedAt: new Date().toISOString() };
    if (typeof name === 'string' && name.trim()) patch.name = name.slice(0, 120);
    if (typeof destination === 'string') patch.destination = destination.slice(0, 200);
    if (typeof dateRange === 'string') patch.dateRange = dateRange.slice(0, 120);
    if (typeof notes === 'string') patch.notes = notes.slice(0, 4000);
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    await owned.ref.update(patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/trips/:id', err);
    res.status(500).json({ error: 'Could not update trip.' });
  }
});

app.delete('/api/trips/:id', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    await owned.ref.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/trips/:id', err);
    res.status(500).json({ error: 'Could not delete trip.' });
  }
});

// Locking is deliberately just a status flip, not a data migration: a locked
// trip is still the same document, still fully editable through chat, still
// in the same app. It stops showing up as an active planning target and
// drops out of the watch batch-check below. That is the entire "make it its
// own thing" mechanism - see CLAUDE.md.
app.post('/api/trips/:id/lock', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const now = new Date().toISOString();
    await owned.ref.update({ status: 'locked', lockedAt: now, updatedAt: now });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/trips/:id/lock', err);
    res.status(500).json({ error: 'Could not lock trip.' });
  }
});

app.post('/api/trips/:id/unlock', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    await owned.ref.update({ status: 'planning', lockedAt: null, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/trips/:id/unlock', err);
    res.status(500).json({ error: 'Could not unlock trip.' });
  }
});

// ---------------------------------------------------------------------------
// Keeping a long answer alive on a phone.
//
// COPY of the same helper in santa-rosa-beach-trip's server.js, added for the
// same measured reason: a chat question that searches the web takes two or
// three minutes, and for all of it not one byte crosses the wire. iOS Safari
// on a mobile network drops a connection that idle, reports "Load failed",
// and the app looks broken while the server is still working happily.
//
// So the response starts immediately and drips a space every few seconds
// until the real body is ready. Leading whitespace is legal JSON, so the
// browser still parses it with an unchanged res.json().
//
// The cost: headers go out before the outcome is known, so a failure cannot
// use a status code. It comes back as 200 with an { error } body, and the
// client checks for that. Everything that CAN fail with a status - the 400,
// the sign-in and access gates, the 404 for someone else's trip - therefore
// has to happen BEFORE this is called.
// ---------------------------------------------------------------------------
const HEARTBEAT_MS = 5000;

function streamedJson(res) {
  res.status(200);
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  // Ask any proxy in the path not to buffer us, which would undo the point.
  res.set('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // One byte straight away, not after the first interval: flushed headers
  // alone do not always wake a buffering proxy.
  const beat = () => { try { res.write(' '); } catch (e) { /* client went away */ } };
  beat();
  const timer = setInterval(beat, HEARTBEAT_MS);
  let done = false;
  return function send(payload) {
    if (done) return;
    done = true;
    clearInterval(timer);
    try { res.end(JSON.stringify(payload)); } catch (e) { /* client went away */ }
  };
}

// ---------------------------------------------------------------------------
// Chat - per trip. Same propose-then-confirm shape as santa-rosa-beach-trip:
// the model can draft a full day-by-day plan, but nothing is saved to the
// trip until the user taps Apply in the UI.
// ---------------------------------------------------------------------------
// One place to change what each tier runs on.
const MODEL_TIERS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const SCHEDULE_TOOL = {
  name: 'propose_schedule_change',
  description:
    'Propose the trip\'s day-by-day schedule, or a change to it. Call this when the user asks you to draft, ' +
    'add to, remove from, or alter the itinerary - never just to answer a question. The change is NOT applied ' +
    'automatically: the user sees your proposal in the app and must tap Apply before it is saved.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence describing the proposed plan or change.' },
      days: {
        type: 'array',
        description: 'The COMPLETE day-by-day array, in date order - not a diff. Re-emit every day.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short day title.' },
            date: { type: 'string', description: 'ISO date, e.g. "2027-03-05", if known - else a placeholder like "Day 1".' },
            dateLabel: { type: 'string', description: 'Display label, e.g. "Fri, Mar 5" or "Day 1".' },
            blocks: {
              type: 'array',
              description: 'Ordered [time-or-period, plan text] pairs for that day.',
              items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
            },
            tip: { type: 'string', description: 'One practical tip for that day.' },
          },
          required: ['title', 'date', 'dateLabel', 'blocks', 'tip'],
        },
      },
    },
    required: ['summary', 'days'],
  },
};

app.get('/api/trips/:id/messages', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const snap = await owned.ref.collection('messages')
      .orderBy('askedAt', 'asc').limit(200).get();
    res.json(snap.docs.map((d) => {
      const m = { id: d.id, ...d.data() };
      // Back into [time, plan] pairs, or the Apply card on an old message
      // would draw a row of blanks and save one.
      if (m.proposedChange && Array.isArray(m.proposedChange.days)) {
        try { m.proposedChange = { ...m.proposedChange, days: schedule.fromStore(m.proposedChange.days) }; }
        catch (e) { m.proposedChange = null; }
      }
      return m;
    }));
  } catch (err) {
    console.error('GET /api/trips/:id/messages', err);
    res.status(500).json({ error: 'Failed to load chat history.' });
  }
});

app.post('/api/trips/:id/chat', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required.' });

    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const tripRef = owned.ref;
    // tripOut, not owned.data: the stored `blocks` are {time, plan} maps and
    // the model is told - correctly - that a block is a [time, plan] pair.
    // Showing it one shape and demanding another is how a model starts
    // "correcting" an itinerary nobody asked it to touch.
    const trip = tripOut(owned.doc.id, owned.data);

    // Past this line nothing can fail with a status code, so start the drip.
    send = streamedJson(res);

    const systemPrompt =
      'You are helping research and plan a trip: "' + (trip.name || 'Untitled trip') + '"' +
      (trip.destination ? ', to ' + trip.destination : '') +
      (trip.dateRange ? ', ' + trip.dateRange : '') + '. ' +
      (trip.notes ? 'Notes so far: ' + trip.notes + '. ' : '') +
      'Use web search for current info - flights, hotels, activities, weather, prices. Be specific and concrete, ' +
      'never invent a price or availability - say so if you cannot verify something. If the user asks you to ' +
      'draft or change the day-by-day itinerary, call the propose_schedule_change tool with the COMPLETE days ' +
      'array - never call it just to answer a question with no requested plan or change. Keep every day and ' +
      'every entry the user did not ask you to touch exactly as it was: what you return replaces the whole ' +
      'itinerary. You have the itinerary below and can change it, so never say you have no itinerary or ask ' +
      'for one to be shared with you, and when asked for a change make a concrete suggestion and propose it ' +
      'rather than asking which of several options they want, unless the request is genuinely ambiguous.\n\n' +
      'Current itinerary:\n' + JSON.stringify(trip.days || []) + '\n\n' +
      'You can also keep the trip\'s bookings - flights, where they are staying, rental cars, restaurant ' +
      'reservations, tours, tickets - with the propose_bookings tool. When the user tells you about a booking or ' +
      'asks to add, change or remove one, propose the COMPLETE updated list, keeping every other booking and its id ' +
      'exactly as it was. Never invent a confirmation number.\n\nCurrent bookings:\n' +
      JSON.stringify(bookingsLib.validate(owned.data.bookings || []));

    // Free accounts run on Haiku, which costs half what Sonnet does and is
    // plenty for trip chat; the owner, Pro, and anyone on their own key get
    // Sonnet. planFor also hands back the web-search tool version this model
    // accepts - Haiku 400s on the newer one, so they must move together.
    const plan = identityLib.planFor(req.user, MODEL_TIERS);
    const response = await completeTurn({
      model: plan.model,
      max_tokens: 8192,
      system: systemPrompt,
      tools: [plan.webSearch, SCHEDULE_TOOL, bookingsLib.TOOL],
      messages: [{ role: 'user', content: question }],
    }, req.user);

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolBlock = response.content.find((b) => b.type === 'tool_use' && b.name === 'propose_schedule_change');

    let answer = textBlocks.map((b) => b.text).join('\n\n');
    let proposedChange = null;
    if (toolBlock && toolBlock.input && Array.isArray(toolBlock.input.days) && toolBlock.input.days.length) {
      proposedChange = {
        summary: typeof toolBlock.input.summary === 'string' ? toolBlock.input.summary : 'Itinerary update',
        // Checked here, not only on apply: an Apply button that leads to a 400
        // is worse than a proposal that was never offered.
        days: schedule.validate(toolBlock.input.days),
        // Which itinerary this was written against. A proposal is a COMPLETE
        // replacement, so applying one written before a later change would
        // silently undo that change - see /schedule/apply. daysUpdatedAt, not
        // updatedAt: every chat turn and every lock moves updatedAt, and a
        // guard keyed to it would refuse proposals for no reason.
        basedOn: owned.data.daysUpdatedAt || null,
      };
      if (!answer) {
        answer = "I've drafted a plan: " + proposedChange.summary + ' Review it below and tap Apply to save it.';
      }
    }
    const bookingsBlock = response.content.find((b) => b.type === 'tool_use' && b.name === 'propose_bookings');
    let proposedBookings = null;
    if (bookingsBlock && bookingsBlock.input && Array.isArray(bookingsBlock.input.bookings)) {
      proposedBookings = {
        summary: String(bookingsBlock.input.summary || 'Bookings update').slice(0, 300),
        bookings: bookingsLib.validate(bookingsBlock.input.bookings),
        // Same guard as the itinerary, on its own clock: a bookings list is a
        // complete replacement too.
        basedOn: owned.data.bookingsUpdatedAt || null,
      };
      if (!answer) answer = 'Here are the bookings: ' + proposedBookings.summary + ' Tap Apply to save them.';
    }
    if (!answer) {
      // Distinguish "nothing to say" from "ran out of room": the first is an
      // answer, the second is a failure wearing an answer's clothes.
      answer = response.stop_reason === 'max_tokens'
        ? "That search ran long and I ran out of room before writing the answer. Ask again, or narrow it a little."
        : "I didn't have anything to add to that — try rephrasing?";
    }

    const askedAt = new Date().toISOString();
    const saved = await tripRef.collection('messages').add({
      question,
      answer,
      // The proposal is stored too, so reopening the trip still shows the
      // Apply card - and it carries `days`, so it needs the same nested-array
      // treatment the trip itself does. Without it the whole chat turn fails
      // on the write, AFTER the model has been paid for and answered.
      proposedChange: proposedChange
        ? { ...proposedChange, days: schedule.toStore(proposedChange.days) }
        : null,
      proposedBookings,
      askedAt,
      answeredAt: new Date().toISOString(),
    });
    await tripRef.update({ updatedAt: new Date().toISOString() });

    // The id, so the page can tell the server what became of the proposal.
    send({ id: saved.id, answer, proposedChange, proposedBookings });
  } catch (err) {
    console.error('POST /api/trips/:id/chat', err);
    // Same reason as the self-test above: without this the reason is lost.
    try {
      await db.collection('control').doc('last-chat-error').set({
        at: new Date().toISOString(),
        status: err.status || null,
        name: err.name || null,
        message: String(err.message || err).slice(0, 600),
      });
    } catch (e) { /* never let the diagnostic break the response */ }
    if (send) return send({ error: 'Chat request failed.' });
    res.status(500).json({ error: 'Chat request failed.' });
  }
});

/** What became of a proposal, written on the chat message that carried it.
 *
 *  This used to live only in the page's memory, so the next time the chat
 *  was loaded from the server - reopening the trip, coming back to the app -
 *  every Apply card came back with its buttons, as if nothing had been
 *  decided. Reported 2026-09-23 as "after applying to itinerary it stays".
 *  Worse than untidy: tapping one again would replace the whole itinerary
 *  with a plan from before any later change. */
async function markProposal(tripRef, messageId, state, which = 'change') {
  if (!messageId || typeof messageId !== 'string' || messageId.length > 64) return;
  const ref = tripRef.collection('messages').doc(messageId);
  const snap = await ref.get();
  // One chat turn can propose both an itinerary and bookings, and each is
  // decided on its own, so each has its own state field.
  const field = which === 'bookings' ? 'proposedBookings' : 'proposedChange';
  if (!snap.exists || !snap.data()[field]) return;
  const stateField = which === 'bookings' ? 'bookingsState' : 'changeState';
  await ref.update({ [stateField]: state, changeHandledAt: new Date().toISOString() });
}

app.post('/api/trips/:id/schedule/apply', requireLogin, async (req, res) => {
  try {
    const body = req.body || {};
    const days = schedule.validate(body.days);
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;

    // A proposal written against an older itinerary would undo whatever
    // changed since - on another device, or from a later proposal already
    // applied. Refuse it with the current itinerary attached. `basedOn` is
    // optional so a card from before this existed still applies as it did.
    if (Object.prototype.hasOwnProperty.call(body, 'basedOn')) {
      const now = owned.data.daysUpdatedAt || null;
      if ((body.basedOn || null) !== now) {
        await markProposal(owned.ref, body.messageId, 'stale').catch(() => {});
        return res.status(409).json({
          error: 'The itinerary changed after this was suggested, so applying it would undo that change. '
            + 'Ask again for a plan based on the current one.',
          days: schedule.fromStore(owned.data.days || []),
        });
      }
    }

    // toStore, not days: Firestore cannot hold an array inside an array, and
    // `blocks` is a list of [time, plan] pairs. Writing the pairs straight in
    // fails with "Property array contains an invalid nested entity", which is
    // what Apply had been doing every time. See schedule.js.
    const at = new Date().toISOString();
    await owned.ref.update({ days: schedule.toStore(days), updatedAt: at, daysUpdatedAt: at });
    await markProposal(owned.ref, body.messageId, 'applied').catch((e) => console.error('markProposal', e));
    res.json({ ok: true, days });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('POST /api/trips/:id/schedule/apply', err);
    res.status(500).json({ error: 'Could not save the itinerary.' });
  }
});

/** Save a proposed bookings list. Same shape and same guard as the itinerary:
 *  the tap is the only write, and a list written before a later change is
 *  refused rather than allowed to undo it. */
app.post('/api/trips/:id/bookings/apply', requireLogin, async (req, res) => {
  try {
    const body = req.body || {};
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    if (Object.prototype.hasOwnProperty.call(body, 'basedOn')
        && (body.basedOn || null) !== (owned.data.bookingsUpdatedAt || null)) {
      await markProposal(owned.ref, body.messageId, 'stale', 'bookings').catch(() => {});
      return res.status(409).json({
        error: 'The bookings changed after this was suggested, so applying it would undo that change. Ask again.',
        bookings: bookingsLib.validate(owned.data.bookings || []),
      });
    }
    const bookings = bookingsLib.validate(body.bookings);
    const at = new Date().toISOString();
    await owned.ref.update({ bookings, bookingsUpdatedAt: at, updatedAt: at });
    await markProposal(owned.ref, body.messageId, 'applied', 'bookings').catch((e) => console.error('markProposal', e));
    res.json({ ok: true, bookings });
  } catch (err) {
    console.error('POST /api/trips/:id/bookings/apply', err);
    res.status(500).json({ error: 'Could not save the bookings.' });
  }
});

/** Remove one booking - the person's own tap on the Overview, no model. */
app.delete('/api/trips/:id/bookings/:bid', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const before = bookingsLib.validate(owned.data.bookings || []);
    const bookings = before.filter((b) => b.id !== req.params.bid);
    if (bookings.length === before.length) return res.status(404).json({ error: 'No such booking.' });
    const at = new Date().toISOString();
    await owned.ref.update({ bookings, bookingsUpdatedAt: at, updatedAt: at });
    res.json({ ok: true, bookings });
  } catch (err) {
    console.error('DELETE /api/trips/:id/bookings/:bid', err);
    res.status(500).json({ error: 'Could not remove that.' });
  }
});

/** Discarding is a decision too, and it has to survive a reload the same way. */
app.post('/api/trips/:id/messages/:mid/discard', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    await markProposal(owned.ref, req.params.mid, 'discarded', (req.body || {}).which === 'bookings' ? 'bookings' : 'change');
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/trips/:id/messages/:mid/discard', err);
    res.status(500).json({ error: 'Could not save that.' });
  }
});

/* ==========================================================================
 * Reading Gmail for bookings someone already has
 *
 * Consent is the feature, not the paperwork around it. Three rules hold the
 * shape together, and each is enforced here rather than promised in copy:
 *
 *   1. The query is fixed (gmail.js), so "we only look at travel senders" is
 *      something the code guarantees and the account page can print.
 *   2. Message bodies are never written down. They are fetched, read once by
 *      the extractor, and dropped with the request.
 *   3. Nothing becomes a trip without a tap. /scan proposes; /import writes.
 * ========================================================================== */

const gmail = gmailLib.create({});
// Same box the BYOK keys live in: AES-256-GCM with the uid as additional
// authenticated data, so a token row copied into another account fails to
// decrypt rather than quietly working.
const tokenVault = byokLib.create({ secret: () => process.env.BYOK_ENCRYPTION_KEY || '' });

const gmailReady = () => gmail.enabled() && tokenVault.enabled();

/** What the account page needs to describe the connection honestly. */
app.get('/api/gmail', requireLogin, async (req, res) => {
  const own = await db.collection('users').doc(req.user.uid).get().catch(() => null);
  const g = (own && own.exists && own.data().gmail) || null;
  res.json({
    available: gmailReady(),
    connected: Boolean(g && g.refresh && !g.expiredAt),
    // Google ended it (see gmail.js on the seven-day Testing-mode limit).
    // The page offers Connect again, with a line saying why.
    expired: Boolean(g && g.expiredAt),
    address: (g && g.address) || null,
    connectedAt: (g && g.connectedAt) || null,
    // The promise, served from the same constant the query is built from, so
    // the page cannot drift from what the code actually does.
    senders: gmailLib.TRAVEL_SENDERS,
    // The same list by kind, so a consent screen can say "car rentals,
    // restaurants" rather than naming four domains and "and 98 more".
    senderGroups: gmailLib.SENDER_GROUPS,
    monthsBack: gmailLib.MONTHS_BACK,
    maxMessages: gmailLib.MAX_MESSAGES,
  });
});

/** Off to Google. The state is signed and carries the uid, so the callback
 *  cannot be used to hang someone else's mailbox off this account. */
app.get('/api/gmail/connect', requireLogin, (req, res) => {
  if (!gmailReady()) return res.status(503).json({ error: 'Gmail is not configured on this deployment.' });
  const payload = `${req.user.uid}.${Date.now()}`;
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(payload).digest('base64url');
  res.redirect(gmail.authUrl(`${payload}.${mac}`));
});

const STATE_TTL_MS = 10 * 60 * 1000;

app.get('/api/gmail/callback', requireLogin, async (req, res) => {
  const fail = (why) => res.redirect('/?gmail=' + encodeURIComponent(why));
  try {
    if (!gmailReady()) return fail('unavailable');
    if (req.query.error) return fail('declined');

    const [uid, at, mac] = String(req.query.state || '').split('.');
    const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(`${uid}.${at}`).digest('base64url');
    // Length first: timingSafeEqual throws on a mismatch rather than
    // returning false.
    if (!mac || mac.length !== expected.length
        || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return fail('bad-state');
    if (uid !== req.user.uid) return fail('bad-state');
    if (!(Date.now() - Number(at) < STATE_TTL_MS)) return fail('expired');

    const tokens = await gmail.exchange(String(req.query.code || ''));
    if (!tokens.refresh_token) {
      // Google withholds it when the grant already exists. authUrl asks for
      // prompt=consent precisely so this cannot happen; if it does, the
      // connection would die in an hour and look like a bug.
      return fail('no-refresh-token');
    }
    const address = await gmail.address(tokens.access_token).catch(() => null);

    await db.collection('users').doc(req.user.uid).set({
      gmail: {
        refresh: tokenVault.encrypt(req.user.uid, tokens.refresh_token),
        address,
        connectedAt: new Date().toISOString(),
        // Explicitly, because this is a merge write and Firestore merges
        // nested maps: without it an old expiry would outlive the reconnect.
        expiredAt: null,
      },
    }, { merge: true });
    await identity.log('gmail.connected', req, { uid: req.user.uid, detail: address || '' });
    res.redirect('/?gmail=connected');
  } catch (err) {
    console.error('GET /api/gmail/callback', err);
    fail('failed');
  }
});

/** Hand the grant back to Google, then forget it. In that order: if the
 *  revoke fails we still drop our copy, but we never drop our copy while
 *  leaving Google believing the app still has access. */
app.delete('/api/gmail', requireLogin, async (req, res) => {
  try {
    const own = await db.collection('users').doc(req.user.uid).get();
    const g = own.exists ? own.data().gmail : null;
    if (g && g.refresh) {
      const token = tokenVault.decrypt(req.user.uid, g.refresh);
      if (token) await gmail.revoke(token);
    }
    await db.collection('users').doc(req.user.uid).set({ gmail: null }, { merge: true });
    await identity.log('gmail.disconnected', req, { uid: req.user.uid });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/gmail', err);
    res.status(500).json({ error: 'Could not disconnect.' });
  }
});

const ITINERARY_TOOL = {
  name: 'found_trips',
  description: 'Report the trips found in these booking emails.',
  input_schema: {
    type: 'object',
    properties: {
      trips: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short trip name, e.g. "Lisbon, October"' },
            destination: { type: 'string' },
            dateRange: { type: 'string', description: 'e.g. "Oct 3-10, 2026"' },
            notes: { type: 'string', description: 'Confirmation numbers, flight numbers, hotel names' },
            bookings: { ...bookingsLib.TOOL.input_schema.properties.bookings,
              description: 'Each booking in this trip on its own - flight, stay, rental car, reservation, tour - with its confirmation number.' },
            sourceIds: { type: 'array', items: { type: 'string' }, description: 'ids of the emails this came from' },
          },
          required: ['name'],
        },
      },
    },
    required: ['trips'],
  },
};

/**
 * Look, extract, propose. Writes nothing.
 *
 * Behind requireBudget because it is a model call like any other, and behind
 * the same daily ceiling. The emails are read into the prompt and go out of
 * scope with the request.
 */
/** The refresh token for the signed-in person, or an error that can still
 *  be sent as a status - call it BEFORE streamedJson. */
async function gmailRefreshFor(uid) {
  if (!gmailReady()) return { status: 503, error: 'Gmail is not configured on this deployment.' };
  const own = await db.collection('users').doc(uid).get();
  const g = own.exists ? own.data().gmail : null;
  if (!g || !g.refresh) return { status: 400, error: 'Connect Gmail first.', needsConnect: true };
  if (g.expiredAt) return { status: 400, error: GMAIL_EXPIRED, needsConnect: true };
  const refresh = tokenVault.decrypt(uid, g.refresh);
  if (!refresh) return { status: 400, error: 'That connection needs setting up again.', needsConnect: true };
  return { refresh };
}

/** Google refused the stored connection. Remember that, so the page stops
 *  saying "connected" and offers to reconnect, and say so in words. */
const GMAIL_EXPIRED = 'Your Gmail connection has ended \u2014 it was removed in your Google account, or Google ended it. '
  + 'Connect Gmail again and this will work.';
async function markGmailExpired(uid) {
  await db.collection('users').doc(uid).set({ gmail: { expiredAt: new Date().toISOString() } }, { merge: true }).catch(() => {});
}

/** The booking emails, through the fixed query. Read into memory, returned,
 *  and dropped by the caller - never written anywhere. */
async function readBookingMail(refresh) {
  const access = await gmail.accessFrom(refresh);
  const ids = await gmail.search(access);
  const messages = [];
  for (const id of ids) {
    const m = await gmail.message(access, id).catch(() => null);
    if (m) messages.push(m);
  }
  return { ids, messages };
}

app.post('/api/gmail/scan', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    const conn = await gmailRefreshFor(req.user.uid);
    if (conn.error) return res.status(conn.status).json({ error: conn.error });

    // Past here nothing may fail with a status: the drip has started.
    send = streamedJson(res);

    const { ids, messages } = await readBookingMail(conn.refresh);
    if (!ids.length) return send({ trips: [], looked: 0 });
    if (!messages.length) return send({ trips: [], looked: ids.length });

    const plan = identityLib.planFor(req.user, MODEL_TIERS);
    const response = await completeTurn({
      model: plan.model,
      max_tokens: 8192,
      system:
        'You are reading a traveller\'s booking confirmation emails and grouping them into trips. ' +
        'Group bookings that belong to the same journey - an outbound flight, a hotel and a return flight ' +
        'are ONE trip, not three. A rental car, a tour, a restaurant reservation or a parking booking at the ' +
        'same place and dates belongs to that trip too: put it in the trip\'s notes with its time and ' +
        'confirmation number, not in a trip of its own. A restaurant or parking booking that is not part of ' +
        'any journey is not a trip - leave it out. Give each trip a short name, the destination, the dates ' +
        'as a readable range, and notes carrying the confirmation numbers, flight numbers, hotel names and ' +
        'rental-car pickup and return times exactly as written. Also list each booking on its own in ' +
        'bookings, so the trip can show it as a card: its kind, a short title, the company, the confirmation ' +
        'number, when it starts and ends, the address and phone if given, a https link to manage it if the ' +
        'email has one, and its total price in dollars when the email states one. ' +
        'Ignore marketing, fare alerts, loyalty statements and anything already in the past. ' +
        'If nothing is a real booking, report no trips. Never invent a detail that is not in the emails.',
      tools: [ITINERARY_TOOL],
      messages: [{ role: 'user', content: JSON.stringify(messages.map((m) => ({
        id: m.id, from: m.from, subject: m.subject, date: m.date, body: m.body,
      }))) }],
    }, req.user);

    const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'found_trips');
    const found = (block && block.input && Array.isArray(block.input.trips)) ? block.input.trips : [];

    // Carry back where each one came from, so the review screen can show the
    // sender and subject rather than asking anyone to trust a summary.
    const byId = new Map(messages.map((m) => [m.id, m]));
    send({
      looked: messages.length,
      trips: found.slice(0, 20).map((t) => ({
        name: String(t.name || '').slice(0, 120),
        destination: String(t.destination || '').slice(0, 200),
        dateRange: String(t.dateRange || '').slice(0, 120),
        notes: String(t.notes || '').slice(0, 4000),
        bookings: bookingsLib.validate(t.bookings),
        sources: (t.sourceIds || []).map((id) => byId.get(id)).filter(Boolean)
          .map((m) => ({ from: m.from, subject: m.subject, date: m.date })),
      })),
    });
  } catch (err) {
    console.error('POST /api/gmail/scan', err);
    if (err.status === 401) await markGmailExpired(req.user.uid);
    if (send) return send({ error: err.status === 401 ? GMAIL_EXPIRED : 'Could not read those emails.', needsConnect: err.status === 401 });
    res.status(err.status || 500).json({ error: 'Could not read those emails.' });
  }
});

/**
 * Find THIS trip's bookings in Gmail. The trip-level scan above answers "what
 * trips do I have"; this answers "what have I booked for this one", and
 * answers it the way chat does - as a proposed bookings list filed into the
 * trip's chat, with Apply and Discard, because it is a model's reading of
 * someone's mail and the person decides what is kept.
 */
app.post('/api/trips/:id/gmail-bookings', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const conn = await gmailRefreshFor(req.user.uid);
    if (conn.error) return res.status(conn.status).json({ error: conn.error, needsConnect: !!conn.needsConnect });

    send = streamedJson(res);
    const trip = tripOut(owned.doc.id, owned.data);
    const question = 'Check my Gmail for this trip\u2019s bookings';
    const { messages } = await readBookingMail(conn.refresh);
    const current = bookingsLib.validate(owned.data.bookings || []);

    let answer; let proposedBookings = null;
    if (!messages.length) {
      answer = 'I looked through your booking emails and found none from the travel companies I check.';
    } else {
      const plan = identityLib.planFor(req.user, MODEL_TIERS);
      const response = await completeTurn({
        model: plan.model,
        max_tokens: 8192,
        system:
          'You are reading someone\'s booking confirmation emails to find the bookings for ONE trip: "' + (trip.name || '') + '"' +
          (trip.destination ? ', ' + trip.destination : '') +
          (trip.dates ? ', ' + trip.dates.start + ' to ' + trip.dates.end : (trip.dateRange ? ', ' + trip.dateRange : '')) + '. ' +
          'Only bookings for this trip count - its place and dates. Ignore other trips, marketing and receipts for ' +
          'things already done. Write a short answer saying what you found and which email each came from (sender ' +
          'and subject). If any are missing from the current list, call propose_bookings with the COMPLETE list - ' +
          'every current booking kept exactly, with its id, plus the new ones. If nothing is missing, say so and do ' +
          'not call the tool. Never invent a detail that is not in the emails.\n\nCurrent bookings:\n' + JSON.stringify(current),
        tools: [bookingsLib.TOOL],
        messages: [{ role: 'user', content: JSON.stringify(messages.map((m) => ({ from: m.from, subject: m.subject, date: m.date, body: m.body }))) }],
      }, req.user);
      const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'propose_bookings');
      answer = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
      if (block && block.input && Array.isArray(block.input.bookings)) {
        proposedBookings = {
          summary: String(block.input.summary || 'Bookings from Gmail').slice(0, 300),
          bookings: bookingsLib.validate(block.input.bookings),
          basedOn: owned.data.bookingsUpdatedAt || null,
        };
      }
      if (!answer) answer = proposedBookings
        ? 'From your booking emails: ' + proposedBookings.summary
        : 'I read ' + messages.length + ' booking emails and found nothing for this trip that is not already here.';
    }
    const at = new Date().toISOString();
    const saved = await owned.ref.collection('messages').add({
      question, answer, proposedChange: null, proposedBookings, askedAt: at, answeredAt: at,
    });
    send({ id: saved.id, question, answer, proposedBookings });
  } catch (err) {
    console.error('POST /api/trips/:id/gmail-bookings', err);
    if (err.status === 401) await markGmailExpired(req.user.uid);
    if (send) return send({ error: err.status === 401 ? GMAIL_EXPIRED : 'Could not read those emails.', needsConnect: err.status === 401 });
    res.status(500).json({ error: 'Could not read those emails.' });
  }
});

/**
 * Things to do near a trip. A model call with web search, so it sits behind
 * the budget like every other one; saved on the trip so the Overview can draw
 * it without paying again. See ideas.js.
 */
app.post('/api/trips/:id/ideas', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const trip = tripOut(owned.doc.id, owned.data);
    if (!String(trip.destination || '').trim()) return res.status(400).json({ error: 'Add a destination first, under Details.' });
    send = streamedJson(res);
    const plan = identityLib.planFor(req.user, MODEL_TIERS);
    const response = await completeTurn({
      model: plan.model,
      max_tokens: 8192,
      system:
        'Find the best things to do for a trip to ' + trip.destination +
        (trip.dates ? ', ' + trip.dates.start + ' to ' + trip.dates.end : (trip.dateRange ? ', ' + trip.dateRange : '')) + '. ' +
        (trip.notes ? 'What is known about the trip: ' + String(trip.notes).slice(0, 1500) + '. ' : '') +
        'Use web search. Prefer things that are actually on or open during those dates, and mix it up - food, ' +
        'outdoors, something special, something easy. Six to eight ideas, each with one sentence on why. Never ' +
        'invent a price, an opening time or a link: leave it out if you could not confirm it. Then call ' +
        'things_to_do with the list.',
      tools: [plan.webSearch, ideasLib.TOOL],
      messages: [{ role: 'user', content: 'What should we do there?' }],
    }, req.user);
    const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'things_to_do');
    const ideas = ideasLib.validate(block && block.input && block.input.ideas);
    if (!ideas.length) return send({ error: 'The search came back without a list. Try again in a moment.' });
    const at = new Date().toISOString();
    await owned.ref.update({ ideas, ideasAt: at });
    send({ ideas, ideasAt: at });
  } catch (err) {
    console.error('POST /api/trips/:id/ideas', err);
    if (send) return send({ error: 'Could not find things to do right now.' });
    res.status(500).json({ error: 'Could not find things to do right now.' });
  }
});

/* ==========================================================================
 * Packing and Budget (2026-09-23)
 *
 * The vacation app's two tabs, for every trip. Both are stored one document
 * per row (see packing.js and budget.js for why), both are shared between
 * everyone looking at the trip, and in both a model only ever SUGGESTS: what
 * it proposes comes back to the page unsaved, and is added by a tap.
 * ========================================================================== */

const ROW_ID = /^[A-Za-z0-9_-]{1,40}$/;
const packingCol = (ref) => ref.collection('packing');
const budgetCol = (ref) => ref.collection('budget');

async function rows(col) {
  const snap = await col.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** What a model needs to know about a trip to suggest something sensible:
 *  where, when, who (the notes), what they are doing, what is booked, and -
 *  free, if there is one - the forecast. */
async function tripContext(owned) {
  const trip = tripOut(owned.doc.id, owned.data);
  const out = ['Trip: ' + (trip.name || 'Untitled')];
  if (trip.destination) out.push('Destination: ' + trip.destination);
  if (trip.dates) out.push('Dates: ' + trip.dates.start + ' to ' + trip.dates.end + (trip.dates.precision === 'month' ? ' (month only)' : ''));
  else if (trip.dateRange) out.push('When: ' + trip.dateRange);
  if (trip.notes) out.push('Notes (who is going, preferences): ' + String(trip.notes).slice(0, 1500));
  const days = Array.isArray(trip.days) ? trip.days : [];
  if (days.length) out.push('Itinerary:\n' + days.slice(0, 14).map((d) => '- ' + (d.dateLabel || d.date || '') + ': ' + (d.title || '') +
    ' - ' + (d.blocks || []).map((b) => b[1]).join('; ')).join('\n'));
  const bookings = bookingsLib.validate(owned.data.bookings || []);
  if (bookings.length) out.push('Bookings:\n' + bookings.map((b) => '- ' + b.kind + ': ' + b.title + (b.when ? ' (' + b.when + ')' : '') +
    (b.total != null ? ', $' + b.total : '')).join('\n'));
  const w = await weatherFor(owned.ref, owned.data).catch(() => null);
  if (w && w.status === 'forecast' && w.days && w.days.length) {
    const ds = w.tripDays ? w.days.filter((d) => d.inTrip) : w.days;
    if (ds.length) out.push('Forecast:\n' + ds.map((d) => '- ' + d.date + ': ' + d.label + ', ' + d.hi + '/' + d.lo + 'F' + (d.rainMm ? ', rain ' + d.rainMm + 'mm' : '')).join('\n'));
  }
  return out.join('\n');
}

// ---- the example trip, read-only ------------------------------------------
app.get(`/api/trips/${demo.DEMO_ID}/packing`, (req, res) => res.json({ items: demo.DEMO_PACKING || [] }));
app.get(`/api/trips/${demo.DEMO_ID}/budget`, (req, res) => res.json(Object.assign({ lines: [], target: null }, demo.DEMO_BUDGET || {}, {
  booked: bookingsLib.validate(demo.DEMO_TRIP.bookings || []).filter((b) => b.total != null)
    .map((b) => ({ id: b.id, kind: b.kind, title: b.title, provider: b.provider, total: b.total })),
})));

// ---- packing ------------------------------------------------------------------
app.get('/api/trips/:id/packing', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  try { res.json({ items: await rows(packingCol(owned.ref)) }); }
  catch (err) { console.error('GET packing', err); res.status(500).json({ error: 'Could not load the packing list.' }); }
});

app.post('/api/trips/:id/packing', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  try {
    const body = req.body || {};
    const incoming = (Array.isArray(body.items) ? body.items : [body]).map(packingLib.item).filter(Boolean);
    if (!incoming.length) return res.status(400).json({ error: 'Write what to pack.' });
    const have = await rows(packingCol(owned.ref));
    if (have.length + incoming.length > packingLib.MAX_ITEMS) return res.status(400).json({ error: 'That list is full.' });
    const now = Date.now();
    await Promise.all(incoming.map((it, i) => packingCol(owned.ref).add({
      ...it, checked: false, order: now + i, createdAt: new Date(now).toISOString(),
    })));
    res.json({ items: await rows(packingCol(owned.ref)) });
  } catch (err) { console.error('POST packing', err); res.status(500).json({ error: 'Could not add that.' }); }
});

app.patch('/api/trips/:id/packing/:iid', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  if (!ROW_ID.test(req.params.iid)) return res.status(404).json({ error: 'No such item.' });
  try {
    const ref = packingCol(owned.ref).doc(req.params.iid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'No such item.' });
    const b = req.body || {};
    const patch = {};
    if (typeof b.checked === 'boolean') patch.checked = b.checked;
    if (b.text !== undefined || b.group !== undefined) {
      const it = packingLib.item({ text: b.text !== undefined ? b.text : snap.data().text, group: b.group !== undefined ? b.group : snap.data().group });
      if (!it) return res.status(400).json({ error: 'Write what to pack.' });
      Object.assign(patch, it);
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
    await ref.update(patch);
    res.json({ item: { id: ref.id, ...snap.data(), ...patch } });
  } catch (err) { console.error('PATCH packing', err); res.status(500).json({ error: 'Could not save that.' }); }
});

app.delete('/api/trips/:id/packing/:iid', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  if (!ROW_ID.test(req.params.iid)) return res.status(404).json({ error: 'No such item.' });
  try {
    const ref = packingCol(owned.ref).doc(req.params.iid);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'No such item.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (err) { console.error('DELETE packing', err); res.status(500).json({ error: 'Could not remove that.' }); }
});

/** Untick everything - the list for the trip home, or the next trip. */
app.post('/api/trips/:id/packing/reset', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  try {
    const snap = await packingCol(owned.ref).get();
    await Promise.all(snap.docs.filter((d) => d.data().checked).map((d) => d.ref.update({ checked: false })));
    res.json({ items: await rows(packingCol(owned.ref)) });
  } catch (err) { console.error('reset packing', err); res.status(500).json({ error: 'Could not reset the list.' }); }
});

/** Suggest what to pack. Returned, not saved: the page shows it and adds
 *  only what is tapped. Never removes or unticks anything. */
app.post('/api/trips/:id/packing/suggest', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    send = streamedJson(res);
    const have = await rows(packingCol(owned.ref));
    const plan = identityLib.planFor(req.user, MODEL_TIERS);
    const response = await completeTurn({
      model: plan.model,
      max_tokens: 4096,
      system:
        'Suggest a packing list for this trip. Be specific to it - the place, the weather, what they are doing, who is ' +
        'going - rather than a generic list: a rental car with small kids means car seats, a boat tour means motion-sickness ' +
        'tablets, rain in the forecast means a rain layer. Group by person when the notes say who is going, otherwise by ' +
        'category. Leave out anything already on their list. Then call packing_list.\n\n' + await tripContext(owned) +
        '\n\nAlready on the list:\n' + (have.map((i) => '- ' + i.text).join('\n') || '(nothing yet)'),
      tools: [packingLib.TOOL],
      messages: [{ role: 'user', content: 'What should we pack?' }],
    }, req.user);
    const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'packing_list');
    const items = packingLib.newOnly(block && block.input && block.input.items, have);
    send({ items });
  } catch (err) {
    console.error('suggest packing', err);
    if (send) return send({ error: 'Could not suggest a list right now.' });
    res.status(500).json({ error: 'Could not suggest a list right now.' });
  }
});

// ---- budget -------------------------------------------------------------------
async function budgetView(owned) {
  const booked = bookingsLib.validate(owned.data.bookings || []).filter((b) => b.total != null)
    .map((b) => ({ id: b.id, kind: b.kind, title: b.title, provider: b.provider, total: b.total }));
  return { target: budgetLib.money(owned.data.budgetTarget), lines: await rows(budgetCol(owned.ref)), booked };
}

app.get('/api/trips/:id/budget', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  try { res.json(await budgetView(owned)); }
  catch (err) { console.error('GET budget', err); res.status(500).json({ error: 'Could not load the budget.' }); }
});

app.put('/api/trips/:id/budget/target', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  try {
    const target = budgetLib.money((req.body || {}).target);
    await owned.ref.update({ budgetTarget: target });
    res.json({ target });
  } catch (err) { console.error('PUT budget target', err); res.status(500).json({ error: 'Could not save that.' }); }
});

app.post('/api/trips/:id/budget/lines', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  try {
    const body = req.body || {};
    const incoming = (Array.isArray(body.lines) ? body.lines : [body]).map(budgetLib.line).filter(Boolean);
    if (!incoming.length) return res.status(400).json({ error: 'Give the line a name.' });
    const have = await rows(budgetCol(owned.ref));
    if (have.length + incoming.length > budgetLib.MAX_LINES) return res.status(400).json({ error: 'That budget is full.' });
    const now = Date.now();
    await Promise.all(incoming.map((l, i) => budgetCol(owned.ref).add({ ...l, order: now + i, createdAt: new Date(now).toISOString() })));
    res.json(await budgetView(owned));
  } catch (err) { console.error('POST budget line', err); res.status(500).json({ error: 'Could not add that.' }); }
});

app.patch('/api/trips/:id/budget/lines/:lid', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  if (!ROW_ID.test(req.params.lid)) return res.status(404).json({ error: 'No such line.' });
  try {
    const ref = budgetCol(owned.ref).doc(req.params.lid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'No such line.' });
    const merged = budgetLib.line({ ...snap.data(), ...(req.body || {}) });
    if (!merged) return res.status(400).json({ error: 'Give the line a name.' });
    await ref.update(merged);
    res.json({ line: { id: ref.id, ...snap.data(), ...merged } });
  } catch (err) { console.error('PATCH budget line', err); res.status(500).json({ error: 'Could not save that.' }); }
});

app.delete('/api/trips/:id/budget/lines/:lid', requireLogin, async (req, res) => {
  const owned = await loadOwnedTrip(req, res);
  if (!owned) return;
  if (!ROW_ID.test(req.params.lid)) return res.status(404).json({ error: 'No such line.' });
  try {
    const ref = budgetCol(owned.ref).doc(req.params.lid);
    if (!(await ref.get()).exists) return res.status(404).json({ error: 'No such line.' });
    await ref.delete();
    res.json({ ok: true });
  } catch (err) { console.error('DELETE budget line', err); res.status(500).json({ error: 'Could not remove that.' }); }
});

/** Estimate the spending the bookings do not already cover. Returned, not
 *  saved - the page adds what is tapped. Web search, because "what does a
 *  dolphin cruise cost in Destin" is a question about now. */
app.post('/api/trips/:id/budget/suggest', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    send = streamedJson(res);
    const view = await budgetView(owned);
    const plan = identityLib.planFor(req.user, MODEL_TIERS);
    const response = await completeTurn({
      model: plan.model,
      max_tokens: 8192,
      system:
        'Estimate a spending budget for this trip, in US dollars, by line: groceries, meals out, activities they have ' +
        'planned or are likely to do, gas or transit, parking, and a little for extras. Bookings that list a price are ' +
        'ALREADY counted - do not include them again. Use web search for real prices where it matters (tickets, tours, ' +
        'typical meal costs there) and keep each note to one line on how you got the number. Skip lines they already ' +
        'have. Then call budget_estimate.\n\n' + await tripContext(owned) +
        '\n\nLines they already have:\n' + (view.lines.map((l) => '- ' + l.category + ': ' + l.label + (l.planned != null ? ' $' + l.planned : '')).join('\n') || '(none yet)'),
      tools: [plan.webSearch, budgetLib.TOOL],
      messages: [{ role: 'user', content: 'What should we budget?' }],
    }, req.user);
    const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'budget_estimate');
    const lines = (block && block.input && Array.isArray(block.input.lines) ? block.input.lines : [])
      .map(budgetLib.line).filter((l) => l && l.planned != null).slice(0, 20);
    if (!lines.length) return send({ error: 'The estimate came back empty. Try again in a moment.' });
    send({ lines });
  } catch (err) {
    console.error('suggest budget', err);
    if (send) return send({ error: 'Could not estimate a budget right now.' });
    res.status(500).json({ error: 'Could not estimate a budget right now.' });
  }
});

/** The tap. Only what was chosen, and only as ordinary trips. */
app.post('/api/gmail/import', requireLogin, async (req, res) => {
  try {
    const picked = Array.isArray((req.body || {}).trips) ? (req.body || {}).trips.slice(0, 20) : [];
    if (!picked.length) return res.status(400).json({ error: 'Nothing to import.' });
    const now = new Date().toISOString();
    const created = [];
    for (const t of picked) {
      const name = String(t.name || '').trim().slice(0, 120);
      if (!name) continue;
      const ref = await db.collection('trips').add({
        name,
        destination: String(t.destination || '').slice(0, 200),
        dateRange: String(t.dateRange || '').slice(0, 120),
        notes: String(t.notes || '').slice(0, 4000),
        // Validated again: this list came back from the browser, not from us.
        bookings: bookingsLib.validate(t.bookings),
        bookingsUpdatedAt: now,
        status: 'planning',
        ownerId: req.user.uid,
        // So a trip that came out of a mailbox is identifiable later, without
        // keeping anything about the mail itself.
        importedFrom: 'gmail',
        createdAt: now,
        updatedAt: now,
        lockedAt: null,
      });
      created.push(ref.id);
    }
    await identity.log('gmail.imported', req, { uid: req.user.uid, detail: `${created.length} trip(s)` });
    res.json({ ok: true, created });
  } catch (err) {
    console.error('POST /api/gmail/import', err);
    res.status(500).json({ error: 'Could not import those.' });
  }
});

// ---------------------------------------------------------------------------
// Watches - flights/hotels/Airbnbs to monitor. Checking one spends an
// Anthropic call with web search; a manual check hits that directly, and the
// batch route below is what a single Cloud Scheduler tick fans out to.
// ---------------------------------------------------------------------------
// A turn that uses the server-side web_search tool does not always finish in
// one response. When the search runs long the API returns stop_reason
// "pause_turn" and expects to be handed its own output back so it can carry
// on; when search results eat max_tokens the model may not have written
// anything yet. Either way every content block is a tool block, so filtering
// for text yields nothing and the user gets "I didn't have anything to add to
// that" for a question the model was halfway through answering.
//
// The same defect was fixed in santa-rosa-beach-trip. Both apps call web
// search the same way, so both needed the same continuation.
const MAX_TURN_CONTINUATIONS = 4;

/** The client this request should use: the caller's own key if they have one
 *  on file, otherwise the app's. Built here rather than at startup, because
 *  one process serves everyone. */
function clientFor(user) {
  return identity.clientFor(user, anthropic, (apiKey) => new Anthropic({ apiKey }));
}

async function completeTurn(params, user) {
  const client = await clientFor(user);
  const messages = params.messages.slice();
  let response;
  for (let i = 0; i <= MAX_TURN_CONTINUATIONS; i++) {
    response = await client.messages.create(Object.assign({}, params, { messages }));
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  return response;
}

const MAX_HISTORY_ENTRIES = 20;

async function runWatchCheck(tripData, watchDoc, account) {
  const w = watchDoc.data();
  const prompt =
    'Trip: "' + (tripData.name || 'Untitled trip') + '"' +
    (tripData.destination ? ' to ' + tripData.destination : '') +
    (tripData.dateRange ? ', ' + tripData.dateRange : '') + '.\n' +
    'Check this ' + (w.kind || 'listing') + ': ' + (w.label || '') + '.\n' +
    'What to watch for: ' + (w.criteria || 'any notable price or availability change') + '.\n' +
    (w.url ? 'Specific listing: ' + w.url + '.\n' : '') +
    (w.lastResult ? 'Last time you checked, you found: ' + w.lastResult + '\n' : '') +
    'Use web search to check current price/availability. Reply in 2-3 sentences: the current state, and ' +
    'whether that is a meaningful change from last time (if you have a prior result to compare). Never invent ' +
    'a price - say so if you cannot verify one.';

  // Same tiering as chat, and the same reason the tool comes from planFor
  // rather than being written out here: Haiku rejects the newer search tool.
  const plan = identityLib.planFor(account, Object.assign({ maxUses: 4 }, MODEL_TIERS));
  const response = await completeTurn({
    model: plan.model,
    max_tokens: 2048,
    tools: [plan.webSearch],
    messages: [{ role: 'user', content: prompt }],
  }, account);
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');

  const now = new Date().toISOString();
  const history = Array.isArray(w.history) ? w.history.slice(-(MAX_HISTORY_ENTRIES - 1)) : [];
  history.push({ checkedAt: now, result: text });
  await watchDoc.ref.update({ lastCheckedAt: now, lastResult: text, history });
  return text;
}

app.get('/api/trips/:id/watches', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const snap = await owned.ref.collection('watches')
      .orderBy('createdAt', 'asc').get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error('GET /api/trips/:id/watches', err);
    res.status(500).json({ error: 'Failed to load watches.' });
  }
});

app.post('/api/trips/:id/watches', requireLogin, async (req, res) => {
  try {
    const { kind, label, criteria, url, intervalHours } = req.body || {};
    if (!label) return res.status(400).json({ error: 'label is required.' });
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const now = new Date().toISOString();
    const ref = await owned.ref.collection('watches').add({
      kind: ['flight', 'hotel', 'airbnb', 'other'].includes(kind) ? kind : 'other',
      label: String(label).slice(0, 200),
      criteria: typeof criteria === 'string' ? criteria.slice(0, 500) : '',
      url: typeof url === 'string' ? url.slice(0, 500) : '',
      intervalHours: Number.isFinite(intervalHours) && intervalHours >= 1 ? Math.min(intervalHours, 24 * 14) : 24,
      lastCheckedAt: null,
      lastResult: null,
      history: [],
      createdAt: now,
    });
    const doc = await ref.get();
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error('POST /api/trips/:id/watches', err);
    res.status(500).json({ error: 'Could not add watch.' });
  }
});

app.patch('/api/trips/:id/watches/:watchId', requireLogin, async (req, res) => {
  try {
    const { criteria, url, intervalHours } = req.body || {};
    const patch = {};
    if (typeof criteria === 'string') patch.criteria = criteria.slice(0, 500);
    if (typeof url === 'string') patch.url = url.slice(0, 500);
    if (Number.isFinite(intervalHours) && intervalHours >= 1) patch.intervalHours = Math.min(intervalHours, 24 * 14);
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const ref = owned.ref.collection('watches').doc(req.params.watchId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Watch not found.' });
    await ref.update(patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/trips/:id/watches/:watchId', err);
    res.status(500).json({ error: 'Could not update watch.' });
  }
});

app.delete('/api/trips/:id/watches/:watchId', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    await owned.ref.collection('watches').doc(req.params.watchId).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/trips/:id/watches/:watchId', err);
    res.status(500).json({ error: 'Could not remove watch.' });
  }
});

app.post('/api/trips/:id/watches/:watchId/check', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const watchDoc = await owned.ref.collection('watches').doc(req.params.watchId).get();
    if (!watchDoc.exists) return res.status(404).json({ error: 'Watch not found.' });
    // A manual check searches the web too, so it waits just as long as chat.
    send = streamedJson(res);
    const result = await runWatchCheck(owned.data, watchDoc, req.user);
    send({ ok: true, result });
  } catch (err) {
    console.error('POST /api/trips/:id/watches/:watchId/check', err);
    if (send) return send({ error: 'Check failed.' });
    res.status(500).json({ error: 'Check failed.' });
  }
});

// The one route a Cloud Scheduler job hits, on a base tick (hourly is
// plenty). Nothing here is on a fixed global schedule - each watch's own
// intervalHours decides whether it's actually due, so the user "sets the
// schedule" per watch in the UI without ever touching Cloud Scheduler.
// Skips every watch on a locked trip: a booked trip isn't being shopped
// anymore. Capped per run so one slow tick can't balloon into a huge bill.
const MAX_CHECKS_PER_RUN = 20;

// Diagnostic: exercise the Anthropic call twice, once with the web_search
// tool and once without, and write both outcomes to Firestore. Cloud Logging
// is not readable by this project's service account, so a 500 from the chat
// route is otherwise a dead end - the user sees "Chat request failed" and the
// reason never leaves the container. Isolating the tool matters because that
// is the only thing chat uses that a working scan does not.
app.post('/api/cron/check-watches', requireLoginOrCron, async (req, res, next) => {
  if (req.query.selftest !== '1') return next();
  const probe = async (label, tools) => {
    const started = Date.now();
    try {
      const r = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 128,
        tools,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      });
      return {
        label, ok: true, ms: Date.now() - started,
        stopReason: r.stop_reason,
        text: r.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 120),
        blocks: r.content.map((b) => b.type),
      };
    } catch (err) {
      return {
        label, ok: false, ms: Date.now() - started,
        status: err.status || null,
        name: err.name || null,
        message: String(err.message || err).slice(0, 600),
      };
    }
  };
  // A third probe that looks like a real question rather than a ping: the
  // first two prove the account and the tool work, this one proves a turn
  // that actually searches comes back with text in it.
  const realistic = async () => {
    const started = Date.now();
    try {
      const r = await completeTurn({
        model: 'claude-sonnet-5',
        max_tokens: 8192,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: 'What is the weather usually like in Destin, Florida in late March, and what are two things to do there with young kids?' }],
      });
      const text = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      return {
        label: 'realistic search question', ok: true, ms: Date.now() - started,
        stopReason: r.stop_reason, blocks: r.content.map((b) => b.type),
        textLength: text.length, preview: text.slice(0, 160),
      };
    } catch (err) {
      return { label: 'realistic search question', ok: false, ms: Date.now() - started,
               status: err.status || null, message: String(err.message || err).slice(0, 600) };
    }
  };

  const out = {
    at: new Date().toISOString(),
    withSearch: await probe('with web_search', [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }]),
    withoutTools: await probe('no tools', undefined),
    realistic: await realistic(),
  };
  await db.collection('control').doc('ai-selftest').set(out);
  res.json(out);
});

app.post('/api/cron/check-watches', requireLoginOrCron, async (req, res) => {
  try {
    const tripsSnap = await db.collection('trips').where('status', '==', 'planning').get();
    const now = Date.now();
    let checked = 0;
    let skippedNoCredit = 0;
    const results = [];
    // Owner -> approved? cached per run, so N trips for one owner is one read.
    const approvalCache = new Map();

    for (const tripDoc of tripsSnap.docs) {
      if (checked >= MAX_CHECKS_PER_RUN) break;

      // A watch check spends an Anthropic call, so the trip's owner must hold
      // credit left. Without this an account with an exhausted allowance
      // would keep billing the shared key every hour - the one place where
      // spending happens with nobody watching.
      const ownerId = tripDoc.data().ownerId;
      if (!approvalCache.has(ownerId)) {
        approvalCache.set(ownerId, await ownerAccount(ownerId));
      }
      const ownerRecord = approvalCache.get(ownerId);
      if (!ownerRecord) {
        skippedNoCredit += 1;
        continue;
      }

      const watchesSnap = await tripDoc.ref.collection('watches').get();
      for (const watchDoc of watchesSnap.docs) {
        if (checked >= MAX_CHECKS_PER_RUN) break;
        const w = watchDoc.data();
        const dueMs = (w.intervalHours || 24) * 3600 * 1000;
        const lastMs = w.lastCheckedAt ? new Date(w.lastCheckedAt).getTime() : 0;
        if (now - lastMs < dueMs) continue;
        try {
          const result = await runWatchCheck(tripDoc.data(), watchDoc, ownerRecord);
          results.push({ tripId: tripDoc.id, watchId: watchDoc.id, result });
        } catch (e) {
          console.error('watch check failed', tripDoc.id, watchDoc.id, e);
        }
        checked += 1;
      }
    }

    await db.collection('control').doc('watch-cron').set(
      { lastRunAt: new Date().toISOString(), checked, skippedNoCredit }, { merge: true });
    res.json({ checked, skippedNoCredit, results });
  } catch (err) {
    console.error('POST /api/cron/check-watches', err);
    res.status(500).json({ error: 'Batch check failed.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Trip Planner listening on :${PORT}`);
});
