// Price watches over time: the price read out of each check's sentence, the
// series and its trend, then the watches route carrying them to the page.
const h = require('./harness.js');
h.install();
const ph = require('../pricehistory');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  /* ---------- reading a price ---------- */
  ok('the first marked amount is the price', eq(ph.priceIn('$842 return on the TAP nonstop - down from $1,010 in August.'), { amount: 842, currency: 'USD' }));
  ok('...through budget.money(): "$1,010" is 1010', eq(ph.priceIn('TAP nonstop $1,010 return. Delta via JFK $890 but 4h layover.'), { amount: 1010, currency: 'USD' }));
  ok('...cents kept', eq(ph.priceIn('US$ 99.50 today'), { amount: 99.5, currency: 'USD' }));
  ok('euros and pounds, by symbol, code or word', eq(ph.priceIn('€238 a night'), { amount: 238, currency: 'EUR' })
     && eq(ph.priceIn('EUR 238 a night'), { amount: 238, currency: 'EUR' }) && eq(ph.priceIn('about 300 euros'), { amount: 300, currency: 'EUR' })
     && eq(ph.priceIn('£85.'), { amount: 85, currency: 'GBP' }) && eq(ph.priceIn('842 USD return'), { amount: 842, currency: 'USD' }));
  ok('a bare number is not a price - dates, flight numbers, hours', ph.priceIn('Oct 1-5, 2026 on TAP 228, a 4h layover') === null);
  ok('no price is null, not zero', ph.priceIn('Sold out on those dates.') === null && ph.priceIn('') === null && ph.priceIn(null) === null);
  ok('"$1.2k" is not $1.20', ph.priceIn('about $1.2k') === null);
  ok('$0 is not a price', ph.priceIn('$0 - could not find a fare') === null);

  /* ---------- the series ---------- */
  const H = [
    { checkedAt: '2026-09-03T10:00:00Z', result: '$949 return.' },
    { checkedAt: '2026-09-01T10:00:00Z', result: '$1,010 return, nonstop.' },
    { checkedAt: '2026-09-02T10:00:00Z', result: 'Could not verify a price today.' },
    { checkedAt: '2026-09-04T10:00:00Z', result: '€800 on the TAP site.' },
    { checkedAt: 'not a date', result: '$1 typo' },
    { at: '2026-09-05T10:00:00Z', result: '$905 return - lowest so far.' },
    { checkedAt: '2026-09-06T10:00:00Z', result: '$930 return.' },
  ];
  const s = ph.series(H);
  ok('entries without a price or a date are skipped', s.points.length === 4, JSON.stringify(s.points));
  ok('...in time order, whichever of checkedAt / at the entry uses', eq(s.points.map((p) => p.price), [1010, 949, 905, 930]));
  ok('...one currency per line: the euro outlier is left out', s.currency === 'USD' && !s.points.some((p) => p.price === 800));
  ok('an empty history is an empty series', eq(ph.series([]), { currency: null, points: [] }) && eq(ph.series(undefined), { currency: null, points: [] }));

  /* ---------- the trend ---------- */
  const tr = ph.trend(s.points);
  ok('down $80 since the first price, 7.9%', tr.delta === -80 && tr.pct === -7.9 && tr.direction === 'down' && tr.since === '2026-09-01T10:00:00Z', JSON.stringify(tr));
  ok('...the low and when it was', tr.low === 905 && tr.lowAt === '2026-09-05T10:00:00Z' && tr.atLow === false && tr.high === 1010);
  ok('...and the last move on its own', tr.change === 25 && tr.last === 930 && tr.count === 4);
  ok('fewer than two prices is not a trend', ph.trend([]) === null && ph.trend([{ at: 'x', price: 1 }]) === null && ph.trend(null) === null);
  const back = ph.trend([{ at: 'a', price: 300 }, { at: 'b', price: 250 }, { at: 'c', price: 280 }, { at: 'd', price: 250 }]);
  ok('a price back at its low is "lowest yet", pointing at the latest time', back.atLow === true && back.lowAt === 'd');
  const up = ph.trend([{ at: 'a', price: 100 }, { at: 'b', price: 108 }]);
  ok('up 8%', up.direction === 'up' && up.pct === 8 && up.delta === 8);
  ok('flat is flat', ph.trend([{ at: 'a', price: 99.99 }, { at: 'b', price: 99.99 }]).direction === 'flat');
  ok('a watch with one priced check carries no price at all', ph.forWatch({ history: [{ checkedAt: '2026-09-01T00:00:00Z', result: '$5' }, { checkedAt: '2026-09-02T00:00:00Z', result: 'none' }] }) === null);

  /* ---------- through the routes ---------- */
  global.fetch = ((real) => async (url, opts) => (/nominatim|met\.no|frankfurter/.test(String(url)) ? new Response('[]', { status: 200 }) : real(url, opts)))(global.fetch);
  Object.assign(process.env, {
    IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
    FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
    ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9242',
  });
  require(require('path').join(__dirname, '..', 'server.js'));
  const B = 'http://127.0.0.1:9242';
  const J = { 'content-type': 'application/json' };
  await new Promise((r) => setTimeout(r, 900));
  const jar = async (email) => (await fetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await jar('boss@example.com');
  const call = async (method, p, body, c = me) => {
    const r = await fetch(B + p, { method, headers: { ...J, ...(c ? { cookie: c } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  let r = await call('GET', '/api/trips/demo/watches', undefined, '');
  const flight = r.body[0], hotel = r.body[1];
  ok('the example trip’s watches carry their prices', flight.price && flight.price.points.length === 8 && flight.price.currency === 'USD');
  ok('...the flight: down $168 since Aug 15, lowest yet', flight.price.trend.delta === -168 && flight.price.trend.since.startsWith('2026-08-15') && flight.price.trend.atLow);
  ok('...the hotel: a low that is not the latest price', hotel.price.trend.low === 236 && !hotel.price.trend.atLow && hotel.price.trend.last === 238);

  const trip = (await call('POST', '/api/trips', { name: 'Costa Rica', destination: 'Tamarindo' })).body;
  const w = (await call('POST', `/api/trips/${trip.id}/watches`, { kind: 'flight', label: 'ATL -> LIR', intervalHours: 24 })).body;
  r = await call('GET', `/api/trips/${trip.id}/watches`);
  ok('a watch never checked has no price', r.status === 200 && r.body[0].price === null);
  // History as runWatchCheck writes it (checkedAt + result), capped at 20.
  const key = [...h.bag('sub').keys()].find((k) => k.endsWith('/watches/' + w.id));
  h.bag('sub').get(key).history = H;
  r = await call('GET', `/api/trips/${trip.id}/watches`);
  ok('...once checked, it carries its series and trend', r.body[0].price.points.length === 4 && r.body[0].price.trend.delta === -80, JSON.stringify(r.body[0].price));
  ok('...worked out on read, never stored', !('price' in h.bag('sub').get(key)));

  const stranger = await jar('x@example.com');
  r = await call('GET', `/api/trips/${trip.id}/watches`, undefined, stranger);
  ok('a stranger gets the usual 404', r.status === 404);
  await call('POST', `/api/trips/${trip.id}/share`, { email: 'wife@example.com' });
  r = await call('GET', `/api/trips/${trip.id}/watches`, undefined, await jar('wife@example.com'));
  ok('someone it is shared with sees the same sparkline', r.status === 200 && r.body[0].price.trend.delta === -80);

  /* ---------- and the trips list carries dates for its countdown ---------- */
  await call('PATCH', `/api/trips/${trip.id}`, { dateRange: 'Mar 27 - Apr 2, 2027' });
  r = await call('GET', '/api/trips');
  const row = r.body.find((t) => t.id === trip.id);
  ok('the trips list says when each trip is', row.dates && row.dates.start === '2027-03-27' && row.dates.precision === 'day', JSON.stringify(row.dates));
  const vague = (await call('POST', '/api/trips', { name: 'Someday', dateRange: 'not sure yet' })).body;
  r = await call('GET', '/api/trips');
  ok('...and null when "When" gives nothing to go on', r.body.find((t) => t.id === vague.id).dates === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
