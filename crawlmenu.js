/**
 * What is on at a brewery, and what to order there - the two things a crawl
 * asks a model for, and the rules for believing what comes back.
 *
 * Open Brewery DB knows where a brewery is and nothing about what it pours or
 * when it shuts. That lives on the brewery's own site, Untappd, Instagram,
 * BeerMenus - so a menu is a web search, and a web search is a model call on
 * somebody's credit. Two consequences:
 *
 *   - It is CACHED FOR EVERYONE, at breweries/<Open Brewery DB id>, for
 *     FRESH_MS. Whoever's crawl first needs a brewery pays for the lookup; the
 *     next crawl through it within two days reads it free. The football app's
 *     shared fan/<team> pages work the same way, for the same reason: cost
 *     scales with breweries in use, not with people.
 *   - Everything in it is validated before it is stored OR drawn, because it
 *     was written by a model from pages anyone can edit: markup stripped,
 *     lengths bounded, only https becomes a link, an ABV is a number between
 *     0 and 20 or nothing, a closing time is HH:MM or nothing.
 *
 * A menu that says it could not find a tap list (no beers, confidence low) is
 * a good answer. The prompt says so in as many words: an invented beer list
 * sends someone across town for a beer that does not exist.
 */

const FRESH_MS = 48 * 3600 * 1000;
const MAX_BEERS = 40;
const MAX_SOURCES = 6;
const CONFIDENCE = ['high', 'medium', 'low'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const clean = (v, n) => String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
function https(v) {
  try {
    const u = new URL(String(v || '').trim());
    return u.protocol === 'https:' ? u.toString().slice(0, 500) : '';
  } catch (e) { return ''; }
}
/** "6.5", 6.5, "6.5%" -> 6.5; anything else, or outside 0-20, -> null. */
function abv(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/%/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || n > 20) return null;
  return Math.round(n * 10) / 10;
}
/** "21:00" -> "21:00"; "9:00" -> "09:00"; anything that is not a 24-hour
 *  time -> null. "9 PM" is not guessed at: the tool asks for 24-hour time,
 *  and a wrong guess would warn someone off a bar that is open. */
function hhmm(v) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v == null ? '' : v).trim());
  return m ? String(m[1]).padStart(2, '0') + ':' + m[2] : null;
}
const bool = (v) => (v === true || v === false ? v : null);
function isoDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? m[0].slice(0, 10) : null;
}

/**
 * One brewery's menu as the model reported it, made safe to store and draw -
 * or null when there is nothing there at all. `opts.now` (ms) and
 * `opts.date` (the crawl's day, which `closesAt` answers for).
 */
function validate(raw, opts) {
  if (!raw || typeof raw !== 'object') return null;
  const o = opts || {};
  const now = new Date(o.now || Date.now());
  const today = now.toISOString().slice(0, 10);
  const seen = new Set();
  const beers = [];
  for (const b of (Array.isArray(raw.beers) ? raw.beers : []).slice(0, MAX_BEERS * 2)) {
    if (!b || typeof b !== 'object') continue;
    const name = clean(b.name, 80);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    beers.push({ name, style: clean(b.style, 60), abv: abv(b.abv), note: clean(b.note, 140) });
    if (beers.length >= MAX_BEERS) break;
  }
  const weekly = {};
  let anyWeekly = false;
  if (raw.weekly && typeof raw.weekly === 'object') {
    for (const d of WEEKDAYS) {
      const v = raw.weekly[d];
      const t = String(v == null ? '' : v).trim().toLowerCase() === 'closed' ? 'closed' : hhmm(v);
      if (t) { weekly[d] = t; anyWeekly = true; }
    }
  }
  const sources = [];
  for (const s of (Array.isArray(raw.sources) ? raw.sources : [])) {
    const url = https(s && s.url);
    if (!url || sources.some((x) => x.url === url)) continue;
    sources.push({ title: clean(s.title, 80) || new URL(url).hostname.replace(/^www\./, ''), url });
    if (sources.length >= MAX_SOURCES) break;
  }
  // An "as of" in the future is a model's typo, not a time machine.
  let asOf = isoDay(raw.asOf);
  if (!asOf || asOf > today) asOf = today;
  const closesAt = hhmm(raw.closesAt);
  const menu = {
    beers,
    food: clean(raw.food, 300),
    hours: clean(raw.hours, 120),
    closesAt,
    closesOn: closesAt && o.date ? o.date : null,
    weekly: anyWeekly ? weekly : null,
    highlights: clean(raw.highlights, 200),
    kidFriendly: bool(raw.kidFriendly),
    dogFriendly: bool(raw.dogFriendly),
    sources,
    confidence: CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'low',
    asOf,
  };
  // With nothing found, "high confidence" is not a claim anyone can make.
  if (!beers.length && menu.confidence === 'high') menu.confidence = 'low';
  return menu;
}

