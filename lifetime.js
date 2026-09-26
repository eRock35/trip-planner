/**
 * A person's lifetime passport: every brewery they have been checked in at,
 * across every crawl on every trip they can open - their own and the ones
 * shared with them - and the beers THEY logged, with milestones.
 *
 * Computed on read from the crawls themselves, never stored: a check-in
 * undone, a crawl deleted or a trip left simply stops counting the next time
 * it is drawn, with no second copy to keep in step. The server hands this
 * module only trips the person owns or is a member of (the same test
 * loadOwnedTrip makes); it trusts that and does no access checks of its own.
 *
 * Check-ins are the trip's, not a person's (a crawl's `visits` map carries no
 * uid - whoever is on the trip was there), so a shared trip's stamps are in
 * every member's passport. Pours carry `by`, so the beer count, ratings and
 * styles are the person's own.
 */

const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const lower = (s) => norm(s).toLowerCase();
const isoOr = (s) => (typeof s === 'string' && !isNaN(Date.parse(s)) ? s : null);

/**
 * The milestones, in the order they are drawn. `need` of `stat`; the hint is
 * shown on a locked badge, so it says how to earn it rather than what it is.
 */
const BADGES = [
  { id: 'first-stamp', title: 'First stamp', stat: 'breweries', need: 1, hint: 'Check in at a brewery on any crawl.' },
  { id: 'first-pour', title: 'First pour', stat: 'beers', need: 1, hint: 'Log a beer at a stop.' },
  { id: 'full-crawl', title: 'Full crawl', stat: 'fullCrawls', need: 1, hint: 'Check in at every stop of a crawl with 3 or more.' },
  { id: 'five-star', title: 'Five-star find', stat: 'fiveStars', need: 1, hint: 'Rate a beer 5 stars.' },
  { id: 'city-hopper', title: 'City hopper', stat: 'cities', need: 3, hint: 'Check in at breweries in 3 cities.' },
  { id: 'ten-taprooms', title: 'Ten taprooms', stat: 'breweries', need: 10, hint: 'Check in at 10 different breweries.' },
  { id: 'style-explorer', title: 'Style explorer', stat: 'styles', need: 10, hint: 'Log beers in 10 different styles.' },
  { id: 'regular', title: 'Crawl regular', stat: 'crawls', need: 5, hint: 'Check in on 5 different crawls.' },
  { id: 'five-states', title: 'Five states', stat: 'states', need: 5, hint: 'Check in in 5 states or provinces.' },
  { id: 'twenty-five-pours', title: '25 pours', stat: 'beers', need: 25, hint: 'Log 25 beers.' },
  { id: 'quarter-century', title: 'Quarter century', stat: 'breweries', need: 25, hint: 'Check in at 25 different breweries.' },
  { id: 'world-tour', title: 'Passport stamped', stat: 'countries', need: 2, hint: 'Check in at breweries in 2 countries.' },
  { id: 'half-century', title: 'Fifty breweries', stat: 'breweries', need: 50, hint: 'Check in at 50 different breweries.' },
  { id: 'centurion', title: 'Centurion', stat: 'beers', need: 100, hint: 'Log 100 beers.' },
];

/** The times at which each new distinct key first appeared, in order: the
 *  Nth entry is when a count of N was reached. */
function firsts(events) {
  const seen = new Set();
  const out = [];
  for (const e of events.filter((x) => x.at).sort((a, b) => a.at.localeCompare(b.at))) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e.at);
  }
  return out;
}

/**
 * `trips`: [{ id, crawls: [{ crawl: crawlOut(...), pours: [...] }] }].
 * `uid`: whose beers count. `opts.stampLimit` bounds the list drawn.
 */
