// Reading someone's Gmail, with their consent.
//
// This suite is mostly about restraint rather than function: the token we hold
// can read the whole mailbox, and what makes the feature honest is that the
// code never asks it to. So the assertions are about what is NOT done - the
// query cannot be widened by a request, bodies are never stored, nothing
// becomes a trip without a tap, and disconnecting hands the grant back to
// Google rather than just forgetting it.
const h = require('./harness.js');
h.install();

const SECRET = 'identity-secret-abcdefghijklmn';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: SECRET,
  SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner',
  IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  GOOGLE_CLIENT_ID: 'client-id-here',
  GOOGLE_CLIENT_SECRET: 'client-secret-here',
  GOOGLE_REDIRECT_URI: 'https://trip.example.com/api/gmail/callback',
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  PORT: '9213',
});

// The model finds one trip across two emails.
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async () => ({
    stop_reason: 'end_turn',
    usage: { input_tokens: 50, output_tokens: 20 },
    content: [{
      type: 'tool_use', name: 'found_trips',
      input: { trips: [{
        name: 'Lisbon, October', destination: 'Lisbon', dateRange: 'Oct 3-10, 2026',
        notes: 'TP1234, conf ABC123', sourceIds: ['m1', 'm2'],
      }] },
    }],
  }) }, batches: {} };
};

require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9213';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const send = (m, p, b, c) => fetch(B + p, { method: m, headers: c ? { ...J, cookie: c } : J, body: b === undefined ? undefined : JSON.stringify(b), redirect: 'manual' });
const post = (p, b, c) => send('POST', p, b, c);
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

