const express = require('express');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { createAccounts } = require('./accounts');
const identityLib = require('./identity');
const identityStore = require('./identity-store');
const analytics = require('./analytics');

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

const { requireLogin, requireAiAccess } = accounts;

app.get('/healthz', (req, res) => res.status(200).send('ok'));
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

/** Identity says who; this app's own record says what they may do here.
 *  `uid` is kept alongside `id` because every route in this file reads
 *  req.user.uid, and renaming it would touch ownership checks on live data. */
async function attachProfile(req, _res, next) {
  if (req.user) {
    req.user.uid = req.user.id;
    const own = await db.collection('users').doc(req.user.id).get().catch(() => null);
    if (own && own.exists) {
      const d = own.data();
      req.user.aiAccess = d.aiAccess || 'none';
      req.user.isAdmin = !!d.isAdmin;
      req.user.mustChangePassword = !!d.mustChangePassword;
      req.user.displayName = d.displayName || req.user.email;
    } else {
      // First sight of this account on this app. Give it a record so the
      // admin panel can see it and grant AI access.
      req.user.aiAccess = 'none';
      req.user.isAdmin = ADMIN_EMAIL && req.user.email === ADMIN_EMAIL;
      await db.collection('users').doc(req.user.id).set({
        email: req.user.email,
        aiAccess: req.user.isAdmin ? 'approved' : 'none',
        isAdmin: !!req.user.isAdmin,
        createdAt: new Date().toISOString(),
      }, { merge: true }).catch(() => {});
      if (req.user.isAdmin) req.user.aiAccess = 'approved';
    }
  }
  next();
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
async function loadOwnedTrip(req, res) {
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
    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error('POST /api/trips', err);
    res.status(500).json({ error: 'Could not create trip.' });
  }
});

app.get('/api/trips/:id', requireLogin, async (req, res) => {
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    res.json({ id: owned.doc.id, ...owned.data });
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
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error('GET /api/trips/:id/messages', err);
    res.status(500).json({ error: 'Failed to load chat history.' });
  }
});

app.post('/api/trips/:id/chat', requireLogin, requireAiAccess, identity.requireBudget, async (req, res) => {
  let send = null;
  try {
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required.' });

    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const tripRef = owned.ref;
    const trip = owned.data;

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
      'array - never call it just to answer a question with no requested plan or change.\n\n' +
      'Current itinerary:\n' + JSON.stringify(trip.days || []);

    const response = await completeTurn({
      model: 'claude-sonnet-5',
      max_tokens: 8192,
      system: systemPrompt,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        SCHEDULE_TOOL,
      ],
      messages: [{ role: 'user', content: question }],
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolBlock = response.content.find((b) => b.type === 'tool_use' && b.name === 'propose_schedule_change');

    let answer = textBlocks.map((b) => b.text).join('\n\n');
    let proposedChange = null;
    if (toolBlock && toolBlock.input && Array.isArray(toolBlock.input.days) && toolBlock.input.days.length) {
      proposedChange = {
        summary: typeof toolBlock.input.summary === 'string' ? toolBlock.input.summary : 'Itinerary update',
        days: toolBlock.input.days,
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
      proposedChange,
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
    const { days } = req.body || {};
    if (!Array.isArray(days) || !days.length) {
      return res.status(400).json({ error: 'days array is required.' });
    }
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    await owned.ref.update({ days, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/trips/:id/schedule/apply', err);
    res.status(500).json({ error: 'Could not save the itinerary.' });
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

async function completeTurn(params) {
  const messages = params.messages.slice();
  let response;
  for (let i = 0; i <= MAX_TURN_CONTINUATIONS; i++) {
    response = await anthropic.messages.create(Object.assign({}, params, { messages }));
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content });
  }
  return response;
}

const MAX_HISTORY_ENTRIES = 20;

async function runWatchCheck(tripData, watchDoc) {
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

  const response = await completeTurn({
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }],
    messages: [{ role: 'user', content: prompt }],
  });
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

app.post('/api/trips/:id/watches/:watchId/check', requireLogin, requireAiAccess, identity.requireBudget, async (req, res) => {
  let send = null;
  try {
    const owned = await loadOwnedTrip(req, res);
    if (!owned) return;
    const watchDoc = await owned.ref.collection('watches').doc(req.params.watchId).get();
    if (!watchDoc.exists) return res.status(404).json({ error: 'Watch not found.' });
    // A manual check searches the web too, so it waits just as long as chat.
    send = streamedJson(res);
    const result = await runWatchCheck(owned.data, watchDoc);
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
    let skippedUnapproved = 0;
    const results = [];
    // Owner -> approved? cached per run, so N trips for one owner is one read.
    const approvalCache = new Map();

    for (const tripDoc of tripsSnap.docs) {
      if (checked >= MAX_CHECKS_PER_RUN) break;

      // A watch check spends an Anthropic call, so the trip's owner must hold
      // approved AI access. Without this, anyone who signed up and added a
      // watch would be billing Erik's key every hour.
      const ownerId = tripDoc.data().ownerId;
      if (!approvalCache.has(ownerId)) {
        approvalCache.set(ownerId, ownerId ? await accounts.isApprovedUid(ownerId) : false);
      }
      if (!approvalCache.get(ownerId)) {
        skippedUnapproved += 1;
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
          const result = await runWatchCheck(tripDoc.data(), watchDoc);
          results.push({ tripId: tripDoc.id, watchId: watchDoc.id, result });
        } catch (e) {
          console.error('watch check failed', tripDoc.id, watchDoc.id, e);
        }
        checked += 1;
      }
    }

    await db.collection('control').doc('watch-cron').set(
      { lastRunAt: new Date().toISOString(), checked, skippedUnapproved }, { merge: true });
    res.json({ checked, skippedUnapproved, results });
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
