// Tour mode: the app demonstrates itself.
//
// The landing page frames each app in a phone-shaped card, and a frame that
// just sits there looks like a screenshot. This makes it look used: content
// scrolls, tabs get tapped, a question gets typed and answered. It is the
// REAL app doing real rendering - only the choreography is scripted - and it
// lives in the app rather than the landing page because a cross-origin
// iframe's DOM cannot be driven from outside.
//
// Three rules every tour keeps:
//   1. Nothing it does costs money. Chat answers are canned and drawn
//      straight into the DOM; nothing reaches a model, a database or
//      localStorage. A landing-page visit is free.
//   2. It only runs with ?tour=1, and never for someone who asked for
//      reduced motion - they get the app, still.
//   3. It never breaks the app. Every step is wrapped; a step that throws
//      (an element not there yet, a layout that changed) restarts the loop
//      rather than leaving the page half-animated.
//
// COPY of eriks-projects/shared/tour.js. Fix it there, then re-copy.

(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var wanted = params.get("tour") === "1";
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function active() { return wanted && !reduced; }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** Wait for something to be true - the trip to load, the board to fill. */
  function until(fn, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 15000);
    return new Promise(function (resolve, reject) {
      (function poll() {
        var v; try { v = fn(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if (Date.now() > deadline) return reject(new Error("tour: timed out waiting"));
        setTimeout(poll, 120);
      })();
    });
  }

  // Ease so it reads as a thumb, not a scrollbar drag.
  function ease(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }

  /** Scroll `target` (window or an element) to `y` over `ms`. rAF-driven, so
   *  it behaves the same inside a frame as on its own tab. */
  function scrollTo(target, y, ms) {
    var isWin = target === window;
    var from = isWin ? window.scrollY : target.scrollTop;
    var start = performance.now();
    return new Promise(function (resolve) {
      (function frame(now) {
        var t = Math.min(1, (now - start) / ms);
        var v = from + (y - from) * ease(t);
        if (isWin) window.scrollTo(0, v); else target.scrollTop = v;
        if (t < 1) requestAnimationFrame(frame); else resolve();
      })(start);
    });
  }

  /** Top to bottom of whatever is scrollable, at a reading pace. */
  function scrollThrough(target, ms) {
    var isWin = target === window;
    var max = isWin
      ? Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      : Math.max(0, target.scrollHeight - target.clientHeight);
    return scrollTo(target, max, ms);
  }

  /** A ring where a finger would land, then the real click. */
  function ring(el) {
    var r = el.getBoundingClientRect();
    var dot = document.createElement("span");
    dot.className = "tour-ring";
    dot.style.left = (r.left + r.width / 2 + window.scrollX) + "px";
    dot.style.top = (r.top + r.height / 2 + window.scrollY) + "px";
    document.body.appendChild(dot);
    setTimeout(function () { dot.remove(); }, 700);
  }
  function tap(el, opts) {
    opts = opts || {};
    if (!el) throw new Error("tour: nothing to tap");
    ring(el);
    return wait(opts.delay === undefined ? 260 : opts.delay).then(function () {
      if (!opts.silent) el.click();
    });
  }

  /** Type into a field the way a person does - one character at a time,
   *  with the input event each app already listens for. */
  function type(el, text, cps) {
    var i = 0, per = 1000 / (cps || 22);
    el.value = "";
    return new Promise(function (resolve) {
      (function next() {
        if (i >= text.length) return resolve();
        el.value = text.slice(0, ++i);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        setTimeout(next, per + (Math.random() * 40 - 20));
      })();
    });
  }

  /** Run the steps forever. A failure restarts from the top after a pause. */
  function run(steps, opts) {
    if (!active()) return;
    opts = opts || {};
    document.documentElement.classList.add("tour-on");
    (async function loop() {
      for (;;) {
        try {
          if (opts.reset) await opts.reset();
          for (var i = 0; i < steps.length; i++) await steps[i]();
        } catch (e) {
          if (window.console && console.debug) console.debug("tour restart:", e && e.message);
          await wait(1500);
        }
        await wait(opts.pause === undefined ? 1200 : opts.pause);
      }
    })();
  }

  var css = document.createElement("style");
  css.textContent =
    ".tour-ring{position:absolute;z-index:2147483000;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;pointer-events:none;" +
    "border:2px solid rgba(10,132,255,.95);background:rgba(10,132,255,.22);animation:tourRing .65s cubic-bezier(.2,.7,.2,1) forwards}" +
    "@keyframes tourRing{0%{transform:scale(.55);opacity:0}25%{opacity:1}100%{transform:scale(1.35);opacity:0}}" +
    /* Hide the caret and focus rings while typing is scripted, so it does not
       look like the visitor's own cursor is in the frame. */
    ".tour-on textarea,.tour-on input{caret-color:transparent}.tour-on *:focus{outline:none!important}";
  document.head.appendChild(css);

  window.Tour = { active: active, run: run, wait: wait, until: until, scrollTo: scrollTo, scrollThrough: scrollThrough, tap: tap, type: type, ring: ring };
})();
