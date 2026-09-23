// Brewery crawls through the real routes: finding breweries, a route with a
// clock, check-ins and pours two phones share, menus looked up once and
// shared, picks, and the crawl into the itinerary. Open Brewery DB and
// Nominatim are faked at global.fetch - the sandbox cannot reach either.
const h = require('./harness.js');
h.install();
const crawlLib = require('../crawl');

let script = null; let calls = 0; let saw = null;
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async (req) => { calls++; saw = req; return script(req); } }, batches: {} };
};
const reply = (name, input) => ({ stop_reason: 'tool_use', usage: { input_tokens: 60, output_tokens: 60 }, content: [{ type: 'tool_use', id: 't', name, input }] });
/** The menus model: one menu per brewery it was asked about, plus one it was not. */
const menusModel = (extra) => async (req) => {
  const asked = JSON.parse(String(req.messages[0].content).replace(/^Breweries:\n/, ''));
  return reply('record_menus', { menus: asked.map((b) => Object.assign({
    breweryId: b.id,
    beers: [{ name: 'Hazy Daze', style: 'Hazy IPA', abv: '6.5%' }, { name: '<script>alert(1)</script>Night Shift', style: 'Stout', abv: 45 }],
    food: 'Tacos from <b>El Camion</b>', hours: 'Sat 12-9 PM', closesAt: '21:00',
    sources: [{ title: 'Untappd', url: 'https://untappd.com/v/x' }, { title: 'Old', url: 'http://insecure.example' }, { url: 'javascript:alert(1)' }],
    confidence: 'high', asOf: '2026-09-22',
  }, extra || {})).concat([{ breweryId: 'ghost-brewery', beers: [{ name: 'Nope' }], confidence: 'high' }]) });
};

const ROWS = [
  { id: 'b0000001-aaaa-4aaa-8aaa-000000000001', name: 'Riverbend Brewing', brewery_type: 'micro', address_1: '1 River Arts Dr', city: 'Asheville', state_province: 'North Carolina', latitude: '35.5873', longitude: '-82.5669', phone: '8285550101', website_url: 'http://riverbend.example' },
  { id: 'b0000002-aaaa-4aaa-8aaa-000000000002', name: 'Foundry Hill Brewing', brewery_type: 'brewpub', address_1: '2 Hill St', city: 'Asheville', state_province: 'North Carolina', latitude: '35.5946', longitude: '-82.5540', phone: '', website_url: 'https://foundryhill.example' },
  { id: 'b0000003-aaaa-4aaa-8aaa-000000000003', name: 'Lantern Ales', brewery_type: 'micro', address_1: '3 Lantern Way', city: 'Asheville', state_province: 'North Carolina', latitude: '35.5990', longitude: '-82.5500' },
  { id: 'b0000004-aaaa-4aaa-8aaa-000000000004', name: 'Old Mill Taproom', brewery_type: 'taproom', address_1: '4 Mill Rd', city: 'Asheville', state_province: 'North Carolina', latitude: '35.5800', longitude: '-82.5600' },
  { id: 'b0000005-aaaa-4aaa-8aaa-000000000005', name: 'Planned Brewing', brewery_type: 'planning', city: 'Asheville', latitude: '35.5951', longitude: '-82.5516' },
  { id: 'b0000006-aaaa-4aaa-8aaa-000000000006', name: 'Gone Brewing', brewery_type: 'closed', city: 'Asheville', latitude: '35.5952', longitude: '-82.5517' },
  { id: 'b0000007-aaaa-4aaa-8aaa-000000000007', name: 'Contract Co', brewery_type: 'contract', city: 'Asheville', latitude: '35.5953', longitude: '-82.5518' },
  { id: 'b0000008-aaaa-4aaa-8aaa-000000000008', name: 'Nowhere Brewing', brewery_type: 'micro', city: 'Asheville', latitude: null, longitude: null },
  { id: 'b0000009-aaaa-4aaa-8aaa-000000000009', name: 'Far Afield Brewing', brewery_type: 'regional', address_1: '9 Far Rd', city: 'Asheville', state_province: 'North Carolina', latitude: '35.6400', longitude: '-82.6000' },
  { id: 'b0000010-aaaa-4aaa-8aaa-000000000010', name: '<img src=x onerror=alert(1)>Sneaky Brewing', brewery_type: 'nano', city: 'Asheville', latitude: '35.5960', longitude: '-82.5530', website_url: 'javascript:alert(1)' },
];

