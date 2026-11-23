// The look and the navigation (redesign, 2026-11): structure a restyle must
// not quietly lose. Read from the files - nothing here needs the server.
//
// What it holds: a white page and a black one, the system font, five type
// sizes, no gradients or capitals-as-style; a top bar whose buttons say what
// they do; the phone's five-item section bar and every section in it; a way
// to each main task one or two taps from home; and a signed-out page that
// shows the example trip rather than an empty sign-in prompt.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const page = read('public/index.html');
const login = read('login.html');
const css = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
const loginCss = login.slice(login.indexOf('<style>'), login.indexOf('</style>'));
const body = page.slice(page.indexOf('<body'), page.indexOf('<script>', page.indexOf('<body')));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const tag = (id) => { const m = page.match(new RegExp('<[a-z]+[^>]*\\bid="' + id + '"[^>]*>')); return m ? m[0] : ''; };

/* ---------- the look ---------- */
for (const [name, sheet] of [['the app', css], ['the sign-in page', loginCss]]) {
  ok(name + ': the page is white', /:root\s*\{[^}]*--bg:\s*#FFFFFF/i.test(sheet));
  ok(name + ': ...and true black in dark, both ways of asking for it',
     /prefers-color-scheme: dark[\s\S]*?--bg:\s*#000(000)?\b/i.test(sheet) && /:root\[data-theme="dark"\]\s*\{[^}]*--bg:\s*#000(000)?\b/i.test(sheet));
  ok(name + ': no gradient or texture anywhere', !/gradient\(/.test(sheet));
  ok(name + ': no capitals as a style', !/text-transform:\s*uppercase/.test(sheet));
  ok(name + ': the system font, never a downloaded one',
     !/@font-face|fonts\.googleapis|fonts\.gstatic|\.woff/.test(sheet) && /font-family:\s*-apple-system/.test(sheet));
  const sizes = [...new Set([...sheet.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const text = sizes.filter((n) => n < 28);
  ok(name + ': type on five sizes (13, 15, 16, 20, then 28 and up for display)',
     text.every((n) => [13, 15, 16, 20].includes(n)), sizes.join(' '));
}
ok('cards carry a hairline, not a drop shadow', /--shadow:\s*0 0 0 1px var\(--line\)/.test(css));
ok('the one real shadow is kept for what floats', /\.tabbar\s*\{[^}]*box-shadow:\s*var\(--lift\)/.test(css) && /\.composer\s*\{[^}]*box-shadow:\s*var\(--lift\)/.test(css));
ok('buttons are pills at least 48px tall', /\n  \.btn \{[^}]*border-radius: 999px[^}]*min-height: 48px/.test(css));
ok('new motion sits inside prefers-reduced-motion: no-preference', /@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*transition/.test(css));
ok('...and reduced motion still stops everything older', /@media \(prefers-reduced-motion: reduce\)/.test(css));
ok('the page’s own styles load after the shared desktop layer, so they have the last word',
   page.indexOf('href="/desktop.css"') > 0 && page.indexOf('href="/desktop.css"') < page.indexOf('<style>'));

/* ---------- navigation ---------- */
ok('the top bar names the app and links home', /<a class="brand"[^>]*href="#\/trips"[^>]*>[\s\S]*?Trip Planner/.test(body));
ok('the account button has words, not only an icon', /id="accountBtn"[^>]*>[\s\S]*?<span id="accountLabel">Sign in<\/span>/.test(body));
ok('...and so does New trip', /id="newTripBtn"[^>]*>[\s\S]*?<span>New trip<\/span>/.test(body));
ok('the page says "Sign in" or "Account" as the session changes', /accountLabel"\)\.textContent = isSignedIn \? "Account" : "Sign in"/.test(page));
const TABS = ['overview', 'itinerary', 'chat', 'packing', 'budget', 'memories', 'crawls', 'watches', 'details'];
ok('every section has a tab and a panel', TABS.every((t) => tag('tab-btn-' + t) && tag('tab-' + t)), TABS.filter((t) => !tag('tab-btn-' + t) || !tag('tab-' + t)).join());
ok('every tab keeps its name for a screen reader and the desktop row',
   TABS.concat('more').every((t) => new RegExp('id="tab-btn-' + t + '"[^>]*><svg aria-hidden="true">[^]*?</svg><span>[A-Z][a-z]+</span></button>').test(body)));
const onPhone = TABS.filter((t) => !/\bin-more\b/.test(tag('tab-btn-' + t)));
ok('a phone’s bar holds five: Overview, Itinerary, Chat, Packing and More',
   onPhone.join() === 'overview,itinerary,chat,packing' && /\bis-more\b/.test(tag('tab-btn-more')), onPhone.join());
ok('the bar is not the shared desktop rail any more', !/dk-tabbar/.test(page));
ok('on a desktop the tabs are a row with an underline, all nine of them',
   /@media \(min-width: 900px\)[\s\S]*\.tab\.in-more \{ display: flex; \}[\s\S]*?\.tab\.is-more \{ display: none; \}/.test(css) &&
   /\.tab\[aria-selected="true"\]::after \{ left: 10px; right: 10px; bottom: -1px;/.test(css));

/* ---------- one or two taps from home ---------- */
ok('home has a full-size New trip button', /id="homeNewBtn"/.test(body) && /\$\("homeNewBtn"\)\.addEventListener\("click"/.test(page));
ok('a trip’s Overview has a way in to Packing, Budget, Crawls, Watches and Memories',
   ['ovPackTile', 'ovBudgetTile', 'ovCrawlTile', 'ovWatchTile', 'ovMemTile'].every((id) => tag(id)));
ok('...the crawl and watch tiles are there before there is anything to show', !/\bhidden\b/.test(tag('ovCrawlTile')) && !/\bhidden\b/.test(tag('ovWatchTile')));
ok('...an empty crawl tile opens the Crawls tab', /getAttribute\("data-crawl"\); if \(id\) openCrawl\(id\); else selectTripTab\("crawls"\)/.test(page));
ok('Details is one tap from a trip', tag('editBtn') && /\$\("editBtn"\)\.addEventListener\("click", function \(\) \{ selectTripTab\("details"\); \}\)/.test(page));

/* ---------- signed out ---------- */
const so = page.slice(page.indexOf('function renderSignedOut'), page.indexOf('/* The example trip is read-only.'));
ok('a visitor is told what the app does', /class="hero-h"/.test(so) && /class="hero-sub"/.test(so));
ok('...offered an account and a sign-in', /href="\/login\?new=1"/.test(so) && /href="\/login"/.test(so));
ok('...and shown the example trip, one tap away', /id="exampleCard" href="#\/trip\/demo"/.test(so));
ok('the example is drawn from the public example routes only', /fetch\("\/api\/trips\/demo" \+ p\)/.test(so) && !/fetch\("\/api\/trips"\)/.test(so));
ok('everything from the example is escaped before it is drawn',
   !/'\s*\+\s*(t\.name|t\.destination|d\.title|d\.dateLabel|b\[[01]\])\b/.test(so.replace(/escapeHtml\([^)]*\)/g, 'E')));
ok('the sign-in page opens ready to register from "Create a free account"', /\[\?&\]new=1/.test(login));
ok('the sign-in page leads back to the example', /<a class="back" href="\/">/.test(login));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
