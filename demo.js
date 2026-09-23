// The example trip an anonymous visitor can browse.
//
// Every real trip belongs to an account and is invisible to anyone else, which
// is right - but it left a first-time visitor looking at a sign-in wall with
// no idea what the app does. This is one fixed, fully worked trip: itinerary,
// a couple of price watches with history, a short chat. It lives in code, not
// Firestore, so it is the same for everyone, costs nothing to serve, and
// cannot be edited into something embarrassing. The id `demo` is reserved:
// loadOwnedTrip refuses writes to it with a message that says what it is.

const DEMO_ID = 'demo';

const DEMO_TRIP = {
  name: 'Lisbon long weekend',
  destination: 'Lisbon, Portugal',
  dateRange: 'Oct 1-5, 2026',
  notes: 'Two adults. Want one proper day trip (Sintra), the rest on foot. Flying from Atlanta.',
  // What the Overview draws as cards. An example trip, labelled as one on the
  // page, so the confirmation codes are plainly made up.
  bookings: [
    { id: 'demoflight01', kind: 'flight', title: 'ATL to LIS - TAP 228', provider: 'TAP Air Portugal', confirmation: 'EXAMPLE1',
      when: 'Wed, Sep 30 - 6:05 PM', until: 'Thu, Oct 1 - 3:40 PM', date: '2026-09-30', total: 1386 },
    { id: 'demostay0001', kind: 'stay', title: 'Memmo Alfama - river-view room', provider: 'Booking.com', confirmation: 'EXAMPLE2',
      when: 'Thu, Oct 1 - from 3 PM', until: 'Mon, Oct 5 - by 11 AM', date: '2026-10-01',
      address: 'Travessa Merceeiras 27, 1100-348 Lisboa', total: 1120,
      notes: 'Rooftop bar closes at midnight; ask for a room away from the terrace.' },
    { id: 'demotrain001', kind: 'transport', title: 'Rossio to Sintra', provider: 'CP', when: 'Sat, Oct 3 - 9:11 AM', date: '2026-10-03',
      notes: 'No booking needed - tap in with a Viva Viagem card.' },
  ],
  ideas: [
    { name: 'Miradouro da Senhora do Monte', kind: 'View', why: 'The highest viewpoint in the old city, and quiet at sunset.', where: 'Gra\u00e7a, 15 min walk' },
    { name: 'Time Out Market', kind: 'Food', why: 'Lisbon\u2019s best-known kitchens under one roof - easy for a first night.', where: 'Cais do Sodr\u00e9' },
    { name: 'LX Factory', kind: 'Shopping', why: 'Old industrial complex turned bookshops, caf\u00e9s and Sunday market.', where: 'Alc\u00e2ntara' },
  ],
  status: 'locked',
  createdAt: '2026-08-14T15:02:11.000Z',
  updatedAt: '2026-09-18T21:40:03.000Z',
  lockedAt: '2026-09-18T21:40:03.000Z',
  days: [
    { title: 'Arrive & Alfama', date: '2026-10-01', dateLabel: 'Thu, Oct 1', blocks: [
      ['3:40 PM', 'Land at LIS (TAP 228). Metro to Baixa-Chiado, ~35 min'],
      ['5:00 PM', 'Check in - Memmo Alfama, room faces the river'],
      ['6:30 PM', 'Walk up to Miradouro de Santa Luzia for the light, then get lost in Alfama'],
      ['8:30 PM', 'Dinner at Taberna do Chef, 5 min walk (book ahead - it is small)'],
    ], tip: 'You will be tired. Keep the first night to one neighbourhood and an early dinner.' },
    { title: 'Belem & the waterfront', date: '2026-10-02', dateLabel: 'Fri, Oct 2', blocks: [
      ['9:00 AM', 'Tram 15E to Belem - stand at the back, it fills up'],
      ['9:45 AM', 'Jeronimos Monastery. Buy the timed ticket the night before'],
      ['11:30 AM', 'Pasteis de Belem - the queue moves fast, get six'],
      ['1:00 PM', 'MAAT, then the river walk back east'],
      ['Evening', 'Time Out Market for an easy, choose-your-own dinner'],
    ], tip: 'Belem is a full morning. Do not try to add anything else before lunch.' },
    { title: 'Sintra day trip', date: '2026-10-03', dateLabel: 'Sat, Oct 3', blocks: [
      ['8:15 AM', 'Train from Rossio - 40 min, on the Navegante card'],
      ['9:30 AM', 'Pena Palace first, before the crowds. Timed ticket, 9:30 slot'],
      ['12:30 PM', 'Lunch in the old town - Tascantiga for petiscos'],
      ['2:00 PM', 'Quinta da Regaleira, mainly for the initiation well'],
      ['5:30 PM', 'Train back. Rest'],
    ], tip: 'Saturday is the busiest day but the only one that fits. The 9:30 Pena slot is what makes it work.' },
    { title: 'Neighbourhoods & fado', date: '2026-10-04', dateLabel: 'Sun, Oct 4', blocks: [
      ['Morning', 'LX Factory - Sunday market, coffee at Landeau'],
      ['1:00 PM', 'Lunch in Principe Real, then the botanical garden'],
      ['4:00 PM', 'Bairro Alto while it is quiet. Miradouro de Sao Pedro de Alcantara'],
      ['9:00 PM', 'Fado at Tasca do Chico - no reservations, arrive by 8:30'],
    ], tip: 'Fado starts late and runs late. It is the one thing worth staying up for.' },
    { title: 'Home', date: '2026-10-05', dateLabel: 'Mon, Oct 5', blocks: [
      ['9:00 AM', 'Last coffee. Check out by 11'],
      ['11:30 AM', 'Metro to the airport - allow an hour, it is one line'],
      ['2:15 PM', 'TAP 227 to Atlanta'],
    ], tip: 'Lisbon airport security is slow in the early afternoon. Ninety minutes is not too much.' },
  ],
};

