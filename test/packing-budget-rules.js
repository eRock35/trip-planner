// The rules for packing items and budget lines, which come from people
// typing and from a model - never trusted as they arrive.
const assert = require('assert');
const packing = require('../packing');
const budget = require('../budget');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

t('an item keeps its words and gets a group', () => assert.deepStrictEqual(packing.item({ text: ' Sunscreen ' }), { text: 'Sunscreen', group: 'Other' }));
t('an empty item is nothing', () => { assert.strictEqual(packing.item({ text: '  ' }), null); assert.strictEqual(packing.item(null), null); });
t('markup is stripped', () => assert.ok(!/[<>]/.test(packing.item({ text: '<b>Hat</b>', group: '<i>Kids</i>' }).text)));
t('suggestions skip what is already packed, however it is spelled', () => {
  const out = packing.newOnly([{ text: 'Sunscreen', group: 'Beach' }, { text: 'Rain jacket', group: 'Clothes' }, { text: 'rain  JACKET!', group: 'x' }],
    [{ text: 'sunscreen' }]);
  assert.deepStrictEqual(out.map((i) => i.text), ['Rain jacket']);
});
t('money reads what people type', () => {
  assert.strictEqual(budget.money('$1,240.50'), 1240.5);
  assert.strictEqual(budget.money('about $40'), 40);
  assert.strictEqual(budget.money(319.856), 319.86);
  assert.strictEqual(budget.money(''), null);
  assert.strictEqual(budget.money('free'), null);
});
t('money refuses the impossible', () => {
  assert.strictEqual(budget.money(-5), null);
  assert.strictEqual(budget.money(5e9), null);
  assert.strictEqual(budget.money('1.2.3'), 1.23);
});
t('a line keeps a known category and fixes its case', () => assert.strictEqual(budget.line({ category: 'food', label: 'Groceries', planned: '250' }).category, 'Food'));
t('an unknown category is kept as written, cleaned', () => assert.strictEqual(budget.line({ category: 'Tips<script>', label: 'x' }).category, 'Tipsscript'));
t('a line with nothing to say is nothing', () => assert.strictEqual(budget.line({ planned: 5 }), null));
console.log(`\n${n} assertions passed.`);