const realFetch = global.fetch;
let obdb = { mode: 'ok', calls: 0, ua: '' }; let geocodes = 0;
const json = (v, status) => new Response(JSON.stringify(v), { status: status || 200, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.openbrewerydb.org/')) {
    obdb.calls++; obdb.ua = (opts && opts.headers && opts.headers['User-Agent']) || ''; obdb.url = u;
    if (obdb.mode === 'down') throw new TypeError('fetch failed');
    if (obdb.mode === '500') return new Response('upstream broke', { status: 500 });
    return json(ROWS);
  }
  if (/nominatim\.openstreetmap\.org/.test(u)) {
    geocodes++;
    const q = new URL(u).searchParams.get('q') || '';
    if (/asheville/i.test(q)) return json([{ lat: '35.5951', lon: '-82.5515', display_name: 'Asheville', address: { city: 'Asheville', state: 'North Carolina', country_code: 'us' } }]);
    if (/portland/i.test(q)) return json([{ lat: '45.5152', lon: '-122.6784', display_name: 'Portland', address: { city: 'Portland', state: 'Oregon', country_code: 'us' } }]);
    return json([]);
  }
  if (/met\.no/.test(u)) return json({});
  return realFetch(url, opts);
};

Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9232',
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9232';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const uidOf = (email) => Buffer.from(email.toLowerCase()).toString('base64url');
const ids = (list) => list.map((s) => s.id);

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const register = async (email) => (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await register('owner@example.com');
  const sarah = await register('sarah@example.com');
  const stranger = await register('stranger@example.com');
  const call = async (method, p, b, c = me) => {
    const r = await realFetch(B + p, { method, headers: { ...J, cookie: c || '' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const text = await r.text();
    let body = {}; try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    return { status: r.status, body };
  };
  const trip = (await call('POST', '/api/trips', { name: 'Asheville weekend', destination: 'Asheville, NC', dateRange: 'Oct 2-4, 2026', notes: 'Two of us, plus a dog' })).body;
  const T = '/api/trips/' + trip.id;

  /* ---------- finding breweries ---------- */
  let r = await call('GET', T + '/breweries/nearby');
  const near = r.body.breweries || [];
  ok('nearby: breweries around the trip\'s own place', r.status === 200 && r.body.centre && r.body.centre.lat === 35.5951 && /Asheville/.test(r.body.centre.label), JSON.stringify(r.body).slice(0, 200));
  ok('...nearest first, each with its distance', near.length > 3 && near.every((b, i) => i === 0 || b.km >= near[i - 1].km) && near.every((b) => typeof b.miles === 'number'));
  ok('...without the planned, closed, contract or unplaceable ones', !near.some((b) => /Planned|Gone|Contract|Nowhere/.test(b.name)) && near.length === 6, near.map((b) => b.name).join(', '));
  ok('...names cleaned and bad websites dropped, because they are drawn into the page', near.some((b) => b.name === 'Sneaky Brewing' && b.website === '') && !/[<>]/.test(JSON.stringify(near)));
  ok('...asked by_dist with an identifying User-Agent', /by_dist=35\.595%2C-82\.552|by_dist=35.595,-82.552/.test(obdb.url) && /trip-planner/.test(obdb.ua), obdb.url + ' / ' + obdb.ua);
  const g0 = geocodes, o0 = obdb.calls;
  r = await call('GET', T + '/breweries/nearby');
  ok('asking again: the place is stored on the trip and the list cached for an hour', r.status === 200 && geocodes === g0 && obdb.calls === o0, `${geocodes - g0} geocodes, ${obdb.calls - o0} directory calls`);

  obdb.mode = '500';
  r = await call('GET', T + '/breweries/nearby?near=' + encodeURIComponent('Portland, OR'));
  ok('the directory failing is a sentence, not a 500', r.status === 503 && /brewery directory/.test(r.body.error) && !/at |Error/.test(r.body.error), JSON.stringify(r.body));
  obdb.mode = 'down';
  r = await call('GET', T + '/breweries/nearby?near=' + encodeURIComponent('Portland, OR'));
  ok('...and so is it being unreachable', r.status === 503 && /Couldn.t reach the brewery directory/.test(r.body.error), JSON.stringify(r.body));
  obdb.mode = 'ok';
  r = await call('GET', T + '/breweries/nearby?near=' + encodeURIComponent('Portland, OR'));
  ok('?near= searches somewhere else, through the same geocoder', r.status === 200 && r.body.centre.lat === 45.5152 && r.body.breweries.length === 6);
  r = await call('GET', T + '/breweries/nearby?near=Atlantis');
  ok('...and a place the map cannot find says so', r.status === 200 && r.body.breweries.length === 0 && /Couldn.t find .Atlantis/.test(r.body.note), JSON.stringify(r.body));

  /* ---------- a crawl ---------- */
  const pick = (name) => near.find((b) => b.name === name);
  const riverbend = pick('Riverbend Brewing'), foundry = pick('Foundry Hill Brewing'), lantern = pick('Lantern Ales'), mill = pick('Old Mill Taproom'), far = pick('Far Afield Brewing');
  const scrambled = [far, riverbend, lantern, mill, foundry];
  r = await call('POST', T + '/crawls', { name: 'Saturday crawl', date: '2026-10-03', startTime: '15:00', stops: scrambled });
  const view = r.body; const C = T + '/crawls/' + (view.crawl && view.crawl.id);
  ok('create: a crawl, in the shortest order', r.status === 200 && ids(view.crawl.stops).join() === ids(crawlLib.bestRoute(scrambled.map(crawlLib.cleanStop))).join(), JSON.stringify(r.body).slice(0, 200));
  ok('...which is no longer than the order they were ticked in', crawlLib.pathKm(view.crawl.stops) <= crawlLib.pathKm(scrambled) + 1e-9);
  ok('...with a schedule, totals, links and room for menus', view.schedule.length === 5 && view.schedule[0].arrive === '15:00' && view.totals.endTime && /google\.com\/maps\/dir/.test(view.links.route)
     && view.links.stops.length === 5 && Object.keys(view.menus).length === 5 && Object.values(view.menus).every((m) => m === null) && Array.isArray(view.pours));
  ok('...and the far one is a ride, with a warning that says so', view.warnings.some((w) => w.kind === 'ride') && view.schedule.some((s) => s.legMode === 'ride'));
  ok('...stamped with who made it', view.crawl.createdBy === uidOf('owner@example.com') && view.crawl.stops.every((s) => s.visitedAt === null));
  r = await call('POST', T + '/crawls', { stops: scrambled, keepOrder: true });
  ok('keepOrder keeps the order given', r.status === 200 && ids(r.body.crawl.stops).join() === ids(scrambled).join());
  await call('DELETE', T + '/crawls/' + r.body.crawl.id);
  ok('eleven stops is too many', (await call('POST', T + '/crawls', { stops: Array.from({ length: 11 }, (_, i) => Object.assign({}, riverbend, { id: 'x' + i })) })).status === 400);
  ok('no stop that can go on a map is refused', (await call('POST', T + '/crawls', { stops: [{ id: 'x', name: 'X' }, { name: 'no id', lat: 1, lng: 1 }] })).status === 400);
  ok('a date that is not a day, or a start that is not a time, is refused',
     (await call('POST', T + '/crawls', { stops: [riverbend], date: '2026-02-30' })).status === 400 && (await call('POST', T + '/crawls', { stops: [riverbend], startTime: '3pm' })).status === 400);

  r = await call('GET', C);
  ok('get: the crawl with its schedule, warnings, links, menus and pours', r.status === 200 && r.body.crawl.name === 'Saturday crawl' && r.body.schedule.length === 5 && Array.isArray(r.body.warnings));

  /* ---------- editing ---------- */
  r = await call('PATCH', C, { name: 'Big <b>Saturday</b>', startTime: '14:00', mode: 'drive' });
  ok('patch: name (markup stripped), start time and mode', r.status === 200 && r.body.crawl.name === 'Big Saturday', r.body.crawl && r.body.crawl.name);
  ok('...drive mode makes every leg a drive', r.body.schedule[0].arrive === '14:00' && r.body.schedule.slice(1).every((s) => s.legMode === 'ride') && !r.body.warnings.some((w) => w.kind === 'ride'));
  await call('PATCH', C, { mode: 'walk', name: 'Saturday crawl' });
  const best = ids(view.crawl.stops);
  r = await call('PATCH', C, { order: best.slice().reverse() });
  ok('patch: a new order', r.status === 200 && ids(r.body.crawl.stops).join() === best.slice().reverse().join());
  ok('...refused when it is not exactly the stops', (await call('PATCH', C, { order: best.slice(1) })).status === 400 && (await call('PATCH', C, { order: best.slice(0, 4).concat(['nope']) })).status === 400);
  r = await call('PATCH', C, { reorder: 'optimal' });
  ok('reorder: optimal puts it back to the shortest route', crawlLib.pathKm(r.body.crawl.stops) <= crawlLib.pathKm(view.crawl.stops) + 1e-9);
  await call('PATCH', C, { order: best });
  r = await call('PATCH', C, { dwell: { [best[1]]: 90 }, dwellMinutes: 45 });
  ok('a stay for one stop, and a default for the rest', r.body.schedule[1].dwellMinutes === 90 && r.body.schedule[0].dwellMinutes === 45);
  ok('...a stay outside 20-180 minutes is refused', (await call('PATCH', C, { dwellMinutes: 400 })).status === 400);
  await call('PATCH', C, { dwell: { [best[1]]: null }, dwellMinutes: 60, startTime: '15:00' });

  /* ---------- check-ins ---------- */
  const [s0, s1, s2] = best;
  r = await call('POST', `${C}/visit/${s0}`);
  const firstAt = r.body.crawl.stops[0].visitedAt;
  ok('check in: the stop is stamped', r.status === 200 && typeof firstAt === 'string');
  r = await call('POST', `${C}/visit/${s0}`, { visited: true });
  ok('...checking in again keeps the first time', r.body.crawl.stops[0].visitedAt === firstAt);
  r = await call('POST', `${C}/visit/${s0}`);
  ok('...and a second tap undoes it', r.body.crawl.stops[0].visitedAt === null);
  await Promise.all([call('POST', `${C}/visit/${s0}`, { visited: true }), call('POST', `${C}/visit/${s1}`, { visited: true }, me)]);
  r = await call('GET', C);
  ok('two phones checking in at once both stick', r.body.crawl.stops[0].visitedAt && r.body.crawl.stops[1].visitedAt);
  ok('an unknown stop is a 404', (await call('POST', `${C}/visit/nope`)).status === 404);
  r = await call('PATCH', C, { order: [s1, s0].concat(best.slice(2)) });
  r = await call('PATCH', C, { reorder: 'optimal' });
  ok('optimising mid-crawl keeps the visited stops where they were walked', ids(r.body.crawl.stops).slice(0, 2).join() === [s1, s0].join(), ids(r.body.crawl.stops).join());
  await call('PATCH', C, { order: best });
  await call('POST', `${C}/visit/${s0}`, { visited: false }); await call('POST', `${C}/visit/${s1}`, { visited: false });

  /* ---------- pours ---------- */
  r = await call('POST', `${C}/pours`, { stopId: s0, beer: 'Hazy Daze', style: 'Hazy IPA', rating: 4, note: 'Juicy <i>and</i> soft' });
  ok('log a beer', r.status === 200 && r.body.pour.beer === 'Hazy Daze' && r.body.pour.rating === 4 && r.body.pour.by === uidOf('owner@example.com') && !/[<>]/.test(r.body.pour.note));
  const pourId = r.body.pour.id;
  ok('...at a stop on this crawl only', (await call('POST', `${C}/pours`, { stopId: 'nope', beer: 'x' })).status === 400);
  ok('...naming a beer', (await call('POST', `${C}/pours`, { stopId: s0, beer: '  ' })).status === 400);
  r = await call('POST', `${C}/pours`, { stopId: s0, beer: 'Mystery', rating: 9 });
  ok('...a rating outside 1-5 is no rating', r.body.pour.rating === null);
  await Promise.all([call('POST', `${C}/pours`, { stopId: s1, beer: 'Phone one', rating: 5 }), call('POST', `${C}/pours`, { stopId: s1, beer: 'Phone two', rating: 3 })]);
  r = await call('GET', C);
  ok('two phones logging at once both land', r.body.pours.filter((p) => /Phone (one|two)/.test(p.beer)).length === 2 && r.body.pours.length === 4, String(r.body.pours.length));
  r = await call('DELETE', `${C}/pours/${pourId}`);
  ok('delete a pour', r.status === 200 && !r.body.pours.some((p) => p.id === pourId) && r.body.pours.length === 3);
  ok('...an unknown or malformed one is a 404', (await call('DELETE', `${C}/pours/nope`)).status === 404 && (await call('DELETE', `${C}/pours/..%2F..%2Fx`)).status === 404);

  /* ---------- menus: looked up once, shared ---------- */
  await call('PATCH', C, { startTime: '19:00' });
  script = menusModel();
  let n = calls;
  r = await call('POST', `${C}/menus`);
  const cache = h.bag('trip-planner');
  ok('menus: one model call for the crawl\'s stops', r.status === 200 && calls === n + 1 && r.body.looked === 5 && r.body.remaining === 0, JSON.stringify(r.body).slice(0, 200));
  ok('...searching the web, recording through record_menus, told not to invent beers',
     saw.tools.some((t) => /web_search/.test(t.type || '')) && saw.tools.some((t) => t.name === 'record_menus') && /Do NOT invent beers/.test(saw.system) && /Sat, Oct 3/.test(saw.system));
  ok('...written to the shared cache, one document per brewery', ids(view.crawl.stops).every((id) => cache.has('breweries/' + id)) && cache.get('breweries/' + s0).name);
  const m0 = r.body.menus[s0];
  ok('...validated: markup gone, ABV a number or nothing, https links only',
     m0.beers[0].abv === 6.5 && m0.beers[1].abv === null && !/[<>]/.test(JSON.stringify(m0)) && m0.food === 'Tacos from El Camion'
     && m0.sources.length === 1 && m0.sources[0].url === 'https://untappd.com/v/x', JSON.stringify(m0).slice(0, 300));
  ok('...a brewery it was not asked about is not stored', !cache.has('breweries/ghost-brewery'));
  r = await call('GET', C);
  ok('get now carries the menus, and a closing time that bites becomes a warning',
     r.body.menus[s0] && r.body.menus[s0].stale === false && r.body.warnings.some((w) => w.kind === 'closed-on-arrival' || w.kind === 'closes-early'), JSON.stringify(r.body.warnings));
  n = calls;
  r = await call('POST', `${C}/menus`);
  ok('asking again while they are fresh makes no model call', r.status === 200 && calls === n && r.body.looked === 0);

  const other = (await call('POST', '/api/trips', { name: 'Theirs', destination: 'Asheville, NC' }, stranger)).body;
  const OC = (await call('POST', `/api/trips/${other.id}/crawls`, { stops: [riverbend, foundry] }, stranger)).body.crawl;
  n = calls;
  r = await call('POST', `/api/trips/${other.id}/crawls/${OC.id}/menus`, undefined, stranger);
  ok('someone else\'s crawl through the same breweries within 48 h: NO model call, menus served', r.status === 200 && calls === n && r.body.menus[riverbend.id] && r.body.menus[riverbend.id].beers.length === 2);
  const renamed = (await call('POST', `/api/trips/${other.id}/crawls`, { stops: [Object.assign({}, lantern, { name: 'Not Lantern At All' })] }, stranger)).body.crawl;
  r = await call('GET', `/api/trips/${other.id}/crawls/${renamed.id}`, undefined, stranger);
  ok('a cached menu is only served to a stop of the same name', r.body.menus[lantern.id] === null);
  const old = cache.get('breweries/' + foundry.id);
  cache.set('breweries/' + foundry.id, Object.assign({}, old, { fetchedAt: new Date(Date.now() - 3 * 86400000).toISOString() }));
  r = await call('GET', C);
  ok('an old menu is still shown, marked stale', r.body.menus[foundry.id] && r.body.menus[foundry.id].stale === true);
  n = calls;
  r = await call('POST', `${C}/menus`);
  ok('...and a lookup asks again for that one only', r.status === 200 && calls === n + 1 && r.body.looked === 1 && JSON.parse(saw.messages[0].content.replace(/^Breweries:\n/, '')).map((b) => b.id).join() === foundry.id);

  const seven = Array.from({ length: 7 }, (_, i) => ({ id: 'seven-' + i, name: 'Seven ' + i, type: 'micro', lat: 35.59 + i * 0.001, lng: -82.55 }));
  const SC = (await call('POST', T + '/crawls', { stops: seven })).body.crawl;
  n = calls;
  r = await call('POST', `${T}/crawls/${SC.id}/menus`);
  ok('seven new breweries: six looked up in one call, one left for the next', r.status === 200 && calls === n + 1 && r.body.looked === 6 && r.body.remaining === 1
     && JSON.parse(saw.messages[0].content.replace(/^Breweries:\n/, '')).length === 6, JSON.stringify(r.body).slice(0, 120));
  script = async () => reply('record_menus', { menus: [] });
  r = await call('POST', `${T}/crawls/${SC.id}/menus`);
  ok('a lookup that finds nothing says so, as the stream\'s error body', r.status === 200 && /without menus/.test(r.body.error || ''));
  await call('DELETE', `${T}/crawls/${SC.id}`);

  /* ---------- picks ---------- */
  script = async () => reply('record_picks', { picks: [
    { stopId: s0, order: 'Hazy Daze, a <b>half</b>', why: 'You like hazy; start small.' },
    { stopId: 'ghost', order: 'Imaginary', why: 'x' },
  ], pacing: 'Half pours at the first two; eat at the third.' });
  n = calls;
  r = await call('POST', `${C}/picks`, { preferences: 'Hazy IPAs, no sours' });
  ok('picks: saved on the crawl, for its own stops only', r.status === 200 && calls === n + 1 && r.body.crawl.picks[s0] && r.body.crawl.picks[s0].order === 'Hazy Daze, a half'
     && !r.body.crawl.picks.ghost && r.body.crawl.picksNote === 'Half pours at the first two; eat at the third.', JSON.stringify(r.body).slice(0, 200));
  ok('...forced through record_picks, with no web search, reading the menus and what they like',
     saw.tool_choice && saw.tool_choice.name === 'record_picks' && !saw.tools.some((t) => /web_search/.test(t.type || '')) && /Hazy Daze/.test(saw.system) && /no sours/.test(saw.system) && /plus a dog/.test(saw.system));
  ok('...and the preferences are kept', r.body.crawl.preferences === 'Hazy IPAs, no sours');
  script = async () => reply('record_picks', { picks: [{ stopId: 'ghost', order: 'x', why: 'y' }], pacing: '' });
  r = await call('POST', `${C}/picks`);
  ok('...picks only for stops that are not on the crawl come back as an error, and change nothing', /without any picks/.test(r.body.error || '')
     && (await call('GET', C)).body.crawl.picks[s0].order === 'Hazy Daze, a half');

  /* ---------- into the itinerary ---------- */
  await call('PATCH', C, { startTime: '15:00' });
  r = await call('POST', T + '/schedule/apply', { days: [
    { title: 'Arrive', date: '2026-10-02', dateLabel: 'Fri, Oct 2', blocks: [['5:00 PM', 'Check in']], tip: '' },
    { title: 'Town day', date: '2026-10-03', dateLabel: 'Sat, Oct 3', blocks: [['9:00 AM', 'Coffee'], ['7:30 PM', 'Dinner']], tip: '' },
  ] });
  let based = r.body.daysUpdatedAt;
  ok('schedule/apply now says when the itinerary last changed', r.status === 200 && typeof based === 'string');
  r = await call('POST', `${C}/itinerary`, { basedOn: based });
  const town = r.body.days && r.body.days[1];
  const mins = town ? town.blocks.map((b) => crawlLib.blockMinutes(b[0])) : [];
  ok('add to itinerary: the crawl lands in its day, in time order around coffee and dinner', r.status === 200 && town.blocks[0][1] === 'Coffee' && town.blocks.some((b) => b[1] === 'Dinner')
     && town.blocks.filter((b) => b[1].startsWith(crawlLib.TAG)).length === 5 && mins.every((m, i) => i === 0 || m >= mins[i - 1]), JSON.stringify(town));
  r = await call('GET', C);
  ok('...and a crawl that runs through dinner in the itinerary says so', r.body.warnings.some((w) => w.kind === 'clash' && /Dinner/.test(w.text) && /7:30 PM/.test(w.text)), JSON.stringify(r.body.warnings));
  r = await call('POST', `${C}/itinerary`, {});
  based = r.body.daysUpdatedAt;
  ok('...with what to order where there is a pick', town.blocks.some((b) => b[1] === crawlLib.TAG + 'Riverbend Brewing — Hazy Daze, a half' || (b[1].startsWith(crawlLib.TAG) && /Hazy Daze, a half/.test(b[1]))));
  ok('...saved through the itinerary\'s own store, with a new daysUpdatedAt', r.body.daysUpdatedAt && (await call('GET', T)).body.days[1].blocks.length === 7 && (await call('GET', T)).body.daysUpdatedAt === based);
  r = await call('POST', `${C}/itinerary`, { basedOn: based });
  ok('adding again replaces, never duplicates', r.status === 200 && r.body.days[1].blocks.filter((b) => b[1].startsWith(crawlLib.TAG)).length === 5);
  r = await call('POST', `${C}/itinerary`, { basedOn: based });
  ok('a stale basedOn is a 409 with the current itinerary', r.status === 409 && Array.isArray(r.body.days) && r.body.days.length === 2 && typeof r.body.daysUpdatedAt === 'string', String(r.status));
  based = r.body.daysUpdatedAt;
  await call('PATCH', C, { date: '2026-10-05' });
  r = await call('POST', `${C}/itinerary`, { basedOn: based });
  ok('a date the itinerary does not have gets a day of its own, and the old day is cleared', r.status === 200 && r.body.days.length === 3 && r.body.days[2].date === '2026-10-05'
     && !r.body.days[1].blocks.some((b) => b[1].startsWith(crawlLib.TAG)), JSON.stringify(r.body.days.map((d) => d.date)));
  await call('PATCH', C, { date: '2026-10-03' });
  r = await call('POST', `${C}/itinerary`, {});
  ok('...moved back, the day it made goes again', r.status === 200 && r.body.days.length === 2);
  await call('PATCH', C, { date: null });
  r = await call('POST', `${C}/itinerary`, {});
  ok('no date: a 400 that says what to do', r.status === 400 && /date/.test(r.body.error));
  await call('PATCH', C, { date: '2026-10-03' });

  /* ---------- a shared trip ---------- */
  await call('POST', T + '/share', { email: 'sarah@example.com' });
  r = await call('GET', T + '/crawls', undefined, sarah);
  ok('a member sees the trip\'s crawls', r.status === 200 && r.body.crawls.some((c) => c.id === view.crawl.id));
  r = await call('POST', `${C}/visit/${s2}`, { visited: true }, sarah);
  ok('...checks in', r.status === 200 && r.body.crawl.stops[2].visitedAt);
  r = await call('POST', `${C}/pours`, { stopId: s2, beer: 'Her pick', rating: 5 }, sarah);
  ok('...logs a beer as herself', r.status === 200 && r.body.pour.by === uidOf('sarah@example.com'));
  r = await call('POST', T + '/crawls', { stops: [lantern] }, sarah);
  ok('...and starts a crawl of her own on it', r.status === 200 && r.body.crawl.createdBy === uidOf('sarah@example.com'));
  const herCrawl = r.body.crawl.id;
  r = await call('GET', T + '/crawls');
  ok('the list: every crawl, soonest first, with each stop\'s times', r.body.crawls.length === 2 && r.body.crawls[0].date === '2026-10-03' && r.body.crawls[0].stops[0].arrive === '15:00' && r.body.crawls[0].visited === 1);
  ok('...and the trip\'s passport: breweries checked in, beers logged, average rating', r.body.passport.breweries === 1 && r.body.passport.beers === 4 && r.body.passport.avgRating === 4.3
     && r.body.passport.top.beer === 'Her pick', JSON.stringify(r.body.passport));

  /* ---------- strangers, signed out, out of credit ---------- */
  const routes = [
    ['GET', T + '/breweries/nearby'], ['GET', T + '/crawls'], ['POST', T + '/crawls', { stops: [riverbend] }], ['GET', C], ['PATCH', C, { name: 'x' }],
    ['DELETE', C], ['POST', C + '/stops', { stop: pick('Sneaky Brewing') }], ['DELETE', `${C}/stops/${s0}`], ['POST', `${C}/visit/${s0}`],
    ['POST', `${C}/pours`, { stopId: s0, beer: 'x' }], ['DELETE', `${C}/pours/whatever`], ['POST', `${C}/menus`], ['POST', `${C}/picks`], ['POST', `${C}/itinerary`, {}],
  ];
  n = calls;
  let codes = [];
  for (const [m, p, b] of routes) codes.push((await call(m, p, b, stranger)).status);
  ok('a stranger gets a 404 on every crawl route, and no model call is made', codes.every((c) => c === 404) && calls === n, codes.join(','));
  codes = [];
  for (const [m, p, b] of routes) codes.push((await realFetch(B + p, { method: m, headers: J, body: b ? JSON.stringify(b) : undefined })).status);
  ok('signed out, every one is a 401', codes.every((c) => c === 401), codes.join(','));
  const idb = h.bag('identity'); const uid = uidOf('owner@example.com');
  idb.set('users/' + uid, Object.assign({}, idb.get('users/' + uid), { spentUsd: 999 }));
  r = await call('POST', `${C}/menus`);
  const r2 = await call('POST', `${C}/picks`);
  ok('out of credit: menus and picks are a 402 before any model call', r.status === 402 && r2.status === 402 && calls === n && /Top up/.test(r.body.detail), `${r.status} ${r2.status}`);
  ok('...and everything that is not a model call still works', (await call('POST', `${C}/visit/${s0}`)).status === 200 && (await call('GET', T + '/breweries/nearby')).status === 200);
  await call('POST', `${C}/visit/${s0}`);
  idb.set('users/' + uid, Object.assign({}, idb.get('users/' + uid), { spentUsd: 0 }));

  /* ---------- the example trip ---------- */
  r = await call('GET', '/api/trips/demo/crawls', undefined, '');
  ok('the example trip has a crawl anyone can read', r.status === 200 && r.body.crawls.length === 1 && r.body.crawls[0].stopCount === 4);
  r = await call('GET', '/api/trips/demo/crawls/demo-marvila', undefined, '');
  ok('...with a schedule, a ride leg into Marvila, links and menus that say they are examples', r.status === 200 && r.body.demo === true && r.body.schedule.length === 4
     && r.body.schedule.some((s) => s.legMode === 'ride') && /google\.com\/maps/.test(r.body.links.route)
     && Object.values(r.body.menus).every((m) => /example/i.test(m.highlights) && m.confidence === 'low' && m.sources.length === 0));
  ok('...and example picks, labelled', Object.values(r.body.crawl.picks).every((p) => /^Example/.test(p.order)));
  ok('...another id there is a 404', (await call('GET', '/api/trips/demo/crawls/nope', undefined, '')).status === 404);
  n = calls;
  codes = [(await call('POST', '/api/trips/demo/crawls', { stops: [riverbend] })).status, (await call('PATCH', '/api/trips/demo/crawls/demo-marvila', { name: 'x' })).status,
    (await call('POST', '/api/trips/demo/crawls/demo-marvila/menus')).status, (await call('POST', '/api/trips/demo/crawls/demo-marvila/visit/demo-musa')).status,
    (await call('GET', '/api/trips/demo/breweries/nearby')).status];
  ok('...and nobody can change it', codes.every((c) => c === 403) && calls === n, codes.join(','));
  ok('...signed out, a write is a 401', (await call('POST', '/api/trips/demo/crawls/demo-marvila/pours', { stopId: 'demo-musa', beer: 'x' }, '')).status === 401);

  /* ---------- stops, and the caps ---------- */
  const sneaky = pick('Sneaky Brewing');
  r = await call('POST', `${C}/stops`, { stop: sneaky });
  const at = ids(r.body.crawl.stops).indexOf(sneaky.id);
  const before = r.body.crawl.stops.filter((s) => s.id !== sneaky.id);
  let lastDone = -1; before.forEach((s, i) => { if (s.visitedAt) lastDone = i; });
  ok('add a stop: it goes where it adds the least distance, ahead of the stops already visited', r.status === 200 && r.body.crawl.stops.length === 6
     && at === crawlLib.cheapestInsert(before, sneaky, lastDone + 1) && at > lastDone, `${at} (visited up to ${lastDone})`);
  ok('...once', (await call('POST', `${C}/stops`, { stop: sneaky })).status === 400);
  await call('POST', `${C}/pours`, { stopId: sneaky.id, beer: 'Gone soon' });
  r = await call('DELETE', `${C}/stops/${sneaky.id}`);
  ok('remove a stop: its pours go with it', r.status === 200 && r.body.crawl.stops.length === 5 && !r.body.pours.some((p) => p.stopId === sneaky.id));
  ok('...removing it again is a 404', (await call('DELETE', `${C}/stops/${sneaky.id}`)).status === 404);
  for (let i = 0; i < 5; i++) await call('POST', `${C}/stops`, { stop: { id: 'extra-' + i, name: 'Extra ' + i, lat: 35.6 + i * 0.001, lng: -82.55 } });
  ok('a crawl holds ten stops', (await call('GET', C)).body.crawl.stops.length === 10 && (await call('POST', `${C}/stops`, { stop: { id: 'eleven', name: 'Eleven', lat: 35.61, lng: -82.55 } })).status === 400);
  const sub = h.bag('sub');
  const pourKey = `trips/${trip.id}/crawls/${view.crawl.id}/pours/`;
  for (let i = 0; i < 300; i++) sub.set(pourKey + 'filler' + i, { stopId: s0, beer: 'Filler', rating: null, by: 'x', at: '2026-10-03T12:00:00Z' });
  r = await call('POST', `${C}/pours`, { stopId: s0, beer: 'One too many' });
  ok('a crawl holds 300 pours', r.status === 400 && /300/.test(r.body.error));
  let made = (await call('GET', T + '/crawls')).body.crawls.length;
  while (made < 20) { await call('POST', T + '/crawls', { stops: [riverbend] }); made++; }
  r = await call('POST', T + '/crawls', { stops: [riverbend] });
  ok('a trip holds twenty crawls', r.status === 400 && /20 crawls/.test(r.body.error));
  r = await call('DELETE', C);
  ok('delete a crawl: gone, with every pour under it', r.status === 200 && (await call('GET', C)).status === 404 && ![...sub.keys()].some((k) => k.startsWith(pourKey)));
  ok('...the shared menus stay for the next crawl through', cache.has('breweries/' + s0));
  ok('a member can delete a crawl too - it is the trip\'s, not one person\'s', (await call('DELETE', `${T}/crawls/${herCrawl}`, undefined, sarah)).status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
