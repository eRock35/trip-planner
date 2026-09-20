// Face ID / Touch ID, as one module several apps can mount.
//
// COPY, NOT A PACKAGE. There is no shared npm package across these repos, so
// this file is copied into each app that needs it. If you fix something here,
// the header in each copy says where the others are. The alternative -
// publishing a package for six small apps - is worse.
//
// It deliberately does NOT own sessions. Each app already has its own idea of
// what a session is (a signed cookie here, a uid cookie there, an admin
// marker somewhere else), and a module that imposed a fourth would leave two
// systems disagreeing about who is signed in. The host passes issueSession
// and readSession in, and this module only ever answers "this credential
// belongs to this owner".
//
// ownerId is whatever the host calls an account: a uid for a multi-user app,
// the literal 'site' for one with a single shared login.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const COLLECTION = 'webauthn-credentials';
const CHALLENGE_TTL = 300; // five minutes is plenty for a Face ID prompt

/* ---------- signed challenge cookies, self-contained ---------- */

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeChallenge(challenge, secret) {
  const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL;
  const body = `${challenge}.${exp}`;
  return `${Buffer.from(body).toString('base64url')}.${sign(body, secret)}`;
}

function readChallenge(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const i = token.lastIndexOf('.');
  const body = Buffer.from(token.slice(0, i), 'base64url').toString();
  const mac = token.slice(i + 1);
  const expected = sign(body, secret);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const cut = body.lastIndexOf('.');
  const challenge = body.slice(0, cut);
  const exp = Number(body.slice(cut + 1));
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  return challenge;
}

function setCookie(res, name, value, maxAge) {
  res.cookie(name, value, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: maxAge * 1000,
  });
}

/* ---------- rp identity ---------- */

// A passkey is scoped to its rpID. Using the registrable domain rather than
// the exact hostname means one enrolment covers the apex and every subdomain
// the app answers on, instead of needing one per hostname. WebAuthn permits
// an rpID that is a registrable suffix of the origin's domain.
function rpInfo(req, baseDomain) {
  const host = req.hostname;
  const base = String(baseDomain || '').trim();
  const rpID = base && (host === base || host.endsWith('.' + base)) ? base : host;
  // The origin must match what the browser saw, port and all. Derived from
  // the request rather than hardcoded to https so this is testable locally;
  // `trust proxy` makes req.protocol read X-Forwarded-Proto on Cloud Run.
  return { rpID, origin: `${req.protocol}://${req.get('host')}` };
}

/**
 * @param opts.store          { get, set, list, remove } over a collection
 * @param opts.secret         () => string, for signing challenge cookies
 * @param opts.rpName         name shown in the OS prompt
 * @param opts.baseDomain     registrable domain, or '' to use the hostname
 * @param opts.issueSession   (res, ownerId, req) => void   -- req is passed so a
 *                            host that scopes its cookie to a parent domain can
 *                            read the hostname; hosts that don't need it ignore it
 * @param opts.currentOwner   (req) => ownerId | null
 * @param opts.canEnrol       async (req) => ownerId | null   -- proves identity
 * @param opts.mountPath      route prefix, default '/api/auth/passkey'
 */
