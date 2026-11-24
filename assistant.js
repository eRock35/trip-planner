/**
 * Assistant access: a read-only token for the account owner's own texting
 * assistant (2026-11-24).
 *
 * Someone signed in can make up to three tokens in the Account sheet. A token
 * lets a program they run ask "what's my hotel in Lisbon?" - it reads the
 * trips that account can already see, and nothing else. It is a bearer
 * secret, so the shape is deliberately narrow:
 *
 *  - READ ONLY, and only under /api/assistant/v1/. There is no write route;
 *    any method but GET is a 405. The token is never looked at by the
 *    session-authenticated routes, and a session cookie is never looked at
 *    here.
 *  - The secret is shown once and never stored. The record is
 *    assistant-tokens/<sha256(token)> = {id, uid, label, hash, createdAt,
 *    lastUsedAt}; the stored hash is compared in constant time.
 *  - What it can read is a SUMMARY, shaped here by summary(): confirmation
 *    numbers masked to their last four, no manage-booking links, no booking
 *    notes (door codes live there), no prices of a single booking, no email
 *    address of anyone, no photos, no chat.
 *
 * This file holds the parts with no database in them, so the tests can call
 * them directly; server.js holds the routes.
 */
const crypto = require('crypto');

const PREFIX = 'tp_ro_';
const MAX_TOKENS = 3;
const SECRET_BYTES = 32;
// tp_ro_ + base64url of 32 bytes (43 characters). Anything else is not one of
// ours and is refused before a hash is computed or the database is asked.
const TOKEN_RE = /^tp_ro_[A-Za-z0-9_-]{43}$/;
const PER_MINUTE = 60;
const PER_DAY = 2000;
// lastUsedAt is for the person reading the list ("used 3 minutes ago"), not
// an audit trail: one write per token per five minutes at most.
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

/** A new token: the secret (returned to the caller once) and its record. */
function mint(uid, label, now = new Date()) {
  const token = PREFIX + crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const hash = sha256(token).toString('hex');
  return {
    token,
    docId: hash,
    record: {
      id: crypto.randomBytes(8).toString('hex'),
      uid: String(uid),
      label: cleanLabel(label),
      hash,
      createdAt: now.toISOString(),
      lastUsedAt: null,
    },
  };
}

function cleanLabel(v) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Assistant';
}

/** The bearer token on a request, or '' when there is none of our shape. */
function bearer(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m && TOKEN_RE.test(m[1]) ? m[1] : '';
}

/** Where a token's record lives: the hex sha256 of the token itself. */
function docIdFor(token) { return sha256(token).toString('hex'); }

/** Does this stored record belong to this token? Constant time: the stored
 *  hash against the hash of what was presented, both 32 bytes. */
function matches(record, token) {
  if (!record || typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), sha256(token));
}

/** What the Account sheet lists. Never the hash. */
function listed(record) {
  return { id: record.id, label: record.label, createdAt: record.createdAt || null, lastUsedAt: record.lastUsedAt || null };
}

/** A sliding window per key, in memory, per instance (the shape of
 *  identity.createLimiter, with the wait reported for Retry-After). */
function limiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    /** Counts one. Returns 0 when allowed, else the seconds until a slot frees. */
    take(key) {
      const t = now();
      const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
      if (list.length >= max) { hits.set(key, list); return Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000)); }
      list.push(t);
      hits.set(key, list);
      if (hits.size > 5000) hits.clear();
      return 0;
    },
    clear(key) { hits.delete(key); },
  };
}

/* ---------- what a token may read ---------- */

/** A confirmation number, last four only. Shorter than five characters and
 *  nothing of it is shown: four of four would be the whole number. */
function maskConfirmation(v) {
  const chars = String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '');
  if (!chars) return '';
  return chars.length > 4 ? '****' + chars.slice(-4) : '****';
}

const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|gate|terminal|seat|row|zone|group|room)$/i;
/** A flight number from a booking's title or provider line, e.g. "TP 1362",
 *  "DL1234", "Delta 1234". Best effort: bookings have no field for it. */
