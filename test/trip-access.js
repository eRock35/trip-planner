// The bug: trip-planner kept its own aiAccess flag and never looked at the
// shared account, so a grant made in the domain-wide admin panel did nothing
// here - and the owner's second address was asked to request permission for
// an app he runs.
const h = require('./harness.js');
h.install();

require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async () => ({
    stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
    content: [{ type: 'text', text: 'An answer.' }] }) }, batches: {} };
};

process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'trip-secret-abcdefghijklmnop';
process.env.FIRESTORE_DATABASE_ID = 'trip-planner';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.PASSKEY_RP_ID = 'strongtechnicalconsulting.com';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = '9208';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9208';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const ids = h.bag('identity');

  const owner = jar(await post('/api/auth/register', { email: 'boss@example.com', password: 'a-long-password-1' }));
  const granted = jar(await post('/api/auth/register', { email: 'granted@example.com', password: 'a-long-password-2' }));
  const stranger = jar(await post('/api/auth/register', { email: 'stranger@example.com', password: 'a-long-password-3' }));

  // Exactly what the admin panel writes: a per-app grant on the shared record.
  const gk = 'users/' + uidOf('granted@example.com');
  ids.set(gk, Object.assign({}, ids.get(gk), { access: { 'trip-planner': 'member' } }));

  // And the owner's SECOND address: owner flag, no trip-planner grant at all.
  const second = jar(await post('/api/auth/register', { email: 'second@example.com', password: 'a-long-password-4' }));
  const sk = 'users/' + uidOf('second@example.com');
  ids.set(sk, Object.assign({}, ids.get(sk), { admin: true }));

  const mine = async (c) => (await fetch(B + '/api/auth/me', { headers: { cookie: c } })).json();

  ok('the ADMIN_EMAIL account is approved', (await mine(owner)).aiAccess === 'approved');
  ok('a shared-panel grant approves here too', (await mine(granted)).aiAccess === 'approved',
     JSON.stringify(await mine(granted)));
  ok('the owner\'s second address is approved without a grant', (await mine(second)).aiAccess === 'approved',
     JSON.stringify(await mine(second)));
  ok('the owner\'s second address is admin here', (await mine(second)).isAdmin === true);
  ok('a stranger is still not approved', (await mine(stranger)).aiAccess === 'none');

  // ...and it is the real gate, not just what /me reports.
  let trip = await (await post('/api/trips', { name: 'T', destination: 'X' }, granted)).json();
  let r = await post(`/api/trips/${trip.id}/chat`, { question: 'hi' }, granted);
  ok('a granted account can actually chat', r.status === 200, String(r.status));

  // A stranger is not "approved" and it no longer matters: approval stopped
  // being the gate on 2026-09-21. Anyone who registers can spend their own
  // allowance and buys more; what a grant still does is described above.
  const st = await (await post('/api/trips', { name: 'S', destination: 'Y' }, stranger)).json();
  r = await post(`/api/trips/${st.id}/chat`, { question: 'hi' }, stranger);
  ok('a stranger can chat on their own allowance', r.status === 200, String(r.status));

  // Out of credit carries somewhere to go.
  const sk2 = 'users/' + uidOf('stranger@example.com');
  ids.set(sk2, Object.assign({}, ids.get(sk2), { access: { 'trip-planner': 'member' }, spentUsd: 99 }));
  r = await post(`/api/trips/${st.id}/chat`, { question: 'hi' }, stranger);
  const body = await r.json();
  ok('an exhausted balance is a 402', r.status === 402, String(r.status));

  // The link follows the money. With no Stripe key mounted this service
  // cannot take a payment however good its sheet looks, so it names one that
  // can rather than dead-ending on "not switched on"...
  ok('with no Stripe key, the 402 points at a service that can sell',
     body.topUpUrl === 'https://dataviz.strongtechnicalconsulting.com/?topup=1', body.topUpUrl);

  // ...and the moment this service is given the key, the link comes home and
  // the reader buys credit here instead of in somebody else's app.
  const identity = require(require('path').join(__dirname, '..', 'identity.js'));
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_MEMBER_PRICE_ID = 'price_member_dummy';
  r = await post(`/api/trips/${st.id}/chat`, { question: 'hi' }, stranger);
  const local = await r.json();
  ok('...and with one, it opens this app\u2019s own sheet', local.topUpUrl === '?topup=1', local.topUpUrl);
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_MEMBER_PRICE_ID;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
