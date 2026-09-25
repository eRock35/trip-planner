/*
 * The Overview's live parts, as plain functions: the departure countdown, a
 * budget counted across currencies, and a price watch's sparkline.
 *
 * Plain functions of their inputs - the clock and the time zone are passed
 * in, never read from a global inside - so the same file runs in the page
 * (window.Live) and under node in test/live.js, and every sum the page draws
 * is one a test has checked.
 *
 * Nothing here talks to the server. The countdown ticks in the browser; the
 * server is never asked what time it is.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Live = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAY = 86400000;

  /* ---------------- time zones ----------------
   * "Midnight on Oct 1" is a different instant in Atlanta and in Lisbon, and
   * on the night the clocks change a day is 23 or 25 hours long. So an ISO
   * day becomes an instant only through the zone it is meant in: the
   * viewer's own unless a test says otherwise. */
  var fmts = {};
  function fmtFor(tz) {
    var key = tz || "";
    if (!fmts[key]) {
      var opts = { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };
      if (tz) opts.timeZone = tz;
      try { fmts[key] = new Intl.DateTimeFormat("en-US", opts); }
      catch (e) { delete opts.timeZone; fmts[key] = new Intl.DateTimeFormat("en-US", opts); }
    }
    return fmts[key];
  }
  function partsAt(ms, tz) {
    var out = {};
    fmtFor(tz).formatToParts(new Date(ms)).forEach(function (p) { out[p.type] = p.value; });
    return { y: +out.year, mo: +out.month, d: +out.day, h: (+out.hour) % 24, mi: +out.minute, s: +out.second };
  }
  /** Minutes the zone is ahead of UTC at that instant. */
  function offsetAt(ms, tz) {
    var p = partsAt(ms, tz);
    return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
  }
  /** The ISO day it is at `ms` in `tz`. */
  function localIso(ms, tz) {
    var p = partsAt(ms, tz);
    return p.y + "-" + String(p.mo).padStart(2, "0") + "-" + String(p.d).padStart(2, "0");
  }
  /** The instant a wall-clock time happens on an ISO day in `tz`. */
  function zonedTime(iso, minutes, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return NaN;
    var guess = Date.UTC(+m[1], +m[2] - 1, +m[3]) + (minutes || 0) * 60000;
    var t = guess - offsetAt(guess, tz) * 60000;
    // Once more at the answer: the offset can differ across a DST change.
    return guess - offsetAt(t, tz) * 60000;
  }
  function isoDays(a, b) {   // whole calendar days from a to b
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
  }

  /** "3:40 PM", "15:40", "9am" -> minutes after midnight; "Morning" -> null. */
  function parseClock(s) {
    var m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?\b/i.exec(String(s || ""));
    if (m) {
      var h = +m[1] % 12 + (/p/i.test(m[3]) ? 12 : 0), mi = +(m[2] || 0);
      return +m[1] >= 1 && +m[1] <= 12 && mi < 60 ? h * 60 + mi : null;
    }
    m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\b/.exec(String(s || ""));
    return m ? +m[1] * 60 + +m[2] : null;
  }

  /** The first thing planned on `iso`: from the day with that date, or - an
   *  itinerary with no dates - the first day. */
  function firstBlock(days, iso) {
    days = Array.isArray(days) ? days : [];
    var day = days.filter(function (d) { return d && String(d.date || "").slice(0, 10) === iso; })[0];
    if (!day && days.length && !days.some(function (d) { return /^\d{4}-\d{2}-\d{2}/.test(String((d && d.date) || "")); })) day = days[0];
    var b = day && Array.isArray(day.blocks) ? day.blocks[0] : null;
    if (!b) return null;
    return { time: String(b[0] == null ? "" : b[0]), plan: String(b[1] == null ? "" : b[1]), minutes: parseClock(b[0]) };
  }

  /**
   * Where a trip is in time.
   * @param trip  { dates: {start, end, precision}, days }
   * @param now   ms since the epoch
   * @param tz    IANA zone; omitted, the viewer's own
   * @returns null (no dates), or one of
   *   { kind: 'before', ms, d, h, m, target }       counting down to the first day
   *   { kind: 'travel', total, first }              the first day: "Today: <first block>"
   *   { kind: 'during', n, total }                  "Day 2 of 5"
   *   { kind: 'after', ago }                        back n days
   *   { kind: 'month', weeks, months, words }       "December 2026": about, never a midnight
   *   { kind: 'month-now', words }                  within that month
   */
  function countdown(trip, now, tz) {
    var dates = trip && trip.dates;
    if (!dates || !/^\d{4}-\d{2}-\d{2}$/.test(dates.start || "") || !/^\d{4}-\d{2}-\d{2}$/.test(dates.end || "")) return null;
    var today = localIso(now, tz);
    if (dates.precision === "month") {
      if (today > dates.end) return { kind: "after", ago: isoDays(dates.end, today) };
      if (today >= dates.start) return { kind: "month-now", words: "This month" };
      // Measured to the middle of the month: the trip could be any day in
      // it, and the middle is the least wrong single answer.
      var toMid = isoDays(today, dates.start) + 14;
      var weeks = Math.max(1, Math.round(toMid / 7)), months = Math.max(1, Math.round(toMid / 30.44));
      return { kind: "month", weeks: weeks, months: months, words: weeks < 9 ? "About " + weeks + (weeks === 1 ? " week" : " weeks") : "About " + months + " months" };
    }
    if (today < dates.start) {
      var target = zonedTime(dates.start, 0, tz);
      var ms = Math.max(0, target - now);
      var min = Math.floor(ms / 60000);
      return { kind: "before", ms: ms, target: target, d: Math.floor(min / 1440), h: Math.floor(min / 60) % 24, m: min % 60 };
    }
    var total = isoDays(dates.start, dates.end) + 1;
    if (today === dates.start) {
      var first = firstBlock(trip.days, dates.start);
      if (first && first.minutes != null) {
        var at = zonedTime(dates.start, first.minutes, tz);
        first.at = at;
        first.inMs = at > now ? at - now : 0;
      }
      return { kind: "travel", total: total, first: first };
    }
    if (today <= dates.end) return { kind: "during", n: isoDays(dates.start, today) + 1, total: total };
    return { kind: "after", ago: isoDays(dates.end, today) };
  }

  /** The trips list's short form, or null when there is nothing to say. */
  function compact(state) {
    if (!state) return null;
    switch (state.kind) {
      case "before":
        if (state.d >= 2) return "in " + state.d + " days";
        if (state.d === 1) return "in 1 day " + state.h + "h";
        return state.h ? "in " + state.h + "h " + state.m + "m" : "in " + state.m + "m";
      case "travel": return "Today";
      case "during": return "Day " + state.n + " of " + state.total;
      case "month": return state.words.charAt(0).toLowerCase() + state.words.slice(1);
      case "month-now": return "this month";
      default: return null;
    }
  }

  /** How long until the next whole minute, so a d/h/m display changes on the
   *  minute rather than up to a minute late. */
  function msToNextMinute(state) {
    if (!state || state.kind !== "before") return 60000;
    return (state.ms % 60000) || 60000;
  }

  /* ---------------- money across currencies ---------------- */
  var cents = function (n) { return Math.round(n * 100) / 100; };

  /**
   * A budget counted in its home currency.
   * @param lines   budget lines; `currency` null or the home one means home
   * @param booked  bookings with a `total`, in the home currency
   * @param opts    { home: 'USD', rates: { EUR: 1.17 } } - one unit of each
   *                currency in the home currency
   * Lines in a currency with no rate are left out of the totals and counted
   * in `uncounted`, never added as if they were home money.
   */
  function convertBudget(lines, booked, opts) {
    opts = opts || {};
    var home = opts.home || "USD", rates = opts.rates || {};
    var planned = 0, spent = 0, converted = 0, uncounted = 0, from = [];
    var out = (Array.isArray(lines) ? lines : []).map(function (l) {
      var cur = l && l.currency && l.currency !== home ? l.currency : home;
      var rate = cur === home ? 1 : (typeof rates[cur] === "number" && rates[cur] > 0 ? rates[cur] : null);
      var row = Object.assign({}, l, { cur: cur, foreign: cur !== home, rate: rate });
      row.plannedHome = l.planned != null && rate ? cents(l.planned * rate) : null;
      row.spentHome = l.spent != null && rate ? cents(l.spent * rate) : null;
      row.uncounted = cur !== home && !rate && (l.planned != null || l.spent != null);
      if (row.uncounted) uncounted++;
      else if (row.foreign && (l.planned != null || l.spent != null)) { converted++; if (from.indexOf(cur) < 0) from.push(cur); }
      if (row.plannedHome != null) planned += row.plannedHome;
      if (row.spentHome != null) spent += row.spentHome;
      return row;
    });
    var bookedSum = (Array.isArray(booked) ? booked : []).reduce(function (a, b) { return a + (Number(b && b.total) || 0); }, 0);
    planned = cents(planned); spent = cents(spent); bookedSum = cents(bookedSum);
    return {
      home: home, lines: out, planned: planned, spent: spent, booked: bookedSum,
      expected: cents(bookedSum + planned), sofar: cents(bookedSum + spent),
      converted: converted, convertedFrom: from, uncounted: uncounted, estimated: converted > 0,
    };
  }

  /** Money in a currency, the way a person writes it: "$1,240.50", "€42". */
  function fmtMoney(n, currency, locale) {
    if (n == null || isNaN(n)) return "";
    try {
      return Number(n).toLocaleString(locale, { style: "currency", currency: currency || "USD", maximumFractionDigits: Number(n) % 1 ? 2 : 0, minimumFractionDigits: Number(n) % 1 ? 2 : 0 });
    } catch (e) { return (currency || "") + " " + Number(n).toFixed(2); }
  }
  /** A rate the way the chip says it: 1.1734 -> "1.17", 0.00643 -> "0.0064". */
  function fmtRate(r) {
    if (!(r > 0)) return "";
    return r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r >= 0.1 ? r.toFixed(2) : r.toPrecision(2);
  }
  /** "$", "€", "¥" - or the code, for a currency with no symbol of its own. */
  function symbol(c) {
    try { return (0).toLocaleString("en-US", { style: "currency", currency: c }).replace(/[\d.,\s\u00a0]/g, "") || c; } catch (e) { return c; }
  }
  function withSym(n, c) { var s = symbol(c); return (/^[A-Z]{2,}$/.test(s) ? s + " " : s) + n; }
  /** The chip's words: "€1 = $1.17". When one unit is worth under a tenth of
   *  the home currency it reads the other way, "$1 = ¥156", because nobody
   *  thinks of a yen as $0.0064. */
  function fxPair(rate, local, home) {
    if (!(rate > 0)) return "";
    return rate >= 0.1 ? withSym(1, local) + " = " + withSym(fmtRate(rate), home) : withSym(1, home) + " = " + withSym(fmtRate(1 / rate), local);
  }

  /* ---------------- sparklines ---------------- */

  /**
   * Geometry for a small line chart of prices over time. x follows the real
   * times (a gap of a week looks like one); y runs low-at-bottom, over a
   * range no narrower than 12% of the high price.
   * @returns null with fewer than two points, else
   *   { line, area, dots: [{x,y}], last: {x,y}, low: {x,y,i} }
   */
  function sparkGeometry(points, w, h, pad) {
    if (!Array.isArray(points) || points.length < 2) return null;
    pad = pad == null ? 4 : pad;
    var ts = points.map(function (p) { return Date.parse(p.at); });
    var t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts);
    var ps = points.map(function (p) { return p.price; });
    var lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
    // The y range is at least 12% of the high price, centred on the data,
    // so a €5 move on €70 does not climb the full height the way a $168
    // drop on $1,010 does. A flat series therefore sits in the middle.
    var span = Math.max(hi - lo, Math.abs(hi) * 0.12) || 1, base = (hi + lo) / 2 - span / 2;
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    var dots = points.map(function (p, i) {
      var fx = t1 > t0 && !isNaN(ts[i]) ? (ts[i] - t0) / (t1 - t0) : i / (points.length - 1);
      var fy = (p.price - base) / span;
      return { x: r2(pad + fx * (w - 2 * pad)), y: r2(h - pad - fy * (h - 2 * pad)) };
    });
    var lowI = 0;
    ps.forEach(function (p, i) { if (p <= ps[lowI]) lowI = i; });
    var line = dots.map(function (d, i) { return (i ? "L" : "M") + d.x + " " + d.y; }).join(" ");
    var area = line + " L" + dots[dots.length - 1].x + " " + (h - pad) + " L" + dots[0].x + " " + (h - pad) + " Z";
    return { line: line, area: area, dots: dots, last: dots[dots.length - 1], low: { x: dots[lowI].x, y: dots[lowI].y, i: lowI } };
  }

  /** "Tue" within the last six days, else "Aug 15" - in the viewer's zone. */
  function sinceLabel(iso, now, tz) {
    var t = Date.parse(iso);
    if (isNaN(t)) return "";
    var days = isoDays(localIso(t, tz), localIso(now, tz));
    var opts = days >= 1 && days <= 6 ? { weekday: "short" } : { month: "short", day: "numeric" };
    if (tz) opts.timeZone = tz;
    if (days === 0) return "today";
    try { return new Date(t).toLocaleDateString("en-US", opts); } catch (e) { return iso.slice(0, 10); }
  }

  /**
   * The badge beside a sparkline, from pricehistory.trend().
   * @returns { tone: 'down'|'up'|'flat', text, short, low } - down is good news for
   *          someone waiting to book, so the page draws it green.
   */
  function priceBadge(trend, currency, now, tz) {
    if (!trend) return null;
    var since = sinceLabel(trend.since, now, tz);
    var sinceText = since === "today" ? "today" : "since " + since;
    var pct = Math.abs(trend.pct);
    var pctText = pct >= 10 ? Math.round(pct) + "%" : (Math.round(pct * 10) / 10) + "%";
    var text = trend.direction === "flat"
      ? "No change " + sinceText
      : (trend.direction === "down" ? "Down " : "Up ") + fmtMoney(Math.abs(trend.delta), currency, "en-US") + " (" + pctText + ") " + sinceText;
    var low = trend.atLow ? "Lowest yet" : "Low " + fmtMoney(trend.low, currency, "en-US") + " · " + sinceLabel(trend.lowAt, now, tz).replace(/^today$/, "today");
    // The Overview tile's narrower form: the money and the date, no percent.
    var short = trend.direction === "flat" ? "No change " + sinceText
      : (trend.direction === "down" ? "Down " : "Up ") + fmtMoney(Math.abs(trend.delta), currency, "en-US") + " " + sinceText;
    return { tone: trend.direction, text: text, short: short, low: low };
  }

  return {
    localIso: localIso, zonedTime: zonedTime, offsetAt: offsetAt, parseClock: parseClock, firstBlock: firstBlock,
    countdown: countdown, compact: compact, msToNextMinute: msToNextMinute,
    convertBudget: convertBudget, fmtMoney: fmtMoney, fmtRate: fmtRate, symbol: symbol, fxPair: fxPair,
    sparkGeometry: sparkGeometry, sinceLabel: sinceLabel, priceBadge: priceBadge,
  };
});
