// Email verification in Trip Planner (2026-09-27).
//
// Nothing used to prove that whoever registered an address owned it, and a
// trip shared TO an address opened for whoever registered it first. Now:
//
// - a trip shared to an address opens (list, the trip itself, the passport)
//   only once that account has confirmed its email - or predates the rule;
// - the owner of a trip is never gated, confirmed or not;
// - an unconfirmed account gets no FREE AI credit: a model call is a 403
//   with code 'verify-email', and the hourly watch sweep skips its watches;
// - /api/auth/me (which shadows identity's) reports emailVerified.
//
// The harness normally stores new accounts confirmed; this suite turns that
// off and confirms by hand, through identity's own confirmEmail.
const h = require('./harness.js');
h.install();
h.autoVerify(false);
const path = require('path');

const calls = [];
require.cache['FAKE_AN'].exports = function FakeAnthropic() {
  return { messages: { create: async (params) => {
    calls.push({ model: params.model });
    return { content: [{ type: 'text', text: '$842 return, nonstop.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } };
  } }, batches: {} };
};
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (/nominatim|openbrewerydb|met\.no|frankfurter/.test(u)) return new Response('[]', { status: 200 });
  return realFetch(url, opts);
};

const PORT = 9263;
const SECRET = 'identity-secret-abcdefghijklmn';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: SECRET, SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: String(PORT), CRON_SECRET: 'cron-test-key',
});
delete process.env.REQUIRE_VERIFIED_FOR_FREE_AI;
delete process.env.IDENTITY_MAIL_URL;
require(path.join(__dirname, '..', 'server.js'));
const identityLib = require(path.join(__dirname, '..', 'identity.js'));
const identityStore = require(path.join(__dirname, '..', 'identity-store.js'));
// Confirming happens on the landing in production; the same module does it.
const landing = identityLib.create({ store: identityStore.store, secret: () => SECRET, app: 'landing-stand-in' });

