/**
 * A card statement, downloaded as CSV from the bank, read into the charges
 * that fall inside a trip.
 *
 * Shared by Trip Planner and the vacation app (synced by
 * scripts/sync-shared.js). No model call and no bank connection: the person
 * downloads the file their bank already offers and picks the charges to add.
 * That is the whole privacy position - nothing here ever holds a bank login,
 * and the file is parsed in the request and dropped.
 *
 * Banks disagree about almost everything in these files, so every guess here
 * is made from the file itself:
 *
 *   - COLUMNS are found by header name ("Transaction Date", "Posted Date",
 *     "Description", "Payee", "Amount", "Debit", "Credit" ...), preferring the
 *     transaction date over the posting date - posting lags a day or three and
 *     would push a Sunday dinner out of a trip that ended Saturday.
 *   - THE SIGN of a single Amount column is not a convention anyone agrees on:
 *     Chase and Bank of America write purchases negative, Amex and Discover
 *     positive. Purchases are most of any statement, so the majority sign is
 *     spending. Payments and refunds are skipped either way.
 *   - DATES with slashes are read month-first (US banks). ISO, "Sep 12, 2026"
 *     and "12 Sep 2026" are read as written.
 *
 * Categories come from the bank's own column when there is one, else from
 * the merchant name, into generic kinds each app maps onto its own budget.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 5000;

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF, a leading BOM. */
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) break;
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
const HEADERS = {
  // Order is preference: the first match wins.
  date: ['transactiondate', 'transdate', 'date', 'purchasedate', 'posteddate', 'postdate', 'postingdate'],
  description: ['description', 'merchant', 'merchantname', 'payee', 'name', 'details', 'transactiondescription', 'memo'],
  amount: ['amount', 'transactionamount', 'amountusd', 'billingamount'],
  debit: ['debit', 'debitamount', 'withdrawal', 'withdrawals', 'charge', 'charges'],
  credit: ['credit', 'creditamount', 'deposit', 'deposits', 'payment', 'payments', 'credits'],
  type: ['type', 'transactiontype'],
  category: ['category', 'transactioncategory'],
};

function columns(header) {
  const h = header.map(norm);
  const out = {};
  for (const [k, names] of Object.entries(HEADERS)) {
    for (const n of names) { const i = h.indexOf(n); if (i >= 0) { out[k] = i; break; } }
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}
function parseDate(v) {
  const s = String(v || '').trim();
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s))) return ymd(+m[3], +m[1], +m[2]);
  if ((m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s))) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()); return mo < 0 ? null : ymd(+m[3], mo + 1, +m[2]);
  }
  if ((m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})/.exec(s))) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()); return mo < 0 ? null : ymd(+m[3], mo + 1, +m[1]);
  }
  return null;
}

/** "-1,234.56", "(12.00)", "$4.50" -> signed number, or null. */
function signed(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s || !/\d/.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-|-$/.test(s.replace(/[$\s]/g, ''))) neg = true;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const PAYMENT = /\b(payment|thank you|autopay|auto pay|auto-pay|online pmt|epay|ach pmt|credit card pmt|balance transfer|interest charge|late fee waiver|cashback|cash back reward|statement credit)\b/i;
const NOT_SPEND_TYPES = /^(payment|return|refund|credit|adjustment|reversal)/i;

/** Generic kinds each app maps onto its own categories. */
const KINDS = ['food', 'groceries', 'gas', 'transport', 'lodging', 'activities', 'shopping', 'other'];

const BANK_CATEGORY = [
  [/grocer|supermarket/i, 'groceries'],
  [/food|dining|restaurant|bar|cafe|coffee/i, 'food'],
  [/gas|fuel|automotive/i, 'gas'],
  [/lodging|hotel|accommodation/i, 'lodging'],
  [/air|airline|airfare|transport|taxi|rideshare|parking|toll|rail|car rental/i, 'transport'],
  [/entertain|recreation|amusement|attraction|arts|sport/i, 'activities'],
  [/merchandise|shopping|retail|clothing|department/i, 'shopping'],
];

