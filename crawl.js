/**
 * Brewery crawls: the route, the clock and the links.
 *
 * Pure on purpose - no network, no database, no clock of its own - so every
 * number the page shows about a crawl (which order, how far, when you arrive,
 * when you have to leave, which leg needs a car) is something a test can pin
 * down. The routes in server.js load and store; this decides.
 *
 * Where it came from. Hopscotch (eRock35/beer-app, server/src/domain/geo.js)
 * already had the geometry: haversine, a nearest-neighbour route tidied with
 * 2-opt, and a walking estimate. Ported here to CommonJS, and taken further in
 * the ways that mattered once a crawl is something you actually do on a
 * Saturday rather than a list you plan on a plane:
 *
 *   - A CLOCK. Hopscotch said "12 min walk". A crawl here has a start time and
 *     a stay at each stop, so it says "arrive 4:12, leave by 5:10" - and so
 *     can warn that the third stop closes before you would get there.
 *   - LEGS ARE ALONG STREETS, not as the crow flies. Haversine is the straight
 *     line; city streets run 1.2-1.4x that (the "circuity" of a street grid).
 *     A crawl that says 11 minutes when the walk is 14 makes every later
 *     arrival wrong, so each leg is the straight line times STREET_FACTOR.
 *   - A RIDE FOR ONE LEG. Hopscotch's verdict was the whole crawl: walkable or
 *     "you will want a car". Most crawls are three short walks and one long
 *     hop across town, so a leg over RIDE_OVER_KM is marked as a ride on its
 *     own, with a drive estimate and a rideshare link for just that leg.
 *   - THE BEST START. Without a fixed start, nearest-neighbour began at
 *     whichever stop was picked first. bestRoute() tries every stop as the
 *     start and keeps the shortest path.
 *
 * Legs and times are COMPUTED from the stops' order every time a crawl is
 * read, never stored: reorder, drop a stop or change the start time and there
 * is nothing stale to forget to update.
 */

const R_KM = 6371;
const KM_TO_MI = 0.621371;
const WALK_KMH = 4.5;            // Hopscotch's "realistic" pace, kept
const RIDE_KMH = 30;             // in town, lights and all
const RIDE_PICKUP_MIN = 5;       // waiting for the car, or parking it
const RIDE_OVER_KM = 1.6;        // ~1 mile, a 20-minute walk at 4.5 km/h
const STREET_FACTOR = 1.25;      // streets vs the straight line
const DEFAULT_START = '15:00';
const DEFAULT_DWELL = 60;
const MIN_DWELL = 20;
const MAX_DWELL = 180;
const MAX_STOPS = 10;
const TAG = '\u{1F37A} ';        // "🍺 " - how the itinerary knows a block came from a crawl

// Open Brewery DB types with no taproom to walk into. "planning" is what the
// directory actually says; "planned" is here too because people (and older
// data) say that.
const SKIP_TYPES = ['planned', 'planning', 'closed', 'contract', 'proprietor'];

const clean = (v, n) => String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const toRad = (d) => (d * Math.PI) / 180;
const hasCoords = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

/* ------------------------------------------------------------------ *
 * Geometry (ported from Hopscotch)
 * ------------------------------------------------------------------ */

/** Great-circle distance in km, or null when either end has no coordinates. */
function haversineKm(a, b) {
  if (!hasCoords(a) || !hasCoords(b)) return null;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

const kmToMiles = (km) => (km == null ? null : km * KM_TO_MI);

/** A leg as walked or driven: the straight line, stretched to the streets. */
function legKm(a, b) {
  const km = haversineKm(a, b);
  return km == null ? null : km * STREET_FACTOR;
}

/**
 * Nearest-neighbour from the start, then 2-opt until nothing improves. For
 * the handful of stops anyone walks in an afternoon this lands on the optimal
 * order essentially every time, in microseconds.
 *
 * `start` is an optional fixed point the route leaves from (the last stop
 * already visited, say); it is not part of the answer. Stops with no
 * coordinates cannot be placed, so they keep their relative order at the end
 * rather than being dropped - Hopscotch dropped them, which silently lost a
 * stop from a saved crawl.
 */
function planRoute(stops, start) {
  const list = Array.isArray(stops) ? stops : [];
  const points = list.filter(hasCoords);
  const unplaced = list.filter((s) => !hasCoords(s));
  if (points.length <= 2 && !hasCoords(start)) return points.concat(unplaced);

  const origin = hasCoords(start) ? start : points[0];
  const remaining = points.slice();
  const order = [];
  let cursor = origin;
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(cursor, remaining[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    cursor = remaining[bestIdx];
    order.push(cursor);
    remaining.splice(bestIdx, 1);
  }

  const length = (route) => {
    let total = haversineKm(origin, route[0]) || 0;
    for (let i = 1; i < route.length; i++) total += haversineKm(route[i - 1], route[i]) || 0;
    return total;
  };

  let best = order;
  let bestLen = length(best);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best.slice(0, i).concat(best.slice(i, j + 1).reverse(), best.slice(j + 1));
        const len = length(candidate);
        if (len < bestLen - 1e-9) { best = candidate; bestLen = len; improved = true; }
      }
    }
  }
  return best.concat(unplaced);
}

