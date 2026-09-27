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

/**
 * ONE VOICE PER ACCOUNT (2026-09-27). Each account counts at most one
 * check-in per brewery bucket, and one pour per beer per bucket (a beer not
 * on the menu shares one slot, "other"). Who holds a voice is recorded
 * OUTSIDE the shared document, at crowd-voices/<voiceId>, where voiceId is an
 * HMAC of uid, brewery id, bucket and slot under a key derived from
 * SESSION_SECRET: nothing there or here reads back to an account. The voice
 * document holds only `holder`, the crawl stop or pour that has it, so it can
 * be found and released; the mark on that stop or pour carries the id (`v`),
 * so releasing never needs the uid - which is what lets a trip member undo a
 * check-in someone else made.
 */
function voiceId(key, uid, breweryId, k, slot) {
  return crypto.createHmac('sha256', key).update([String(uid), String(breweryId), String(k), String(slot)].join('\n')).digest('hex').slice(0, 40);
}
/** A pour's slot within its bucket: its menu beer, or one shared "other". */
const pourSlot = (mark) => (mark && mark.b ? mark.b : 'other');
/** Check-in marks were plain bucket keys before voices; read both. */
function checkinOf(mark) {
  if (!mark) return null;
  if (typeof mark === 'string') return { k: mark, v: null };
  return mark.k ? { k: mark.k, v: mark.v || null } : null;
}

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
 *
 * COARSE ON PURPOSE (2026-09-27). The threshold decides when a number first
 * appears; on its own it never stopped differencing - read the average
 * before and after one person's pour and (n+1)*after - n*before is their
 * stars. Hopscotch answers that with an even-sized prefix of drinkers, which
 * needs the list of who; these are running sums with nobody's name on them,
 * so the cheap version instead: every count is shown rounded DOWN to a
 * multiple of COUNT_STEP, and the average to the nearest HALF star. One more
 * check-in or pour usually moves nothing at all, and when it does, a count
 * that steps by five and a half-star average do not say what that one person
 * gave. What is left is in CLAUDE.md ("Crowd numbers are coarse").
 */
const COUNT_STEP = 5;
const floorStep = (n) => Math.floor(n / COUNT_STEP) * COUNT_STEP;
const halfStar = (avg) => Math.round(avg * 2) / 2;
function summary(entry, stop) {
  if (!entry || !entry.crowd || typeof entry.crowd !== 'object' || !countable(stop)) return null;
  const b = entry.crowd[nameKey(stop.name)];
  if (!b || typeof b !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
  const checkins = num(b.checkins), ratingN = num(b.ratingN), ratingSum = num(b.ratingSum), pours = num(b.pours);
  const out = { checkins: null, rating: null, ratings: null, topBeer: null };
  if (checkins >= THRESHOLD) out.checkins = floorStep(checkins);
  if (ratingN >= THRESHOLD) {
    const avg = ratingSum / ratingN;
    if (avg >= 1 && avg <= 5) { out.rating = halfStar(avg); out.ratings = floorStep(ratingN); }
  }
  // The most-poured beer by its STEPPED count, a tie going to the name: one
  // more pour of a beer changes which one is named only when it crosses a
  // step, never because it is one ahead.
  let top = null;
  for (const row of Object.values(b.beers && typeof b.beers === 'object' ? b.beers : {})) {
    const n = floorStep(num(row && row.n)), name = String((row && row.name) || '').replace(/[<>]/g, '').slice(0, 80).trim();
    if (!name || n < THRESHOLD) continue;
    if (!top || n > top.n || (n === top.n && name.localeCompare(top.name) < 0)) top = { name, n };
  }
  if (top && pours >= THRESHOLD) out.topBeer = top;
  return out.checkins || out.rating || out.topBeer ? out : null;
}

module.exports = { THRESHOLD, COUNT_STEP, MAX_BEER_ROWS, nameKey, beerKey, countable, checkinMark, pourMark, tally, summary, voiceId, pourSlot, checkinOf };
