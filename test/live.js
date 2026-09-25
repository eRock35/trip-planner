// The Overview's live parts as plain functions (public/live.js): the
// countdown across time zones and precisions, a budget counted across
// currencies, and a price watch's sparkline and badge.
const assert = require('assert');
const L = require('../public/live.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const at = (iso) => Date.parse(iso);

const LISBON = {
  dates: { start: '2026-10-01', end: '2026-10-05', precision: 'day' },
  days: [
    { date: '2026-10-01', blocks: [['3:40 PM', 'Land at LIS (TAP 228)'], ['5:00 PM', 'Check in']] },
    { date: '2026-10-02', blocks: [['9:00 AM', 'Tram 15E to Belem']] },
  ],
};

/* ---------- time zones ---------- */
t('an ISO day becomes midnight in the zone it is meant in', () => {
  assert.strictEqual(new Date(L.zonedTime('2026-10-01', 0, 'America/New_York')).toISOString(), '2026-10-01T04:00:00.000Z');
  assert.strictEqual(new Date(L.zonedTime('2026-10-01', 0, 'Europe/Lisbon')).toISOString(), '2026-09-30T23:00:00.000Z');
  assert.strictEqual(new Date(L.zonedTime('2026-10-01', 15 * 60 + 40, 'Asia/Tokyo')).toISOString(), '2026-10-01T06:40:00.000Z');
});
t('...and across a DST change, the instant after it', () => {
  // US clocks go back at 2 AM on Nov 1 2026: Nov 2 midnight is EST (-5).
  assert.strictEqual(new Date(L.zonedTime('2026-11-02', 0, 'America/New_York')).toISOString(), '2026-11-02T05:00:00.000Z');
  assert.strictEqual(new Date(L.zonedTime('2026-03-29', 0, 'Europe/London')).toISOString(), '2026-03-29T00:00:00.000Z');
  assert.strictEqual(new Date(L.zonedTime('2026-03-30', 0, 'Europe/London')).toISOString(), '2026-03-29T23:00:00.000Z');
});
t('"today" is the viewer’s today, not UTC’s', () => {
  const late = at('2026-09-30T23:30:00Z');
  assert.strictEqual(L.localIso(late, 'Europe/Lisbon'), '2026-10-01');
  assert.strictEqual(L.localIso(late, 'America/Los_Angeles'), '2026-09-30');
});

/* ---------- the countdown ---------- */
t('no dates, no countdown', () => {
  assert.strictEqual(L.countdown({ dates: null }, Date.now()), null);
  assert.strictEqual(L.countdown(null, Date.now()), null);
  assert.strictEqual(L.compact(null), null);
});
t('before the trip: days, hours and minutes to local midnight', () => {
  const now = at('2026-09-25T12:00:00Z');
  const ny = L.countdown(LISBON, now, 'America/New_York');
  assert.deepStrictEqual([ny.kind, ny.d, ny.h, ny.m], ['before', 5, 16, 0]);
  const lx = L.countdown(LISBON, now, 'Europe/Lisbon');
  assert.deepStrictEqual([lx.d, lx.h, lx.m], [5, 11, 0], 'Lisbon is five hours ahead of New York');
  assert.strictEqual(L.compact(ny), 'in 5 days');
});
t('...counting real hours across a DST change, not wall-clock ones', () => {
  const trip = { dates: { start: '2026-11-02', end: '2026-11-04', precision: 'day' } };
  const st = L.countdown(trip, at('2026-10-31T04:00:00Z'), 'America/New_York'); // Oct 31, 00:00 EDT
  assert.deepStrictEqual([st.d, st.h, st.m], [2, 1, 0], 'the night the clocks go back is 25 hours long');
});
t('...short forms under two days', () => {
  const st1 = L.countdown(LISBON, at('2026-09-29T20:30:00Z'), 'UTC');
  assert.strictEqual(L.compact(st1), 'in 1 day 3h');
  const st2 = L.countdown(LISBON, at('2026-09-30T19:30:00Z'), 'America/New_York');
  assert.strictEqual(L.compact(st2), 'in 8h 30m');
  const st3 = L.countdown(LISBON, at('2026-10-01T03:48:00Z'), 'America/New_York');
  assert.strictEqual(L.compact(st3), 'in 12m');
});
t('the same instant is travel day in Lisbon and still the night before in LA', () => {
  const late = at('2026-09-30T23:30:00Z');
  assert.strictEqual(L.countdown(LISBON, late, 'Europe/Lisbon').kind, 'travel');
  const la = L.countdown(LISBON, late, 'America/Los_Angeles');
  assert.deepStrictEqual([la.kind, la.d, la.h, la.m], ['before', 0, 7, 30]);
});
t('travel day says what comes first, and how long until it', () => {
  const st = L.countdown(LISBON, at('2026-10-01T10:00:00Z'), 'Europe/Lisbon'); // 11:00 in Lisbon
  assert.strictEqual(st.kind, 'travel');
  assert.deepStrictEqual([st.first.time, st.first.plan], ['3:40 PM', 'Land at LIS (TAP 228)']);
  assert.strictEqual(st.first.inMs, (4 * 60 + 40) * 60000);
  assert.strictEqual(L.compact(st), 'Today');
  const after = L.countdown(LISBON, at('2026-10-01T16:00:00Z'), 'Europe/Lisbon');
  assert.strictEqual(after.first.inMs, 0, 'once it has happened there is nothing to count to');
});
t('...an itinerary with no time, or no itinerary, still says Today', () => {
  const st = L.countdown({ dates: LISBON.dates, days: [{ date: '2026-10-01', blocks: [['Morning', 'Pack']] }] }, at('2026-10-01T10:00:00Z'), 'UTC');
  assert.deepStrictEqual([st.kind, st.first.plan, st.first.minutes, st.first.inMs], ['travel', 'Pack', null, undefined]);
  assert.strictEqual(L.countdown({ dates: LISBON.dates }, at('2026-10-01T10:00:00Z'), 'UTC').first, null);
});
t('during the trip: Day 2 of 5; after it: back n days', () => {
  const d2 = L.countdown(LISBON, at('2026-10-02T12:00:00Z'), 'Europe/Lisbon');
  assert.deepStrictEqual([d2.kind, d2.n, d2.total], ['during', 2, 5]);
  assert.strictEqual(L.compact(d2), 'Day 2 of 5');
  const back = L.countdown(LISBON, at('2026-10-07T12:00:00Z'), 'Europe/Lisbon');
  assert.deepStrictEqual([back.kind, back.ago], ['after', 2]);
  assert.strictEqual(L.compact(back), null, 'a finished trip has no chip in the list');
});
t('a month is "about", never a midnight nobody chose', () => {
  const dec = { dates: { start: '2026-12-01', end: '2026-12-31', precision: 'month' } };
  const st = L.countdown(dec, at('2026-09-25T12:00:00Z'), 'UTC');
  assert.deepStrictEqual([st.kind, st.words], ['month', 'About 3 months']);
  assert.ok(!('ms' in st) && !('d' in st), 'no countdown numbers at month precision');
  const oct = L.countdown({ dates: { start: '2026-10-01', end: '2026-10-31', precision: 'month' } }, at('2026-09-25T12:00:00Z'), 'UTC');
  assert.strictEqual(oct.words, 'About 3 weeks', 'measured to the middle of the month, not its first day');
  assert.strictEqual(L.compact(oct), 'about 3 weeks');
  assert.strictEqual(L.countdown(dec, at('2026-12-10T12:00:00Z'), 'UTC').words, 'This month');
  assert.strictEqual(L.countdown(dec, at('2027-01-03T12:00:00Z'), 'UTC').kind, 'after');
});
t('the display redraws on the minute', () => {
  const st = L.countdown(LISBON, at('2026-09-25T12:00:20Z'), 'UTC');
  assert.strictEqual(L.msToNextMinute(st), 40000);
  assert.strictEqual(L.msToNextMinute({ kind: 'during' }), 60000);
});
t('clock times are read the ways an itinerary writes them', () => {
  assert.strictEqual(L.parseClock('3:40 PM'), 940);
  assert.strictEqual(L.parseClock('12:30 AM'), 30);
  assert.strictEqual(L.parseClock('12 pm'), 720);
  assert.strictEqual(L.parseClock('9am'), 540);
  assert.strictEqual(L.parseClock('15:40'), 940);
  assert.strictEqual(L.parseClock('10:00 Arrive'), 600);
  assert.strictEqual(L.parseClock('Morning'), null);
  assert.strictEqual(L.parseClock('Evening'), null);
});

/* ---------- a budget across currencies ---------- */
const LINES = [
  { id: 'a', label: 'Meals out', planned: 100, spent: 40 },
  { id: 'b', label: 'Sintra tickets', planned: 64, spent: 19, currency: 'EUR' },
  { id: 'c', label: 'Pasteis', planned: null, spent: 12.6, currency: 'EUR' },
  { id: 'd', label: 'Ramen', planned: null, spent: 1000, currency: 'JPY' },
  { id: 'e', label: 'Dollars, said so', planned: 10, spent: null, currency: 'USD' },
  { id: 'f', label: 'An idea in euros', planned: null, spent: null, currency: 'EUR' },
];
const BOOKED = [{ total: 1386 }, { total: 1120 }];
t('lines in euros are counted in dollars at the rate', () => {
  const b = L.convertBudget(LINES, BOOKED, { home: 'USD', rates: { EUR: 1.17 } });
  assert.strictEqual(b.planned, 184.88);                 // 100 + 64*1.17 + 10
  assert.strictEqual(b.spent, 76.97);                    // 40 + 22.23 + 14.74
  assert.strictEqual(b.booked, 2506);
  assert.strictEqual(b.sofar, 2582.97);
  assert.strictEqual(b.expected, 2690.88);
  const eur = b.lines.find((l) => l.id === 'b');
  assert.deepStrictEqual([eur.foreign, eur.plannedHome, eur.spentHome], [true, 74.88, 22.23]);
  assert.deepStrictEqual([b.converted, b.convertedFrom, b.estimated], [2, ['EUR'], true]);
});
t('...a currency with no rate is left out and counted as left out, never as dollars', () => {
  const b = L.convertBudget(LINES, BOOKED, { home: 'USD', rates: { EUR: 1.17 } });
  const yen = b.lines.find((l) => l.id === 'd');
  assert.deepStrictEqual([yen.uncounted, yen.spentHome], [true, null]);
  assert.strictEqual(b.uncounted, 1);
  assert.strictEqual(b.lines.find((l) => l.id === 'f').uncounted, false, 'a line with no amounts is not missing anything');
});
t('...the home currency written out is still home money', () => {
  const b = L.convertBudget(LINES, [], { home: 'USD', rates: {} });
  const usd = b.lines.find((l) => l.id === 'e');
  assert.deepStrictEqual([usd.foreign, usd.plannedHome], [false, 10]);
  assert.strictEqual(b.planned, 110, 'no rates: only home lines count');
  assert.strictEqual(b.uncounted, 3);
  assert.strictEqual(b.estimated, false);
});
t('...a trip budgeted in euros converts the dollar estimates instead', () => {
  const b = L.convertBudget([{ planned: 100, currency: 'USD' }, { planned: 50 }], [], { home: 'EUR', rates: { USD: 0.855 } });
  assert.strictEqual(b.planned, 135.5);
});
t('...and an empty budget is all zeroes', () => {
  const b = L.convertBudget([], null, {});
  assert.deepStrictEqual([b.planned, b.spent, b.booked, b.home], [0, 0, 0, 'USD']);
});
t('rates read the way a person says them', () => {
  assert.strictEqual(L.fxPair(1.1734, 'EUR', 'USD'), '€1 = $1.17');
  assert.strictEqual(L.fxPair(0.0064, 'JPY', 'USD'), '$1 = ¥156', 'a yen is not "$0.0064"');
  assert.strictEqual(L.fxPair(1.13, 'CHF', 'USD'), 'CHF 1 = $1.13');
  assert.strictEqual(L.fxPair(null, 'EUR', 'USD'), '');
  assert.strictEqual(L.fmtMoney(1240.5, 'USD', 'en-US'), '$1,240.50');
  assert.strictEqual(L.fmtMoney(42, 'EUR', 'en-US'), '€42');
});

/* ---------- sparklines ---------- */
const P = [
  { at: '2026-09-01T00:00:00Z', price: 100 },
  { at: '2026-09-02T00:00:00Z', price: 80 },
  { at: '2026-09-04T00:00:00Z', price: 90 },
];
t('fewer than two prices is no chart', () => {
  assert.strictEqual(L.sparkGeometry([], 100, 50), null);
  assert.strictEqual(L.sparkGeometry([P[0]], 100, 50), null);
  assert.strictEqual(L.sparkGeometry(null, 100, 50), null);
});
t('x follows the real times, y runs low at the bottom', () => {
  const g = L.sparkGeometry(P, 100, 50, 5);
  assert.strictEqual(g.line, 'M5 5 L35 45 L95 25');
  assert.deepStrictEqual(g.low, { x: 35, y: 45, i: 1 });
  assert.deepStrictEqual(g.last, { x: 95, y: 25 });
  assert.ok(/ Z$/.test(g.area) && g.area.startsWith(g.line), 'the area closes along the bottom');
});
t('...a small move stays small: the range is at least 12% of the high', () => {
  const g = L.sparkGeometry([{ at: '2026-09-19T00:00:00Z', price: 65 }, { at: '2026-09-24T00:00:00Z', price: 70 }], 100, 50, 5);
  // span 8.4 centred on 67.5: 65 sits at 0.202, 70 at 0.798 of the 40px height.
  assert.deepStrictEqual(g.dots.map((d) => d.y), [36.9, 13.1]);
});
t('...a flat price sits in the middle, and equal times fall back to order', () => {
  const flat = L.sparkGeometry([{ at: '2026-09-01T00:00:00Z', price: 50 }, { at: '2026-09-02T00:00:00Z', price: 50 }], 100, 50, 5);
  assert.ok(flat.dots.every((d) => d.y === 25));
  assert.strictEqual(flat.low.i, 1, 'the latest of equal lows');
  const same = L.sparkGeometry([{ at: 'x', price: 1 }, { at: 'x', price: 2 }, { at: 'x', price: 3 }], 100, 50, 5);
  assert.deepStrictEqual(same.dots.map((d) => d.x), [5, 50, 95]);
});
const trend = (first, last, since, extra) => Object.assign({ first, last, delta: Math.round((last - first) * 100) / 100,
  pct: Math.round(((last - first) / first) * 1000) / 10, direction: last < first ? 'down' : last > first ? 'up' : 'flat',
  since, low: Math.min(first, last), lowAt: last < first ? '2026-09-18T10:00:00Z' : since, atLow: last <= first }, extra || {});
t('the badge: down $168 since a date', () => {
  const b = L.priceBadge(trend(1010, 842, '2026-08-15T10:00:00Z'), 'USD', at('2026-09-25T12:00:00Z'), 'UTC');
  assert.deepStrictEqual([b.tone, b.text, b.low], ['down', 'Down $168 (17%) since Aug 15', 'Lowest yet']);
  assert.strictEqual(b.short, 'Down $168 since Aug 15', 'the tile’s shorter form');
});
t('...since a weekday within the week, up with a percentage', () => {
  const b = L.priceBadge(trend(100, 108, '2026-09-22T10:00:00Z'), 'USD', at('2026-09-25T12:00:00Z'), 'UTC');
  assert.deepStrictEqual([b.tone, b.text], ['up', 'Up $8 (8%) since Tue']);
  assert.strictEqual(b.low, 'Low $100 · Tue');
});
t('...the weekday is the viewer’s, not UTC’s', () => {
  // 02:00 UTC on Wednesday is still Tuesday evening in Los Angeles.
  assert.strictEqual(L.sinceLabel('2026-09-23T02:00:00Z', at('2026-09-25T20:00:00Z'), 'America/Los_Angeles'), 'Tue');
  assert.strictEqual(L.sinceLabel('2026-09-23T02:00:00Z', at('2026-09-25T20:00:00Z'), 'UTC'), 'Wed');
});
t('...no change says so, and small moves keep a decimal', () => {
  assert.strictEqual(L.priceBadge(trend(250, 250, '2026-09-01T10:00:00Z'), 'USD', at('2026-09-25T12:00:00Z'), 'UTC').text, 'No change since Sep 1');
  assert.strictEqual(L.priceBadge(trend(255, 238, '2026-08-20T10:00:00Z'), 'USD', at('2026-09-25T12:00:00Z'), 'UTC').text, 'Down $17 (6.7%) since Aug 20');
  assert.strictEqual(L.priceBadge(null), null);
});

console.log(`\n${n} assertions passed.`);
