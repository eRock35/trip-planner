// The advisor tool on trip chat (advisor.js, completeAdvised in server.js).
//
// Off by default, and off means the request is the one it always was. On, a
// planning ask also offers the advisor - the documented tool, model and
// limits, under the documented beta header - and nothing else does. What a
// consultation costs lands on the same person's budget as the answer, the
// budget still refuses BEFORE any call, and a 400 from the beta never costs
// the person their answer. No network: the SDK is the harness's fake.
const h = require('./harness.js');
h.install();

// Every outgoing call: which key, the body, and what else create() was handed.
const sent = [];
// Each test queues what the next calls answer; with nothing queued, a plain
// answer. A function is called with the request; an Error is thrown.
const queue = [];
const PLAIN = () => ({ stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
  content: [{ type: 'text', text: 'An answer.' }] });
require.cache['FAKE_AN'].exports = function (opts) {
  const apiKey = (opts && opts.apiKey) || process.env.ANTHROPIC_API_KEY;
  return { messages: { create: async (...args) => {
    sent.push({ apiKey, params: JSON.parse(JSON.stringify(args[0])), args: args.length, options: args[1] });
    const next = queue.length ? queue.shift() : PLAIN;
    const out = typeof next === 'function' ? next(args[0]) : next;
    if (out instanceof Error) throw out;
    return out;
  } }, batches: {} };
};

