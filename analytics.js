// Google Analytics, served by the app rather than hardcoded into its pages.
//
// WHY A ROUTE INSTEAD OF PASTING THE SNIPPET INTO EVERY PAGE
//
// Three reasons, in order of how much they matter:
//
//   1. It is OFF unless configured. With no GA_MEASUREMENT_ID the route serves
//      an inert file and no request ever reaches Google. That means local runs,
//      browser tests and any un-configured deployment are silent by default -
//      a pasted snippet would have every test run and every screenshot firing
//      real hits into the property and polluting the numbers.
//   2. One ID lives in one env var per service instead of in thirteen HTML
//      files across five repos, where changing or removing it means editing
//      every one and hoping none was missed.
//   3. Pages can opt out individually. The admin pages have no business being
//      measured - they are one person, and their page paths describe the
//      site's own private structure.
//
// A GA measurement ID is NOT a secret - it ships in the page source of every
// site that uses it, and anyone can read it. It is a plain env var, not a
// Secret Manager entry. Do not treat it as a credential.
//
// MOUNT IT OUTSIDE THE LOGIN GATE
//
// On the apps that gate everything (santa-rosa, friction) this route must be
// registered BEFORE the gate middleware. A gated /analytics.js is a 401 or a
// redirect to /login, so the sign-in page - the one page every visitor sees -
// would be the one page that never measures. This exact mistake was made with
// the shared passkey client earlier and is easy to repeat.
//
// SUBDOMAINS
//
// Every app sits under one registrable domain, so a single GA4 property sees
// them all and GA's cookie is already scoped to the registrable domain: a
// visitor moving from the landing page to dataviz stays one session, with no
// cross-domain configuration. `app_name` is sent on every event so one
// property can still be split per app.

const DEFAULT_ROUTE = '/analytics.js';

/** GA4 measurement IDs look like G-XXXXXXXXXX. Reject anything else rather
 *  than injecting an arbitrary string into a script tag. */
const ID_RE = /^G-[A-Z0-9]{6,20}$/;

/** JSON for embedding in a script. JSON.stringify escapes quotes but leaves
 *  `</script>` intact, so a value containing it would break out of an inlined
 *  <script> block. This route serves an external file today, where that is
 *  harmless - but `script()` is exported, so make the output safe to inline
 *  rather than depend on nobody ever doing it. U+2028/9 are escaped too: they
 *  are literal line terminators in JavaScript but legal inside a JSON string. */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function measurementId() {
  return String(process.env.GA_MEASUREMENT_ID || '').trim();
}

function enabled() {
  return ID_RE.test(measurementId());
}

/**
 * The loader. It is served as JavaScript from the app's own origin, so the
 * page needs a single unconditional <script src="/analytics.js" async> tag
 * and no inline snippet - which also means no inline-script CSP exception.
 */
function script(appName) {
  if (!enabled()) {
    const why = measurementId()
      ? '// analytics: GA_MEASUREMENT_ID is set but is not a valid G-XXXXXXXXXX id; doing nothing.\n'
      : '// analytics: GA_MEASUREMENT_ID is not set on this deployment; doing nothing.\n';
    return why;
  }
  const id = measurementId();
  const app = safeJson(String(appName || 'unknown'));
  return `// Google Analytics 4, loaded by ${id}.
(function () {
  // Honour the browser's Do Not Track. Nothing here is worth overriding it for.
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;

  window.dataLayer = window.dataLayer || [];
  function gtag(){ window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', ${safeJson(id)}, {
    // Which app this hit came from, so one property can be split five ways.
    app_name: ${app},
    // These pages carry no personally identifying path segments, but say so
    // explicitly rather than relying on that staying true.
    anonymize_ip: true,
  });

  // These are tab-based single-page apps: GA counts one page_view on load and
  // then never hears about the four tabs the visitor actually used. This gives
  // each app one line to report a view it knows about.
  window.track = function (name, params) {
    try { gtag('event', 'screen_view', Object.assign({ screen_name: String(name), app_name: ${app} }, params || {})); }
    catch (e) { /* analytics must never break the page */ }
  };

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(${safeJson(id)});
  document.head.appendChild(s);
})();
`;
}

/**
 * @param app       express app
 * @param appName   reported as app_name on every event
 * @param route     defaults to /analytics.js
 */
function mount(app, appName, route = DEFAULT_ROUTE) {
  app.get(route, (req, res) => {
    res.type('application/javascript');
    // Short cache: long enough to avoid a fetch per navigation, short enough
    // that turning analytics off actually takes effect the same day.
    res.set('Cache-Control', enabled() ? 'public, max-age=3600' : 'no-store');
    res.send(script(appName));
  });
  return { enabled: enabled(), route };
}

module.exports = { mount, script, enabled, measurementId, safeJson, DEFAULT_ROUTE, ID_RE };
