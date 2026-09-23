/**
 * Private photo storage: one Cloud Storage bucket per app, never public.
 *
 * Shared by Trip Planner and the vacation app (synced by
 * scripts/sync-shared.js). Plain REST against storage.googleapis.com with
 * the service's own runtime identity, the same way every other Google call in
 * these apps works - no SDK, no key file.
 *
 * WHY THE APP SERVES EVERY PHOTO ITSELF, rather than handing out links:
 *   - Each bucket has public access prevention ENFORCED. Nothing in it can be
 *     made public, by mistake or otherwise. The vacation app's bucket holds
 *     photos of two young children; that setting is the point.
 *   - A signed URL would be a bearer link: whoever holds it sees the photo,
 *     signed in or not, until it expires. Streaming through the app means
 *     every single photo request passes the same sign-in and ownership check
 *     as the page that shows it.
 *   - Signing needs iam.serviceAccounts.signBlob on the runtime account,
 *     which none of them hold, and should not gain for this.
 *
 * Configured by PHOTOS_BUCKET. Without it the feature reports itself
 * unavailable rather than half-working, the same as Gmail.
 */

const METADATA_TOKEN = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const API = 'https://storage.googleapis.com/storage/v1/b/';
const UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b/';

// Photos arrive already shrunk by the page (photo-tools.js): ~2048px on the
// long side, JPEG. 8 MB is a generous ceiling for that and a firm one for
// anything that skipped it.
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_THUMB_BYTES = 600 * 1024;

function create({ bucket = () => process.env.PHOTOS_BUCKET || '', fetchImpl = (...a) => fetch(...a), token = null } = {}) {
  let cached = null;

  async function accessToken() {
    if (token) return token();
    if (cached && cached.until > Date.now()) return cached.value;
    const res = await fetchImpl(METADATA_TOKEN, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw Object.assign(new Error('No runtime credentials for photo storage'), { status: 503 });
    const d = await res.json();
    cached = { value: d.access_token, until: Date.now() + Math.max(0, (d.expires_in || 300) - 60) * 1000 };
    return cached.value;
  }

  const enabled = () => !!bucket();
  const obj = (name) => encodeURIComponent(name);

  async function put(name, buffer, contentType = 'image/jpeg') {
    const url = `${UPLOAD}${encodeURIComponent(bucket())}/o?uploadType=media&name=${obj(name)}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': contentType },
      body: buffer,
    });
    if (!res.ok) throw Object.assign(new Error(`photo upload failed: ${res.status}`), { status: 502 });
    return true;
  }

  /** The bytes, or null when there is no such photo. */
  async function get(name) {
    const res = await fetchImpl(`${API}${encodeURIComponent(bucket())}/o/${obj(name)}?alt=media`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`photo read failed: ${res.status}`), { status: 502 });
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
  }

  /** Gone is gone: a 404 counts as deleted. */
  async function del(name) {
    const res = await fetchImpl(`${API}${encodeURIComponent(bucket())}/o/${obj(name)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (!res.ok && res.status !== 404) throw Object.assign(new Error(`photo delete failed: ${res.status}`), { status: 502 });
    return true;
  }

  /** Every object under a prefix - for deleting a whole trip's photos. */
  async function delPrefix(prefix) {
    let pageToken = '', n = 0;
    do {
      const res = await fetchImpl(`${API}${encodeURIComponent(bucket())}/o?prefix=${obj(prefix)}&fields=items(name),nextPageToken` + (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''), {
        headers: { Authorization: `Bearer ${await accessToken()}` },
      });
      if (!res.ok) throw Object.assign(new Error(`photo list failed: ${res.status}`), { status: 502 });
      const d = await res.json();
      // Eight at a time: a trip of 500 photos is 1,000 objects, and one at a
      // time inside a single request would be a minute of round trips.
      const names = (d.items || []).map((it) => it.name);
      for (let k = 0; k < names.length; k += 8) {
        await Promise.all(names.slice(k, k + 8).map((name) => del(name)));
      }
      n += names.length;
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    return n;
  }

  return { enabled, put, get, del, delPrefix };
}

/**
 * A base64 image from the page, checked: a real JPEG/PNG/WebP by its first
 * bytes (not by what the request claims), and under the ceiling. Returns
 * { buffer, contentType } or { error }.
 */
function imageBuffer(b64, maxBytes = MAX_PHOTO_BYTES) {
  const data = String(b64 || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!data) return { error: 'No photo came through.' };
  if (Math.floor(data.length * 3 / 4) > maxBytes) return { error: 'That photo is too large.' };
  let buffer;
  try { buffer = Buffer.from(data, 'base64'); } catch (e) { return { error: 'That photo could not be read.' }; }
  if (buffer.length < 12) return { error: 'That photo could not be read.' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { buffer, contentType: 'image/jpeg' };
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { buffer, contentType: 'image/png' };
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') return { buffer, contentType: 'image/webp' };
  return { error: 'That file is not a photo (JPEG, PNG or WebP).' };
}

/** A caption or a date from the page, bounded. */
const caption = (v) => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
/** "2026-09-24T18:32:05" as the camera recorded it (local time, no zone),
 *  or null. Kept as the camera's wall-clock time on purpose: a sunset at
 *  6:32 PM on the beach should say 6:32 PM, whatever the server's zone. */
function takenAt(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4] || '12'}:${m[5] || '00'}:${m[6] || '00'}`;
}

module.exports = { create, imageBuffer, caption, takenAt, MAX_PHOTO_BYTES, MAX_THUMB_BYTES };
