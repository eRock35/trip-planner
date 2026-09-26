// The crawl recap card's pure parts (public/recap-card.js): what goes on the
// card, from the crawl the page holds, and how text is cut to fit. Drawing
// itself needs a canvas and is checked in a browser.
const RC = require('../public/recap-card.js');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };

const stop = (id, name, visitedAt, extra) => Object.assign({ id, name, city: 'Asheville', state: 'North Carolina', visitedAt }, extra || {});
const view = {
  crawl: {
    name: 'Saturday crawl', date: '2026-10-03', mode: 'walk',
    stops: [stop('a', 'Riverbend', '2026-10-03T19:00:00Z'), stop('b', 'Foundry Hill', '2026-10-03T20:10:00Z'), stop('c', 'Lantern', null), stop('d', 'Far Afield', '2026-10-03T22:00:00Z')],
  },
  schedule: [{}, { legMode: 'walk', legMiles: 0.6 }, { legMode: 'walk', legMiles: 0.4 }, { legMode: 'ride', legMiles: 3.1 }],
  pours: [
    { stopId: 'a', beer: 'Hazy Daze', rating: 4, at: '2026-10-03T19:10:00Z' },
    { stopId: 'b', beer: 'Night Shift', style: 'Stout', rating: 5, at: '2026-10-03T20:20:00Z' },
    { stopId: 'd', beer: 'Pils', rating: 3, at: '2026-10-03T22:10:00Z' },
    { stopId: 'd', beer: 'Unrated', rating: null, at: '2026-10-03T22:20:00Z' },
  ],
};
let d = RC.cardData(view);
ok('name, place and day', d.name === 'Saturday crawl' && d.place === 'Asheville, North Carolina' && d.day === 'Sat, Oct 3, 2026', JSON.stringify(d));
ok('stops checked in of all, beers logged', d.visited === 3 && d.stops === 4 && d.beers === 4);
ok('average of the rated pours only, to one place', d.avg === 4);
ok('the top-rated pour, and where', d.top && d.top.beer === 'Night Shift' && d.top.rating === 5 && d.top.brewery === 'Foundry Hill');
ok('miles walked: walk legs between two checked-in stops only (nothing to or from the skipped stop)', d.miles === 0.6 && d.rideMiles === 0, `${d.miles} / ${d.rideMiles}`);
ok('the breweries checked in, in route order', d.breweries.join() === 'Riverbend,Foundry Hill,Far Afield');

d = RC.cardData({ crawl: { name: '', stops: [], mode: 'drive' }, schedule: [], pours: [] }, { destination: 'Lisbon' });
ok('an empty crawl still has a card to draw', d.name === 'Beer crawl' && d.place === 'Lisbon' && d.avg === null && d.top === null && d.beers === 0 && d.day === '');
ok('a bad date is no day, not "Invalid Date"', RC.cardData({ crawl: { date: '2026-02-30x', stops: [] } }).day === '');

const hostile = RC.cardData({ crawl: { name: 'Big\u0000 night‮<script>\n\n  out', stops: [stop('x', 'A​B\u0007 Brewing', '2026-10-03T19:00:00Z', { city: 'Lisboa', state: 'Lisboa' })] }, schedule: [{}],
  pours: [{ stopId: 'x', beer: 'x'.repeat(500), rating: 9 }, { stopId: 'x', beer: 'Real', rating: 2 }] });
ok('control and direction-override characters are stripped, spaces collapsed', hostile.name === 'Big night<script> out' && hostile.breweries[0] === 'AB Brewing', JSON.stringify(hostile.name));
ok('a rating outside 1-5 is not counted', hostile.avg === 2 && hostile.top.beer === 'Real');
ok('a place whose city and state are the same says it once', hostile.place === 'Lisboa');

// A stand-in canvas context: every character 10px wide.
const ctx = { measureText: (t) => ({ width: String(t).length * 10 }) };
ok('fitText leaves text that fits alone', RC.fitText(ctx, 'Short', 100) === 'Short');
const cut = RC.fitText(ctx, 'A very long brewery name indeed', 100);
ok('...and cuts what does not, with an ellipsis, inside the width', cut.endsWith('…') && ctx.measureText(cut).width <= 100, cut);
const lines = RC.wrap(ctx, 'One two three four five six seven eight nine ten', 120, 2);
ok('wrap: at most the lines asked for, each inside the width, the last cut', lines.length === 2 && lines.every((l) => ctx.measureText(l).width <= 120) && lines[1].endsWith('…'), JSON.stringify(lines));
ok('wrap: one enormous word is cut rather than overflowing', RC.wrap(ctx, 'x'.repeat(80), 120, 2).every((l) => ctx.measureText(l).width <= 120));
ok('file names are plain', RC.fileName({ name: '<b>Big</b> Night / Out!' }, 'wide') === 'crawl-b-big-b-night-out-wide.png' && RC.fileName({ name: '???' }, 'portrait') === 'crawl-recap.png');
ok('sizes: 1080x1350 portrait and 1200x630 wide', RC.SIZES.portrait.w === 1080 && RC.SIZES.portrait.h === 1350 && RC.SIZES.wide.w === 1200 && RC.SIZES.wide.h === 630);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