const B = 'http://127.0.0.1:' + PORT;
const J = { 'content-type': 'application/json' };
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const ids = h.bag('identity'), tp = h.bag('trip-planner');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const call = async (method, p, body, cookie, extra = {}) => {
  const r = await fetch(B + p, { method, headers: Object.assign({}, J, cookie ? { cookie } : {}, extra), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* whitespace-streamed or not json */ }
  return { status: r.status, body: json };
};
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const register = async (email) => jar(await fetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }));
const confirm = (email) => landing.confirmEmail(identityLib.makeVerifyToken(uidOf(email), email, SECRET));

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  tp.set('control/crowd-backfill', { doneAt: '2026-09-27T00:00:00.000Z' });   // not this suite's business

  const erik = await register('erik@example.com');
  ok('a new account is stored unconfirmed', ids.get('users/' + uidOf('erik@example.com')) && !ids.get('users/' + uidOf('erik@example.com')).emailVerifiedAt);
  let r = await call('GET', '/api/auth/me', undefined, erik);
  ok('/api/auth/me reports emailVerified: false', r.body && r.body.emailVerified === false, JSON.stringify(r.body && r.body.emailVerified));

  /* ---------- the owner is never gated ---------- */
  r = await call('POST', '/api/trips', { name: 'Destin', destination: 'Destin, FL', dateRange: 'Oct 3-7, 2026' }, erik);
  const trip = r.body;
  ok('an unconfirmed owner starts a trip', r.status === 200 && trip && trip.id);
  r = await call('GET', `/api/trips/${trip.id}`, undefined, erik);
  ok('...and opens it', r.status === 200 && r.body.role === 'owner', r.status);
  r = await call('GET', '/api/trips', undefined, erik);
  ok('...and it is in their list', r.status === 200 && r.body.length === 1 && r.body[0].id === trip.id);
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: 'sarah@example.com' }, erik);
  ok('...and can share it', r.status === 200 && r.body.members.length === 1, r.status);

  /* ---------- a member must confirm first ---------- */
  const sarah = await register('sarah@example.com');
  r = await call('GET', '/api/trips', undefined, sarah);
  ok('an unconfirmed account does not see a trip shared to its address', r.status === 200 && r.body.length === 0, JSON.stringify(r.body));
  r = await call('GET', `/api/trips/${trip.id}`, undefined, sarah);
  ok('...and opening it is the stranger\'s 404', r.status === 404, r.status);
  r = await call('GET', `/api/trips/${trip.id}/messages`, undefined, sarah);
  ok('...on its sub-routes too', r.status === 404, r.status);
  r = await call('POST', `/api/trips/${trip.id}/lock`, {}, sarah);
  ok('...and it cannot change it', r.status === 404 && (tp.get('trips/' + trip.id) || {}).status !== 'locked', r.status);
  r = await call('GET', '/api/passport', undefined, sarah);
  ok('...and the lifetime passport (which reads the same two queries) still answers', r.status === 200, r.status);

  const res = await confirm('sarah@example.com');
  ok('confirming the address (the link) marks it', res.ok === true && Boolean(ids.get('users/' + uidOf('sarah@example.com')).emailVerifiedAt));
  r = await call('GET', '/api/auth/me', undefined, sarah);
  ok('/api/auth/me now reports emailVerified: true', r.body.emailVerified === true);
  r = await call('GET', '/api/trips', undefined, sarah);
  ok('once confirmed, the shared trip is in the list', r.body.length === 1 && r.body[0].id === trip.id && r.body[0].role === 'member', JSON.stringify(r.body));
  r = await call('GET', `/api/trips/${trip.id}`, undefined, sarah);
  ok('...and opens as a member', r.status === 200 && r.body.role === 'member', r.status);

  // An account from before the rule is grandfathered.
  const oldUid = uidOf('grandma@example.com');
  ids.set('users/' + oldUid, { email: 'grandma@example.com', password: identityLib.makeHash('a-long-password-1'), createdAt: '2026-09-20T10:00:00.000Z' });
  await call('POST', `/api/trips/${trip.id}/share`, { email: 'grandma@example.com' }, erik);
  const grandma = h.session(SECRET, 'grandma@example.com');
  r = await call('GET', '/api/trips', undefined, grandma);
  ok('an account made before the cutoff sees trips shared with it', r.body.length === 1 && r.body[0].id === trip.id, JSON.stringify(r.body));

  // A stranger confirmed is still a stranger.
  const bob = await register('bob@example.com');
  await confirm('bob@example.com');
  r = await call('GET', `/api/trips/${trip.id}`, undefined, bob);
  ok('a confirmed stranger still gets 404', r.status === 404);

  /* ---------- the free AI credit ---------- */
  const before = calls.length;
  r = await call('POST', `/api/trips/${trip.id}/chat`, { question: 'What is on Thursday?' }, erik);
  ok('an unconfirmed owner\'s chat is refused before any model call', r.status === 403 && calls.length === before, `${r.status} ${calls.length - before}`);
  ok('...with the verify-email code and a sentence to show', r.body && r.body.code === 'verify-email' && /^Confirm your email to use the free AI credit\. We sent a link to erik@example\.com\.$/.test(r.body.error), JSON.stringify(r.body));
  ok('...and the resend path under this app\'s mount', r.body && r.body.resend === '/api/auth/verify/send', r.body && r.body.resend);
  r = await call('POST', '/api/auth/verify/send', {}, erik);
  ok('which answers', r.status === 200 && r.body.ok === true, r.status);
  // Someone paying is not asked.
  ids.set('users/' + uidOf('erik@example.com'), { ...ids.get('users/' + uidOf('erik@example.com')), toppedUpUsd: 5 });
  r = await call('POST', `/api/trips/${trip.id}/chat`, { question: 'What is on Thursday?' }, erik);
  ok('an unconfirmed account that bought credit is not gated', r.status === 200 && calls.length > before, r.status);
  ids.set('users/' + uidOf('erik@example.com'), { ...ids.get('users/' + uidOf('erik@example.com')), toppedUpUsd: 0 });
  r = await call('POST', `/api/trips/${trip.id}/chat`, { question: 'Anything else?' }, sarah);
  ok('a confirmed member chats on the free credit', r.status === 200, r.status);

  /* ---------- the hourly sweep ---------- */
  await call('POST', `/api/trips/${trip.id}/watches`, { kind: 'flight', label: 'ATL to VPS', intervalHours: 6 }, erik);
  const n = calls.length;
  r = await call('POST', '/api/cron/check-watches', undefined, null, { 'X-Cron-Key': 'cron-test-key' });
  ok('the sweep skips an unconfirmed free owner\'s watch, spending nothing', r.status === 200 && r.body.checked === 0 && r.body.skippedNoCredit === 1 && calls.length === n, JSON.stringify(r.body));
  await confirm('erik@example.com');
  r = await call('POST', '/api/cron/check-watches', undefined, null, { 'X-Cron-Key': 'cron-test-key' });
  ok('...and checks it once the owner has confirmed', r.status === 200 && r.body.checked === 1 && calls.length > n, JSON.stringify(r.body));

  /* ---------- the page ---------- */
  const page = await (await fetch(B + '/')).text();
  ok('the page loads the shared banner at /api/auth', page.includes('<script src="/verify-banner.js" data-mount="/api/auth" defer></script>'));
  ok('...says why shared trips may be missing', page.includes('Trips shared with you appear once you confirm your email.'));
  ok('...and shows the 403 sentence rather than a generic failure', /res\.status === 402 \|\| res\.status === 403 \|\| res\.status === 503/.test(page));
  const js = await fetch(B + '/verify-banner.js');
  ok('/verify-banner.js is served', js.status === 200 && /stc-verify-banner/.test(await js.text()));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
