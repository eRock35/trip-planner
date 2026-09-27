// A service booted WITHOUT SESSION_SECRET (2026-09-27). Two features signed
// with it and fell back to a key anyone reading this public repo knows: the
// Gmail OAuth state (an HMAC under '') and the crowd's voice ids (an HMAC
// under 'unset'). Now each reports itself unavailable instead:
//  - Gmail says unavailable, connect is a 503, a callback carrying a state
//    signed with the empty key is refused before Google is asked;
//  - check-ins and pours still save, but count nothing and leave no record
//    (so the backfill counts them once a key is set); the backfill is a 503,
//    and the scheduler's once-only run waits rather than recording itself done.
const h = require('./harness.js');
h.install();
const crypto = require('crypto');

let googleCalls = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (/googleapis|accounts\.google/.test(u)) { googleCalls++; return new Response('{}', { status: 500 }); }
  if (/nominatim|met\.no|openbrewerydb|frankfurter/.test(u)) return new Response('[]', { status: 200 });
  return realFetch(url, opts);
};
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: '',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9252', CRON_SECRET: 'cron-test-key',
  GOOGLE_CLIENT_ID: 'client-id-here', GOOGLE_CLIENT_SECRET: 'client-secret-here',
  GOOGLE_REDIRECT_URI: 'https://trip.example.com/api/gmail/callback',
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9252';
const J = { 'content-type': 'application/json' };
const tp = h.bag('trip-planner'), sub = h.bag('sub');
const RB = { id: 'b0000001-aaaa-4aaa-8aaa-000000000001', name: 'Riverbend Brewing', type: 'micro', city: 'Asheville', state: 'North Carolina', country: 'United States', lat: 35.5873, lng: -82.5669 };

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const me = (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email: 'alice@example.com', password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const uid = Buffer.from('alice@example.com').toString('base64url');
  const call = async (method, p, body, extra) => {
    const r = await realFetch(B + p, { method, redirect: 'manual', headers: Object.assign({}, J, { cookie: me }, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await r.json(); } catch (e) { /* redirect */ }
    return { status: r.status, body: json, location: r.headers.get('location') };
  };

  /* ---------- Gmail ---------- */
  let r = await call('GET', '/api/gmail');
  ok('Gmail reports itself unavailable', r.status === 200 && r.body.available === false, JSON.stringify(r.body));
  r = await call('GET', '/api/gmail/connect');
  ok('connect: 503, not a redirect carrying an empty-key state', r.status === 503 && !r.location, `${r.status} ${r.location}`);
  const at = String(Date.now());
  const forged = `${uid}.${at}.` + crypto.createHmac('sha256', '').update(`${uid}.${at}`).digest('base64url');
  r = await call('GET', '/api/gmail/callback?code=x&state=' + encodeURIComponent(forged));
  ok('a callback with a state signed under the empty key is refused, and Google is never asked', r.status === 302 && /gmail=unavailable/.test(r.location) && googleCalls === 0, `${r.status} ${r.location} google=${googleCalls}`);
  ok('...and nothing was connected', !((tp.get('users/' + uid) || {}).gmail));

  /* ---------- the crowd ---------- */
  const trip = (await call('POST', '/api/trips', { name: 'Away', destination: 'Asheville, NC' })).body.id;
  const crawl = (await call('POST', `/api/trips/${trip}/crawls`, { name: 'Crawl', date: '2026-10-03', stops: [RB], keepOrder: true })).body.crawl.id;
  const C = `/api/trips/${trip}/crawls/${crawl}`;
  r = await call('POST', C + '/visit/' + RB.id, { visited: true });
  ok('a check-in still saves', r.status === 200 && r.body.crawl.stops[0].visitedAt, r.status);
  r = await call('POST', C + '/pours', { stopId: RB.id, beer: 'Hazy Daze', rating: 4 });
  ok('a pour still saves', r.status === 200 && r.body.pour && r.body.pour.rating === 4, r.status);
  const doc = sub.get(`trips/${trip}/crawls/${crawl}`);
  const pour = [...sub.entries()].find(([k]) => k.startsWith(`trips/${trip}/crawls/${crawl}/pours/`));
  ok('...neither counted: no counters, no voices', !(tp.get('breweries/' + RB.id) || {}).crowd && ![...tp.keys()].some((k) => k.startsWith('crowd-voices/')));
  ok('...and neither left a record, so a later backfill with a key counts them', !(doc.crowd && Object.prototype.hasOwnProperty.call(doc.crowd, RB.id))
     && pour && !Object.prototype.hasOwnProperty.call(pour[1], 'crowd'), JSON.stringify([doc.crowd, pour && pour[1]]));
  r = await call('POST', C + '/visit/' + RB.id, { visited: false });
  ok('an undo still works', r.status === 200 && r.body.crawl.stops[0].visitedAt === null);

  r = await call('POST', '/api/admin/crowd-backfill', undefined, { 'X-Cron-Key': 'cron-test-key' });
  ok('the backfill: 503, in words', r.status === 503 && /SESSION_SECRET/.test(r.body.error), JSON.stringify(r.body));
  r = await call('POST', '/api/cron/check-watches', undefined, { 'X-Cron-Key': 'cron-test-key' });
  ok('the scheduler tick still runs the sweep...', r.status === 200 && typeof r.body.checked === 'number', JSON.stringify(r.body));
  ok('...without recording the once-only backfill as done', !tp.has('control/crowd-backfill'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
