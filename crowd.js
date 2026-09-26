/**
 * What every Trip Planner crawler thought of a brewery - anonymously.
 *
 * Counters, and nothing but counters, on the shared `breweries/<id>` document
 * that already holds the menu cache:
 *
 *   crowd: {
 *     <nameKey>: {                 one bucket per brewery NAME, see below
 *       checkins, pours, ratingSum, ratingN,
 *       beers: { <beerKey>: { name, n } }   only beers on the stop's menu
 *     }
 *   }
 *
 * WHAT IS NEVER STORED THERE: a uid, an email, a trip or crawl id, a pour's
 * note, a time, anything a person typed. The only strings are the brewery's
 * name (hashed, as the key) and a beer's name as the shared menu spells it -
 * text a model copied from the brewery's own public tap list. A beer someone
 * typed that is not on that menu still counts toward the rating and the pour
 * total, but never becomes a named row: a free-text name could be anything
 * ("Erik's 40th"), and this document is read by every crawler on the site.
 *
 * WHY A BUCKET PER NAME. The id is one the browser sends, so a crawl could
 * put "Totally Real Brewing" on the route under a real brewery's id and rate
 * it one star twenty times. The menu cache answers the same problem by only
 * reusing an entry for a stop of the same name (crawlmenu.usable); here the
 * name is part of the key, so a stop only ever reads - and writes - the bucket
 * for its own name, and a fake name counts into a bucket nobody with the real
 * name will ever see.
 *
 * IDEMPOTENT BY RECORDING WHAT WAS COUNTED. The crawl keeps `crowd.<stopId>`
 * = the bucket its check-in went into, and each pour keeps `crowd` = exactly
 * what it added ({k, r, b, bn}). Every change is then "take away what was
 * counted, add what is true now" (tally), done in the same transaction as
 * the write it follows - so a second tap, an undo, a 3-star pour edited to 5,
 * a deleted stop or crawl or trip each move the numbers by exactly their own
 * contribution, and a replay moves them by nothing.
 */
const crypto = require('crypto');

/** Nothing is shown until at least this many people-actions back it. */
const THRESHOLD = 5;
/** A bucket's named-beer rows are bounded: menus change, the map must not grow forever. */
const MAX_BEER_ROWS = 120;

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/** The bucket for a brewery name - the same comparison crawlmenu's sameName
 *  makes (case and surrounding space), plus runs of spaces. */
function nameKey(name) { const n = norm(name); return n ? 'n' + hash(n) : null; }
function beerKey(name) { const n = norm(name); return n ? 'b' + hash(n) : null; }

/** Ids that must never feed the counters: the example trip's made-up stops. */
function countable(stop) {
  return !!(stop && typeof stop.id === 'string' && stop.id && !/^demo-/i.test(stop.id) && nameKey(stop.name));
}

/** A check-in's contribution: the bucket it counted into, or null. */
function checkinMark(stop) { return countable(stop) ? nameKey(stop.name) : null; }

/**
 * A pour's contribution. `entry` is the brewery document: its menu, when
 * usable for this stop (same name), is what decides whether the beer becomes
 * a named row, spelled as the menu spells it; its bucket, whether there is
 * still room for a new row.
 */
function pourMark(stop, pour, entry) {
  if (!countable(stop) || !pour) return null;
  const k = nameKey(stop.name);
  const r = Number.isInteger(pour.rating) && pour.rating >= 1 && pour.rating <= 5 ? pour.rating : null;
  let b = null, bn = null;
  const menu = entry && entry.menu && norm(entry.name) === norm(stop.name) ? entry.menu : null;
  const beers = menu && Array.isArray(menu.beers) ? menu.beers : [];
  const want = norm(pour.beer);
  const hit = want ? beers.find((x) => x && norm(x.name) === want) : null;
  if (hit) {
    b = beerKey(hit.name); bn = String(hit.name).replace(/[<>]/g, '').slice(0, 80);
    const rows = entry.crowd && entry.crowd[k] && entry.crowd[k].beers && typeof entry.crowd[k].beers === 'object' ? entry.crowd[k].beers : {};
    const live = Object.keys(rows).filter((x) => rows[x] && Number(rows[x].n) > 0);
    if (!live.includes(b) && live.length >= MAX_BEER_ROWS) { b = null; bn = null; }
  }
  return { k, r, b, bn };
}

