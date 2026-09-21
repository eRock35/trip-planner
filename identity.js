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
const { AsyncLocalStorage } = require('async_hooks');
const webauthn = require('./identity-webauthn');
const byokLib = require('./byok');

// The metered Anthropic client is built once per process but serves every
// visitor, so "who is this call for" cannot be baked into it. This carries the
// current request across the awaits between the route and the SDK call, which
// is what lets usage be charged to the right person without threading a uid
// through every function that might one day call a model.
const requestContext = new AsyncLocalStorage();

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

// Web search bills per search, on top of tokens: $10 per 1,000 searches.
// This was missing, and it is not a rounding error - it is usually the LARGER
// half of a research answer's cost. A trip-planner question on Sonnet runs
// about 8k input and 1.5k output, which is $0.031 of tokens; five searches is
// $0.05 on top. The ledger was charging people for the third of the bill it
// could see and eating the rest, and raising max_uses makes the gap grow
// rather than shrink.
//
// Web FETCH is free (tokens only), so it is deliberately not priced here.
// An errored search is not billed by Anthropic either, and does not appear in
// the counter, so nothing extra is needed to exclude it.
const WEB_SEARCH_USD = 0.01;

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
  // The batch discount is on tokens. Searches are not discounted, so they are
  // added after the halving rather than before it.
  const tokens = batch ? dollars / 2 : dollars;
  const searches = Number((usage.server_tool_use || {}).web_search_requests || 0);
  return tokens + searches * WEB_SEARCH_USD;
}

/* ------------------------------------------------------------------ *
 * The shared budget
 * ------------------------------------------------------------------ */

// One allowance per PERSON, spendable across every app - not one per app.
// Five separate $2 budgets would be $10 and would let someone who exhausted
// one simply move to the next, which is the whole thing this is meant to stop.
//
// Denominated in dollars rather than calls because that is what it actually
// costs: one Opus request with a long document is worth many Haiku ones, and a
// call-count budget prices them the same.
const FREE_ALLOWANCE_USD = Number(process.env.FREE_ALLOWANCE_USD || 2);

// Spending is recorded AFTER a call, so the last one allowed can overshoot by
// its own cost. Bounded, and the alternative - reserving an estimate up front
// and reconciling after - is a great deal of machinery for a couple of cents.
function budgetFor(user) {
  if (!user) {
    // Not signed in. Each app decides whether anonymous use is allowed at all;
    // this only says there is no personal allowance to draw on.
    return { unlimited: false, allowanceUsd: 0, spentUsd: 0, remainingUsd: 0, reason: 'signed-out' };
  }
  // The owner is never metered - it is his API key.
  if (user.admin === true) {
    return { unlimited: true, allowanceUsd: Infinity, spentUsd: Number(user.spentUsd || 0), remainingUsd: Infinity, reason: 'owner' };
  }
  // Their key, their bill. Not metered here, but usage is still recorded so
  // the dashboard can show what they ran - it just is not charged to anyone.
  if (user.byok && user.byok.blob) {
    return { unlimited: true, allowanceUsd: Infinity, spentUsd: Number(user.spentUsd || 0), remainingUsd: Infinity, reason: 'byok' };
  }
  // A paid plan covers its own usage; the allowance is for everyone else.
  //
  // Keyed off `plan`, which is domain-wide, and NOT off access['dataviz'].
  // That clause used to be here and it was the same mistake as writing the
  // plan to DataViz's own database: an app-scoped grant driving a
  // domain-wide entitlement. "dataviz: pro" is meant to unlock DataViz's own
  // features - your own data instead of the samples - and it was instead
  // handing out unlimited spend on the owner's API key in Trip Planner,
  // Football, Friction and Hopscotch as well. Three accounts held it.
  //
  // DataViz's own feature gate still reads the grant, via hasAccess() in its
  // isPro(). Only the BILLING question moved.
  if (user.plan === 'pro') {
    return { unlimited: true, allowanceUsd: Infinity, spentUsd: Number(user.spentUsd || 0), remainingUsd: Infinity, reason: 'pro' };
  }
  const allowance = FREE_ALLOWANCE_USD + Number(user.toppedUpUsd || 0);
  const spent = Number(user.spentUsd || 0);
  return {
    unlimited: false,
    allowanceUsd: allowance,
    spentUsd: spent,
    remainingUsd: Math.max(0, allowance - spent),
    toppedUpUsd: Number(user.toppedUpUsd || 0),
    member: isMember(user),
    reason: isMember(user) ? 'member' : 'allowance',
  };
}

