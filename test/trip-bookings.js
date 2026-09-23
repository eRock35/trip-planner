// Bookings on a trip: proposed by chat or by reading Gmail, saved only on a
// tap, guarded against undoing a later change, and validated wherever they
// come from - including the browser.
const h = require('./harness.js');
h.install();

let script = null;   // what the fake model does next
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async (req) => script(req) }, batches: {} };
};
const CAR = { kind: 'car', title: 'Midsize - National', provider: 'National', confirmation: '2136112815',
  when: 'Tue, Sep 22 - 5:00 PM', until: 'Sun, Sep 27 - 12:00 PM', date: '2026-09-22', phone: '+1 844 382 6875' };
const STAY = { kind: 'stay', title: 'Beach cottage - Airbnb', provider: 'Airbnb', confirmation: 'HMH2RHHXY4',
  when: 'Wed, Sep 23 - after 4 PM', date: '2026-09-23', url: 'https://www.airbnb.com/trips/v1' };
const proposes = (list, text = 'Done.') => async () => ({ stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
  content: [{ type: 'text', text }, { type: 'tool_use', id: 't', name: 'propose_bookings', input: { summary: 'Bookings', bookings: list } }] });

// Google, faked where the app calls it.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = (b) => new Response(JSON.stringify(b), { status: 200 });
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    if (global.__expire && new URLSearchParams(opts.body).get('grant_type') === 'refresh_token') {
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
    }
    return json({ access_token: 'at', refresh_token: 'rt' });
  }
  if (u.includes('/gmail/v1/users/me/profile')) return json({ emailAddress: 'erik@example.com' });
  if (u.includes('/gmail/v1/users/me/messages?')) return json({ messages: [{ id: 'm1' }] });
  if (u.includes('/gmail/v1/users/me/messages/m1')) return json({ id: 'm1', payload: { headers: [{ name: 'From', value: 'National <x@nationalcar.com>' }, { name: 'Subject', value: 'Your reservation' }], mimeType: 'text/plain', body: { data: Buffer.from('Pickup Tue Sep 22 5 PM. Confirmation 2136112815.').toString('base64url') } } });
  return realFetch(url, opts);
};
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9221',
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REDIRECT_URI: 'https://example.test/api/gmail/callback',
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9221';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => realFetch(B + p, { method: 'POST', headers: { ...J, cookie: c }, body: JSON.stringify(b || {}) });
const get = async (p, c) => (await realFetch(B + p, { headers: { cookie: c } })).json();

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const me = (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'boss@example.com', password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const trip = await (await post('/api/trips', { name: 'Beach', destination: 'Santa Rosa Beach, FL', dateRange: 'Sep 22-27, 2026' }, me)).json();

  /* ---------- chat proposes, Apply saves ---------- */
  script = proposes([CAR], 'Added your National rental.');
  const a = await (await post(`/api/trips/${trip.id}/chat`, { question: 'I rented a car from National, conf 2136112815' }, me)).json();
  ok('chat proposes bookings', a.proposedBookings && a.proposedBookings.bookings.length === 1, JSON.stringify(a).slice(0, 160));
  ok('...based on no bookings yet', a.proposedBookings.basedOn === null);
  ok('...and nothing is saved until Apply', !(await get(`/api/trips/${trip.id}`, me)).bookings);

  let r = await post(`/api/trips/${trip.id}/bookings/apply`, { bookings: a.proposedBookings.bookings, basedOn: null, messageId: a.id }, me);
  let t = await get(`/api/trips/${trip.id}`, me);
  ok('Apply saves them', r.status === 200 && t.bookings.length === 1 && t.bookings[0].confirmation === '2136112815');
  let msgs = await get(`/api/trips/${trip.id}/messages`, me);
  ok('...and the card is remembered as applied', msgs.find((m) => m.id === a.id).bookingsState === 'applied');

  /* ---------- a stale list is refused ---------- */
  r = await post(`/api/trips/${trip.id}/bookings/apply`, { bookings: [STAY], basedOn: null, messageId: a.id }, me);
  ok('a list written before the car was saved is refused', r.status === 409, String(r.status));
  t = await get(`/api/trips/${trip.id}`, me);
  ok('...and the car survives', t.bookings.length === 1 && t.bookings[0].kind === 'car');

  /* ---------- the chat sees the current list ---------- */
  let sawBookings = '';
  script = async (req) => { sawBookings = req.system; return proposes([...t.bookings, STAY])(); };
  const b = await (await post(`/api/trips/${trip.id}/chat`, { question: 'add the Airbnb' }, me)).json();
  ok('chat is shown the current bookings, ids and all', sawBookings.includes('2136112815') && sawBookings.includes(t.bookings[0].id));
  ok('...and the new proposal is based on them', b.proposedBookings.basedOn === t.bookingsUpdatedAt);
  r = await post(`/api/trips/${trip.id}/bookings/apply`, { bookings: b.proposedBookings.bookings, basedOn: b.proposedBookings.basedOn, messageId: b.id }, me);
  t = await get(`/api/trips/${trip.id}`, me);
  ok('...so it applies and keeps the car', r.status === 200 && t.bookings.length === 2 && t.bookings.some((x) => x.kind === 'car'));
  ok('...soonest first', t.bookings[0].kind === 'car' && t.bookings[1].kind === 'stay');

  /* ---------- delete one ---------- */
  const stayId = t.bookings.find((x) => x.kind === 'stay').id;
  r = await realFetch(`${B}/api/trips/${trip.id}/bookings/${stayId}`, { method: 'DELETE', headers: { cookie: me } });
  t = await get(`/api/trips/${trip.id}`, me);
  ok('deleting one removes exactly that one', r.status === 200 && t.bookings.length === 1 && t.bookings[0].kind === 'car');
  r = await realFetch(`${B}/api/trips/${trip.id}/bookings/nope`, { method: 'DELETE', headers: { cookie: me } });
  ok('...and an unknown id is a 404', r.status === 404);

  /* ---------- this trip's bookings, from Gmail ---------- */
  r = await post(`/api/trips/${trip.id}/gmail-bookings`, {}, me);
  ok('before connecting Gmail, the check says so with a status', r.status === 400 && (await r.json()).needsConnect === true, String(r.status));
  // connect: seal a refresh token onto the user the way the callback does
  const vault = require('../byok').create({ secret: () => process.env.BYOK_ENCRYPTION_KEY });
  const uid = Buffer.from('boss@example.com').toString('base64url');
  const u = h.bag('trip-planner').get('users/' + uid);
  u.gmail = { refresh: vault.encrypt(uid, 'rt'), address: 'erik@example.com', connectedAt: new Date().toISOString() };
  let sys = '';
  script = async (req) => { sys = req.system; return proposes([...t.bookings, STAY], 'Found your Airbnb.')(); };
  const g = await (await post(`/api/trips/${trip.id}/gmail-bookings`, {}, me)).json();
  ok('the Gmail check proposes a bookings list', g.proposedBookings && g.proposedBookings.bookings.length === 2, JSON.stringify(g).slice(0, 140));
  ok('...told which trip, and what is already there', /Beach/.test(sys) && /2026-09-22/.test(sys) && sys.includes('2136112815'));
  ok('...filed into the trip’s chat, so it can be applied or discarded later', (await get(`/api/trips/${trip.id}/messages`, me)).some((m) => m.id === g.id && m.proposedBookings));
  ok('...and wrote nothing by itself', (await get(`/api/trips/${trip.id}`, me)).bookings.length === 1);
  const bag = [...h.bag('trip-planner').entries()].map(([k, v]) => JSON.stringify(v)).join('');
  ok('no email body was stored', !bag.includes('Pickup Tue Sep 22 5 PM'));
  r = await post(`/api/trips/${trip.id}/messages/${g.id}/discard`, { which: 'bookings' }, me);
  msgs = await get(`/api/trips/${trip.id}/messages`, me);
  ok('discarding it is remembered', msgs.find((m) => m.id === g.id).bookingsState === 'discarded');

  /* ---------- Google ends the connection after seven days ---------- */
  global.__expire = true;
  r = await post(`/api/trips/${trip.id}/gmail-bookings`, {}, me);
  let ended = await r.json();
  ok('an expired Gmail connection is explained, and asks to reconnect', ended.needsConnect === true && /seven days/.test(ended.error || ''), JSON.stringify(ended).slice(0, 120));
  let gs = await get('/api/gmail', me);
  ok('...and the account stops saying connected', gs.connected === false && gs.expired === true, JSON.stringify({ c: gs.connected, e: gs.expired }));
  r = await post(`/api/trips/${trip.id}/gmail-bookings`, {}, me);
  ok('...the next try says so before reading anything', r.status === 400 && (await r.json()).needsConnect === true);
  global.__expire = false;
  const crypto = require('crypto');
  const payload = uid + '.' + Date.now();
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  r = await realFetch(`${B}/api/gmail/callback?code=abc&state=${encodeURIComponent(payload + '.' + mac)}`, { headers: { cookie: me }, redirect: 'manual' });
  gs = await get('/api/gmail', me);
  ok('reconnecting clears it (a merge write would otherwise keep the old expiry)', gs.connected === true && gs.expired === false,
     (r.headers.get('location') || '') + ' ' + JSON.stringify({ c: gs.connected, e: gs.expired }));

  /* ---------- import carries bookings, cleaned ---------- */
  r = await post('/api/gmail/import', { trips: [{ name: 'Jamaica', destination: 'Montego Bay', bookings: [
    { kind: 'flight', title: '<img src=x onerror=alert(1)>ATL to MBJ', confirmation: 'DL123', url: 'javascript:alert(1)', phone: 'call me' },
  ] }] }, me);
  const created = (await r.json()).created[0];
  const imp = await get(`/api/trips/${created}`, me);
  ok('an imported trip arrives with its bookings', imp.bookings && imp.bookings.length === 1 && imp.bookings[0].confirmation === 'DL123');
  ok('...with markup stripped and no unsafe link, because the browser handed these back',
     !/[<>]/.test(imp.bookings[0].title) && imp.bookings[0].url === '' && imp.bookings[0].phone === '');

  /* ---------- other people ---------- */
  const other = (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'x@example.com', password: 'a-long-password-2' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  r = await post(`/api/trips/${trip.id}/bookings/apply`, { bookings: [STAY] }, other);
  ok('someone else cannot change my bookings', r.status === 404, String(r.status));
  r = await realFetch(`${B}/api/trips/${trip.id}/bookings/${t.bookings[0].id}`, { method: 'DELETE', headers: { cookie: other } });
  ok('...or delete one', r.status === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
