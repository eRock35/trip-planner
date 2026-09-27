// The 2026-09-27 hardening, behaviourally:
//  - the watch cron is the scheduler's: the cron key only, a signed-in free
//    account gets nothing, and the answer is counts - never anyone's results;
//  - ?selftest=1 (three Sonnet calls) is the cron key's too;
//  - the sweep charges each check to the trip's OWNER, and still skips an
//    owner with no credit left;
//  - every cron-key check compares in constant time;
//  - the brewery search's "near" box: ten a minute per person, and a capped
//    line to the one-a-second map search;
//  - trust proxy + parsed cookies: a Face ID enrolment and sign-in round trip
//    works behind an https front end (a software authenticator, real crypto);
//  - nosniff and HSTS on every response.
const h = require('./harness.js');
h.install();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Count every model call, and whose client made it.
const calls = [];
require.cache['FAKE_AN'].exports = function FakeAnthropic() {
  return { messages: { create: async (params) => {
    calls.push({ model: params.model });
    return { content: [{ type: 'text', text: '$842 return, nonstop.' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 } };
  }, batches: {} } };
};

// The map search: held open on demand, so a line can be built up.
let hold = null;
let geocodes = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('nominatim')) {
    geocodes++;
    if (hold) await hold.promise;
    return new Response(JSON.stringify([{ lat: '35.59', lon: '-82.55', display_name: 'Asheville, NC, United States', name: 'Asheville', address: { city: 'Asheville', country_code: 'us' } }]), { status: 200 });
  }
  if (/openbrewerydb|met\.no|frankfurter/.test(u)) return new Response('[]', { status: 200 });
  return realFetch(url, opts);
};

const PORT = 9251;
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: String(PORT), CRON_SECRET: 'cron-test-key',
  GEOCODE_QUEUE_MAX: '3', GEOCODE_PER_USER: '3', DAILY_CAP_CACHE_MS: '0',
});
require(path.join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:' + PORT;
const J = { 'content-type': 'application/json' };
const uidOf = (email) => Buffer.from(email.toLowerCase()).toString('base64url');
const ids = h.bag('identity'), tp = h.bag('trip-planner');
const cookiesOf = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).filter((c) => !/=$/.test(c)).join('; ');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };

/* ---------- a software authenticator: just enough CBOR and ES256 ---------- */
function cbor(v) {
  const head = (major, n) => (n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]));
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();
function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  let counter = 0;
  const count = () => { const b = Buffer.alloc(4); b.writeUInt32BE(counter++); return b; };
  return {
    create(options, origin) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(options.rp.id), Buffer.from([0x45]), count(), Buffer.alloc(16), len, credId, cose]);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData), attestationObject: b64u(cbor({ fmt: 'none', attStmt: {}, authData })), transports: ['internal'] } };
    },
    get(options, origin) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
      const authData = Buffer.concat([sha(options.rpId), Buffer.from([0x05]), count()]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) } };
    },
  };
}

