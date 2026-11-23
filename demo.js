// The example trip an anonymous visitor can browse.
//
// Every real trip belongs to an account and is invisible to anyone else, which
// is right - but it left a first-time visitor looking at a sign-in wall with
// no idea what the app does. This is one fixed, fully worked trip: itinerary,
// a couple of price watches with history, a short chat. It lives in code, not
// Firestore, so it is the same for everyone, costs nothing to serve, and
// cannot be edited into something embarrassing. The id `demo` is reserved:
// loadOwnedTrip refuses writes to it with a message that says what it is.
//
// Its dates are RELATIVE to today (2026-11-23). It used to be fixed at
// Oct 1-5, 2026, and once that week was over the example read "Back 7 weeks",
// had no forecast and showed its crawl as a recap - an example of a trip that
// is over, which is not what a first-time visitor came to see. Now day 1 is
// always the next Thursday at least MIN_LEAD_DAYS away (so 2-8 days out:
// inside the weather's 9-day forecast, with a countdown that ticks), and every
// date and time in here - itinerary, bookings, chat, watch history, the
// crawl, the rate - is the same offset from that day as it was from Oct 1.
// The shift is always whole weeks, so "Sintra on the Saturday", "Sunday
// market" and every weekday label stay true. Built on request and kept per
// UTC day: no timer (the service is billed per request).

const DEMO_ID = 'demo';
const MIN_LEAD_DAYS = 2;
const START_WEEKDAY = 4; // Thursday, the weekday the plan was written around

const DAY_MS = 86400000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmt = (ms, o) => new Date(ms).toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC' }, o));

/** Day 1 of the example for a given moment: the next Thursday (UTC) at least
 *  MIN_LEAD_DAYS ahead. Returned as midnight UTC, in ms. */
function startFor(now = Date.now()) {
  const today = Date.parse(isoDay(Number(now))); // midnight UTC
  let start = today + MIN_LEAD_DAYS * DAY_MS;
  while (new Date(start).getUTCDay() !== START_WEEKDAY) start += DAY_MS;
  return start;
}

/** A calendar for the example, counted from its day 1 (n = 0). */
function calendar(start) {
  const ms = (n) => start + n * DAY_MS;
  const day = (n) => isoDay(ms(n));                                          // '2026-10-01'
  const label = (n) => fmt(ms(n), { weekday: 'short', month: 'short', day: 'numeric' }); // 'Thu, Oct 1'
  const md = (n) => fmt(ms(n), { month: 'short', day: 'numeric' });         // 'Oct 1'
  const month = (n) => fmt(ms(n), { month: 'long' });                        // 'October'
  const at = (n, hms) => `${day(n)}T${hms}.000Z`;                            // an ISO instant
  /** 'Oct 1-5, 2026', 'Sep 30 - Oct 4, 2026', 'Dec 31, 2026 - Jan 4, 2027'. */
  const range = (a, b, withYear = true) => {
    const ya = fmt(ms(a), { year: 'numeric' }), yb = fmt(ms(b), { year: 'numeric' });
    if (ya !== yb) return `${md(a)}, ${ya} - ${md(b)}, ${yb}`;
    const body = fmt(ms(a), { month: 'short' }) === fmt(ms(b), { month: 'short' })
      ? `${md(a)}-${fmt(ms(b), { day: 'numeric' })}` : `${md(a)} - ${md(b)}`;
    return withYear ? `${body}, ${yb}` : body;
  };
  return { day, label, md, month, at, range };
}

