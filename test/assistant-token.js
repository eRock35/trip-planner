// Assistant access (2026-11-24): a read-only token someone makes in the
// Account sheet so their own texting assistant can read their trips.
//
// What this holds: a token is shown once and only its hash is stored; at most
// three; it reads exactly the trips its account can see signed in (own, and
// shared to a confirmed address) and nobody else's; the summary masks
// confirmation numbers and carries no notes, links, emails or prices of one
// booking; a revoked or wrong token is a bare 401; nothing but GET exists;
// the token opens none of the session's routes and a session opens none of
// the token's; uses are limited and logged without the token.
const h = require('./harness.js');
h.install();
const crypto = require('crypto');
const path = require('path');

Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9261',
  ASSISTANT_PER_MINUTE: '40',
});

// Everything the server logs, to check a token never reaches the log.
const logged = [];
for (const k of ['log', 'error', 'warn']) {
  const real = console[k].bind(console);
  console[k] = (...a) => { logged.push(a.map(String).join(' ')); if (k === 'log' && !/^\[assistant\]|listening/.test(String(a[0]))) real(...a); };
}

require(path.join(__dirname, '..', 'server.js'));
const assistantLib = require(path.join(__dirname, '..', 'assistant.js'));
const identityLib = require(path.join(__dirname, '..', 'identity.js'));

