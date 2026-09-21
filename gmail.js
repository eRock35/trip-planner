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
 * `searchQuery()` takes no user input on purpose. An earlier shape let the
 * caller pass extra terms, which would have made the consent copy a lie the
 * first time anyone used it.
 *
 * ## What is kept
 *
 * The refresh token, encrypted, and nothing else. Message bodies are fetched,
 * read once by the extractor and dropped; only the trip a person chooses to
 * import is written. The scan route never persists a candidate.
 *
 * ## Verification
 *
 * `gmail.readonly` is a RESTRICTED scope. Offering this publicly needs Google
 * app verification plus an annual third-party security assessment (CASA). The
 * app therefore runs in TESTING mode - up to 100 users, each added by address
 * in the Cloud Console, who see an "unverified app" warning once. That ceiling
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
 */
const TRAVEL_SENDERS = [
  // airlines
  'delta.com', 'united.com', 'aa.com', 'southwest.com', 'alaskaair.com',
  'jetblue.com', 'flyfrontier.com', 'spirit.com', 'britishairways.com',
  'aircanada.ca', 'lufthansa.com', 'klm.com', 'airfrance.fr', 'ryanair.com',
  'easyjet.com', 'iberia.com', 'tapairportugal.com',
  // hotels and stays
  'marriott.com', 'hilton.com', 'hyatt.com', 'ihg.com', 'choicehotels.com',
  'wyndhamhotels.com', 'airbnb.com', 'vrbo.com', 'booking.com', 'hotels.com',
  // agencies, rail and cars
  'expedia.com', 'priceline.com', 'kayak.com', 'orbitz.com', 'travelocity.com',
  'amtrak.com', 'eurail.com', 'trainline.com', 'raileurope.com',
  'hertz.com', 'enterprise.com', 'avis.com', 'budget.com',
];

/** How far back a scan looks. A year covers next season's booking and last
 *  season's receipts without trawling a decade of mail. */
const MONTHS_BACK = 12;
/** Ceiling on messages per scan: each one is tokens through the extractor, and
 *  an unbounded scan is an unbounded bill. */
const MAX_MESSAGES = 25;

function create(opts) {
  const {
    clientId = () => process.env.GOOGLE_CLIENT_ID || '',
    clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri = () => process.env.GOOGLE_REDIRECT_URI || '',
    fetchImpl = (...a) => fetch(...a),
  } = opts || {};

  const enabled = () => Boolean(clientId() && clientSecret() && redirectUri());

  /** The Gmail query. No arguments: see the note at the top of this file. */
  function searchQuery(now = new Date()) {
    const after = new Date(now);
    after.setMonth(after.getMonth() - MONTHS_BACK);
    const from = TRAVEL_SENDERS.map((d) => `from:${d}`).join(' OR ');
    return `(${from}) after:${after.toISOString().slice(0, 10).replace(/-/g, '/')}`;
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

  async function search(accessToken, now = new Date()) {
    const q = encodeURIComponent(searchQuery(now));
    const data = await api(accessToken, `/messages?q=${q}&maxResults=${MAX_MESSAGES}`);
    return (data.messages || []).map((m) => m.id);
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
      body: plainText(m.payload).slice(0, 12000),
    };
  }

  return { enabled, authUrl, exchange, accessFrom, revoke, address, search, message, searchQuery, SCOPE, TRAVEL_SENDERS, MONTHS_BACK, MAX_MESSAGES };
}

/** Depth-first walk for the first text/plain part. */
function plainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of (payload.parts || [])) {
    const found = plainText(part);
    if (found) return found;
  }
  return '';
}

module.exports = { create, plainText, TRAVEL_SENDERS, SCOPE, MONTHS_BACK, MAX_MESSAGES };