function create(opts) {
  const {
    store, secret, rpName, baseDomain = '',
    issueSession, currentOwner, canEnrol,
    mountPath = '/api/auth/passkey',
  } = opts;

  const list = () => store.list(COLLECTION);

  async function forOwnerAndRp(ownerId, rpID) {
    const all = await list();
    return all.filter((c) => c.rpID === rpID && (ownerId ? c.ownerId === ownerId : true));
  }

  function mount(app) {
    // Whether to offer the button at all. Open by design: it reveals only
    // that a passkey exists, which the button itself would anyway.
    app.get(`${mountPath}/status`, async (req, res) => {
      const { rpID } = rpInfo(req, baseDomain);
      let registered = false;
      try {
        registered = (await list()).some((c) => c.rpID === rpID);
      } catch (e) { /* treat as none rather than breaking the login page */ }
      res.json({ registered, rpID });
    });

    // Enrolling proves identity through canEnrol - a password, typically.
    // A session alone is not enough: a borrowed one could otherwise leave
    // itself permanent access that outlives the session it came from.
    app.post(`${mountPath}/register/options`, async (req, res) => {
      try {
        const ownerId = await canEnrol(req);
        if (!ownerId) return res.status(401).json({ error: 'That did not prove who you are.' });
        const { rpID } = rpInfo(req, baseDomain);
        const existing = await forOwnerAndRp(ownerId, rpID);
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName: String(ownerId).slice(0, 64),
          userDisplayName: String(opts.displayName || ownerId).slice(0, 64),
          attestationType: 'none',
          excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports || undefined })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        });
        setCookie(res, 'pk_reg', makeChallenge(options.challenge, secret()), CHALLENGE_TTL);
        setCookie(res, 'pk_who', makeChallenge(String(ownerId), secret()), CHALLENGE_TTL);
        res.json(options);
      } catch (err) {
        console.error('passkey register/options', err);
        res.status(500).json({ error: 'Could not start Face ID setup.' });
      }
    });

    // The verify step cannot carry a password - its body is the credential.
    // The options step already demanded one, and the signed five-minute
    // cookies tie this call back to it, including which account it was for.
    app.post(`${mountPath}/register/verify`, async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req, baseDomain);
        const challenge = readChallenge((req.cookies || {}).pk_reg, secret());
        const ownerId = readChallenge((req.cookies || {}).pk_who, secret());
        if (!challenge || !ownerId) return res.status(400).json({ error: 'That took too long. Start again.' });

        const verification = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });
        if (!verification.verified) return res.status(400).json({ error: 'That passkey could not be verified.' });

        const cred = verification.registrationInfo.credential;
        await store.set(COLLECTION, cred.id, {
          ownerId,
          publicKey: Buffer.from(cred.publicKey).toString('base64'),
          counter: cred.counter,
          transports: cred.transports || [],
          rpID,
          label: String((req.body && req.body.label) || 'Face ID').slice(0, 60),
          createdAt: new Date().toISOString(),
        });
        setCookie(res, 'pk_reg', '', 0);
        setCookie(res, 'pk_who', '', 0);
        res.json({ ok: true });
      } catch (err) {
        console.error('passkey register/verify', err);
        res.status(500).json({ error: 'Face ID setup failed.' });
      }
    });

    app.post(`${mountPath}/login/options`, async (req, res) => {
      try {
        const { rpID } = rpInfo(req, baseDomain);
        const creds = (await list()).filter((c) => c.rpID === rpID);
        if (!creds.length) return res.status(404).json({ error: 'No Face ID is set up for this site yet.' });
        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports || undefined })),
          userVerification: 'preferred',
        });
        setCookie(res, 'pk_auth', makeChallenge(options.challenge, secret()), CHALLENGE_TTL);
        res.json(options);
      } catch (err) {
        console.error('passkey login/options', err);
        res.status(500).json({ error: 'Could not start Face ID sign-in.' });
      }
    });

    app.post(`${mountPath}/login/verify`, async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req, baseDomain);
        const challenge = readChallenge((req.cookies || {}).pk_auth, secret());
        if (!challenge) return res.status(400).json({ error: 'That took too long. Try again.' });

        const id = req.body && req.body.id;
        if (!id) return res.status(400).json({ error: 'Malformed passkey response.' });
        const stored = await store.get(COLLECTION, id);
        if (!stored) return res.status(404).json({ error: 'Unknown passkey.' });

        const verification = await verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id,
            publicKey: Buffer.from(stored.publicKey, 'base64'),
            counter: stored.counter || 0,
            transports: stored.transports || undefined,
          },
        });
        if (!verification.verified) return res.status(401).json({ error: 'Face ID was rejected.' });

        // The counter guards against a cloned authenticator. Synced passkeys
        // report 0 forever, so only a genuine increase is worth storing.
        const next = verification.authenticationInfo.newCounter;
        const patch = { lastUsedAt: new Date().toISOString() };
        if (typeof next === 'number' && next > (stored.counter || 0)) patch.counter = next;
        await store.set(COLLECTION, id, Object.assign({}, stored, patch));

        setCookie(res, 'pk_auth', '', 0);
        issueSession(res, stored.ownerId, req);
        res.json({ ok: true, ownerId: stored.ownerId });
      } catch (err) {
        console.error('passkey login/verify', err);
        res.status(500).json({ error: 'Face ID sign-in failed.' });
      }
    });

    app.get(`${mountPath}s`, async (req, res) => {
      const owner = currentOwner(req);
      if (!owner) return res.status(401).json({ error: 'not signed in' });
      const creds = (await list()).filter((c) => c.ownerId === owner);
      res.json({
        passkeys: creds.map((c) => ({
          id: c.id, label: c.label, rpID: c.rpID, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null,
        })),
      });
    });

    app.delete(`${mountPath}s/:id`, async (req, res) => {
      const owner = currentOwner(req);
      if (!owner) return res.status(401).json({ error: 'not signed in' });
      const cred = await store.get(COLLECTION, req.params.id);
      // 404 rather than 403 on someone else's credential, so the API will not
      // confirm that an id exists.
      if (!cred || cred.ownerId !== owner) return res.status(404).json({ error: 'Not found.' });
      await store.remove(COLLECTION, req.params.id);
      res.json({ ok: true });
    });
  }

  return { mount, list, rpInfo: (req) => rpInfo(req, baseDomain), COLLECTION };
}

module.exports = { create, rpInfo, COLLECTION, CHALLENGE_TTL };
