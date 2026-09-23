/**
 * Reading a person's Gmail for travel confirmations, with their consent.
 *
 * The feature is "find the bookings you already have and offer to turn them
 * into trips". Everything here is shaped by one idea: the narrowest thing that
 * does the job is also the only thing we can honestly ask permission for.
 *
 * ## What this deliberately does not do
 *
 * Google has no read scope narrower than `gmail.readonly`, so the TOKEN we
 * hold can read anything. That is exactly why the QUERY is a fixed, curated
 * list of travel senders compiled here rather than anything a request can
 * influence: holding a capability we never exercise is a promise, and a
 * promise a user cannot inspect is worth very little. This way the consent
 * screen can name the senders, and the code is what enforces it.
 *
 * `searchQueries()` takes no user input on purpose. An earlier shape let the
 * caller pass extra terms, which would have made the consent copy a lie the
 * first time anyone used it.
 *
 * ## What is kept
 *
 * The refresh token, encrypted, and nothing else. Message bodies are fetched,
 * read once by the extractor and dropped; only the trip a person chooses to
 * import is written. The scan route never persists a candidate.
 *
 * ## Shared
 *
 * COPY. The source is eriks-projects/shared/gmail.js, synced into
 * trip-planner and santa-rosa-beach-trip by scripts/sync-shared.js. It is
 * shared rather than per-app because TRAVEL_SENDERS is a promise made on a
 * consent screen: two apps holding two lists would be two different promises
 * that drift, and a person who connected one would have no way to know.
 *
 * ## Verification
 *
 * `gmail.readonly` is a RESTRICTED scope. Offering this publicly needs Google
 * app verification plus an annual third-party security assessment (CASA). The
 * app is therefore PUBLISHED BUT UNVERIFIED (since 2026-09-23; it ran in
 * Testing before that): anyone may connect, up to Google's 100-user cap for an
 * unverified app, and each sees an "unverified app" warning once. That ceiling
 * is a product decision, not a bug: see the deploy notes before trying to lift
 * it.
 */

const AUTH_HOST = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Read-only, and only Gmail. No profile, no contacts, no calendar - each extra
// scope is another line on the consent screen that we would have to justify.
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/**
 * Who we look at. Curated rather than clever, because this list IS the
 * consent: whatever is here is what the screen promises and what the account
 * page can show back. Adding a domain widens what the app reads, so adding one
 * is a decision, not a tweak.
 *
 * Grouped so a consent screen can say WHAT KIND of company it reads - "car
 * rentals, restaurants" - rather than naming four domains and "and 90 more".
 *
 * Widened on 2026-09-23 at Erik's request ("we need to search things like
 * rental cars and all that"): the first list had four car-rental companies
 * and no restaurants, tours or cruises, so a trip's rental car from National
 * or its boat tour booked through FareHarbor was invisible.
 *
 * Left out on purpose: banks and card travel portals (capitalone.com,
 * chase.com - far more statements than bookings), rideshare (a receipt a day
 * from Uber would crowd out everything else), and anything whose domain also
 * sends non-travel mail (disney.go.com, yelp.com).
 */
const SENDER_GROUPS = {
  'Airlines': [
    'delta.com', 'united.com', 'aa.com', 'southwest.com', 'alaskaair.com',
    'jetblue.com', 'flyfrontier.com', 'spirit.com', 'hawaiianairlines.com',
    'allegiantair.com', 'suncountry.com', 'flybreeze.com', 'aveloair.com',
    'westjet.com', 'aircanada.ca', 'britishairways.com', 'virginatlantic.com',
    'aerlingus.com', 'lufthansa.com', 'klm.com', 'airfrance.fr', 'iberia.com',
    'tapairportugal.com', 'ryanair.com', 'easyjet.com', 'emirates.com',
    'qatarairways.com', 'aeromexico.com', 'copaair.com',
  ],
  'Hotels & stays': [
    'marriott.com', 'hilton.com', 'hyatt.com', 'ihg.com', 'choicehotels.com',
    'wyndhamhotels.com', 'bestwestern.com', 'radissonhotels.com', 'accor.com',
    'omnihotels.com', 'fourseasons.com', 'loewshotels.com', 'sonesta.com',
    'airbnb.com', 'vrbo.com', 'vacasa.com', 'evolve.com', 'sonder.com',
  ],
  'Car rentals': [
    'hertz.com', 'enterprise.com', 'nationalcar.com', 'alamo.com', 'avis.com',
    'budget.com', 'sixt.com', 'thrifty.com', 'dollar.com', 'paylesscar.com',
    'foxrentacar.com', 'europcar.com', 'turo.com', 'zipcar.com',
    'getaround.com', 'rentalcars.com', 'autoslash.com',
  ],
  'Booking sites': [
    'expedia.com', 'booking.com', 'hotels.com', 'priceline.com', 'kayak.com',
    'orbitz.com', 'travelocity.com', 'hopper.com', 'agoda.com', 'trip.com',
    'kiwi.com', 'costcotravel.com', 'tripit.com',
  ],
  'Trains & buses': [
    'amtrak.com', 'brightline.com', 'greyhound.com', 'flixbus.com',
    'eurail.com', 'trainline.com', 'raileurope.com', 'viarail.ca',
  ],
  'Cruises': [
    'carnival.com', 'royalcaribbean.com', 'ncl.com', 'princess.com',
    'celebritycruises.com',
  ],
  'Tours & tickets': [
    // FareHarbor, Peek and Rezdy are what most small local operators - the
    // boat tour, the kayak rental, the dolphin cruise - book through, so
    // they find far more than the big brands would alone.
    'viator.com', 'getyourguide.com', 'klook.com', 'fareharbor.com',
    'peek.com', 'rezdy.com',
  ],
  'Restaurants': [
    'opentable.com', 'resy.com', 'exploretock.com', 'sevenrooms.com',
  ],
  'Parking': [
    'spothero.com', 'parkwhiz.com',
  ],
};