/** Is a cached entry good to reuse for this stop? Younger than FRESH_MS and
 *  written for a brewery of the same name. The cache is keyed by a directory
 *  id the browser sends, so without the name check one crawl could file a
 *  menu for "anything" under a real brewery's id and serve it to everyone
 *  else who goes there. */
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
function isFresh(entry, stop, now) {
  if (!entry || !entry.menu || !stop) return false;
  if (!sameName(entry.name, stop.name)) return false;
  const at = Date.parse(entry.fetchedAt || '');
  return Number.isFinite(at) && (now || Date.now()) - at < FRESH_MS;
}
function usable(entry, stop) {
  return !!(entry && entry.menu && stop && sameName(entry.name, stop.name));
}

const TOOL = {
  name: 'record_menus',
  description:
    'Record what you found for each brewery: its current tap list, food, hours on the crawl\'s date, and whether ' +
    'it suits kids and dogs. Call it once, with every brewery you were asked about.',
  input_schema: {
    type: 'object',
    properties: {
      menus: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            breweryId: { type: 'string', description: 'The id you were given for this brewery, exactly.' },
            beers: {
              type: 'array',
              description: 'What is on tap NOW, as listed by a source you found. Leave empty rather than guess.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  style: { type: 'string', description: 'e.g. "Hazy IPA", "Pilsner", "Imperial stout".' },
                  abv: { type: 'number', description: 'Percent, e.g. 6.5. Omit if not stated.' },
                  note: { type: 'string', description: 'A few words if the source says something useful ("new this week", "cask").' },
                },
                required: ['name'],
              },
            },
            food: { type: 'string', description: 'Kitchen, snacks, or which food truck is there - or that there is no food.' },
            hours: { type: 'string', description: 'Opening hours on the crawl\'s date, readable, e.g. "Sat 12-10 PM".' },
            closesAt: { type: 'string', description: 'Closing time on the crawl\'s date, 24-hour "HH:MM" (e.g. "22:00", "01:00" for 1 AM). Omit if not found.' },
            weekly: {
              type: 'object',
              description: 'Closing time for each day of the week if the source lists regular hours: 24-hour "HH:MM", or "closed".',
              properties: Object.fromEntries(WEEKDAYS.map((d) => [d, { type: 'string' }])),
            },
            highlights: { type: 'string', description: 'One line: what it is known for, or what makes a visit worth it.' },
            kidFriendly: { type: 'boolean', description: 'Are under-21s / children welcome? Omit if not stated.' },
            dogFriendly: { type: 'boolean', description: 'Are dogs welcome? Omit if not stated.' },
            sources: {
              type: 'array',
              items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['url'] },
              description: 'The https pages the tap list and hours came from.',
            },
            confidence: { type: 'string', enum: CONFIDENCE, description: 'high: a dated tap list from this week; medium: a list that may be a little old; low: none found, or unsure.' },
            asOf: { type: 'string', description: 'The date the tap list was current, "YYYY-MM-DD".' },
          },
          required: ['breweryId', 'beers', 'confidence'],
        },
      },
    },
    required: ['menus'],
  },
};

/* ---------- what to order ---------- */

const PICKS_TOOL = {
  name: 'record_picks',
  description: 'Record what to order at each stop of the crawl, and one short pacing note for the whole afternoon.',
  input_schema: {
    type: 'object',
    properties: {
      picks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stopId: { type: 'string', description: 'The stop\'s id, exactly as given.' },
            order: { type: 'string', description: 'What to order, short: a beer from the menu by name, a flight, a half pour. When there is no menu, a style to ask for.' },
            why: { type: 'string', description: 'One line on why, tied to what they said they like.' },
          },
          required: ['stopId', 'order', 'why'],
        },
      },
      pacing: { type: 'string', description: 'One or two practical sentences for the whole crawl - where to do flights or half pours, where there is food. Not a lecture.' },
    },
    required: ['picks', 'pacing'],
  },
};

/** Picks keyed by stop id, for this crawl's stops only - a model that
 *  invents a stop, or answers for one since removed, has that answer
 *  dropped. Returns {picks, pacing}. */
function validatePicks(input, stopIds) {
  const allowed = new Set(Array.isArray(stopIds) ? stopIds : []);
  const picks = {};
  for (const p of (input && Array.isArray(input.picks) ? input.picks : [])) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.stopId || '');
    const order = clean(p.order, 140);
    if (!allowed.has(id) || !order || picks[id]) continue;
    picks[id] = { order, why: clean(p.why, 200) };
  }
  return { picks, pacing: clean(input && input.pacing, 300) };
}

module.exports = { validate, validatePicks, isFresh, usable, abv, hhmm, TOOL, PICKS_TOOL, FRESH_MS, MAX_BEERS, WEEKDAYS };