/* ---------- a stand-in for Google ---------- */
const seen = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1:9213')) return realFetch(url, init);
  seen.push(u);
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const sent = new URLSearchParams(init.body);
    return reply(sent.get('grant_type') === 'refresh_token'
      ? { access_token: 'access-token' }
      : { access_token: 'access-token', refresh_token: 'THE-REFRESH-TOKEN' });
  }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return reply({});
  if (u.includes('/users/me/profile')) return reply({ emailAddress: 'traveller@example.com' });
  if (u.includes('/users/me/messages?')) return reply({ messages: [{ id: 'm1' }, { id: 'm2' }] });
  if (u.includes('/users/me/messages/')) {
    const id = u.split('/messages/')[1].split('?')[0];
    return reply({
      id, snippet: 'Your booking',
      payload: {
        headers: [
          { name: 'From', value: 'TAP <noreply@tapairportugal.com>' },
          { name: 'Subject', value: 'Your booking is confirmed' },
          { name: 'Date', value: 'Mon, 1 Sep 2026 10:00:00 +0000' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('Flight TP1234 to Lisbon, 3 Oct.').toString('base64url') },
      },
    });
  }
  return { ok: false, status: 404, json: async () => ({ error: 'unexpected ' + u }) };
};

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const gmailLib = require(require('path').join(__dirname, '..', 'gmail.js'));

  const cookie = jar(await post('/api/auth/register', { email: 'traveller@example.com', password: 'a-long-password-1' }));
  const uid = Buffer.from('traveller@example.com').toString('base64url');
  const bag = h.bag('trip-planner');

  /* ---------- the promise the consent screen makes ---------- */
  let r = await fetch(B + '/api/gmail', { headers: { cookie } });
  let body = await r.json();
  ok('the app reports whether Gmail is wired up', body.available === true, JSON.stringify(body.available));
  ok('...and that nothing is connected yet', body.connected === false);
  ok('...and names the senders it will look at', Array.isArray(body.senders) && body.senders.length > 10, String(body.senders && body.senders.length));

  // The query is built from that same list and takes no arguments, so the
  // screen cannot promise one thing while the code does another.
  const g = gmailLib.create({ clientId: () => 'x', clientSecret: () => 'y', redirectUri: () => 'z' });
  const q = g.searchQuery(new Date('2026-09-21T00:00:00Z'));
  ok('the query only names those senders',
     body.senders.every((d) => q.includes('from:' + d)), q.slice(0, 60));
  ok('...and is bounded by a date window', /after:\d{4}\/\d{2}\/\d{2}/.test(q), q.slice(-24));
  ok('searchQuery takes no caller input at all', g.searchQuery.length <= 1, String(g.searchQuery.length));

  /* ---------- connecting ---------- */
  r = await fetch(B + '/api/gmail/connect', { headers: { cookie }, redirect: 'manual' });
  const to = r.headers.get('location') || '';
  ok('connect sends you to Google', r.status === 302 && to.startsWith('https://accounts.google.com/'), String(r.status));
  ok('...asking only to READ Gmail', to.includes(encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly')));
  ok('...and for nothing else', !/contacts|calendar|profile|drive/.test(decodeURIComponent(to)));
  ok('...offline, or the grant dies in an hour', to.includes('access_type=offline') && to.includes('prompt=consent'));
  const state = new URL(to).searchParams.get('state');

  // A state someone else made must not be able to hang THEIR mailbox off this
  // account - that is the whole reason it is signed.
  r = await fetch(B + `/api/gmail/callback?code=x&state=${uid}.${Date.now()}.forged`, { headers: { cookie }, redirect: 'manual' });
  ok('a forged state is refused', (r.headers.get('location') || '').includes('bad-state'), r.headers.get('location'));
  ok('...and nothing was stored', !(bag.get('users/' + uid) || {}).gmail);

  r = await fetch(B + `/api/gmail/callback?code=the-code&state=${encodeURIComponent(state)}`, { headers: { cookie }, redirect: 'manual' });
  ok('a real callback connects', (r.headers.get('location') || '').includes('gmail=connected'), r.headers.get('location'));

  const stored = (bag.get('users/' + uid) || {}).gmail || {};
  ok('the refresh token is stored ENCRYPTED', Boolean(stored.refresh) && !String(stored.refresh).includes('THE-REFRESH-TOKEN'), String(stored.refresh).slice(0, 24));
  ok('...and the address is shown back, so you know whose mailbox it is', stored.address === 'traveller@example.com', stored.address);

  /* ---------- scanning ---------- */
  seen.length = 0;
  r = await post('/api/gmail/scan', {}, cookie);
  body = await r.json();
  ok('a scan proposes what it found', Array.isArray(body.trips) && body.trips.length === 1, JSON.stringify(body).slice(0, 120));
  ok('...with the emails it came from, not just a summary',
     body.trips[0].sources.length === 2 && /tapairportugal/.test(body.trips[0].sources[0].from), JSON.stringify(body.trips[0].sources));
  ok('...having searched only the curated query',
     seen.some((u) => u.includes('/messages?q=') && u.includes('tapairportugal.com')), seen.join(' | ').slice(0, 120));

  // The point of "propose only": a scan writes nothing.
  const tripsAfterScan = [...bag.keys()].filter((k) => k.startsWith('trips/'));
  ok('a scan creates no trips', tripsAfterScan.length === 0, JSON.stringify(tripsAfterScan));
  // And keeps no mail. Nothing in the record should carry a subject or body.
  ok('...and stores nothing from the emails',
     !JSON.stringify(bag.get('users/' + uid)).includes('booking is confirmed'), JSON.stringify(bag.get('users/' + uid)).slice(0, 120));

  /* ---------- importing is the tap ---------- */
  r = await post('/api/gmail/import', { trips: [body.trips[0]] }, cookie);
  const imported = await r.json();
  ok('importing creates the trip', r.status === 200 && imported.created.length === 1, JSON.stringify(imported));
  const trip = bag.get('trips/' + imported.created[0]);
  ok('...owned by them', trip.ownerId === uid);
  ok('...marked as having come from a mailbox', trip.importedFrom === 'gmail');
  ok('...carrying the confirmation numbers', /ABC123/.test(trip.notes), trip.notes);

  r = await post('/api/gmail/import', { trips: [] }, cookie);
  ok('importing nothing is a 400, not an empty trip', r.status === 400, String(r.status));

  /* ---------- disconnecting ---------- */
  seen.length = 0;
  r = await send('DELETE', '/api/gmail', undefined, cookie);
  ok('disconnect succeeds', r.status === 200, String(r.status));
  ok('...by handing the grant back to Google', seen.some((u) => u.startsWith('https://oauth2.googleapis.com/revoke')), seen.join(' | '));
  ok('...and forgetting the token', !(bag.get('users/' + uid) || {}).gmail);

  r = await post('/api/gmail/scan', {}, cookie);
  ok('a scan after disconnecting is refused', r.status === 400, String(r.status));

  /* ---------- signed out ---------- */
  r = await fetch(B + '/api/gmail', { redirect: 'manual' });
  ok('none of this is reachable signed out', r.status === 401 || r.status === 302, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