/**
 * A running total of counter changes, per brewery id. Every write adds
 * "what is true now" and takes away "what was counted", and write() turns
 * the net into one merge per brewery - a whole crawl being deleted is one
 * write to each brewery on it, not one per pour.
 */
function tally() {
  const by = new Map();                      // breweryId -> nameKey -> {n, beers}
  const bucket = (id, k) => {
    if (!by.has(id)) by.set(id, {});
    const t = by.get(id);
    return (t[k] = t[k] || { n: {}, beers: {} });
  };
  const add = (id, k, field, v) => { if (id && k && v) { const b = bucket(id, k); b.n[field] = (b.n[field] || 0) + v; } };
  const apply = (id, kind, mark, sign) => {
    if (!mark) return;
    if (kind === 'checkin') { add(id, typeof mark === 'string' ? mark : mark.k, 'checkins', sign); return; }
    if (typeof mark !== 'object' || !mark.k) return;
    add(id, mark.k, 'pours', sign);
    if (Number.isInteger(mark.r) && mark.r >= 1 && mark.r <= 5) { add(id, mark.k, 'ratingSum', sign * mark.r); add(id, mark.k, 'ratingN', sign); }
    if (mark.b) {
      const row = bucket(id, mark.k).beers[mark.b] = bucket(id, mark.k).beers[mark.b] || { n: 0, name: '' };
      row.n += sign;
      if (sign > 0 && mark.bn) row.name = mark.bn;
    }
  };
  return {
    /** A change from `before` to `after` (either may be null). */
    change(id, kind, before, after) { apply(id, kind, before, -1); apply(id, kind, after, +1); return this; },
    /** [{id, data}] - data for set(data, {merge: true}); `inc` is
     *  FieldValue.increment. Breweries whose net is zero are left out. */
    writes(inc) {
      const out = [];
      for (const [id, t] of by) {
        const crowd = {};
        for (const [k, b] of Object.entries(t)) {
          const o = {};
          for (const [f, v] of Object.entries(b.n)) if (v) o[f] = inc(v);
          const beers = {};
          for (const [bk, row] of Object.entries(b.beers)) if (row.n) beers[bk] = row.name ? { name: row.name, n: inc(row.n) } : { n: inc(row.n) };
          if (Object.keys(beers).length) o.beers = beers;
          if (Object.keys(o).length) crowd[k] = o;
        }
        if (Object.keys(crowd).length) out.push({ id, data: { crowd } });
      }
      return out;
    },
  };
}

/**
 * What a stop shows, from the brewery document, for a stop of this name.
 * Each number appears only when at least THRESHOLD actions back it, so a
 * figure can never describe one person's evening. null when there is
 * nothing to show at all.
 */
function summary(entry, stop) {
  if (!entry || !entry.crowd || typeof entry.crowd !== 'object' || !countable(stop)) return null;
  const b = entry.crowd[nameKey(stop.name)];
  if (!b || typeof b !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const checkins = num(b.checkins), ratingN = num(b.ratingN), ratingSum = num(b.ratingSum), pours = num(b.pours);
  const out = { checkins: null, rating: null, ratings: null, topBeer: null };
  if (checkins >= THRESHOLD) out.checkins = checkins;
  if (ratingN >= THRESHOLD) {
    const avg = ratingSum / ratingN;
    if (avg >= 1 && avg <= 5) { out.rating = Math.round(avg * 10) / 10; out.ratings = ratingN; }
  }
  let top = null;
  for (const row of Object.values(b.beers && typeof b.beers === 'object' ? b.beers : {})) {
    const n = num(row && row.n), name = String((row && row.name) || '').replace(/[<>]/g, '').slice(0, 80).trim();
    if (!name || n < THRESHOLD) continue;
    if (!top || n > top.n) top = { name, n };
  }
  if (top && pours >= THRESHOLD) out.topBeer = top;
  return out.checkins || out.rating || out.topBeer ? out : null;
}

module.exports = { THRESHOLD, MAX_BEER_ROWS, nameKey, beerKey, countable, checkinMark, pourMark, tally, summary };
