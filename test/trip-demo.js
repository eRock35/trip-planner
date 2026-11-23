// The example trip: readable by anyone, writable by no one, real trips still private.
const h = require('./harness.js');
h.install();
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'trip-secret-abcdefghijklmnop';
process.env.FIRESTORE_DATABASE_ID = 'trip-planner'; process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test'; process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'; process.env.PORT = '9211';
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9211';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
(async () => {
  await new Promise((r) => setTimeout(r, 900));
  let r = await fetch(B + '/api/trips/demo'); const trip = await r.json();
  ok('anyone can read the example trip', r.status === 200 && trip.demo === true && trip.days.length === 5, String(r.status));
  ok('it is cacheable', /max-age/.test(r.headers.get('cache-control') || ''));
  r = await fetch(B + '/api/trips/demo/messages'); const msgs = await r.json();
  ok('...and its chat', r.status === 200 && msgs.length === 3 && msgs[1].proposedChange);
  r = await fetch(B + '/api/trips/demo/watches'); const ws = await r.json();
  ok('...and its watches, with history', r.status === 200 && ws.length === 2 && ws[0].history.length === 8);
  r = await fetch(B + '/api/trips');
  ok('the real trips list is still sign-in only', r.status === 401, String(r.status));
  r = await post('/api/trips/demo/chat', { question: 'hi' });
  ok('signed out, writing to the example is a 401', r.status === 401, String(r.status));
  const user = jar(await post('/api/auth/register', { email: 'u@example.com', password: 'a-long-password-1' }));
  r = await post('/api/trips/demo/lock', {}, user); const b = await r.json();
  ok('signed in, writing to the example is a 403 that says so', r.status === 403 && b.demo === true, JSON.stringify(b));
  r = await post('/api/trips/demo/watches', { kind: 'flight', label: 'x' }, user);
  ok('...for every write route', r.status === 403, String(r.status));
  r = await post('/api/trips/demo/schedule/apply', { days: trip.days }, user);
  ok('...including the itinerary', r.status === 403, String(r.status));
  r = await fetch(B + '/api/trips/demo', { headers: { cookie: user } });
  ok('a signed-in user can still read it', r.status === 200);
  // Copying the example into an account.
  r = await post('/api/trips/demo/copy', {});
  ok('copying needs a session', r.status === 401, String(r.status));
  r = await post('/api/trips/demo/copy', {}, user);
  const copy = await r.json();
  ok('a signed-in user can copy the example', r.status === 200 && copy.id, JSON.stringify(copy));
  r = await fetch(B + '/api/trips/' + copy.id, { headers: { cookie: user } });
  const mine = await r.json();
  ok('the copy is theirs, and editable', r.status === 200 && mine.demo !== true);
  ok('...it arrives in planning, not locked', mine.status === 'planning', mine.status);
  ok('...with the itinerary', Array.isArray(mine.days) && mine.days.length === 5, String((mine.days || []).length));
  ok('...and remembers where it came from', mine.copiedFrom === 'demo');
  r = await fetch(B + '/api/trips/' + copy.id + '/watches', { headers: { cookie: user } });
  const copiedWatches = await r.json();
  ok('...and the watches came too', copiedWatches.length === 2, String(copiedWatches.length));
  ok('...with their history left behind', copiedWatches.every((w) => !w.history || !w.history.length));
  r = await post('/api/trips/' + copy.id + '/lock', {}, user);
  ok('the copy is writable, unlike the example', r.status === 200, String(r.status));

  // The example's dates are relative to today (demo.js), so it is always upcoming.
  const demo = require('../demo');
  const DAY = 86400000, todayMs = Date.parse(new Date().toISOString().slice(0, 10));
  const lead = (Date.parse(trip.dates.start) - todayMs) / DAY;
  ok('the example is always upcoming: day 1 is 2-8 days away, a Thursday', lead >= demo.MIN_LEAD_DAYS && lead <= demo.MIN_LEAD_DAYS + 6
     && new Date(trip.dates.start + 'T00:00:00Z').getUTCDay() === 4 && trip.dates.from === 'itinerary' && trip.dates.precision === 'day', trip.dates.start + ' lead ' + lead);
  const wd = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  ok('...five consecutive days, each label naming its own date', trip.days.every((d, i) => Date.parse(d.date) === Date.parse(trip.dates.start) + i * DAY && d.dateLabel === wd(d.date)),
     trip.days.map((d) => d.date + ' ' + d.dateLabel).join(', '));
  ok('..."When" says the same dates as the itinerary', JSON.stringify(require('../tripdates').fromText(trip.dateRange, new Date())) === JSON.stringify({ start: trip.dates.start, end: trip.dates.end, precision: 'day' }),
     trip.dateRange);
  ok('...and the history before it (chat, watch checks, lock) is in the past', [trip.createdAt, trip.lockedAt, ...msgs.map((m) => m.answeredAt), ...ws.flatMap((w) => w.history.map((x) => x.at))].every((t) => Date.parse(t) < Date.now()));
  ok('...in the order it was written', Date.parse(trip.createdAt) < Date.parse(msgs[0].askedAt) && Date.parse(ws[0].history[0].at) < Date.parse(ws[0].history[7].at) && Date.parse(trip.lockedAt) < Date.parse(trip.dates.start));
  // A fixed clock: on the day the example was written (Thu Sep 24, 2026) it
  // comes out exactly as it was, Oct 1-5 with Aug 15 as the first flight check.
  const then = demo.build(Date.parse('2026-09-24T12:00:00Z'));
  ok('on a fixed clock of Sep 24, 2026 it is the original Oct 1-5 trip', then.DEMO_TRIP.dateRange === 'Oct 1-5, 2026' && then.DEMO_TRIP.days[0].dateLabel === 'Thu, Oct 1'
     && then.DEMO_TRIP.days[4].dateLabel === 'Mon, Oct 5' && then.DEMO_TRIP.bookings[0].when === 'Wed, Sep 30 - 6:05 PM' && then.DEMO_WATCHES[0].history[0].at === '2026-08-15T10:00:00.000Z'
     && then.DEMO_WATCHES[0].label === 'ATL -> LIS, Oct 1-5, TAP nonstop' && then.DEMO_CRAWL.date === '2026-10-02' && then.DEMO_TRIP.createdAt === '2026-08-14T15:02:11.000Z',
     then.DEMO_TRIP.dateRange + ' ' + then.DEMO_TRIP.days[0].dateLabel);
  ok('...and across a year end the range still reads', demo.build(Date.parse('2026-12-24T12:00:00Z')).DEMO_TRIP.dateRange === 'Dec 31, 2026 - Jan 4, 2027');
  ok('...the weekday plan holds on any day (Sintra is always the Saturday)', [0, 1, 2, 3, 4, 5, 6, 30, 200].every((k) => {
    const d = demo.build(Date.parse('2026-11-23T08:00:00Z') + k * DAY).DEMO_TRIP.days;
    return /^Sat,/.test(d[2].dateLabel) && /^Sun,/.test(d[3].dateLabel);
  }));

  r = await fetch(B + '/healthz');
  ok('frame-ancestors is set for the landing page', /frame-ancestors[^;]*strongtechnicalconsulting\.com/.test(r.headers.get('content-security-policy') || ''), r.headers.get('content-security-policy'));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
