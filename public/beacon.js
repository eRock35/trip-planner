/* Count a view, for the trending ranking on the landing page.
 *
 * Every app on this domain carries this file. The counter and the stats live
 * in Spellbook, not in each app and not in the landing page: the landing page
 * is deliberately a static server that scales to zero, and giving it a
 * database would put a round trip in front of the root domain. Spellbook
 * already has a Firestore and an admin, so the beacon lands there.
 *
 * What this sends: the app's name, the coarse path, and the referrer's HOST.
 * Not the full referrer, not the query string, not an id of any kind - the
 * visitor id is a random opaque value Spellbook sets in its own first-party
 * cookie, and this file never reads it. No IPs, no user agents, nothing tied
 * to who is signed in. Enough to count and rank; not enough to follow anyone.
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

  // Spellbook's origin. Same-origin when Spellbook itself carries this file.
  var HOST = (document.currentScript && document.currentScript.getAttribute('data-to'))
    || 'https://spellbook-u4h4ftn3fa-uc.a.run.app';

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
