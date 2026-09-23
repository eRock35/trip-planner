// The crawl's route, clock and links - pure, so every number is pinned here.
const c = require('../crawl');
const menu = require('../crawlmenu');

let pass = 0, fail = 0;
const ok = (n, cond, x) => { if (cond) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x !== undefined ? '  <- ' + x : '')); } };
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);

/* ---------- haversine ---------- */
ok('one degree of latitude is ~111.19 km', near(c.haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 111.195, 0.01));
ok('Asheville to Charlotte is ~159 km as the crow flies', near(c.haversineKm({ lat: 35.5951, lng: -82.5515 }, { lat: 35.2271, lng: -80.8431 }), 158.7, 2),
   c.haversineKm({ lat: 35.5951, lng: -82.5515 }, { lat: 35.2271, lng: -80.8431 }));
ok('the same point is zero', c.haversineKm({ lat: 38.7, lng: -9.1 }, { lat: 38.7, lng: -9.1 }) === 0);
ok('no coordinates, no distance', c.haversineKm({ lat: 1 }, { lat: 1, lng: 2 }) === null && c.haversineKm(null, { lat: 1, lng: 1 }) === null);
ok('a leg is the straight line stretched to the streets', near(c.legKm({ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 }), 1.11195 * c.STREET_FACTOR, 1e-3));

/* ---------- planRoute / bestRoute ---------- */
const line = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, lat: 35.6, lng: -82.55 + i * 0.004 }));
const shuffled = [line[2], line[0], line[4], line[1], line[3]];
const order = (r) => r.map((s) => s.id).join('');
const got = order(c.bestRoute(shuffled));
ok('stops on a street come back in street order, from one end', got === 'abcde' || got === 'edcba', got);
ok('planRoute from a fixed start walks away from it', order(c.planRoute(shuffled, { lat: 35.6, lng: -82.56 })) === 'abcde', order(c.planRoute(shuffled, { lat: 35.6, lng: -82.56 })));

function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
function perms(a) { if (a.length <= 1) return [a]; const out = []; a.forEach((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).forEach((p) => out.push([x].concat(p)))); return out; }
const r = rng(42);
const scatter = Array.from({ length: 7 }, (_, i) => ({ id: 's' + i, lat: 35.59 + r() * 0.03, lng: -82.56 + r() * 0.03 }));
const brute = Math.min.apply(null, perms(scatter).map(c.pathKm));
ok('seven scattered stops: bestRoute finds the optimal order (checked against all 5,040)', near(c.pathKm(c.bestRoute(scatter)), brute, 1e-9),
   c.pathKm(c.bestRoute(scatter)) + ' vs ' + brute);
ok('...which starting from the first-ticked stop does not always', c.pathKm(c.planRoute(scatter)) >= brute - 1e-9);
ok('one stop is itself', order(c.planRoute([line[3]])) === 'd' && order(c.bestRoute([line[3]])) === 'd');
ok('two stops keep the order they were given', order(c.planRoute([line[3], line[0]])) === 'da' && order(c.bestRoute([line[3], line[0]])) === 'da');
ok('a stop with no coordinates is kept, at the end, not dropped', order(c.planRoute([line[0], { id: 'x', name: 'X' }, line[2], line[1]])) === 'abcx');
ok('cheapest insertion puts a stop between its neighbours', c.cheapestInsert([line[0], line[1], line[3], line[4]], line[2]) === 2);
ok('...but never behind the stops already visited', c.cheapestInsert([line[0], line[1], line[3], line[4]], line[2], 3) === 3);
const d = c.describeRoute([line[0], line[1]]);
ok('describeRoute keeps Hopscotch\'s shape: legs, total, walk time', d.legs.length === 2 && d.legs[0].km === 0 && d.totalKm > 0 && d.totalWalkMinutes >= 5 && d.walkable === true);

/* ---------- the clock ---------- */
ok('toMinutes reads HH:MM, and nothing else', c.toMinutes('15:40') === 940 && c.toMinutes('9:40') === null && c.toMinutes('24:00') === null && c.toMinutes('3pm') === null);
ok('clock wraps past midnight', c.clock(940) === '15:40' && c.clock(1470) === '00:30');
ok('clock12 drops :00 unless asked', c.clock12(1260) === '9 PM' && c.clock12(1280) === '9:20 PM' && c.clock12(1260, true) === '9:00 PM' && c.clock12(0) === '12 AM' && c.clock12(720) === '12 PM');

