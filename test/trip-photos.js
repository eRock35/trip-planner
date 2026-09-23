// Memories: trip photos in a private bucket, served only through the app to
// the trip's owner. Cloud Storage and the metadata server are faked at
// global.fetch, where photostore.js reaches them.
const h = require('./harness.js');
h.install();

const BUCKET = 'test-trip-photos';
const objects = new Map();          // name -> { buffer, contentType }
let failPut = null;                 // a name pattern whose upload should fail
let storageCalls = 0; let badAuth = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  if (/nominatim|met\.no/.test(u)) return new Response('[]', { status: 200 });
  if (u.startsWith('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token')) {
    return json({ access_token: 'runtime-token', expires_in: 3600 });
  }
  if (u.startsWith('https://storage.googleapis.com/')) {
    storageCalls++;
    if ((opts.headers || {}).Authorization !== 'Bearer runtime-token') badAuth++;
    const method = opts.method || 'GET';
    let m = /\/upload\/storage\/v1\/b\/([^/]+)\/o\?uploadType=media&name=([^&]+)$/.exec(u);
    if (m && method === 'POST') {
      const name = decodeURIComponent(m[2]);
      if (m[1] !== BUCKET) return json({ error: 'no bucket' }, 404);
      if (failPut && failPut.test(name)) return json({ error: 'boom' }, 503);
      objects.set(name, { buffer: Buffer.from(opts.body), contentType: opts.headers['Content-Type'] });
      return json({ name });
    }
    m = /\/storage\/v1\/b\/([^/]+)\/o\?prefix=([^&]+)&/.exec(u);
    if (m) {
      const prefix = decodeURIComponent(m[2]);
      return json({ items: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) });
    }
    m = /\/storage\/v1\/b\/([^/]+)\/o\/([^?]+)(\?alt=media)?$/.exec(u);
    if (m) {
      const name = decodeURIComponent(m[2]);
      if (method === 'DELETE') { const had = objects.delete(name); return new Response(had ? null : '{}', { status: had ? 204 : 404 }); }
      const o = objects.get(name);
      if (!o) return json({ error: 'not found' }, 404);
      return new Response(o.buffer, { status: 200, headers: { 'content-type': o.contentType } });
    }
    return json({ error: 'unexpected ' + method + ' ' + u }, 400);
  }
  return realFetch(url, opts);
};
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9225',
  PHOTOS_BUCKET: BUCKET,
});
require(require('path').join(__dirname, '..', 'server.js'));
const B = 'http://127.0.0.1:9225';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };

const jpegBytes = (n, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, fill)]);
const pngBytes = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 1)]);
const photo = (over = {}) => Object.assign({
  full: jpegBytes(300 * 1024).toString('base64'),      // over the 100 KB default on purpose
  thumb: jpegBytes(20 * 1024, 3).toString('base64'),
  takenAt: '2026-09-24T18:32:05', width: 2048, height: 1536, caption: 'Sunset <b>at</b> the pier',
}, over);

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const register = async (email) => (await realFetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }))
    .headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const me = await register('traveller@example.com');
  const other = await register('stranger@example.com');
  const call = async (method, p, b, c = me) => {
    const r = await realFetch(B + p, { method, headers: { ...J, cookie: c || '' }, body: b === undefined ? undefined : JSON.stringify(b) });
    const text = await r.text();
    let body = {}; try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
    return { status: r.status, body };
  };
  const raw = (p, c = me) => realFetch(B + p, { headers: { cookie: c || '' } });
  const trip = (await call('POST', '/api/trips', { name: 'Beach', destination: 'Santa Rosa Beach, FL', dateRange: 'Sep 22-27, 2026' })).body;
  const T = '/api/trips/' + trip.id;
  const under = (tripId) => [...objects.keys()].filter((k) => k.startsWith(`trips/${tripId}/`));
  const records = (tripId) => [...h.bag('sub').keys()].filter((k) => k.startsWith(`trips/${tripId}/photos/`));

  /* ---------- nothing yet ---------- */
  let r = await call('GET', T + '/photos');
  ok('a new trip has no photos, and storage is available', r.status === 200 && r.body.available === true && r.body.photos.length === 0, JSON.stringify(r.body));

  /* ---------- upload ---------- */
  const sent = photo();
  r = await call('POST', T + '/photos', sent);
  const p1 = r.body.photo || {};
  ok('a photo uploads', r.status === 200 && /^[a-f0-9]{24}$/.test(p1.id || ''), JSON.stringify(r.body).slice(0, 160));
  ok('...as two objects in the bucket, full and thumbnail, under the trip',
     under(trip.id).length === 2 && objects.has(`trips/${trip.id}/${p1.id}.jpg`) && objects.has(`trips/${trip.id}/${p1.id}-thumb.jpg`), under(trip.id).join(', '));
  ok('...the bytes stored exactly, typed by their content', objects.get(`trips/${trip.id}/${p1.id}.jpg`).buffer.equals(Buffer.from(sent.full, 'base64'))
     && objects.get(`trips/${trip.id}/${p1.id}.jpg`).contentType === 'image/jpeg');
  ok('...with the runtime identity, never a key', badAuth === 0);
  ok('...and one record', records(trip.id).length === 1);
  const rec = h.bag('sub').get(`trips/${trip.id}/photos/${p1.id}`) || {};
  ok('...holding when it was taken, the caption without markup, size, who and when',
     rec.takenAt === '2026-09-24T18:32:05' && rec.caption === 'Sunset bat/b the pier' && rec.width === 2048 && rec.height === 1536
     && rec.bytes === Buffer.from(sent.full, 'base64').length && rec.uploadedBy === Buffer.from('traveller@example.com').toString('base64url')
     && !Number.isNaN(Date.parse(rec.uploadedAt)) && typeof rec.order === 'number', JSON.stringify(rec));

  r = await call('POST', T + '/photos', photo({ full: pngBytes(4000).toString('base64'), takenAt: 'yesterday-ish', width: -3, height: 'tall', caption: '' }));
  const p2 = r.body.photo || {};
  ok('a PNG with no usable date or size is still a photo', r.status === 200 && p2.takenAt === null && p2.width === null && p2.height === null, JSON.stringify(r.body));
  ok('...stored as what it is', objects.get(`trips/${trip.id}/${p2.id}.jpg`).contentType === 'image/png');

  /* ---------- list ---------- */
  r = await call('GET', T + '/photos');
  ok('the list has both', r.status === 200 && r.body.available && r.body.photos.length === 2, JSON.stringify(r.body).slice(0, 200));
  ok('...each with id, time, caption and size', ['id', 'takenAt', 'caption', 'width', 'height', 'uploadedAt'].every((k) => k in r.body.photos[0]));
  ok('...and no storage path or link: the page builds its own URLs', !/trips\/|storage\.googleapis|http/.test(JSON.stringify(r.body)), JSON.stringify(r.body));

  /* ---------- the bytes, through the app ---------- */
  let res = await raw(`${T}/photos/${p1.id}/thumb`);
  let buf = Buffer.from(await res.arrayBuffer());
  ok('the thumbnail is served', res.status === 200 && buf.equals(Buffer.from(sent.thumb, 'base64')));
  ok('...as an image, cached privately for good, never sniffed',
     res.headers.get('content-type') === 'image/jpeg' && res.headers.get('cache-control') === 'private, max-age=31536000, immutable'
     && res.headers.get('x-content-type-options') === 'nosniff', [...res.headers].map((x) => x.join(': ')).join(' | '));
  res = await raw(`${T}/photos/${p1.id}/full`);
  buf = Buffer.from(await res.arrayBuffer());
  ok('the full photo is served the same way', res.status === 200 && buf.equals(Buffer.from(sent.full, 'base64'))
     && res.headers.get('cache-control') === 'private, max-age=31536000, immutable' && res.headers.get('x-content-type-options') === 'nosniff');
  res = await raw(`${T}/photos/${p2.id}/full`);
  ok('...with its own type', res.headers.get('content-type') === 'image/png');
  ok('a photo that does not exist is a 404', (await raw(`${T}/photos/${'0'.repeat(24)}/thumb`)).status === 404);
  const before = storageCalls;
  ok('...and a malformed id is a 404 that never reaches storage',
     (await raw(`${T}/photos/..%2F..%2Fother/full`)).status === 404 && (await raw(`${T}/photos/ABC/thumb`)).status === 404 && storageCalls === before);

  /* ---------- caption ---------- */
  r = await call('PATCH', `${T}/photos/${p1.id}`, { caption: '  The <script>pier</script>, golden hour  ' });
  ok('a caption is edited, cleaned', r.status === 200 && r.body.photo.caption === 'The scriptpier/script, golden hour', JSON.stringify(r.body));
  ok('...and the list shows it', (await call('GET', T + '/photos')).body.photos.find((p) => p.id === p1.id).caption === 'The scriptpier/script, golden hour');
  ok('...a caption for a photo that is not there is a 404', (await call('PATCH', `${T}/photos/${'a'.repeat(24)}`, { caption: 'x' })).status === 404);

  /* ---------- refusals ---------- */
  const n0 = objects.size;
  r = await call('POST', T + '/photos', photo({ full: Buffer.from('%PDF-1.7 definitely not a photo at all').toString('base64') }));
  ok('a file that is not an image is refused, by its bytes', r.status === 400 && /not a photo/.test(r.body.error), JSON.stringify(r.body));
  r = await call('POST', T + '/photos', photo({ thumb: undefined }));
  ok('...a photo without its thumbnail is refused', r.status === 400);
  r = await call('POST', T + '/photos', photo({ thumb: jpegBytes(700 * 1024).toString('base64') }));
  ok('...and a "thumbnail" the size of a photo is refused', r.status === 400 && /too large/.test(r.body.error), JSON.stringify(r.body));
  ok('...none of them stored anything', objects.size === n0 && records(trip.id).length === 2);

  r = await call('POST', T + '/photos', { full: jpegBytes(13 * 1024 * 1024).toString('base64'), thumb: jpegBytes(10).toString('base64') });
  ok('a body over the route’s ceiling is a JSON 413', r.status === 413 && r.body.error, String(r.status));

  failPut = /-thumb\.jpg$/;
  r = await call('POST', T + '/photos', photo());
  failPut = null;
  ok('storage failing halfway is a 502 ...', r.status === 502, String(r.status));
  ok('...and leaves nothing behind: no half photo, no record', objects.size === n0 && records(trip.id).length === 2, `${objects.size} vs ${n0}`);

  /* ---------- other people ---------- */
  const s0 = storageCalls;
  const theirs = await Promise.all([
    call('GET', T + '/photos', undefined, other),
    call('POST', T + '/photos', photo(), other),
    raw(`${T}/photos/${p1.id}/thumb`, other),
    raw(`${T}/photos/${p1.id}/full`, other),
    call('PATCH', `${T}/photos/${p1.id}`, { caption: 'mine now' }, other),
    call('DELETE', `${T}/photos/${p1.id}`, undefined, other),
  ]);
  ok("someone else gets a 404 on every photo route, the images included", theirs.every((x) => x.status === 404), theirs.map((x) => x.status).join(','));
  ok('...without the request ever reaching storage', storageCalls === s0);
  ok('...and nothing of mine changed', objects.has(`trips/${trip.id}/${p1.id}.jpg`) && (await call('GET', T + '/photos')).body.photos.find((p) => p.id === p1.id).caption !== 'mine now');
  const out = await Promise.all([call('GET', T + '/photos', undefined, ''), raw(`${T}/photos/${p1.id}/thumb`, '')]);
  ok('signed out: 401, the images included', out.every((x) => x.status === 401), out.map((x) => x.status).join(','));

  /* ---------- the example trip ---------- */
  r = await call('GET', '/api/trips/demo/photos', undefined, '');
  ok('the example trip lists no photos, and says it is the example', r.status === 200 && r.body.available === true && r.body.photos.length === 0 && r.body.demo === true);
  r = await call('POST', '/api/trips/demo/photos', photo());
  ok('...and cannot be added to', r.status === 403);

  /* ---------- delete ---------- */
  r = await call('DELETE', `${T}/photos/${p2.id}`);
  ok('a photo is deleted', r.status === 200);
  ok('...both objects gone', !objects.has(`trips/${trip.id}/${p2.id}.jpg`) && !objects.has(`trips/${trip.id}/${p2.id}-thumb.jpg`));
  ok('...its record gone', !h.bag('sub').has(`trips/${trip.id}/photos/${p2.id}`));
  ok('...and it is no longer served or listed', (await raw(`${T}/photos/${p2.id}/thumb`)).status === 404 && (await call('GET', T + '/photos')).body.photos.length === 1);
  ok('...deleting it again is a 404', (await call('DELETE', `${T}/photos/${p2.id}`)).status === 404);

  /* ---------- a trip holds 500 ---------- */
  const full = (await call('POST', '/api/trips', { name: 'Many' })).body;
  for (let i = 0; i < 500; i++) h.bag('sub').set(`trips/${full.id}/photos/p${String(i).padStart(23, '0')}`, { caption: '', uploadedAt: '2026-09-24T00:00:00Z' });
  r = await call('POST', `/api/trips/${full.id}/photos`, photo());
  ok('the 501st photo is refused, saying why', r.status === 400 && /500 photos/.test(r.body.error), JSON.stringify(r.body));

  /* ---------- deleting the trip takes its photos ---------- */
  const doomed = (await call('POST', '/api/trips', { name: 'Doomed' })).body;
  const D = '/api/trips/' + doomed.id;
  await call('POST', D + '/photos', photo());
  await call('POST', D + '/photos', photo({ takenAt: null }));
  ok('(a second trip with two photos)', under(doomed.id).length === 4 && records(doomed.id).length === 2);
  r = await call('DELETE', D);
  ok('deleting a trip succeeds', r.status === 200);
  ok('...and removes its photos from the bucket', under(doomed.id).length === 0, under(doomed.id).join(', '));
  ok('...and their records', records(doomed.id).length === 0);
  ok("...and leaves every other trip's photos alone", objects.has(`trips/${trip.id}/${p1.id}.jpg`) && records(trip.id).length === 1);

  /* ---------- no bucket configured ---------- */
  delete process.env.PHOTOS_BUCKET;
  r = await call('GET', T + '/photos');
  ok('without a bucket the list says photos are unavailable', r.status === 200 && r.body.available === false && r.body.photos.length === 0, JSON.stringify(r.body));
  r = await call('POST', T + '/photos', photo());
  ok('...and an upload is a 503 that says so', r.status === 503 && r.body.unavailable === true, JSON.stringify(r.body));
  ok('...as are the images', (await raw(`${T}/photos/${p1.id}/thumb`)).status === 503);
  const undeleted = (await call('POST', '/api/trips', { name: 'Gone anyway' })).body;
  ok('...and deleting a trip still works', (await call('DELETE', '/api/trips/' + undeleted.id)).status === 200);
  process.env.PHOTOS_BUCKET = BUCKET;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
