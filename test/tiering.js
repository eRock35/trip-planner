// The point of tiering is that a free request costs half as much, and the
// point of pairing the search tool with the model is that the cheap one does
// not 400. Assert both by recording what the app actually sends.
const h = require('./harness.js');
h.install();

const sent = [];
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async (params) => {
    sent.push({ model: params.model, tools: (params.tools || []).map((t) => t.type || t.name) });
    return { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
             content: [{ type: 'text', text: 'An answer.' }] };
  } }, batches: {} };
};

process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'trip-secret-abcdefghijklmnop';
process.env.FIRESTORE_DATABASE_ID = 'trip-planner';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = '9209';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9209';
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
  const free = jar(await post('/api/auth/register', { email: 'free@example.com', password: 'a-long-password-2' }));
  const pro = jar(await post('/api/auth/register', { email: 'pro@example.com', password: 'a-long-password-3' }));
  for (const [email, patch] of [
    ['free@example.com', { access: { 'trip-planner': 'member' } }],
    ['pro@example.com', { access: { 'trip-planner': 'member', dataviz: 'pro' } }],
  ]) {
    const k = 'users/' + uidOf(email);
    ids.set(k, Object.assign({}, ids.get(k), patch));
  }

  const ask = async (cookie) => {
    const trip = await (await post('/api/trips', { name: 'T', destination: 'X' }, cookie)).json();
    sent.length = 0;
    await post(`/api/trips/${trip.id}/chat`, { question: 'hi' }, cookie);
    return sent[0] || {};
  };

  let c = await ask(free);
  ok('a free account runs on Haiku', c.model === 'claude-haiku-4-5', c.model);
  ok('...with the search tool Haiku accepts', c.tools.includes('web_search_20250305'), JSON.stringify(c.tools));
  ok('...and never the one it 400s on', !c.tools.includes('web_search_20260209'));

  c = await ask(owner);
  ok('the owner runs on Sonnet', c.model === 'claude-sonnet-5', c.model);
  ok('...with the newer search tool', c.tools.includes('web_search_20260209'), JSON.stringify(c.tools));

  c = await ask(pro);
  ok('a Pro account runs on Sonnet', c.model === 'claude-sonnet-5', c.model);

  ok('the schedule tool survives the swap', c.tools.includes('propose_schedule_change'), JSON.stringify(c.tools));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
