/**
 * When is this trip? Worked out from what the trip actually has.
 *
 * The Overview's countdown and weather both need a start and an end, and a
 * trip here has two places that might say: the itinerary, whose days carry
 * ISO dates once one is planned, and "When" - free text a person typed
 * ("March 27", "Sep 23-26, 2026", "December 2026", "Early March 2027").
 *
 * The itinerary wins when it has dates, because it is the plan. Otherwise the
 * text is parsed, and the answer says how PRECISE it is: `day` for a real
 * date, `month` for "December 2026". A countdown to the first of a month the
 * person only named would claim a precision nobody gave it, so the page words
 * a month-precision answer as "about".
 *
 * Nothing here guesses harder than that. Text it cannot read gives null, and
 * the Overview simply leaves the countdown out.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Whole words only. Without the boundaries "maybe next year" read as May,
// and "market", "decide" and "separate" would each have found a month.
const MONTH_RE = '\\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b';

const monthIndex = (s) => MONTHS.indexOf(String(s).slice(0, 3).toLowerCase());
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const valid = (y, m, d) => m >= 0 && d >= 1 && d <= lastDay(y, m);

/** A date with no year means the next time it comes round, counted from
 *  today - "March 27" typed in September is next March, not last. */
function yearFor(m, d, today) {
  const y = today.getUTCFullYear();
  const cand = Date.UTC(y, m, d);
  const t = Date.UTC(y, today.getUTCMonth(), today.getUTCDate());
  // A little grace: a trip that started a few days ago is this year's trip,
  // not next year's.
  return cand < t - 14 * 86400000 ? y + 1 : y;
}

function fromText(text, today) {
  const s = String(text || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const yearM = s.match(/\b(20\d{2})\b/);
  const year = yearM ? Number(yearM[1]) : null;

  // "sep 23 - oct 2, 2026", "sep 30-oct 2"
  let m = s.match(new RegExp(`${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\s*-\\s*${MONTH_RE}\\.? (\\d{1,2})`));
  if (m) {
    const m1 = monthIndex(m[1]); const d1 = Number(m[2]); const m2 = monthIndex(m[3]); const d2 = Number(m[4]);
    const y1 = year || yearFor(m1, d1, today);
    const y2 = m2 < m1 ? y1 + 1 : y1;
    if (valid(y1, m1, d1) && valid(y2, m2, d2)) return { start: iso(y1, m1, d1), end: iso(y2, m2, d2), precision: 'day' };
  }
  // "sep 23-26, 2026", "october 1 - 5"
  m = s.match(new RegExp(`${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\s*-\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`));
  if (m) {
    const mo = monthIndex(m[1]); const d1 = Number(m[2]); const d2 = Number(m[3]);
    const y = year || yearFor(mo, d1, today);
    if (d2 >= d1 && valid(y, mo, d1) && valid(y, mo, d2)) return { start: iso(y, mo, d1), end: iso(y, mo, d2), precision: 'day' };
  }
  // "march 27", "mar 27, 2027"
  m = s.match(new RegExp(`${MONTH_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\d)`));
  if (m && !/^\d{4}$/.test(m[2])) {
    const mo = monthIndex(m[1]); const d = Number(m[2]);
    const y = year || yearFor(mo, d, today);
    if (valid(y, mo, d)) return { start: iso(y, mo, d), end: iso(y, mo, d), precision: 'day' };
  }
  // "december 2026", "early march 2027", "april" - a month, not a date
  m = s.match(new RegExp(`${MONTH_RE}`));
  if (m) {
    const mo = monthIndex(m[1]);
    const y = year || yearFor(mo, lastDay(today.getUTCFullYear(), mo), today);
    return { start: iso(y, mo, 1), end: iso(y, mo, lastDay(y, mo)), precision: 'month' };
  }
  return null;
}

/**
 * @returns {{start: string, end: string, precision: 'day'|'month', from: 'itinerary'|'text'} | null}
 */
function tripDates(trip, today = new Date()) {
  const dated = (Array.isArray(trip && trip.days) ? trip.days : [])
    .map((d) => String((d && d.date) || '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)))
    .sort();
  if (dated.length) return { start: dated[0], end: dated[dated.length - 1], precision: 'day', from: 'itinerary' };
  const t = fromText(trip && trip.dateRange, today);
  return t ? { ...t, from: 'text' } : null;
}

module.exports = { tripDates, fromText };