/**
 * Membership: the flat monthly fee that covers hosting and metering.
 *
 * Deliberately NOT `unlimited`. That is the whole point of the model - credit
 * is sold at what the call actually costs, and the monthly fee pays for the
 * hosting and the ledger rather than for tokens. A member who runs their
 * balance to zero is stopped by requireBudget exactly like anyone else; what
 * membership buys is the better model, the bigger search budget, and the
 * right to keep topping up.
 *
 * A cancelled membership runs to the end of the period already paid for -
 * Stripe has taken that money, so the service is owed.
 */
function isMember(user) {
  if (!user || user.plan !== 'member') return false;
  if (user.currentPeriodEnd && Date.parse(user.currentPeriodEnd) < Date.now()) return false;
  return true;
}

/**
 * Which tier of model and search budget this person gets.
 *
 * Separate from `unlimited`, and the distinction matters: a member pays every
 * month but still spends their own credit per call, so they are metered AND
 * on the paid tier. Keying the model off `unlimited` alone would have quietly
 * served Haiku to someone paying $5 a month.
 */
function paidTier(user) {
  return budgetFor(user).unlimited || isMember(user);
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
/* ------------------------------------------------------------------ *
 * Which model, and which web-search tool that model can actually use
 * ------------------------------------------------------------------ */

// Haiku 4.5 is $1/$5 per million tokens against Sonnet 5's $2/$10 and Opus 5's
// $5/$25. For chat it is plenty, and half the bill is half the bill - so the
// free allowance buys roughly twice as much conversation for the same money.
// Anyone who is paying, one way or another - the owner, a Pro subscription, or
// their own API key - gets the better model.
//
// THE TRAP, measured against the live API before this was written: Haiku 4.5
// returns 400 on web_search_20260209 ("does not support programmatic tool
// calling"). The newer search tool needs Opus 4.6+ or Sonnet 4.6+. So the
// model and the search tool have to move together or every free-tier chat
// breaks the moment the model is downgraded - which is why planFor hands back
// both and no call site picks a tool type on its own.
const SEARCH_MODERN = 'web_search_20260209';
const SEARCH_BASIC = 'web_search_20250305';
const MODERN_SEARCH = /^claude-(opus-(5|4-8|4-7|4-6)|sonnet-(5|4-6)|fable-5)/;

function webSearchFor(model, maxUses) {
  return {
    type: MODERN_SEARCH.test(String(model || '')) ? SEARCH_MODERN : SEARCH_BASIC,
    name: 'web_search',
    max_uses: maxUses,
  };
}

/**
 * Pick the model for this request, and the search tool that goes with it.
 *
 * @param user          req.user, or null for an anonymous visitor (free).
 * @param opts.free     model for the shared allowance and for signed-out use.
 * @param opts.paid     model for the owner, Pro, and bring-your-own-key.
 * @param opts.maxUses  one search budget for both tiers, when an app wants that.
 *
 * The search budget is per tier, because searches cost real money per use and
 * five of them was not enough to answer a research question. Asked to price a
 * week's travel for four people, the model spent its five searches, said "I
 * hit a search tool limit just now, so I don't have live flight/hotel prices
 * in hand", and offered a framework instead of an answer - which is the whole
 * job, not done. Paid gets a budget that can actually finish; free stays tight
 * because the $2 allowance is real money and searches are most of what spends
 * it.
 */
const FREE_SEARCHES = Number(process.env.FREE_MAX_SEARCHES || 4);
const PAID_SEARCHES = Number(process.env.PAID_MAX_SEARCHES || 14);

function planFor(user, opts) {
  const paid = paidTier(user);
  const model = (paid && opts.paid) || opts.free;
  const maxUses = opts.maxUses !== undefined
    ? opts.maxUses
    : (paid ? PAID_SEARCHES : FREE_SEARCHES);
  return {
    model,
    tier: paid ? 'paid' : 'free',
    maxUses,
    webSearch: webSearchFor(model, maxUses),
  };
}

/** Where someone sends money. Checkout is built once, on dataviz, and the
 *  balance it tops up is shared, so every app points at the same place rather
 *  than growing its own Stripe integration. TOP_UP_URL overrides it; without
 *  a base domain there is nowhere sensible to guess, so the 402 carries no
 *  link rather than a broken one. */
function topUpUrl() {
  const explicit = String(process.env.TOP_UP_URL || '').trim();
  if (explicit) return explicit;
  const base = String(process.env.PASSKEY_RP_ID || '').trim();
  return base ? `https://dataviz.${base}/?topup=1` : null;
}

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

/** A pending ask for access, or null. Presence of `requests[appKey]` with no
 *  decision is what the notifier reports and the admin panel lists. */
function pendingRequest(user, appKey) {
  const r = user && user.requests && user.requests[appKey];
  if (!r || typeof r !== 'object') return null;
  return r.state === 'denied' ? null : r;
}

/** True when the user holds ANY access to the app, or a specific level. */
function hasAccess(user, appKey, level = null) {
  if (!user) return false;
  // The owner does not ask himself for permission. `absent means no` is the
  // right default for a stranger who just registered; applying it to the
  // person who runs the whole domain just invents a chore. The flag lives on
  // the account rather than in each service's environment, so it travels with
  // the identity and is visible on the dashboard instead of being config
  // five services have to agree about.
  if (user.admin === true) return true;
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

  /** Runs each request inside a context the meter can read. Mounted by
   *  identity.mount, so an app gets it by wiring identity at all. */
  function trackRequests(req, _res, next) {
    requestContext.run({ req }, next);
  }

  /** The signed-in person for the request currently being served, if any. */
  function currentUid() {
    const store = requestContext.getStore();
    return (store && store.req && store.req.user && store.req.user.id) || null;
  }

  /** What this person may still spend. */
  function budget(req) {
    return budgetFor(req && req.user);
  }

  /**
   * Refuse a model call when the allowance is gone. Put this in front of every
   * route that spends, not just the obvious one - the budget is only real if
   * nothing can route around it.
   *
   * A request with no user passes through: whether anonymous use is allowed is
   * each app's own decision, made by its own gate. This one only enforces a
   * personal allowance, and there isn't one to enforce.
   */
  function requireBudget(req, res, next) {
    const b = budgetFor(req.user);
    if (!req.user || b.unlimited || b.remainingUsd > 0) return next();
    log('budget.exhausted', req, { detail: `spent ${b.spentUsd.toFixed(2)} of ${b.allowanceUsd.toFixed(2)}`, ok: false });
    return res.status(402).json({
      error: 'You have used your credit.',
      detail: `Your $${b.allowanceUsd.toFixed(2)} of credit is spent. Top up to keep going — it works across every app.`,
      // Telling someone to top up without saying where is a dead end. Checkout
      // lives on one app for everyone, so every other app's 402 has to carry
      // the way there.
      topUpUrl: topUpUrl(),
      budget: { allowanceUsd: b.allowanceUsd, spentUsd: b.spentUsd, remainingUsd: 0 },
    });
  }

  /** One row per model call, priced. Also fire-and-forget. */
  async function recordUsage({ model, usage, route, uid, batch = false, calls = 1, byok = false }) {
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
      // Their key paid for this one. The row is still written, because the
      // dashboard should show what ran, but nobody is billed for it.
      byok: Boolean(byok),
    };
    try { await store.add(USAGE, row); } catch (e) { /* never break the call it measured */ }
    // Charge it to the person, atomically. Without this the ledger would be a
    // sum over an unbounded collection on every request; with a read-modify-
    // write it would lose charges whenever two apps billed at once.
    if (!byok && uid && typeof row.costUsd === 'number' && row.costUsd > 0 && store.bump) {
      try { await store.bump(USERS, uid, { spentUsd: row.costUsd, callCount: 1 }); } catch (e) { /* same */ }
    }
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
            byok: Boolean(client.__byok),
            // Who to charge. `whoFor` lets an app hand over the current
            // request, since one client serves every visitor; scheduled work
            // has nobody to charge and is left unattributed.
            uid: (opts.whoFor && opts.whoFor()) || opts.uid || currentUid(),
          }).catch(() => {});
        }
      } catch (e) { /* never let measurement break the call */ }
      return res;
    };
    return client;
  }

  /* ---------- bring your own key ---------- */

  const byok = byokLib.create({
    secret: () => process.env.BYOK_ENCRYPTION_KEY || '',
    // Overridable so a test can point validation at a stand-in rather than
    // spending a real round trip to Anthropic on every run.
    validateUrl: process.env.BYOK_VALIDATE_URL || undefined,
  });

  /** The Anthropic key this request should run on: the user's own if they
   *  have one on file, otherwise null, meaning "the service's own key". */
  async function apiKeyFor(user) {
    if (!user || !user.byok || !user.byok.blob) return null;
    return byok.decrypt(user.id, user.byok.blob);
  }

  /** A metered Anthropic client for this request.
   *
   *  Apps build one client at startup with the service key. A user on their
   *  own key needs a different client, so this returns either the shared one
   *  or a per-key client, cached by key so a busy user does not construct a
   *  new one per request. `__byok` rides on the client because that is what
   *  the meter reads to decide whether to charge anyone.
   *
   *  @param fallback the app's own client, used when the user has no key.
   *  @param make     (apiKey) => client, so identity never imports the SDK.
   */
  const keyClients = new Map();
  async function clientFor(user, fallback, make) {
    const apiKey = await apiKeyFor(user);
    if (!apiKey) return fallback;
    if (!keyClients.has(apiKey)) {
      // Cap it so a stream of bad keys cannot grow this without bound.
      if (keyClients.size > 200) keyClients.clear();
      const client = meter(make(apiKey));
      client.__byok = true;
      keyClients.set(apiKey, client);
    }
    return keyClients.get(apiKey);
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
    expressApp.use(trackRequests);
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
      const record = {
        email,
        password: makeHash(password),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdBy: appName,
      };
      // Whoever registers with the configured owner address is the owner. Set
      // here so a fresh deployment produces a working admin without anyone
      // hand-editing the database.
      const owner = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (owner && email === owner) record.admin = true;
      await store.set(USERS, uid, record);
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
        requests: req.user.requests || {},
        admin: req.user.admin === true,
        budget: budgetFor(req.user),
        // The last four characters and when it was added - never the key.
        byok: {
          supported: byok.enabled(),
          present: Boolean(req.user.byok && req.user.byok.blob),
          last4: (req.user.byok && req.user.byok.last4) || null,
          addedAt: (req.user.byok && req.user.byok.addedAt) || null,
        },
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

    /* ---- bring your own key ---- */

    expressApp.post(`${mountPath}/byok`, async (req, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
        if (!byok.enabled()) {
          return res.status(503).json({ error: 'Storing keys is not switched on for this deployment.' });
        }
        const supplied = String((req.body || {}).key || '').trim();
        // Prove it works before storing it: a typo caught here beats a failed
        // answer an hour from now that looks like the app is broken.
        const check = await byok.validate(supplied);
        if (!check.ok) return res.status(400).json({ error: check.error });

        const record = { blob: byok.encrypt(req.user.id, supplied), last4: byok.last4(supplied), addedAt: new Date().toISOString() };
        await store.set(USERS, req.user.id, Object.assign({}, await getUser(req.user.id), { byok: record }));
        await log('byok.added', req, { uid: req.user.id, detail: '...' + record.last4 });
        // Never echo the key back, not even the one they just sent.
        res.json({ ok: true, byok: { present: true, last4: record.last4, addedAt: record.addedAt } });
      } catch (err) {
        console.error('POST byok', err);
        res.status(err.status || 500).json({ error: 'Could not save that key.' });
      }
    });

    expressApp.delete(`${mountPath}/byok`, async (req, res) => {
      try {
        if (!req.user) return res.status(401).json({ error: 'Sign in first.' });
        const current = await getUser(req.user.id);
        if (current) {
          const next = Object.assign({}, current);
          delete next.byok;
          await store.set(USERS, req.user.id, next);
        }
        // Any cached client built from it dies with it, or the key would keep
        // working for as long as the process lived.
        keyClients.clear();
        await log('byok.removed', req, { uid: req.user.id });
        res.json({ ok: true, byok: { present: false } });
      } catch (err) {
        console.error('DELETE byok', err);
        res.status(500).json({ error: 'Could not remove that key.' });
      }
    });

    // Ask for access to THIS app. There is no app key in the body on purpose:
    // you can only ask for the app you are actually on, so there is nothing to
    // forge. Re-asking is allowed and refreshes the timestamp, which is what
    // makes the notifier mention it again.
    expressApp.post(`${mountPath}/access/request`, async (req, res) => {
      const s = session(req);
      if (!s) return res.status(401).json({ error: 'Sign in first.' });
      const user = await getUser(s.uid);
      if (!user) return res.status(401).json({ error: 'Sign in first.' });
      if (hasAccess(user, appName)) {
        return res.status(400).json({ error: 'You already have access to this one.' });
      }
      const requests = { ...(user.requests || {}) };
      requests[appName] = {
        at: new Date().toISOString(),
        note: String((req.body || {}).note || '').slice(0, 300),
        state: 'pending',
      };
      await store.set(USERS, s.uid, { ...user, requests });
      await log('access.requested', req, { uid: s.uid, email: user.email, detail: appName });
      res.json({ ok: true, requested: appName });
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
      const requests = { ...(user.requests || {}) };
      if (level) {
        access[appKey] = String(level);
        // They asked and got it - the ask is answered, so drop it rather than
        // leaving a pending request beside the access it was asking for.
        delete requests[appKey];
      } else {
        delete access[appKey];
      }
      await store.set(USERS, uid, { ...user, access, requests });
      return access;
    },

    /** Turn an ask down without granting. Keeps the record so the notifier
     *  stops mentioning it and the panel stops listing it; a fresh ask from
     *  the same person overwrites this and is reported again. */
    async denyRequest(uid, appKey) {
      const user = await getUser(uid);
      if (!user) throw Object.assign(new Error('No such account.'), { status: 404 });
      const requests = { ...(user.requests || {}) };
      if (!requests[appKey]) throw Object.assign(new Error('No such request.'), { status: 404 });
      requests[appKey] = { ...requests[appKey], state: 'denied', decidedAt: new Date().toISOString() };
      await store.set(USERS, uid, { ...user, requests });
      return requests;
    },

    pendingRequest,
    log,
    recordUsage,
    meter,
    budget,
    budgetFor,
    requireBudget,
    apiKeyFor,
    clientFor,
    byokEnabled: byok.enabled,
    trackRequests,
    currentUid,
    priceOf,
    MIN_PASSWORD,
    COOKIE,
    collections: { USERS, EVENTS, USAGE },
  };
}

module.exports = {
  planFor,
  webSearchFor, create, priceOf, PRICES, isMember, paidTier, uidFor, makeHash, matches, accessLevel, hasAccess, pendingRequest, budgetFor, FREE_ALLOWANCE_USD, USERS, EVENTS, USAGE, COOKIE, MIN_PASSWORD };
