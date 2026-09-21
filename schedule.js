// Shape rules for a proposed itinerary.
//
// COPY of the validate half of santa-rosa-beach-trip/schedule.js. That app
// also carries a seed itinerary, which this one has no use for - every trip
// here starts empty and builds up from chat.
//
// The point is the same in both: the `days` array comes out of a model, so it
// is untrusted input even though a person taps Apply. A day with no `blocks`,
// or a date that is not a date, renders as a broken Itinerary tab that would
// need a deploy to fix.
//
// Shape: { title, date: "YYYY-MM-DD", dateLabel, blocks: [[time, plan], ...], tip }

const MAX_DAYS = 30;
const MAX_BLOCKS = 40;

/** Reject anything that would render as garbage or blow up the page. The model
 *  proposes this array, so it is untrusted input even though the user taps
 *  Apply: a missing `blocks` or a date that is not a string is a broken
 *  Schedule tab, and the fix would need a deploy. */
function validate(days) {
  if (!Array.isArray(days) || !days.length) throw bad('The schedule needs at least one day.');
  if (days.length > MAX_DAYS) throw bad(`That is more than ${MAX_DAYS} days.`);
  return days.map((d, i) => {
    if (!d || typeof d !== 'object') throw bad(`Day ${i + 1} is not a day.`);
    const blocks = Array.isArray(d.blocks) ? d.blocks : [];
    if (blocks.length > MAX_BLOCKS) throw bad(`Day ${i + 1} has more than ${MAX_BLOCKS} entries.`);
    return {
      title: str(d.title, 120) || `Day ${i + 1}`,
      // An ISO date or nothing - never a half-parsed string, which would make
      // the "Today" pill land on the wrong day.
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')) ? String(d.date) : null,
      dateLabel: str(d.dateLabel, 60),
      blocks: blocks.map((b) => {
        const pair = Array.isArray(b) ? b : [b && b.time, b && b.plan];
        return [str(pair[0], 60), str(pair[1], 800)];
      }).filter((b) => b[0] || b[1]),
      tip: str(d.tip, 800),
    };
  });
}

function str(v, max) {
  return String(v === null || v === undefined ? '' : v).slice(0, max).trim();
}

function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}


/* ------------------------------------------------------------------ *
 * The Firestore boundary
 * ------------------------------------------------------------------ */

/**
 * Firestore cannot store an array inside an array. `blocks` is a list of
 * [time, plan] PAIRS, so `days` is an array of maps each holding an array of
 * arrays, and writing it back gets
 *
 *     3 INVALID_ARGUMENT: Property array contains an invalid nested entity.
 *
 * which surfaced as "Could not save the schedule." on every single Apply.
 * Nothing was wrong with the plan, the validation or the model - the shape
 * simply cannot be written, so Apply had never once worked since the schedule
 * moved into Firestore.
 *
 * The pair is the right shape for everything else: the page renders from it,
 * the model proposes it, the seed is written in it. So it is converted here,
 * at the one place that talks to the database, rather than changed everywhere
 * else to suit the store.
 */
function toStore(days) {
  return validate(days).map((day) => ({
    ...day,
    blocks: day.blocks.map((b) => ({ time: b[0], plan: b[1] })),
  }));
}

/** ...and back. validate() already accepts a {time, plan} map as well as a
 *  pair, so reading through it converts and sanity-checks in one pass - which
 *  also means a stored document that predates toStore() still loads. */
function fromStore(days) {
  return validate(days);
}

module.exports = { validate, toStore, fromStore, MAX_DAYS, MAX_BLOCKS };