const DEMO_MESSAGES = [
  {
    question: 'Is early October a good time for Lisbon, and what should I expect weather-wise?',
    answer: 'Yes - it is one of the best windows. Early October averages **22-24C** with cool evenings around 15C, and the summer crowds have thinned. Rain picks up later in the month but the first week is usually dry. Sea is still warm enough to swim at Cascais if you want a beach afternoon. Pack a light layer for evenings and the Sintra hills, which run a few degrees cooler.',
    proposedChange: null,
    askedAt: '2026-08-14T15:06:40.000Z',
    answeredAt: '2026-08-14T15:07:52.000Z',
  },
  {
    question: 'Draft a 5-day plan. One day in Sintra, the rest walking. We like food more than museums.',
    answer: "Here's a plan built around walking and eating, with Sintra on the Saturday because that is the only day the 9:30 Pena slot lines up. Review it below and tap Apply to save it.",
    proposedChange: { summary: 'A five-day plan: Alfama, Belem, a Sintra day trip, neighbourhoods and fado, then home.', days: DEMO_TRIP.days },
    askedAt: '2026-08-14T15:12:03.000Z',
    answeredAt: '2026-08-14T15:14:31.000Z',
    _changeHandled: true,
  },
  {
    question: 'Do I need to book anything ahead?',
    answer: 'Three things, in order of how much it matters:\n\n1. **Pena Palace** - timed entry, and the 9:30 slot sells out. Book as soon as your dates are fixed.\n2. **Taberna do Chef** - about 20 seats. A week ahead is enough.\n3. **Jeronimos** - buy the ticket online the night before to skip the line.\n\nFado at Tasca do Chico does not take reservations - just arrive by 8:30.',
    proposedChange: null,
    askedAt: '2026-09-02T19:44:10.000Z',
    answeredAt: '2026-09-02T19:45:20.000Z',
  },
];

const DEMO_WATCHES = [
  {
    kind: 'flight', label: 'ATL -> LIS, Oct 1-5, TAP nonstop', criteria: 'Economy, nonstop, under $900 return',
    url: 'https://www.google.com/travel/flights', intervalHours: 24,
    lastCheckedAt: '2026-09-18T10:00:00.000Z',
    lastResult: 'TAP nonstop is $842 return in economy - down from $1,010 last week. Booked at this price.',
    history: [
      { at: '2026-08-15T10:00:00.000Z', result: 'TAP nonstop $1,010 return. Delta via JFK $890 but 4h layover.' },
      { at: '2026-08-29T10:00:00.000Z', result: 'TAP nonstop $985. No meaningful change.' },
      { at: '2026-09-11T10:00:00.000Z', result: 'TAP nonstop dropped to $868. Worth watching one more week.' },
      { at: '2026-09-18T10:00:00.000Z', result: 'TAP nonstop $842 return - down from $1,010 last week. Booked at this price.' },
    ],
  },
  {
    kind: 'hotel', label: 'Memmo Alfama, 4 nights', criteria: 'River-view room, breakfast included, under $260/night',
    url: 'https://www.memmohotels.com/alfama', intervalHours: 72,
    lastCheckedAt: '2026-09-16T10:00:00.000Z',
    lastResult: 'River-view with breakfast is $238/night direct, $251 on Booking. Direct rate is the one to take.',
    history: [
      { at: '2026-08-20T10:00:00.000Z', result: 'River-view $255/night direct. Booking.com $262.' },
      { at: '2026-09-16T10:00:00.000Z', result: 'River-view with breakfast is $238/night direct, $251 on Booking. Direct rate is the one to take.' },
    ],
  },
];

// The example trip's Packing and Budget tabs. Read-only, like the rest of it.
const DEMO_PACKING = [
  ['Passports', 'Documents', true], ['Boarding passes on phone', 'Documents', true], ['Travel adapter (type F)', 'Tech', true],
  ['Walking shoes - the hills are steep', 'Clothes', true], ['Light jacket for Sintra, it is cooler up there', 'Clothes', false],
  ['Sunglasses', 'Clothes', false], ['Viva Viagem card (or buy on arrival)', 'Documents', false], ['Phone charger + power bank', 'Tech', false],
].map(([text, group, checked], i) => ({ id: 'demopack' + i, text, group, checked, order: i }));
const DEMO_BUDGET = {
  target: 3500,
  lines: [
    ['Food', 'Meals out', 600, 180, 'Two people, about 60 euros a day'], ['Activities', 'Sintra: Pena Palace + Quinta da Regaleira', 70, 0, 'Two tickets each'],
    ['Transport', 'Metro, trams, train to Sintra', 60, 22, 'Viva Viagem top-ups'], ['Food', 'Pasteis, coffee, snacks', 80, 31, ''],
  ].map(([category, label, planned, spent, note], i) => ({ id: 'demoline' + i, category, label, planned, spent, note, order: i })),
};

module.exports = { DEMO_ID, DEMO_TRIP, DEMO_MESSAGES, DEMO_WATCHES, DEMO_PACKING, DEMO_BUDGET };
