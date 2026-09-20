const express = require('express');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const { createPasskeyAuth } = require('./auth');

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const FIRESTORE_DB = process.env.FIRESTORE_DATABASE_ID || 'trip-planner';
const SITE_LOGIN_USERNAME = process.env.SITE_LOGIN_USERNAME || '';
const SITE_LOGIN_PASSWORD = process.env.SITE_LOGIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env
const db = new Firestore({ projectId: PROJECT_ID, databaseId: FIRESTORE_DB });

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Auth - auth.js and login.html are the same file as santa-rosa-beach-trip
// (Face ID / Touch ID via WebAuthn, password fallback), but the GATE SHAPE
// is different: this app is public to browse, same split college-football-app
// uses and for the same reason. Anyone can load the page and view trips; only
// routes that spend Anthropic tokens or write data require login. See
// requireLogin's call sites below - it's applied per-route, not globally.
// ---------------------------------------------------------------------------
function passwordOk(req) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) return false;
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  return decoded.slice(0, sep) === SITE_LOGIN_USERNAME && decoded.slice(sep + 1) === SITE_LOGIN_PASSWORD;
}

function requirePassword(req, res, next) {
  if (passwordOk(req)) return next();
  if (req.body && typeof req.body.password === 'string' && SITE_LOGIN_PASSWORD &&
      req.body.password === SITE_LOGIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: 'password required' });
}

