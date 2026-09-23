// The rules for a booking, which arrives from model output and from the
// browser - never trusted, always validated.
const assert = require('assert');
const { validate, KINDS } = require('../bookings');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

t('a real booking survives intact', () => {
  const [b] = validate([{ kind: 'car', title: 'Midsize - National', provider: 'National', confirmation: '2136112815',
    when: 'Tue, Sep 22 - 5:00 PM', until: 'Sun, Sep 27 - 12:00 PM', date: '2026-09-22',
    address: '2200 Rental Car Center Pkwy, College Park, GA', phone: '+1 (844) 382-6875', url: 'https://www.nationalcar.com/manage' }]);
  assert.strictEqual(b.kind, 'car'); assert.strictEqual(b.confirmation, '2136112815');
  assert.strictEqual(b.phone, '+1 (844) 382-6875'); assert.ok(b.url.startsWith('https://'));
  assert.ok(/^[a-f0-9]{12}$/.test(b.id));
});
t('only https becomes a link', () => {
  assert.strictEqual(validate([{ title: 'x', url: 'javascript:alert(1)' }])[0].url, '');
  assert.strictEqual(validate([{ title: 'x', url: 'http://example.com' }])[0].url, '');
  assert.strictEqual(validate([{ title: 'x', url: 'data:text/html,hi' }])[0].url, '');
});
t('only a phone number becomes a phone link', () => {
  assert.strictEqual(validate([{ title: 'x', phone: 'call the host' }])[0].phone, '');
  assert.strictEqual(validate([{ title: 'x', phone: '12' }])[0].phone, '');
});
t('markup is stripped from every field', () => {
  const [b] = validate([{ title: '<img src=x onerror=alert(1)>Cottage', notes: '<script>x</script>ok' }]);
  assert.ok(!/[<>]/.test(JSON.stringify(b)));
});
t('an unknown kind is "other", not a crash', () => assert.strictEqual(validate([{ kind: 'spaceship', title: 'x' }])[0].kind, 'other'));
t('an empty booking is dropped, a titleless one is named for its provider', () => {
  assert.strictEqual(validate([{ kind: 'car' }]).length, 0);
  assert.strictEqual(validate([{ provider: 'Hertz', confirmation: 'H1' }])[0].title, 'Hertz');
});
t('ids are kept, so deleting one deletes that one', () => {
  const [a] = validate([{ id: 'abc123def456', title: 'x' }]);
  assert.strictEqual(a.id, 'abc123def456');
  const two = validate([{ id: 'abc123def456', title: 'x' }, { id: 'abc123def456', title: 'y' }]);
  assert.notStrictEqual(two[0].id, two[1].id);
});
t('a made-up id cannot smuggle anything', () => assert.ok(/^[a-f0-9]{12}$/.test(validate([{ id: '../../x', title: 'x' }])[0].id)));
t('soonest first, undated last', () => {
  const v = validate([{ title: 'late', date: '2026-09-26' }, { title: 'undated' }, { title: 'early', date: '2026-09-22' }]);
  assert.deepStrictEqual(v.map((b) => b.title), ['early', 'late', 'undated']);
});
t('capped', () => assert.strictEqual(validate(Array.from({ length: 100 }, (_, i) => ({ title: 't' + i }))).length, 40));
t('not a list is an empty list', () => { assert.deepStrictEqual(validate(null), []); assert.deepStrictEqual(validate('x'), []); });
t('every kind the tool offers is one the validator keeps', () => KINDS.forEach((k) => assert.strictEqual(validate([{ kind: k, title: 'x' }])[0].kind, k)));
console.log(`\n${n} assertions passed.`);
