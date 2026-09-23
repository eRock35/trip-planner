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
  };
}

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

module.exports = { money, line, TOOL, CATEGORIES, MAX_LINES };
