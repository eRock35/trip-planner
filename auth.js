// Passkey (WebAuthn) auth, with the password kept as a fallback.
//
// Two things worth knowing before changing anything here:
//
// 1. The RP ID is derived from the request's own hostname rather than
//    hardcoded. A passkey is bound to the domain it was registered on. This
//    app currently lives only at its *.run.app URL, but deriving the RP ID
//    means it keeps working if that ever changes, instead of silently
//    locking everyone out.
// 2. Registering a passkey REQUIRES the password first. Otherwise anyone who
//    found the URL could enrol their own passkey and walk in.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days - it's a personal app
const CHALLENGE_TTL_SECONDS = 300;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

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
  // Constant-time compare; timingSafeEqual throws on length mismatch.
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
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  const prior = res.getHeader('Set-Cookie');
  const list = prior ? (Array.isArray(prior) ? prior.slice() : [prior]) : [];
  list.push(bits.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) {
  setCookie(res, name, '', 0);
}

// Cloud Run terminates TLS, so the scheme is always https here.
function rpInfo(req) {
  const rpID = req.hostname;
  return { rpID, origin: `https://${rpID}` };
}

/**
 * @param opts.db           Firestore instance
 * @param opts.collection   collection holding credentials
 * @param opts.rpName       display name shown in the OS prompt
 * @param opts.sessionSecret HMAC secret for session + challenge cookies
 * @param opts.userName     label for the single account this app has
 * @param opts.passwordGate express middleware enforcing the password
 */
function createPasskeyAuth(opts) {
  const { db, collection, rpName, sessionSecret, userName, passwordGate } = opts;
  // The verify step can't carry the password - its body is the WebAuthn
  // credential. The options step already demanded the password, and the
  // signed 5-minute challenge cookie proves this is the same flow, so verify
  // can accept a looser gate where an app needs one.
  const verifyGate = opts.verifyGate || passwordGate;

  function hasSession(req) {
    if (!sessionSecret) return false;
    return !!readToken(parseCookies(req).session, sessionSecret);
  }

  function issueSession(res) {
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    setCookie(res, 'session', makeToken({ sub: userName, exp }, sessionSecret), SESSION_TTL_SECONDS);
  }

  async function listCredentials() {
    const snap = await db.collection(collection).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  function mount(app) {
    // --- registration (password required) ---
    app.post('/api/auth/passkey/register/options', passwordGate, async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const existing = await listCredentials();
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName,
          userDisplayName: userName,
          attestationType: 'none',
          excludeCredentials: existing
            .filter((c) => c.rpID === rpID)
            .map((c) => ({ id: c.id, transports: c.transports || undefined })),
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred', // Face ID / Touch ID when available
          },
        });
        const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
        setCookie(res, 'reg_challenge', makeToken({ c: options.challenge, exp }, sessionSecret), CHALLENGE_TTL_SECONDS);
        res.json(options);
      } catch (err) {
        console.error('passkey register/options', err);
        res.status(500).json({ error: 'Could not start passkey registration.' });
      }
    });

    app.post('/api/auth/passkey/register/verify', verifyGate, async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req);
        const stashed = readToken(parseCookies(req).reg_challenge, sessionSecret);
        if (!stashed) return res.status(400).json({ error: 'Registration expired — try again.' });

        const verification = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: stashed.c,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });
        if (!verification.verified) return res.status(400).json({ error: 'Passkey could not be verified.' });

        const cred = verification.registrationInfo.credential;
        await db.collection(collection).doc(cred.id).set({
          publicKey: Buffer.from(cred.publicKey).toString('base64'),
          counter: cred.counter,
          transports: cred.transports || [],
          rpID,
          label: (req.body && req.body.label) || 'Passkey',
          createdAt: new Date().toISOString(),
        });

        clearCookie(res, 'reg_challenge');
        issueSession(res);
        res.json({ ok: true });
      } catch (err) {
        console.error('passkey register/verify', err);
        res.status(500).json({ error: 'Passkey registration failed.' });
      }
    });

    // --- login (no password - that's the point) ---
    app.post('/api/auth/passkey/login/options', async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const creds = (await listCredentials()).filter((c) => c.rpID === rpID);
        if (!creds.length) return res.status(404).json({ error: 'No passkey registered on this domain yet.' });

        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports || undefined })),
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
        const doc = await db.collection(collection).doc(id).get();
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

        // Counter guards against cloned authenticators. Synced passkeys often
        // report 0 throughout, so only persist genuine increases.
        const newCounter = verification.authenticationInfo.newCounter;
        if (typeof newCounter === 'number' && newCounter > (stored.counter || 0)) {
          await doc.ref.update({ counter: newCounter, lastUsedAt: new Date().toISOString() });
        } else {
          await doc.ref.update({ lastUsedAt: new Date().toISOString() });
        }

        clearCookie(res, 'auth_challenge');
        issueSession(res);
        res.json({ ok: true });
      } catch (err) {
        console.error('passkey login/verify', err);
        res.status(500).json({ error: 'Passkey sign-in failed.' });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      clearCookie(res, 'session');
      res.json({ ok: true });
    });

    app.get('/api/auth/status', async (req, res) => {
      const { rpID } = rpInfo(req);
      let registered = false;
      try {
        registered = (await listCredentials()).some((c) => c.rpID === rpID);
      } catch (e) { /* treat as none */ }
      res.json({ signedIn: hasSession(req), passkeyRegistered: registered });
    });
  }

  return { mount, hasSession, issueSession };
}

module.exports = { createPasskeyAuth, parseCookies };