/**
 * Where a new stop costs the least extra distance: the index to insert it at,
 * no earlier than `from` (the stops already visited stay where they are - a
 * stop added mid-crawl belongs somewhere ahead, not behind you).
 */
function cheapestInsert(stops, stop, from) {
  const list = Array.isArray(stops) ? stops : [];
  const min = Math.max(0, Math.min(list.length, from || 0));
  if (!hasCoords(stop) || !list.length) return list.length;
  let best = list.length, bestCost = Infinity;
  for (let i = min; i <= list.length; i++) {
    const before = list[i - 1], after = list[i];
    const cost = (before ? haversineKm(before, stop) || 0 : 0) + (after ? haversineKm(stop, after) || 0 : 0)
      - (before && after ? haversineKm(before, after) || 0 : 0);
    if (cost < bestCost - 1e-9) { bestCost = cost; best = i; }
  }
  return best;
}

/** Total length of a route in straight-line km, stop to stop. */
function pathKm(route) {
  let total = 0;
  for (let i = 1; i < route.length; i++) total += haversineKm(route[i - 1], route[i]) || 0;
  return total;
}

/**
 * The shortest open path through the stops, from whichever stop makes it
 * shortest. planRoute() with no start begins at the first stop it is handed,
 * which is whichever one the person happened to tick first - and the shortest
 * crawl rarely starts there. Ten stops is ten tiny runs.
 */
function bestRoute(stops) {
  const list = Array.isArray(stops) ? stops : [];
  const placed = list.filter(hasCoords);
  if (placed.length <= 2) return planRoute(list);
  let best = planRoute(list);
  let bestLen = pathKm(best.filter(hasCoords));
  for (const s of placed) {
    // Nearest-neighbour from `s` picks `s` first (distance 0), so the route
    // starts there; 2-opt then tidies the rest.
    const candidate = planRoute(list, s);
    const len = pathKm(candidate.filter(hasCoords));
    if (len < bestLen - 1e-9) { best = candidate; bestLen = len; }
  }
  return best;
}

/** Legs with distance and a walking estimate - Hopscotch's shape, kept for
 *  anything that only wants the walk, with the street factor applied. */
function describeRoute(route, start) {
  const legs = [];
  let prev = hasCoords(start) ? start : null;
  let totalKm = 0;
  for (const stop of route) {
    const km = prev ? legKm(prev, stop) : 0;
    totalKm += km || 0;
    legs.push({
      to: stop,
      km: km == null ? null : round(km, 2),
      miles: km == null ? null : round(kmToMiles(km), 2),
      walkMinutes: km == null ? null : Math.round((km / WALK_KMH) * 60),
    });
    prev = stop;
  }
  return {
    legs,
    totalKm: round(totalKm, 2),
    totalMiles: round(kmToMiles(totalKm), 2),
    totalWalkMinutes: Math.round((totalKm / WALK_KMH) * 60),
    walkable: totalKm <= 5,
  };
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

/** "15:40" -> 940, or null. */
function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm == null ? '' : hhmm).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** 940 -> "15:40". Past midnight wraps: 1470 -> "00:30". */
function clock(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
/** 1260 -> "9 PM", 1280 -> "9:20 PM". `full` keeps the minutes on the hour
 *  ("9:00 PM"), which is how the itinerary writes its times. */
function clock12(min, full) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (mm || full ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM');
}

const dwellOf = (v, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_DWELL, Math.max(MIN_DWELL, Math.round(n)));
};
const walkMinutes = (km) => Math.max(1, Math.round((km / WALK_KMH) * 60));
const rideMinutes = (km) => Math.round((km / RIDE_KMH) * 60) + RIDE_PICKUP_MIN;

