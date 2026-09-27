// The crowd backfill: check-ins and pours from before the counters shipped
// get counted through the same voice code a tap uses; first-day marks with no
// voice get one, or give their count back when the account's voice is held
// elsewhere; the example trip's stops never count; a second run changes
// nothing; only the cron key or an admin may run it.
const h = require('./harness.js');
h.install();
const crowdLib = require('../crowd');

const realFetch = global.fetch;
global.fetch = async (url, opts) => (/nominatim|met\.no|openbrewerydb|frankfurter/.test(String(url)) ? new Response('[]', { status: 200 }) : realFetch(url, opts));
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9244', CRON_SECRET: 'cron-test-key',
});

const uidOf = (email) => Buffer.from(email.toLowerCase()).toString('base64url');
const ALICE = uidOf('alice@example.com'), BOB = uidOf('bob@example.com');
const RB = { id: 'b0000001-aaaa-4aaa-8aaa-000000000001', name: 'Riverbend Brewing', city: 'Asheville', state: 'North Carolina', lat: 35.58, lng: -82.56 };
const DM = { id: 'demo-musa', name: 'Musa', city: 'Lisboa', lat: 38.74, lng: -9.1 };
const K = crowdLib.nameKey(RB.name);
const tp = h.bag('trip-planner'), sub = h.bag('sub');
// Bob's first-day pour (River Stout, 5 stars) and Alice's first-day
// check-in on L2 are already in the counters, without voices.
tp.set('breweries/' + RB.id, { name: RB.name, menu: { beers: [{ name: 'Hazy Daze' }, { name: 'River Stout' }] }, fetchedAt: '2026-09-25T00:00:00.000Z',
  crowd: { [K]: { checkins: 1, pours: 1, ratingSum: 5, ratingN: 1, beers: { [crowdLib.beerKey('River Stout')]: { name: 'River Stout', n: 1 } } } } });
tp.set('trips/L1', { name: 'Before', ownerId: ALICE, memberIds: [BOB], updatedAt: '2026-09-20T00:00:00Z' });
sub.set('trips/L1/crawls/lc1', { name: 'Old crawl', stops: [RB, DM], visits: { [RB.id]: '2026-09-20T19:00:00.000Z', [DM.id]: '2026-09-20T20:00:00.000Z' }, createdBy: ALICE });
sub.set('trips/L1/crawls/lc1/pours/a1', { stopId: RB.id, beer: 'Hazy Daze', rating: 4, by: ALICE, at: '2026-09-20T19:10:00.000Z' });
sub.set('trips/L1/crawls/lc1/pours/a2', { stopId: RB.id, beer: 'hazy daze', rating: 2, by: ALICE, at: '2026-09-20T19:20:00.000Z' });
sub.set('trips/L1/crawls/lc1/pours/a3', { stopId: DM.id, beer: 'x', rating: 5, by: ALICE, at: '2026-09-20T20:10:00.000Z' });
tp.set('trips/L2', { name: 'First day', ownerId: ALICE, updatedAt: '2026-09-26T00:00:00Z' });
sub.set('trips/L2/crawls/lc2', { name: 'First-day crawl', stops: [RB], visits: { [RB.id]: '2026-09-26T19:00:00.000Z' }, crowd: { [RB.id]: K }, createdBy: ALICE });
sub.set('trips/L2/crawls/lc2/pours/b1', { stopId: RB.id, beer: 'River Stout', rating: 5, by: BOB, at: '2026-09-26T19:10:00.000Z',
  crowd: { k: K, r: 5, b: crowdLib.beerKey('River Stout'), bn: 'River Stout' } });

