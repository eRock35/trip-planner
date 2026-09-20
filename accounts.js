// Multi-user accounts for Trip Planner.
//
// Why this is a separate file from auth.js: auth.js is shared VERBATIM with
// santa-rosa-beach-trip and college-football-app, and it is deliberately
// single-account (one username, one set of passkeys, a session that just says
// "signed in"). This app needs real user identity, so it gets its own module
// rather than forking a file two other apps depend on.
//
// Access model, per Erik's call:
//   - anyone can register
//   - every logged-in user gets the free features immediately
//   - features that spend Anthropic tokens require aiAccess === 'approved',
//     which only the admin can grant. This is the whole point: a stranger
//     signing up must not be able to run Sonnet 5 on Erik's API key.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_SECONDS = 300;
const SCRYPT_KEYLEN = 64;

// --- password hashing ------------------------------------------------------
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), s, SCRYPT_KEYLEN).toString('hex');
  return { salt: s, hash: derived };
}

function passwordMatches(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const got = Buffer.from(crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex'));
  const want = Buffer.from(expectedHash);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// --- signed cookies --------------------------------------------------------
function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

function readToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 1) return null;
  const body = token.slice(0, idx);
  const got = Buffer.from(token.slice(idx + 1));
  const want = Buffer.from(sign(body, secret));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`,
  ];
  const prior = res.getHeader('Set-Cookie');
  const list = prior ? (Array.isArray(prior) ? prior.slice() : [prior]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) { setCookie(res, name, '', 0); }

// Cloud Run terminates TLS, so the scheme is always https here.
function rpInfo(req) {
  const rpID = req.hostname;
  return { rpID, origin: `https://${rpID}` };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Deterministic id from the email, so `create()` fails on a duplicate rather
// than needing a uniqueness index Firestore doesn't have.
function uidFor(email) {
  return Buffer.from(normalizeEmail(email)).toString('base64url');
}

function publicUser(uid, d) {
  return {
    id: uid,
    email: d.email,
    displayName: d.displayName || d.email,
    aiAccess: d.aiAccess || 'none',
    aiNote: d.aiNote || '',
    isAdmin: !!d.isAdmin,
    createdAt: d.createdAt || null,
    aiRequestedAt: d.aiRequestedAt || null,
    aiDecidedAt: d.aiDecidedAt || null,
  };
}

/**
 * @param opts.db            Firestore instance
 * @param opts.sessionSecret HMAC secret for session + challenge cookies
 * @param opts.rpName        label shown in the OS passkey prompt
 * @param opts.adminEmail    the one account that can approve AI access
 */
function createAccounts(opts) {
  const { db, sessionSecret, rpName, adminEmail } = opts;
  const users = () => db.collection('users');
  const creds = () => db.collection('webauthn-credentials');

  function issueSession(res, uid) {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    setCookie(res, 'session', makeToken({ sub: uid, exp }, sessionSecret), SESSION_TTL_SECONDS);
  }

  function sessionUid(req) {
    if (!sessionSecret) return null;
    const p = readToken(parseCookies(req).session, sessionSecret);
    return p ? p.sub : null;
  }

  async function loadUser(uid) {
    if (!uid) return null;
    const doc = await users().doc(uid).get();
    return doc.exists ? { uid, ...doc.data() } : null;
  }

  // Attaches req.user when a valid session cookie names a real account.
  async function attachUser(req, res, next) {
    try {
      req.user = await loadUser(sessionUid(req));
    } catch (e) {
      req.user = null;
    }
    next();
  }

  function requireLogin(req, res, next) {
    if (req.user) return next();
    if ((req.get('Accept') || '').indexOf('text/html') !== -1) return res.redirect('/login');
    return res.status(401).json({ error: 'not signed in' });
  }

  // The gate that protects Erik's API key. Everything that calls Anthropic
  // sits behind this, never behind requireLogin alone.
  function requireAiAccess(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'not signed in' });
    if (req.user.aiAccess === 'approved') return next();
    return res.status(403).json({
      error: 'AI features need approval.',
      aiAccess: req.user.aiAccess || 'none',
      hint: 'Request access from the account menu — each one is reviewed by hand.',
    });
  }

  function requireAdmin(req, res, next) {
    if (req.user && req.user.isAdmin) return next();
    return res.status(404).json({ error: 'not found' }); // don't advertise the admin surface
  }

  async function isApprovedUid(uid) {
    const u = await loadUser(uid);
    return !!(u && u.aiAccess === 'approved');
  }

  function mount(app) {
    // --- registration ------------------------------------------------------
    app.post('/api/auth/register', async (req, res) => {
      try {
        const email = normalizeEmail(req.body && req.body.email);
        const password = (req.body && req.body.password) || '';
        const displayName = ((req.body && req.body.displayName) || '').toString().slice(0, 80);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          return res.status(400).json({ error: 'Enter a valid email address.' });
        }
        if (String(password).length < 10) {
          return res.status(400).json({ error: 'Password must be at least 10 characters.' });
        }
        const uid = uidFor(email);
        const { salt, hash } = hashPassword(password);
        const isAdmin = !!adminEmail && email === normalizeEmail(adminEmail);
        const now = new Date().toISOString();
        try {
          await users().doc(uid).create({
            email,
            displayName: displayName || email.split('@')[0],
            passwordSalt: salt,
            passwordHash: hash,
            // The admin is the only account that starts approved; everyone
            // else has to ask.
            aiAccess: isAdmin ? 'approved' : 'none',
            isAdmin,
            createdAt: now,
          });
        } catch (e) {
          if (e && e.code === 6) return res.status(409).json({ error: 'That email is already registered.' });
          throw e;
        }
        issueSession(res, uid);
        const u = await loadUser(uid);
        res.json({ ok: true, user: publicUser(uid, u) });
      } catch (err) {
        console.error('POST /api/auth/register', err);
        res.status(500).json({ error: 'Could not create the account.' });
      }
    });

    app.post('/api/auth/login', async (req, res) => {
      try {
        const email = normalizeEmail(req.body && req.body.email);
        const password = (req.body && req.body.password) || '';
        const uid = uidFor(email);
        const u = await loadUser(uid);
        // Same response either way so this can't be used to enumerate accounts.
        if (!u || !passwordMatches(password, u.passwordSalt, u.passwordHash)) {
          return res.status(401).json({ error: 'Email or password is incorrect.' });
        }
        issueSession(res, uid);
        res.json({ ok: true, user: publicUser(uid, u) });
      } catch (err) {
        console.error('POST /api/auth/login', err);
        res.status(500).json({ error: 'Sign-in failed.' });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      clearCookie(res, 'session');
      res.json({ ok: true });
    });

    app.get('/api/auth/me', (req, res) => {
      if (!req.user) return res.json({ signedIn: false });
      res.json({ signedIn: true, user: publicUser(req.user.uid, req.user) });
    });

    // Does any passkey exist for this host? The login page uses this to decide
    // whether to offer Face ID at all. Deliberately says nothing about WHICH
    // account, so it leaks nothing to an anonymous caller.
    app.get('/api/auth/passkey/available', async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const snap = await creds().where('rpID', '==', rpID).limit(1).get();
        res.json({ available: !snap.empty });
      } catch (e) {
        res.json({ available: false });
      }
    });

    // --- AI access request / approval --------------------------------------
    app.post('/api/ai-access/request', requireLogin, async (req, res) => {
      try {
        if (req.user.aiAccess === 'approved') return res.json({ ok: true, aiAccess: 'approved' });
        const note = ((req.body && req.body.note) || '').toString().slice(0, 500);
        await users().doc(req.user.uid).update({
          aiAccess: 'pending',
          aiNote: note,
          aiRequestedAt: new Date().toISOString(),
        });
        res.json({ ok: true, aiAccess: 'pending' });
      } catch (err) {
        console.error('POST /api/ai-access/request', err);
        res.status(500).json({ error: 'Could not send the request.' });
      }
    });

    app.get('/api/admin/users', requireLogin, requireAdmin, async (req, res) => {
      try {
        const snap = await users().limit(500).get();
        const all = snap.docs.map((d) => publicUser(d.id, d.data()));
        const rank = { pending: 0, approved: 1, none: 2, denied: 3 };
        all.sort((a, b) => (rank[a.aiAccess] ?? 9) - (rank[b.aiAccess] ?? 9));
        res.json(all);
      } catch (err) {
        console.error('GET /api/admin/users', err);
        res.status(500).json({ error: 'Could not load users.' });
      }
    });

    app.post('/api/admin/ai-access', requireLogin, requireAdmin, async (req, res) => {
      try {
        const { userId, decision } = req.body || {};
        if (!userId || !['approved', 'denied', 'none'].includes(decision)) {
          return res.status(400).json({ error: 'userId and a valid decision are required.' });
        }
        const target = await loadUser(userId);
        if (!target) return res.status(404).json({ error: 'No such user.' });
        if (target.isAdmin && decision !== 'approved') {
          return res.status(400).json({ error: 'Cannot remove the admin account\'s own access.' });
        }
        await users().doc(userId).update({ aiAccess: decision, aiDecidedAt: new Date().toISOString() });
        res.json({ ok: true });
      } catch (err) {
        console.error('POST /api/admin/ai-access', err);
        res.status(500).json({ error: 'Could not save that decision.' });
      }
    });

    // --- passkeys, scoped to the signed-in account -------------------------
    // Enrolment requires an existing session: you register with a password
    // first, then add Face ID. A passkey is an credential for ONE account, so
    // it carries the userId it was minted for.
    app.post('/api/auth/passkey/register/options', requireLogin, async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const existing = await creds().where('userId', '==', req.user.uid).get();
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName: req.user.email,
          userDisplayName: req.user.displayName || req.user.email,
          attestationType: 'none',
          excludeCredentials: existing.docs
            .map((d) => d.data())
            .filter((c) => c.rpID === rpID)
            .map((c) => ({ id: c.credId, transports: c.transports || undefined })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        });
        const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
        setCookie(res, 'reg_challenge', makeToken({ c: options.challenge, exp }, sessionSecret), CHALLENGE_TTL_SECONDS);
        res.json(options);
      } catch (err) {
        console.error('passkey register/options', err);
        res.status(500).json({ error: 'Could not start passkey setup.' });
      }
    });

    app.post('/api/auth/passkey/register/verify', requireLogin, async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req);
        const stashed = readToken(parseCookies(req).reg_challenge, sessionSecret);
        if (!stashed) return res.status(400).json({ error: 'Setup expired — try again.' });
        const verification = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: stashed.c,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });
        if (!verification.verified) return res.status(400).json({ error: 'Passkey could not be verified.' });
        const cred = verification.registrationInfo.credential;
        await creds().doc(cred.id).set({
          credId: cred.id,
          userId: req.user.uid,
          publicKey: Buffer.from(cred.publicKey).toString('base64'),
          counter: cred.counter,
          transports: cred.transports || [],
          rpID,
          createdAt: new Date().toISOString(),
        });
        clearCookie(res, 'reg_challenge');
        res.json({ ok: true });
      } catch (err) {
        console.error('passkey register/verify', err);
        res.status(500).json({ error: 'Passkey setup failed.' });
      }
    });

    // Sign-in by passkey. The credential itself identifies the account, so no
    // email is needed up front.
    app.post('/api/auth/passkey/login/options', async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const snap = await creds().where('rpID', '==', rpID).get();
        if (snap.empty) return res.status(404).json({ error: 'No passkey registered on this device yet.' });
        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: snap.docs.map((d) => ({ id: d.data().credId, transports: d.data().transports || undefined })),
          userVerification: 'preferred',
        });
        const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
        setCookie(res, 'auth_challenge', makeToken({ c: options.challenge, exp }, sessionSecret), CHALLENGE_TTL_SECONDS);
        res.json(options);
      } catch (err) {
        console.error('passkey login/options', err);
        res.status(500).json({ error: 'Could not start passkey sign-in.' });
      }
    });

    app.post('/api/auth/passkey/login/verify', async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req);
        const stashed = readToken(parseCookies(req).auth_challenge, sessionSecret);
        if (!stashed) return res.status(400).json({ error: 'Sign-in expired — try again.' });
        const id = req.body && req.body.id;
        if (!id) return res.status(400).json({ error: 'Malformed passkey response.' });
        const doc = await creds().doc(id).get();
        if (!doc.exists) return res.status(404).json({ error: 'Unknown passkey.' });
        const stored = doc.data();
        const verification = await verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: stashed.c,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id,
            publicKey: Buffer.from(stored.publicKey, 'base64'),
            counter: stored.counter || 0,
            transports: stored.transports || undefined,
          },
        });
        if (!verification.verified) return res.status(401).json({ error: 'Passkey rejected.' });
        const newCounter = verification.authenticationInfo.newCounter;
        // Synced passkeys often report 0 forever, so only persist real increases.
        if (typeof newCounter === 'number' && newCounter > (stored.counter || 0)) {
          await doc.ref.update({ counter: newCounter, lastUsedAt: new Date().toISOString() });
        } else {
          await doc.ref.update({ lastUsedAt: new Date().toISOString() });
        }
        clearCookie(res, 'auth_challenge');
        issueSession(res, stored.userId);
        const u = await loadUser(stored.userId);
        if (!u) return res.status(401).json({ error: 'That passkey\'s account no longer exists.' });
        res.json({ ok: true, user: publicUser(stored.userId, u) });
      } catch (err) {
        console.error('passkey login/verify', err);
        res.status(500).json({ error: 'Passkey sign-in failed.' });
      }
    });
  }

  return { mount, attachUser, requireLogin, requireAiAccess, requireAdmin, isApprovedUid, publicUser };
}

module.exports = { createAccounts };
