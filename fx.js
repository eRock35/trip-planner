/**
 * Exchange rates for a trip abroad: what the money there is, and what it is
 * worth in the currency the trip is budgeted in.
 *
 * WHERE THE CURRENCY COMES FROM. The destination is already geocoded once
 * and stored on the trip (`geo`, weather.js), and Nominatim's answer carries
 * an ISO 3166 country code. A static map turns that into an ISO 4217
 * currency. No lookup, no model, no guessing from the destination text.
 *
 * WHERE THE RATES COME FROM. Frankfurter (frankfurter.dev), which republishes
 * the European Central Bank's daily reference rates. Chosen for its terms,
 * the same way weather.js chose MET Norway over Open-Meteo: free, no key, no
 * sign-up, and no non-commercial clause - this site sells memberships. The
 * ECB's own terms ask that the rates be treated as reference rates for
 * information, which is exactly how the page labels them: estimates.
 *
 * WHAT IT IS SENT: a base currency code and a list of currency codes. Nothing
 * about the trip, the place, or the person.
 *
 * COST: one request per base currency per six hours per instance, cached in
 * memory. Not Firestore: the source has no quota to protect, and a cold
 * instance paying one HTTPS call instead of one Firestore read gains nothing.
 * Failures are remembered for ten minutes so a source that is down is not
 * asked on every page view. Every failure hides the feature - a rate is
 * decoration on the Overview and an estimate in the Budget, never something a
 * trip can be broken by.
 *
 * Nothing here runs outside a request. The cache is read and filled inside
 * the request that needs it (see "Billed per request" in CLAUDE.md).
 */

const API = 'https://api.frankfurter.dev/v1/latest';
const UA = 'trip-planner/1.0 (+https://trip.strongtechnicalconsulting.com)';
const CACHE_MS = 6 * 3600 * 1000;   // the ECB publishes once a working day
const FAIL_MS = 10 * 60 * 1000;
const ATTRIBUTION = 'Rates: European Central Bank reference rates, via Frankfurter. Estimates, not what a card or a counter will charge.';

// ISO 3166-1 alpha-2 -> ISO 4217. Where a country uses a currency that is not
// its own (Ecuador, Panama's dollar, Kosovo's euro) the map says what is in
// people's pockets. Bulgaria joined the euro on 1 January 2026.
const EUR = ['ad', 'at', 'ax', 'be', 'bg', 'bl', 'cy', 'de', 'ee', 'es', 'fi', 'fr', 'gf', 'gp', 'gr', 'hr', 'ie', 'it', 'lt', 'lu', 'lv',
  'mc', 'me', 'mf', 'mq', 'mt', 'nl', 'pm', 'pt', 're', 'si', 'sk', 'sm', 'tf', 'va', 'xk', 'yt'];
