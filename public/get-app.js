/*
 * "Get the iPhone app" - a slim bar on iPhones, or a list of the apps
 * (2026-10-03).
 *
 * SHARED: canonical in eriks-projects/shared/, copied into each app's public/
 * by scripts/sync-shared.js. Edit it there, never a copy.
 *
 *   <script src="get-app.js" data-src="/ios-app.json" defer></script>
 *     The bar. The server answers {name, url}; the bar shows only on an
 *     iPhone, never inside the iPhone app itself (its user agent carries
 *     "StrongTechApp/"), and only when url is a TestFlight public link.
 *
 *   <script src="get-app.js" data-src="/ios-apps.json" data-list="#iphone-apps" defer></script>
 *     The list, for the landing page: the server answers {apps: [{name, url,
 *     blurb}]}, each one becomes a link in that element, and the element is
 *     un-hidden. On every device: on a computer the TestFlight page says how
 *     to open it on a phone.
 *
 * The links come from Cloud Run settings (TESTFLIGHT_URL...), unset until
 * Apple approves a build for external testing, so until then nothing shows.
 *
 * Written for a strict CSP (the lab's `script-src 'self'`): no inline script,
 * no inline handlers, no eval. Styles go in through a constructed stylesheet,
 * falling back to a <style> element. Every string is set as text. Dismissing
 * the bar hides it for 30 days in this browser.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && root.fetch) api.start(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var ID = 'stc-get-app';
  var DISMISS_KEY = 'stc-get-app-dismissed';
  var DISMISS_DAYS = 30;
  var LINK = /^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]{4,20}$/;

  function validLink(url) {
    return typeof url === 'string' && LINK.test(url);
  }

  /** An iPhone or iPod browser, and not the iPhone app's own web view. */
  function wantsBar(ua) {
    var s = String(ua || '');
    return /\b(iPhone|iPod)\b/.test(s) && s.indexOf('StrongTechApp/') === -1;
  }

  function clean(text, max) {
    return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max || 80);
  }

  function scriptEl(doc) {
    var el = doc.currentScript;
    if (el && el.getAttribute) return el;
    var all = doc.querySelectorAll ? doc.querySelectorAll('script[src*="get-app.js"]') : [];
    return all.length ? all[all.length - 1] : null;
  }

  function dismissed(win, now) {
    try {
      var at = Number(win.localStorage.getItem(DISMISS_KEY));
      return at > 0 && now - at < DISMISS_DAYS * 864e5;
    } catch (e) {
      return false;
    }
  }

  // Light: near-black on white with a blue button (white on #0060C0, 6.1:1).
  // Dark: near-white on #1c1c1e, button #0A84FF with black text (6.9:1).
  // Buttons are 44px tall for a thumb.
  var CSS = [
    '#' + ID + '{position:relative;z-index:2147482999;box-sizing:border-box;width:100%;margin:0;',
    'display:flex;align-items:center;gap:8px;padding:4px 4px 4px 14px;',
    'padding-top:calc(4px + env(safe-area-inset-top,0px));',
    'background:#fff;color:#1c1c1e;border-bottom:1px solid #d1d1d6;',
    'font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;text-align:left}',
    '#' + ID + ' *{box-sizing:border-box;font-size:14px;line-height:1.35;letter-spacing:normal;text-transform:none}',
    '#' + ID + ' .stc-ga-text{flex:1;min-width:0;margin:0;padding:6px 0}',
    '#' + ID + ' .stc-ga-text b{font-weight:600}',
    '#' + ID + ' .stc-ga-get{flex:none;display:inline-flex;align-items:center;min-height:44px;padding:0 16px;',
    'border-radius:22px;background:#0060C0;color:#fff;font-weight:600;text-decoration:none}',
    '#' + ID + ' .stc-ga-close{flex:none;width:44px;height:44px;border:0;border-radius:10px;background:transparent;',
    'color:inherit;font:22px/1 -apple-system,Helvetica,Arial,sans-serif;font-size:22px;cursor:pointer;padding:0}',
    '#' + ID + ' a:focus-visible,#' + ID + ' button:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    '@media (prefers-color-scheme:dark){#' + ID + '{background:#1c1c1e;color:#f2f2f7;border-bottom-color:#3a3a3c}',
    '#' + ID + ' .stc-ga-get{background:#0A84FF;color:#000}}',
  ].join('');

  function addStyles(win, doc) {
    try {
      if (win.CSSStyleSheet && doc.adoptedStyleSheets) {
        var sheet = new win.CSSStyleSheet();
        sheet.replaceSync(CSS);
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.concat([sheet]);
        return;
      }
    } catch (e) { /* fall through */ }
    var style = doc.createElement('style');
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  function drawBar(win, doc, info) {
    if (doc.getElementById(ID)) return;
    addStyles(win, doc);
    var bar = doc.createElement('div');
    bar.id = ID;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Get the iPhone app');

    var p = doc.createElement('p');
    p.className = 'stc-ga-text';
    var b = doc.createElement('b');
    b.textContent = clean(info.name) || 'This app';
    p.appendChild(b);
    p.appendChild(doc.createTextNode(' is on iPhone. Free beta through TestFlight.'));

    var a = doc.createElement('a');
    a.className = 'stc-ga-get';
    a.href = info.url;
    a.rel = 'noopener';
    a.textContent = 'Get the app';

    var x = doc.createElement('button');
    x.type = 'button';
    x.className = 'stc-ga-close';
    x.setAttribute('aria-label', 'Hide');
    x.textContent = '×';
    x.addEventListener('click', function () {
      try { win.localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) { /* private mode */ }
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    });

    bar.appendChild(p);
    bar.appendChild(a);
    bar.appendChild(x);
    doc.body.insertBefore(bar, doc.body.firstChild);
  }

  /** Fill the landing page's list; returns how many links went in. */
  function drawList(doc, target, apps) {
    var box = doc.querySelector(target);
    if (!box) return 0;
    var list = box.querySelector('[data-get-apps]') || box;
    var n = 0;
    (apps || []).forEach(function (app) {
      if (!app || !validLink(app.url)) return;
      var a = doc.createElement('a');
      a.className = 'get-app-link';
      a.href = app.url;
      a.rel = 'noopener';
      var name = doc.createElement('strong');
      name.textContent = clean(app.name);
      a.appendChild(name);
      if (app.blurb) {
        var s = doc.createElement('span');
        s.textContent = clean(app.blurb, 140);
        a.appendChild(s);
      }
      list.appendChild(a);
      n += 1;
    });
    if (n) box.hidden = false;
    return n;
  }

  function start(win) {
    var doc = win.document;
    var el = scriptEl(doc);
    var src = el && el.getAttribute('data-src');
    var target = el && el.getAttribute('data-list');
    if (!src) return;
    if (!target && (!wantsBar(win.navigator && win.navigator.userAgent) || dismissed(win, Date.now()))) return;
    win.fetch(src, { credentials: 'omit', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var go = function () {
          if (target) drawList(doc, target, data.apps);
          else if (validLink(data.url)) drawBar(win, doc, data);
        };
        if (doc.body) go(); else doc.addEventListener('DOMContentLoaded', go);
      })
      .catch(function () { /* decoration: a failure shows nothing */ });
  }

  return { start: start, wantsBar: wantsBar, validLink: validLink, clean: clean, dismissed: dismissed, drawList: drawList };
});
