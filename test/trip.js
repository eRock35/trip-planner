const h = require('./harness.js');
h.install();
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'trip-secret-abcdefghijklmnop';
process.env.FIRESTORE_DATABASE_ID = 'trip-planner';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.PORT = '9203';
require(require('path').join(__dirname, '..', 'server.js'));

const B = 'http://127.0.0.1:9203';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const post = (p, b, c) => fetch(B + p, { method: 'POST', headers: c ? { ...J, cookie: c } : J, body: JSON.stringify(b) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const uidOf = (e) => Buffer.from(e.toLowerCase()).toString('base64url');

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  let r = await post('/api/auth/register', { email: 'boss@example.com', password: 'a-long-password-1' });
  ok('the admin registers at the existing URL', r.status === 200, String(r.status));
  const admin = jar(r);
  r = await post('/api/auth/register', { email: 'guest@example.com', password: 'a-long-password-2' });
  const guest = jar(r);
  ok('a second account registers', r.status === 200);

  r = await fetch(B + '/api/auth/me', { headers: { cookie: admin } });
  let me = await r.json();
  ok('/api/auth/me still reports aiAccess and isAdmin', me.aiAccess !== undefined && me.isAdmin === true, JSON.stringify(me));
  ok('the ADMIN_EMAIL account is auto-approved for AI', me.aiAccess === 'approved', me.aiAccess);
  r = await fetch(B + '/api/auth/me', { headers: { cookie: guest } });
  me = await r.json();
  ok('an ordinary account is NOT auto-approved', me.aiAccess === 'none' && me.isAdmin === false, JSON.stringify(me));
  ok('me still reports uid for the page', me.uid === uidOf('guest@example.com'), me.uid);

  // trips: ownership is the thing that must not break
  r = await post('/api/trips', { name: 'Iceland', destination: 'Reykjavik' }, guest);
  ok('a signed-in user can create a trip', r.status === 200 || r.status === 201, String(r.status));
  const trips = [...h.bag('trip-planner').entries()].filter(([k]) => k.startsWith('trips/')).map(([, v]) => v);
  ok('the trip is owned by the identity uid', trips.length === 1 && trips[0].ownerId === uidOf('guest@example.com'), JSON.stringify(trips.map((t) => t.ownerId)));

  r = await fetch(B + '/api/trips', { headers: { cookie: guest } });
  const mine = await r.json();
  ok('the owner sees it', JSON.stringify(mine).includes('Iceland'));
  r = await fetch(B + '/api/trips', { headers: { cookie: admin } });
  ok('another account does NOT see it', !JSON.stringify(await r.json()).includes('Iceland'));
  r = await fetch(B + '/api/trips');
  ok('anonymous is refused', r.status === 401 || r.status === 302, String(r.status));

  // a session from a sibling app works here
  r = await fetch(B + '/api/trips', { headers: { cookie: h.session(SECRET, 'guest@example.com') } });
  ok('a session from a SIBLING app is accepted', r.status === 200, String(r.status));

  // the AI gate is still separate from being signed in
  r = await post('/api/trips/nonexistent/chat', { question: 'hi' }, guest);
  ok('an unapproved account cannot spend tokens', r.status === 403, String(r.status));

  // admin reset writes to identity, where the password now lives
  r = await post('/api/auth/reset-request', { email: 'guest@example.com' });
  ok('reset-request answers ok', r.status === 200);
  r = await post('/api/auth/reset-request', { email: 'nobody@example.com' });
  ok('and answers identically for an unknown address', r.status === 200);
  const flagged = h.bag('trip-planner').get('users/' + uidOf('guest@example.com'));
  ok('the request is flagged on this app\'s record', Boolean(flagged && flagged.resetRequestedAt));

  r = await post('/api/admin/reset-password', { userId: uidOf('guest@example.com') }, admin);
  const out = await r.json();
  ok('the admin can issue a temporary password', r.status === 200 && out.password, JSON.stringify(out).slice(0, 80));
  r = await post('/api/auth/login', { email: 'guest@example.com', password: out.password });
  ok('the temporary password actually signs in (it went to identity)', r.status === 200, String(r.status));
  r = await post('/api/auth/login', { email: 'guest@example.com', password: 'a-long-password-2' });
  ok('the old password no longer works', r.status === 401);
  r = await post('/api/admin/reset-password', { userId: uidOf('guest@example.com') }, guest);
  ok('a non-admin cannot reset anyone', r.status === 403 || r.status === 404, String(r.status));

  r = await fetch(B + '/analytics.js');
  ok('/analytics.js is still ungated', r.status === 200);

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