// A at the origin; B ~0.44 km north (a walk); C ~2.2 km beyond (a ride).
const A = { id: 'A', name: 'Alpha Ales', lat: 35.0, lng: -82.0 };
const Bs = { id: 'B', name: 'Bravo Brewing', lat: 35.004, lng: -82.0 };
const Cs = { id: 'C', name: 'Charlie Cellars', lat: 35.024, lng: -82.0 };
const walkCrawl = { date: '2026-10-03', startTime: '15:00', dwellMinutes: 60, mode: 'walk', stops: [A, Bs, Cs] };
const s = c.schedule(walkCrawl);
ok('first stop arrives at the start, no leg before it', s.stops[0].arrive === '15:00' && s.stops[0].leave === '16:00' && s.stops[0].legMode === null && s.stops[0].legKm === null);
ok('a short leg is a walk at 4.5 km/h along the streets', s.stops[1].legMode === 'walk' && s.stops[1].legMinutes === Math.round((c.legKm(A, Bs) / 4.5) * 60) && s.stops[1].arrive === '16:07',
   JSON.stringify(s.stops[1]));
ok('a leg over 1.6 km is a ride: 30 km/h plus 5 min pickup', s.stops[2].legMode === 'ride' && s.stops[2].legMinutes === Math.round((c.legKm(Bs, Cs) / 30) * 60) + 5 && s.stops[2].arrive === '17:18',
   JSON.stringify(s.stops[2]));
ok('totals: miles, walk and ride minutes, end time', s.totals.endTime === '18:18' && s.totals.rideLegs === 1 && s.totals.walkMinutes === 7 && s.totals.rideMinutes === 11 && s.totals.walkable === false
   && near(s.totals.miles, Math.round(c.kmToMiles(c.legKm(A, Bs) + c.legKm(Bs, Cs)) * 10) / 10), JSON.stringify(s.totals));
const straight = 1.6 / c.STREET_FACTOR / 111.195;
const under = c.schedule({ stops: [A, { id: 'U', name: 'U', lat: A.lat + straight * 0.99, lng: A.lng }] });
const over = c.schedule({ stops: [A, { id: 'O', name: 'O', lat: A.lat + straight * 1.01, lng: A.lng }] });
ok('the ride threshold: just under 1.6 km walks, just over rides', under.stops[1].legMode === 'walk' && over.stops[1].legMode === 'ride', under.stops[1].legKm + ' / ' + over.stops[1].legKm);
const dr = c.schedule(Object.assign({}, walkCrawl, { mode: 'drive' }));
ok('drive mode: every leg is a drive estimate, even a short one', dr.stops[1].legMode === 'ride' && dr.stops[1].legMinutes === Math.round((c.legKm(A, Bs) / 30) * 60) + 5 && dr.stops[2].legMode === 'ride');
ok('...and a drivable crawl whose legs are short still says it is walkable', c.schedule({ mode: 'drive', stops: [A, Bs] }).totals.walkable === true);
const own = c.schedule(Object.assign({}, walkCrawl, { stops: [A, Object.assign({}, Bs, { dwellMinutes: 90 }), Cs] }));
ok('a stop\'s own stay overrides the crawl\'s', own.stops[1].leave === '17:37' && own.stops[1].dwellMinutes === 90);
ok('stays are clamped to 20..180 minutes', c.schedule({ dwellMinutes: 5, stops: [A] }).stops[0].dwellMinutes === 20 && c.schedule({ dwellMinutes: 999, stops: [A] }).stops[0].dwellMinutes === 180);
ok('no start time: 3 PM; no stay: an hour', c.schedule({ stops: [A] }).stops[0].arrive === '15:00' && c.schedule({ stops: [A] }).stops[0].leave === '16:00');
const late = c.schedule({ startTime: '22:30', dwellMinutes: 60, stops: [A, Bs, Cs] });
ok('a crawl that ends after midnight says so, and its clock wraps', late.totals.endsAfterMidnight === true && late.totals.endTime === '01:48' && late.stops[2].arrive === '00:48' && late.stops[2].arriveMinutes > 1440,
   JSON.stringify(late.totals));
