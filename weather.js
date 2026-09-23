/**
 * Weather for a trip: where it is, and what the days you are there look like.
 *
 * Two public services, chosen for their terms as much as their data:
 *
 *   - OpenStreetMap's Nominatim turns "Santa Rosa Beach, FL" into a place.
 *     Free with attribution; its policy asks for light use, an identifying
 *     User-Agent and caching - so a trip is geocoded ONCE and the answer is
 *     stored on the trip (`geo`), redone only when the destination changes.
 *   - MET Norway's locationforecast gives a global forecast about nine days
 *     out. Free INCLUDING commercial use, with attribution, and it asks for an
 *     identifying User-Agent too.
 *
 * Open-Meteo was the obvious choice and was not used: its free tier is for
 * non-commercial use, and this site sells memberships.
 *
 * No model call anywhere in here, so it costs nothing and needs no budget.
 * Every failure degrades to "no weather" rather than an error - weather is
 * decoration on the Overview, not something a trip can be broken by.
 */

const UA = 'trip-planner/1.0 (+https://trip.strongtechnicalconsulting.com)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MET = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const HORIZON_DAYS = 9;          // what MET reliably covers
const CACHE_MS = 30 * 60 * 1000; // MET updates roughly hourly; half an hour is polite
const ATTRIBUTION = 'Forecast: MET Norway. Place: © OpenStreetMap contributors.';

/** MET's symbol codes, reduced to a word and an icon family the page draws. */
function describe(symbol) {
  const s = String(symbol || '').replace(/_(day|night|polartwilight)$/, '');
  if (!s) return { label: '', icon: 'cloud' };
  if (s.includes('thunder')) return { label: 'Thunderstorms', icon: 'storm' };
  if (s.includes('snow')) return { label: 'Snow', icon: 'snow' };
  if (s.includes('sleet')) return { label: 'Sleet', icon: 'snow' };
  if (s.includes('heavyrain')) return { label: 'Heavy rain', icon: 'rain' };
  if (s.includes('lightrain')) return { label: s.includes('showers') ? 'Light showers' : 'Light rain', icon: 'rain' };
  if (s.includes('rain')) return { label: s.includes('showers') ? 'Showers' : 'Rain', icon: 'rain' };
  if (s === 'fog') return { label: 'Fog', icon: 'cloud' };
  if (s === 'cloudy') return { label: 'Cloudy', icon: 'cloud' };
  if (s === 'partlycloudy') return { label: 'Partly cloudy', icon: 'partly' };
  if (s === 'fair') return { label: 'Mostly sunny', icon: 'partly' };
  if (s === 'clearsky') return { label: 'Sunny', icon: 'sun' };
  return { label: s.replace(/([a-z])([A-Z])/g, '$1 $2'), icon: 'cloud' };
}