const passkeyAuth = createPasskeyAuth({
  db,
  collection: 'webauthn-credentials',
  rpName: 'Trip Planner',
  sessionSecret: SESSION_SECRET,
  userName: SITE_LOGIN_USERNAME || 'erik',
  passwordGate: requirePassword,
  verifyGate: (req, res, next) => {
    if (passkeyAuth.hasSession(req) || passwordOk(req)) return next();
    return res.status(401).json({ error: 'not signed in' });
  },
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
passkeyAuth.mount(app);

app.post('/api/auth/password', (req, res) => {
  const { username, password } = req.body || {};
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  if (username !== SITE_LOGIN_USERNAME || password !== SITE_LOGIN_PASSWORD) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  passkeyAuth.issueSession(res);
  res.json({ ok: true });
});

// A scheduled batch-check run authenticates with the cron secret instead of
// a session - see requireLoginOrCron below, used only on that one route.
function requireLogin(req, res, next) {
  if (!SITE_LOGIN_USERNAME || !SITE_LOGIN_PASSWORD) {
    return res.status(500).json({ error: 'Server login is not configured.' });
  }
  if (passkeyAuth.hasSession(req) || passwordOk(req)) return next();
  if ((req.get('Accept') || '').indexOf('text/html') !== -1) return res.redirect('/login');
  return res.status(401).json({ error: 'not signed in' });
}

function requireLoginOrCron(req, res, next) {
  const key = req.get('X-Cron-Key');
  if (CRON_SECRET && key && key === CRON_SECRET) return next();
  return requireLogin(req, res, next);
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

app.get('/api/trips', async (req, res) => {
  try {
    const snap = await db.collection('trips').orderBy('updatedAt', 'desc').limit(100).get();
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

app.get('/api/trips/:id', async (req, res) => {
  try {
    const doc = await db.collection('trips').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Trip not found.' });
    res.json({ id: doc.id, ...doc.data() });
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
    const ref = db.collection('trips').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Trip not found.' });
    await ref.update(patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/trips/:id', err);
    res.status(500).json({ error: 'Could not update trip.' });
  }
});

app.delete('/api/trips/:id', requireLogin, async (req, res) => {
  try {
    await db.collection('trips').doc(req.params.id).delete();
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
    const ref = db.collection('trips').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Trip not found.' });
    const now = new Date().toISOString();
    await ref.update({ status: 'locked', lockedAt: now, updatedAt: now });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/trips/:id/lock', err);
    res.status(500).json({ error: 'Could not lock trip.' });
  }
});

app.post('/api/trips/:id/unlock', requireLogin, async (req, res) => {
  try {
    const ref = db.collection('trips').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Trip not found.' });
    await ref.update({ status: 'planning', lockedAt: null, updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/trips/:id/unlock', err);
    res.status(500).json({ error: 'Could not unlock trip.' });
  }
});

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

app.get('/api/trips/:id/messages', async (req, res) => {
  try {
    const snap = await db.collection('trips').doc(req.params.id).collection('messages')
      .orderBy('askedAt', 'asc').limit(200).get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  } catch (err) {
    console.error('GET /api/trips/:id/messages', err);
    res.status(500).json({ error: 'Failed to load chat history.' });
  }
});

app.post('/api/trips/:id/chat', requireLogin, async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question) return res.status(400).json({ error: 'question is required.' });

    const tripRef = db.collection('trips').doc(req.params.id);
    const tripDoc = await tripRef.get();
    if (!tripDoc.exists) return res.status(404).json({ error: 'Trip not found.' });
    const trip = tripDoc.data();

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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
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
    if (!answer) answer = "I didn't have anything to add to that — try rephrasing?";

    const askedAt = new Date().toISOString();
    await tripRef.collection('messages').add({
      question,
      answer,
      proposedChange,
      askedAt,
      answeredAt: new Date().toISOString(),
    });
    await tripRef.update({ updatedAt: new Date().toISOString() });

    res.json({ answer, proposedChange });
  } catch (err) {
    console.error('POST /api/trips/:id/chat', err);
    res.status(500).json({ error: 'Chat request failed.' });
  }
});

app.post('/api/trips/:id/schedule/apply', requireLogin, async (req, res) => {
  try {
    const { days } = req.body || {};
    if (!Array.isArray(days) || !days.length) {
      return res.status(400).json({ error: 'days array is required.' });
    }
    const ref = db.collection('trips').doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Trip not found.' });
    await ref.update({ days, updatedAt: new Date().toISOString() });
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

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
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

app.get('/api/trips/:id/watches', async (req, res) => {
  try {
    const snap = await db.collection('trips').doc(req.params.id).collection('watches')
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
    const tripDoc = await db.collection('trips').doc(req.params.id).get();
    if (!tripDoc.exists) return res.status(404).json({ error: 'Trip not found.' });
    const now = new Date().toISOString();
    const ref = await tripDoc.ref.collection('watches').add({
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
    const ref = db.collection('trips').doc(req.params.id).collection('watches').doc(req.params.watchId);
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
    await db.collection('trips').doc(req.params.id).collection('watches').doc(req.params.watchId).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/trips/:id/watches/:watchId', err);
    res.status(500).json({ error: 'Could not remove watch.' });
  }
});

app.post('/api/trips/:id/watches/:watchId/check', requireLogin, async (req, res) => {
  try {
    const tripDoc = await db.collection('trips').doc(req.params.id).get();
    if (!tripDoc.exists) return res.status(404).json({ error: 'Trip not found.' });
    const watchDoc = await tripDoc.ref.collection('watches').doc(req.params.watchId).get();
    if (!watchDoc.exists) return res.status(404).json({ error: 'Watch not found.' });
    const result = await runWatchCheck(tripDoc.data(), watchDoc);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('POST /api/trips/:id/watches/:watchId/check', err);
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

app.post('/api/cron/check-watches', requireLoginOrCron, async (req, res) => {
  try {
    const tripsSnap = await db.collection('trips').where('status', '==', 'planning').get();
    const now = Date.now();
    let checked = 0;
    const results = [];

    for (const tripDoc of tripsSnap.docs) {
      if (checked >= MAX_CHECKS_PER_RUN) break;
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

    await db.collection('control').doc('watch-cron').set({ lastRunAt: new Date().toISOString(), checked }, { merge: true });
    res.json({ checked, results });
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
