/**
 * Reading a photo of a receipt into one spending line.
 *
 * Shared by Trip Planner and the vacation app (synced by
 * scripts/sync-shared.js). Each app makes the model call itself - Trip
 * Planner through its metered completeTurn(), the vacation app on its own
 * key - so this file only shapes the request and checks the answer.
 *
 * Three rules, the same ones every model-written thing in these apps follows:
 *
 *   1. The model PROPOSES. What comes back is shown as an editable card and
 *      saved only when someone taps Add. A misread total is a thing a person
 *      corrects before it counts, not after.
 *   2. The answer is checked, not trusted. A total that is not a positive
 *      amount, a date that is not a date, a category that is not one of the
 *      app's own - each is dropped to "unknown" rather than stored as if read.
 *   3. The photo is not kept. It is read once for this request and dropped,
 *      the way Gmail message bodies are. The receipt's line is the record.
 */

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
// The API's own ceiling per image is 5 MB of decoded bytes. The pages shrink a
// receipt to ~1600px before sending, which is a few hundred KB; this is the
// backstop for a page that did not.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const clean = (v, n) => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

function amount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' && !/\d/.test(String(v))) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

function isoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return m[0];
}

/** The image as the browser sent it: base64 plus a media type. Returns the
 *  API's image block, or { error } in words a person can act on. */
function imageBlock(image) {
  const mediaType = String((image && image.mediaType) || '').toLowerCase();
  const data = String((image && image.data) || '').replace(/^data:[^;]+;base64,/, '');
  if (!MEDIA_TYPES.includes(mediaType)) return { error: 'That file is not a photo this can read (JPEG, PNG or WebP).' };
  if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return { error: 'No photo came through. Try again.' };
  const bytes = Math.floor(data.replace(/\s/g, '').length * 3 / 4);
  if (bytes > MAX_IMAGE_BYTES) return { error: 'That photo is too large. Try again - the page usually shrinks it first.' };
  return { block: { type: 'image', source: { type: 'base64', media_type: mediaType, data: data.replace(/\s/g, '') } } };
}

function tool(categories) {
  return {
    name: 'record_receipt',
    description: 'Record what this receipt says was paid.',
    input_schema: {
      type: 'object',
      properties: {
        readable: { type: 'boolean', description: 'false if this is not a receipt or the total cannot be read.' },
        merchant: { type: 'string', description: 'The business name as a person would say it: "Publix", "The Donut Hole", "Shell".' },
        total: { type: 'number', description: 'The final amount paid, including tax - and the tip, if a tip is written or printed on it.' },
        currency: { type: 'string', description: 'Three-letter code. USD unless the receipt clearly says otherwise.' },
        date: { type: 'string', description: 'The purchase date as YYYY-MM-DD, or empty if it is not on the receipt.' },
        category: { type: 'string', enum: categories },
        items: {
          type: 'array',
          description: 'Up to 12 of the main line items, for the note. Skip if it is a long grocery receipt.',
          items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' } }, required: ['name'] },
        },
        note: { type: 'string', description: 'One short line: what this was, e.g. "Groceries for the week" or "Dinner for 4, tip included".' },
      },
      required: ['readable'],
    },
  };
}

/** The request body, minus the model and the call itself. `context` is a
 *  line or two about the trip so "which category" has something to go on. */
function request({ categories, image, context }) {
  const img = imageBlock(image);
  if (img.error) return img;
  return {
    params: {
      max_tokens: 1500,
      system:
        'You read photos of receipts for a family travel budget. Read the FINAL total actually paid - after tax, and ' +
        'including a tip if one is written or printed. If the photo is blurry, cut off or not a receipt, say readable: ' +
        'false rather than guessing a number. Pick the one category that fits best.' +
        (context ? '\n\nThe trip: ' + clean(context, 600) : ''),
      tools: [tool(categories)],
      tool_choice: { type: 'tool', name: 'record_receipt' },
      messages: [{ role: 'user', content: [img.block, { type: 'text', text: 'Read this receipt.' }] }],
    },
  };
}

/** The model's answer, checked. Returns a proposed line, or { error }. */
function read(response, categories) {
  const blocks = (response && response.content) || [];
  const b = blocks.find((x) => x && x.type === 'tool_use' && x.name === 'record_receipt');
  const r = (b && b.input) || {};
  if (!b || r.readable === false) return { error: 'Could not read a total on that receipt. Try a sharper, flatter photo - or add it by hand.' };
  const total = amount(r.total);
  if (total == null) return { error: 'Could not read a total on that receipt. Try a sharper, flatter photo - or add it by hand.' };
  const cat = clean(r.category, 60);
  const items = (Array.isArray(r.items) ? r.items : []).slice(0, 12)
    .map((i) => ({ name: clean(i && i.name, 60), amount: amount(i && i.amount) }))
    .filter((i) => i.name);
  return {
    receipt: {
      merchant: clean(r.merchant, 80) || 'Receipt',
      total,
      currency: /^[A-Z]{3}$/.test(String(r.currency || '').toUpperCase()) ? String(r.currency).toUpperCase() : 'USD',
      date: isoDate(r.date),
      category: categories.find((c) => c.toLowerCase() === cat.toLowerCase()) || categories[categories.length - 1],
      note: clean(r.note, 160),
      items,
    },
  };
}

module.exports = { request, read, imageBlock, tool, amount, isoDate, MEDIA_TYPES, MAX_IMAGE_BYTES };