ok('an empty crawl ends when it starts', c.schedule({ startTime: '14:00', stops: [] }).totals.endTime === '14:00');

/* ---------- warnings ---------- */
const at = (closesAt, extra) => ({ B: Object.assign({ closesAt, closesOn: '2026-10-03' }, extra || {}) });
let w = c.warnings(walkCrawl, at('16:00'));
ok('arriving at or after closing time is a warning in words', w.some((x) => x.stopId === 'B' && x.kind === 'closed-on-arrival' && x.text === 'Bravo Brewing closes 4 PM — you\'d arrive 4:07 PM'), JSON.stringify(w));
w = c.warnings(walkCrawl, at('16:30'));
ok('closing before you would leave says how long you get', w.some((x) => x.kind === 'closes-early' && /23 min there, not 60/.test(x.text)), JSON.stringify(w));
w = c.warnings(walkCrawl, at('23:00'));
ok('open all the way through: no closing warning', !w.some((x) => /closes/.test(x.kind)));
ok('a closing time found for a different date is not used', !c.warnings(walkCrawl, { B: { closesAt: '16:00', closesOn: '2026-10-04' } }).some((x) => x.stopId === 'B' && x.kind !== 'ride'));
ok('weekly hours answer for any date (Oct 3 2026 is a Saturday)', c.warnings(walkCrawl, { B: { weekly: { sat: '16:00' } } }).some((x) => x.kind === 'closed-on-arrival')
   && c.warnings(walkCrawl, { B: { weekly: { sat: 'closed' } } }).some((x) => x.kind === 'closed' && /closed on Saturdays/.test(x.text)));
ok('"01:00" means one in the morning, not before lunch', !c.warnings(late.stops && { startTime: '22:30', date: '2026-10-03', stops: [A, Bs, Cs] }, { A: { closesAt: '01:00', closesOn: '2026-10-03' } }).some((x) => x.stopId === 'A' && x.kind !== 'ride'));
ok('a leg that needs a ride in walk mode is flagged', c.warnings(walkCrawl, {}).some((x) => x.kind === 'ride' && x.stopId === 'C' && /Charlie Cellars is .* mi from Bravo Brewing/.test(x.text)));
ok('...but not in drive mode, where every leg is a ride', !c.warnings(Object.assign({}, walkCrawl, { mode: 'drive' }), {}).some((x) => x.kind === 'ride'));
ok('ending after midnight is flagged', c.warnings({ startTime: '22:30', stops: [A, Bs, Cs] }, {}).some((x) => x.kind === 'late' && x.stopId === null && /1:48 AM/.test(x.text)));

/* ---------- links ---------- */
const named = [A, Object.assign({}, Bs, { name: 'Hops & Barley Co.', street: '12 Main St', city: 'Asheville' }), Cs];
const L = c.mapsLinks(named, 'walk', c.schedule({ mode: 'walk', stops: named }).stops);
const g = new URL(L.route);
ok('one Google Maps link for the whole route: origin, destination, waypoints, walking',
   g.origin === 'https://www.google.com' && g.pathname === '/maps/dir/' && g.searchParams.get('api') === '1'
   && g.searchParams.get('origin') === '35.000000,-82.000000' && g.searchParams.get('destination') === '35.024000,-82.000000'
   && g.searchParams.get('waypoints') === '35.004000,-82.000000' && g.searchParams.get('travelmode') === 'walking', L.route);
ok('...several waypoints are |-separated and encoded', /waypoints=[^&]*%7C/.test(c.mapsLinks([A, Bs, Cs, Object.assign({}, A, { id: 'Z', lat: 35.1 })], 'drive').route)
   && /travelmode=driving/.test(c.mapsLinks([A, Bs], 'drive').route));