/**
 * When you get to each stop and when you leave it, and the leg before it.
 *
 * Per stop: {id, arrive, leave ('HH:MM'), arriveMinutes, leaveMinutes (from
 * midnight of the crawl's day - past 1440 means after midnight), dwellMinutes,
 * legKm, legMiles, legMinutes, legMode ('walk' | 'ride', null for the first)}.
 *
 * In walk mode a leg longer than RIDE_OVER_KM is a ride with a drive estimate
 * - the page offers a car for that leg alone. In drive mode every leg is.
 */
function schedule(crawl) {
  const c = crawl || {};
  const stops = Array.isArray(c.stops) ? c.stops : [];
  const drive = c.mode === 'drive';
  const start = toMinutes(c.startTime) != null ? toMinutes(c.startTime) : toMinutes(DEFAULT_START);
  const baseDwell = dwellOf(c.dwellMinutes, DEFAULT_DWELL);
  const rows = [];
  let t = start;
  let totalKm = 0, walkMin = 0, rideMin = 0, rideLegs = 0, longLegs = 0;
  stops.forEach((s, i) => {
    let km = null, minutes = null, mode = null;
    if (i > 0) {
      km = legKm(stops[i - 1], s);
      if (km == null) km = 0;               // no coordinates: no leg we can time
      const ride = drive || km > RIDE_OVER_KM;
      if (km > RIDE_OVER_KM) longLegs += 1;
      mode = ride ? 'ride' : 'walk';
      minutes = ride ? rideMinutes(km) : walkMinutes(km);
      if (ride) { rideMin += minutes; rideLegs += 1; } else walkMin += minutes;
      totalKm += km;
      t += minutes;
    }
    const dwell = dwellOf(s && s.dwellMinutes, baseDwell);
    rows.push({
      id: s && s.id,
      arrive: clock(t), leave: clock(t + dwell),
      arriveMinutes: t, leaveMinutes: t + dwell,
      dwellMinutes: dwell,
      legKm: km == null ? null : round(km, 2),
      legMiles: km == null ? null : round(kmToMiles(km), 2),
      legMinutes: minutes,
      legMode: mode,
    });
    t += dwell;
  });
  return {
    stops: rows,
    totals: {
      stops: rows.length,
      km: round(totalKm, 2),
      miles: round(kmToMiles(totalKm), 1),
      walkMinutes: walkMin,
      rideMinutes: rideMin,
      rideLegs,
      startTime: clock(start),
      startMinutes: start,
      endTime: clock(t),
      endMinutes: t,
      endsAfterMidnight: t > 1440,
      // Every leg short enough to walk, whatever mode was chosen - "By car"
      // on a crawl you could walk is worth knowing.
      walkable: longLegs === 0,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Warnings
 * ------------------------------------------------------------------ */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
function weekdayOf(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

/**
 * When a stop closes on the crawl's date, as 'HH:MM', 'closed', or null for
 * "not known". Menus are cached for everyone whose crawl includes the
 * brewery, on whatever date that is, so a single `closesAt` would be one
 * crawl's Saturday applied to someone else's Tuesday. The weekly closing
 * times, when found, answer for any date; `closesAt` only for the date it
 * was looked up for.
 */
function closesFor(menu, isoDay) {
  if (!menu || !isoDay) return null;
  const dow = weekdayOf(isoDay);
  const weekly = menu.weekly && typeof menu.weekly === 'object' ? menu.weekly : null;
  if (weekly && dow != null && weekly[WEEKDAYS[dow]]) return weekly[WEEKDAYS[dow]];
  if (menu.closesAt && menu.closesOn === isoDay) return menu.closesAt;
  return null;
}

/**
 * What might go wrong with the plan: a stop closed or closing before you
 * would leave it, a crawl that runs past midnight, a leg too far to walk.
 * Each is {stopId|null, kind, text}, in the words the page shows.
 */
function warnings(crawl, menus, sched) {
  const c = crawl || {};
  const stops = Array.isArray(c.stops) ? c.stops : [];
  const s = sched || schedule(c);
  const out = [];
  stops.forEach((stop, i) => {
    const row = s.stops[i];
    const closes = closesFor(menus && menus[stop.id], c.date);
    if (closes === 'closed') {
      out.push({ stopId: stop.id, kind: 'closed', text: `${stop.name} is closed on ${WEEKDAY_NAMES[weekdayOf(c.date)]}, going by its listed hours` });
    } else if (closes) {
      let close = toMinutes(closes);
      // "01:00" is one in the morning, after the day it closes for.
      if (close != null && close < 6 * 60) close += 1440;
      if (close != null && row.arriveMinutes >= close) {
        out.push({ stopId: stop.id, kind: 'closed-on-arrival', text: `${stop.name} closes ${clock12(close)} — you'd arrive ${clock12(row.arriveMinutes)}` });
      } else if (close != null && row.leaveMinutes > close) {
        out.push({ stopId: stop.id, kind: 'closes-early', text: `${stop.name} closes ${clock12(close)} — that's ${close - row.arriveMinutes} min there, not ${row.dwellMinutes}` });
      }
    }
    if (c.mode !== 'drive' && row.legMode === 'ride') {
      out.push({ stopId: stop.id, kind: 'ride', text: `${stop.name} is ${row.legMiles} mi from ${stops[i - 1].name} — a ride for that leg, about ${row.legMinutes} min` });
    }
  });
  if (s.totals.endsAfterMidnight) {
    out.push({ stopId: null, kind: 'late', text: `Runs past midnight — the last stop ends at ${clock12(s.totals.endMinutes)}` });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Links - rather than a routing API: no key, no cost, and the phone's own
 * maps app does turn-by-turn better than anything drawn here.
 * ------------------------------------------------------------------ */

const coord = (s) => `${Number(s.lat).toFixed(6)},${Number(s.lng).toFixed(6)}`;

/**
 * {route, stops:[{id, apple, google, uber}]}.
 *
 * `route` is one Google Maps directions link for the whole crawl, stops as
 * waypoints (Google opens up to nine of them on the web, three in its mobile
 * app - enough for most crawls, and every stop has its own link besides).
 * Per stop, Apple Maps and Google directions to it, walking or driving as its
 * leg is; `uber` only on a leg that is a ride (`rows` from schedule()), or on
 * every stop after the first when no schedule is given.
 */
function mapsLinks(stops, mode, rows) {
  const list = (Array.isArray(stops) ? stops : []).filter(hasCoords);
  const travel = mode === 'drive' ? 'driving' : 'walking';
  let route = null;
  if (list.length) {
    const first = list[0], last = list[list.length - 1], mid = list.slice(1, -1);
    route = 'https://www.google.com/maps/dir/?api=1' +
      (list.length > 1 ? '&origin=' + encodeURIComponent(coord(first)) : '') +
      '&destination=' + encodeURIComponent(coord(last)) +
      (mid.length ? '&waypoints=' + encodeURIComponent(mid.map(coord).join('|')) : '') +
      '&travelmode=' + travel;
  }
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  return {
    route,
    stops: list.map((s, i) => {
      const row = byId.get(s.id);
      const ride = row ? row.legMode === 'ride' : (i > 0 && mode === 'drive');
      const wantsUber = row ? row.legMode === 'ride' : i > 0;
      const where = [s.street, s.city].filter(Boolean).join(', ');
      return {
        id: s.id,
        apple: `https://maps.apple.com/?daddr=${encodeURIComponent(coord(s))}&dirflg=${ride ? 'd' : 'w'}`,
        google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(coord(s))}&travelmode=${ride ? 'driving' : 'walking'}`,
        uber: wantsUber
          ? 'https://m.uber.com/ul/?action=setPickup&pickup=my_location' +
            `&dropoff[latitude]=${Number(s.lat).toFixed(6)}&dropoff[longitude]=${Number(s.lng).toFixed(6)}` +
            `&dropoff[nickname]=${encodeURIComponent(String(s.name || 'Next stop'))}` +
            (where ? `&dropoff[formatted_address]=${encodeURIComponent(where)}` : '')
          : null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Open Brewery DB rows, and stops as the page sends them back
 * ------------------------------------------------------------------ */

const STOP_ID = /^[A-Za-z0-9_-]{1,64}$/;
function httpUrl(v) {
  try {
    const u = new URL(String(v || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 300) : '';
  } catch (e) { return ''; }
}
function phone(v) {
  const s = String(v || '').trim();
  return /^[+()\d\s.-]{7,24}$/.test(s) && (s.match(/\d/g) || []).length >= 7 ? s : '';
}
function coordOf(v, limit) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** No taproom to visit: planned, closed, contract-brewed, or a brand with no
 *  place of its own. */
function skipType(type) {
  return SKIP_TYPES.includes(String(type || '').trim().toLowerCase());
}

/**
 * An Open Brewery DB row - or a stop as the page sends it back, which is the
 * same thing already normalised - as a stop: strings, numbers and nothing
 * else. The directory gives coordinates as strings and a website as whatever
 * was typed in; both are drawn into the page, so both are checked here.
 * Returns null for a row with no id or name.
 */
function normaliseBrewery(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id == null ? '' : raw.id).trim();
  const name = clean(raw.name, 120);
  if (!STOP_ID.test(id) || !name) return null;
  return {
    id,
    name,
    type: clean(raw.brewery_type != null ? raw.brewery_type : raw.type, 20).toLowerCase(),
    street: clean(raw.address_1 || raw.street, 120),
    city: clean(raw.city, 60),
    state: clean(raw.state_province || raw.state, 60),
    postalCode: clean(raw.postal_code || raw.postalCode, 20),
    country: clean(raw.country, 60),
    phone: phone(raw.phone),
    website: httpUrl(raw.website_url != null ? raw.website_url : raw.website),
    lat: coordOf(raw.latitude != null ? raw.latitude : raw.lat, 90),
    lng: coordOf(raw.longitude != null ? raw.longitude : raw.lng, 180),
  };
}

/** A stop for a crawl: a normalised brewery that can be placed on a map,
 *  plus its own stay. Visits are server state and never taken from here. */
function cleanStop(raw) {
  const b = normaliseBrewery(raw);
  if (!b || !hasCoords(b)) return null;
  const dwell = raw.dwellMinutes == null || raw.dwellMinutes === '' ? null : dwellOf(raw.dwellMinutes, null);
  return Object.assign(b, { dwellMinutes: dwell });
}

/* ------------------------------------------------------------------ *
 * Into the itinerary
 * ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "2026-10-03" -> "Sat, Oct 3", the way the itinerary labels its days. */
function dayLabel(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** An itinerary time as minutes, as well as free text allows: "3:40 PM",
 *  "15:40", "3 PM", "Noon", "Evening". null when there is nothing to go on. */
function blockMinutes(label) {
  const s = String(label || '').trim().toLowerCase();
  let m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/.exec(s);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3].startsWith('p')) h += 12;
    return h * 60 + Number(m[2] || 0);
  }
  m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const words = { morning: 9 * 60, noon: 12 * 60, lunch: 12 * 60 + 30, afternoon: 14 * 60, evening: 19 * 60, dinner: 19 * 60, night: 21 * 60, 'late night': 23 * 60 };
  for (const w of Object.keys(words)) if (s.startsWith(w)) return words[w];
  return null;
}

/** The line a stop becomes in the itinerary: "🍺 Musa — a pint of Mimi". */
function planText(stop, pick) {
  const order = pick && pick.order ? ' — ' + clean(pick.order, 160) : '';
  return (TAG + clean(stop.name, 120) + order).slice(0, 800);
}

/** Was this block put there by this crawl? Its text starts with the tag and
 *  one of the crawl's stop names - so a second crawl on the same day keeps
 *  its own blocks, and a line someone typed with a beer emoji is left alone. */
function isCrawlBlock(plan, names) {
  const p = String(plan || '');
  if (!p.startsWith(TAG)) return false;
  return names.some((n) => p === TAG + n || p.startsWith(TAG + n + ' — '));
}

/**
 * The itinerary with this crawl in it. `days` is [time, plan] pairs, as
 * schedule.fromStore() gives them. Blocks this crawl added before are taken
 * out first (by `previous.names` as well as the current stops, so a stop
 * removed since goes too), then one block per stop is put in time order into
 * the day with the crawl's date - a new day, in date order, if there is none.
 * A day this crawl created before that is now empty goes with it.
 *
 * Returns {days, date, names} - the last two are what to remember on the
 * crawl for next time.
 */
function addToItinerary(days, crawl, sched, previous) {
  const c = crawl || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.date || ''))) throw Object.assign(new Error('Give the crawl a date first.'), { status: 400 });
  const stops = Array.isArray(c.stops) ? c.stops : [];
  const s = sched || schedule(c);
  const prev = previous || {};
  const names = Array.from(new Set(stops.map((x) => clean(x.name, 120)).concat(Array.isArray(prev.names) ? prev.names : []).filter(Boolean)));

  let out = (Array.isArray(days) ? days : []).map((d) => Object.assign({}, d, {
    blocks: (d.blocks || []).filter((b) => !isCrawlBlock(b[1], names)),
  }));
  out = out.filter((d) => !(prev.createdDay && d.date === prev.createdDay && d.date !== c.date && !d.blocks.length));

  let idx = out.findIndex((d) => d.date === c.date);
  let created = prev.createdDay === c.date ? c.date : null;
  if (idx < 0) {
    const day = {
      title: clean(c.name, 120) || 'Beer crawl',
      date: c.date,
      dateLabel: dayLabel(c.date),
      blocks: [],
      tip: s.totals.walkable ? 'Walkable — comfortable shoes, and water between stops.' : 'Sort the ride for the long leg before you set off.',
    };
    // In date order among the dated days; after everything if none is later.
    const at = out.findIndex((d) => d.date && d.date > c.date);
    if (at < 0) out.push(day); else out.splice(at, 0, day);
    idx = out.indexOf(day);
    created = c.date;
  }

  const picks = c.picks && typeof c.picks === 'object' ? c.picks : {};
  const mine = stops.map((stop, i) => ({ key: s.stops[i].arriveMinutes, own: true,
    block: [clock12(s.stops[i].arriveMinutes, true), planText(stop, picks[stop.id])] }));
  // Existing blocks keep their order; one with no readable time sorts with
  // the block before it, so "Evening" after "8:30 PM" stays after it.
  let last = -1;
  const theirs = out[idx].blocks.map((b) => {
    const k = blockMinutes(b[0]);
    if (k != null) last = k;
    return { key: k != null ? k : last, own: false, block: b };
  });
  const merged = theirs.concat(mine).map((x, i) => Object.assign(x, { i }))
    .sort((a, b) => a.key - b.key || (a.own === b.own ? a.i - b.i : a.own ? 1 : -1))
    .map((x) => x.block);
  out[idx] = Object.assign({}, out[idx], { blocks: merged });
  return { days: out, date: c.date, names: stops.map((x) => clean(x.name, 120)), createdDay: created };
}

/**
 * What the itinerary already has during the crawl: "Dinner at 7:30 PM" on a
 * crawl that runs until nine. Only blocks with a clock time count - "Evening"
 * is too vague to call a clash - and the crawl's own blocks (and any other
 * crawl's) are not a clash with itself.
 */
function clashes(crawl, days, sched) {
  const c = crawl || {};
  if (!c.date) return [];
  const s = sched || schedule(c);
  if (!s.stops.length) return [];
  const day = (Array.isArray(days) ? days : []).find((d) => d && d.date === c.date);
  if (!day) return [];
  const out = [];
  for (const b of day.blocks || []) {
    const time = Array.isArray(b) ? b[0] : b && b.time;
    const plan = String((Array.isArray(b) ? b[1] : b && b.plan) || '');
    if (!plan || plan.startsWith(TAG) || !/\d/.test(String(time || ''))) continue;
    const m = blockMinutes(time);
    if (m == null || m < s.totals.startMinutes || m >= s.totals.endMinutes) continue;
    const what = clean(plan, 60) + (plan.length > 60 ? '\u2026' : '');
    out.push({ stopId: null, kind: 'clash', text: `The itinerary has \u201c${what}\u201d at ${clock12(m)}, during the crawl` });
  }
  return out.slice(0, 3);
}

module.exports = {
  haversineKm, kmToMiles, legKm, planRoute, bestRoute, cheapestInsert, pathKm, describeRoute,
  toMinutes, clock, clock12, dwellOf, schedule, closesFor, warnings, mapsLinks,
  normaliseBrewery, cleanStop, skipType, dayLabel, blockMinutes, planText, isCrawlBlock, addToItinerary, clashes,
  WALK_KMH, RIDE_KMH, RIDE_PICKUP_MIN, RIDE_OVER_KM, STREET_FACTOR, DEFAULT_START, DEFAULT_DWELL,
  MIN_DWELL, MAX_DWELL, MAX_STOPS, SKIP_TYPES, TAG, STOP_ID,
};
