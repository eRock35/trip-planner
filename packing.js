/**
 * A trip's packing list.
 *
 * Stored one document per item under trips/<id>/packing, not as one array on
 * the trip. The list is the thing two people tick at the same time, standing
 * in two bedrooms; with one array, the second phone's save would write back a
 * list that did not have the first phone's tick in it. One document each, and
 * a tick is a write to that item alone.
 *
 * The vacation app kept its list in localStorage - per phone - and said so on
 * the page. This one is shared, which is the point of having it on a server.
 */
const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const MAX_ITEMS = 300;
const DEFAULT_GROUP = 'Other';

/** One item as a person or a model wrote it, or null if there is nothing. */
function item(i) {
  if (!i || typeof i !== 'object') return null;
  const text = clean(i.text, 140);
  if (!text) return null;
  return { text, group: clean(i.group, 40) || DEFAULT_GROUP };
}

/** Suggested items, minus anything already on the list (case and spacing
 *  ignored) and minus repeats within the suggestion itself. */
function newOnly(suggested, existing) {
  const key = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const have = new Set((existing || []).map((e) => key(e.text)));
  const out = [];
  for (const s of (Array.isArray(suggested) ? suggested : [])) {
    const it = item(s);
    if (!it || have.has(key(it.text))) continue;
    have.add(key(it.text));
    out.push(it);
    if (out.length >= 60) break;
  }
  return out;
}

const TOOL = {
  name: 'packing_list',
  description: 'Report the packing list you suggest for this trip.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The thing to pack, with a short reason when it is not obvious, e.g. "Rain jacket - showers Thursday".' },
            group: { type: 'string', description: 'A person when the trip notes name who is going ("Son (6)"), otherwise a category: Clothes, Toiletries, Documents, Tech, Beach, Kids, Car, Other.' },
          },
          required: ['text', 'group'],
        },
      },
    },
    required: ['items'],
  },
};

module.exports = { item, newOnly, TOOL, MAX_ITEMS, DEFAULT_GROUP };
