/* Count a view, for the trending ranking on the landing page.
 *
 * Every app on this domain carries this file. The counter and the stats live
 * on the root domain, next to the admin panel that reads them - not inside
 * one of the apps being counted, which is where they started.
 *
 * What this sends: the app's name, the coarse path, and the referrer's HOST.
 * Not the full referrer, not the query string, not an id of any kind - the
 * visitor id is a random opaque value the counter (lib/views.js) sets in its
 * own cookie, and this file never reads it. No IPs, no user agents, nothing tied
 * to who is signed in. Enough to count and rank; not enough to follow anyone.
 *
 * What this does NOT count: a preview. The landing page frames six apps as
 * live phone previews (?tour=1, see shared/tour.js), and until 2026-09-25
 * each of those frames posted a view here - so "Most used this week" and the
 * Trending badge mostly ranked how far down the page visitors scrolled. A
 * page that is framed, or that was opened with the tour parameter, stays
 * silent. Spellbook's preview has no ?tour=1, which is why the frame test is
 * the main rule and the parameter only the second. A real visit is never
 * framed: the previews open the app in a new tab on a tap, and that tab is a
 * top-level page with no tour parameter, so it still counts (except Friction,
 * whose tap opens its public /preview, which carries no beacon).
 *
 * It must never slow or break the page it is on: one fire-and-forget POST,
 * keepalive so it survives the navigation, every failure swallowed.
 *
 * COPY. The source is eriks-projects/shared/beacon.js - edit it there and run
 * `node scripts/sync-shared.js`. CI fails if a copy drifts.
 */
(function () {
  'use strict';
  var app = (document.currentScript && document.currentScript.getAttribute('data-app')) || '';
  if (!app) return;

  // Framed means a preview (or someone else's page wrapping ours), not a
  // visit. Comparing window.top is normally allowed even across origins, but
  // some browsers and sandboxed frames throw on touching it at all - and a
  // page that cannot see its own top is, by definition, not the top.
  var framed;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  if (framed) return;

  // The tour parameter the previews use, with any value: a tour is a
  // demonstration running itself, not somebody using the app.
  if (/[?&]tour(?:=|&|$)/.test(location.search || '')) return;

  // The root domain's counter. The default is the www host, which every app
  // subdomain posts to cross-origin (CORS-allowed; www does not redirect
  // /api/*). The landing page lives on the apex and names it with data-to,
  // so its own view stays same-origin, with no preflight.
  var HOST = (document.currentScript && document.currentScript.getAttribute('data-to'))
    || 'https://www.strongtechnicalconsulting.com';

  // The referrer's host only. A full referrer carries paths and query strings
  // from other people's sites, which is more than counting needs.
  var ref = '';
  try { ref = document.referrer ? new URL(document.referrer).host : ''; } catch (e) { ref = ''; }

  try {
    fetch(HOST + '/api/beacon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: true,
      body: JSON.stringify({ app: app, path: location.pathname, ref: ref })
    }).catch(function () {});
  } catch (e) { /* a page must never break because a counter did */ }
})();