const B = 'http://127.0.0.1:9261';
const A = '/api/assistant/v1';
const tp = h.bag('trip-planner'), idb = h.bag('identity');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const call = async (method, p, body, cookie, extra) => {
  const r = await fetch(B + p, { method, headers: Object.assign({}, body === undefined ? {} : J, cookie ? { cookie } : {}, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
const withToken = (method, p, token, body) => call(method, p, body, null, { authorization: 'Bearer ' + token });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const register = async (email) => jar(await fetch(B + '/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ email, password: 'a-long-password-1' }) }));
const mk = async (cookie, label) => (await call('POST', '/api/account/assistant-tokens', label === undefined ? {} : { label }, cookie));

(async () => {
  await new Promise((r) => setTimeout(r, 900));

  /* ---------- the parts with no server in them ---------- */
  ok('a confirmation number shows its last four only', assistantLib.maskConfirmation('ABC-123 XYZ9') === '****XYZ9');
  ok('...four characters or fewer show nothing of it', assistantLib.maskConfirmation('K7Q2') === '****' && assistantLib.maskConfirmation('') === '');
  ok('a flight number is read from the title', assistantLib.flightNumber({ title: 'ATL to LIS - TP 1362' }) === 'TP 1362' &&
     assistantLib.flightNumber({ title: 'Lisbon to Atlanta', provider: 'Delta 1234' }) === 'Delta 1234' &&
     assistantLib.flightNumber({ title: 'Flight home Oct 12' }) === '');
  let clock = 0;
  const lim = assistantLib.limiter({ max: 2, windowMs: 60000, now: () => clock });
  ok('the limiter allows the limit, then says how long to wait', lim.take('a') === 0 && lim.take('a') === 0 && lim.take('a') === 60 && lim.take('b') === 0);
  clock = 61000;
  ok('...and lets go when the window has passed', lim.take('a') === 0);
  ok('only a token of our exact shape is read from the header',
     assistantLib.bearer({ headers: { authorization: 'Bearer tp_ro_' + 'a'.repeat(43) } }) !== '' &&
     assistantLib.bearer({ headers: { authorization: 'Bearer tp_ro_short' } }) === '' &&
     assistantLib.bearer({ headers: { authorization: 'Basic tp_ro_' + 'a'.repeat(43) } }) === '' &&
     assistantLib.bearer({ headers: {} }) === '');

  /* ---------- the page ---------- */
  const page = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const ui = page.slice(page.indexOf('/* ---------- Assistant access: read-only tokens'), page.indexOf('aiRequestBtn.addEventListener("click", openCreditSheet)'));
  ok('the Account sheet has an Assistant access row', /accountRow\("Assistant access", [^)]*openAssistantSheet\)/.test(page));
  ok('...with a copy button, a list and a revoke', /id="asCopyBtn"/.test(page) && /id="asList"/.test(page) && />Revoke</.test(ui));
  ok('the page keeps the token in memory only, and drops it when the sheet closes', !/localStorage|sessionStorage|document\.cookie/.test(ui) && /onClose: function \(\) \{ asFresh = "";/.test(ui));
  ok('labels are escaped before they are drawn', /escapeHtml\(t\.label\)/.test(ui) && !/'\s*\+\s*t\.label\s*\+\s*'</.test(ui));

  /* ---------- people and trips ---------- */
  const erik = await register('erik@example.com');
  const sarah = await register('sarah@example.com');
  const bob = await register('bob@example.com');
  const lisbon = (await call('POST', '/api/trips', { name: 'Lisbon', destination: 'Lisbon, Portugal', dateRange: 'Mar 4-8, 2027', notes: 'Door code 4455 is in the notes' }, erik)).body;
  const sarahs = (await call('POST', '/api/trips', { name: 'Girls weekend', destination: 'Savannah, GA', dateRange: 'May 2027' }, sarah)).body;
  const bobs = (await call('POST', '/api/trips', { name: 'Bob in Reno', destination: 'Reno, NV' }, bob)).body;
  await call('POST', `/api/trips/${sarahs.id}/share`, { email: 'erik@example.com' }, sarah);
  await call('POST', `/api/trips/${lisbon.id}/share`, { email: 'sarah@example.com' }, erik);
  let r = await call('POST', `/api/trips/${lisbon.id}/schedule/apply`, { days: [
    { title: 'Arrive', date: '2027-03-04', dateLabel: 'Thu, Mar 4', blocks: [['10:25 AM', 'Land at LIS'], ['3:00 PM', 'Check in']] },
    { title: 'Sintra', date: '2027-03-05', dateLabel: 'Fri, Mar 5', blocks: [['9:00 AM', 'Train to Sintra']] },
  ] }, erik);
  ok('(setup) an itinerary is saved', r.status === 200, r.text.slice(0, 120));
  Object.assign(tp.get('trips/' + lisbon.id), { bookings: [
    { id: 'bk000001', kind: 'stay', title: 'Hotel Avenida Palace', provider: 'Booking.com', confirmation: 'HX-99-4471-8830', when: 'Thu, Mar 4 - after 3 PM', until: 'Mon, Mar 8 - by 11 AM', date: '2027-03-04', address: 'Rua 1 de Dezembro 123, Lisbon', phone: '+351 21 321 8100', url: 'https://example.com/manage?key=SECRETLINK', notes: 'Door code 4455', total: 912.4 },
    { id: 'bk000002', kind: 'flight', title: 'ATL to LIS - TP 1362', provider: 'TAP', confirmation: 'QWERTY', when: 'Wed, Mar 3 - 9:05 PM', until: 'Thu, Mar 4 - 10:25 AM', date: '2027-03-03', total: 1310 },
    { id: 'bk000003', kind: 'reservation', title: 'Dinner at Ramiro', confirmation: 'R12' },
  ] });
  await call('POST', `/api/trips/${lisbon.id}/packing`, { items: [{ text: 'Passports', group: 'Documents' }, { text: 'Adapter', group: 'Tech' }, { text: 'Rain jacket', group: 'Clothes' }] }, erik);
  const pk = (await call('GET', `/api/trips/${lisbon.id}/packing`, undefined, erik)).body.items;
  await call('PATCH', `/api/trips/${lisbon.id}/packing/${pk[0].id}`, { checked: true }, erik);
  await call('POST', `/api/trips/${lisbon.id}/budget/lines`, { lines: [
    { label: 'Dinners', category: 'Food', planned: 400, spent: 120.5 },
    { label: 'Tram passes', category: 'Transport', planned: 60, spent: 30, currency: 'EUR' },
  ] }, erik);
  await call('PUT', `/api/trips/${lisbon.id}/budget/target`, { target: 3500 }, erik);

  /* ---------- create: shown once, hash only ---------- */
  r = await call('GET', '/api/account/assistant-tokens', undefined, erik);
  ok('a new account has no tokens, and is told the limit', r.status === 200 && r.body.tokens.length === 0 && r.body.max === 3, r.text);
  r = await mk(erik, 'Atlas <on the VM>');
  const T = r.body && r.body.token;
  ok('creating one returns the token', r.status === 200 && assistantLib.TOKEN_RE.test(String(T)), r.text.slice(0, 80));
  ok('...recognisable by its prefix, with 32 random bytes behind it', String(T).startsWith('tp_ro_') && Buffer.from(String(T).slice(6), 'base64url').length === 32);
  ok('...with its label cleaned and no hash', r.body.created.label === 'Atlas on the VM' && !('hash' in r.body.created) && !!r.body.created.id);
  ok('...never cached', /no-store/.test(r.headers.get('cache-control') || ''));
  const tid = r.body.created.id;
  r = await call('GET', '/api/account/assistant-tokens', undefined, erik);
  ok('the list has it: label, created, never used', r.body.tokens.length === 1 && r.body.tokens[0].id === tid && r.body.tokens[0].label === 'Atlas on the VM' &&
     !!r.body.tokens[0].createdAt && r.body.tokens[0].lastUsedAt === null, r.text);
  ok('the token is shown ONCE: the list never carries it, or its hash', !r.text.includes(T) && !r.text.includes(T.slice(6)) && !/hash/.test(r.text));
  const hash = crypto.createHash('sha256').update(T).digest('hex');
  const rec = tp.get('assistant-tokens/' + hash);
  ok('what is stored is sha256(token), the uid, the label and two times', !!rec && rec.hash === hash && rec.uid === identityLib.uidFor('erik@example.com') &&
     Object.keys(rec).sort().join() === 'createdAt,hash,id,label,lastUsedAt,uid', rec && Object.keys(rec).join());
  const everything = () => JSON.stringify([...h.DBS.values()].map((m) => [...m.entries()]));
  ok('the token itself is nowhere in any database', !everything().includes(T) && !everything().includes(T.slice(6)));

  /* ---------- who may create ---------- */
  r = await call('POST', '/api/account/assistant-tokens', {});
  ok('signed out: no token', r.status === 401);
  r = await call('POST', '/api/account/assistant-tokens', {}, erik, { origin: 'https://evil.example.com' });
  ok('a write from another origin is refused', r.status === 403, r.status);
  r = await call('POST', '/api/account/assistant-tokens', {}, erik, { 'sec-fetch-site': 'same-site' });
  ok('...and from a sibling site', r.status === 403, r.status);
  r = await fetch(B + '/api/account/assistant-tokens', { method: 'POST', headers: { cookie: erik, 'content-type': 'application/x-www-form-urlencoded' }, body: 'label=x' });
  ok('...and a plain form post', r.status === 403, r.status);
  r = await call('DELETE', '/api/account/assistant-tokens/' + tid, undefined, erik, { origin: 'https://evil.example.com' });
  ok('...a revoke from another origin too', r.status === 403, r.status);
  r = await withToken('POST', '/api/account/assistant-tokens', T, {});
  ok('a token cannot make another token', r.status === 401, r.status);
  r = await withToken('GET', '/api/account/assistant-tokens', T);
  ok('...or list them', r.status === 401, r.status);

  /* ---------- at most three ---------- */
  const two = await Promise.all([mk(erik, 'Second'), mk(erik, 'Third'), mk(erik, 'Fourth'), mk(erik, 'Fifth')]);
  ok('four more at once: two are made, two refused', two.filter((x) => x.status === 200).length === 2 && two.filter((x) => x.status === 409).length === 2, two.map((x) => x.status).join());
  r = await call('GET', '/api/account/assistant-tokens', undefined, erik);
  ok('...and the account holds three', r.body.tokens.length === 3);
  const T2 = two.find((x) => x.status === 200).body.token;
  r = await call('GET', '/api/account/assistant-tokens', undefined, bob);
  ok('nobody else sees them', r.body.tokens.length === 0);
  r = await call('DELETE', '/api/account/assistant-tokens/' + tid, undefined, bob);
  ok('nobody else can revoke one', r.status === 404 && tp.has('assistant-tokens/' + hash), r.status);

  /* ---------- reading: the list ---------- */
  r = await withToken('GET', A + '/trips', T);
  const ids = ((r.body && r.body.trips) || []).map((t) => t.id).sort();
  ok('the token lists its account\'s own trip', r.status === 200 && ids.includes(lisbon.id), r.text.slice(0, 200));
  ok('...and the one shared to it', ids.includes(sarahs.id) && r.body.trips.find((t) => t.id === sarahs.id).role === 'member');
  ok('...and nobody else\'s', ids.length === 2 && !ids.includes(bobs.id), ids.join());
  const signedIn = (await call('GET', '/api/trips', undefined, erik)).body.map((t) => t.id).sort();
  ok('exactly the trips the signed-in list shows', signedIn.join() === ids.join());
  ok('the list carries no email address', !r.text.includes('@'), r.text);
  ok('...and is not cached', /no-store/.test(r.headers.get('cache-control') || ''));
  const row = r.body.trips.find((t) => t.id === lisbon.id);
  ok('a row has the name, place, dates and day count', row.name === 'Lisbon' && row.place === 'Lisbon, Portugal' && row.dates.start === '2027-03-04' && row.days === 2 && row.role === 'owner', JSON.stringify(row));

  /* ---------- reading: one trip ---------- */
  r = await withToken('GET', `${A}/trips/${lisbon.id}`, T);
  const s = r.body || {};
  ok('a trip\'s summary opens', r.status === 200 && s.name === 'Lisbon' && s.place === 'Lisbon, Portugal' && s.dates && s.dates.start === '2027-03-04' && s.dates.end === '2027-03-05', r.text.slice(0, 200));
  ok('...the itinerary with times and titles', s.days.length === 2 && s.days[0].title === 'Arrive' && s.days[0].date === '2027-03-04' &&
     s.days[0].items[0].time === '10:25 AM' && s.days[0].items[0].title === 'Land at LIS', JSON.stringify(s.days));
  const flight = s.bookings.find((b) => b.type === 'flight'), stay = s.bookings.find((b) => b.type === 'stay');
  ok('...the hotel: name, times, address', stay.name === 'Hotel Avenida Palace' && stay.start === 'Thu, Mar 4 - after 3 PM' && stay.end === 'Mon, Mar 8 - by 11 AM' && /Rua 1 de Dezembro/.test(stay.address), JSON.stringify(stay));
  ok('...the flight: number and landing time', flight.flightNumber === 'TP 1362' && flight.end === 'Thu, Mar 4 - 10:25 AM', JSON.stringify(flight));
  ok('confirmation numbers are masked to the last four', stay.confirmation === '****8830' && flight.confirmation === '****ERTY' &&
     !r.text.includes('HX-99') && !r.text.includes('4471') && !r.text.includes('QWERTY'), r.text.slice(0, 400));
  ok('...a short one shows nothing', s.bookings.find((b) => b.type === 'reservation').confirmation === '****' && !r.text.includes('R12'));
  ok('no booking notes, links, phone numbers or prices of one booking', !/Door code|4455|SECRETLINK|example\.com|\+351|912\.4|1310/.test(r.text), r.text);
  ok('no email address, of anyone', !r.text.includes('@') && !/sharing|members|ownerId|memberIds/.test(r.text));
  ok('no trip notes, chat or photos', !/notes|messages|photo/i.test(r.text));
  ok('packing totals', s.packing.items === 3 && s.packing.packed === 1 && s.packing.left === 2, JSON.stringify(s.packing));
  ok('budget totals, per currency and never converted', s.budget.target === 3500 && s.budget.lines === 2 && s.budget.currency === 'USD' &&
     s.budget.totals.USD.planned === 400 && s.budget.totals.USD.spent === 120.5 && s.budget.totals.EUR.spent === 30 && s.budget.bookedUsd === 2222.4, JSON.stringify(s.budget));
  r = await withToken('GET', `${A}/trips/${sarahs.id}`, T);
  ok('a shared trip opens, as a member', r.status === 200 && r.body.role === 'member' && r.body.name === 'Girls weekend' && !r.text.includes('@'));
  r = await withToken('GET', `${A}/trips/${bobs.id}`, T);
  const missing = await withToken('GET', `${A}/trips/nosuchtrip123`, T);
  ok('someone else\'s trip is a 404, the same as one that does not exist', r.status === 404 && missing.status === 404 && r.text === missing.text, r.status + ' ' + missing.status);
  r = await withToken('GET', `${A}/trips/demo`, T);
  ok('the example trip is not served here', r.status === 404);
  r = await withToken('GET', `${A}/trips/${lisbon.id}/photos`, T);
  ok('there is no deeper route: photos, chat, anything else is a 404 in JSON', r.status === 404 && r.body && r.body.error === 'Not found.');
  r = await withToken('GET', '/api/assistant/v2/trips', T);
  ok('...and no other version', r.status === 404);

  /* ---------- last used ---------- */
  r = await call('GET', '/api/account/assistant-tokens', undefined, erik);
  const used = r.body.tokens.find((t) => t.id === tid);
  ok('the list says when a token was last used', !!used.lastUsedAt && Date.now() - Date.parse(used.lastUsedAt) < 60000 && r.body.tokens.filter((t) => t.lastUsedAt).length === 1, r.text);

  /* ---------- no writes ---------- */
  const before = everything();
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    r = await withToken(m, `${A}/trips/${lisbon.id}`, T, m === 'DELETE' ? undefined : { name: 'Changed' });
    ok(`${m} is a 405`, r.status === 405 && r.headers.get('allow') === 'GET', r.status);
  }
  r = await withToken('POST', A + '/trips', T, { name: 'New' });
  ok('POST to the list is a 405', r.status === 405);
  r = await call('POST', A + '/anything/at/all', { a: 1 });
  ok('...with no token as well: there is no write route to find', r.status === 405);
  r = await withToken('HEAD', A + '/trips', T);
  ok('HEAD and OPTIONS are not offered either', r.status === 405 && (await withToken('OPTIONS', A + '/trips', T)).status === 405);
  ok('none of that changed anything', everything() === before);

  /* ---------- the token is not a session, and a session is not a token ---------- */
  r = await withToken('GET', '/api/trips', T);
  ok('the token does not open the normal trips list', r.status === 401, r.status);
  r = await withToken('GET', `/api/trips/${lisbon.id}`, T);
  ok('...or a trip', r.status === 401);
  r = await withToken('GET', `/api/trips/${lisbon.id}/messages`, T);
  ok('...or its chat', r.status === 401);
  r = await withToken('PATCH', `/api/trips/${lisbon.id}`, T, { name: 'Changed' });
  ok('...or a write', r.status === 401 && tp.get('trips/' + lisbon.id).name === 'Lisbon');
  r = await withToken('POST', '/api/trips', T, { name: 'Made with a token' });
  ok('...or making a trip', r.status === 401);
  r = await withToken('GET', '/api/auth/me', T);
  ok('...and /api/auth/me says signed out', r.body && r.body.signedIn === false);
  r = await call('GET', '/api/trips', undefined, 'stc_session=' + T);
  ok('...nor as a cookie', r.status === 401);
  r = await call('GET', A + '/trips', undefined, erik);
  ok('a session does not open the assistant routes', r.status === 401, r.status);
  r = await call('GET', `${A}/trips/${lisbon.id}`, undefined, erik);
  ok('...not even for its own trip', r.status === 401);
  r = await call('GET', A + '/trips?token=' + T);
  ok('the token is read from the header only, never the URL', r.status === 401);

  /* ---------- wrong tokens ---------- */
  const none = await call('GET', A + '/trips');
  const garbage = await withToken('GET', A + '/trips', 'tp_ro_' + 'A'.repeat(43));
  const malformed = await withToken('GET', A + '/trips', 'hello');
  ok('no token, an unknown one and a malformed one: 401', none.status === 401 && garbage.status === 401 && malformed.status === 401);
  ok('...the same bare answer for each', none.text === garbage.text && garbage.text === malformed.text && none.text === '{"error":"Unauthorized."}', none.text);

  /* ---------- revoke ---------- */
  r = await call('DELETE', '/api/account/assistant-tokens/' + tid, undefined, erik);
  ok('the owner revokes a token', r.status === 200 && !tp.has('assistant-tokens/' + hash));
  r = await withToken('GET', A + '/trips', T);
  ok('a revoked token is a 401', r.status === 401);
  ok('...indistinguishable from one that never existed', r.text === garbage.text);
  r = await withToken('GET', `${A}/trips/${lisbon.id}`, T);
  ok('...on a trip too', r.status === 401);
  ok('...and is not written back by the attempt', !tp.has('assistant-tokens/' + hash));
  r = await call('GET', '/api/account/assistant-tokens', undefined, erik);
  ok('the list drops it, and there is room for another', r.body.tokens.length === 2 && (await mk(erik, 'Again')).status === 200);
  r = await call('DELETE', '/api/account/assistant-tokens/' + tid, undefined, erik);
  ok('revoking twice is a 404', r.status === 404);
  r = await withToken('GET', A + '/trips', T2);
  ok('the other tokens still work', r.status === 200 && r.body.trips.length === 2);

  /* ---------- access follows the account, as it is now ---------- */
  await call('DELETE', `/api/trips/${sarahs.id}/share/${identityLib.uidFor('erik@example.com')}`, undefined, sarah);
  r = await withToken('GET', A + '/trips', T2);
  ok('a trip no longer shared leaves the token\'s list', r.body.trips.length === 1 && r.body.trips[0].id === lisbon.id);
  r = await withToken('GET', `${A}/trips/${sarahs.id}`, T2);
  ok('...and is a 404', r.status === 404);

  h.autoVerify(false);
  const carol = await register('carol@example.com');
  await call('POST', `/api/trips/${lisbon.id}/share`, { email: 'carol@example.com' }, erik);
  const TC = (await mk(carol)).body.token;
  r = await withToken('GET', A + '/trips', TC);
  ok('an unconfirmed address: trips shared to it are not listed, as signed in', r.status === 200 && r.body.trips.length === 0 &&
     (await call('GET', '/api/trips', undefined, carol)).body.length === 0, r.text);
  r = await withToken('GET', `${A}/trips/${lisbon.id}`, TC);
  ok('...and not opened', r.status === 404);
  h.autoVerify(true);

  const erikUid = identityLib.uidFor('erik@example.com');
  idb.get('users/' + erikUid).disabled = true;
  r = await withToken('GET', A + '/trips', T2);
  ok('a disabled account\'s token stops working', r.status === 401 && r.text === garbage.text);
  delete idb.get('users/' + erikUid).disabled;
  const kept = idb.get('users/' + erikUid);
  idb.delete('users/' + erikUid);
  r = await withToken('GET', A + '/trips', T2);
  ok('...and a deleted account\'s', r.status === 401);
  idb.set('users/' + erikUid, kept);

  /* ---------- the limit, per token ---------- */
  const TB = (await mk(bob, 'Bob')).body.token;
  let last = null, allowed = 0;
  for (let i = 0; i < 41; i++) { last = await withToken('GET', A + '/trips', TB); if (last.status === 200) allowed++; }
  ok('past the per-minute limit (40 in this suite): 429', allowed === 40 && last.status === 429, allowed + ' ' + last.status);
  ok('...saying when to come back, and nothing else', Number(last.headers.get('retry-after')) >= 1 && Number(last.headers.get('retry-after')) <= 60 && !last.text.includes('trips'), last.text);
  r = await withToken('GET', `${A}/trips/${bobs.id}`, TB);
  ok('...on every route', r.status === 429);
  r = await withToken('GET', A + '/trips', T2);
  ok('another token is not held to it', r.status === 200);

  /* ---------- the log ---------- */
  const uses = logged.filter((l) => l.startsWith('[assistant]'));
  ok('uses are logged, by the token\'s public id', uses.some((l) => l.includes('"token":"' + tid + '"') && l.includes('"status":200')) && uses.some((l) => l.includes('"event":"created"')) && uses.some((l) => l.includes('"event":"revoked"')), uses.slice(0, 3).join(' | '));
  const all = logged.join('\n');
  ok('...never the token, its hash, or whose it is', ![T, T2, TB, TC].some((t) => all.includes(t) || all.includes(t.slice(6))) && !all.includes(hash) && !uses.some((l) => l.includes(erikUid) || l.includes('@')));

  /* ---------- wrong tokens, per address ---------- */
  let bad = null;
  for (let i = 0; i < 31; i++) bad = await withToken('GET', A + '/trips', 'tp_ro_' + crypto.randomBytes(32).toString('base64url'));
  ok('thirty wrong tokens from one address, and it is told to stop', bad.status === 429, bad.status);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
