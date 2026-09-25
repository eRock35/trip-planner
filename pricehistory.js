/**
 * A watch's price over time, read out of what its checks said.
 *
 * A watch check stores a sentence ("TAP nonstop is $842 return - down from
 * $1,010 last week"), not a number, because it is a model's answer and some
 * checks honestly find no price at all. This reads the price back out of each
 * entry in `history` (capped at 20) so the Watches tab and the Overview can
 * draw a sparkline and say "down $168 since Aug 15".
 *
 * The rules, each there because the alternative misleads:
 *   - Only an amount with a currency mark counts ("$842", "€238", "842 USD").
 *     A bare number is as likely to be a date, a flight number or "4h".
 *   - The FIRST marked amount in the sentence is the price. The check is told
 *     to lead with it; later amounts are comparisons ("down from $1,010").
 *   - The number goes through budget.money(), the same parser the budget
 *     uses, so "$1,240.50" is 1240.5 everywhere in the app.
 *   - An entry with no price is skipped, not drawn as zero.
 *   - Prices in different currencies are never drawn on one line: the series
 *     keeps the currency most entries used.
 *   - Fewer than two prices is not a trend, so there is no chart and no badge.
 */
const { money } = require('./budget');

const MARKS = { 'US$': 'USD', 'C$': 'CAD', 'CA$': 'CAD', 'A$': 'AUD', 'AU$': 'AUD', 'NZ$': 'NZD', 'MX$': 'MXN', 'R$': 'BRL',
  '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '฿': 'THB' };
const WORDS = { dollars: 'USD', dollar: 'USD', euros: 'EUR', euro: 'EUR', pounds: 'GBP' };
const CODES = 'USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|MXN|SEK|NOK|DKK|BRL|INR|THB|SGD|HKD|ZAR|CZK|PLN|HUF|ISK|TRY|KRW|CNY';
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const SYMS = Object.keys(MARKS).sort((a, b) => b.length - a.length).map((s) => s.replace(/[$]/g, '\\$')).join('|');
// Symbol or code before the number, or a code/word after it. The number must
// not run on into more digits or a "k" (a "$1.2k" is not $1.20).
const PRICE_RE = new RegExp(
  `(?:(${SYMS})\\s?|\\b(${CODES})\\s)${NUM}(?![\\d.,]*\\d)(?![kKmM]\\b)` +
  `|\\b${NUM}\\s?(${CODES}|dollars?|euros?|pounds)\\b`, 'i');

/** "TAP nonstop $1,010 return" -> { amount: 1010, currency: 'USD' }, or null. */
function priceIn(text) {
  const m = PRICE_RE.exec(String(text || ''));
  if (!m) return null;
  const amount = money(m[3] || m[4]);
  if (amount == null || amount <= 0) return null;
  const mark = m[1] || m[2] || m[5] || '';
  const currency = MARKS[mark] || MARKS[mark.toUpperCase()] || WORDS[mark.toLowerCase()] || mark.toUpperCase();
  return { amount, currency };
}

const whenOf = (e) => String((e && (e.checkedAt || e.at)) || '');

/** history -> { currency, points: [{ at, price }] } in time order. */
function series(history) {
  const rows = (Array.isArray(history) ? history : [])
    .map((e) => ({ at: whenOf(e), p: priceIn(e && e.result) }))
    .filter((r) => r.p && !Number.isNaN(Date.parse(r.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!rows.length) return { currency: null, points: [] };
  const count = {};
  for (const r of rows) count[r.p.currency] = (count[r.p.currency] || 0) + 1;
  const latest = rows[rows.length - 1].p.currency;
  const currency = Object.keys(count).sort((a, b) => (count[b] - count[a]) || (a === latest ? -1 : b === latest ? 1 : 0))[0];
  return { currency, points: rows.filter((r) => r.p.currency === currency).map((r) => ({ at: r.at, price: r.p.amount })) };
}

const cents = (n) => Math.round(n * 100) / 100;

/** How the price has moved: since the first price seen, and where the low
 *  was. null with fewer than two prices. */
function trend(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  // The LATEST occurrence of the lowest price, so a price back at its low
  // reads as "lowest yet" rather than pointing at an older match.
  let low = points[0];
  let high = points[0];
  for (const p of points) { if (p.price <= low.price) low = p; if (p.price > high.price) high = p; }
  const delta = cents(last.price - first.price);
  return {
    first: first.price, last: last.price, since: first.at, lastAt: last.at,
    delta, pct: first.price ? Math.round((delta / first.price) * 1000) / 10 : 0,
    direction: delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat',
    change: cents(last.price - prev.price),
    low: low.price, lowAt: low.at, atLow: last.price <= low.price,
    high: high.price, count: points.length,
  };
}

/** What a watch carries to the page: its points and the trend, or null. */
function forWatch(w) {
  const s = series(w && w.history);
  const t = trend(s.points);
  return t ? { currency: s.currency, points: s.points, trend: t } : null;
}

module.exports = { priceIn, series, trend, forWatch };
