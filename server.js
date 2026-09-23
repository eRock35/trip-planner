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
  res.json(Object.assign({ id: demo.DEMO_ID, demo: true }, demo.DEMO_TRIP));
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
      'Current itinerary:\n' + JSON.stringify(trip.days || []);

    // Free accounts run on Haiku, which costs half what Sonnet does and is
    // plenty for trip chat; the owner, Pro, and anyone on their own key get
    // Sonnet. planFor also hands back the web-search tool version this model
    // accepts - Haiku 400s on the newer one, so they must move together.
    const plan = identityLib.planFor(req.user, MODEL_TIERS);
    const response = await completeTurn({
      model: plan.model,
      max_tokens: 8192,
      system: systemPrompt,
      tools: [plan.webSearch, SCHEDULE_TOOL],
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
      };
      if (!answer) {
        answer = "I've drafted a plan: " + proposedChange.summary + ' Review it below and tap Apply to save it.';
      }
    }
    if (!answer) {
      // Distinguish "nothing to say" from "ran out of room": the first is an
      // answer, the second is a failure wearing an answer's clothes.
      answer = response.stop_reason === 'max_tokens'
        ? "That search ran long and I ran out of room before writing the answer. Ask again, or narrow it a little."
        : "I didn't have anything to add to that — try rephrasing?";
    }

    const askedAt = new Date().toISOString();
    await tripRef.collection('messages').add({
      question,
      answer,
      // The proposal is stored too, so reopening the trip still shows the
      // Apply card - and it carries `days`, so it needs the same nested-array
      // treatment the trip itself does. Without it the whole chat turn fails
      // on the write, AFTER the model has been paid for and answered.
      proposedChange: proposedChange
        ? { ...proposedChange, days: schedule.toStore(proposedChange.days) }
        : null,
      askedAt,
      answeredAt: new Date().toISOString(),
    });
    await tripRef.update({ updatedAt: new Date().toISOString() });

    send({ answer, proposedChange });
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

app.post('/api/trips/:id/schedule/apply', requireLogin, async (req, res) => {
  try {
    const days = schedule.validate((req.body || {}).days);
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    // toStore, not days: Firestore cannot hold an array inside an array, and
    // `blocks` is a list of [time, plan] pairs. Writing the pairs straight in
    // fails with "Property array contains an invalid nested entity", which is
    // what Apply had been doing every time. See schedule.js.
    await owned.ref.update({ days: schedule.toStore(days), updatedAt: new Date().toISOString() });
    res.json({ ok: true, days });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('POST /api/trips/:id/schedule/apply', err);
    res.status(500).json({ error: 'Could not save the itinerary.' });
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
    connected: Boolean(g && g.refresh),
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
app.post('/api/gmail/scan', requireLogin, identity.requireBudget, identity.requireDailyCap, async (req, res) => {
  let send = null;
  try {
    if (!gmailReady()) return res.status(503).json({ error: 'Gmail is not configured on this deployment.' });
    const own = await db.collection('users').doc(req.user.uid).get();
    const g = own.exists ? own.data().gmail : null;
    if (!g || !g.refresh) return res.status(400).json({ error: 'Connect Gmail first.' });
    const refresh = tokenVault.decrypt(req.user.uid, g.refresh);
    if (!refresh) return res.status(400).json({ error: 'That connection needs setting up again.' });

    // Past here nothing may fail with a status: the drip has started.
    send = streamedJson(res);

    const access = await gmail.accessFrom(refresh);
    const ids = await gmail.search(access);
    if (!ids.length) return send({ trips: [], looked: 0 });

    const messages = [];
    for (const id of ids) {
      const m = await gmail.message(access, id).catch(() => null);
      if (m) messages.push(m);
    }
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
        'rental-car pickup and return times exactly as written. ' +
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
        sources: (t.sourceIds || []).map((id) => byId.get(id)).filter(Boolean)
          .map((m) => ({ from: m.from, subject: m.subject, date: m.date })),
      })),
    });
  } catch (err) {
    console.error('POST /api/gmail/scan', err);
    if (send) return send({ error: 'Could not read those emails.' });
    res.status(err.status || 500).json({ error: 'Could not read those emails.' });
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