function flightNumber(b) {
  const text = [b.title, b.provider].filter(Boolean).join(' ');
  const code = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/.exec(text);
  if (code) return code[1] + ' ' + code[2];
  const re = /\b([A-Z][A-Za-z]+)\s+#?(\d{2,4})\b/g;
  let m;
  while ((m = re.exec(text))) if (!MONTHS.test(m[1])) return m[1] + ' ' + m[2];
  return '';
}

/** One booking, as an assistant may read it. Deliberately absent: the full
 *  confirmation number, the manage-booking url (often a sign-in by itself),
 *  notes (door codes), phone, and what it cost. */
function bookingOut(b) {
  const out = {
    type: b.kind,
    name: b.title,
    provider: b.provider || '',
    date: b.date || '',
    start: b.when || '',
    end: b.until || '',
    confirmation: maskConfirmation(b.confirmation),
    address: b.address || '',
  };
  if (b.kind === 'flight') out.flightNumber = flightNumber(b);
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The trip summary.
 * @param trip      tripOut()'s trip (days already [time, plan] pairs, dates worked out)
 * @param role      'owner' | 'member', from the same check the page's routes use
 * @param bookings  bookings.validate()'d list
 * @param packing   rows of trips/<id>/packing
 * @param budget    {target, lines, booked} as the Budget tab reads it
 */
function summary(trip, role, bookings, packing, budget) {
  const days = (Array.isArray(trip.days) ? trip.days : []).map((d) => ({
    date: d.date || '',
    label: d.dateLabel || '',
    title: d.title || '',
    items: (Array.isArray(d.blocks) ? d.blocks : []).map((b) => ({ time: String((b && b[0]) || ''), title: String((b && b[1]) || '') })),
  }));
  const home = trip.homeCurrency || 'USD';
  const lines = (budget && budget.lines) || [];
  // Totals per currency, never converted: an exchange rate is the page's
  // estimate, and an assistant reading "about" as exact would be wrong.
  const byCurrency = {};
  for (const l of lines) {
    const cur = l.currency || home;
    const row = byCurrency[cur] || (byCurrency[cur] = { planned: 0, spent: 0 });
    row.planned += Number(l.planned) || 0;
    row.spent += Number(l.spent) || 0;
  }
  for (const k of Object.keys(byCurrency)) byCurrency[k] = { planned: round2(byCurrency[k].planned), spent: round2(byCurrency[k].spent) };
  const booked = ((budget && budget.booked) || []).reduce((s, b) => s + (Number(b.total) || 0), 0);
  const items = packing || [];
  const packed = items.filter((i) => i.checked === true).length;
  return {
    id: trip.id,
    role,
    name: trip.name || 'Untitled trip',
    place: trip.destination || '',
    when: trip.dateRange || '',
    dates: trip.dates ? { start: trip.dates.start, end: trip.dates.end, precision: trip.dates.precision || 'day' } : null,
    status: trip.status || 'planning',
    days,
    bookings: (bookings || []).map(bookingOut),
    packing: { items: items.length, packed, left: items.length - packed },
    budget: {
      currency: home,
      target: budget && budget.target != null ? budget.target : null,
      lines: lines.length,
      totals: byCurrency,
      // Bookings that state a price, in dollars as the confirmations gave it.
      bookedUsd: round2(booked),
    },
  };
}

/** One row of the list. No one's email: the page's own list names who a trip
 *  is shared with, and an assistant has no use for that. */
function listRow(s) {
  return {
    id: s.id, role: s.role, name: s.name, place: s.destination, when: s.dateRange,
    dates: s.dates ? { start: s.dates.start, end: s.dates.end, precision: s.dates.precision || 'day' } : null,
    status: s.status, days: s.dayCount,
  };
}

module.exports = {
  PREFIX, MAX_TOKENS, TOKEN_RE, PER_MINUTE, PER_DAY, TOUCH_EVERY_MS,
  mint, cleanLabel, bearer, docIdFor, matches, listed, limiter,
  maskConfirmation, flightNumber, bookingOut, summary, listRow,
};