const MERCHANT = [
  [/publix|kroger|winn.?dixie|whole foods|trader joe|aldi|safeway|food lion|piggly|harris teeter|sprouts|fresh market|grocery|market ?place|instacart|costco|sam'?s club|bj'?s wholesale/i, 'groceries'],
  // Brand names as whole words: "PARKMOBILE" once read as Mobil, and a
  // seashell shop is not a Shell station.
  [/\bshell\b(?! ?shop)|exxon|\bmobil\b|chevron|\bbp\b|marathon petro|speedway|wawa|racetrac|race trac|circle k|murphy (usa|express)|sunoco|valero|citgo|texaco|quiktrip|\bqt\b|buc-?ee|pilot travel|pilot flying|love'?s travel|\bfuel\b|gas station|supercharg|chargepoint|electrify america/i, 'gas'],
  [/restaurant|grill|cafe|café|coffee|starbucks|dunkin|donut|bakery|pizza|taco|bbq|barbecue|burger|kitchen|tavern|brew|pub\b|bar &|seafood|oyster|sushi|diner|bistro|cantina|creamery|ice cream|frozen yogurt|gelato|sweet shop|candy|fudge|mcdonald|chick-?fil-?a|wendy|subway|chipotle|panera|popeye|sonic|waffle house|cracker barrel|doordash|uber ?eats|grubhub|toast|sq \*.*(cafe|grill|kitchen)/i, 'food'],
  [/marriott|hilton|hyatt|sheraton|westin|holiday inn|hampton|courtyard|embassy suites|hotel|motel|resort|\binn\b|lodge|airbnb|vrbo|booking\.com|expedia|hotels\.com/i, 'lodging'],
  [/\buber\b|\blyft\b|parking|park mobile|parkmobile|toll|sunpass|e-?zpass|peach pass|amtrak|delta air|american air|united air|southwest|jetblue|spirit air|frontier|alaska air|hertz|avis|enterprise rent|national car|budget rent|alamo|sixt|turo|\btransit\b|metro/i, 'transport'],
  [/museum|aquarium|zoo|tour|cruise|charter|parasail|kayak|paddle|golf|mini ?golf|putt|arcade|bowling|cinema|theat|amc |regal|ticket|eventbrite|admission|park admission|water ?park|splash|state park|national park|rental.*(bike|kayak|board)|bike rental/i, 'activities'],
  [/amazon|target|walmart|wal-mart|cvs|walgreens|dollar general|dollar tree|family dollar|ace hardware|home depot|lowe'?s|surf shop|beach shop|souvenir|gift|outlet|store|shop\b|boutique|t\.?j\.? ?maxx|marshalls|ross\b|old navy/i, 'shopping'],
];

function kindOf(description, bankCategory) {
  let bank = null;
  if (bankCategory) for (const [re, k] of BANK_CATEGORY) if (re.test(bankCategory)) { bank = k; break; }
  // The bank's category wins when it says something specific. "Merchandise"
  // is what Discover calls nearly everything, mini golf included, so there
  // the merchant's name gets the say.
  if (bank && bank !== 'shopping') return bank;
  for (const [re, k] of MERCHANT) if (re.test(description)) return k;
  return bank || 'other';
}

/** The pretty version of a card descriptor: "SQ *THE DONUT HOLE SANTA ROSA FL"
 *  -> "The Donut Hole Santa Rosa FL". Keeps state codes upper-case. */
function tidy(description) {
  let s = String(description || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(sq|tst|sp|pp|paypal|py|in|dd|pos|ach|debit|purchase|chk card)\s*\*\s*/i, '');
  s = s.replace(/\s#?\d{4,}\b/g, '').replace(/\s+x{2,}\d*$/i, '').trim();
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\b([A-Z][a-z])$/, (st) => st.toUpperCase());
  }
  return s.slice(0, 120);
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

/**
 * The whole job. `from`/`to` are ISO dates (either may be null: no window on
 * that side); `slackDays` widens both, because a card dates a hotel charge at
 * checkout and a gas stop on the drive down falls the day before.
 * Returns { transactions, skipped, columns } or { error }.
 */
function parse(text, { from = null, to = null, slackDays = 1 } = {}) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'That file is empty.' };
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return { error: 'That file is larger than a statement should be (2 MB). Download a shorter date range.' };
  const rows = parseCsv(text);
  // Some banks put a few lines of account summary above the real header. The
  // header is the first row that names a date AND an amount-ish column.
  let h = -1, cols = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const c = columns(rows[i]);
    if (c.date != null && c.description != null && (c.amount != null || c.debit != null)) { h = i; cols = c; break; }
  }
  // Wells Fargo and a few credit unions export no header at all: date, amount,
  // two blank or reference columns, then the description last. Recognised by
  // shape - a date first and an amount second on the first rows - not assumed.
  if (h < 0 && rows.length && rows.slice(0, 3).every((r) => r.length >= 3 && parseDate(r[0]) && signed(r[1]) != null)) {
    h = -1; cols = { date: 0, amount: 1, description: rows[0].length - 1 };
  } else if (h < 0) {
    return { error: 'This does not look like a card statement. Download the CSV version from your bank, with date, description and amount columns.' };
  }

  const lo = from ? addDays(from, -slackDays) : null;
  const hi = to ? addDays(to, slackDays) : null;
  const raw = [];
  const skipped = { payments: 0, outOfRange: 0, unreadable: 0 };
  for (const r of rows.slice(h + 1, h + 1 + MAX_ROWS)) {
    const date = parseDate(r[cols.date]);
    const description = String(r[cols.description] || '').trim();
    let value = null;
    if (cols.debit != null || cols.credit != null) {
      const d = cols.debit != null ? signed(r[cols.debit]) : null;
      const c = cols.credit != null ? signed(r[cols.credit]) : null;
      if (d != null && d !== 0) value = { spend: Math.abs(d), sure: true };
      else if (c != null && c !== 0) value = { spend: -Math.abs(c), sure: true };
      else if (cols.amount != null) value = { raw: signed(r[cols.amount]) };
    } else value = { raw: signed(r[cols.amount]) };
    if (!date || !description || !value || (value.raw == null && value.spend == null)) { skipped.unreadable++; continue; }
    raw.push({ date, description, value, type: cols.type != null ? String(r[cols.type] || '') : '', bankCategory: cols.category != null ? String(r[cols.category] || '') : '' });
  }
  // The sign of a lone Amount column: whichever sign most rows carry is spend.
  // Payments and refunds do not vote: a short statement of one purchase and
  // one payment would otherwise tie, and the tie picked the wrong sign.
  const unsure = raw.filter((x) => x.value.raw != null && !NOT_SPEND_TYPES.test(x.type) && !PAYMENT.test(x.description));
  const negatives = unsure.filter((x) => x.value.raw < 0).length;
  const spendIsNegative = negatives > unsure.length - negatives;

  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const spend = x.value.spend != null ? x.value.spend : (spendIsNegative ? -x.value.raw : x.value.raw);
    if (!(spend > 0) || NOT_SPEND_TYPES.test(x.type) || PAYMENT.test(x.description)) { skipped.payments++; continue; }
    if ((lo && x.date < lo) || (hi && x.date > hi)) { skipped.outOfRange++; continue; }
    const amount = Math.round(spend * 100) / 100;
    const key = x.date + '|' + amount.toFixed(2) + '|' + x.description.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
    if (seen.has(key)) continue; // the same row twice in one file
    seen.add(key);
    out.push({ key, date: x.date, description: tidy(x.description), amount, kind: kindOf(x.description, x.bankCategory) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
  return { transactions: out, skipped, found: out.length };
}

/** Flag charges that are probably already in the budget - a receipt scanned
 *  at the table, then the same dinner on the statement. Same amount, dated
 *  within three days. Flagged, never dropped: two $40 dinners are possible. */
function markDuplicates(transactions, existing) {
  const have = (existing || []).filter((e) => e && e.amount > 0);
  return transactions.map((t) => {
    const dup = have.some((e) => Math.abs(e.amount - t.amount) < 0.005 &&
      (!e.date || Math.abs((Date.parse(e.date) - Date.parse(t.date)) / 86400000) <= 3));
    return dup ? { ...t, possibleDuplicate: true } : t;
  });
}

module.exports = { parse, parseCsv, parseDate, signed, columns, kindOf, tidy, markDuplicates, KINDS, MAX_BYTES };
