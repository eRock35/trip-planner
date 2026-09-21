// Bring your own key: storing someone else's Anthropic credential.
//
// The threat this has to survive is a leaked Firestore export, so the key is
// never stored in the clear and never read back to the browser - the account
// panel shows the last four characters and nothing else.
//
// WHY NOT CLOUD KMS. It was the first choice and is still the right one. The
// deployer service account has `cloudkms.keyRings.create` denied (the same
// permission gap as cloudscheduler.jobs.create and the domain mapping), so
// the keyring cannot be created from here. The KMS API itself is now enabled
// on the project, so the upgrade needs one console action from Erik and no
// code change beyond a v2 branch below.
//
// What is here instead: AES-256-GCM under a 32-byte key held in Secret
// Manager as `byok-encryption-key`. In THIS deployment that is close to the
// same guarantee - a container compromised enough to read the secret already
// holds the Anthropic key, the Stripe key and the session secrets - but it is
// weaker against a stolen database copy PLUS a stolen secret, which KMS would
// not be, because KMS never hands out the key material at all.
//
// Two details that make the upgrade free:
//   - every ciphertext carries a version tag (`v1.`), so a later KMS-wrapped
//     `v2.` can be written alongside and old rows still decrypt;
//   - the uid is the GCM additional-authenticated-data, so a ciphertext
//     copied into another account's record fails to decrypt rather than
//     quietly working. Re-encrypting under KMS keeps that binding.

const crypto = require('crypto');

const VERSION = 'v1';
const IV_BYTES = 12;

function create(opts) {
  const { secret, validateUrl = 'https://api.anthropic.com/v1/models' } = opts;

  function key() {
    const raw = String(secret() || '');
    if (!raw) return null;
    const buf = Buffer.from(raw, 'base64');
    // A short key would "work" and give a fraction of the intended strength,
    // which is the kind of thing nobody notices. Refuse it.
    if (buf.length !== 32) return null;
    return buf;
  }

  function enabled() {
    return Boolean(key());
  }

  function encrypt(uid, plaintext) {
    const k = key();
    if (!k) throw Object.assign(new Error('Key storage is not configured on this deployment.'), { status: 503 });
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
    cipher.setAAD(Buffer.from(String(uid)));
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }

  /** Null rather than throwing: a key that cannot be decrypted - rotated
   *  secret, record copied between accounts - should degrade to "no key on
   *  file", not to a 500 on every request the user makes. */
  function decrypt(uid, blob) {
    try {
      const k = key();
      if (!k || !blob) return null;
      const [version, iv, tag, ct] = String(blob).split('.');
      if (version !== VERSION) return null;
      const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
      d.setAAD(Buffer.from(String(uid)));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
    } catch (e) {
      return null;
    }
  }

  /** All anyone ever sees of their stored key again. */
  function last4(apiKey) {
    const s = String(apiKey || '');
    return s.length > 4 ? s.slice(-4) : '';
  }

  /** Prove it works before storing it. A listing costs no tokens, so a typo
   *  is caught here rather than as a failed answer an hour later. */
  async function validate(apiKey) {
    const s = String(apiKey || '').trim();
    if (!s) return { ok: false, error: 'Paste your API key first.' };
    if (!/^sk-ant-/.test(s)) {
      return { ok: false, error: 'That does not look like an Anthropic API key - they start with "sk-ant-".' };
    }
    try {
      const res = await fetch(validateUrl, {
        headers: { 'x-api-key': s, 'anthropic-version': '2023-06-01' },
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Anthropic rejected that key. Check you copied all of it.' };
      }
      if (!res.ok) return { ok: false, error: `Anthropic answered ${res.status}. Try again in a moment.` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'Could not reach Anthropic to check that key.' };
    }
  }

  return { enabled, encrypt, decrypt, last4, validate, VERSION };
}

module.exports = { create, VERSION };
