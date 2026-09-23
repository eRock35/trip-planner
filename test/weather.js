// Weather on the Overview: the module against realistic MET Norway and
// Nominatim responses, then the route through the real server with the
// network faked at fetch.
const h = require('./harness.js');
h.install();
const assert = require('assert');
const weatherLib = require('../weather');

// ---- a MET-shaped forecast: hourly for 60h, then six-hourly, from NOW ----
const NOW = Date.parse('2026-09-23T15:00:00Z');
function metFixture(startMs, hotC = 31, coolC = 23) {
  const ts = [];
  for (let h = 0; h < 216; h += (h < 60 ? 1 : 6)) {
    const t = startMs + h * 3600000;
    const localHour = (new Date(t).getUTCHours() - 6 + 24) % 24; // about CST
    const temp = coolC + (hotC - coolC) * Math.max(0, Math.sin(((localHour - 6) / 24) * 2 * Math.PI));
    const block = { summary: { symbol_code: h > 40 && h < 70 ? 'rainshowers_day' : 'clearsky_day' }, details: { precipitation_amount: h > 40 && h < 70 ? 1.2 : 0 } };
    ts.push({ time: new Date(t).toISOString(), data: {
      instant: { details: { air_temperature: Number(temp.toFixed(1)) } },
      ...(h < 60 ? { next_1_hours: block } : { next_6_hours: block }),
    } });
  }
  return { properties: { timeseries: ts } };
}
const NOMINATIM_SRB = [{ lat: '30.3960', lon: '-86.2288', display_name: 'Santa Rosa Beach, Walton County, Florida, United States',
  name: 'Santa Rosa Beach', address: { town: 'Santa Rosa Beach', state: 'Florida', country: 'United States', country_code: 'us' } }];

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };

(async () => {
  /* ---------- the module ---------- */
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url: String(url), ua: opts && opts.headers && opts.headers['User-Agent'] });
    if (String(url).includes('nominatim')) return new Response(JSON.stringify(NOMINATIM_SRB), { status: 200 });
    return new Response(JSON.stringify(metFixture(NOW)), { status: 200 });
  };
  const w = weatherLib.create({ fetchImpl: fake, now: () => NOW });
  const geo = await w.geocode('Santa Rosa Beach, FL');
  ok('geocoding names the place the way a person would', geo && geo.name === 'Santa Rosa Beach, Florida', geo && geo.name);
  ok('...to four decimals, which is all MET accepts', geo.lat === 30.396 && geo.lon === -86.2288);
  ok('every request identifies the app, as both services require', calls.every((c) => /trip-planner\/1\.0/.test(c.ua || '')));

  let out = await w.forTrip(geo, { start: '2026-09-23', end: '2026-09-26', precision: 'day' });
  ok('a trip starting today gets a forecast', out.status === 'forecast', out.status);
  ok('...with days, highs above lows, in °F', out.days.length >= 4 && out.days.every((d) => d.hi >= d.lo) && out.days[0].hi > 80, JSON.stringify(out.days[0]));
  ok('...the trip’s own days marked', out.days.filter((d) => d.inTrip).map((d) => d.date).join() === '2026-09-23,2026-09-24,2026-09-25,2026-09-26',
     out.days.filter((d) => d.inTrip).map((d) => d.date).join());
  ok('...a rainy day reads as rain, with an amount', out.days.some((d) => d.icon === 'rain' && d.rainMm > 0), JSON.stringify(out.days.map((d) => d.icon)));
  ok('...and right now', out.now && typeof out.now.temp === 'number' && out.now.label === 'Sunny', JSON.stringify(out.now));
  ok('no day is shown whose afternoon the forecast does not cover (no "73 / 73" evening slivers)',
     out.days.every((d) => d.hi > d.lo), JSON.stringify(out.days.map((d) => d.date + ' ' + d.hi + '/' + d.lo)));
  ok('...and "today" is the destination\u2019s today', out.today === '2026-09-23', out.today);
  {
    // Starting at 7 PM local, the way a late-evening look does: the first day
    // has only evening hours in it and must not appear as a day.
    const EVE = Date.parse('2026-09-24T01:00:00Z');
    const w2 = weatherLib.create({ fetchImpl: async () => new Response(JSON.stringify(metFixture(EVE)), { status: 200 }), now: () => EVE });
    const o2 = await w2.forTrip(geo, null);
    ok('a forecast that starts in the evening drops that evening as a "day"',
       o2.days[0].date === '2026-09-24' && o2.days.every((d) => d.hi > d.lo), o2.days.slice(0, 2).map((d) => d.date + ' ' + d.hi + '/' + d.lo).join(', '));
  }
  ok('...with attribution, which both licences require', /MET Norway/.test(out.attribution) && /OpenStreetMap/.test(out.attribution));

  const metCalls = calls.filter((c) => c.url.includes('met.no')).length;
  await w.forTrip(geo, { start: '2026-09-23', end: '2026-09-26', precision: 'day' });
  ok('a second look within half an hour is served from cache', calls.filter((c) => c.url.includes('met.no')).length === metCalls);

  out = await w.forTrip(geo, { start: '2027-03-27', end: '2027-03-27', precision: 'day' });
  ok('a trip months away says when the forecast opens, and fetches nothing', out.status === 'later' && out.opensOn === '2027-03-18', JSON.stringify(out));
  out = await w.forTrip(geo, { start: '2026-09-01', end: '2026-09-05', precision: 'day' });
  ok('a finished trip says so', out.status === 'past');
  out = await w.forTrip(geo, { start: '2026-12-01', end: '2026-12-31', precision: 'month' });
  ok('"December" gets the next few days, not fake trip days', out.status === 'forecast' && out.tripDays === false && out.days.every((d) => !d.inTrip));
  out = await w.forTrip(null, null);
  ok('no place, no weather - and no error', out.status === 'no-place');

  ok('MET symbols become words', weatherLib.describe('partlycloudy_night').label === 'Partly cloudy' && weatherLib.describe('heavyrainandthunder').icon === 'storm');

  /* ---------- the route ---------- */
  const seen = { nominatim: 0, met: 0 };
  let nominatimAnswer = NOMINATIM_SRB;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('nominatim')) { seen.nominatim++; return new Response(JSON.stringify(nominatimAnswer), { status: 200 }); }
    if (u.includes('api.met.no')) { seen.met++; return new Response(JSON.stringify(metFixture(Date.now())), { status: 200 }); }
    return realFetch(url, opts);
  };
  Object.assign(process.env, {
    IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
    FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
    ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9219',
  });
  require(require('path').join(__dirname, '..', 'server.js'));
  const B = 'http://127.0.0.1:9219';
  const J = { 'content-type': 'application/json' };
  await new Promise((r) => setTimeout(r, 900));
  const reg = await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'boss@example.com', password: 'a-long-password-1' }) });
  const me = (reg.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
  const trip = await (await realFetch(B + '/api/trips', { method: 'POST', headers: { ...J, cookie: me }, body: JSON.stringify({ name: 'Beach', destination: 'Santa Rosa Beach, FL', dateRange: 'Sep 23-26, 2026' }) })).json();

  let r = await realFetch(`${B}/api/trips/${trip.id}/weather`, { headers: { cookie: me } });
  out = await r.json();
  ok('the route answers with a forecast for the trip', r.status === 200 && out.status === 'forecast', JSON.stringify(out).slice(0, 120));
  ok('...and stores the place on the trip', h.bag('trip-planner').get('trips/' + trip.id).geo.name === 'Santa Rosa Beach, Florida');
  const got = await (await realFetch(`${B}/api/trips/${trip.id}`, { headers: { cookie: me } })).json();
  ok('the trip itself now says when it is', got.dates && got.dates.start === '2026-09-23' && got.dates.end === '2026-09-26', JSON.stringify(got.dates));

  const before = seen.nominatim;
  await realFetch(`${B}/api/trips/${trip.id}/weather`, { headers: { cookie: me } });
  ok('a second visit does not look the place up again', seen.nominatim === before);

  await realFetch(`${B}/api/trips/${trip.id}`, { method: 'PATCH', headers: { ...J, cookie: me }, body: JSON.stringify({ destination: 'Somewhere that does not exist' }) });
  nominatimAnswer = [];
  out = await (await realFetch(`${B}/api/trips/${trip.id}/weather`, { headers: { cookie: me } })).json();
  ok('changing the destination looks again; nothing found is "no place", not an error', out.status === 'no-place', out.status);
  const n2 = seen.nominatim;
  await realFetch(`${B}/api/trips/${trip.id}/weather`, { headers: { cookie: me } });
  ok('...and a place that found nothing is not searched for on every visit', seen.nominatim === n2);

  r = await realFetch(`${B}/api/trips/${trip.id}/weather`);
  ok('someone signed out gets nothing', r.status === 401 || r.status === 404, String(r.status));
  const other = (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'x@example.com', password: 'a-long-password-2' }) })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  r = await realFetch(`${B}/api/trips/${trip.id}/weather`, { headers: { cookie: other } });
  ok('...and neither does someone else', r.status === 404, String(r.status));

  nominatimAnswer = NOMINATIM_SRB;
  r = await realFetch(`${B}/api/trips/demo/weather`);
  ok('the example trip has weather for anyone', r.status === 200 && ['forecast', 'later', 'past'].includes((await r.json()).status));

  global.fetch = async (url, opts) => (String(url).includes('met.no') ? new Response('down', { status: 503 }) : realFetch(url, opts));
  await realFetch(`${B}/api/trips/${trip.id}`, { method: 'PATCH', headers: { ...J, cookie: me }, body: JSON.stringify({ destination: 'Santa Rosa Beach, FL' }) });
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('nominatim')) return new Response(JSON.stringify(NOMINATIM_SRB), { status: 200 });
    if (u.includes('met.no')) return new Response('down', { status: 503 });
    return realFetch(url, opts);
  };
  // new coordinates-key so the cache cannot answer
  h.bag('trip-planner').get('trips/' + trip.id).geo = { query: 'Santa Rosa Beach, FL', name: 'X', lat: 10.1234, lon: 20.5678 };
  r = await realFetch(`${B}/api/trips/${trip.id}/weather`, { headers: { cookie: me } });
  out = await r.json();
  ok('MET being down is "unavailable", never a 500', r.status === 200 && out.status === 'unavailable', r.status + ' ' + out.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