// The example trip's Packing and Budget tabs. Read-only, like the rest of it.
const DEMO_PACKING = [
  ['Passports', 'Documents', true], ['Boarding passes on phone', 'Documents', true], ['Travel adapter (type F)', 'Tech', true],
  ['Walking shoes - the hills are steep', 'Clothes', true], ['Light jacket for Sintra, it is cooler up there', 'Clothes', false],
  ['Sunglasses', 'Clothes', false], ['Viva Viagem card (or buy on arrival)', 'Documents', false], ['Phone charger + power bank', 'Tech', false],
].map(([text, group, checked], i) => ({ id: 'demopack' + i, text, group, checked, order: i }));
const DEMO_BUDGET = {
  target: 3500,
  // Some lines in euros, entered the way a receipt from Lisbon arrives, so
  // the example shows them converted at DEMO_RATES and labelled as estimates.
  lines: [
    ['Food', 'Meals out', 600, 180, 'Two people, about 60 euros a day', null, 'manual'],
    ['Activities', 'Sintra: Pena Palace + Quinta da Regaleira', 64, 0, 'Two tickets each', 'EUR', 'manual'],
    ['Transport', 'Metro, trams, train to Sintra', 50, 19, 'Viva Viagem top-ups', 'EUR', 'manual'],
    ['Food', 'Pasteis de Belem', null, 12.6, 'Six pasteis and two coffees', 'EUR', 'receipt'],
    ['Food', 'Pasteis, coffee, snacks', 80, 31, '', null, 'manual'],
  ].map(([category, label, planned, spent, note, currency, source], i) => ({ id: 'demoline' + i, category, label, planned, spent, note, currency, source, date: null, order: i })),
};

/** Everything dated in the example, as it reads at `now` (ms).
 *  Offsets are from day 1 as written when it was Oct 1, 2026 (Aug 14 = -48). */
