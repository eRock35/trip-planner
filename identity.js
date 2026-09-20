// One identity across every app on strongtechnicalconsulting.com.
//
// WHY THIS EXISTS
//
// Six apps grew up separately and ended up with four different site passwords
// and two independent account systems. Each was a reasonable local decision;
// together they meant a different sign-in for every subdomain.
//
// This module owns ONE user record, ONE session cookie and ONE passkey, shared
// by every app that mounts it. Each app keeps its own AUTHORIZATION on top -
// who may spend Anthropic tokens, who has a subscription, who is admin. This
// answers "who are you", never "what may you do".
//
// WHY SANTA ROSA IS NOT ON THIS LIST, AND CANNOT BE BY ACCIDENT
//
// The session cookie is scoped to `.strongtechnicalconsulting.com` and the
// passkey's rpID is that same registrable domain. santa-rosa-beach-trip has no
// custom domain mapping - it answers only on its *.run.app hostname, and that
// is deliberate (see its CLAUDE.md: a mapping would publish the hostname to
// public Certificate Transparency logs, and the app holds two young kids'
// details).
//
// So a browser will not send this cookie to it, and a passkey for this rpID
// cannot be used there. The separation Erik asked for - the password he might
// hand a friend for the football app must never open the vacation app - is
// enforced by DNS, not by a code check someone could later forget. If anyone
// ever maps santa-rosa to a subdomain, THAT is the change that would quietly
// join it to this system. Don't.
//
// STORAGE
//
// All of it lives in one Firestore database (`identity`), separate from any
// app's own data, so no app's database is a dependency of everyone's sign-in.
//
//   users/<uid>                  uid = base64url(lowercased email)
//   webauthn-credentials/<id>    ownerId = uid, rpID = the registrable domain
//   events/<auto>                the audit log
//   usage/<auto>                 one row per model call, with its cost
//
// The uid is derived from the email rather than random, so `create()` fails on
// a duplicate instead of needing a uniqueness index Firestore does not have.

const crypto = require('crypto');
const webauthn = require('./identity-webauthn');

const USERS = 'users';
const EVENTS = 'events';
const USAGE = 'usage';
const COOKIE = 'stc_session';
const SESSION_DAYS = 30;
const SESSION_TTL = SESSION_DAYS * 24 * 60 * 60;
const MIN_PASSWORD = 10;

/* ------------------------------------------------------------------ *
 * What a model call costs
 * ------------------------------------------------------------------ */

// Dollars per million tokens, from the Anthropic model table (rates cached
// 2026-06-24). An unknown model prices as null rather than as zero - a silent
// zero would make a new model look free on the dashboard, which is exactly the
// case you would want to notice.
const PRICES = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5-1': { input: 10, output: 50 },
};

// Standard cache multipliers: a write costs 1.25x an input token, a read 0.1x.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * @param usage   the `usage` object off an Anthropic response
 * @param batch   true for a Batch API call, which bills at half price
 * @returns dollars, or null if the model is not in the table
 */
function priceOf(model, usage, batch = false) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const million = 1e6;
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const dollars =
    (inTok * p.input +
      outTok * p.output +
      cacheWrite * p.input * CACHE_WRITE_MULTIPLIER +
      cacheRead * p.input * CACHE_READ_MULTIPLIER) /
    million;
  return batch ? dollars / 2 : dollars;
}

/* ------------------------------------------------------------------ *
 * Passwords
 * ------------------------------------------------------------------ */

function hash(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('base64');
}

function makeHash(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  return { salt, hash: hash(password, salt) };
}

