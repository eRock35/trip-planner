// What every crawler thought of a brewery, and a person's lifetime passport.
//
// The counters on breweries/<id> (crowd.js): moved exactly once per check-in
// and pour however many times a phone taps, taken back on undo, on a pour
// edited or removed, a stop removed, a crawl or a trip deleted; never holding
// anything that says who; shown only past five; kept per brewery NAME so a
// crawl cannot rate a real brewery under a made-up one; never fed by the
// example trip. And the lifetime passport: only trips the person owns or is
// on, their own beers, milestones.
const h = require('./harness.js');
h.install();
const crowdLib = require('../crowd');
const lifetimeLib = require('../lifetime');

let modelMenus = null;
require.cache['FAKE_AN'].exports = function () {
  return { messages: { create: async (req) => {
    const asked = JSON.parse(String(req.messages[0].content).replace(/^Breweries:\n/, ''));
    return { stop_reason: 'tool_use', usage: { input_tokens: 60, output_tokens: 60 }, content: [{ type: 'tool_use', id: 't', name: 'record_menus', input: { menus: asked.map((b) => Object.assign({ breweryId: b.id }, modelMenus)) } }] };
  } }, batches: {} };
};
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (/nominatim|met\.no|openbrewerydb|frankfurter/.test(u)) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  return realFetch(url, opts);
};

Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9243',
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9243';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const uidOf = (email) => Buffer.from(email.toLowerCase()).toString('base64url');