function build(now) {
  const start = startFor(now);
  const { day, label, md, month, at, range } = calendar(start);
  const yesterday = calendar(Date.parse(isoDay(Number(now))) - DAY_MS); // the example rate's day

  const DEMO_TRIP = {
    name: 'Lisbon long weekend',
    destination: 'Lisbon, Portugal',
    dateRange: range(0, 4),
    notes: 'Two adults. Want one proper day trip (Sintra), the rest on foot. Flying from Atlanta.',
    // What the Overview draws as cards. An example trip, labelled as one on the
    // page, so the confirmation codes are plainly made up.
    bookings: [
      { id: 'demoflight01', kind: 'flight', title: 'ATL to LIS - TAP 228', provider: 'TAP Air Portugal', confirmation: 'EXAMPLE1',
        when: `${label(-1)} - 6:05 PM`, until: `${label(0)} - 3:40 PM`, date: day(-1), total: 1386 },
      { id: 'demostay0001', kind: 'stay', title: 'Memmo Alfama - river-view room', provider: 'Booking.com', confirmation: 'EXAMPLE2',
        when: `${label(0)} - from 3 PM`, until: `${label(4)} - by 11 AM`, date: day(0),
        address: 'Travessa Merceeiras 27, 1100-348 Lisboa', total: 1120,
        notes: 'Rooftop bar closes at midnight; ask for a room away from the terrace.' },
      { id: 'demotrain001', kind: 'transport', title: 'Rossio to Sintra', provider: 'CP', when: `${label(2)} - 9:11 AM`, date: day(2),
        notes: 'No booking needed - tap in with a Viva Viagem card.' },
    ],
    ideas: [
      { name: 'Miradouro da Senhora do Monte', kind: 'View', why: 'The highest viewpoint in the old city, and quiet at sunset.', where: 'Gra\u00e7a, 15 min walk' },
      { name: 'Time Out Market', kind: 'Food', why: 'Lisbon\u2019s best-known kitchens under one roof - easy for a first night.', where: 'Cais do Sodr\u00e9' },
      { name: 'LX Factory', kind: 'Shopping', why: 'Old industrial complex turned bookshops, caf\u00e9s and Sunday market.', where: 'Alc\u00e2ntara' },
    ],
    status: 'locked',
    createdAt: at(-48, '15:02:11'),
    updatedAt: at(-13, '21:40:03'),
    lockedAt: at(-13, '21:40:03'),
    days: [
      { title: 'Arrive & Alfama', date: day(0), dateLabel: label(0), blocks: [
        ['3:40 PM', 'Land at LIS (TAP 228). Metro to Baixa-Chiado, ~35 min'],
        ['5:00 PM', 'Check in - Memmo Alfama, room faces the river'],
        ['6:30 PM', 'Walk up to Miradouro de Santa Luzia for the light, then get lost in Alfama'],
        ['8:30 PM', 'Dinner at Taberna do Chef, 5 min walk (book ahead - it is small)'],
      ], tip: 'You will be tired. Keep the first night to one neighbourhood and an early dinner.' },
      { title: 'Belem & the waterfront', date: day(1), dateLabel: label(1), blocks: [
        ['9:00 AM', 'Tram 15E to Belem - stand at the back, it fills up'],
        ['9:45 AM', 'Jeronimos Monastery. Buy the timed ticket the night before'],
        ['11:30 AM', 'Pasteis de Belem - the queue moves fast, get six'],
        ['1:00 PM', 'MAAT, then the river walk back east'],
        ['Evening', 'Time Out Market for an easy, choose-your-own dinner'],
      ], tip: 'Belem is a full morning. Do not try to add anything else before lunch.' },
      { title: 'Sintra day trip', date: day(2), dateLabel: label(2), blocks: [
        ['8:15 AM', 'Train from Rossio - 40 min, on the Navegante card'],
        ['9:30 AM', 'Pena Palace first, before the crowds. Timed ticket, 9:30 slot'],
        ['12:30 PM', 'Lunch in the old town - Tascantiga for petiscos'],
        ['2:00 PM', 'Quinta da Regaleira, mainly for the initiation well'],
        ['5:30 PM', 'Train back. Rest'],
      ], tip: 'Saturday is the busiest day but the only one that fits. The 9:30 Pena slot is what makes it work.' },
      { title: 'Neighbourhoods & fado', date: day(3), dateLabel: label(3), blocks: [
        ['Morning', 'LX Factory - Sunday market, coffee at Landeau'],
        ['1:00 PM', 'Lunch in Principe Real, then the botanical garden'],
        ['4:00 PM', 'Bairro Alto while it is quiet. Miradouro de Sao Pedro de Alcantara'],
        ['9:00 PM', 'Fado at Tasca do Chico - no reservations, arrive by 8:30'],
      ], tip: 'Fado starts late and runs late. It is the one thing worth staying up for.' },
      { title: 'Home', date: day(4), dateLabel: label(4), blocks: [
        ['9:00 AM', 'Last coffee. Check out by 11'],
        ['11:30 AM', 'Metro to the airport - allow an hour, it is one line'],
        ['2:15 PM', 'TAP 227 to Atlanta'],
      ], tip: 'Lisbon airport security is slow in the early afternoon. Ninety minutes is not too much.' },
    ],
  };

  const DEMO_MESSAGES = [
    {
      question: 'What should I expect weather-wise, and what should I pack for it?',
      answer: 'Lisbon is mild for most of the year, but it is a city of hills and river wind, so evenings run cooler than the daytime number suggests. The Overview has the forecast for your days once they are within about nine days - check it the week before. Whatever it says: shoes with grip for the steep, polished cobbles, a light layer for evenings, and a little more for the Sintra hills, which run a few degrees cooler than the city.',
      proposedChange: null,
      askedAt: at(-48, '15:06:40'),
      answeredAt: at(-48, '15:07:52'),
    },
    {
      question: 'Draft a 5-day plan. One day in Sintra, the rest walking. We like food more than museums.',
      answer: "Here's a plan built around walking and eating, with Sintra on the Saturday because that is the only day the 9:30 Pena slot lines up. Review it below and tap Apply to save it.",
      proposedChange: { summary: 'A five-day plan: Alfama, Belem, a Sintra day trip, neighbourhoods and fado, then home.', days: DEMO_TRIP.days },
      askedAt: at(-48, '15:12:03'),
      answeredAt: at(-48, '15:14:31'),
      _changeHandled: true,
    },
    {
      question: 'Do I need to book anything ahead?',
      answer: 'Three things, in order of how much it matters:\n\n1. **Pena Palace** - timed entry, and the 9:30 slot sells out. Book as soon as your dates are fixed.\n2. **Taberna do Chef** - about 20 seats. A week ahead is enough.\n3. **Jeronimos** - buy the ticket online the night before to skip the line.\n\nFado at Tasca do Chico does not take reservations - just arrive by 8:30.',
      proposedChange: null,
      askedAt: at(-29, '19:44:10'),
      answeredAt: at(-29, '19:45:20'),
    },
  ];

  // Each check leads with the price, the way runWatchCheck asks, so the
  // Watches tab can draw the example's sparklines (pricehistory.js).
  const DEMO_WATCHES = [
    {
      kind: 'flight', label: `ATL -> LIS, ${range(0, 4, false)}, TAP nonstop`, criteria: 'Economy, nonstop, under $900 return',
      url: 'https://www.google.com/travel/flights', intervalHours: 24,
      lastCheckedAt: at(-13, '10:00:00'),
      lastResult: `$842 return on the TAP nonstop - down from $1,010 in ${month(-47)}. Booked at this price.`,
      history: [
        { at: at(-47, '10:00:00'), result: '$1,010 return, TAP nonstop. Delta via JFK is $890 but with a 4h layover.' },
        { at: at(-42, '10:00:00'), result: '$1,024 return on the TAP nonstop - up a little.' },
        { at: at(-37, '10:00:00'), result: '$998 return. No meaningful change.' },
        { at: at(-33, '10:00:00'), result: '$985 return on the TAP nonstop. No meaningful change.' },
        { at: at(-27, '10:00:00'), result: `$912 return - TAP has a fare sale on ${month(0)} dates.` },
        { at: at(-23, '10:00:00'), result: `$934 return. The sale fare has gone on the ${md(0)} flight.` },
        { at: at(-20, '10:00:00'), result: '$868 return. Worth watching one more week.' },
        { at: at(-13, '10:00:00'), result: `$842 return on the TAP nonstop - down from $1,010 in ${month(-47)}. Booked at this price.` },
      ],
    },
    {
      kind: 'hotel', label: 'Memmo Alfama, 4 nights', criteria: 'River-view room, breakfast included, under $260/night',
      url: 'https://www.memmohotels.com/alfama', intervalHours: 72,
      lastCheckedAt: at(-15, '10:00:00'),
      lastResult: '$238/night direct for the river-view room with breakfast, $251 on Booking. Direct rate is the one to take.',
      history: [
        { at: at(-42, '10:00:00'), result: '$255/night direct for the river-view room. Booking.com $262.' },
        { at: at(-35, '10:00:00'), result: '$261/night direct; Booking.com has it at $259.' },
        { at: at(-28, '10:00:00'), result: '$249/night direct, breakfast included.' },
        { at: at(-21, '10:00:00'), result: '$236/night direct with breakfast - a two-day promotion.' },
        { at: at(-15, '10:00:00'), result: '$238/night direct for the river-view room with breakfast, $251 on Booking. Direct rate is the one to take.' },
      ],
    },
  ];

  // The example trip's exchange rate: fixed, and labelled as an example on the
  // page. Near the real euro rate of the time, but not a live number.
  const DEMO_RATES = {
    status: 'ok', example: true, home: 'USD', local: 'EUR', rate: 1.17, rates: { EUR: 1.17 },
    date: yesterday.day(0), publishedAt: yesterday.at(0, '14:00:00'), fetchedAt: yesterday.at(0, '15:00:00'),
    attribution: 'Example rate. On your own trip: European Central Bank reference rates, via Frankfurter.',
    homeCurrencies: ['USD'],
  };

  // The example trip's brewery crawl. The breweries are real Lisbon craft
  // breweries at APPROXIMATE coordinates (good enough to draw a route, not to
  // navigate by); the menus and picks are plainly examples - generic "House
  // IPA" rows and a line saying so - because the example must not make claims
  // about what a real business pours or when it shuts. On a real trip these
  // come from a web lookup made for the crawl's date.
  const DEMO_CRAWL = {
    id: 'demo-marvila',
    name: 'Marvila beer crawl',
    date: day(1),
    startTime: '15:30',
    dwellMinutes: 50,
    mode: 'walk',
    preferences: 'Two of us. Hazy IPAs and anything tart; one of us drinks lighter.',
    stops: [
      { id: 'demo-oitava-colina', name: 'Oitava Colina', type: 'micro', street: 'Graça', city: 'Lisboa', state: 'Lisboa', lat: 38.7196, lng: -9.1308, phone: '', website: '' },
      { id: 'demo-musa', name: 'Musa', type: 'brewpub', street: 'Marvila', city: 'Lisboa', state: 'Lisboa', lat: 38.7447, lng: -9.1011, phone: '', website: '' },
      { id: 'demo-lince', name: 'Lince', type: 'micro', street: 'Marvila', city: 'Lisboa', state: 'Lisboa', lat: 38.7462, lng: -9.1022, phone: '', website: '' },
      { id: 'demo-dois-corvos', name: 'Dois Corvos Cervejeira', type: 'micro', street: 'Marvila', city: 'Lisboa', state: 'Lisboa', lat: 38.7478, lng: -9.1036, phone: '', website: '' },
    ].map((s) => Object.assign({ postalCode: '', country: 'Portugal', dwellMinutes: null, visitedAt: null }, s)),
    picks: {
      'demo-oitava-colina': { order: 'Example: a half pour of the house pale', why: 'An easy first one — on a real crawl this names a beer from the board.' },
      'demo-musa': { order: 'Example: a flight of four', why: 'Four small pours is the way to meet a brewery known for range.' },
      'demo-lince': { order: 'Example: the tart seasonal', why: 'For the one who likes it sour; the lighter drinker takes a half.' },
      'demo-dois-corvos': { order: 'Example: the house IPA, and food', why: 'Last stop and the longest stay — eat here.' },
    },
    picksNote: 'Example: half pours at the first two, and eat at the last stop.',
    createdAt: at(-19, '10:00:00'),
    updatedAt: at(-13, '21:40:03'),
    createdBy: 'demo',
  };

  /** An example menu, labelled as one wherever it is drawn. */
  function exampleMenu(beers) {
    return {
      beers: beers.map(([name, style, abv]) => ({ name, style, abv, note: '' })),
      food: 'Example — on a real crawl: the kitchen, snacks or the food truck that day.',
      hours: 'Example — on a real crawl: the hours for your date.',
      closesAt: null, closesOn: null, weekly: null,
      highlights: 'An example menu. For your own crawl, "Get menus & hours" looks up the current board.',
      kidFriendly: null, dogFriendly: null, sources: [], confidence: 'low', asOf: day(-13),
    };
  }
  const DEMO_CRAWL_MENUS = {
    'demo-oitava-colina': exampleMenu([['House pale ale', 'Pale ale', 5.2], ['House IPA', 'IPA', 6.5], ['Stout', 'Stout', 6]]),
    'demo-dois-corvos': exampleMenu([['House IPA', 'IPA', 6.5], ['Session IPA', 'Session IPA', 4.5], ['Seasonal sour', 'Sour', 5], ['Porter', 'Porter', 6.2]]),
    'demo-lince': exampleMenu([['Lager', 'Lager', 4.8], ['Tart seasonal', 'Sour', 4.5], ['Double IPA', 'DIPA', 8]]),
    'demo-musa': exampleMenu([['House IPA', 'IPA', 6.2], ['Pilsner', 'Pilsner', 5], ['Red ale', 'Red ale', 5.5]]),
  };

  return { DEMO_TRIP, DEMO_MESSAGES, DEMO_WATCHES, DEMO_RATES, DEMO_CRAWL, DEMO_CRAWL_MENUS, start: day(0) };
}

// One build per UTC day, made on the first request that needs it.
let cached = null;
/** The example as it reads today (or at `now`, for tests). */
function today(now = Date.now()) {
  const key = isoDay(Number(now));
  if (!cached || cached.key !== key) cached = { key, demo: build(now) };
  return cached.demo;
}

module.exports = { DEMO_ID, DEMO_PACKING, DEMO_BUDGET, MIN_LEAD_DAYS, startFor, calendar, build, today };