/** The flat list the query is built from. Derived, never edited directly, so
 *  the groups a consent screen shows and the senders actually searched
 *  cannot disagree. */
const TRAVEL_SENDERS = [...new Set(Object.values(SENDER_GROUPS).flat())];

/** How far back a scan looks. A year covers next season's booking and last
 *  season's receipts without trawling a decade of mail. */
const MONTHS_BACK = 12;
/** Ceiling on messages per scan: each one is tokens through the extractor, and
 *  an unbounded scan is an unbounded bill. Raised from 25 to 40 when the
 *  sender list widened, with BODY_CHARS cut from 12000 to 8000 so a scan costs
 *  about what it did: the booking details in a confirmation are near the top,
 *  and what gets cut is the legal footer. */
const MAX_MESSAGES = 40;
const BODY_CHARS = 8000;

function create(opts) {
  const {
    clientId = () => process.env.GOOGLE_CLIENT_ID || '',
    clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri = () => process.env.GOOGLE_REDIRECT_URI || '',
    fetchImpl = (...a) => fetch(...a),
  } = opts || {};

  const enabled = () => Boolean(clientId() && clientSecret() && redirectUri());

  /** The Gmail queries, one per sender group. No arguments: see the note at
   *  the top of this file - nothing a request sends can widen what is read.
   *
   *  One query per group rather than one for everything, for two reasons.
   *  A single query over a hundred senders is ~1,700 characters, longer than
   *  anything Gmail documents supporting. And a single query shares one
   *  message ceiling across every kind of booking, so a run of restaurant
   *  reminders could push out the one car-rental confirmation that mattered.
   *  search() takes the newest from each group in turn instead.
   *
   *  `-category:promotions -category:social` is what keeps a wider list from
   *  meaning a noisier scan. Every airline and hotel here sends far more fare
   *  sales than confirmations; Gmail files confirmations under Primary or
   *  Updates. This narrows what is read, never widens it.
   *
   *  FORWARDED BOOKINGS (2026-09-23). Each group has a second query for the
   *  same senders' mail forwarded in: a subject starting Fwd/FW that names
   *  one of those domains in its text. Reported as "not picking up my
   *  National car rental email": it had been booked through a work address
   *  and forwarded home, so the From line was the work address and `from:`
   *  could never match - National appeared only inside the forwarded text.
   *  Same senders, same window, same exclusions; the privacy policy and both
   *  consent sheets say so. */
  function searchQueries(now = new Date()) {
    const after = new Date(now);
    after.setMonth(after.getMonth() - MONTHS_BACK);
    const tail = `-category:promotions -category:social after:${after.toISOString().slice(0, 10).replace(/-/g, '/')}`;
    return Object.entries(SENDER_GROUPS).flatMap(([group, domains]) => [
      { group, forwarded: false, q: `from:(${domains.join(' OR ')}) ${tail}` },
      { group, forwarded: true, q: `subject:(fwd OR fw) (${domains.map((d) => `"${d}"`).join(' OR ')}) ${tail}` },
    ]);
  }

  /** Where to send someone to grant access. `state` ties the round trip to
   *  the session that started it - without it, a link someone else crafted
   *  could attach THEIR mailbox to YOUR account. */
  function authUrl(state) {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPE,
      // offline + consent is what actually returns a refresh token. Without
      // `prompt=consent` Google omits it on every grant after the first, and
      // the connection silently stops working an hour later.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_HOST}?${params}`;
  }

  async function form(url, body) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // invalid_grant is Google saying the stored connection is over: revoked
      // by the person, or expired. (While the app was in Testing, every
      // refresh token died after seven days, and that was the common case;
      // published, it is rarer - a revoke, a password change, six months
      // unused.) That is a "reconnect", not a failure, and callers must be
      // able to tell the two apart.
      if (data.error === 'invalid_grant') {
        throw Object.assign(new Error('Google ended this Gmail connection'), { status: 401, expired: true });
      }
      throw Object.assign(new Error(data.error_description || data.error || `Google said ${res.status}`), { status: 502 });
    }
    return data;
  }

  /** Swap the one-time code for tokens. */
  async function exchange(code) {
    return form(TOKEN_URL, {
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    });
  }

  /** A fresh access token. These last an hour; the refresh token is what we
   *  store, so this runs at the start of every scan. */
  async function accessFrom(refreshToken) {
    const data = await form(TOKEN_URL, {
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
    });
    return data.access_token;
  }

  /** Hand the grant back to Google. Deleting our copy while Google still
   *  believes the app has access is the dishonest version of disconnecting. */
  async function revoke(token) {
    try {
      await fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
      return true;
    } catch (e) {
      return false;   // best effort: the local record goes either way
    }
  }

  async function api(accessToken, path) {
    const res = await fetchImpl(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error((data.error && data.error.message) || `Gmail said ${res.status}`), { status: res.status === 401 ? 401 : 502 });
    }
    return data;
  }

  /** Which address this grant belongs to, so the account page can show whose
   *  mailbox is connected rather than just "connected". */
  async function address(accessToken) {
    const me = await api(accessToken, '/profile');
    return me.emailAddress || null;
  }

  /** Up to MAX_MESSAGES ids, taken round-robin across the groups: the newest
   *  of each group first, then the second newest of each, and so on. One
   *  group failing does not sink the scan - the others still answer - but a
   *  401 does, because that is the whole connection, not one query. */
  async function search(accessToken, now = new Date()) {
    const lists = await Promise.all(searchQueries(now).map(({ q }) =>
      api(accessToken, `/messages?q=${encodeURIComponent(q)}&maxResults=${MAX_MESSAGES}`)
        .then((d) => (d.messages || []).map((m) => m.id))
        .catch((e) => { if (e.status === 401) throw e; return []; })));
    const out = [];
    const seen = new Set();
    for (let i = 0; out.length < MAX_MESSAGES && lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        if (i < l.length && !seen.has(l[i]) && out.length < MAX_MESSAGES) { seen.add(l[i]); out.push(l[i]); }
      }
    }
    return out;
  }

  /** A message flattened to what the extractor needs: who, when, and the
   *  plain text. HTML parts are ignored rather than stripped - a booking
   *  confirmation that has no text/plain part is rare, and guessing at markup
   *  is how you feed a model a page of CSS. */
  async function message(accessToken, id) {
    const m = await api(accessToken, `/messages/${id}?format=full`);
    const headers = {};
    for (const h of ((m.payload && m.payload.headers) || [])) headers[String(h.name).toLowerCase()] = h.value;
    return {
      id: m.id,
      from: headers.from || '',
      subject: headers.subject || '',
      date: headers.date || '',
      snippet: m.snippet || '',
      body: plainText(m.payload).slice(0, BODY_CHARS),
    };
  }

  return { enabled, authUrl, exchange, accessFrom, revoke, address, search, message, searchQueries, SCOPE, TRAVEL_SENDERS, SENDER_GROUPS, MONTHS_BACK, MAX_MESSAGES };
}

/** The message as text: the first text/plain part, depth first. Failing
 *  that, the first text/html part with its markup taken out - a forward from
 *  a work mail client is often HTML only, and returning nothing there meant a
 *  message the search had found reached the extractor as a blank. */
function plainText(payload) {
  return firstPart(payload, 'text/plain') || htmlToText(firstPart(payload, 'text/html'));
}

function firstPart(payload, type) {
  if (!payload) return '';
  if (payload.mimeType === type && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of (payload.parts || [])) {
    const found = firstPart(part, type);
    if (found) return found;
  }
  return '';
}

/** Enough of an HTML-to-text pass for an extractor: the style and script
 *  blocks go whole (otherwise the model reads a page of CSS), block tags
 *  become line breaks, the rest of the markup goes, and the common entities
 *  come back as characters. */
function htmlToText(html) {
  if (!html) return '';
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table)\b[^>]*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (named[k] !== undefined) return named[k];
      if (k[0] === '#') {
        const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
      }
      return m;
    })
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim();
}

module.exports = { create, plainText, TRAVEL_SENDERS, SENDER_GROUPS, SCOPE, MONTHS_BACK, MAX_MESSAGES, BODY_CHARS };