function passport(trips, uid, opts) {
  const o = opts || {};
  const stamps = new Map();                  // brewery id -> first check-in
  const breweryEv = [], cityEv = [], stateEv = [], countryEv = [], crawlEv = [], beerEv = [], styleEv = [], fiveEv = [], fullEv = [];
  const cities = new Map(), states = new Map(), countries = new Map();
  let beers = 0, rated = 0, sum = 0, top = null, crawlsWithStamp = 0;
  const tripsWith = new Set();

  for (const t of Array.isArray(trips) ? trips : []) {
    for (const c of Array.isArray(t.crawls) ? t.crawls : []) {
      const crawl = c && c.crawl;
      if (!crawl || !Array.isArray(crawl.stops)) continue;
      const names = new Map(crawl.stops.map((s) => [s.id, s.name]));
      const visited = crawl.stops.filter((s) => isoOr(s.visitedAt));
      if (visited.length) {
        crawlsWithStamp += 1;
        tripsWith.add(t.id);
        crawlEv.push({ key: t.id + '/' + crawl.id, at: visited.map((s) => s.visitedAt).sort()[0] });
        if (crawl.stops.length >= 3 && visited.length === crawl.stops.length) {
          fullEv.push({ key: t.id + '/' + crawl.id, at: visited.map((s) => s.visitedAt).sort().pop() });
        }
      }
      for (const s of visited) {
        const at = s.visitedAt;
        breweryEv.push({ key: s.id, at });
        const prev = stamps.get(s.id);
        if (!prev || at < prev.visitedAt) {
          stamps.set(s.id, { id: s.id, name: norm(s.name).slice(0, 120), city: norm(s.city).slice(0, 60), state: norm(s.state).slice(0, 60), country: norm(s.country).slice(0, 60), visitedAt: at });
        }
        const country = norm(s.country), state = norm(s.state), city = norm(s.city);
        if (country) { countryEv.push({ key: lower(country), at }); countries.set(lower(country), country); }
        if (state) { const k = lower(country) + '|' + lower(state); stateEv.push({ key: k, at }); states.set(k, state); }
        if (city) { const k = lower(country) + '|' + lower(state) + '|' + lower(city); cityEv.push({ key: k, at }); cities.set(k, city); }
      }
      for (const p of Array.isArray(c.pours) ? c.pours : []) {
        if (!p || p.by !== uid) continue;
        const at = isoOr(p.at);
        beers += 1;
        beerEv.push({ key: t.id + '/' + crawl.id + '/' + (p.id || beers), at });
        if (norm(p.style)) styleEv.push({ key: lower(p.style), at });
        if (Number.isInteger(p.rating) && p.rating >= 1 && p.rating <= 5) {
          rated += 1; sum += p.rating;
          if (p.rating === 5) fiveEv.push({ key: t.id + '/' + crawl.id + '/' + (p.id || beers), at });
          if (!top || p.rating > top.rating || (p.rating === top.rating && String(p.at) > String(top.at))) {
            top = { beer: norm(p.beer).slice(0, 80), style: norm(p.style).slice(0, 60), rating: p.rating, at: p.at || null, brewery: norm(names.get(p.stopId)).slice(0, 120) };
          }
        }
      }
    }
  }

  const when = {
    breweries: firsts(breweryEv), cities: firsts(cityEv), states: firsts(stateEv), countries: firsts(countryEv),
    crawls: firsts(crawlEv), beers: firsts(beerEv), styles: firsts(styleEv), fiveStars: firsts(fiveEv), fullCrawls: firsts(fullEv),
  };
  const stats = {
    breweries: stamps.size, cities: cities.size, states: states.size, countries: countries.size,
    crawls: crawlsWithStamp, beers, styles: new Set(styleEv.map((e) => e.key)).size,
    fiveStars: fiveEv.length, fullCrawls: fullEv.length,
  };
  const badges = BADGES.map((b) => {
    const have = stats[b.stat] || 0;
    const earned = have >= b.need;
    return {
      id: b.id, title: b.title, hint: b.hint, need: b.need, have: Math.min(have, b.need), earned,
      earnedAt: earned ? (when[b.stat][b.need - 1] || null) : null,
    };
  });
  // The one to show as "next": the locked badge closest to done.
  const locked = badges.filter((b) => !b.earned).sort((a, b) => (b.have / b.need) - (a.have / a.need) || a.need - b.need);
  const limit = o.stampLimit || 60;
  return {
    breweries: stats.breweries, beers, cities: stats.cities, states: stats.states, countries: stats.countries,
    crawls: stats.crawls, trips: tripsWith.size, styles: stats.styles,
    avgRating: rated ? Math.round((sum / rated) * 10) / 10 : null,
    top,
    places: {
      states: Array.from(states.values()).sort(),
      countries: Array.from(countries.values()).sort(),
    },
    stamps: Array.from(stamps.values()).sort((a, b) => b.visitedAt.localeCompare(a.visitedAt)).slice(0, limit),
    badges,
    earned: badges.filter((b) => b.earned).length,
    next: locked[0] || null,
  };
}

module.exports = { passport, BADGES };
