// Trip chat remembers the conversation and answers in one piece (2026-11-24).
// Erik's screenshot: "No let's add it" was answered "I'm not sure what you'd
// like to add" - every turn was sent alone - and a searched answer read as
// shards (", and" on a line of its own).
const h = require('./harness.js');
h.install();

const sent = [];
const queue = [];
const PLAIN = () => ({ stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
  content: [{ type: 'text', text: 'An answer.' }] });
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async (...args) => {
    sent.push(JSON.parse(JSON.stringify(args[0])));
    const next = queue.length ? queue.shift() : PLAIN;
    return typeof next === 'function' ? next(args[0]) : next;
  } }, batches: {} };
};

Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn',
  SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner',
  IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com',
  ANTHROPIC_API_KEY: 'sk-ant-the-service-key',
  PORT: '9257',
});
delete process.env.TRIP_ADVISOR;
const path = require('path');
const ch = require(path.join(__dirname, '..', 'chat-history.js'));
require(path.join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9257';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

(async () => {
  /* ---------- the pure parts ---------- */
  const first = ch.toMessages([], 'Plan the days');
  ok('a first question is sent alone', first.length === 1 && first[0].role === 'user' && first[0].content === 'Plan the days');

  const stored = [
    { question: 'Plan the days', answer: 'Book the Pena Palace 9:30 slot.', proposedBookings: { summary: 'Pena Palace tickets' } },
    { question: 'thanks', answer: '' },                       // unanswered: left out
  ];
  const m = ch.toMessages(stored, "No let's add it");
  ok('earlier turns ride along as user/assistant pairs, then the new question',
     m.map((x) => x.role).join() === 'user,assistant,user' && m[2].content === "No let's add it", JSON.stringify(m.map((x) => x.role)));
  ok('...the assistant turn says what it proposed and that it is not applied yet',
     /Pena Palace tickets/.test(m[1].content) && /not applied yet/.test(m[1].content), m[1].content);
  const many = Array.from({ length: 20 }, (_, i) => ({ question: 'q' + i, answer: 'a' + i }));
  const capped = ch.toMessages(many, 'now');
  ok(`only the last ${ch.MAX_TURNS} turns are sent`, capped.length === ch.MAX_TURNS * 2 + 1 && capped[0].content === 'q12', capped[0].content);
  ok('an old answer is clipped, not sent whole', ch.toMessages([{ question: 'q', answer: 'x'.repeat(9000) }], 'n')[1].content.length < 2600);
  ok('a decided proposal says so', /applied by the user/.test(ch.proposalNote({ proposedChange: { summary: 's' }, changeState: 'applied' })));

  // A searched answer, as the API returns it: a preamble, the search, then
  // text split around each citation.
  const content = [
    { type: 'text', text: "I'll check current flight availability and weather for you." },
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
    { type: 'text', text: 'Round-trip flights from Atlanta start from ' },
    { type: 'text', text: '$858', citations: [{ type: 'web_search_result_location', url: 'https://a.example' }] },
    { type: 'text', text: ', so your timing is good value.' },
    { type: 'text', text: 'Pack layers and a light rain jacket.' },
  ];
  const joined = ch.joinText(content);
  ok('the answer reads as one sentence around a citation, not shards',
     joined.includes('Round-trip flights from Atlanta start from $858, so your timing is good value.'), JSON.stringify(joined));
  ok('...the "I\'ll check ..." preamble before the search is dropped', !/I'll check/.test(joined), joined);
  ok('...and separate blocks with no citation are still paragraphs', /value\.\n\nPack layers/.test(joined), JSON.stringify(joined));
  ok('a plain answer is left as it is', ch.joinText([{ type: 'text', text: 'Hello.' }]) === 'Hello.');
  ok('a preamble is kept when nothing follows the search',
     ch.joinText([{ type: 'text', text: 'Short.' }, { type: 'server_tool_use', id: 'x' }]) === 'Short.');

  /* ---------- through the route ---------- */
  await new Promise((r) => setTimeout(r, 900));
  const owner = jar(await post('/api/auth/register', { email: 'boss@example.com', password: 'a-long-password-1' }));
  const trip = await (await post('/api/trips', { name: 'Lisbon', destination: 'Lisbon' }, owner)).json();

  queue.push(() => ({ stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 }, content: content }));
  let r = await (await post(`/api/trips/${trip.id}/chat`, { question: 'Plan the days for this trip.' }, owner)).json();
  ok('the first turn is answered in one piece', /start from \$858, so your/.test(r.answer || '') && !/I'll check/.test(r.answer), r.answer);
  ok('...and the request carried just the question', sent[sent.length - 1].messages.length === 1);

  r = await (await post(`/api/trips/${trip.id}/chat`, { question: "No let's add it" }, owner)).json();
  const req2 = sent[sent.length - 1];
  ok('a follow-up is sent with the turn before it',
     req2.messages.length === 3 && req2.messages[0].content === 'Plan the days for this trip.' && /\$858/.test(req2.messages[1].content)
       && req2.messages[2].content === "No let's add it", JSON.stringify(req2.messages.map((x) => x.role)));
  ok('the system prompt tells it to act on "add it" and not narrate',
     /act on what you last offered/.test(req2.system) && /do not narrate/.test(req2.system));

  const other = jar(await post('/api/auth/register', { email: 'someone@example.com', password: 'a-long-password-2' }));
  const t2 = await (await post('/api/trips', { name: 'Other', destination: 'Rome' }, other)).json();
  await post(`/api/trips/${t2.id}/chat`, { question: 'hi' }, other);
  ok("another trip's chat never sees this one's history", sent[sent.length - 1].messages.length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
