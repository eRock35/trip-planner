// Does a user who registered BEFORE the identity switch still get in?
const h = require('./harness.js');
h.install();
const crypto = require('crypto');
const SECRET = 'identity-secret-abcdefghijklmn';
process.env.IDENTITY_SESSION_SECRET = SECRET;
process.env.SESSION_SECRET = 'trip-secret-abcdefghijklmnop';
process.env.FIRESTORE_DATABASE_ID = 'trip-planner';
process.env.IDENTITY_DATABASE_ID = 'identity';
process.env.GOOGLE_CLOUD_PROJECT = 'test';
process.env.ADMIN_EMAIL = 'boss@example.com';
process.env.ANTHROPIC_API_KEY = 'k';
process.env.PORT = '9210';

// A legacy account exactly as production stores one: hex scrypt, in the app's
// own database, with NOTHING in identity.
const uid = Buffer.from('legacy@example.com').toString('base64url');
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('their-real-password', salt, 64).toString('hex');
h.bag('trip-planner').set('users/' + uid, {
  email: 'legacy@example.com', passwordSalt: salt, passwordHash: hash,
  aiAccess: 'approved', isAdmin: false, createdAt: '2026-09-20T19:23:49Z',
});
h.bag('trip-planner').set('trips/t1', { ownerId: uid, name: 'Jamaica', destination: 'Montego Bay' });

require(require('path').join(__dirname, '..', 'server.js'));

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const r = await fetch('http://127.0.0.1:9210/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'legacy@example.com', password: 'their-real-password' }),
  });
  const body = await r.json().catch(() => ({}));
  console.log('  legacy sign-in ->', r.status, JSON.stringify(body));
  console.log(r.status === 200
    ? '  OK: the existing password still works.'
    : '  REGRESSION CONFIRMED: a user who registered before the switch cannot sign in.');
  process.exit(0);
})();
