// Exchange rates: the currency map, the cache, every failure hiding the
// feature, then the route through the real server with Nominatim and the
// rates source faked at fetch. The sandbox cannot reach the real source.
const h = require('./harness.js');
h.install();
const fxLib = require('../fx');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };

// What Frankfurter's /v1/latest?base=USD answers: 1 USD = n of each.
const USD_RATES = { amount: 1, base: 'USD', date: '2026-09-24', rates: { EUR: 0.8547, GBP: 0.7407, JPY: 156.25, CHF: 0.885 } };
const EUR_RATES = { amount: 1, base: 'EUR', date: '2026-09-24', rates: { USD: 1.17, GBP: 0.8666 } };
const NOMINATIM = {
  lisbon: [{ lat: '38.7077', lon: '-9.1366', name: 'Lisboa', display_name: 'Lisboa, Portugal', address: { city: 'Lisboa', state: 'Lisboa', country: 'Portugal', country_code: 'pt' } }],
  srb: [{ lat: '30.3960', lon: '-86.2288', name: 'Santa Rosa Beach', display_name: 'Santa Rosa Beach, Florida, United States', address: { town: 'Santa Rosa Beach', state: 'Florida', country: 'United States', country_code: 'us' } }],
  hanoi: [{ lat: '21.0285', lon: '105.8542', name: 'Hà Nội', display_name: 'Hà Nội, Việt Nam', address: { city: 'Hà Nội', country: 'Việt Nam', country_code: 'vn' } }],
};