(async () => {
  await wait(900);
  const register = async (email) => cookiesOf(await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }));
  const call = async (method, p, body, cookie, extra) => {
    const r = await realFetch(B + p, { method, headers: Object.assign({}, J, cookie ? { cookie } : {}, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; const text = await r.text(); try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: r.status, body: json, headers: r.headers, res: r };
  };
  const cron = (q, key) => call('POST', '/api/cron/check-watches' + (q || ''), undefined, null, key === undefined ? { 'X-Cron-Key': 'cron-test-key' } : key ? { 'X-Cron-Key': key } : {});

  const alice = await register('alice@example.com');   // owns a trip with a watch
  const carol = await register('carol@example.com');   // owns one too, out of credit
  const bob = await register('bob@example.com');       // a free account, nothing else
  const ALICE = uidOf('alice@example.com'), CAROL = uidOf('carol@example.com');
  const aTrip = (await call('POST', '/api/trips', { name: 'Alice away', destination: 'Asheville, NC' }, alice)).body;
  await call('POST', `/api/trips/${aTrip.id}/watches`, { kind: 'flight', label: 'ATL to AVL', intervalHours: 6 }, alice);
  const cTrip = (await call('POST', '/api/trips', { name: 'Carol away' }, carol)).body;
  await call('POST', `/api/trips/${cTrip.id}/watches`, { kind: 'hotel', label: 'Somewhere', intervalHours: 6 }, carol);
  ids.set('users/' + CAROL, Object.assign({}, ids.get('users/' + CAROL), { spentUsd: 50 }));
  tp.set('control/crowd-backfill', { doneAt: '2026-09-27T00:00:00.000Z' });   // not what this suite is about

  /* ---------- 1. the watch cron is the scheduler's ---------- */
  let r = await cron('', null);
  ok('signed out, no key: 401', r.status === 401, r.status);
  r = await call('POST', '/api/cron/check-watches', undefined, bob);
  ok('a signed-in free account: 401, and nothing ran', r.status === 401 && calls.length === 0, `${r.status} ${calls.length}`);
  ok('...its answer holds no result and no trip id', !JSON.stringify(r.body || {}).includes(aTrip.id) && !(r.body && r.body.results));
  r = await call('POST', '/api/cron/check-watches', undefined, bob, { 'X-Cron-Key': 'cron-test-kez' });
  ok('a session plus a wrong key of the right length: 401', r.status === 401);

  /* ---------- 4. the sweep charges the owner ---------- */
  const spent = (uid) => Number((ids.get('users/' + uid) || {}).spentUsd || 0);
  const aliceBefore = spent(ALICE);
  r = await cron();
  await wait(100);   // the meter's write is fire-and-forget
  ok('the scheduler\'s key: the sweep runs', r.status === 200 && r.body.checked === 1, JSON.stringify(r.body));
  ok('...and answers counts only - no results, no trip or watch ids', Object.keys(r.body).sort().join() === 'checked,failed,skippedNoCredit'
     && !JSON.stringify(r.body).includes(aTrip.id), JSON.stringify(r.body));
  ok('...an owner with no credit is still skipped', r.body.skippedNoCredit === 1, JSON.stringify(r.body));
  ok('...the watch was really checked', /\$842/.test((await call('GET', `/api/trips/${aTrip.id}/watches`, undefined, alice)).body[0].lastResult || ''));
  ok('the check was charged to the trip\'s owner', spent(ALICE) > aliceBefore, `${aliceBefore} -> ${spent(ALICE)}`);
  const usage = [...ids.entries()].filter(([k]) => k.startsWith('usage/')).map(([, v]) => v);
  ok('...its usage row names the owner and the sweep, not nobody', usage.some((u) => u.uid === ALICE && u.route === 'watch-sweep')
     && !usage.some((u) => !u.uid), JSON.stringify(usage.map((u) => [u.uid, u.route])));
  ok('...and nothing was charged to the out-of-credit owner', spent(CAROL) === 50);
  r = await cron();
  ok('a second tick an hour early checks nothing (not due)', r.status === 200 && r.body.checked === 0, JSON.stringify(r.body));

  /* ---------- 2. the self-test is the cron key's ---------- */
  const before = calls.length;
  r = await call('POST', '/api/cron/check-watches?selftest=1', undefined, bob);
  ok('?selftest=1 signed in: 401, no model call, nothing written', r.status === 401 && calls.length === before && !tp.has('control/ai-selftest'), `${r.status} ${calls.length - before}`);
  r = await cron('?selftest=1');
  ok('?selftest=1 with the key: runs and records', r.status === 200 && r.body.withSearch && r.body.withSearch.ok && tp.has('control/ai-selftest') && calls.length > before);

  /* ---------- 5. constant-time key checks ---------- */
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('no cron-key comparison with === or == is left in server.js', !/[!=]==?\s*CRON_SECRET\b|CRON_SECRET\s*[!=]==?/.test(src));
  ok('...every X-Cron-Key read goes through cronKeyOk', (src.match(/get\('X-Cron-Key'\)/g) || []).length === 1 && /function cronKeyOk[\s\S]{0,400}timingSafeEqual/.test(src));
  r = await call('POST', '/api/admin/crowd-backfill?dry=1', undefined, null, { 'X-Cron-Key': 'x' });
  ok('the backfill route: a short wrong key is refused, not thrown on', r.status === 401, r.status);
  r = await call('POST', '/api/admin/crowd-backfill?dry=1', undefined, null, { 'X-Cron-Key': 'cron-test-key' });
  ok('...and the right one still runs it', r.status === 200 && r.body.dry === true, JSON.stringify(r.body));

  /* ---------- 7. the map search: per person, and a capped line ---------- */
  const near = (cookie, q, trip) => call('GET', `/api/trips/${trip}/breweries/nearby?near=${encodeURIComponent(q)}`, undefined, cookie);
  const bTrip = (await call('POST', '/api/trips', { name: 'Bob away' }, bob)).body;
  for (let i = 0; i < 3; i++) await near(bob, 'Asheville ' + i, bTrip.id);
  r = await near(bob, 'Asheville again', bTrip.id);
  ok('a fourth search in a minute (limit 3 in this suite): 429 with a sentence', r.status === 429 && /searches/.test(r.body.error), JSON.stringify(r.body));
  r = await near(alice, 'Asheville', aTrip.id);
  ok('...someone else is not held to it', r.status === 200 && r.body.centre, r.status);
  let release;
  hold = { promise: new Promise((res) => { release = res; }) };
  const dave = await register('dave@example.com');
  const dTrip = (await call('POST', '/api/trips', { name: 'Dave away' }, dave)).body;
  const eve = await register('eve@example.com');
  const eTrip = (await call('POST', '/api/trips', { name: 'Eve away' }, eve)).body;
  const g0 = geocodes;
  const queued = [near(dave, 'Boone', dTrip.id), near(dave, 'Hendersonville', dTrip.id), near(dave, 'Brevard', dTrip.id)];
  await wait(200);
  r = await near(eve, 'Black Mountain', eTrip.id);
  ok('with the line full, another search is refused at once, in words', r.status === 503 && /busy/.test(r.body.error), `${r.status} ${JSON.stringify(r.body)}`);
  release(); hold = null;
  const done = await Promise.all(queued);
  ok('...the ones in line all finish', done.every((x) => x.status === 200), done.map((x) => x.status).join());
  ok('...and the refused one was never sent to the map', geocodes - g0 === 3, geocodes - g0);
  r = await near(eve, 'Black Mountain', eTrip.id);
  ok('...and once it drains, searching works again', r.status === 200, r.status);

  /* ---------- 3. Face ID behind an https front end ---------- */
  const origin = 'https://127.0.0.1:' + PORT;
  const https = { 'X-Forwarded-Proto': 'https' };
  const device = authenticator();
  let o = await call('POST', '/api/auth/passkey/register/options', { password: 'a-long-password-1' }, alice, https);
  ok('enrolment options (password proved) set signed challenge cookies', o.status === 200 && /pk_reg=/.test(cookiesOf(o.res)) && /pk_who=/.test(cookiesOf(o.res)), o.status);
  const challengeCookies = cookiesOf(o.res);
  r = await call('POST', '/api/auth/passkey/register/verify', device.create(o.body, origin), alice + '; ' + challengeCookies, https);
  ok('enrolment verify reads those cookies and accepts the https origin', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await call('POST', '/api/auth/passkey/register/verify', device.create(o.body, origin), alice, https);
  ok('...without the challenge cookies it is refused', r.status === 400);

  o = await call('POST', '/api/auth/passkey/login/options', {}, null, https);
  ok('sign-in options set the challenge cookie', o.status === 200 && /pk_auth=/.test(cookiesOf(o.res)), o.status);
  r = await call('POST', '/api/auth/passkey/login/verify', device.get(o.body, origin), cookiesOf(o.res), https);
  const faceId = cookiesOf(r.res);
  ok('Face ID sign-in verifies and issues a session', r.status === 200 && r.body.ok === true && /stc_session=/.test(faceId), JSON.stringify(r.body));
  const me = (await call('GET', '/api/auth/me', undefined, faceId)).body;
  ok('...a passkey-proved session for the right account', me.signedIn && me.uid === ALICE && me.via === 'passkey', JSON.stringify(me));
  o = await call('POST', '/api/auth/passkey/login/options', {}, null, https);
  r = await call('POST', '/api/auth/passkey/login/verify', device.get(o.body, 'http://127.0.0.1:' + PORT), cookiesOf(o.res), https);
  ok('...and an assertion made for plain http is not accepted over https', r.status !== 200 || r.body.ok !== true, r.status);

  /* ---------- 9. headers everywhere ---------- */
  for (const p of ['/api/health', '/api/auth/me', '/login', '/']) {
    const x = await realFetch(B + p);
    ok(`${p}: nosniff, HSTS and the frame-ancestors CSP`, x.headers.get('x-content-type-options') === 'nosniff'
       && x.headers.get('strict-transport-security') === 'max-age=31536000' && /frame-ancestors/.test(x.headers.get('content-security-policy') || ''));
  }
  // One malformed percent-escape used to be an unhandled rejection in the
  // shared identity parser, which stops a Node 22 process: the server died.
  r = await call('GET', '/api/auth/me', undefined, 'stc_session=%E0%A4%A; other=1');
  ok('a malformed cookie is ignored, not a 500', r.status === 200 && r.body.signedIn === false, r.status);
  r = await call('GET', '/api/trips', undefined, 'x=%E0%A4%A; ' + alice);
  ok('...the well-formed cookies beside it still count', r.status === 200 && Array.isArray(r.body.trips || r.body), r.status);
  await wait(100);
  r = await call('GET', '/api/health');
  ok('...and the server is still up afterwards', r.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