// A stand-in for Anthropic's /v1/models, so saving a key has something to ask.
const http = require('http');
const VALID = 'sk-ant-api03-' + 'v'.repeat(60) + 'GOOD';
http.createServer((req, res) => {
  res.writeHead((req.headers['x-api-key'] || '') === VALID ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end('{}');
}).listen(9311, '127.0.0.1');

Object.assign(process.env, {
  BYOK_VALIDATE_URL: 'http://127.0.0.1:9311/v1/models',
  BYOK_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('base64'),
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn',
  SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner',
  IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com',
  ANTHROPIC_API_KEY: 'sk-ant-the-service-key',
  PORT: '9253',
});
delete process.env.TRIP_ADVISOR;
const path = require('path');
require(path.join(__dirname, '..', 'server.js'));
const advisor = require(path.join(__dirname, '..', 'advisor.js'));
const identityLib = require(path.join(__dirname, '..', 'identity.js'));

// What the server logs with console.warn, so the fallback's line can be read.
const warned = [];
const realWarn = console.warn;
console.warn = (...a) => { warned.push(a.join(' ')); };

const B = 'http://127.0.0.1:9253';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');
const near = (a, b) => Math.abs(a - b) < 1e-9;
const settle = () => new Promise((r) => setTimeout(r, 150));   // metering is fire-and-forget

const PLANNING = 'Draft a day-by-day itinerary for our four days';
const SIMPLE = 'where should we eat';
const types = (p) => (p.tools || []).map((t) => t.type || t.name);
const hasAdvisor = (p) => (p.tools || []).some((t) => t.name === 'advisor' || t.type === advisor.TOOL_TYPE);

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const ids = h.bag('identity');
  const usageRows = () => [...ids.entries()].filter(([k]) => k.startsWith('usage/')).map(([, v]) => v);
  const spent = (email) => Number((ids.get('users/' + uidOf(email)) || {}).spentUsd || 0);

  const owner = jar(await post('/api/auth/register', { email: 'boss@example.com', password: 'a-long-password-1' }));
  ids.set('users/' + uidOf('boss@example.com'), { ...ids.get('users/' + uidOf('boss@example.com')), admin: true });
  const free = jar(await post('/api/auth/register', { email: 'free@example.com', password: 'a-long-password-2' }));
  const ownerTrip = await (await post('/api/trips', { name: 'T', destination: 'X' }, owner)).json();
  const freeTrip = await (await post('/api/trips', { name: 'T', destination: 'X' }, free)).json();

  /** One chat turn; returns the response body and the calls it made. */
  const ask = async (cookie, trip, question) => {
    sent.length = 0;
    const r = await post(`/api/trips/${trip.id}/chat`, { question }, cookie);
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body, calls: sent.slice() };
  };

  /* ---------- the documented strings, pinned ---------- */
  ok('the tool type is the documented one', advisor.TOOL_TYPE === 'advisor_20260301', advisor.TOOL_TYPE);
  ok('the beta is the documented one', advisor.BETA === 'advisor-tool-2026-03-01', advisor.BETA);
  ok('the advisor is Opus 5.5', advisor.MODEL === 'claude-opus-5-5', advisor.MODEL);
  ok('...a model the price table knows', identityLib.priceOf(advisor.MODEL, { input_tokens: 1 }) !== null);
  ok('at most 2 consultations a turn, 2048 tokens each', advisor.MAX_USES === 2 && advisor.MAX_TOKENS === 2048);

  /* ---------- off: the request is what it was ---------- */
  let t = await ask(owner, ownerTrip, PLANNING);
  const offOwner = t.calls[0];
  ok('switch unset: one call', t.calls.length === 1, String(t.calls.length));
  ok('...no advisor tool, even on a planning ask', !hasAdvisor(offOwner.params), JSON.stringify(types(offOwner.params)));
  ok('...the three tools it always had', JSON.stringify(types(offOwner.params)) ===
    JSON.stringify(['web_search_20260209', 'propose_schedule_change', 'propose_bookings']), JSON.stringify(types(offOwner.params)));
  ok('...create() is handed the body and nothing else (no beta header)', offOwner.args === 1, String(offOwner.args));
  ok('...the prompt does not mention an advisor', !/advisor/i.test(offOwner.params.system));
  ok('...only the fields it always sent', JSON.stringify(Object.keys(offOwner.params)) ===
    JSON.stringify(['model', 'max_tokens', 'system', 'tools', 'messages']), JSON.stringify(Object.keys(offOwner.params)));
  for (const v of ['0', '', 'true', 'on', 'off']) {
    process.env.TRIP_ADVISOR = v;
    t = await ask(owner, ownerTrip, PLANNING);
    ok(`TRIP_ADVISOR=${JSON.stringify(v)} is off, byte for byte`,
      t.calls.length === 1 && t.calls[0].args === 1 && JSON.stringify(t.calls[0].params) === JSON.stringify(offOwner.params));
  }

  /* ---------- on: a planning ask carries the advisor ---------- */
  process.env.TRIP_ADVISOR = '1';
  t = await ask(owner, ownerTrip, PLANNING);
  let c = t.calls[0];
  const tool = (c.params.tools || []).find((x) => x.name === 'advisor');
  ok('switch on, planning ask: one call', t.calls.length === 1, String(t.calls.length));
  ok('...with exactly the documented tool', JSON.stringify(tool) === JSON.stringify(
    { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5', max_uses: 2, max_tokens: 2048 }), JSON.stringify(tool));
  ok('...after the tools it already had', JSON.stringify(types(c.params)) === JSON.stringify(
    ['web_search_20260209', 'propose_schedule_change', 'propose_bookings', 'advisor_20260301']), JSON.stringify(types(c.params)));
  ok('...under the beta header', c.options && c.options.headers &&
    c.options.headers['anthropic-beta'] === 'advisor-tool-2026-03-01', JSON.stringify(c.options));
  ok('...the executor is still the model it was', c.params.model === 'claude-sonnet-5' && c.params.max_tokens === 8192, c.params.model);
  ok('...and is told when to consult it', c.params.system.endsWith(advisor.PROMPT) &&
    /before you commit to a multi-day plan/.test(c.params.system) && /Do not call it for a simple question/.test(c.params.system));
  // Take the advisor back out and it is the request the switch-off sent.
  const stripped = Object.assign({}, c.params, {
    system: c.params.system.slice(0, -advisor.PROMPT.length),
    tools: c.params.tools.filter((x) => x.name !== 'advisor'),
  });
  ok('...and nothing else about the request moved', JSON.stringify(stripped) === JSON.stringify(offOwner.params));

  t = await ask(free, freeTrip, PLANNING);
  c = t.calls[0];
  ok('a free account keeps Haiku as the executor', c.params.model === 'claude-haiku-4-5', c.params.model);
  ok('...and gets the same advisor', hasAdvisor(c.params) && c.params.tools.find((x) => x.name === 'advisor').model === 'claude-opus-5-5');

  /* ---------- on: a plain question does not ---------- */
  t = await ask(owner, ownerTrip, SIMPLE);
  c = t.calls[0];
  ok('switch on, plain question: no advisor tool', !hasAdvisor(c.params), JSON.stringify(types(c.params)));
  ok('...no beta header', c.args === 1, String(c.args));
  ok('...no advisor in the prompt', !/advisor/i.test(c.params.system));
  for (const q of ['hi', 'What is the weather in Lisbon in May?', 'how much is the train to Sintra',
    'add my Delta flight DL123 to the bookings', 'is the museum open monday']) {
    ok('not a planning ask: ' + q, advisor.isPlanningAsk(q) === false);
  }
  for (const q of ['Rebalance the schedule, day 2 is too packed', 'Should we stay in Alfama or Chiado?',
    'Plan our 4 days', 'Compare the two hotels', 'swap day 2 and 3 in the itinerary']) {
    ok('a planning ask: ' + q, advisor.isPlanningAsk(q) === true);
  }

  /* ---------- "paid": the paid tier only ---------- */
  process.env.TRIP_ADVISOR = 'paid';
  t = await ask(free, freeTrip, PLANNING);
  ok('TRIP_ADVISOR=paid: a free account does not get it', !hasAdvisor(t.calls[0].params) && t.calls[0].args === 1);
  t = await ask(owner, ownerTrip, PLANNING);
  ok('...the paid tier does', hasAdvisor(t.calls[0].params) && t.calls[0].args === 2);
  process.env.TRIP_ADVISOR = '1';

  /* ---------- what a consultation costs is charged ----------
     The docs' shape: top-level usage is the executor's only, and each
     advisor_message in usage.iterations carries its own model and tokens. */
  const usage = {
    input_tokens: 9000, output_tokens: 2500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: 3 },
    iterations: [
      { type: 'message', input_tokens: 4000, output_tokens: 300 },
      { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 9500, output_tokens: 1400,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { type: 'message', input_tokens: 5000, output_tokens: 2200 },
    ],
  };
  const ADVISED = () => ({ stop_reason: 'end_turn', usage, content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} },
    { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1',
      content: { type: 'advisor_redacted_result', encrypted_content: 'opaque', stop_reason: 'end_turn' } },
    { type: 'text', text: 'Here is the plan.' },
  ] });
  // From identity.js PRICES, by hand: Haiku 4.5 $1/$5, Opus 5.5 $4/$20 per
  // million tokens, a search $0.01.
  const executorUsd = (9000 * 1 + 2500 * 5) / 1e6;      // 0.0215
  const advisorUsd = (9500 * 4 + 1400 * 20) / 1e6;      // 0.066
  const searchUsd = 3 * 0.01;                           // 0.03
  const totalUsd = executorUsd + advisorUsd + searchUsd; // 0.1175
  ok('the price table agrees with the sum by hand', near(identityLib.priceOf('claude-haiku-4-5', usage), totalUsd),
    String(identityLib.priceOf('claude-haiku-4-5', usage)));
  await settle();
  let before = spent('free@example.com');
  let rowsBefore = usageRows().length;
  queue.push(ADVISED);
  t = await ask(free, freeTrip, PLANNING);
  await settle();
  ok('an advised answer comes back as the answer', t.body.answer === 'Here is the plan.', JSON.stringify(t.body).slice(0, 120));
  ok('...never showing the advisor blocks', !/advisor|opaque/i.test(JSON.stringify(t.body)));
  const row = usageRows().slice(rowsBefore).find((u) => u.advisorCalls);
  ok('the usage row is priced with the consultation in it', row && near(row.costUsd, totalUsd), JSON.stringify(row));
  ok('...and says how much of it was the advisor', row && near(row.advisorUsd, advisorUsd) && row.advisorCalls === 1 &&
    JSON.stringify(row.advisorModels) === '["claude-opus-5-5"]' && row.advisorInputTokens === 9500 && row.advisorOutputTokens === 1400,
    JSON.stringify(row));
  ok('...recorded against the executor model', row && row.model === 'claude-haiku-4-5', row && row.model);
  ok("the person's budget is charged all of it", near(spent('free@example.com') - before, totalUsd),
    String(spent('free@example.com') - before));
  ok('...which is $0.1175', near(totalUsd, 0.1175), String(totalUsd));

  /* ---------- the budget still refuses BEFORE any call ---------- */
  const fk = 'users/' + uidOf('free@example.com');
  const keep = ids.get(fk).spentUsd;
  ids.set(fk, { ...ids.get(fk), spentUsd: 999 });
  t = await ask(free, freeTrip, PLANNING);
  ok('out of credit: refused with a 402', t.status === 402, String(t.status));
  ok('...before any model call, advisor or not', t.calls.length === 0, String(t.calls.length));
  ids.set(fk, { ...ids.get(fk), spentUsd: keep });

  /* ---------- a 400 for the advisor never fails the message ---------- */
  const apiError = (status, name) => Object.assign(new Error(status + ' ' + name), { status, name });
  warned.length = 0;
  queue.push(apiError(400, 'BadRequestError'));
  queue.push(() => ({ stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
    content: [{ type: 'text', text: 'Answered anyway.' }] }));
  t = await ask(owner, ownerTrip, PLANNING);
  ok('a 400 with the advisor: asked again, once', t.calls.length === 2, String(t.calls.length));
  ok('...the first try carried the advisor', hasAdvisor(t.calls[0].params) && t.calls[0].args === 2);
  ok('...the second is the plain request, no tool, no header',
    t.calls[1].args === 1 && JSON.stringify(t.calls[1].params) === JSON.stringify(offOwner.params));
  ok('...and the person gets their answer', t.status === 200 && t.body.answer === 'Answered anyway.' && !t.body.error,
    JSON.stringify(t.body).slice(0, 120));
  ok('...with the log line', warned.includes('[advisor] unavailable (400); answered without it'), JSON.stringify(warned));

  // A failure that is not the advisor's is not asked twice.
  for (const [status, name] of [[401, 'AuthenticationError'], [429, 'RateLimitError']]) {
    warned.length = 0;
    queue.push(apiError(status, name));
    t = await ask(owner, ownerTrip, PLANNING);
    ok(`a ${status} is not retried without the advisor`, t.calls.length === 1 && Boolean(t.body.error) && warned.length === 0,
      t.calls.length + ' ' + JSON.stringify(t.body));
  }
  // And a second failure is still a failure, said once - not a loop.
  queue.push(apiError(400, 'BadRequestError'));
  queue.push(apiError(400, 'BadRequestError'));
  t = await ask(owner, ownerTrip, PLANNING);
  ok('if the plain retry fails too, it stops there', t.calls.length === 2 && Boolean(t.body.error), String(t.calls.length));

  /* ---------- a consultation that fails inside a 200 ---------- */
  warned.length = 0;
  queue.push(() => ({ stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 }, content: [
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'advisor', input: {} },
    { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'advisor_tool_result_error', error_code: 'overloaded' } },
    { type: 'text', text: 'Planned without it.' },
  ] }));
  t = await ask(owner, ownerTrip, PLANNING);
  ok('an advisor error block is not retried', t.calls.length === 1 && t.body.answer === 'Planned without it.', JSON.stringify(t.body).slice(0, 100));
  ok('...and is logged', warned.includes('[advisor] unavailable (overloaded); answered without it'), JSON.stringify(warned));
  ok('reaching max_uses is the cap working, not an error', advisor.consultErrors({ content: [
    { type: 'advisor_tool_result', content: { type: 'advisor_tool_result_error', error_code: 'max_uses_exceeded' } }] }).length === 0);

  /* ---------- a paused turn carries on with the advisor still there ---------- */
  queue.push(() => ({ stop_reason: 'pause_turn', usage: { input_tokens: 5, output_tokens: 5 },
    content: [{ type: 'server_tool_use', id: 'srvtoolu_3', name: 'web_search', input: { query: 'x' } }] }));
  t = await ask(owner, ownerTrip, PLANNING);
  ok('a paused turn continues', t.calls.length === 2, String(t.calls.length));
  ok('...with the tool and the header on the continuation too',
    hasAdvisor(t.calls[1].params) && t.calls[1].args === 2 && t.calls[1].params.messages.length === 2);

  /* ---------- their own key pays for their own advisor ---------- */
  const member = jar(await post('/api/auth/register', { email: 'byok@example.com', password: 'a-long-password-3' }));
  const mk = 'users/' + uidOf('byok@example.com');
  ids.set(mk, { ...ids.get(mk), plan: 'member' });
  const saved = await post('/api/auth/byok', { key: VALID }, member);
  ok('a member saves a key', saved.status === 200, String(saved.status));
  const memberTrip = await (await post('/api/trips', { name: 'T', destination: 'X' }, member)).json();
  await settle();
  before = spent('byok@example.com');
  rowsBefore = usageRows().length;
  queue.push(() => Object.assign(ADVISED(), {}));
  t = await ask(member, memberTrip, PLANNING);
  await settle();
  ok('own key: the advised call goes out on THEIR key', t.calls.length === 1 && t.calls[0].apiKey === VALID, t.calls[0] && t.calls[0].apiKey);
  ok('...with the same tool and header', hasAdvisor(t.calls[0].params) && t.calls[0].args === 2);
  ok('...and is not charged to them', spent('byok@example.com') === before, `${before} -> ${spent('byok@example.com')}`);
  const own = usageRows().slice(rowsBefore).find((u) => u.advisorCalls);
  ok('...but is recorded, advisor and all', own && own.byok === true && near(own.advisorUsd, advisorUsd), JSON.stringify(own));

  console.warn = realWarn;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
