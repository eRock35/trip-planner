// Who may spend, and how much - now that nobody approves anybody.
//
// The approval gate was written when "ask Erik" was the only cost control.
// The budget is the control now: everyone who registers can use chat, bounded
// by their own allowance, and they buy more. This suite pins the two things
// that replaced the gate, because removing a gate is exactly the change worth
// being able to prove.
const h = require('./harness.js');
h.install();

require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async () => ({
    stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
    content: [{ type: 'text', text: 'An answer.' }],
  }) }, batches: {} };
};

const SECRET = 'identity-secret-abcdefghijklmn';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: SECRET,
  SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner',
  IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  FREE_TIER_DAILY_CAP_USD: '2',
  // Off, so writing the counter and asking in the next line is not answered
  // from the value read a moment earlier.
  DAILY_CAP_CACHE_MS: '0',
  // Production sets this, and the 402's top-up link is derived from it.
  PASSKEY_RP_ID: 'strongtechnicalconsulting.com',
  PORT: '9212',
});
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9212';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const today = () => new Date().toISOString().slice(0, 10);

/** Ask a question on a trip this cookie owns. */
async function ask(cookie) {
  const trip = await (await post('/api/trips', { name: 'T', destination: 'X' }, cookie)).json();
  return post(`/api/trips/${trip.id}/chat`, { question: 'where should we eat' }, cookie);
}

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const ids = h.bag('identity');

  /* ---------- a brand new account can just use it ---------- */
  const fresh = jar(await post('/api/auth/register', { email: 'new@example.com', password: 'a-long-password-1' }));
  let r = await ask(fresh);
  ok('a brand new account can use chat without asking anyone', r.status === 200, String(r.status));

  const me = await (await fetch(B + '/api/auth/me', { headers: { cookie: fresh } })).json();
  ok('...and is told what it has to spend', me.budget && me.budget.allowanceUsd > 0, JSON.stringify(me.budget));
  ok('...which is not unlimited', me.budget.unlimited === false, JSON.stringify(me.budget));

  /* ---------- what the counter counts ----------
     The blocking half is only half. If a member's usage filled the free
     tier's daily allowance, $2 would stop meaning "what strangers cost me"
     and start meaning "what anyone cost me", and the ceiling would lock out
     the people it exists to serve. */
  const counter = () => Number((h.bag('identity').get('control/free-spend-trip-planner-' + today()) || {}).usd || 0);
  ok('free-tier spend counts toward the ceiling', counter() > 0, String(counter()));

  const paid = jar(await post('/api/auth/register', { email: 'paid@example.com', password: 'a-long-password-9' }));
  const pk = uidOf('paid@example.com');
  ids.set('users/' + pk, { ...ids.get('users/' + pk), toppedUpUsd: 25 });
  const before = counter();
  r = await ask(paid);
  ok('a paying account can chat', r.status === 200, String(r.status));
  // Fire-and-forget metering: give the write a moment to land, then assert it
  // did not.
  await new Promise((r2) => setTimeout(r2, 120));
  ok("...and their spend does NOT count against the free tier", counter() === before,
     `${before} -> ${counter()}`);

  /* ---------- until their own allowance is gone ---------- */
  const uid = uidOf('new@example.com');
  ids.set('users/' + uid, { ...ids.get('users/' + uid), spentUsd: 999 });
  r = await ask(fresh);
  ok('an account out of credit is refused', r.status === 402, String(r.status));
  let body = await r.json();
  ok('...and told where to top up', Boolean(body.topUpUrl), JSON.stringify(body).slice(0, 120));
  ids.set('users/' + uid, { ...ids.get('users/' + uid), spentUsd: 0 });

  /* ---------- and the ceiling over everyone ----------
     The per-user budget bounds ONE account. Accounts are free and a uid is
     derived from an email, so without this the exposure is unbounded no
     matter how carefully each account is metered. */
  h.bag('identity').set('control/free-spend-trip-planner-' + today(), { usd: 99 });
  const second = jar(await post('/api/auth/register', { email: 'second@example.com', password: 'a-long-password-2' }));
  r = await ask(second);
  ok('a new account cannot route around the day being spent', r.status === 503, String(r.status));
  body = await r.json();
  ok('...and is told it is the free tier, not them', /free tier/i.test(body.error || ''), JSON.stringify(body));
  ok('...and that paying removes the limit', Boolean(body.topUpUrl), JSON.stringify(body).slice(0, 140));

  /* ---------- and it never blocks someone who paid ----------
     A ceiling low enough to be a real limit on strangers is low enough to
     lock out a customer by lunchtime, if it counts them too. */
  const member = jar(await post('/api/auth/register', { email: 'member@example.com', password: 'a-long-password-5' }));
  const mk = uidOf('member@example.com');
  ids.set('users/' + mk, { ...ids.get('users/' + mk), plan: 'member' });
  r = await ask(member);
  ok('a member is not blocked by the free tier being spent', r.status === 200, String(r.status));

  const topped = jar(await post('/api/auth/register', { email: 'topped@example.com', password: 'a-long-password-6' }));
  const tk = uidOf('topped@example.com');
  ids.set('users/' + tk, { ...ids.get('users/' + tk), toppedUpUsd: 25 });
  r = await ask(topped);
  ok('...nor is someone who bought credit', r.status === 200, String(r.status));

  /* ---------- but it never locks out the person paying the bill ---------- */
  const boss = jar(await post('/api/auth/register', { email: 'boss@example.com', password: 'a-long-password-3' }));
  ids.set('users/' + uidOf('boss@example.com'), { ...ids.get('users/' + uidOf('boss@example.com')), admin: true });
  r = await ask(boss);
  ok('the owner still gets in over the ceiling', r.status === 200, String(r.status));

  // Their own key is their own bill, so the ceiling is not theirs either.
  // A key only counts while the membership does - it is the fee, not the key,
  // that says this person is not a stranger.
  const byok = jar(await post('/api/auth/register', { email: 'byok@example.com', password: 'a-long-password-4' }));
  const bk = uidOf('byok@example.com');
  ids.set('users/' + bk, { ...ids.get('users/' + bk), byok: { blob: 'x', last4: '1234' } });
  r = await ask(byok);
  ok('a key alone does not get past the ceiling', r.status === 503, String(r.status));
  ids.set('users/' + bk, { ...ids.get('users/' + bk), plan: 'member' });
  r = await ask(byok);
  ok('...and with the membership it does', r.status === 200, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
