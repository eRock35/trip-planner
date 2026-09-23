// What became of a proposal has to outlive the page that decided it.
//
// Reported 2026-09-23 as "after applying to itinerary it stays": Apply saved
// the itinerary, but "applied" lived only in the page's memory, so the next
// load of the chat from the server drew the Apply card again as if nothing
// had happened. Tapping it again would have replaced the whole itinerary with
// a plan from before any later change - the same trap the vacation app had.
const h = require('./harness.js');
h.install();

// Each chat turn proposes a plan with one marker block, so the tests can tell
// which proposal a saved itinerary came from.
let marker = 'A';
const plan = (m) => [
  { title: 'Arrive', date: '2026-10-01', dateLabel: 'Thu, Oct 1', blocks: [['Afternoon', 'Land'], ['Evening', 'PLAN-' + m]] },
];
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async () => ({
    stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      { type: 'text', text: 'Here is a plan.' },
      { type: 'tool_use', id: 't', name: 'propose_schedule_change', input: { summary: 'Plan ' + marker, days: plan(marker) } },
    ],
  }) }, batches: {} };
};

Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9218',
});
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9218';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const get = (p, c) => fetch(B + p, { headers: { cookie: c } });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
async function ask(tid, m, c) {
  marker = m;
  const r = await post(`/api/trips/${tid}/chat`, { question: 'plan it ' + m }, c);
  return r.json();
}
async function messages(tid, c) { return (await get(`/api/trips/${tid}/messages`, c)).json(); }
async function daysText(tid, c) { return JSON.stringify((await (await get(`/api/trips/${tid}`, c)).json()).days || []); }

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const me = jar(await post('/api/auth/register', { email: 'boss@example.com', password: 'a-long-password-1' }));
  const trip = await (await post('/api/trips', { name: 'Lisbon', destination: 'Lisbon' }, me)).json();

  /* ---------- a proposal knows its message and its base ---------- */
  const a = await ask(trip.id, 'A', me);
  ok('the chat answer carries the stored message id', typeof a.id === 'string' && a.id.length > 0, JSON.stringify(Object.keys(a)));
  ok('...and the itinerary version it was written against (none yet)', a.proposedChange && a.proposedChange.basedOn === null);

  // A second suggestion, made BEFORE the first is applied: both are based on
  // the same (empty) itinerary.
  const b = await ask(trip.id, 'B', me);

  /* ---------- apply A: saved, and remembered ---------- */
  let r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: a.proposedChange.days, basedOn: a.proposedChange.basedOn, messageId: a.id }, me);
  ok('applying A saves the itinerary', r.status === 200 && (await daysText(trip.id, me)).includes('PLAN-A'), String(r.status));
  let msgs = await messages(trip.id, me);
  ok('THE FIX: after a reload the chat says A was applied',
     msgs.find((m) => m.id === a.id).changeState === 'applied', JSON.stringify(msgs.map((m) => m.changeState)));
  ok('...and B is still undecided', !msgs.find((m) => m.id === b.id).changeState);

  /* ---------- apply B, which was written before A: refused ---------- */
  r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: b.proposedChange.days, basedOn: b.proposedChange.basedOn, messageId: b.id }, me);
  const refused = await r.json();
  ok('B, written before A was applied, is refused with 409', r.status === 409, String(r.status));
  ok('...with the current itinerary attached for the page to redraw', JSON.stringify(refused.days || []).includes('PLAN-A'));
  ok('...and A survives', (await daysText(trip.id, me)).includes('PLAN-A') && !(await daysText(trip.id, me)).includes('PLAN-B'));
  msgs = await messages(trip.id, me);
  ok('...and B is recorded as stale, so its card cannot be pressed again', msgs.find((m) => m.id === b.id).changeState === 'stale');

  /* ---------- asking again works ---------- */
  const c = await ask(trip.id, 'C', me);
  ok('a fresh suggestion is based on the itinerary A saved', typeof c.proposedChange.basedOn === 'string');
  r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: c.proposedChange.days, basedOn: c.proposedChange.basedOn, messageId: c.id }, me);
  ok('...and applies', r.status === 200 && (await daysText(trip.id, me)).includes('PLAN-C'), String(r.status));

  /* ---------- discard is remembered too ---------- */
  const d = await ask(trip.id, 'D', me);
  r = await post(`/api/trips/${trip.id}/messages/${d.id}/discard`, {}, me);
  msgs = await messages(trip.id, me);
  ok('discarding is remembered across a reload', r.status === 200 && msgs.find((m) => m.id === d.id).changeState === 'discarded');
  ok('...and changed nothing', (await daysText(trip.id, me)).includes('PLAN-C'));

  /* ---------- a lock or a rename is not an itinerary change ---------- */
  const e = await ask(trip.id, 'E', me);
  await fetch(B + `/api/trips/${trip.id}`, { method: 'PATCH', headers: { ...J, cookie: me }, body: JSON.stringify({ notes: 'booked' }) });
  await post(`/api/trips/${trip.id}/lock`, {}, me);
  r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: e.proposedChange.days, basedOn: e.proposedChange.basedOn, messageId: e.id }, me);
  ok('editing notes or locking the trip does not make a suggestion stale', r.status === 200, String(r.status));

  /* ---------- old cards, and other people ---------- */
  r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: plan('OLD') }, me);
  ok('a card from before this existed (no basedOn, no id) still applies', r.status === 200, String(r.status));

  const other = jar(await post('/api/auth/register', { email: 'someone@example.com', password: 'a-long-password-2' }));
  r = await post(`/api/trips/${trip.id}/messages/${e.id}/discard`, {}, other);
  ok('someone else cannot mark my proposals', r.status === 404, String(r.status));
  msgs = await messages(trip.id, me);
  ok('...and it is still applied', msgs.find((m) => m.id === e.id).changeState === 'applied');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
