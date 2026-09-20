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

module.exports = { validate, MAX_DAYS, MAX_BLOCKS };
