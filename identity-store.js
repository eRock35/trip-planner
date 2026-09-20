// The store adapter every app hands to shared/identity.js.
//
// This deliberately does NOT go through lib/store.js. That one is bound to the
// app's own database (`eriks-projects` here), and the whole point of the shared
// account is that football, dataviz, friction and trip-planner read the SAME
// user records. Pointing identity at an app's own database would give each app
// its own private set of users that merely looked shared.
//
// Copy this file alongside shared/identity.js when wiring up another app; the
// only thing that changes per app is nothing at all.

const { Firestore } = require('@google-cloud/firestore');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'metal-celerity-236019';
const DATABASE = process.env.IDENTITY_DATABASE_ID || 'identity';

let db = null;
function client() {
  if (!db) db = new Firestore({ projectId: PROJECT, databaseId: DATABASE });
  return db;
}

/** Append-only collections (events, usage) have no natural key. Time-ordered
 *  prefix so a plain document-id sort is roughly chronological. */
function autoId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const store = {
  async get(collection, id) {
    const snap = await client().collection(collection).doc(id).get();
    return snap.exists ? snap.data() : null;
  },
  async set(collection, id, value) {
    await client().collection(collection).doc(id).set(value);
  },
  async remove(collection, id) {
    await client().collection(collection).doc(id).delete();
  },
  async list(collection) {
    const snap = await client().collection(collection).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async add(collection, value) {
    const id = autoId();
    await client().collection(collection).doc(id).set(value);
    return id;
  },
};

module.exports = { store, databaseId: () => DATABASE };