ok('a single stop is just a destination', !/origin=/.test(c.mapsLinks([A], 'walk').route));
const ap = new URL(L.stops[1].apple);
ok('per-stop Apple Maps directions, walking for a walk leg', ap.host === 'maps.apple.com' && ap.searchParams.get('daddr') === '35.004000,-82.000000' && ap.searchParams.get('dirflg') === 'w');
ok('...driving for a ride leg', new URL(L.stops[2].apple).searchParams.get('dirflg') === 'd');
ok('an Uber link only on the ride leg', L.stops[0].uber === null && L.stops[1].uber === null && typeof L.stops[2].uber === 'string');
const namedRide = c.mapsLinks(named, 'drive', c.schedule({ mode: 'drive', stops: named }).stops).stops[1].uber;
const u = new URL(namedRide);
ok('the Uber link sets a pickup at my location and a dropoff with the name encoded',
   u.host === 'm.uber.com' && u.searchParams.get('action') === 'setPickup' && u.searchParams.get('pickup') === 'my_location'
   && u.searchParams.get('dropoff[latitude]') === '35.004000' && u.searchParams.get('dropoff[nickname]') === 'Hops & Barley Co.'
   && u.searchParams.get('dropoff[formatted_address]') === '12 Main St, Asheville' && !/ /.test(namedRide), namedRide);
ok('no stops, no route', c.mapsLinks([], 'walk').route === null);

/* ---------- Open Brewery DB rows ---------- */
const row = {
  id: '5128df48-79fc-4f0f-8b52-d06be54d0cec', name: '<b>Riverbend</b> Brewing', brewery_type: 'Micro',
  address_1: '1 River Arts Dr', city: 'Asheville', state_province: 'North Carolina', postal_code: '28801', country: 'United States',
  longitude: '-82.5669', latitude: '35.5873', phone: '8285550100', website_url: 'http://www.riverbend.example',
};
const nb = c.normaliseBrewery(row);
ok('a directory row becomes a stop: numbers for coordinates, markup gone', nb.lat === 35.5873 && nb.lng === -82.5669 && nb.name === 'Riverbend Brewing', nb.name);
ok('...no angle brackets survive anywhere', !/[<>]/.test(JSON.stringify(nb)));
ok('...type lowercased, street from address_1, state from state_province', nb.type === 'micro' && nb.street === '1 River Arts Dr' && nb.state === 'North Carolina');
ok('...an http website is kept (it is the directory\'s, not a model\'s)', nb.website === 'http://www.riverbend.example/');
ok('...a javascript: website is not', c.normaliseBrewery(Object.assign({}, row, { website_url: 'javascript:alert(1)' })).website === '');
ok('...a phone that is not a phone is dropped', c.normaliseBrewery(Object.assign({}, row, { phone: 'call us!' })).phone === '');
ok('...missing or silly coordinates are null', c.normaliseBrewery(Object.assign({}, row, { latitude: null, longitude: 'x' })).lat === null
   && c.normaliseBrewery(Object.assign({}, row, { latitude: '95' })).lat === null);
ok('...an id with a slash in it is refused (it becomes a document path)', c.normaliseBrewery(Object.assign({}, row, { id: '../x' })) === null && c.normaliseBrewery({ id: 'x' }) === null);
ok('cleanStop needs coordinates and keeps a stay', c.cleanStop(Object.assign({}, row, { latitude: null })) === null && c.cleanStop(Object.assign({}, nb, { dwellMinutes: 45 })).dwellMinutes === 45);
ok('skipType: planning, planned, closed, contract and proprietor have no taproom', ['planning', 'planned', 'Closed', 'contract', 'proprietor'].every(c.skipType));
ok('...micro, brewpub, taproom and the rest do', !['micro', 'brewpub', 'nano', 'regional', 'large', 'bar', 'taproom', ''].some(c.skipType));

/* ---------- into the itinerary ---------- */
ok('itinerary times read as minutes', c.blockMinutes('3:40 PM') === 940 && c.blockMinutes('9 am') === 540 && c.blockMinutes('15:05') === 905
   && c.blockMinutes('Evening') === 1140 && c.blockMinutes('whenever') === null && c.blockMinutes('12:30 PM') === 750 && c.blockMinutes('12 AM') === 0);
const days = [
  { title: 'Arrive', date: '2026-10-02', dateLabel: 'Fri, Oct 2', blocks: [['4:00 PM', 'Land']], tip: '' },
  { title: 'Town', date: '2026-10-03', dateLabel: 'Sat, Oct 3', blocks: [['9:00 AM', 'Coffee'], ['Evening', 'Dinner out'], ['9:30 PM', 'Show'], ['Late', '\u{1F37A} Beer at home']], tip: '' },
];
const picked = Object.assign({}, walkCrawl, { name: 'Afternoon crawl', picks: { B: { order: 'The hazy pale', why: 'x' } } });
let m = c.addToItinerary(days, picked);
const sat = m.days[1].blocks;
ok('a crawl goes into the day with its date, in time order', sat.map((b) => b[1]).join(' | ') ===
   'Coffee | \u{1F37A} Alpha Ales | \u{1F37A} Bravo Brewing — The hazy pale | \u{1F37A} Charlie Cellars | Dinner out | Show | \u{1F37A} Beer at home', sat.map((b) => b[1]).join(' | '));
