/*
 * "Confirm your email" - one slim bar, the same in every app (2026-09-27).
 *
 * SHARED: canonical in eriks-projects/shared/, copied into each app's public/
 * by scripts/sync-shared.js. Edit it there, never a copy.
 *
 *   <script src="verify-banner.js" data-mount="/api/auth" defer></script>
 *
 * data-mount is where the page's app mounts the shared account (/api/id,
 * /api/auth, or "api/auth" relative to a lab app's base). The bar asks
 * `<mount>/me` and shows only when that says signedIn and emailVerified is
 * exactly false - an app whose /me does not report it simply never shows one.
 *
 * Written for a strict CSP (the lab's `script-src 'self'`): no inline script,
 * no inline handlers, no eval. Styles go in through a constructed stylesheet
 * (CSSOM), falling back to a <style> element where that is unsupported.
 *
 * The address is drawn masked (e***@example.com) and set as text, never as
 * markup. Dismissing hides it for this browser tab's session. It goes first
 * in <body>, in the flow, so it pushes a page down instead of covering it.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document && root.fetch) api.start(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DISMISS_KEY = 'stc-verify-banner-dismissed';
  var ID = 'stc-verify-banner';

  /** e***@example.com. Empty for anything that is not an address. */
  function mask(email) {
    var e = String(email || '');
    var at = e.lastIndexOf('@');
    if (at < 1 || at === e.length - 1) return '';
    return e.charAt(0) + '***' + e.slice(at);
  }

  /** The mount path this script was given, without a trailing slash. */
  function mountFrom(doc) {
    var el = doc.currentScript;
    if (!el || !el.getAttribute) {
      var all = doc.querySelectorAll ? doc.querySelectorAll('script[src*="verify-banner.js"]') : [];
      el = all.length ? all[all.length - 1] : null;
    }
    var m = el && el.getAttribute ? el.getAttribute('data-mount') : '';
    return String(m || '/api/id').replace(/\/+$/, '');
  }

  /** Should this /me answer draw a bar? */
  function wants(me) {
    return Boolean(me && me.signedIn === true && me.emailVerified === false);
  }

  // Light: dark brown on a pale amber, 12:1. Dark: pale amber on deep brown,
  // 11:1. Buttons are 44px tall for a thumb.
  var CSS = [
    '#' + ID + '{position:relative;z-index:2147483000;box-sizing:border-box;width:100%;margin:0;',
    'display:flex;align-items:center;gap:8px;padding:4px 4px 4px 14px;',
    'padding-top:calc(4px + env(safe-area-inset-top,0px));',
    'background:#fff4d6;color:#3d2e00;border-bottom:1px solid #e0c060;',
    'font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
    'box-shadow:0 1px 6px rgba(0,0,0,.08);text-align:left}',
    // Every app styles p and button its own way; none of it reaches in here.
    '#' + ID + ' *{box-sizing:border-box;font-size:14px;line-height:1.35;letter-spacing:normal;text-transform:none}',
    '#' + ID + ' .stc-vb-text{flex:1;min-width:0;margin:0;padding:6px 0}',
    '#' + ID + ' .stc-vb-send{flex:none;min-height:44px;padding:0 14px;border-radius:10px;',
    'border:1.5px solid currentColor;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}',
    '#' + ID + ' .stc-vb-send:disabled{opacity:.7;cursor:default}',
    '#' + ID + ' .stc-vb-close{flex:none;width:44px;height:44px;border:0;border-radius:10px;background:transparent;',
    'color:inherit;font:22px/1 -apple-system,Helvetica,Arial,sans-serif;font-size:22px;line-height:1;cursor:pointer;padding:0}',
    '#' + ID + ' button:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    '@media (max-width:520px){#' + ID + '{flex-wrap:wrap}#' + ID + ' .stc-vb-text{flex-basis:calc(100% - 52px)}',
    '#' + ID + ' .stc-vb-send{order:3;margin:0 0 6px}}',
    '@media (prefers-color-scheme:dark){#' + ID + '{background:#3a2f10;color:#ffe9a8;border-bottom-color:#6b5520;',
    'box-shadow:0 1px 6px rgba(0,0,0,.5)}}',
  ].join('');

  function addStyles(win, doc) {
    try {
      if (win.CSSStyleSheet && 'adoptedStyleSheets' in doc) {
        var sheet = new win.CSSStyleSheet();
        sheet.replaceSync(CSS);
        doc.adoptedStyleSheets = Array.prototype.slice.call(doc.adoptedStyleSheets).concat([sheet]);
        return;
      }
    } catch (e) { /* fall through to a style element */ }
    try {
      var style = doc.createElement('style');
      style.textContent = CSS;
      (doc.head || doc.documentElement).appendChild(style);
    } catch (e) { /* unstyled is still readable */ }
  }

  function storage(win) {
    try { return win.sessionStorage || null; } catch (e) { return null; }
  }

  /**
   * Build the bar for this /me answer, or return null when there is nothing
   * to say. `send` is () => Promise, the "Send again" call.
   */
  function render(doc, me, send) {
    if (!wants(me)) return null;
    var bar = doc.createElement('div');
    bar.id = ID;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Confirm your email');

    var text = doc.createElement('p');
    text.className = 'stc-vb-text';
    var where = mask(me.email);
    text.textContent = 'Confirm your email to unlock the free AI credit and shared items'
      + (where ? ' - we sent a link to ' + where + '.' : '.');

    var again = doc.createElement('button');
    again.type = 'button';
    again.className = 'stc-vb-send';
    again.textContent = 'Send again';
    again.addEventListener('click', function () {
      again.disabled = true;
      again.textContent = 'Sending…';
      Promise.resolve().then(send).then(function (ok) {
        again.textContent = ok === false ? 'Try later' : 'Sent - check your inbox';
      }, function () {
        again.textContent = 'Try later';
      });
    });

    var close = doc.createElement('button');
    close.type = 'button';
    close.className = 'stc-vb-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      var s = storage(doc.defaultView || {});
      try { if (s) s.setItem(DISMISS_KEY, '1'); } catch (e) { /* fine */ }
    });

    bar.appendChild(text);
    bar.appendChild(again);
    bar.appendChild(close);
    return bar;
  }

  function start(win) {
    var doc = win.document;
    // Not inside the landing's live previews: that frame is a showcase.
    try { if (win.top && win.top !== win) return; } catch (e) { return; }
    var s = storage(win);
    try { if (s && s.getItem(DISMISS_KEY) === '1') return; } catch (e) { /* show it */ }
    var mount = mountFrom(doc);
    var send = function () {
      return win.fetch(mount + '/verify/send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).then(function (r) { return r.ok; });
    };
    win.fetch(mount + '/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (!wants(me) || doc.getElementById(ID)) return;
        var bar = render(doc, me, send);
        if (!bar) return;
        addStyles(win, doc);
        // First in the page, in the flow: it pushes the app down rather than
        // covering its header, and scrolls away with it.
        var go = function () {
          if (!doc.body || doc.getElementById(ID)) return;
          if (doc.body.insertBefore && doc.body.firstChild) doc.body.insertBefore(bar, doc.body.firstChild);
          else doc.body.appendChild(bar);
        };
        if (doc.body) go(); else doc.addEventListener('DOMContentLoaded', go);
      })
      .catch(function () { /* no bar is the right failure */ });
  }

  return { mask: mask, mountFrom: mountFrom, wants: wants, render: render, start: start, CSS: CSS, ID: ID };
});