const USD = ['as', 'bq', 'ec', 'fm', 'gu', 'io', 'mh', 'mp', 'pr', 'pw', 'sv', 'tc', 'tl', 'um', 'us', 'vg', 'vi'];
const COUNTRY_CURRENCY = Object.assign(
  Object.fromEntries(EUR.map((c) => [c, 'EUR'])),
  Object.fromEntries(USD.map((c) => [c, 'USD'])),
  {
    ae: 'AED', af: 'AFN', ag: 'XCD', ai: 'XCD', al: 'ALL', am: 'AMD', ao: 'AOA', ar: 'ARS', au: 'AUD', aw: 'AWG', az: 'AZN',
    ba: 'BAM', bb: 'BBD', bd: 'BDT', bf: 'XOF', bh: 'BHD', bi: 'BIF', bj: 'XOF', bm: 'BMD', bn: 'BND', bo: 'BOB', br: 'BRL',
    bs: 'BSD', bt: 'BTN', bw: 'BWP', by: 'BYN', bz: 'BZD', ca: 'CAD', cc: 'AUD', cd: 'CDF', cf: 'XAF', cg: 'XAF', ch: 'CHF',
    ci: 'XOF', ck: 'NZD', cl: 'CLP', cm: 'XAF', cn: 'CNY', co: 'COP', cr: 'CRC', cu: 'CUP', cv: 'CVE', cw: 'ANG', cx: 'AUD',
    cz: 'CZK', dj: 'DJF', dk: 'DKK', dm: 'XCD', do: 'DOP', dz: 'DZD', eg: 'EGP', eh: 'MAD', er: 'ERN', et: 'ETB', fj: 'FJD',
    fk: 'FKP', fo: 'DKK', ga: 'XAF', gb: 'GBP', gd: 'XCD', ge: 'GEL', gg: 'GBP', gh: 'GHS', gi: 'GIP', gl: 'DKK', gm: 'GMD',
    gn: 'GNF', gq: 'XAF', gt: 'GTQ', gw: 'XOF', gy: 'GYD', hk: 'HKD', hn: 'HNL', ht: 'HTG', hu: 'HUF', id: 'IDR', il: 'ILS',
    im: 'GBP', in: 'INR', iq: 'IQD', ir: 'IRR', is: 'ISK', je: 'GBP', jm: 'JMD', jo: 'JOD', jp: 'JPY', ke: 'KES', kg: 'KGS',
    kh: 'KHR', ki: 'AUD', km: 'KMF', kn: 'XCD', kp: 'KPW', kr: 'KRW', kw: 'KWD', ky: 'KYD', kz: 'KZT', la: 'LAK', lb: 'LBP',
    lc: 'XCD', li: 'CHF', lk: 'LKR', lr: 'LRD', ls: 'LSL', ly: 'LYD', ma: 'MAD', md: 'MDL', mg: 'MGA', mk: 'MKD', ml: 'XOF',
    mm: 'MMK', mn: 'MNT', mo: 'MOP', mr: 'MRU', ms: 'XCD', mu: 'MUR', mv: 'MVR', mw: 'MWK', mx: 'MXN', my: 'MYR', mz: 'MZN',
    na: 'NAD', nc: 'XPF', ne: 'XOF', nf: 'AUD', ng: 'NGN', ni: 'NIO', no: 'NOK', np: 'NPR', nr: 'AUD', nu: 'NZD', nz: 'NZD',
    om: 'OMR', pa: 'PAB', pe: 'PEN', pf: 'XPF', pg: 'PGK', ph: 'PHP', pk: 'PKR', pl: 'PLN', pn: 'NZD', ps: 'ILS', py: 'PYG',
    qa: 'QAR', ro: 'RON', rs: 'RSD', ru: 'RUB', rw: 'RWF', sa: 'SAR', sb: 'SBD', sc: 'SCR', sd: 'SDG', se: 'SEK', sg: 'SGD',
    sh: 'SHP', sj: 'NOK', sl: 'SLE', sn: 'XOF', so: 'SOS', sr: 'SRD', ss: 'SSP', st: 'STN', sx: 'ANG', sy: 'SYP', sz: 'SZL',
    td: 'XAF', tg: 'XOF', th: 'THB', tj: 'TJS', tk: 'NZD', tm: 'TMT', tn: 'TND', to: 'TOP', tr: 'TRY', tt: 'TTD', tv: 'AUD',
    tw: 'TWD', tz: 'TZS', ua: 'UAH', ug: 'UGX', uy: 'UYU', uz: 'UZS', vc: 'XCD', ve: 'VES', vn: 'VND', vu: 'VUV', wf: 'XPF',
    ws: 'WST', ye: 'YER', za: 'ZAR', zm: 'ZMW', zw: 'ZWG',
  },
);

/** What a trip can be budgeted in: the ECB's published set, so the home
 *  currency always has rates. Ordered for a picker, common ones first. */
const HOME_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'JPY', 'MXN', 'SEK', 'NOK', 'DKK', 'ISK', 'PLN', 'CZK',
  'HUF', 'RON', 'TRY', 'BRL', 'CNY', 'HKD', 'SGD', 'INR', 'IDR', 'ILS', 'KRW', 'MYR', 'PHP', 'THB', 'ZAR'];