(async () => {
  /* ---------- the map ---------- */
  ok('Portugal spends euros', fxLib.currencyFor('pt') === 'EUR' && fxLib.currencyFor('PT') === 'EUR');
  ok('Bulgaria has been on the euro since 2026', fxLib.currencyFor('bg') === 'EUR');
  ok('Ecuador and Puerto Rico spend dollars; Japan yen; the UK pounds', fxLib.currencyFor('ec') === 'USD' && fxLib.currencyFor('pr') === 'USD'
     && fxLib.currencyFor('jp') === 'JPY' && fxLib.currencyFor('gb') === 'GBP');
  ok('an unknown or missing country has no currency, not a guess', fxLib.currencyFor('zz') === null && fxLib.currencyFor('') === null && fxLib.currencyFor(undefined) === null);
  ok('every entry is a two-letter country and a three-letter code',
     Object.entries(fxLib.COUNTRY_CURRENCY).every(([k, v]) => /^[a-z]{2}$/.test(k) && /^[A-Z]{3}$/.test(v)) && Object.keys(fxLib.COUNTRY_CURRENCY).length > 230,
     String(Object.keys(fxLib.COUNTRY_CURRENCY).length));
  ok('home is the trip’s setting, else dollars; never something without rates',
     fxLib.homeOf({ homeCurrency: 'eur' }) === 'EUR' && fxLib.homeOf({}) === 'USD' && fxLib.homeOf({ homeCurrency: 'VND' }) === 'USD' && fxLib.homeOf(null) === 'USD');
  ok('codes are checked: junk is null', fxLib.code('<script>') === null && fxLib.code('ABC') === null && fxLib.code(' gbp ') === 'GBP');

  /* ---------- the cache ---------- */
  let clock = Date.parse('2026-09-25T12:00:00Z');
  const calls = [];
  let answer = () => new Response(JSON.stringify(USD_RATES), { status: 200 });
  const fx = fxLib.create({ fetchImpl: async (url, opts) => { calls.push({ url: String(url), ua: opts && opts.headers && opts.headers['User-Agent'] }); return answer(url); }, now: () => clock });

  let v = await fx.view({ home: 'USD', local: 'EUR' });
  ok('euros in dollars: €1 = $1.17', v.status === 'ok' && v.rate === 1.17 && v.local === 'EUR' && v.home === 'USD', JSON.stringify(v));
  ok('...with the ECB date and roughly when it was published', v.date === '2026-09-24' && v.publishedAt === '2026-09-24T14:00:00.000Z');
  ok('...and the attribution the page prints', /European Central Bank/.test(v.attribution) && /Estimates/.test(v.attribution));
  ok('the source is sent a currency code and nothing else', calls.length === 1 && calls[0].url === 'https://api.frankfurter.dev/v1/latest?base=USD', calls[0].url);
  ok('...identifying the app', /trip-planner\/1\.0/.test(calls[0].ua || ''));

  v = await fx.view({ home: 'USD', local: 'EUR', also: ['GBP', 'JPY', 'nonsense'] });
  ok('other currencies a budget uses come in the same answer', v.rates.GBP === 1.35007 && v.rates.JPY === 0.0064 && !('nonsense' in v.rates), JSON.stringify(v.rates));
  ok('...from the cache: one request per base currency', calls.length === 1);
  clock += 5 * 3600 * 1000;
  await fx.view({ home: 'USD', local: 'EUR' });
  ok('five hours on, still cached', calls.length === 1);
  clock += 2 * 3600 * 1000;
  await fx.view({ home: 'USD', local: 'EUR' });
  ok('past six hours, asked again', calls.length === 2);

  const [a, b] = await Promise.all([fx.view({ home: 'CHF', local: 'EUR' }), fx.view({ home: 'CHF', local: 'GBP' })]);
  ok('two pages at once share one request', calls.filter((c) => /base=CHF/.test(c.url)).length === 1);

  v = await fx.view({ home: 'USD', local: 'USD' });
  ok('a trip at home needs no rate and asks for none', v.status === 'same' && calls.length === 3, v.status + ' ' + calls.length);
  v = await fx.view({ home: 'USD', local: null });
  ok('no country, no currency - and no request', v.status === 'no-currency' && calls.length === 3);
  v = await fx.view({ home: 'USD', local: 'VND' });
  ok('a currency the source does not publish is "unsupported", not a made-up rate', v.status === 'unsupported' && v.rate === undefined);

  const bad = fxLib.create({ fetchImpl: async () => { calls.push({ url: 'bad' }); return new Response('down', { status: 503 }); }, now: () => clock });
  v = await bad.view({ home: 'USD', local: 'EUR' });
  ok('the source being down hides the feature', v.status === 'unavailable' && !v.rate && Object.keys(v.rates).length === 0);
  const before = calls.length;
  await bad.view({ home: 'USD', local: 'EUR' });
  ok('...and is not asked again on every page view', calls.length === before);
  clock += 11 * 60 * 1000;
  await bad.view({ home: 'USD', local: 'EUR' });
  ok('...but is, ten minutes later', calls.length === before + 1);
  const empty = fxLib.create({ fetchImpl: async () => new Response(JSON.stringify({ base: 'USD', date: '2026-09-24', rates: {} }), { status: 200 }), now: () => clock });
  ok('an empty answer is a failure, not "no rates exist"', (await empty.view({ home: 'USD', local: 'EUR' })).status === 'unavailable');
  const junk = fxLib.create({ fetchImpl: async () => new Response('<html>', { status: 200 }), now: () => clock });
  ok('...and so is an answer that is not JSON', (await junk.view({ home: 'USD', local: 'EUR' })).status === 'unavailable');
  const thrown = fxLib.create({ fetchImpl: async () => { throw new Error('ENOTFOUND'); }, now: () => clock });
  ok('...and a network error', (await thrown.view({ home: 'USD', local: 'EUR' })).status === 'unavailable');

  /* ---------- the route ---------- */
  const seen = { nominatim: 0, rates: 0, ratesUrls: [] };
  let ratesDown = false;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('nominatim')) {
      seen.nominatim++;
      const q = decodeURIComponent(new URL(u).searchParams.get('q') || '').toLowerCase();
      return new Response(JSON.stringify(q.includes('lisbon') ? NOMINATIM.lisbon : q.includes('hanoi') ? NOMINATIM.hanoi : q.includes('santa rosa') ? NOMINATIM.srb : []), { status: 200 });
    }
    if (u.includes('frankfurter')) {
      seen.rates++; seen.ratesUrls.push(u);
      if (ratesDown) return new Response('down', { status: 503 });
      return new Response(JSON.stringify(/base=EUR/.test(u) ? EUR_RATES : USD_RATES), { status: 200 });
    }
    if (u.includes('api.met.no')) return new Response('{}', { status: 200 });
    return realFetch(url, opts);
  };
  Object.assign(process.env, {
    IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
    FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
    ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9241',
  });
  require(require('path').join(__dirname, '..', 'server.js'));
  const B = 'http://127.0.0.1:9241';
  const J = { 'content-type': 'application/json' };
  await new Promise((r) => setTimeout(r, 900));
  const jar = async (email) => (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await jar('boss@example.com');
  const call = async (method, p, body, c = me) => {
    const r = await realFetch(B + p, { method, headers: { ...J, ...(c ? { cookie: c } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})), cache: r.headers.get('cache-control') };
  };
  const trip = (await call('POST', '/api/trips', { name: 'Lisbon', destination: 'Lisbon, Portugal', dateRange: 'Oct 1-5, 2026' })).body;
  const T = '/api/trips/' + trip.id;

  let r = await call('GET', T + '/rates');
  ok('a trip to Lisbon gets euros in dollars', r.status === 200 && r.body.status === 'ok' && r.body.local === 'EUR' && r.body.rate === 1.17, JSON.stringify(r.body).slice(0, 160));
  ok('...and the list of currencies a budget can be counted in', Array.isArray(r.body.homeCurrencies) && r.body.homeCurrencies[0] === 'USD');
  ok('...the place was looked up once and kept, country and all', h.bag('trip-planner').get('trips/' + trip.id).geo.countryCode === 'pt');
  ok('...privately cached', /private/.test(r.cache || ''), r.cache);
  const n0 = seen.nominatim, r0 = seen.rates;
  await call('GET', T + '/rates');
  ok('a second look asks nobody', seen.nominatim === n0 && seen.rates === r0);

  r = await call('GET', T + '/rates?also=GBP,JPY,%3Cb%3E,ABCD');
  ok('a budget line in pounds or yen gets its rate too; junk codes are dropped', r.body.rates.GBP > 1.3 && r.body.rates.JPY > 0 && Object.keys(r.body.rates).length === 3, JSON.stringify(r.body.rates));
  ok('...and only a base currency ever reaches the source', seen.ratesUrls.every((u) => /^https:\/\/api\.frankfurter\.dev\/v1\/latest\?base=[A-Z]{3}$/.test(u)), seen.ratesUrls.join(' '));

  // A place stored without a country - geocoded by an older build, say - is
  // looked up again ONCE, through the polite path, and remembered.
  const stored = h.bag('trip-planner').get('trips/' + trip.id);
  delete stored.geo.countryCode;
  const n1 = seen.nominatim;
  r = await call('GET', T + '/rates');
  ok('a stored place with no country is looked up once more', r.body.status === 'ok' && seen.nominatim === n1 + 1 && stored.geo.countryCode === undefined
     && h.bag('trip-planner').get('trips/' + trip.id).geo.countryCode === 'pt', seen.nominatim - n1);
  await call('GET', T + '/rates');
  ok('...and never again', seen.nominatim === n1 + 1);

  // Budget in euros: the Lisbon trip is now at home.
  r = await call('PATCH', T, { homeCurrency: 'eur' });
  ok('the home currency is a per-trip setting', r.status === 200 && h.bag('trip-planner').get('trips/' + trip.id).homeCurrency === 'EUR');
  r = await call('PATCH', T, { homeCurrency: 'XYZ' });
  ok('...only from the list', r.status === 400 && h.bag('trip-planner').get('trips/' + trip.id).homeCurrency === 'EUR');
  r = await call('GET', T + '/rates?also=USD');
  ok('budgeted in euros, Lisbon needs no chip - but a dollar line still gets its rate ($1 = €0.85)', r.body.status === 'same' && r.body.home === 'EUR' && r.body.rates.USD === 0.854701, JSON.stringify(r.body));
  await call('PATCH', T, { homeCurrency: 'USD' });

  // Budget lines remember their currency.
  r = await call('POST', T + '/budget/lines', { lines: [{ category: 'Food', label: 'Pasteis', spent: '12.60', currency: 'eur', source: 'receipt' }, { category: 'Food', label: 'Junk', spent: 5, currency: '<x>' }] });
  const pasteis = r.body.lines.find((l) => l.label === 'Pasteis'), junkLine = r.body.lines.find((l) => l.label === 'Junk');
  ok('a line keeps the currency it was entered in', r.status === 200 && pasteis.currency === 'EUR' && pasteis.spent === 12.6, JSON.stringify(pasteis));
  ok('...a junk currency is home money, not stored', junkLine.currency === null);
  r = await call('PATCH', `${T}/budget/lines/${pasteis.id}`, { spent: '14' });
  ok('...and keeps it when the amount is edited', r.body.line.currency === 'EUR' && r.body.line.spent === 14, JSON.stringify(r.body.line));

  // At home: no chip, no request.
  const home = (await call('POST', '/api/trips', { name: 'Beach', destination: 'Santa Rosa Beach, FL', dateRange: 'Sep 22-27, 2026' })).body;
  const rr = seen.rates;
  r = await call('GET', '/api/trips/' + home.id + '/rates');
  ok('a trip at home says so and asks the source nothing', r.body.status === 'same' && seen.rates === rr, r.body.status);
  const nowhere = (await call('POST', '/api/trips', { name: 'Somewhere', destination: '' })).body;
  r = await call('GET', '/api/trips/' + nowhere.id + '/rates');
  ok('no destination is "no currency", not an error', r.status === 200 && r.body.status === 'no-currency');
  const hanoi = (await call('POST', '/api/trips', { name: 'Hanoi', destination: 'Hanoi, Vietnam' })).body;
  r = await call('GET', '/api/trips/' + hanoi.id + '/rates');
  ok('a currency the ECB does not publish hides the chip', r.status === 200 && r.body.status === 'unsupported' && r.body.local === 'VND', r.body.status);

  // Who may see it.
  r = await call('GET', T + '/rates', undefined, '');
  ok('signed out gets nothing', r.status === 401, String(r.status));
  const stranger = await jar('stranger@example.com');
  r = await call('GET', T + '/rates', undefined, stranger);
  ok('a stranger gets the usual 404', r.status === 404, String(r.status));
  await call('POST', T + '/share', { email: 'wife@example.com' });
  const wife = await jar('wife@example.com');
  r = await call('GET', T + '/rates', undefined, wife);
  ok('someone the trip is shared with sees the same rate', r.status === 200 && r.body.status === 'ok' && r.body.rate === 1.17);
  r = await call('PATCH', T, { homeCurrency: 'GBP' }, wife);
  ok('...and can change what it is budgeted in, like any other detail', r.status === 200 && h.bag('trip-planner').get('trips/' + trip.id).homeCurrency === 'GBP');

  // The example trip: fixed, labelled, no request.
  const rd = seen.rates;
  r = await call('GET', '/api/trips/demo/rates', undefined, '');
  ok('the example trip has an example rate for anyone', r.status === 200 && r.body.status === 'ok' && r.body.example === true && r.body.local === 'EUR' && r.body.rate > 1);
  ok('...fixed, so it never asks the source', seen.rates === rd);
  r = await call('GET', '/api/trips/demo/budget', undefined, '');
  ok('...and its budget has lines in euros to convert', r.body.lines.some((l) => l.currency === 'EUR') && r.body.lines.some((l) => !l.currency));

  // Down: a 200 that hides the chip. A fresh home currency so no cache answers.
  ratesDown = true;
  await call('PATCH', T, { homeCurrency: 'CAD' });
  r = await call('GET', T + '/rates');
  ok('the source down is a 200 saying unavailable, never a 500', r.status === 200 && r.body.status === 'unavailable' && !r.body.rate, r.status + ' ' + r.body.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
