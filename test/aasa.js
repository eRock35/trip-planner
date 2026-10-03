// The iPhone app's association file, /.well-known/apple-app-site-association
// (see eriks-projects/mobile/README.md). Apple's fetcher sends no cookie and
// follows no redirect, and reads it only as JSON, so:
//  - no APPLE_TEAM_ID, or a malformed one: 404, so nothing wrong is published;
//  - set: 200, application/json, no redirect, no cookie, no sign-in;
//  - links open the app everywhere but /api/*, and the app may use the
//    passwords saved for this site;
//  - the Team ID is read per request, so a revision's env is all it takes.
const h = require('./harness.js');
h.install();

const PORT = 9271;
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: String(PORT), CRON_SECRET: 'cron-test-key',
});
delete process.env.APPLE_TEAM_ID;
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:' + PORT;
const PATH = '/.well-known/apple-app-site-association';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const get = (p, headers = {}) => fetch(B + p, { redirect: 'manual', headers });

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  let r = await get(PATH);
  ok('no APPLE_TEAM_ID: 404', r.status === 404, r.status);
  for (const bad of ['abcde12345', 'ABCDE1234', 'ABCDE12345X', 'ABCDE-1234', ' ']) {
    process.env.APPLE_TEAM_ID = bad;
    r = await get(PATH);
    ok(`a malformed Team ID (${JSON.stringify(bad)}): 404`, r.status === 404, r.status);
  }

  process.env.APPLE_TEAM_ID = 'ABCDE12345';
  r = await get(PATH, { 'X-Forwarded-Proto': 'https' });
  ok('set: 200 with no redirect', r.status === 200, r.status);
  ok('...served as application/json', /^application\/json\b/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  ok('...sets no cookie', !r.headers.get('set-cookie'), r.headers.get('set-cookie'));
  ok('...cacheable for an hour', /max-age=3600/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  const body = await r.json();
  const id = 'ABCDE12345.com.strongtechnicalconsulting.trip';
  const d = body.applinks && body.applinks.details;
  ok('applinks name this app', Array.isArray(d) && d.length === 1 && JSON.stringify(d[0].appIDs) === JSON.stringify([id]), JSON.stringify(d));
  ok('...every path but /api/*', JSON.stringify(d[0].components.map((c) => [c['/'], !!c.exclude])) === JSON.stringify([['/api/*', true], ['*', false]]),
    JSON.stringify(d[0].components));
  ok('webcredentials name this app', JSON.stringify(body.webcredentials) === JSON.stringify({ apps: [id] }), JSON.stringify(body.webcredentials));

  r = await get(PATH, { Cookie: 'x=%E0%A4%A' });
  ok('a stray malformed cookie does not change it', r.status === 200, r.status);

  process.env.APPLE_TEAM_ID = 'ZZZZZ99999';
  ok('read per request: a new value is served at once', JSON.stringify(await (await get(PATH)).json()).includes('ZZZZZ99999.com.strongtechnicalconsulting.trip'));

  r = await get(PATH + '.json');
  const twin = await r.text();
  ok('only the one path (no .json twin)', !(r.status === 200 && twin.includes('applinks')), r.status);

  // "Get the iPhone app" (shared/get-app.js): the link, or null.
  delete process.env.TESTFLIGHT_URL;
  r = await get('/ios-app.json');
  ok('no TestFlight link: 200 with url null, no sign-in', r.status === 200 && JSON.stringify(await r.json()) === JSON.stringify({ name: 'Trip Planner', url: null }), r.status);
  process.env.TESTFLIGHT_URL = 'https://testflight.apple.com/join/AbCd1234';
  ok('a TestFlight public link is answered', (await (await get('/ios-app.json')).json()).url === process.env.TESTFLIGHT_URL);
  process.env.TESTFLIGHT_URL = 'https://evil.example/join/AbCd1234';
  ok('anything else is null', (await (await get('/ios-app.json')).json()).url === null);
  delete process.env.TESTFLIGHT_URL;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
