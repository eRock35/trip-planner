// Shared test harness: one in-memory Firestore shared across every app and the
// identity database, so a session minted on one app is honoured on another.
const Module = require('module');

const DBS = new Map();
function bag(dbId) { if (!DBS.has(dbId)) DBS.set(dbId, new Map()); return DBS.get(dbId); }

class FakeFirestore {
  constructor(opts = {}) { this.dbId = opts.databaseId || '(default)'; }
  collection(name) {
    const store = bag(this.dbId);
    const mk = (filters = [], order = null, lim = 0) => ({
      where(f, op, v) { return mk(filters.concat([[f, op, v]]), order, lim); },
      orderBy(f, dir) { return mk(filters, [f, dir], lim); },
      limit(n) { return mk(filters, order, n); },
      async get() {
        let rows = [];
        // Real query snapshots carry .ref, and app code uses it to reach a
        // subcollection (trip -> watches). Without it the harness silently
        // returned parents with no children and a test looked like a bug in
        // the app.
        const self = this;
        for (const [k, v] of store) if (k.startsWith(name + '/')) {
          const id = k.slice(name.length + 1);
          if (id.includes('/')) continue;            // a subcollection doc, not one of ours
          rows.push({ id, data: () => v, exists: true, get ref() { return self.doc(id); } });
        }
        for (const [f, op, val] of filters) rows = rows.filter((r) => {
          const got = r.data()[f];
          if (op === '==') return got === val;
          if (op === '>=') return String(got || '') >= String(val);
          if (op === '<=') return String(got || '') <= String(val);
          if (op === '>') return String(got || '') > String(val);
          if (op === '<') return String(got || '') < String(val);
          if (op === '!=') return got !== val;
          // An unimplemented operator silently keeping every row makes a
          // watermark look broken when it is not. Fail loudly instead.
          throw new Error('harness: unsupported where operator ' + op);
        });
        if (order) { rows.sort((a, b) => String(a.data()[order[0]] || '').localeCompare(String(b.data()[order[0]] || ''))); if (order[1] === 'desc') rows.reverse(); }
        if (lim) rows = rows.slice(0, lim);
        return { docs: rows, empty: !rows.length, size: rows.length };
      },
      count() { return { get: async () => ({ data: () => ({ count: 0 }) }) }; },
      async add(value) {
        noNestedArrays(value);
        const id = 'a' + Math.random().toString(36).slice(2, 11);
        store.set(name + '/' + id, JSON.parse(JSON.stringify(value)));
        return this.doc(id); // callers read the ref back, so return a real one
      },
      doc(id) {
        const key = name + '/' + (id || 'auto' + Math.random().toString(36).slice(2));
        return { id: key.slice(name.length + 1),
          async get() { const d = store.get(key); return { exists: d !== undefined, id: key.slice(name.length + 1), data: () => d }; },
          async set(v, o) { noNestedArrays(v); store.set(key, o && o.merge ? applyIncrements(store.get(key), v) : JSON.parse(JSON.stringify(v))); },
          async update(v) { noNestedArrays(v); store.set(key, Object.assign({}, store.get(key) || {}, v)); },
          async delete() { store.delete(key); },
          collection: (sub) => new FakeFirestore({ databaseId: 'sub' }).collection(key + '/' + sub) };
      },
    });
    return mk();
  }
  batch() { const ops = []; return { set(r, v, o) { ops.push([r, v, o]); }, delete(r) { ops.push([r, null]); }, async commit() { for (const [r, v, o] of ops) v === null ? await r.delete() : await r.set(v, o); } }; }
}


/**
 * Firestore refuses to store an array inside an array, and the fake has to
 * refuse it too.
 *
 * This is not pedantry about a fake. `days[].blocks` is a list of [time, plan]
 * PAIRS, so writing an itinerary back is exactly an array of arrays - and
 * every Apply in the vacation app and the trip planner failed in production
 * with
 *
 *     3 INVALID_ARGUMENT: Property array contains an invalid nested entity.
 *
 * while every test passed, because the fake happily stored the shape the real
 * database rejects. A fake that accepts more than the real thing does not
 * catch bugs; it hides them, and it hid this one from the day the schedule
 * moved into Firestore.
 */
function noNestedArrays(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (Array.isArray(item)) {
        throw Object.assign(
          new Error(`3 INVALID_ARGUMENT: Property array contains an invalid nested entity. (at ${path || 'root'}[${i}])`),
          { code: 3 },
        );
      }
      noNestedArrays(item, `${path}[${i}]`);
    }
    return value;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) noNestedArrays(v, path ? `${path}.${k}` : k);
  }
  return value;
}

function install() {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (r, ...rest) {
    if (r === '@google-cloud/firestore') return 'FAKE_FS';
    if (r === '@anthropic-ai/sdk') return 'FAKE_AN';
    return orig.call(this, r, ...rest);
  };
  require.cache['FAKE_FS'] = { id: 'FAKE_FS', filename: 'FAKE_FS', loaded: true, exports: { Firestore: FakeFirestore, FieldValue } };
  require.cache['FAKE_AN'] = { id: 'FAKE_AN', filename: 'FAKE_AN', loaded: true, exports: function () {
    return { messages: { create: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), batches: {} } };
  } };
}

const crypto = require('crypto');
function session(secret, email, via = 'password') {
  const uid = Buffer.from(String(email).toLowerCase()).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600, via })).toString('base64url');
  return 'stc_session=' + encodeURIComponent(body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url'));
}

// Firestore's atomic increment, which the real store uses for the spend
// ledger. Without it a bump() silently does nothing and a budget looks
// unspent.
const FieldValue = {
  increment(by) { return { __increment: by }; },
};
function applyIncrements(existing, patch) {
  const out = Object.assign({}, existing || {});
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && typeof v.__increment === 'number') {
      out[k] = Number(out[k] || 0) + v.__increment;
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { bag, install, session, DBS, FieldValue };
