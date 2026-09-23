/**
 * Breweries near a place, from Open Brewery DB.
 *
 * Free, no key, community-maintained (openbrewerydb.org): names, types,
 * addresses, coordinates, phones and websites for breweries worldwide. What it
 * does NOT have is anything that changes - hours, tap lists, food - which is
 * why menus are a separate, metered web lookup (crawlmenu.js).
 *
 * Polite in the same ways weather.js is with Nominatim and MET Norway: an
 * identifying User-Agent, and answers cached in memory for an hour, so a
 * picker opened twice, or by two people on one trip, asks once. The cache is
 * per instance and dies with it, which is fine: it exists to be kind to a
 * free service, not to be a database.
 *
 * Every failure is a sentence a person can act on - "the brewery directory
 * didn't answer" - thrown with a status, never a stack trace on the page.
 */

const crawlLib = require('./crawl');
const { UA } = require('./weather');

const API = 'https://api.openbrewerydb.org/v1/breweries';
const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;
const PER_PAGE = 50;

const sentence = (text, status) => Object.assign(new Error(text), { status: status || 503, sentence: true });

function create({ fetchImpl = (...a) => fetch(...a), now = () => Date.now(), ttlMs = TTL_MS, timeoutMs = TIMEOUT_MS } = {}) {
  const cache = new Map();

  async function getJson(url) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      let res;
      try {
        res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: controller ? controller.signal : undefined });
      } catch (err) {
        if (err && err.name === 'AbortError') throw sentence('The brewery directory took too long to answer. Try again in a moment.');
        throw sentence('Couldn’t reach the brewery directory. Try again in a moment.');
      }
      if (res.status === 429) throw sentence('The brewery directory is busy right now. Give it a minute.');
      if (!res.ok) throw sentence(`The brewery directory answered ${res.status}. Try again in a moment.`);
      try { return await res.json(); } catch (e) { throw sentence('The brewery directory sent something unreadable. Try again in a moment.'); }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Breweries around a point, nearest first, each with its distance. Skips
   * the ones with no taproom (crawl.skipType) and any with no coordinates -
   * a stop that cannot go on the map cannot go on a route.
   */
  async function nearby(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw sentence('No place to search around.', 400);
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    const hit = cache.get(key);
    let rows;
    if (hit && now() - hit.at < ttlMs) rows = hit.rows;
    else {
      const raw = await getJson(`${API}?by_dist=${encodeURIComponent(key)}&per_page=${PER_PAGE}`);
      rows = Array.isArray(raw) ? raw : [];
      cache.set(key, { at: now(), rows });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
    }
    const centre = { lat, lng };
    return rows
      .map(crawlLib.normaliseBrewery)
      .filter((b) => b && b.lat != null && b.lng != null && !crawlLib.skipType(b.type))
      .map((b) => {
        const km = crawlLib.haversineKm(centre, b);
        return Object.assign(b, { km: Math.round(km * 100) / 100, miles: Math.round(crawlLib.kmToMiles(km) * 100) / 100 });
      })
      .sort((a, b) => a.km - b.km);
  }

  return { nearby };
}

module.exports = { create, API, TTL_MS };