ok('...with its arrival times, written the way the itinerary writes them', sat[1][0] === '3:00 PM' && sat[2][0] === '4:07 PM' && sat[3][0] === '5:18 PM');
ok('...touching no other day', JSON.stringify(m.days[0]) === JSON.stringify(days[0]));
ok('...and says what to remember for next time', m.date === '2026-10-03' && m.names.length === 3 && m.createdDay === null);
let again = c.addToItinerary(m.days, Object.assign({}, picked, { startTime: '16:00' }), null, m);
ok('adding again replaces the crawl\'s blocks rather than doubling them', again.days[1].blocks.filter((b) => /Alpha Ales/.test(b[1])).length === 1 && again.days[1].blocks.length === sat.length
   && again.days[1].blocks.some((b) => b[0] === '4:00 PM' && /Alpha/.test(b[1])));
ok('...and leaves a beer emoji someone typed themselves alone', again.days[1].blocks.some((b) => b[1] === '\u{1F37A} Beer at home'));
const dropped = c.addToItinerary(again.days, Object.assign({}, picked, { stops: [A, Bs] }), null, again);
ok('a stop removed since goes from the itinerary too', !dropped.days[1].blocks.some((b) => /Charlie/.test(b[1])) && dropped.days[1].blocks.some((b) => /Bravo/.test(b[1])));
const other = c.addToItinerary(m.days, { name: 'Night', date: '2026-10-03', startTime: '22:00', stops: [{ id: 'Q', name: 'Quiet Pint', lat: 35, lng: -82 }] });
ok('a second crawl on the same day keeps the first crawl\'s blocks', other.days[1].blocks.some((b) => /Alpha Ales/.test(b[1])) && other.days[1].blocks.some((b) => /Quiet Pint/.test(b[1])));
const fresh = c.addToItinerary(days, Object.assign({}, picked, { date: '2026-10-05' }));
ok('no day with that date: a new one, in date order, labelled', fresh.days.length === 3 && fresh.days[2].date === '2026-10-05' && fresh.days[2].dateLabel === 'Mon, Oct 5'
   && fresh.days[2].title === 'Afternoon crawl' && fresh.days[2].blocks.length === 3 && fresh.createdDay === '2026-10-05');
const between = c.addToItinerary(days, Object.assign({}, picked, { date: '2026-10-01' }));
ok('...before the days that come after it', between.days[0].date === '2026-10-01' && between.days[1].date === '2026-10-02');
const movedOff = c.addToItinerary(fresh.days, Object.assign({}, picked, { date: '2026-10-02' }), null, fresh);
ok('moving the crawl to another date takes it off the old day, and the day it made goes with it',
   movedOff.days.length === 2 && movedOff.days[0].blocks.some((b) => /Alpha/.test(b[1])) && !movedOff.days.some((d) => d.date === '2026-10-05'));
ok('an empty itinerary gets its first day', c.addToItinerary([], picked).days.length === 1);
let threw = null; try { c.addToItinerary(days, Object.assign({}, picked, { date: null })); } catch (e) { threw = e; }
ok('no date is refused with a 400 that says why', threw && threw.status === 400 && /date/.test(threw.message));

const clashDays = [{ date: '2026-10-03', blocks: [['9:00 AM', 'Coffee'], ['5:30 PM', 'Dinner at a place with a very long name that goes on and on and on'], ['Evening', 'Stroll'], ['4:00 PM', c.TAG + 'Alpha Ales']] }];
const cl = c.clashes(walkCrawl, clashDays);
ok('clashes: a timed block during the crawl is flagged, shortened', cl.length === 1 && cl[0].kind === 'clash' && /at 5:30 PM, during the crawl/.test(cl[0].text) && /\u2026/.test(cl[0].text), JSON.stringify(cl));
ok('...not a block before it, a vague "Evening", or a crawl\'s own block', !cl.some((x) => /Coffee|Stroll|Alpha/.test(x.text)));
ok('...and nothing on another day, or with no date', !c.clashes(Object.assign({}, walkCrawl, { date: '2026-10-04' }), clashDays).length && !c.clashes(Object.assign({}, walkCrawl, { date: null }), clashDays).length);

