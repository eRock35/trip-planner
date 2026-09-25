/**
 * A trip's budget: an optional target, spending lines with a planned and a
 * spent amount, and what the bookings already cost.
 *
 * Lines are one document each under trips/<id>/budget, for the same reason
 * the packing list is: two people entering what dinner cost must not erase
 * each other. The target lives on the trip, because there is only one.
 *
 * Money arrives from people typing and from a model estimating, so amounts
 * go through money(): a number, or a string like "$1,240.50"; never negative,
 * never absurd, always to the cent.
 */
const { code: fxCode } = require('./fx');
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const CATEGORIES = ['Lodging', 'Transport', 'Food', 'Activities', 'Shopping', 'Other'];
const MAX_LINES = 100;

/** A money amount, or null. "$1,240.50" -> 1240.5; "about $40" -> 40. */
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  // No digit, no amount. Without this, "free" stripped to "" and Number("")
  // is 0 - a line someone wrote "free" on would have claimed to cost $0.00
  // rather than having no figure.
  if (typeof v !== 'number' && !/\d/.test(String(v))) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'));
  if (!Number.isFinite(n) || n < 0 || n > 1e6) return null;
  return Math.round(n * 100) / 100;
}

/** A calendar day, "2026-09-24", or null. A real day: "2026-02-30" is not
 *  one, and a date that is not a date would sort and group as nonsense. */
function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return m[0];
}

/** Where a line's number came from, so the page can say so: typed in, read
 *  off a receipt photo, taken from a card statement, or estimated by Claude.
 *  A figure someone can trace is a figure someone can check. */
const SOURCES = ['manual', 'receipt', 'card', 'estimate'];

function line(l) {
  if (!l || typeof l !== 'object') return null;
  const label = clean(l.label, 80);
  const cat = clean(l.category, 30);
  if (!label && !cat) return null;
  return {
    category: CATEGORIES.find((c) => c.toLowerCase() === cat.toLowerCase()) || (cat || 'Other'),
    label: label || cat,
    planned: money(l.planned),
    spent: money(l.spent),
    note: clean(l.note, 200),
    // Both optional. Lines written before these existed read back as an
    // undated manual line, which is what they were.
    date: isoDate(l.date),
    source: SOURCES.includes(l.source) ? l.source : 'manual',
    // The currency the amounts are in, when it is not the trip's home one:
    // a receipt from Lisbon is in euros. null means the home currency, which
    // is what every line written before this was. The Budget converts at the
    // day's reference rate and says the result is an estimate.
    currency: fxCode(l.currency),
  };
}

/** statement.js sorts a card charge into generic kinds shared with the
 *  vacation app; these are this budget's categories for them. Groceries and
 *  meals out are both Food here because that is how people budget a trip -
 *  the vacation app splits them, which is its call. */
const KIND_CATEGORY = {
  food: 'Food', groceries: 'Food',
  gas: 'Transport', transport: 'Transport',
  lodging: 'Lodging', activities: 'Activities', shopping: 'Shopping', other: 'Other',
};

const TOOL = {
  name: 'budget_estimate',
  description: 'Report the budget lines you estimate for this trip.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: CATEGORIES },
            label: { type: 'string', description: 'e.g. "Groceries", "Two dinners out", "Dolphin cruise for 4", "Gas".' },
            planned: { type: 'number', description: 'Estimated US dollars for the whole trip.' },
            note: { type: 'string', description: 'One short line on how the estimate was made.' },
          },
          required: ['category', 'label', 'planned'],
        },
      },
    },
    required: ['lines'],
  },
};

module.exports = { money, line, isoDate, TOOL, CATEGORIES, SOURCES, KIND_CATEGORY, MAX_LINES };
