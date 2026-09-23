/**
 * Things to do: a short, researched list for a trip's destination and dates,
 * the Trip Planner version of the vacation app's "Nearby Activities".
 *
 * Saved straight onto the trip when asked for - unlike the itinerary and the
 * bookings there is nothing here to confirm, because nothing here is a
 * decision. It is a list of suggestions, labelled as one, and asking again
 * replaces it. Saving it matters for the other reason: it is a model call
 * with web search, and drawing the Overview must not buy it again.
 *
 * Model output, drawn into the page, so the same rules as bookings: text is
 * stripped of markup and only https becomes a link.
 */
const MAX = 10;
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
function https(v) {
  try { const u = new URL(String(v || '').trim()); return u.protocol === 'https:' ? u.toString().slice(0, 500) : ''; }
  catch (e) { return ''; }
}

function validate(list) {
  if (!Array.isArray(list)) return [];
  return list.map((i) => i && typeof i === 'object' ? {
    name: clean(i.name, 100),
    kind: clean(i.kind, 40),
    why: clean(i.why, 280),
    where: clean(i.where, 120),
    when: clean(i.when, 80),
    cost: clean(i.cost, 40),
    url: https(i.url),
  } : null).filter((i) => i && i.name).slice(0, MAX);
}

const TOOL = {
  name: 'things_to_do',
  description: 'Report the things to do you found for this trip.',
  input_schema: {
    type: 'object',
    properties: {
      ideas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            kind: { type: 'string', description: 'One or two words: "Beach", "Food", "Outdoors", "Museum", "Nightlife", "Tour", "Kids", "Event".' },
            why: { type: 'string', description: 'One sentence on why it is worth it for this trip.' },
            where: { type: 'string', description: 'Area or distance, e.g. "Seaside, 10 min drive".' },
            when: { type: 'string', description: 'Best time or the dates it is on, if it matters.' },
            cost: { type: 'string', description: 'Rough price, e.g. "Free", "$25 a person".' },
            url: { type: 'string', description: 'https link to its own site, if found.' },
          },
          required: ['name', 'why'],
        },
      },
    },
    required: ['ideas'],
  },
};

module.exports = { validate, TOOL, MAX };
