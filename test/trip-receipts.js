// Receipts and card statements, through the real routes: both only propose,
// neither keeps the file, and the lines they lead to remember where their
// number came from.
const h = require('./harness.js');
h.install();

let script = null; let calls = 0; let saw = null;
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async (req) => { calls++; saw = req; return script(req); } }, batches: {} };
};
const receiptSays = (input) => async () => ({ stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 60 },
  content: [{ type: 'tool_use', id: 't', name: 'record_receipt', input }] });

// Storage is watched, not used: the point is that a receipt never reaches it.
const realFetch = global.fetch;
let storageCalls = 0;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (/nominatim|met\.no/.test(u)) return new Response('[]', { status: 200 });
  if (u.startsWith('https://storage.googleapis.com/') || u.startsWith('http://metadata.google.internal/')) {
    storageCalls++;
    return new Response('{}', { status: 200 });
  }
  return realFetch(url, opts);
};
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9224',
  PHOTOS_BUCKET: 'test-trip-photos',
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9224';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const uidOf = (email) => Buffer.from(email.toLowerCase()).toString('base64url');

// A JPEG's first bytes and some padding; the model is fake, so it only has to
// pass the shape checks.
const jpeg = (n = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]).toString('base64');

const CSV = [
  'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
  '09/21/2026,09/22/2026,MARRIOTT DESTIN,Travel,Sale,-200.00,',        // the day before: inside the slack
  '09/23/2026,09/24/2026,PUBLIX #1234,Groceries,Sale,-84.12,',
  '09/24/2026,09/25/2026,SHELL OIL 57444,Gas,Sale,-45.00,',
  '09/24/2026,09/25/2026,SQ *THE DONUT HOLE,Food & Drink,Sale,-23.45,', // also scanned as a receipt
  '09/25/2026,09/26/2026,DOLPHIN TOURS DESTIN,Entertainment,Sale,-160.00,',
  '09/26/2026,09/27/2026,SEASIDE SURF SHOP,Shopping,Sale,-32.10,',
  '09/25/2026,09/25/2026,Payment Thank You-Mobile,,Payment,500.00,',
  '09/10/2026,09/11/2026,NETFLIX.COM,Entertainment,Sale,-15.99,',       // before the trip
  '10/01/2026,10/02/2026,AMAZON MKTPL,Shopping,Sale,-12.00,',           // after it
].join('\r\n');

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const register = async (email) => (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await register('traveller@example.com');
  const other = await register('stranger@example.com');
  const call = async (method, p, b, c = me) => {
    const r = await realFetch(B + p, { method, headers: { ...J, cookie: c || '' }, body: b === undefined ? undefined : (typeof b === 'string' ? b : JSON.stringify(b)) });
    const text = await r.text();
    let body = {}; try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    return { status: r.status, body };
  };
  const trip = (await call('POST', '/api/trips', { name: 'Beach', destination: 'Santa Rosa Beach, FL', dateRange: 'Sep 22-27, 2026' })).body;
  const T = '/api/trips/' + trip.id;

  /* ---------- a receipt, read into a proposed line ---------- */
  script = receiptSays({ readable: true, merchant: 'The Donut Hole', total: 23.45, currency: 'USD', date: '2026-09-24', category: 'Food', note: 'Breakfast for 4', items: [{ name: 'Dozen donuts', amount: 14 }] });
  let r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } });
  ok('a receipt comes back as a proposed line', r.status === 200 && r.body.line && r.body.line.label === 'The Donut Hole' && r.body.line.spent === 23.45, JSON.stringify(r.body).slice(0, 160));
  ok('...dated, categorised, noted and marked as from a receipt',
     r.body.line.date === '2026-09-24' && r.body.line.category === 'Food' && r.body.line.note === 'Breakfast for 4' && r.body.line.source === 'receipt');
  ok('...with its currency, so a euro receipt can say so', r.body.currency === 'USD');
  ok('...read by the model with the photo and the trip in view',
     saw.messages[0].content.some((b) => b.type === 'image' && b.source.media_type === 'image/jpeg') && /Santa Rosa Beach/.test(saw.system) && /2026-09-22/.test(saw.system));
  ok('...forced to answer through the receipt tool', saw.tool_choice && saw.tool_choice.name === 'record_receipt');
  ok('...and NOTHING is saved', (await call('GET', T + '/budget')).body.lines.length === 0);
  ok('...and the photo never goes near storage', storageCalls === 0, String(storageCalls));

  const big = jpeg(900 * 1024);
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: big } });
  ok('a real-sized photo fits (the 100 KB default would refuse it)', r.status === 200, String(r.status));

  script = receiptSays({ readable: true, merchant: 'Pastelaria', total: 42, currency: 'eur', category: 'Food' });
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } });
  ok('a receipt in euros says so, and an unreadable date is no date', r.body.currency === 'EUR' && r.body.line.date === null, JSON.stringify(r.body));

  const before = calls;
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'application/pdf', data: jpeg() } });
  ok('a file that is not a photo is a 400', r.status === 400 && /photo/i.test(r.body.error), JSON.stringify(r.body));
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: '' } });
  ok('...and so is no photo at all', r.status === 400);
  r = await call('POST', T + '/budget/receipt', {});
  ok('...or no image field', r.status === 400);
  ok('...all refused BEFORE any model call is paid for', calls === before, `${before} -> ${calls}`);

  script = receiptSays({ readable: false });
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } });
  ok('an unreadable receipt says so, as a 422', r.status === 422 && /Could not read a total/.test(r.body.error), JSON.stringify(r.body));
  script = receiptSays({ readable: true, merchant: 'Blur', total: 'about a lot' });
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } });
  ok('...and so does a total that is not a number', r.status === 422);
  script = async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'text', text: 'I think it says $20?' }] });
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } });
  ok('...and so does an answer that skipped the tool', r.status === 422);

  let n = calls;
  r = await realFetch(B + T + '/budget/receipt', { method: 'POST', headers: J, body: JSON.stringify({ image: { mediaType: 'image/jpeg', data: jpeg() } }) });
  ok('signed out: 401, and no model call', r.status === 401 && calls === n);
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } }, other);
  ok("someone else's trip: 404, and no model call", r.status === 404 && calls === n);
  r = await call('POST', '/api/trips/demo/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } });
  ok('the example trip: refused', r.status === 403 && calls === n);
  const ids = h.bag('identity'); const uid = uidOf('traveller@example.com');
  ids.set('users/' + uid, { ...ids.get('users/' + uid), spentUsd: 999 });
  r = await call('POST', T + '/budget/receipt', { image: { mediaType: 'image/jpeg', data: jpeg() } });
  ok('out of credit: 402 saying how to top up, and no model call', r.status === 402 && /Top up/.test(r.body.detail) && calls === n, JSON.stringify(r.body).slice(0, 120));
  ids.set('users/' + uid, { ...ids.get('users/' + uid), spentUsd: 0 });

  /* ---------- the lines a receipt or a card lead to ---------- */
  r = await call('POST', T + '/budget/lines', { lines: [
    { category: 'Food', label: 'The Donut Hole', spent: 23.45, date: '2026-09-24', note: 'Breakfast for 4', source: 'receipt' },
    { category: 'Other', label: 'Mystery', spent: '5', date: '2026-02-30', source: 'bank-api' },
    { category: 'Food', label: 'Groceries', planned: 250 },
  ] });
  const byLabel = (lines, l) => lines.find((x) => x.label === l);
  ok('a line keeps its date and where its number came from', r.status === 200 && byLabel(r.body.lines, 'The Donut Hole').date === '2026-09-24' && byLabel(r.body.lines, 'The Donut Hole').source === 'receipt');
  ok('...a date that is not a day is no date, and an unknown source is manual',
     byLabel(r.body.lines, 'Mystery').date === null && byLabel(r.body.lines, 'Mystery').source === 'manual');
  ok('...and a line with neither reads as an undated manual line', byLabel(r.body.lines, 'Groceries').date === null && byLabel(r.body.lines, 'Groceries').source === 'manual');
  const donut = byLabel(r.body.lines, 'The Donut Hole');
  r = await call('PATCH', `${T}/budget/lines/${donut.id}`, { spent: '24.45' });
  ok('...and editing the amount keeps both', r.body.line.spent === 24.45 && r.body.line.date === '2026-09-24' && r.body.line.source === 'receipt');
  await call('PATCH', `${T}/budget/lines/${donut.id}`, { spent: '23.45' });
  await call('DELETE', `${T}/budget/lines/${byLabel((await call('GET', T + '/budget')).body.lines, 'Mystery').id}`);

  script = async () => ({ stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 },
    content: [{ type: 'tool_use', id: 't', name: 'budget_estimate', input: { lines: [{ category: 'Transport', label: 'Gas', planned: 90, source: 'receipt', date: '2026-09-23' }] } }] });
  r = await call('POST', T + '/budget/suggest');
  ok("Claude's estimates are marked as estimates, whatever the model claims", r.body.lines && r.body.lines[0].source === 'estimate' && r.body.lines[0].date === null, JSON.stringify(r.body));

  /* ---------- a card statement ---------- */
  const linesBefore = (await call('GET', T + '/budget')).body.lines.length;
  r = await call('POST', T + '/budget/statement', { csv: CSV });
  const tx = r.body.transactions || [];
  const find = (re) => tx.find((t) => re.test(t.description));
  ok('a statement is read', r.status === 200 && Array.isArray(tx), JSON.stringify(r.body).slice(0, 200));
  ok('...inside the trip window, from its dates', r.body.window && r.body.window.from === '2026-09-22' && r.body.window.to === '2026-09-27');
  ok('...a day of slack either side: the hotel charge the night before is in', !!find(/Marriott/i));
  ok('...charges outside the trip are counted and left out', r.body.skipped.outOfRange === 2 && !find(/netflix|amazon/i), JSON.stringify(r.body.skipped));
  ok('...payments are counted and left out', r.body.skipped.payments === 1 && !find(/payment/i));
  ok('...six charges offered', tx.length === 6, String(tx.length));
  ok('...each in this budget’s categories',
     find(/publix/i).category === 'Food' && find(/shell/i).category === 'Transport' && find(/donut/i).category === 'Food' &&
     find(/dolphin/i).category === 'Activities' && find(/surf shop/i).category === 'Shopping' && find(/marriott/i).category === 'Lodging',
     tx.map((t) => t.description + '=' + t.category).join(', '));
  ok('...with the amount as spending, not a signed number', find(/publix/i).amount === 84.12 && find(/publix/i).date === '2026-09-23');
  ok('...the dinner already scanned from a receipt is flagged, not dropped', find(/donut/i).possibleDuplicate === true && find(/publix/i).possibleDuplicate === false);
  ok('...room left in the budget is reported', r.body.room === 100 - linesBefore, String(r.body.room));
  ok('...and NOTHING is saved', (await call('GET', T + '/budget')).body.lines.length === linesBefore);

  r = await call('POST', T + '/budget/statement', { csv: 'hello,world\nthis,is not a statement\n' });
  ok('a file that is not a statement is a 400 that says what to download', r.status === 400 && /CSV/.test(r.body.error), JSON.stringify(r.body));
  r = await call('POST', T + '/budget/statement', { csv: '' });
  ok('...and an empty one is a 400', r.status === 400);
  r = await call('POST', T + '/budget/statement', {});
  ok('...and so is none at all', r.status === 400);
  const large = 'Transaction Date,Description,Amount\n' + '09/23/2026,PUBLIX,-1.00\n'.repeat(60000);
  r = await call('POST', T + '/budget/statement', { csv: large });
  ok('a statement over 1 MB fits the route (the default limit would refuse it)', r.status === 200, String(r.status) + ' ' + JSON.stringify(r.body).slice(0, 80));

  const undated = (await call('POST', '/api/trips', { name: 'Someday', destination: 'Somewhere' })).body;
  r = await call('POST', `/api/trips/${undated.id}/budget/statement`, { csv: CSV });
  ok('a trip with no dates has no window, so every charge is offered', r.body.window.from === null && r.body.transactions.length === 8 && r.body.skipped.outOfRange === 0, JSON.stringify(r.body.skipped));

  r = await realFetch(B + T + '/budget/statement', { method: 'POST', headers: J, body: JSON.stringify({ csv: CSV }) });
  ok('signed out: 401', r.status === 401);
  ok("someone else's trip: 404", (await call('POST', T + '/budget/statement', { csv: CSV }, other)).status === 404);

  // Adding the ticked charges is one call, and they say they came from a card.
  const chosen = tx.filter((t) => !t.possibleDuplicate).map((t) => ({ label: t.description, spent: t.amount, date: t.date, category: t.category, source: 'card' }));
  r = await call('POST', T + '/budget/lines', { lines: chosen });
  const cards = (r.body.lines || []).filter((l) => l.source === 'card');
  ok('the ticked charges are added in one call, dated and marked as card', r.status === 200 && cards.length === 5 && cards.every((l) => l.date && l.spent > 0), String(cards.length));
  r = await call('POST', T + '/budget/statement', { csv: CSV });
  ok('...and a second import of the same file flags all of them', r.body.transactions.every((t) => t.possibleDuplicate), r.body.transactions.filter((t) => !t.possibleDuplicate).map((t) => t.description).join(', '));

  const many = Array.from({ length: 120 }, (_, i) => ({ label: 'Charge ' + i, spent: i + 1, category: 'Other', source: 'card' }));
  r = await call('POST', T + '/budget/lines', { lines: many });
  ok('more lines than the budget holds is refused, saying how many fit', r.status === 400 && typeof r.body.room === 'number' && /room for \d+ more/.test(r.body.error), JSON.stringify(r.body));

  /* ---------- the limits stay where they were for everything else ---------- */
  r = await call('POST', T + '/budget/lines', { label: 'x', note: 'y'.repeat(200 * 1024) });
  ok('an ordinary route still refuses a body over 100 KB, in JSON', r.status === 413 && /too large/.test(r.body.error), String(r.status) + ' ' + JSON.stringify(r.body).slice(0, 80));
  r = await call('POST', T + '/budget/lines', '{"label": ');
  ok('...and malformed JSON is a JSON 400', r.status === 400 && r.body.error, JSON.stringify(r.body).slice(0, 80));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