require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9244';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const counters = () => JSON.stringify(tp.get('breweries/' + RB.id).crowd);
const snapshot = () => JSON.stringify([Array.from(tp.entries()).filter(([k]) => /^(breweries|crowd-voices)\//.test(k)), Array.from(sub.entries())]);

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const register = async (email) => (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const admin = await register('boss@example.com');
  const alice = await register('alice@example.com');
  const run = async (headers, q) => {
    const r = await realFetch(B + '/api/admin/crowd-backfill' + (q || ''), { method: 'POST', headers: Object.assign({}, J, headers) });
    let body = {}; try { body = await r.json(); } catch (e) {}
    return { status: r.status, body };
  };

  ok('signed out: refused', (await run({})).status === 401);
  ok('a signed-in non-admin: the admin surface\'s 404', (await run({ cookie: alice })).status === 404);
  ok('a wrong cron key: refused', (await run({ 'X-Cron-Key': 'nope' })).status === 401);
  const before = snapshot();
  let r = await run({ cookie: admin }, '?dry=1');
  const dryRun = r.body;
  ok('a dry run writes nothing', r.status === 200 && r.body.dry === true && snapshot() === before, JSON.stringify(r.body));

  r = await run({ 'X-Cron-Key': 'cron-test-key' });
  ok('...and reported exactly what the real run then did', JSON.stringify([dryRun.checkins, dryRun.pours]) === JSON.stringify([r.body.checkins, r.body.pours]), JSON.stringify(dryRun));
  const b = JSON.parse(counters())[K];
  ok('runs with the cron key', r.status === 200 && r.body.trips === 2 && r.body.crawls === 2, JSON.stringify(r.body));
  ok('check-ins: the old one counted, the example stop not, the first-day one given back (Alice\'s voice is taken)',
     JSON.stringify(r.body.checkins) === JSON.stringify({ counted: 1, notCounted: 1, voiced: 0, uncounted: 1 }) && b.checkins === 1, JSON.stringify(r.body.checkins) + ' ' + JSON.stringify(b));
  ok('pours: Alice\'s first Hazy Daze counted, her second of the same beer and the example stop\'s not, Bob\'s first-day pour given its voice',
     JSON.stringify(r.body.pours) === JSON.stringify({ counted: 1, notCounted: 2, voiced: 1, uncounted: 0 }) && b.pours === 2 && b.ratingSum === 9 && b.ratingN === 2, JSON.stringify(r.body.pours) + ' ' + JSON.stringify(b));
  ok('...the menu beer\'s row too', b.beers[crowdLib.beerKey('Hazy Daze')].n === 1 && b.beers[crowdLib.beerKey('River Stout')].n === 1);
  const lc1 = sub.get('trips/L1/crawls/lc1'), lc2 = sub.get('trips/L2/crawls/lc2');
  ok('every item now has a record: a voice, or null', lc1.crowd[RB.id].v && lc1.crowd[DM.id] === null && lc2.crowd[RB.id] === null
     && sub.get('trips/L1/crawls/lc1/pours/a1').crowd.v && sub.get('trips/L1/crawls/lc1/pours/a2').crowd === null
     && sub.get('trips/L1/crawls/lc1/pours/a3').crowd === null && sub.get('trips/L2/crawls/lc2/pours/b1').crowd.v);
  ok('no example-trip brewery was counted', !Array.from(tp.keys()).some((k) => /^breweries\/demo-/.test(k)));
  const voices = Array.from(tp.entries()).filter(([k]) => k.startsWith('crowd-voices/'));
  ok('three voices, holding only where they are, and no uid or email', voices.length === 3 && voices.every(([, v]) => Object.keys(v).sort().join() === 'holder,kind')
     && ![ALICE, BOB, '@example'].some((x) => JSON.stringify(voices).indexOf(x) >= 0), JSON.stringify(voices));

  const after = snapshot();
  r = await run({ cookie: admin });
  ok('run again (as the admin): nothing to do, nothing changed', r.status === 200 && r.body.checkins.counted + r.body.checkins.notCounted + r.body.checkins.voiced + r.body.checkins.uncounted === 0
     && r.body.pours.counted + r.body.pours.notCounted + r.body.pours.voiced + r.body.pours.uncounted === 0 && snapshot() === after, JSON.stringify(r.body));

  // The backfilled voice behaves like any other: Alice's undo releases it.
  const a1v = sub.get('trips/L1/crawls/lc1/pours/a1').crowd.v;
  const alicePours = await realFetch(B + '/api/trips/L1/crawls/lc1/pours/a1', { method: 'DELETE', headers: { ...J, cookie: alice } });
  ok('a backfilled pour removed through the app takes its count and its voice back', alicePours.status === 200 && JSON.parse(counters())[K].pours === 1
     && JSON.parse(counters())[K].ratingSum === 5 && tp.has('crowd-voices/' + a1v) === false && tp.has('crowd-voices/' + lc1.crowd[RB.id].v));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