function matches(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const a = Buffer.from(hash(password, record.salt));
  const b = Buffer.from(record.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ *
 * Tokens and the shared cookie
 * ------------------------------------------------------------------ */

const b64url = (b) => Buffer.from(b).toString('base64url');

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

function readToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = Buffer.from(sign(body, secret));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!payload || !payload.sub) return null;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/** The cookie is set on the PARENT domain so every subdomain sees it. Locally
 *  (127.0.0.1, or any host that is not under the base domain) it falls back to
 *  a host-only cookie, which is what makes this testable off Cloud Run. */
function cookieDomain(req, baseDomain) {
  const host = String(req.hostname || '');
  if (!baseDomain) return null;
  if (host === baseDomain || host.endsWith('.' + baseDomain)) return '.' + baseDomain;
  return null;
}

function setSessionCookie(res, req, value, baseDomain, maxAge) {
  const bits = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  const domain = cookieDomain(req, baseDomain);
  if (domain) bits.push(`Domain=${domain}`);
  // Secure whenever the request arrived over https. Deriving it from the
  // request rather than NODE_ENV means local http testing still works and
  // production is still Secure, without a flag to get wrong.
  if (req.protocol === 'https') bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

function clearSessionCookie(res, req, baseDomain) {
  const bits = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const domain = cookieDomain(req, baseDomain);
  if (domain) bits.push(`Domain=${domain}`);
  res.append('Set-Cookie', bits.join('; '));
}

/* ------------------------------------------------------------------ *
 * Access: what a person may do, which is NOT what identity answers
 * ------------------------------------------------------------------ */

// One account now opens five apps, so "is signed in" can no longer mean "may
// use this". Each app reads its own key off the user's `access` map and
// decides; absent means no, so a new registration gets nothing anywhere until
// it is granted. Fail closed - the alternative is that registering on the
// public dataviz page silently hands someone the private research tools.
//
// The map lives on the user record rather than in each app's database so the
// admin dashboard can show and change it in one place.
//
//   access: { friction: 'member', football: 'research', dataviz: 'pro' }
//
// Levels are per-app strings, not a global ranking: 'research' means nothing
// to friction and 'pro' means nothing to football. An app asking for a level
// it does not define simply never matches.
function accessLevel(user, appKey) {
  if (!user || !user.access || typeof user.access !== 'object') return null;
  const level = user.access[appKey];
  return typeof level === 'string' && level ? level : (level === true ? 'member' : null);
}

/** True when the user holds ANY access to the app, or a specific level. */
function hasAccess(user, appKey, level = null) {
  const got = accessLevel(user, appKey);
  if (!got) return false;
  return level ? got === level : true;
}

const normalise = (email) => String(email || '').trim().toLowerCase();
const uidFor = (email) => b64url(normalise(email));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ------------------------------------------------------------------ *
 * The module
 * ------------------------------------------------------------------ */

/**
 * @param opts.store       { get, set, list, remove, add } over a collection
 * @param opts.secret      () => string   shared HMAC secret, same on every app
 * @param opts.app         this app's name, recorded on every event and usage row
 * @param opts.baseDomain  registrable domain the cookie and rpID are scoped to
 * @param opts.rpName      name shown in the OS Face ID prompt
 * @param opts.mountPath   route prefix, default '/api/id'
 */
function create(opts) {
  const {
    store,
    secret,
    app: appName,
    baseDomain = '',
    rpName = 'Erik Strong',
    mountPath = '/api/id',
  } = opts;

  let warnedAboutSecret = false;

  /* ---------- users ---------- */

  async function getUser(uid) {
    if (!uid) return null;
    return store.get(USERS, uid);
  }

  async function byEmail(email) {
    return getUser(uidFor(email));
  }

  /* ---------- sessions ---------- */

  function issueSession(res, req, uid, via = 'password') {
    const key = secret();
    if (!key) throw Object.assign(new Error('Sign-in is not configured on this deployment.'), { status: 503 });
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
    const token = makeToken({ sub: uid, exp, via }, key);
    setSessionCookie(res, req, token, baseDomain, SESSION_TTL);
  }

  function session(req) {
    const key = secret();
    // Without a secret, every HMAC is computed over an empty key - which means
    // anyone could mint a session for any account. Refuse to recognise ANY
    // session rather than accept forged ones. A deployment missing the
    // variable then looks signed-out, which is loud and safe, instead of
    // looking fine and being wide open.
    if (!key) {
      if (!warnedAboutSecret) {
        warnedAboutSecret = true;
        console.error('[identity] IDENTITY_SESSION_SECRET is not set - all shared sessions are being rejected.');
      }
      return null;
    }
    const payload = readToken(parseCookies(req)[COOKIE], key);
    if (!payload) return null;
    return { uid: payload.sub, via: payload.via === 'passkey' ? 'passkey' : 'password' };
  }

  /** Loads req.user when there is a valid session. Never rejects - routes that
   *  need a user use requireUser; routes that merely want to know use this. */
  async function attachUser(req, _res, next) {
    const s = session(req);
    if (s) {
      const user = await getUser(s.uid).catch(() => null);
      if (user && !user.disabled) {
        req.user = { id: s.uid, via: s.via, ...user };
        delete req.user.password; // never let the hash reach a handler by accident
      }
    }
    next();
  }

  function requireUser(req, res, next) {
    if (req.user) return next();
    return res.status(401).json({ error: 'Sign in first.' });
  }

  /* ---------- the audit log ---------- */

  /** One row per interesting thing. Fire-and-forget: a failed write must never
   *  turn a successful sign-in into a 500, so this swallows its own errors. */
  async function log(kind, req, detail = {}) {
    const row = {
      at: new Date().toISOString(),
      app: appName,
      kind,
      uid: (req && req.user && req.user.id) || detail.uid || null,
      email: (req && req.user && req.user.email) || detail.email || null,
      ip: req ? String(req.ip || '').slice(0, 45) : null,
      ua: req ? String(req.get ? req.get('user-agent') || '' : '').slice(0, 200) : null,
      detail: detail.detail || null,
      ok: detail.ok === undefined ? true : Boolean(detail.ok),
    };
    try { await store.add(EVENTS, row); } catch (e) { /* logging must not break the request */ }
    return row;
  }

  /** One row per model call, priced. Also fire-and-forget. */
  async function recordUsage({ model, usage, route, uid, batch = false, calls = 1 }) {
    const row = {
      at: new Date().toISOString(),
      app: appName,
      model: model || null,
      route: route || null,
      uid: uid || null,
      calls,
      batch: Boolean(batch),
      inputTokens: Number((usage && usage.input_tokens) || 0),
      outputTokens: Number((usage && usage.output_tokens) || 0),
      cacheReadTokens: Number((usage && usage.cache_read_input_tokens) || 0),
      cacheWriteTokens: Number((usage && usage.cache_creation_input_tokens) || 0),
      costUsd: priceOf(model, usage, batch),
    };
    try { await store.add(USAGE, row); } catch (e) { /* never break the call it measured */ }
    return row;
  }

  /**
   * Wrap an Anthropic client so every call records what it cost.
   *
   * Done at the client rather than at each call site on purpose: there are ten
   * call sites across five apps, and the one that gets added next year is
   * exactly the one that would be forgotten. Wrapping the client means a new
   * route is metered by existing.
   *
   * Fire-and-forget: the write is never awaited, so measuring a call cannot
   * add latency to it, and recordUsage swallows its own errors so a failed
   * write cannot fail the request it was measuring.
   *
   * The Batch API is NOT covered - a batch's usage is not known when it is
   * submitted, only when its results are read, so metering it belongs with
   * the collect step rather than here.
   */
  function meter(client, opts = {}) {
    const original = client.messages.create.bind(client.messages);
    client.messages.create = async (params, ...rest) => {
      const res = await original(params, ...rest);
      try {
        if (res && res.usage) {
          recordUsage({
            model: (params && params.model) || null,
            usage: res.usage,
            route: opts.route || null,
            uid: opts.uid || null,
          }).catch(() => {});
        }
      } catch (e) { /* never let measurement break the call */ }
      return res;
    };
    return client;
  }

  /* ---------- passkeys, via the shared WebAuthn module ---------- */

  const passkeys = webauthn.create({
    store,
    secret,
    rpName,
    baseDomain,
    mountPath: `${mountPath}/passkey`,
    issueSession: (res, ownerId, req) => issueSession(res, req, ownerId, 'passkey'),
    currentOwner: (req) => {
      const s = session(req);
      return s ? s.uid : null;
    },
    // Enrolling needs the PASSWORD, not just a session - otherwise a borrowed
    // session could mint permanent access that outlives it.
    canEnrol: async (req) => {
      const s = session(req);
      if (!s) return null;
      const user = await getUser(s.uid);
      if (!user) return null;
      const supplied = (req.body || {}).password;
      if (supplied && matches(supplied, user.password)) return s.uid;
      return null;
    },
  });

  /* ---------- routes ---------- */

  function mount(expressApp) {
    expressApp.use(attachUser);

    expressApp.post(`${mountPath}/register`, async (req, res) => {
      const email = normalise((req.body || {}).email);
      const password = String((req.body || {}).password || '');
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That does not look like an email address.' });
      if (password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: `Use at least ${MIN_PASSWORD} characters.` });
      }
      const uid = uidFor(email);
      if (await getUser(uid)) {
        await log('register.duplicate', req, { uid, email, ok: false });
        return res.status(409).json({ error: 'That address already has an account. Sign in instead.' });
      }
      await store.set(USERS, uid, {
        email,
        password: makeHash(password),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdBy: appName,
      });
      issueSession(res, req, uid, 'password');
      await log('register', req, { uid, email });
      res.json({ ok: true, email });
    });

    expressApp.post(`${mountPath}/login`, async (req, res) => {
      const email = normalise((req.body || {}).email);
      const password = String((req.body || {}).password || '');
      const user = await byEmail(email);
      if (!user || user.disabled || !matches(password, user.password)) {
        // A deliberate pause, and an answer that does not say which half was
        // wrong - otherwise this endpoint enumerates who has an account.
        await new Promise((r) => setTimeout(r, 400));
        await log('login.failed', req, { uid: uidFor(email), email, ok: false });
        return res.status(401).json({ error: 'That email and password did not match.' });
      }
      const uid = uidFor(email);
      issueSession(res, req, uid, 'password');
      await store.set(USERS, uid, { ...user, lastSeenAt: new Date().toISOString() });
      await log('login', req, { uid, email });
      res.json({ ok: true, email });
    });

    expressApp.post(`${mountPath}/logout`, async (req, res) => {
      await log('logout', req);
      clearSessionCookie(res, req, baseDomain);
      res.json({ ok: true });
    });

    expressApp.get(`${mountPath}/me`, (req, res) => {
      if (!req.user) return res.json({ signedIn: false });
      res.json({
        signedIn: true,
        email: req.user.email,
        uid: req.user.id,
        via: req.user.via,
        access: req.user.access || {},
        createdAt: req.user.createdAt || null,
      });
    });

    // Changing the password. A Face ID session is proof enough on its own; a
    // password-proved one must produce the current password, or a stolen
    // cookie could take the account for good. There is no mail sender on any
    // of these services, so Face ID is the only reset door that exists.
    expressApp.post(`${mountPath}/password`, async (req, res) => {
      const s = session(req);
      if (!s) return res.status(401).json({ error: 'Sign in first.' });
      const user = await getUser(s.uid);
      if (!user) return res.status(401).json({ error: 'Sign in first.' });

      const next = String((req.body || {}).next || '');
      if (next.length < MIN_PASSWORD) {
        return res.status(400).json({ error: `Use at least ${MIN_PASSWORD} characters.` });
      }
      const proved =
        s.via === 'passkey' ||
        matches(String((req.body || {}).current || ''), user.password);
      if (!proved) {
        await new Promise((r) => setTimeout(r, 400));
        await log('password.change.refused', req, { uid: s.uid, email: user.email, ok: false });
        return res.status(401).json({ error: 'That did not prove who you are.' });
      }
      await store.set(USERS, s.uid, { ...user, password: makeHash(next), passwordChangedAt: new Date().toISOString() });
      await log('password.change', req, { uid: s.uid, email: user.email, detail: `via ${s.via}` });
      res.json({ ok: true });
    });

    passkeys.mount(expressApp);
  }

  return {
    mount,
    attachUser,
    requireUser,
    session,
    issueSession,
    getUser,
    byEmail,
    uidFor,
    accessLevel,
    hasAccess,
    /** Grant or revoke. `level` of null removes the key entirely rather than
     *  storing a falsy value, so the map only ever lists real grants. */
    async setAccess(uid, appKey, level) {
      const user = await getUser(uid);
      if (!user) throw Object.assign(new Error('No such account.'), { status: 404 });
      const access = { ...(user.access || {}) };
      if (level) access[appKey] = String(level);
      else delete access[appKey];
      await store.set(USERS, uid, { ...user, access });
      return access;
    },
    log,
    recordUsage,
    meter,
    priceOf,
    MIN_PASSWORD,
    COOKIE,
    collections: { USERS, EVENTS, USAGE },
  };
}

module.exports = { create, priceOf, PRICES, uidFor, makeHash, matches, accessLevel, hasAccess, USERS, EVENTS, USAGE, COOKIE, MIN_PASSWORD };
