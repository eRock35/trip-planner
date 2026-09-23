// Packing and Budget, through the real routes.
const h = require('./harness.js');
h.install();
let script = null; let saw = null;
require.cache['FAKE_AN'].exports = function () { return { messages: { create: async (req) => { saw = req; return script(req); } }, batches: {} }; };
const tool = (name, input) => async () => ({ stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't', name, input }] });
global.fetch = ((real) => async (url, opts) => (/nominatim|met\.no/.test(String(url)) ? new Response('[]', { status: 200 }) : real(url, opts)))(global.fetch);
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9223',
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9223';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const me = (await fetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'boss@example.com', password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const call = async (method, p, b, c = me) => { const r = await fetch(B + p, { method, headers: { ...J, cookie: c }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const trip = (await call('POST', '/api/trips', { name: 'Beach', destination: 'Santa Rosa Beach, FL', dateRange: 'Sep 22-27, 2026', notes: 'Erik, wife, son (6), daughter (3)' })).body;
  const T = '/api/trips/' + trip.id;

  /* ---------- packing ---------- */
  let r = await call('POST', T + '/packing', { text: 'Sunscreen', group: 'Beach' });
  ok('add an item', r.status === 200 && r.body.items.length === 1 && r.body.items[0].checked === false);
  r = await call('POST', T + '/packing', { items: [{ text: 'Swimsuits', group: 'Son (6)' }, { text: '' }, { text: 'Car seat', group: 'Daughter (3)' }] });
  ok('add several at once, empty ones skipped', r.body.items.length === 3, String(r.body.items.length));
  const [a, b] = r.body.items;
  // Two phones tick different items "at the same time".
  const [x, y] = await Promise.all([call('PATCH', `${T}/packing/${a.id}`, { checked: true }), call('PATCH', `${T}/packing/${b.id}`, { checked: true })]);
  r = await call('GET', T + '/packing');
  ok('two ticks at once both stick - each item is its own document', x.status === 200 && y.status === 200 && r.body.items.filter((i) => i.checked).length === 2);
  r = await call('PATCH', `${T}/packing/${a.id}`, { text: 'Sunscreen SPF 50' });
  ok('rename keeps the tick', r.body.item.text === 'Sunscreen SPF 50' && r.body.item.checked === true);
  r = await call('POST', T + '/packing/reset');
  ok('reset unticks everything and removes nothing', r.body.items.length === 3 && r.body.items.every((i) => !i.checked));
  r = await call('DELETE', `${T}/packing/${b.id}`);
  ok('delete one', r.status === 200 && (await call('GET', T + '/packing')).body.items.length === 2);
  ok('an unknown or malformed id is a 404', (await call('PATCH', `${T}/packing/nope`, { checked: true })).status === 404
     && (await call('DELETE', `${T}/packing/..%2F..%2Fx`)).status === 404);

  script = tool('packing_list', { items: [{ text: 'sunscreen spf 50', group: 'Beach' }, { text: 'Rain jacket - showers Thursday', group: 'Clothes' }, { text: 'Puddle jumper', group: 'Daughter (3)' }] });
  r = await call('POST', T + '/packing/suggest');
  ok('suggestions come back', r.status === 200 && Array.isArray(r.body.items), JSON.stringify(r.body).slice(0, 100));
  ok('...minus what is already on the list', !r.body.items.some((i) => /sunscreen/i.test(i.text)) && r.body.items.length === 2);
  ok('...made with the trip in view: who is going, and what is on the list', /son \(6\)/i.test(saw.system) && /Sunscreen SPF 50/.test(saw.system));
  ok('...and NOT saved - a suggestion is added by a tap', (await call('GET', T + '/packing')).body.items.length === 2);

  /* ---------- budget ---------- */
  r = await call('PUT', T + '/budget/target', { target: '$2,000' });
  ok('a target, typed the way people type', r.body.target === 2000);
  r = await call('POST', T + '/budget/lines', { lines: [{ category: 'food', label: 'Groceries', planned: '250' }, { category: 'Activities', label: 'Dolphin cruise', planned: 160 }] });
  ok('add lines', r.status === 200 && r.body.lines.length === 2 && r.body.lines[0].category === 'Food');
  const line = r.body.lines[0];
  r = await call('PATCH', `${T}/budget/lines/${line.id}`, { spent: '84.12' });
  ok('record what was spent', r.body.line.spent === 84.12 && r.body.line.planned === 250);
  r = await call('PATCH', `${T}/budget/lines/${line.id}`, { spent: '' });
  ok('clearing a figure leaves no figure, not $0', r.body.line.spent === null);

  // A booking with a price counts as committed money.
  h.bag('trip-planner').get('trips/' + trip.id).bookings = [{ id: 'car111111111', kind: 'car', title: 'Midsize - National', total: 319.86 }, { id: 'stay11111111', kind: 'stay', title: 'Cottage' }];
  r = await call('GET', T + '/budget');
  ok('bookings with a price appear as booked, those without do not', r.body.booked.length === 1 && r.body.booked[0].total === 319.86);

  script = tool('budget_estimate', { lines: [{ category: 'Food', label: 'Two dinners out', planned: 180, note: 'Seaside averages' }, { category: 'Transport', label: 'Gas', planned: 'about $90' }, { category: 'Other', label: 'nothing' }] });
  r = await call('POST', T + '/budget/suggest');
  ok('an estimate comes back, with figures read as money', r.status === 200 && r.body.lines.length === 2 && r.body.lines[1].planned === 90, JSON.stringify(r.body).slice(0, 140));
  ok('...searched for, and told the bookings are already counted', saw.tools.some((t) => /web_search/.test(t.type || t.name || '')) && /ALREADY counted/.test(saw.system) && /319.86/.test(saw.system));
  ok('...and NOT saved', (await call('GET', T + '/budget')).body.lines.length === 2);

  r = await call('DELETE', `${T}/budget/lines/${line.id}`);
  ok('delete a line', r.status === 200 && (await call('GET', T + '/budget')).body.lines.length === 1);

  /* ---------- the example trip, and other people ---------- */
  const demoP = await (await fetch(B + '/api/trips/demo/packing')).json();
  const demoB = await (await fetch(B + '/api/trips/demo/budget')).json();
  ok('the example trip has packing and a budget for anyone', demoP.items.length > 3 && demoB.lines.length > 2 && demoB.booked.length === 2 && demoB.target === 3500);
  ok('...and cannot be changed', (await call('POST', '/api/trips/demo/packing', { text: 'x' })).status === 403);
  const other = (await fetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'x@example.com', password: 'a-long-password-2' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  ok('someone else sees nothing of mine', (await call('GET', T + '/packing', undefined, other)).status === 404 && (await call('GET', T + '/budget', undefined, other)).status === 404);
  ok('...and changes nothing', (await call('PATCH', `${T}/packing/${a.id}`, { checked: true }, other)).status === 404);
  ok('signed out, suggestions are refused before any model call', (await fetch(B + T + '/packing/suggest', { method: 'POST' })).status === 401);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