/* ---------- menus and picks (crawlmenu.js) ---------- */
const v = menu.validate({
  beers: [{ name: '<script>x</script>Hazy Daze', style: 'Hazy IPA', abv: '6.5%' }, { name: 'Big Stout', abv: 45 }, { name: 'big stout' }, { name: '' }],
  food: 'Tacos <img src=x onerror=alert(1)>', hours: 'Sat 12-10 PM', closesAt: '9pm', weekly: { sat: '22:00', sun: 'Closed', mon: 'late' },
  sources: [{ title: 'Site', url: 'https://riverbend.example/taps' }, { url: 'http://insecure.example' }, { url: 'javascript:alert(1)' }],
  confidence: 'certain', asOf: '2099-01-01', kidFriendly: 'yes', dogFriendly: true,
}, { now: Date.parse('2026-09-23T12:00:00Z'), date: '2026-10-03' });
ok('a menu: markup stripped from every field', !/[<>]/.test(JSON.stringify(v)) && v.beers[0].name === 'x Hazy Daze' && v.food === 'Tacos', v.beers[0].name + ' / ' + v.food);
ok('...ABV "6.5%" is 6.5, 45 is nothing', v.beers[0].abv === 6.5 && v.beers[1].abv === null);
ok('...a repeated beer is dropped, and one with no name', v.beers.length === 2);
ok('...only https links', v.sources.length === 1 && v.sources[0].url === 'https://riverbend.example/taps');
ok('...a closing time that is not HH:MM is no closing time', v.closesAt === null && v.closesOn === null);
ok('...weekly hours kept where they are times or "closed"', v.weekly.sat === '22:00' && v.weekly.sun === 'closed' && !('mon' in v.weekly));
ok('...unknown confidence is low; "as of" the future is today; "yes" is not a boolean', v.confidence === 'low' && v.asOf === '2026-09-23' && v.kidFriendly === null && v.dogFriendly === true);
const good = menu.validate({ beers: [{ name: 'Pils', abv: 5 }], closesAt: '21:00', confidence: 'high', asOf: '2026-09-22' }, { now: Date.parse('2026-09-23T12:00:00Z'), date: '2026-10-03' });
ok('...a real closing time is kept, with the date it answers for', good.closesAt === '21:00' && good.closesOn === '2026-10-03' && good.confidence === 'high' && good.asOf === '2026-09-22');
ok('...nothing found cannot be "high" confidence', menu.validate({ beers: [], confidence: 'high' }).confidence === 'low');
ok('...at most 40 beers', menu.validate({ beers: Array.from({ length: 60 }, (_, i) => ({ name: 'Beer ' + i })) }).beers.length === 40);
const entry = { name: 'Riverbend Brewing', menu: good, fetchedAt: '2026-09-23T10:00:00Z' };
ok('a cached menu is fresh for 48 hours, for a brewery of the same name', menu.isFresh(entry, { name: 'riverbend brewing' }, Date.parse('2026-09-25T09:00:00Z'))
   && !menu.isFresh(entry, { name: 'Riverbend Brewing' }, Date.parse('2026-09-25T11:00:00Z'))
   && !menu.isFresh(entry, { name: 'Somewhere Else' }, Date.parse('2026-09-23T11:00:00Z')));
const p = menu.validatePicks({ picks: [{ stopId: 'A', order: 'Pils <b>now</b>', why: 'crisp' }, { stopId: 'ghost', order: 'x', why: 'y' }, { stopId: 'A', order: 'second', why: '' }, { stopId: 'B', order: '' }], pacing: 'Eat at B.' }, ['A', 'B']);
ok('picks: only this crawl\'s stops, one each, and something to order', Object.keys(p.picks).join() === 'A' && p.picks.A.order === 'Pils now', JSON.stringify(p));
ok('...markup stripped, pacing kept', !/[<>]/.test(JSON.stringify(p)) && p.pacing === 'Eat at B.');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