const f = (c) => Math.round(c * 9 / 5 + 32);
const addDays = (isoDay, n) => new Date(Date.parse(isoDay + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function create({ fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  const cache = new Map();

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} said ${res.status}`), { status: res.status });
    return res.json();
  }

  /** "Santa Rosa Beach, FL" -> a place, or null. */
  async function geocode(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const url = `${NOMINATIM}?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
    const rows = await getJson(url);
    const r = Array.isArray(rows) && rows[0];
    if (!r) return null;
    const a = r.address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.suburb || r.name || '';
    const region = a.state || a.region || a.county || '';
    return {
      query: q,
      name: [town, region, a.country_code && a.country_code.toUpperCase() !== 'US' ? a.country : ''].filter(Boolean).join(', ') || r.display_name,
      lat: Number(Number(r.lat).toFixed(4)),
      lon: Number(Number(r.lon).toFixed(4)),
      countryCode: (a.country_code || '').toLowerCase(),
    };
  }

  async function forecastFor(lat, lon) {
    // MET asks for at most four decimals, which also makes the cache key stable.
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.data;
    const data = await getJson(`${MET}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
    cache.set(key, { at: now(), data });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return data;
  }

  /**
   * Bucket MET's timeseries into local days. MET speaks UTC and a place has
   * no timezone attached, so local time is approximated from longitude
   * (15 degrees an hour). An hour off near a DST boundary moves which day a
   * 6-hour slot lands in, not what the day's high was.
   */
  function daily(met, lon) {
    const offsetMs = Math.round(lon / 15) * 3600000;
    const byDay = new Map();
    for (const t of ((met && met.properties && met.properties.timeseries) || [])) {
      const local = new Date(Date.parse(t.time) + offsetMs);
      const day = local.toISOString().slice(0, 10);
      const hour = local.getUTCHours();
      const d = t.data || {};
      const temp = d.instant && d.instant.details && d.instant.details.air_temperature;
      if (!byDay.has(day)) byDay.set(day, { temps: [], symbols: [], precip: 0, midday: false });
      const b = byDay.get(day);
      if (typeof temp === 'number') b.temps.push(temp);
      if (hour >= 11 && hour <= 16) b.midday = true;
      const next = d.next_1_hours || d.next_6_hours;
      if (next && next.summary && next.summary.symbol_code) b.symbols.push({ hour, code: next.summary.symbol_code });
      // Hourly slots early on, six-hourly later: count each hour once.
      if (d.next_1_hours && d.next_1_hours.details) b.precip += d.next_1_hours.details.precipitation_amount || 0;
      else if (d.next_6_hours && d.next_6_hours.details && hour % 6 === 0) b.precip += d.next_6_hours.details.precipitation_amount || 0;
    }
    // A day the forecast only catches the evening of - the first one, most of
    // the time - has a "high" that is really the evening's temperature and
    // read as 73 / 73. Only days whose afternoon is covered are shown; what
    // it is like right now is the separate `now`.
    return [...byDay.entries()].filter(([, b]) => b.temps.length && b.midday).map(([date, b]) => {
      // The day's weather is the afternoon's, which is when anyone is out in it.
      const pick = b.symbols.slice().sort((x, y) => Math.abs(x.hour - 13) - Math.abs(y.hour - 13))[0];
      const w = describe(pick && pick.code);
      return {
        date, hi: f(Math.max(...b.temps)), lo: f(Math.min(...b.temps)),
        label: w.label, icon: w.icon, rainMm: Math.round(b.precip * 10) / 10,
      };
    });
  }

  /**
   * What the Overview shows.
   * @param geo   a place from geocode(), or null
   * @param dates {start, end, precision} from tripdates, or null
   */
  async function forTrip(geo, dates) {
    const base = { attribution: ATTRIBUTION };
    if (!geo) return { ...base, status: 'no-place' };
    const place = { name: geo.name, lat: geo.lat, lon: geo.lon };
    const today = new Date(now() + Math.round(geo.lon / 15) * 3600000).toISOString().slice(0, 10);
    if (dates && dates.precision === 'day') {
      if (dates.end < today) return { ...base, status: 'past', place };
      if (dates.start > addDays(today, HORIZON_DAYS)) {
        return { ...base, status: 'later', place, opensOn: addDays(dates.start, -HORIZON_DAYS) };
      }
    }
    const met = await forecastFor(geo.lat, geo.lon);
    let days = daily(met, geo.lon).filter((d) => d.date >= today).slice(0, HORIZON_DAYS + 1);
    const during = dates && dates.precision === 'day';
    days = days.map((d) => ({ ...d, inTrip: !!(during && d.date >= dates.start && d.date <= dates.end) }));
    const first = met && met.properties && met.properties.timeseries && met.properties.timeseries[0];
    const nowTemp = first && first.data && first.data.instant && first.data.instant.details && first.data.instant.details.air_temperature;
    const nowSym = first && first.data && (first.data.next_1_hours || first.data.next_6_hours);
    return {
      ...base,
      status: 'forecast',
      place,
      // Today where the trip is, which is what "Today" on the strip should
      // mean - not the viewer's clock, which can be a day off across zones.
      today,
      checkedAt: new Date(now()).toISOString(),
      now: typeof nowTemp === 'number' ? { temp: f(nowTemp), ...describe(nowSym && nowSym.summary && nowSym.summary.symbol_code) } : null,
      // Month-precision dates ("December 2026") cannot mark trip days, so the
      // page shows the next few days as "the next few days" instead.
      tripDays: during,
      days,
    };
  }

  return { geocode, forTrip, daily, describe };
}

module.exports = { create, describe, HORIZON_DAYS, ATTRIBUTION, UA };
