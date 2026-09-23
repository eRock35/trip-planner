/**
 * A trip's bookings: the rental car, the place you are staying, the flights,
 * the dinner reservation, the boat tour.
 *
 * These used to have nowhere to go but the free-text notes, which is why the
 * Overview could not draw them as cards the way the vacation app does
 * ("Midsize - National", confirmation you can tap to copy, pickup time,
 * address that opens in Maps). Now they are a list on the trip.
 *
 * They arrive three ways, and every one of them is text somebody else wrote:
 * a model reading booking emails, a model in chat, and the browser handing a
 * scan result back to import. So validate() runs on ALL of them, and it is
 * strict about the things that end up somewhere dangerous: nothing becomes a
 * link unless it is https, nothing becomes a phone link unless it is a phone
 * number, and angle brackets are stripped because these fields are drawn
 * into the page.
 */

const crypto = require('crypto');
const { money } = require('./budget');

const KINDS = ['flight', 'stay', 'car', 'reservation', 'activity', 'transport', 'other'];
const MAX = 40;

function text(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function url(v) {
  const s = String(v || '').trim();
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString().slice(0, 500) : '';
  } catch (e) { return ''; }
}
function phone(v) {
  const s = String(v || '').trim();
  // Digits, spaces, + ( ) - . only, and enough digits to be a number.
  return /^[+()\d\s.-]{7,24}$/.test(s) && (s.match(/\d/g) || []).length >= 7 ? s : '';
}
function isoDate(v) {
  const s = String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? s : '';
}

/**
 * Normalise a list of bookings, dropping any that have nothing to show.
 * Keeps an existing `id`, gives a new one otherwise, so deleting one booking
 * from the Overview deletes that one and not whatever now sits at its index.
 */
function validate(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const b of list.slice(0, MAX * 2)) {
    if (!b || typeof b !== 'object') continue;
    const item = {
      id: /^[a-z0-9]{8,24}$/i.test(String(b.id || '')) ? String(b.id) : crypto.randomBytes(6).toString('hex'),
      kind: KINDS.includes(b.kind) ? b.kind : 'other',
      title: text(b.title, 120),
      provider: text(b.provider, 80),
      confirmation: text(b.confirmation, 60),
      when: text(b.when, 80),
      until: text(b.until, 80),
      date: isoDate(b.date),
      address: text(b.address, 200),
      phone: phone(b.phone),
      url: url(b.url),
      notes: text(b.notes, 500),
      // What it cost, in dollars, when the confirmation says - the Budget tab
      // counts these as already committed.
      total: money(b.total),
    };
    if (!item.title && !item.provider && !item.confirmation) continue;
    if (!item.title) item.title = item.provider || 'Booking';
    if (seen.has(item.id)) item.id = crypto.randomBytes(6).toString('hex');
    seen.add(item.id);
    out.push(item);
    if (out.length >= MAX) break;
  }
  // Soonest first; undated ones after, in the order given.
  return out.map((b, i) => [b, i]).sort((x, y) => {
    const a = x[0].date || '9999'; const c = y[0].date || '9999';
    return a < c ? -1 : a > c ? 1 : x[1] - y[1];
  }).map(([b]) => b);
}

/** The tool a model uses to propose bookings. Like the itinerary tool, it
 *  proposes the COMPLETE list - nothing is saved until someone taps Apply. */
const TOOL = {
  name: 'propose_bookings',
  description:
    'Propose the trip\'s complete list of bookings - flights, where they are staying, rental cars, restaurant ' +
    'reservations, tours and tickets, trains, parking. Call it when the user tells you about a booking, asks you ' +
    'to add, change or remove one, or when booking emails show ones that are missing. It is NOT saved ' +
    'automatically: the user sees the list and taps Apply. Return EVERY booking, including the unchanged ones, ' +
    'keeping their ids.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence: what was added, changed or removed.' },
      bookings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Keep the id of an existing booking; omit for a new one.' },
            kind: { type: 'string', enum: KINDS },
            title: { type: 'string', description: 'Short, e.g. "Midsize - National", "Beach cottage - Airbnb", "ATL to ECP - Delta 1234".' },
            provider: { type: 'string', description: 'The company, e.g. "National", "Airbnb", "OpenTable".' },
            confirmation: { type: 'string', description: 'Confirmation or reservation number exactly as written.' },
            when: { type: 'string', description: 'Start, readable, e.g. "Tue, Sep 22 - 5:00 PM" or "Check-in after 4 PM".' },
            until: { type: 'string', description: 'End, readable, e.g. "Sun, Sep 27 - 12:00 PM" or "Checkout by 10 AM".' },
            date: { type: 'string', description: 'ISO start date, e.g. "2026-09-22", when known.' },
            address: { type: 'string' },
            phone: { type: 'string' },
            url: { type: 'string', description: 'https link to manage the booking, when the email has one.' },
            notes: { type: 'string', description: 'Anything worth knowing: door code instructions, what is included, how to skip the counter.' },
            total: { type: 'number', description: 'Total price in US dollars when stated, e.g. 319.86. Omit if not stated - never estimate it.' },
          },
          required: ['kind', 'title'],
        },
      },
    },
    required: ['summary', 'bookings'],
  },
};

module.exports = { validate, TOOL, KINDS, MAX };