const KNOWN = new Set(Object.values(COUNTRY_CURRENCY).concat(HOME_CURRENCIES));

const code = (v) => { const c = String(v || '').trim().toUpperCase(); return /^[A-Z]{3}$/.test(c) && KNOWN.has(c) ? c : null; };

/** "pt" -> "EUR"; unknown or missing -> null. */
function currencyFor(countryCode) {
  return COUNTRY_CURRENCY[String(countryCode || '').trim().toLowerCase()] || null;
}

/** The currency a trip is budgeted in: its own setting, else US dollars. */
function homeOf(trip) {
  const c = code(trip && trip.homeCurrency);
  return c && HOME_CURRENCIES.includes(c) ? c : 'USD';
}

/** Roughly when the ECB published the rates for `date`: about 16:00 Central
 *  European time, which is 14:00 UTC for most of the travel year. Good
 *  enough to say "updated 3h ago"; the page says the date when it is old. */
const publishedAt = (date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? `${date}T14:00:00.000Z` : null);

function create({ fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const cache = new Map();     // base -> { at, data } | { at, failed: true }
  const inflight = new Map();  // base -> Promise

  /** Every rate against `base`, as the source gives it: 1 base = n other. */
  async function ratesFor(base) {
    const hit = cache.get(base);
    if (hit && hit.failed && now() - hit.at < FAIL_MS) throw new Error('rates recently unavailable');
    if (hit && !hit.failed && now() - hit.at < CACHE_MS) return hit.data;
    if (inflight.has(base)) return inflight.get(base);
    const run = (async () => {
      try {
        const res = await fetchImpl(`${API}?base=${encodeURIComponent(base)}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`rates said ${res.status}`);
        const body = await res.json();
        const rates = {};
        for (const [k, v] of Object.entries((body && body.rates) || {})) {
          if (/^[A-Z]{3}$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 0) rates[k] = v;
        }
        if (!Object.keys(rates).length || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) throw new Error('rates came back empty');
        const data = { base, date: body.date, rates, fetchedAt: new Date(now()).toISOString() };
        cache.set(base, { at: now(), data });
        return data;
      } catch (err) {
        cache.set(base, { at: now(), failed: true });
        throw err;
      } finally {
        inflight.delete(base);
      }
    })();
    inflight.set(base, run);
    return run;
  }

  /**
   * What the page shows. `rate` is the value of ONE unit of the local
   * currency in the home currency (€1 = $1.17 -> 1.17), and `rates` is the
   * same for every currency asked about, so a budget line in any of them can
   * be counted.
   *
   *   status: 'ok'          - local differs from home and has a rate
   *           'same'        - the trip is at home (rates still given for `also`)
   *           'no-currency' - no place, or a country the map does not know
   *           'unsupported' - the source has no rate for the local currency
   *           'unavailable' - the source failed
   */
  async function view({ home, local, also = [] } = {}) {
    home = code(home) || 'USD';
    local = code(local);
    const wanted = [...new Set([local, ...also.map(code)].filter((c) => c && c !== home))].slice(0, 12);
    const base = { home, local, attribution: ATTRIBUTION };
    const statusFor = () => (!local ? 'no-currency' : local === home ? 'same' : null);
    if (!wanted.length) return { ...base, status: statusFor() || 'same', rates: {} };
    let data;
    try { data = await ratesFor(home); } catch (err) { return { ...base, status: 'unavailable', rates: {} }; }
    const rates = {};
    for (const c of wanted) if (data.rates[c]) rates[c] = Number((1 / data.rates[c]).toPrecision(6));
    const out = { ...base, rates, date: data.date, publishedAt: publishedAt(data.date), fetchedAt: data.fetchedAt };
    const s = statusFor();
    if (s) return { ...out, status: s };
    if (!rates[local]) return { ...out, status: 'unsupported' };
    return { ...out, status: 'ok', rate: rates[local] };
  }

  return { ratesFor, view };
}

module.exports = { create, currencyFor, homeOf, code, publishedAt, COUNTRY_CURRENCY, HOME_CURRENCIES, ATTRIBUTION, API };
