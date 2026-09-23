// Things to do: found with web search, saved on the trip, cleaned on the way.
const h = require('./harness.js');
h.install();
let sawTools = null; let sawSystem = '';
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async (req) => {
    sawTools = req.tools; sawSystem = req.system;
    return { stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 }, content: [
      { type: 'tool_use', id: 't', name: 'things_to_do', input: { ideas: [
        { name: 'Grayton Beach State Park', kind: 'Outdoors', why: 'Dune lakes and a quiet beach.', where: '10 min', cost: '$5 a car', url: 'https://www.floridastateparks.org/grayton' },
        { name: '<b>The Big Chill</b>', kind: 'Food', why: 'Food hall with live music.', url: 'javascript:alert(1)' },
        { kind: 'Nameless', why: 'dropped' },
      ] } }] };
  } }, batches: {} };
};
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9222',
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9222';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const me = (await fetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'boss@example.com', password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const post = (p, b) => fetch(B + p, { method: 'POST', headers: { ...J, cookie: me }, body: JSON.stringify(b || {}) });
  const bare = await (await post('/api/trips', { name: 'Somewhere' })).json();
  let r = await post(`/api/trips/${bare.id}/ideas`);
  ok('no destination: asks for one, with a status, and spends nothing', r.status === 400 && sawTools === null, String(r.status));

  const trip = await (await post('/api/trips', { name: 'Beach', destination: 'Santa Rosa Beach, FL', dateRange: 'Sep 23-26, 2026' })).json();
  r = await post(`/api/trips/${trip.id}/ideas`);
  const out = await r.json();
  ok('ideas come back', r.status === 200 && out.ideas && out.ideas.length === 2, JSON.stringify(out).slice(0, 120));
  ok('...searched for, on the web', sawTools.some((t) => /web_search/.test(t.type || t.name || '')));
  ok('...for this place and these dates', /Santa Rosa Beach/.test(sawSystem) && /2026-09-23/.test(sawSystem));
  ok('...cleaned: markup stripped from the name, the nameless one dropped',
     !/[<>]/.test(JSON.stringify(out.ideas)) && out.ideas[1].name.includes('The Big Chill') && out.ideas.every((i) => i.name));
  ok('...and only https links survive', out.ideas[0].url.startsWith('https://') && out.ideas[1].url === '');
  const saved = await (await fetch(B + `/api/trips/${trip.id}`, { headers: { cookie: me } })).json();
  ok('saved on the trip, so the Overview does not pay for it again', Array.isArray(saved.ideas) && saved.ideas.length === 2 && !!saved.ideasAt);
  r = await fetch(B + `/api/trips/${trip.id}/ideas`, { method: 'POST' });
  ok('signed out: refused before any model call', r.status === 401, String(r.status));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
