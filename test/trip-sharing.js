// Sharing a trip: the owner adds someone by email - before or after they have
// an account - and from then on that person uses the trip as the owner does,
// except deleting it or changing who it is shared with. Strangers still get a
// 404, and removing someone takes the trip away from them again.
const h = require('./harness.js');
h.install();

require.cache['FAKE_AN'].exports = function () {
  return {
    messages: {
      create: async () => ({
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'text', text: 'The dolphin cruise leaves at 4.' }],
      }),
    },
    batches: {},
  };
};

Object.assign(process.env, {
  IDENTITY_SESSION_SECRET: 'identity-secret-abcdefghijklmn', SESSION_SECRET: 'trip-secret-abcdefghijklmnop',
  FIRESTORE_DATABASE_ID: 'trip-planner', IDENTITY_DATABASE_ID: 'identity', GOOGLE_CLOUD_PROJECT: 'test',
  ADMIN_EMAIL: 'boss@example.com', ANTHROPIC_API_KEY: 'sk-ant-test', PORT: '9231',
});
require(require('path').join(__dirname, '..', 'server.js'));
const identityLib = require(require('path').join(__dirname, '..', 'identity.js'));

const B = 'http://127.0.0.1:9231';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const J = { 'content-type': 'application/json' };
const call = (method, p, body, cookie) => fetch(B + p, { method, headers: Object.assign({}, J, cookie ? { cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
const jar = (r) => (r.headers.getSetCookie() || []).map((c) => c.split(';')[0]).join('; ');
const register = async (email) => jar(await call('POST', '/api/auth/register', { email, password: 'a-long-password-1' }));

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  const erik = await register('erik@example.com');
  let r = await call('POST', '/api/trips', { name: 'Destin', destination: 'Destin, FL', dateRange: 'Oct 3-7, 2026' }, erik);
  const trip = await r.json();
  ok('the owner starts a trip', r.status === 200 && !!trip.id);

  /* ---------- sharing before she has an account ---------- */
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: '  Sarah@Example.com ' }, erik);
  let sh = await r.json();
  ok('sharing with an address that has no account yet works', r.status === 200 && sh.members.length === 1, JSON.stringify(sh));
  ok('...the address is stored lowercased and trimmed', sh.members[0].email === 'sarah@example.com');
  ok('...and keyed to the uid that address will sign in as', sh.members[0].uid === identityLib.uidFor('sarah@example.com'));
  ok('...the owner is named too', sh.owner.email === 'erik@example.com');
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: 'sarah@example.com' }, erik);
  ok('sharing twice with the same person is not a second entry', (await r.json()).members.length === 1);

  /* ---------- she signs up, and it is there ---------- */
  const sarah = await register('sarah@example.com');
  r = await call('GET', '/api/trips', undefined, sarah);
  let list = await r.json();
  ok('once she signs up with that address, the trip is in her list', list.length === 1 && list[0].id === trip.id, JSON.stringify(list));
  ok('...marked as shared by Erik', list[0].role === 'member' && list[0].sharedBy === 'erik@example.com');
  r = await call('GET', '/api/trips', undefined, erik);
  list = await r.json();
  ok('the owner\'s list says who it is shared with', list[0].role === 'owner' && list[0].sharedWith[0] === 'sarah@example.com', JSON.stringify(list));

  r = await call('GET', `/api/trips/${trip.id}`, undefined, sarah);
  const seen = await r.json();
  ok('she can open it', r.status === 200 && seen.name === 'Destin');
  ok('...as a member, seeing who else is on it', seen.role === 'member' && seen.sharing.owner.email === 'erik@example.com' && seen.sharing.members.length === 1);

  /* ---------- she can plan ---------- */
  r = await call('PATCH', `/api/trips/${trip.id}`, { notes: 'Kids want the dolphin cruise' }, sarah);
  ok('she can edit the details', r.status === 200);
  r = await call('POST', `/api/trips/${trip.id}/packing`, { text: 'Sunscreen' }, sarah);
  ok('she can add to the packing list', r.status === 200, String(r.status));
  r = await call('GET', `/api/trips/${trip.id}/packing`, undefined, erik);
  ok('...and Erik sees what she added', JSON.stringify(await r.json()).includes('Sunscreen'));
  r = await call('POST', `/api/trips/${trip.id}/budget/lines`, { category: 'Food', label: 'Groceries', spent: 84.1 }, sarah);
  ok('she can add spending', r.status === 200, String(r.status));
  r = await call('POST', `/api/trips/${trip.id}/lock`, {}, sarah);
  ok('she can lock it in', r.status === 200, String(r.status));
  await call('POST', `/api/trips/${trip.id}/unlock`, {}, sarah);

  r = await call('POST', `/api/trips/${trip.id}/chat`, { question: 'When does the cruise leave?' }, sarah);
  await r.text();
  r = await call('GET', `/api/trips/${trip.id}/messages`, undefined, erik);
  const msgs = await r.json();
  ok('a question she asks is in the shared chat', msgs.length === 1 && msgs[0].question === 'When does the cruise leave?', JSON.stringify(msgs).slice(0, 200));
  ok('...recorded as hers, so the page can say who asked', msgs[0].askedBy === identityLib.uidFor('sarah@example.com'));

  /* ---------- what stays the owner's ---------- */
  r = await call('DELETE', `/api/trips/${trip.id}`, undefined, sarah);
  ok('she cannot delete the trip', r.status === 403, String(r.status));
  r = await call('GET', `/api/trips/${trip.id}`, undefined, erik);
  ok('...it is still there', r.status === 200);
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: 'friend@example.com' }, sarah);
  ok('she cannot share it onward', r.status === 403, String(r.status));
  r = await call('DELETE', `/api/trips/${trip.id}/share/${identityLib.uidFor('erik@example.com')}`, undefined, sarah);
  ok('...or remove anyone but herself', r.status === 403, String(r.status));

  /* ---------- strangers still see nothing ---------- */
  const mallory = await register('mallory@example.com');
  r = await call('GET', `/api/trips/${trip.id}`, undefined, mallory);
  ok('someone it is not shared with gets a 404, not a 403', r.status === 404, String(r.status));
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: 'mallory@example.com' }, mallory);
  ok('...and cannot share it to themselves', r.status === 404, String(r.status));
  r = await call('GET', '/api/trips', undefined, mallory);
  ok('...and it is not in their list', (await r.json()).length === 0);
  r = await call('GET', `/api/trips/${trip.id}`);
  ok('signed out is a 401', r.status === 401, String(r.status));

  /* ---------- bad input ---------- */
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: 'not-an-email' }, erik);
  ok('a non-address is refused', r.status === 400);
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: 'ERIK@example.com' }, erik);
  ok('sharing with yourself is refused', r.status === 400 && /your own/.test((await r.json()).error));
  r = await call('POST', '/api/trips/example/share', { email: 'x@example.com' }, erik);
  ok('the example trip cannot be shared', r.status === 403 || r.status === 404, String(r.status));

  /* ---------- taking it back ---------- */
  r = await call('DELETE', `/api/trips/${trip.id}/share/${identityLib.uidFor('sarah@example.com')}`, undefined, erik);
  sh = await r.json();
  ok('the owner can stop sharing', r.status === 200 && sh.members.length === 0);
  r = await call('GET', `/api/trips/${trip.id}`, undefined, sarah);
  ok('...and she loses it at once', r.status === 404, String(r.status));
  r = await call('GET', '/api/trips', undefined, sarah);
  ok('...from her list too', (await r.json()).length === 0);
  r = await call('GET', `/api/trips/${trip.id}/packing`, undefined, erik);
  ok('what she added stays', JSON.stringify(await r.json()).includes('Sunscreen'));

  /* ---------- leaving ---------- */
  await call('POST', `/api/trips/${trip.id}/share`, { email: 'sarah@example.com' }, erik);
  r = await call('DELETE', `/api/trips/${trip.id}/share/${identityLib.uidFor('sarah@example.com')}`, undefined, sarah);
  ok('she can leave a trip shared with her', r.status === 200 && (await r.json()).left === true, String(r.status));
  r = await call('GET', `/api/trips/${trip.id}`, undefined, erik);
  ok('...and Erik sees she has gone', (await r.json()).sharing.members.length === 0);

  /* ---------- a ceiling ---------- */
  for (let i = 0; i < 10; i++) await call('POST', `/api/trips/${trip.id}/share`, { email: `p${i}@example.com` }, erik);
  r = await call('POST', `/api/trips/${trip.id}/share`, { email: 'one-too-many@example.com' }, erik);
  ok('a trip can be shared with up to ten people', r.status === 400 && /up to 10/.test((await r.json()).error));

  /* ---------- the list is newest first across both kinds ---------- */
  await call('DELETE', `/api/trips/${trip.id}/share/${identityLib.uidFor('p0@example.com')}`, undefined, erik);
  const sarahTrip = await (await call('POST', '/api/trips', { name: 'Sarah\'s own' }, sarah)).json();
  await new Promise((res) => setTimeout(res, 20));
  await call('POST', `/api/trips/${trip.id}/share`, { email: 'sarah@example.com' }, erik);
  await call('PATCH', `/api/trips/${trip.id}`, { notes: 'touched' }, erik);
  list = await (await call('GET', '/api/trips', undefined, sarah)).json();
  ok('her list holds her own trip and the shared one, newest first',
     list.length === 2 && list[0].id === trip.id && list[1].id === sarahTrip.id && list[1].role === 'owner', JSON.stringify(list.map((t) => [t.name, t.role])));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