const RB = { id: 'b0000001-aaaa-4aaa-8aaa-000000000001', name: 'Riverbend Brewing', type: 'micro', street: '1 River Arts Dr', city: 'Asheville', state: 'North Carolina', country: 'United States', lat: 35.5873, lng: -82.5669 };
const FH = { id: 'b0000002-aaaa-4aaa-8aaa-000000000002', name: 'Foundry Hill Brewing', type: 'brewpub', city: 'Asheville', state: 'North Carolina', country: 'United States', lat: 35.5946, lng: -82.554 };
const PDX = { id: 'b0000003-aaaa-4aaa-8aaa-000000000003', name: 'Rose City Ales', type: 'micro', city: 'Portland', state: 'Oregon', country: 'United States', lat: 45.52, lng: -122.67 };
const LIS = { id: 'b0000004-aaaa-4aaa-8aaa-000000000004', name: 'Tejo Taproom', type: 'taproom', city: 'Lisboa', state: 'Lisboa', country: 'Portugal', lat: 38.74, lng: -9.1 };
const store = h.bag('trip-planner');
const brewery = (id) => store.get('breweries/' + id) || null;
const bucket = (id, name) => { const d = brewery(id); return (d && d.crowd && d.crowd[crowdLib.nameKey(name)]) || {}; };
const n = (v) => Number(v || 0);

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const register = async (email) => (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await register('owner@example.com');
  const sarah = await register('sarah@example.com');
  const stranger = await register('stranger@example.com');
  const U = [];
  for (let i = 1; i <= 5; i++) U.push(await register('crawler' + i + '@example.com'));
  const call = async (method, p, b, c = me) => {
    const r = await realFetch(B + p, { method, headers: { ...J, cookie: c || '' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const text = await r.text();
    let body = {}; try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    return { status: r.status, body };
  };
  const newTrip = async (name, c = me) => (await call('POST', '/api/trips', { name, destination: 'Asheville, NC', dateRange: 'Oct 2-4, 2026' }, c)).body.id;
  const newCrawl = async (tripId, stops, c = me) => {
    const r = await call('POST', '/api/trips/' + tripId + '/crawls', { name: 'Crawl', date: '2026-10-03', stops, keepOrder: true }, c);
    return '/api/trips/' + tripId + '/crawls/' + r.body.crawl.id;
  };

  // A menu for Riverbend, as a lookup would have left it.
  store.set('breweries/' + RB.id, { name: 'Riverbend Brewing', city: 'Asheville', fetchedAt: new Date().toISOString(),
    menu: { beers: [{ name: 'Hazy Daze', style: 'Hazy IPA', abv: 6.5, note: '' }, { name: 'River Stout', style: 'Stout', abv: 7, note: '' }], food: '', confidence: 'high' } });

  const tripA = await newTrip('Asheville weekend');
  const A = '/api/trips/' + tripA;
  await call('POST', A + '/share', { email: 'sarah@example.com' });
  const C1 = await newCrawl(tripA, [RB, FH]);

  /* ---------- check-ins: once, whatever the taps ---------- */
  let r = await call('POST', C1 + '/visit/' + RB.id, { visited: true });
  ok('a check-in counts one', r.status === 200 && n(bucket(RB.id, RB.name).checkins) === 1, JSON.stringify(brewery(RB.id).crowd));
  r = await call('POST', C1 + '/visit/' + RB.id, { visited: true });
  ok('...checking in again does not count twice', n(bucket(RB.id, RB.name).checkins) === 1);
  r = await call('POST', C1 + '/visit/' + RB.id);
  ok('...the toggle undoes it and takes it back', r.status === 200 && r.body.crawl.stops[0].visitedAt === null && n(bucket(RB.id, RB.name).checkins) === 0);
  await call('POST', C1 + '/visit/' + RB.id, { visited: false });
  ok('...undoing twice does not go below', n(bucket(RB.id, RB.name).checkins) === 0);
  await Promise.all([1, 2, 3].map(() => call('POST', C1 + '/visit/' + RB.id, { visited: true })));
  ok('three phones checking in at once count one', n(bucket(RB.id, RB.name).checkins) === 1, n(bucket(RB.id, RB.name).checkins));
  r = await call('POST', C1 + '/visit/' + RB.id, { visited: true }, sarah);
  ok('a member checking in the same stop is the same check-in', r.status === 200 && n(bucket(RB.id, RB.name).checkins) === 1);
  r = await call('GET', C1);
  ok('...and one check-in is not shown (under five)', r.status === 200 && r.body.crowd && r.body.crowd[RB.id] === null, JSON.stringify(r.body.crowd));

  /* ---------- pours: counted, edited by the difference, removed once ---------- */
  r = await call('POST', C1 + '/pours', { stopId: RB.id, beer: 'hazy daze', rating: 3 });
  const p1 = r.body.pour.id;
  let b = bucket(RB.id, RB.name);
  const hk = crowdLib.beerKey('Hazy Daze');
  ok('a pour adds to pours, the rating sum and count, and the menu beer\'s row', n(b.pours) === 1 && n(b.ratingSum) === 3 && n(b.ratingN) === 1 && b.beers[hk].n === 1 && b.beers[hk].name === 'Hazy Daze', JSON.stringify(b));
  ok('...the pour handed back carries no bookkeeping', r.body.pour && r.body.pour.crowd === undefined && r.body.pours.every((p) => p.crowd === undefined));
  r = await call('PATCH', C1 + '/pours/' + p1, { rating: 5 });
  b = bucket(RB.id, RB.name);
  ok('3 stars edited to 5: the sum moves by 2, the count by nothing', r.status === 200 && n(b.ratingSum) === 5 && n(b.ratingN) === 1 && n(b.pours) === 1 && b.beers[hk].n === 1, JSON.stringify(b));
  ok('...and the pour says 5', r.body.pours.find((p) => p.id === p1).rating === 5);
  r = await call('PATCH', C1 + '/pours/' + p1, { rating: 5 });
  ok('...the same edit again moves nothing', n(bucket(RB.id, RB.name).ratingSum) === 5 && n(bucket(RB.id, RB.name).ratingN) === 1);
  await call('PATCH', C1 + '/pours/' + p1, { rating: null });
  b = bucket(RB.id, RB.name);
  ok('rating cleared: out of the sum and the count, still a pour', n(b.ratingSum) === 0 && n(b.ratingN) === 0 && n(b.pours) === 1);
  ok('a rating of 7 is refused', (await call('PATCH', C1 + '/pours/' + p1, { rating: 7 })).status === 400 && n(bucket(RB.id, RB.name).ratingN) === 0);
  await call('PATCH', C1 + '/pours/' + p1, { rating: 4, beer: 'Something <b>off</b> menu' });
  b = bucket(RB.id, RB.name);
  ok('renamed to a beer not on the menu: the menu beer\'s row gives its pour back', n(b.pours) === 1 && n(b.ratingSum) === 4 && b.beers[hk].n === 0, JSON.stringify(b));
  r = await call('POST', C1 + '/pours', { stopId: RB.id, beer: "Another typed pint", rating: 1 });
  ok('the same account\'s second off-menu beer here is the same voice ("other"): not counted', n(bucket(RB.id, RB.name).ratingSum) === 4 && n(bucket(RB.id, RB.name).pours) === 1);
  await call('DELETE', C1 + '/pours/' + r.body.pour.id);
  ok('...and removing it takes back nothing, because it added nothing', n(bucket(RB.id, RB.name).ratingSum) === 4 && n(bucket(RB.id, RB.name).pours) === 1);
  // Sarah, a member of the trip, has her own voice.
  r = await call('POST', C1 + '/pours', { stopId: RB.id, beer: "Erik's 40th birthday pint", rating: 2, note: 'with owner@example.com at 6pm' }, sarah);
  const p2 = r.body.pour.id;
  const raw = JSON.stringify(brewery(RB.id));
  ok('a typed beer not on the menu is never written by name (a member\'s voice counts)', !/Erik|birthday|40th|off menu/i.test(raw) && n(bucket(RB.id, RB.name).ratingSum) === 6, raw.slice(0, 300));
  r = await call('DELETE', C1 + '/pours/' + p2);
  ok('removing a pour takes its rating back', r.status === 200 && n(bucket(RB.id, RB.name).ratingSum) === 4 && n(bucket(RB.id, RB.name).pours) === 1);
  r = await call('DELETE', C1 + '/pours/' + p2);
  ok('...removing it again is a 404 and moves nothing', r.status === 404 && n(bucket(RB.id, RB.name).ratingSum) === 4 && n(bucket(RB.id, RB.name).pours) === 1);
  await Promise.all([1, 2].map(() => call('DELETE', C1 + '/pours/' + p1)));
  ok('two phones removing one pour take it back once', n(bucket(RB.id, RB.name).pours) === 0 && n(bucket(RB.id, RB.name).ratingSum) === 0 && n(bucket(RB.id, RB.name).ratingN) === 0, JSON.stringify(bucket(RB.id, RB.name)));

  /* ---------- nothing that says who ---------- */
  const doc = JSON.stringify(brewery(RB.id));
  const forbidden = [uidOf('owner@example.com'), uidOf('sarah@example.com'), 'owner@', 'sarah@', tripA, C1.split('/').pop(), p1, p2, '"by"', '"at"', 'visitedAt', 'with owner'];
  const crowdOnly = JSON.stringify(brewery(RB.id).crowd);
  ok('...and its counters carry no note, style or time', !/"note"|"style"|"at"|"by"|T\d\d:\d\d/.test(crowdOnly), crowdOnly);
  ok('the brewery document holds no uid, email, trip, crawl or pour id, author, time or note', forbidden.every((f) => doc.indexOf(f) < 0), forbidden.filter((f) => doc.indexOf(f) >= 0).join(', '));
  ok('...only the menu fields and counters', Object.keys(brewery(RB.id)).sort().join() === 'city,crowd,fetchedAt,menu,name');

  /* ---------- five before anything shows ---------- */
  // Four accounts (the owner and three others), each on their own crawl.
  await call('POST', C1 + '/pours', { stopId: RB.id, beer: 'Hazy Daze', rating: 4 });
  for (const u of U.slice(0, 3)) {
    const c = await newCrawl(await newTrip('Trip', u), [RB], u);
    await call('POST', c + '/visit/' + RB.id, { visited: true }, u);
    await call('POST', c + '/pours', { stopId: RB.id, beer: 'Hazy Daze', rating: 4 }, u);
  }
  r = await call('GET', C1);
  ok('four check-ins and four ratings: still nothing shown', n(bucket(RB.id, RB.name).checkins) === 4 && r.body.crowd[RB.id] === null, JSON.stringify(r.body.crowd));
  const C5 = await newCrawl(await newTrip('Fifth', U[3]), [RB], U[3]);
  await call('POST', C5 + '/visit/' + RB.id, { visited: true }, U[3]);
  await call('POST', C5 + '/pours', { stopId: RB.id, beer: 'HAZY DAZE ', rating: 5 }, U[3]);
  r = await call('GET', C1);
  const cr = r.body.crowd[RB.id];
  ok('the fifth check-in and rating: shown, as an average to the half star (4.2 reads 4.0)', cr && cr.checkins === 5 && cr.ratings === 5 && cr.rating === 4, JSON.stringify(cr));
  ok('...with the most-poured beer, spelled as the menu spells it', cr && cr.topBeer && cr.topBeer.name === 'Hazy Daze' && cr.topBeer.n === 5, JSON.stringify(cr));
  ok('...and the other stop, never checked in, shows nothing', r.body.crowd[FH.id] === null);
  ok('summary(): 4 of everything is null, 5 is shown', crowdLib.summary({ crowd: { [crowdLib.nameKey('X')]: { checkins: 4, ratingN: 4, ratingSum: 20, pours: 4 } } }, { id: 'x', name: 'X' }) === null
     && crowdLib.summary({ crowd: { [crowdLib.nameKey('X')]: { checkins: 5 } } }, { id: 'x', name: 'X' }).checkins === 5);
  ok('summary(): hostile stored numbers are clamped, markup stripped',
     (() => { const s = crowdLib.summary({ crowd: { [crowdLib.nameKey('X')]: { checkins: -40, ratingN: 5, ratingSum: 9999, pours: 9, beers: { a: { name: '<img src=x onerror=alert(1)>', n: 9 } } } } }, { id: 'x', name: 'X' });
       return s && s.checkins === null && s.rating === null && !/[<>]/.test(JSON.stringify(s)); })());

  /* ---------- coarse numbers: differencing one person out (2026-09-27) ---------- */
  const X = { id: 'x', name: 'X' }, KX = crowdLib.nameKey('X');
  const sum = (bk) => crowdLib.summary({ crowd: { [KX]: bk } }, X);
  ok('summary(): counts step down to a multiple of five (7 check-ins read 5, 13 ratings read 10)',
     sum({ checkins: 7, ratingN: 13, ratingSum: 52, pours: 13 }).checkins === 5 && sum({ checkins: 7, ratingN: 13, ratingSum: 52, pours: 13 }).ratings === 10);
  ok('summary(): the average is to the half star (4.2 -> 4, 4.3 -> 4.5, 3.74 -> 3.5)',
     sum({ ratingN: 5, ratingSum: 21 }).rating === 4 && sum({ ratingN: 10, ratingSum: 43 }).rating === 4.5 && sum({ ratingN: 50, ratingSum: 187 }).rating === 3.5);
  // The attack the rounding is for: read, one person pours, read again.
  // Before, 21/5 -> 4.2 and 26/6 -> 4.3 gave the sixth rating away exactly.
  // Now the counts do not move at all, and 2, 3 and 4 stars all read 4.0 -
  // what is left (an extreme rating can still tip the half star) is written
  // down in CLAUDE.md rather than claimed away here.
  const shown6 = [1, 2, 3, 4, 5].map((r6) => sum({ checkins: 6, ratingN: 6, ratingSum: 21 + r6, pours: 6 }));
  ok('one more check-in and rating: the counts do not move', shown6.every((x) => x.checkins === 5 && x.ratings === 5), JSON.stringify(shown6));
  ok('...and the average no longer names the rating: 2, 3 and 4 stars read the same', shown6[1].rating === 4 && shown6[2].rating === 4 && shown6[3].rating === 4, JSON.stringify(shown6.map((x) => x.rating)));
  ok('summary(): the most-poured beer is chosen by its stepped count, a tie to the name - one pour ahead names nothing new',
     sum({ pours: 20, beers: { a: { name: 'Zed IPA', n: 6 }, b: { name: 'Amber', n: 5 } } }).topBeer.name === 'Amber'
     && sum({ pours: 20, beers: { a: { name: 'Zed IPA', n: 10 }, b: { name: 'Amber', n: 9 } } }).topBeer.name === 'Zed IPA'
     && sum({ pours: 20, beers: { a: { name: 'Zed IPA', n: 10 }, b: { name: 'Amber', n: 9 } } }).topBeer.n === 10);
  ok('summary(): a beer with 7 pours reads 5, not 7', sum({ pours: 9, beers: { a: { name: 'Hazy', n: 7 } } }).topBeer.n === 5);

  /* ---------- a made-up name under a real id ---------- */
  const before = JSON.stringify(bucket(RB.id, RB.name));
  const fakeTrip = await newTrip('Fake', stranger);
  const fake = Object.assign({}, RB, { name: 'Totally Real Brewing' });
  const CF = await newCrawl(fakeTrip, [fake], stranger);
  await call('POST', CF + '/visit/' + RB.id, { visited: true }, stranger);
  for (let i = 0; i < 6; i++) await call('POST', CF + '/pours', { stopId: RB.id, beer: 'Hazy Daze', rating: 1 }, stranger);
  ok('a stop under a real id with another name never touches the real bucket', JSON.stringify(bucket(RB.id, RB.name)) === before, JSON.stringify(bucket(RB.id, RB.name)));
  ok('...its own bucket has no named beer (the menu is not its menu), and six pours by one account are one voice', !Object.keys(bucket(RB.id, fake.name).beers || {}).length && n(bucket(RB.id, fake.name).pours) === 1 && n(bucket(RB.id, fake.name).ratingN) === 1);
  r = await call('GET', C1);
  ok('...and the real stop still shows the real numbers', r.body.crowd[RB.id].rating === 4 && r.body.crowd[RB.id].checkins === 5);
  r = await call('GET', CF, undefined, stranger);
  ok('...while the fake stop reads only its own (one voice: nothing shown)', r.body.crowd[RB.id] === null, JSON.stringify(r.body.crowd));

  /* ---------- strangers and the example trip ---------- */
  const snapshot = JSON.stringify(brewery(RB.id));
  ok('a stranger checking in on someone else\'s crawl: 404, nothing counted', (await call('POST', C1 + '/visit/' + FH.id, { visited: true }, stranger)).status === 404);
  const someone = (await call('GET', C1)).body.pours[0].id;
  ok('...editing a pour there: 404', (await call('PATCH', C1 + '/pours/' + someone, { rating: 1 }, stranger)).status === 404);
  ok('...removing one: 404', (await call('DELETE', C1 + '/pours/' + someone, undefined, stranger)).status === 404);
  ok('...and the counters did not move', JSON.stringify(brewery(RB.id)) === snapshot);
  const demoKeys = () => Array.from(store.keys()).filter((k) => /^breweries\/demo-/.test(k));
  r = await call('POST', '/api/trips/demo/crawls/demo-marvila/visit/demo-musa', { visited: true });
  ok('the example trip refuses a check-in (403) and no demo brewery is counted', r.status === 403 && !demoKeys().length);
  r = await call('POST', '/api/trips/demo/crawls/demo-marvila/pours', { stopId: 'demo-musa', beer: 'x', rating: 5 });
  ok('...and a pour', r.status === 403 && !demoKeys().length);
  const DT = await newTrip('Copycat');
  const CD = await newCrawl(DT, [{ id: 'demo-musa', name: 'Musa', lat: 38.7447, lng: -9.1011 }]);
  await call('POST', CD + '/visit/demo-musa', { visited: true });
  await call('POST', CD + '/pours', { stopId: 'demo-musa', beer: 'x', rating: 5 });
  ok('...and a real crawl with the example\'s made-up stop id never counts either', !demoKeys().length && !crowdLib.countable({ id: 'demo-musa', name: 'Musa' }));
  r = await call('GET', '/api/trips/demo/crawls/demo-marvila');
  ok('the example crawl shows no crowd numbers', r.status === 200 && JSON.stringify(r.body.crowd) === '{}');

  /* ---------- taking it all back ---------- */
  const was = bucket(RB.id, RB.name);
  r = await call('DELETE', C5 + '/stops/' + RB.id, undefined, U[3]);
  b = bucket(RB.id, RB.name);
  ok('removing a stop takes back its check-in and its pours', r.status === 200 && (n(b.checkins) === n(was.checkins) - 1 && n(b.pours) === n(was.pours) - 1 && n(b.ratingSum) === n(was.ratingSum) - 5), `${r.status} ${JSON.stringify(b)}`);
  const C6 = await newCrawl(await newTrip('Sixth', U[4]), [RB, FH], U[4]);
  await call('POST', C6 + '/visit/' + RB.id, { visited: true }, U[4]);
  await call('POST', C6 + '/pours', { stopId: RB.id, beer: 'River Stout', rating: 3 }, U[4]);
  await call('POST', C6 + '/pours', { stopId: RB.id, beer: 'Hazy Daze', rating: 2 }, U[4]);
  const mid = bucket(RB.id, RB.name);
  r = await call('DELETE', C6, undefined, U[4]);
  b = bucket(RB.id, RB.name);
  ok('deleting a crawl takes back everything it added', r.status === 200 && n(b.checkins) === n(mid.checkins) - 1 && n(b.pours) === n(mid.pours) - 2 && n(b.ratingSum) === n(mid.ratingSum) - 5 && b.beers[crowdLib.beerKey('River Stout')].n === 0, JSON.stringify(b));
  ok('...its pours are gone with it', !Array.from(h.bag('sub').keys()).some((k) => k.indexOf(C6.split('/').pop()) >= 0));
  // The same account again: deleting C6 released its voices.
  const TX = await newTrip('To delete', U[4]);
  const CX = await newCrawl(TX, [RB], U[4]);
  await call('POST', CX + '/visit/' + RB.id, { visited: true }, U[4]);
  await call('POST', CX + '/pours', { stopId: RB.id, beer: 'Hazy Daze', rating: 1 }, U[4]);
  const pre = bucket(RB.id, RB.name);
  ok('a deleted crawl\'s voices are free again: the same account counts on a new crawl', n(pre.checkins) === n(b.checkins) + 1 && n(pre.pours) === n(b.pours) + 1, JSON.stringify(pre));
  r = await call('DELETE', '/api/trips/' + TX, undefined, U[4]);
  b = bucket(RB.id, RB.name);
  ok('deleting a trip takes back what its crawls added', r.status === 200 && n(b.checkins) === n(pre.checkins) - 1 && n(b.ratingSum) === n(pre.ratingSum) - 1 && n(b.pours) === n(pre.pours) - 1, JSON.stringify(b));

  /* ---------- a menu lookup keeps the counters ---------- */
  store.set('breweries/' + RB.id, Object.assign({}, brewery(RB.id), { fetchedAt: '2020-01-01T00:00:00.000Z' }));
  const keep = JSON.stringify(brewery(RB.id).crowd);
  modelMenus = { beers: [{ name: 'Fresh Pils', style: 'Pilsner', abv: 5 }], confidence: 'high', asOf: '2026-09-25' };
  r = await call('POST', C1 + '/menus', {});
  const after = brewery(RB.id);
  ok('a menu lookup replaces the menu and keeps every crawler\'s counters', /Fresh Pils/.test(JSON.stringify(after.menu)) && !/Hazy Daze/.test(JSON.stringify(after.menu)) && JSON.stringify(after.crowd) === keep, JSON.stringify(r.body).slice(0, 200));

  /* ---------- one voice per account per brewery ---------- */
  const XB = { id: 'b0000005-aaaa-4aaa-8aaa-000000000005', name: 'Crosstown Brewing', city: 'Asheville', state: 'North Carolina', country: 'United States', lat: 35.59, lng: -82.56 };
  const xb = () => bucket(XB.id, XB.name);
  const v1 = await register('voice1@example.com'), v2 = await register('voice2@example.com'), v3 = await register('voice3@example.com');
  const T1 = await newTrip('Voice one', v1), T2 = await newTrip('Voice two', v1), T3 = await newTrip('Voice three', v1);
  const X1 = await newCrawl(T1, [XB], v1), X2 = await newCrawl(T2, [XB], v1), X3 = await newCrawl(T3, [XB], v1);
  for (const c of [X1, X2, X3]) await call('POST', c + '/visit/' + XB.id, { visited: true }, v1);
  ok('one account checking in at one brewery on three crawls counts once', n(xb().checkins) === 1, JSON.stringify(xb()));
  const px = [];
  for (const c of [X1, X2, X3]) px.push((await call('POST', c + '/pours', { stopId: XB.id, beer: 'Off-menu lager', rating: 5 }, v1)).body.pour.id);
  ok('...and three pours of the same beer there count once', n(xb().pours) === 1 && n(xb().ratingSum) === 5 && n(xb().ratingN) === 1, JSON.stringify(xb()));
  const x2 = (await call('GET', X2, undefined, v1)).body;
  ok('...the others are still checked in and logged, just not counted', x2.crawl.stops[0].visitedAt && x2.pours.length === 1);
  await call('POST', '/api/trips/' + T1 + '/share', { email: 'voice2@example.com' }, v1);
  const X1b = await newCrawl(T1, [XB], v2);
  await call('POST', X1b + '/visit/' + XB.id, { visited: true }, v2);
  await call('POST', X1 + '/pours', { stopId: XB.id, beer: 'Off-menu lager', rating: 3 }, v2);
  ok('two members of one trip are two voices: two check-ins, two ratings', n(xb().checkins) === 2 && n(xb().pours) === 2 && n(xb().ratingSum) === 8, JSON.stringify(xb()));
  await call('PATCH', X1 + '/pours/' + px[0], { rating: 2 }, v1);
  ok('an edit on the counted pour still moves the sum (5 made 2)', n(xb().ratingSum) === 5 && n(xb().ratingN) === 2 && n(xb().pours) === 2, JSON.stringify(xb()));
  await call('PATCH', X2 + '/pours/' + px[1], { rating: 1 }, v1);
  ok('...an edit on an uncounted pour of the same beer moves nothing', n(xb().ratingSum) === 5 && n(xb().pours) === 2);
  // A member's undo releases the voice the owner's check-in holds.
  await call('POST', X1 + '/visit/' + XB.id, { visited: false }, v2);
  ok('undo releases the voice (here a member undoing the owner\'s check-in)', n(xb().checkins) === 1);
  ok('...and nothing else is re-counted by itself: the second crawl\'s check-in stays uncounted', n(xb().checkins) === 1 && (h.bag('sub').get('trips/' + T2 + '/crawls/' + X2.split('/').pop()).crowd || {})[XB.id] === null);
  const X4 = await newCrawl(await newTrip('Voice four', v1), [XB], v1);
  await call('POST', X4 + '/visit/' + XB.id, { visited: true }, v1);
  ok('...a later check-in takes the voice and counts', n(xb().checkins) === 2);
  await call('DELETE', X1 + '/pours/' + px[0], undefined, v1);
  ok('removing the counted pour releases its voice and its rating', n(xb().pours) === 1 && n(xb().ratingSum) === 3);
  await call('PATCH', X2 + '/pours/' + px[1], { rating: 4 }, v1);
  ok('...a later edit of another pour of that beer takes the voice', n(xb().pours) === 2 && n(xb().ratingSum) === 7 && n(xb().ratingN) === 2, JSON.stringify(xb()));
  const T5 = await newTrip('Concurrent', v3);
  const Y = [await newCrawl(T5, [XB], v3), await newCrawl(T5, [XB], v3), await newCrawl(T5, [XB], v3)];
  const cBefore = n(xb().checkins), pBefore = n(xb().pours);
  await Promise.all(Y.map((c) => call('POST', c + '/visit/' + XB.id, { visited: true }, v3)));
  await Promise.all([1, 2, 3].map(() => call('POST', Y[0] + '/pours', { stopId: XB.id, beer: 'Off-menu lager', rating: 4 }, v3)));
  ok('concurrent check-ins on three crawls and three pours at once by one account: one of each', n(xb().checkins) === cBefore + 1 && n(xb().pours) === pBefore + 1, JSON.stringify(xb()));
  const voices = Array.from(h.bag('trip-planner').entries()).filter(([k]) => k.startsWith('crowd-voices/'));
  const secrets = ['voice1@', 'voice2@', 'voice3@', '@example.com', uidOf('voice1@example.com'), uidOf('voice2@example.com'), uidOf('voice3@example.com'), uidOf('owner@example.com')];
  const marks = JSON.stringify(Array.from(h.bag('sub').entries()).map(([, v]) => v.crowd));
  ok('voices are recorded outside the shared document, holding only where the voice is', voices.length > 0 && voices.every(([k, v]) => /^crowd-voices\/[0-9a-f]{40}$/.test(k) && Object.keys(v).sort().join() === 'holder,kind' && /^[cp]:[^/]+\/[^/]+\/[^/]+$/.test(v.holder)));
  ok('...no uid or email is readable in a voice, its key, a mark or the brewery counters', secrets.every((x) => JSON.stringify(voices).indexOf(x) < 0 && marks.indexOf(x) < 0 && JSON.stringify(brewery(XB.id)).indexOf(x) < 0), secrets.filter((x) => JSON.stringify(voices).indexOf(x) >= 0 || marks.indexOf(x) >= 0).join());
  ok('...and the voice id is not a plain hash of the uid (it is keyed)', !voices.some(([k]) => k.indexOf(require('crypto').createHash('sha256').update(uidOf('voice1@example.com')).digest('hex').slice(0, 40)) >= 0));

  /* ---------- the lifetime passport ---------- */
  // Sarah's own trip, shared with the owner, in Portland; the stranger's
  // trip in Lisbon is nobody else's.
  const tripS = await newTrip('Portland', sarah);
  await call('POST', '/api/trips/' + tripS + '/share', { email: 'owner@example.com' }, sarah);
  const CS = await newCrawl(tripS, [PDX, Object.assign({}, FH, { id: 'b0000009-aaaa-4aaa-8aaa-000000000009', name: '<img src=x onerror=alert(1)>Sneaky Ales' })], sarah);
  await call('POST', CS + '/visit/' + PDX.id, { visited: true }, sarah);
  await call('POST', CS + '/visit/b0000009-aaaa-4aaa-8aaa-000000000009', { visited: true }, sarah);
  await call('POST', CS + '/pours', { stopId: PDX.id, beer: 'Rose <script>x</script>Pale', style: 'Pale Ale', rating: 5 }, sarah);
  await call('POST', CS + '/pours', { stopId: PDX.id, beer: 'Owner pint', style: 'Porter', rating: 5 }, me);
  const tripL = await newTrip('Lisbon', stranger);
  const CL = await newCrawl(tripL, [LIS], stranger);
  await call('POST', CL + '/visit/' + LIS.id, { visited: true }, stranger);
  await call('POST', C1 + '/visit/' + FH.id, { visited: true });

  ok('signed out: 401', (await call('GET', '/api/passport', undefined, '')).status === 401);
  r = await call('GET', '/api/passport');
  let pp = r.body;
  const stampIds = (p) => (p.stamps || []).map((s) => s.id).sort().join();
  ok('the owner\'s passport: their own trips and the one shared with them', r.status === 200 && pp.stamps.some((s) => s.id === PDX.id) && pp.stamps.some((s) => s.id === RB.id) && pp.stamps.some((s) => s.id === FH.id), stampIds(pp));
  ok('...never the stranger\'s Lisbon trip', !pp.stamps.some((s) => s.id === LIS.id) && pp.countries === 1 && pp.places.countries.join() === 'United States', JSON.stringify(pp.places));
  // Riverbend, Foundry Hill, Portland's two and the copied example stop.
  ok('...each brewery once, however many crawls stamped it', pp.breweries === 5 && new Set(pp.stamps.map((s) => s.id)).size === pp.stamps.length, pp.breweries);
  ok('...two states, two cities', pp.states === 2 && pp.cities === 2 && pp.places.states.join() === 'North Carolina,Oregon');
  const minePours = pp.beers;
  ok('...beers are the ones THEY logged, not Sarah\'s', minePours >= 1 && pp.top && pp.top.beer === 'Owner pint' && pp.top.rating === 5, JSON.stringify(pp.top));
  ok('...badges: every one listed, earned ones dated, locked ones with how', pp.badges.length === lifetimeLib.BADGES.length
     && pp.badges.find((x) => x.id === 'first-stamp').earned && pp.badges.find((x) => x.id === 'first-stamp').earnedAt
     && pp.badges.find((x) => x.id === 'five-star').earned
     && !pp.badges.find((x) => x.id === 'ten-taprooms').earned && pp.badges.find((x) => x.id === 'ten-taprooms').have === 5 && /10 different/.test(pp.badges.find((x) => x.id === 'ten-taprooms').hint)
     && pp.next && !pp.next.earned, JSON.stringify(pp.badges.slice(0, 3)));
  ok('...nothing in it carries markup', !/[<>]/.test(JSON.stringify(pp)) && pp.stamps.some((s) => s.name === 'Sneaky Ales'), JSON.stringify(pp.stamps.map((s) => s.name)));
  r = await call('GET', '/api/passport', undefined, stranger);
  ok('the stranger\'s passport: only their own trips', r.status === 200 && stampIds(r.body) === [LIS.id, RB.id].sort().join() && r.body.countries === 2, stampIds(r.body));
  r = await call('GET', '/api/passport', undefined, sarah);
  ok('Sarah\'s: her Portland trip and the Asheville trip shared with her', stampIds(r.body).indexOf(PDX.id) >= 0 && stampIds(r.body).indexOf(RB.id) >= 0 && stampIds(r.body).indexOf(LIS.id) < 0 && r.body.beers === 1, stampIds(r.body));
  await call('DELETE', '/api/trips/' + tripS + '/share/' + uidOf('owner@example.com'), undefined, sarah);
  r = await call('GET', '/api/passport');
  ok('taken off the shared trip: its stamps leave the owner\'s passport', r.status === 200 && !r.body.stamps.some((s) => s.id === PDX.id) && r.body.states === 1 && r.body.beers === minePours - 1, stampIds(r.body));
  await call('POST', C1 + '/visit/' + FH.id, { visited: false });
  r = await call('GET', '/api/passport');
  ok('an undone check-in stops counting on the next read', !r.body.stamps.some((s) => s.id === FH.id), stampIds(r.body));

  // Pure: the milestone clock.
  const mk = (id, at, extra) => Object.assign({ id, name: id, city: 'C' + id, state: 'S' + id, country: 'US', visitedAt: at }, extra || {});
  const lp = lifetimeLib.passport([{ id: 't', crawls: [{ crawl: { id: 'c', stops: Array.from({ length: 10 }, (_, i) => mk('s' + i, '2026-09-' + String(10 + i) + 'T12:00:00.000Z')) }, pours: [] }] }], 'u');
  ok('lifetime: ten breweries earns Ten taprooms on the day of the tenth', lp.badges.find((x) => x.id === 'ten-taprooms').earnedAt === '2026-09-19T12:00:00.000Z'
     && lp.badges.find((x) => x.id === 'five-states').earnedAt === '2026-09-14T12:00:00.000Z' && lp.badges.find((x) => x.id === 'full-crawl').earned);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
