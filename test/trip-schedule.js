// Does trip-planner's chat actually change the itinerary? The flow existed
// before today; this proves it end to end, with the model stubbed so the
// assertions are about the app and not about what Claude felt like writing.
const h = require('./harness.js');
h.install();

const PROPOSED = [
  { title: 'Arrive & settle', date: '2026-10-01', dateLabel: 'Thu, Oct 1',
    blocks: [['Afternoon', 'Land and pick up the car'], ['Evening', 'Dinner near the hotel']],
    tip: 'Keep the first evening easy.' },
  { title: 'Museums, then the river', date: '2026-10-02', dateLabel: 'Fri, Oct 2',
    blocks: [['Morning', 'Museum'], ['8:00 PM', 'A surprise: sunset river cruise']],
    tip: 'Book the cruise ahead.' },
];

// Replace the harness's generic answer with one that calls the tool.
require.cache['FAKE_AN'].exports = function () {
  return {
    messages: {
      create: async () => ({
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'text', text: 'Added a sunset river cruise on the Friday evening.' },
          { type: 'tool_use', id: 'toolu_1', name: 'propose_schedule_change',
            input: { summary: 'Adds a sunset river cruise on Friday evening.', days: PROPOSED } },
        ],
      }),
    },
    batches: {},
  };
};

process.env.IDENTITY_SESSION_SECRET = 'identity-secret-abcdefghijklmn';
process.env.SESSION_SECRET = 'trip-secret-abcdefghijklmnop';
process.env.FIRESTORE_DATABASE_ID = 'trip-planner';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = '9207';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9207';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  let r = await post('/api/auth/register', { email: 'boss@example.com', password: 'a-long-password-1' });
  const admin = jar(r);
  ok('admin registered', r.status === 200, String(r.status));

  r = await post('/api/trips', { name: 'Lisbon', destination: 'Lisbon', dateRange: 'Oct 1-5, 2026' }, admin);
  const trip = await r.json();
  ok('trip created', r.status === 200 && !!trip.id, JSON.stringify(trip).slice(0, 120));

  r = await post(`/api/trips/${trip.id}/chat`, { question: 'Add a surprise to Friday evening' }, admin);
  const chat = await r.json();
  ok('chat answers with 200', r.status === 200, String(r.status));
  ok('chat proposes a change', !!(chat.proposedChange && chat.proposedChange.days), JSON.stringify(chat).slice(0, 160));
  ok('the proposal keeps both days', chat.proposedChange && chat.proposedChange.days.length === 2);
  ok('the proposal is normalised (blocks are pairs)',
     chat.proposedChange && Array.isArray(chat.proposedChange.days[1].blocks[1]) && chat.proposedChange.days[1].blocks[1][0] === '8:00 PM');

  r = await fetch(B + `/api/trips/${trip.id}`, { headers: { cookie: admin } });
  let saved = await r.json();
  ok('nothing is saved before Apply', !saved.days || !saved.days.length, JSON.stringify(saved.days || []).slice(0, 80));

  r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: chat.proposedChange.days }, admin);
  const applied = await r.json();
  ok('apply succeeds', r.status === 200 && applied.ok === true, JSON.stringify(applied).slice(0, 120));
  ok('apply returns the saved days for the page to draw', Array.isArray(applied.days) && applied.days.length === 2);

  r = await fetch(B + `/api/trips/${trip.id}`, { headers: { cookie: admin } });
  saved = await r.json();
  ok('the itinerary is now on the trip', saved.days && saved.days.length === 2, JSON.stringify(saved.days || []).slice(0, 80));
  ok('the surprise survived the round trip',
     JSON.stringify(saved.days).indexOf('sunset river cruise') !== -1);

  r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: 'nope' }, admin);
  ok('garbage is a 400, not a 500', r.status === 400, String(r.status));

  r = await post(`/api/trips/${trip.id}/schedule/apply`, { days: chat.proposedChange.days }, '');
  ok('apply needs a session', r.status === 401, String(r.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
