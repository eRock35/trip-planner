// Bring your own key, end to end through trip-planner: saving it, the key
// never coming back, the request actually going out on it, not being charged
// for it, and removing it putting everything back.
const h = require('./harness.js');
h.install();

// Which API key each outgoing call was built with, and what it asked for.
const sent = [];
require.cache['FAKE_AN'].exports = function (opts) {
  const apiKey = (opts && opts.apiKey) || process.env.ANTHROPIC_API_KEY;
  return { messages: { create: async (params) => {
    sent.push({ apiKey, model: params.model });
    return { stop_reason: 'end_turn', usage: { input_tokens: 100000, output_tokens: 20000 },
             content: [{ type: 'text', text: 'An answer.' }] };
  } }, batches: {} };
};

// A stand-in for Anthropic's /v1/models, so validate() has something to call.
const http = require('http');
const VALID = 'sk-ant-api03-' + 'v'.repeat(60) + 'GOOD';
http.createServer((req, res) => {
  const key = req.headers['x-api-key'] || '';
  res.writeHead(key === VALID ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end('{}');
}).listen(9310, '127.0.0.1');

process.env.BYOK_VALIDATE_URL = 'http://127.0.0.1:9310/v1/models';
process.env.BYOK_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'trip-secret-abcdefghijklmnop';
process.env.FIRESTORE_DATABASE_ID = 'trip-planner';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.ANTHROPIC_API_KEY = 'sk-ant-the-service-key';
process.env.PORT = '9210';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9210';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const del = (p, c) => fetch(B + p, { method: 'DELETE', headers: { cookie: c } });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const ids = h.bag('identity');
  const EMAIL = 'byok@example.com';
  const user = jar(await post('/api/auth/register', { email: EMAIL, password: 'a-long-password-1' }));
  const uid = uidOf(EMAIL);
  const k = 'users/' + uid;
  ids.set(k, Object.assign({}, ids.get(k), { access: { 'trip-planner': 'member' } }));
  const me = async () => (await fetch(B + '/api/auth/me', { headers: { cookie: user } })).json();

  // --- before
  ok('starts with no key on file', (await me()).byok.present === false, JSON.stringify((await me()).byok));
  const trip = await (await post('/api/trips', { name: 'T', destination: 'X' }, user)).json();
  sent.length = 0;
  await post(`/api/trips/${trip.id}/chat`, { question: 'hi' }, user);
  ok('runs on the service key by default', sent[0].apiKey === 'sk-ant-the-service-key', sent[0].apiKey);
  ok('...on the free model', sent[0].model === 'claude-haiku-4-5', sent[0].model);
  const spentBefore = Number((ids.get(k) || {}).spentUsd || 0);
  ok('the free call was charged to them', spentBefore > 0, String(spentBefore));

  // --- saving
  let r = await post('/api/auth/byok', { key: 'not-a-key' }, user);
  ok('a key that is not an Anthropic key is refused', r.status === 400, String(r.status));
  r = await post('/api/auth/byok', { key: 'sk-ant-api03-' + 'w'.repeat(60) + 'BAD1' }, user);
  ok('a key Anthropic rejects is refused', r.status === 400, JSON.stringify(await r.json()));
  r = await post('/api/auth/byok', { key: VALID }, user);
  const saved = await r.json();
  ok('a working key is accepted', r.status === 200, JSON.stringify(saved));
  ok('the response shows only the last four', saved.byok.last4 === 'GOOD' && !JSON.stringify(saved).includes(VALID));

  const stored = ids.get(k);
  ok('the key is not stored in the clear', !JSON.stringify(stored).includes(VALID), JSON.stringify(stored.byok).slice(0, 80));
  ok('what is stored is version tagged', String(stored.byok.blob).startsWith('v1.'));
  ok('/me never returns the key', !JSON.stringify(await me()).includes(VALID));
  ok('/me reports it is present', (await me()).byok.present === true && (await me()).byok.last4 === 'GOOD');

  // --- using
  sent.length = 0;
  const before = Number((ids.get(k) || {}).spentUsd || 0);
  await post(`/api/trips/${trip.id}/chat`, { question: 'hi again' }, user);
  ok('the call goes out on THEIR key', sent[0].apiKey === VALID, sent[0].apiKey);
  ok('...and gets the paid model', sent[0].model === 'claude-sonnet-5', sent[0].model);
  ok('...and is not charged to them', Number((ids.get(k) || {}).spentUsd || 0) === before,
     `${before} -> ${(ids.get(k) || {}).spentUsd}`);
  const usage = [...h.bag('identity').entries()].filter(([key]) => key.startsWith('usage/')).map(([, v]) => v);
  ok('...but is still recorded for the dashboard', usage.some((u) => u.byok === true), JSON.stringify(usage.slice(-1)));
  ok('their budget reads as unlimited', (await me()).budget.reason === 'byok', (await me()).budget.reason);

  // --- removing
  r = await del('/api/auth/byok', user);
  ok('it can be removed', r.status === 200);
  ok('...and /me says so', (await me()).byok.present === false);
  ok('...and the record no longer holds it', !(ids.get(k) || {}).byok);
  sent.length = 0;
  await post(`/api/trips/${trip.id}/chat`, { question: 'once more' }, user);
  ok('...and calls go back to the service key', sent[0].apiKey === 'sk-ant-the-service-key', sent[0].apiKey);
  ok('...on the free model again', sent[0].model === 'claude-haiku-4-5', sent[0].model);

  // --- nobody else's business
  r = await post('/api/auth/byok', { key: VALID }, '');
  ok('a signed-out request cannot save a key', r.status === 401, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
