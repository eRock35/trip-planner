const h = require('./harness.js');
h.install();
const crypto = require('crypto');
const SECRET = 'identity-secret-abcdefghijklmn';
Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: SECRET, SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity',
  GOOGLE_CLOUD_PROJECT: 'test', ADMIN_EMAIL: 'strongtechnicalconsulting@gmail.com',
  ANTHROPIC_API_KEY: 'k', PORT: '9211',
});

// A stand-in, not a real person: this repo is public, and a fixture does not
// need to publish someone's actual address to prove the migration works.
const email = 'migrated-user@example.com';
const uid = Buffer.from(email).toString('base64url');
const password = 'whatever-they-chose';
const salt = crypto.randomBytes(16).toString('hex');
const hexHash = crypto.scryptSync(password, salt, 64).toString('hex');

// The app's own record, untouched by the migration
h.bag('trip-planner').set('users/' + uid, {
  email, passwordSalt: salt, passwordHash: hexHash,
  aiAccess: 'pending', isAdmin: false, aiRequestedAt: '2026-09-20T19:39:58Z',
});
h.bag('trip-planner').set('trips/t1', { ownerId: uid, name: 'Jamaica', destination: 'Montego Bay', status: 'planning' });
// The identity record exactly as the migration writes it: hex converted to base64
h.bag('identity').set('users/' + uid, {
  email, password: { salt, hash: Buffer.from(hexHash, 'hex').toString('base64') },
  createdAt: '2026-09-20T19:37:00Z', createdBy: 'trip-planner', migratedAt: '2026-09-20',
});

require(require('path').join(__dirname, '..', 'server.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  let r = await fetch('http://127.0.0.1:9211/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email, password }) });
  ok('a migrated user signs in with their ORIGINAL password', r.status === 200, String(r.status));
  const cookie = (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');

  r = await fetch('http://127.0.0.1:9211/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'wrong' }) });
  ok('a wrong password is still refused', r.status === 401);

  r = await fetch('http://127.0.0.1:9211/api/auth/me', { headers: { cookie } });
  const me = await r.json();
  ok('their pending AI request survived the migration', me.aiAccess === 'pending', JSON.stringify(me));
  ok('they are not accidentally an admin', me.isAdmin === false);

  r = await fetch('http://127.0.0.1:9211/api/trips', { headers: { cookie } });
  const trips = await r.json();
  ok('their trip is still theirs', JSON.stringify(trips).includes('Jamaica'), JSON.stringify(trips).slice(0, 120));

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})();
