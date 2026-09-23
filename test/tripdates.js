// Reading "When" the way a person wrote it.
const assert = require('assert');
const { tripDates, fromText } = require('../tripdates');
const TODAY = new Date('2026-09-23T12:00:00Z');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
const eq = (text, start, end, precision) => {
  const r = fromText(text, TODAY);
  assert.ok(r, text + ' -> null');
  assert.deepStrictEqual([r.start, r.end, r.precision], [start, end, precision], text + ' -> ' + JSON.stringify(r));
};

t('a range within a month, with a year', () => eq('Sep 23-26, 2026', '2026-09-23', '2026-09-26', 'day'));
t('en dash and spaces', () => eq('Oct 1 – 5, 2026', '2026-10-01', '2026-10-05', 'day'));
t('a range across months', () => eq('Sep 30 - Oct 2, 2026', '2026-09-30', '2026-10-02', 'day'));
t('across a new year, no year given', () => eq('Dec 30 - Jan 3', '2026-12-30', '2027-01-03', 'day'));
t('one day, no year: the next March, not the last one', () => eq('March 27', '2027-03-27', '2027-03-27', 'day'));
t('a trip that started days ago is this year’s', () => eq('Sep 20-27', '2026-09-20', '2026-09-27', 'day'));
t('a month is a month, and says so', () => eq('December 2026', '2026-12-01', '2026-12-31', 'month'));
t('...with words around it', () => eq('Early March 2027', '2027-03-01', '2027-03-31', 'month'));
t('...and a month with no year means the next one', () => eq('April', '2027-04-01', '2027-04-30', 'month'));
t('a month is only found as a whole word', () => {
  assert.strictEqual(fromText('maybe next year', TODAY), null);
  assert.strictEqual(fromText('decide later, near the market', TODAY), null);
  eq('Sept. 5-7, 2026', '2026-09-05', '2026-09-07', 'day');
});
t('nothing to go on is null, not a guess', () => {
  assert.strictEqual(fromText('', TODAY), null);
  assert.strictEqual(fromText('not sure yet', TODAY), null);
});
t('an impossible date is not invented', () => assert.strictEqual(fromText('Feb 31, 2027', TODAY).precision, 'month'));
t('the itinerary beats the text when it has dates', () => {
  const r = tripDates({ dateRange: 'December 2026', days: [{ date: '2026-12-22' }, { date: '2026-12-20' }, { date: 'Day 3' }] }, TODAY);
  assert.deepStrictEqual([r.start, r.end, r.from], ['2026-12-20', '2026-12-22', 'itinerary']);
});
t('an itinerary with no real dates falls back to the text', () => {
  const r = tripDates({ dateRange: 'Sep 23-26, 2026', days: [{ date: 'Day 1' }] }, TODAY);
  assert.deepStrictEqual([r.start, r.from], ['2026-09-23', 'text']);
});
t('Erik’s real trips read as expected', () => {
  eq('March 27', '2027-03-27', '2027-03-27', 'day');
  eq('April 2027', '2027-04-01', '2027-04-30', 'month');
});
console.log(`\n${n} assertions passed.`);
