/**
 * The crawl recap card: a picture of how a crawl went, drawn on a canvas in
 * the browser and handed to the phone's share sheet as a PNG file.
 *
 * Drawn HERE, not on the server, deliberately. A trip is private - its owner
 * and the people it is shared with, a 404 to everyone else - and a card
 * served from a URL would be the first thing about a trip that a stranger
 * could open. So there is no link: the picture is made from what this page
 * already has, and it goes exactly where the person sends it, as a file.
 *
 * The photo, when there is one, is fetched from the app's own authenticated
 * photo route (same origin, the session cookie) and drawn from a Blob, so the
 * canvas stays origin-clean and toBlob() works. A cross-origin image would
 * taint it and toBlob() would throw.
 *
 * `cardData` and `fitText` are pure and `require`d by test/recap-card.js;
 * `draw` needs a real canvas.
 */
(function (root) {
  "use strict";

  var SIZES = { portrait: { w: 1080, h: 1350 }, wide: { w: 1200, h: 630 } };
  var FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  // Colours on the card's own dark ground, each measured >= 7:1 against it.
  var INK = { bg0: "#17110A", bg1: "#2E1D0C", text: "#FFFFFF", soft: "#E9DCC8", amber: "#FFB547", stamp: "#7FE09A", panel: "rgba(255,255,255,0.08)", line: "rgba(255,255,255,0.16)" };

  /** Text as it may be drawn: no control characters, no runs of space. The
   *  canvas does not interpret markup, so tags are harmless - but a name
   *  that arrived through the server has had them stripped already. */
  function clean(s, n) {
    return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, n || 200);
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function dayText(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DAYS[d.getUTCDay()] + ", " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + m[1];
  }

  /**
   * What goes on the card, from the crawl's view as the page holds it
   * ({crawl, schedule, totals, pours}). Miles are the WALKED legs between
   * stops that were both checked in - a ride is not walking, and a stop
   * skipped was not walked to.
   */
  function cardData(v, opts) {
    var o = opts || {};
    var c = (v && v.crawl) || {}, stops = Array.isArray(c.stops) ? c.stops : [], rows = (v && v.schedule) || [];
    var pours = Array.isArray(v && v.pours) ? v.pours : [];
    var visited = stops.filter(function (s) { return s && s.visitedAt; });
    var walked = 0, rode = 0;
    for (var i = 1; i < stops.length; i++) {
      var r = rows[i] || {};
      if (!stops[i].visitedAt || !stops[i - 1].visitedAt || typeof r.legMiles !== "number") continue;
      if (r.legMode === "walk") walked += r.legMiles; else rode += r.legMiles;
    }
    var rated = pours.filter(function (p) { return p && p.rating >= 1 && p.rating <= 5; });
    var best = rated.slice().sort(function (a, b) { return b.rating - a.rating || String(b.at || "").localeCompare(String(a.at || "")); })[0] || null;
    var byId = {};
    stops.forEach(function (s) { byId[s.id] = s; });
    var first = visited[0] || stops[0] || {};
    var place = [clean(first.city, 60), clean(first.state, 60)].filter(Boolean);
    if (place.length === 2 && place[0].toLowerCase() === place[1].toLowerCase()) place.pop();
    return {
      name: clean(c.name, 80) || "Beer crawl",
      place: place.join(", ") || clean(o.destination, 80),
      day: dayText(c.date),
      stops: stops.length,
      visited: visited.length,
      beers: pours.length,
      avg: rated.length ? Math.round((rated.reduce(function (a, p) { return a + p.rating; }, 0) / rated.length) * 10) / 10 : null,
      miles: Math.round(walked * 10) / 10,
      rideMiles: Math.round(rode * 10) / 10,
      drive: c.mode === "drive",
      top: best ? { beer: clean(best.beer, 80), style: clean(best.style, 60), rating: best.rating, brewery: clean((byId[best.stopId] || {}).name, 80) } : null,
      breweries: visited.map(function (s) { return clean(s.name, 60); }).filter(Boolean),
    };
  }

  /** The longest start of `text` that fits `max` pixels, with an ellipsis
   *  when it had to be cut. */
  function fitText(ctx, text, max) {
    text = String(text || "");
    if (ctx.measureText(text).width <= max) return text;
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(text.slice(0, mid).trimEnd() + "…").width <= max) lo = mid; else hi = mid - 1;
    }
    return text.slice(0, lo).trimEnd() + "…";
  }
  /** Words into at most `lines` lines of `max` pixels; the last one cut. */
  function wrap(ctx, text, max, lines) {
    var words = String(text || "").split(" "), out = [], line = "";
    for (var i = 0; i < words.length; i++) {
      var tryLine = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(tryLine).width <= max || !line) { line = tryLine; continue; }
      out.push(line); line = words[i];
      if (out.length === lines - 1) { line = words.slice(i).join(" "); break; }
    }
    if (line) out.push(line);
    return out.slice(0, lines).map(function (l, i) { return i === lines - 1 || i === out.length - 1 ? fitText(ctx, l, max) : l; });
  }

  function font(px, weight) { return (weight || 400) + " " + px + "px " + FONT; }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  /** A five-point star, drawn - no font on the card is trusted with ★. */
  function star(ctx, cx, cy, r, filled, color) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
      ctx[i ? "lineTo" : "moveTo"](cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath();
    if (filled) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, r * 0.14); ctx.stroke(); }
  }
  function stars(ctx, x, cy, r, n, color) {
    for (var i = 0; i < 5; i++) star(ctx, x + r + i * r * 2.3, cy, r, i < n, color);
    return r * 2.3 * 5;
  }
  /** Cover-crop an image into a box, its `fade` edge ("bottom" or "left")
   *  melting into whatever is beneath over `by` pixels. Done on a second
   *  canvas with a gradient mask, so there is no seam against the ground;
   *  that canvas holds only this same-origin image, so nothing is tainted. */
  function cover(ctx, img, x, y, w, h, fade, by) {
    var iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
    if (!iw || !ih) return;
    var s = Math.max(w / iw, h / ih), sw = w / s, sh = h / s;
    var off = ctx.canvas.ownerDocument ? ctx.canvas.ownerDocument.createElement("canvas") : null;
    if (!off || !fade) { ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h); return; }
    off.width = w; off.height = h;
    var o = off.getContext("2d");
    o.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, w, h);
    var g = fade === "left" ? o.createLinearGradient(0, 0, by, 0) : o.createLinearGradient(0, h, 0, h - by);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0,1)");
    o.globalCompositeOperation = "destination-in";
    o.fillStyle = g; o.fillRect(0, 0, w, h);
    ctx.drawImage(off, x, y);
  }
  /** The largest size up to `px` (down to `min`) at which `text` fits. */
  function sizeToFit(ctx, text, max, px, min, weight) {
    for (; px > min; px -= 2) { ctx.font = font(px, weight); if (ctx.measureText(text).width <= max) return px; }
    ctx.font = font(min, weight);
    return min;
  }
  function kicker(d) { return ["Beer crawl", d.day].filter(Boolean).join(" · ").toUpperCase(); }
  function statList(d) {
    return [
      { n: d.visited + "/" + d.stops, u: "Stops" },
      { n: String(d.beers), u: d.beers === 1 ? "Beer" : "Beers" },
      d.drive || (!d.miles && d.rideMiles) ? { n: (d.rideMiles || 0).toFixed(1), u: "Miles" } : { n: d.miles.toFixed(1), u: "Miles walked" },
      { n: d.avg != null ? d.avg.toFixed(1) : "–", u: "Avg rating", star: d.avg != null },
    ];
  }
  function ground(ctx, w, h) {
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, INK.bg1); g.addColorStop(1, INK.bg0);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // A few bubbles, for the look of it.
    ctx.fillStyle = "rgba(255,181,71,0.06)";
    [[0.86, 0.18, 0.16], [0.95, 0.42, 0.07], [0.78, 0.36, 0.05], [0.1, 0.94, 0.12]].forEach(function (b) {
      ctx.beginPath(); ctx.arc(w * b[0], h * b[1], w * b[2], 0, Math.PI * 2); ctx.fill();
    });
  }
  function drawStats(ctx, x, y, w, list, big, small) {
    var cw = w / list.length;
    list.forEach(function (s, i) {
      var cx = x + i * cw;
      if (i) { ctx.fillStyle = INK.line; ctx.fillRect(cx, y + 6, 2, big + small + 12); }
      var pad = i ? cw * 0.12 : 0, room = cw - pad - 10;
      // Numbers shrink to fit rather than being cut: "4.…" says nothing.
      var px = sizeToFit(ctx, s.n, room - (s.star ? big * 0.62 : 0), big, big * 0.55, 800);
      ctx.fillStyle = INK.text; ctx.textBaseline = "alphabetic";
      ctx.fillText(s.n, cx + pad, y + big * 0.86);
      if (s.star) star(ctx, cx + pad + ctx.measureText(s.n).width + big * 0.34, y + big * 0.86 - px * 0.42, big * 0.24, true, INK.amber);
      ctx.fillStyle = INK.soft; ctx.textBaseline = "top";
      var label = s.u.toUpperCase();
      sizeToFit(ctx, label, room, small, small * 0.72, 700);
      ctx.fillText(fitText(ctx, label, room), cx + pad, y + big + 12);
    });
  }
  /** Brewery names as passport stamps, as many rows as allowed. */
  function drawStamps(ctx, x, y, w, names, px, rows, dry) {
    ctx.font = font(px, 800); ctx.textBaseline = "middle";
    var h = px * 1.9, gap = px * 0.6, cx = x, row = 0, drawn = 0, endX = x, endRow = 0;
    for (var i = 0; i < names.length; i++) {
      var t = fitText(ctx, names[i].toUpperCase(), w * 0.8), tw = ctx.measureText(t).width + px * 1.4;
      if (cx + tw > x + w && cx > x) { row++; cx = x; }
      if (row >= rows) break;
      var cy = y + row * (h + gap);
      if (dry) { cx += tw + gap; drawn++; endX = cx; endRow = row; continue; }
      ctx.save();
      ctx.translate(cx + tw / 2, cy + h / 2);
      ctx.rotate(((i % 3) - 1) * 0.035);
      ctx.strokeStyle = INK.stamp; ctx.lineWidth = Math.max(2, px * 0.12);
      roundRect(ctx, -tw / 2, -h / 2, tw, h, px * 0.4); ctx.stroke();
      ctx.fillStyle = INK.stamp; ctx.fillText(t, -tw / 2 + px * 0.7, 1);
      ctx.restore();
      cx += tw + gap; drawn++; endX = cx; endRow = row;
    }
    // The ones that did not fit are counted rather than silently dropped.
    var left = names.length - drawn;
    if (left > 0 && !dry) {
      var more = "+" + left + " more";
      ctx.font = font(px, 700);
      if (endX + ctx.measureText(more).width <= x + w) { ctx.fillStyle = INK.soft; ctx.fillText(more, endX, y + endRow * (h + gap) + h / 2); }
    }
    return { drawn: drawn, height: (endRow + 1) * (h + gap) };
  }
  function drawTop(ctx, x, y, w, d, s) {
    // "Top-rated" panel: label, beer, where, stars.
    var h = s * 3.7;
    ctx.fillStyle = INK.panel; roundRect(ctx, x, y, w, h, s * 0.5); ctx.fill();
    ctx.textBaseline = "top";
    ctx.fillStyle = INK.amber; ctx.font = font(s * 0.62, 800);
    ctx.fillText("TOP-RATED", x + s * 0.8, y + s * 0.6);
    stars(ctx, x + w - s * 0.8 - s * 0.42 * 2.3 * 5, y + s * 0.9, s * 0.42, d.top.rating, INK.amber);
    ctx.fillStyle = INK.text; ctx.font = font(s * 1.05, 800);
    ctx.fillText(fitText(ctx, d.top.beer, w - s * 1.6), x + s * 0.8, y + s * 1.45);
    ctx.fillStyle = INK.soft; ctx.font = font(s * 0.72, 500);
    ctx.fillText(fitText(ctx, [d.top.brewery ? "at " + d.top.brewery : "", d.top.style].filter(Boolean).join(" · "), w - s * 1.6), x + s * 0.8, y + s * 2.7);
    return h;
  }
  function footer(ctx, x, y, px) {
    ctx.textBaseline = "alphabetic"; ctx.fillStyle = INK.soft; ctx.font = font(px, 600);
    ctx.fillText("Planned and checked in with Trip Planner", x, y);
  }

  /**
   * Draw the card. `size` is "portrait" (1080x1350) or "wide" (1200x630);
   * `photo` an ImageBitmap or loaded <img>, or null.
   */
  function draw(canvas, d, size, photo) {
    var S = SIZES[size] || SIZES.portrait, w = S.w, h = S.h;
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext("2d");
    ground(ctx, w, h);
    if (size === "wide") {
      var pad = 64, colW = photo ? 640 : w - pad * 2;
      if (photo) {
        cover(ctx, photo, w - 500, 0, 500, h, "left", 140);
        colW = w - 500 - pad - 20;
      }
      var y = pad;
      ctx.textBaseline = "top"; ctx.fillStyle = INK.amber; ctx.font = font(24, 800);
      ctx.fillText(fitText(ctx, kicker(d), colW), pad, y); y += 44;
      ctx.fillStyle = INK.text; ctx.font = font(60, 800);
      wrap(ctx, d.name, colW, 2).forEach(function (l) { ctx.fillText(l, pad, y); y += 70; });
      if (d.place) { ctx.fillStyle = INK.soft; ctx.font = font(28, 500); ctx.fillText(fitText(ctx, d.place, colW), pad, y + 2); y += 50; }
      y += 16;
      drawStats(ctx, pad, y, colW, statList(d), 56, 18); y += 56 + 18 + 40;
      if (d.top) {
        ctx.fillStyle = INK.amber; ctx.font = font(20, 800); ctx.fillText("TOP-RATED", pad, y);
        var sx = pad + ctx.measureText("TOP-RATED").width + 16;
        stars(ctx, sx, y + 11, 11, d.top.rating, INK.amber);
        ctx.fillStyle = INK.text; ctx.font = font(30, 700);
        ctx.fillText(fitText(ctx, d.top.beer + (d.top.brewery ? " · " + d.top.brewery : ""), colW), pad, y + 32);
      } else if (d.breweries.length) {
        drawStamps(ctx, pad, y, colW, d.breweries, 18, 2);
      }
      footer(ctx, pad, h - 40, 20);
      return canvas;
    }
    // Portrait. Measured first, then drawn: without a photo the block sits
    // in the middle of the card rather than leaving its bottom third empty.
    var P = 80, W = w - P * 2, ph = photo ? 560 : 0;
    var big = photo ? 80 : 104, nameLh = photo ? 86 : 112, gapA = photo ? 24 : 64, gapB = photo ? 48 : 80, gapC = photo ? 36 : 64;
    ctx.font = font(photo ? 76 : 96, 800);
    var nameLines = wrap(ctx, d.name, W, 2);
    var stampPx = photo ? 22 : 30, bottom = h - 120;
    var head = 56 + nameLines.length * nameLh + (d.place ? 64 : 0) + gapA + big + 24 + gapB + (d.top ? 148 + gapC : 0);
    var start = photo ? ph - 40 : P;
    var stampRoom = bottom - start - head;
    var rows = Math.max(0, Math.min(3, Math.floor(stampRoom / (stampPx * 2.5))));
    var stampH = rows && d.breweries.length ? drawStamps(ctx, P, 0, W, d.breweries, stampPx, rows, true).height : 0;
    var top = photo ? start : Math.max(P, Math.round(start + (bottom - start - head - stampH) / 2));
    if (photo) cover(ctx, photo, 0, 0, w, ph, "bottom", 280);
    ctx.textBaseline = "top"; ctx.fillStyle = INK.amber; ctx.font = font(30, 800);
    ctx.fillText(fitText(ctx, kicker(d), W), P, top); top += 56;
    ctx.fillStyle = INK.text; ctx.font = font(photo ? 76 : 96, 800);
    nameLines.forEach(function (l) { ctx.fillText(l, P, top); top += nameLh; });
    if (d.place) { ctx.fillStyle = INK.soft; ctx.font = font(38, 500); ctx.fillText(fitText(ctx, d.place, W), P, top + 4); top += 64; }
    top += gapA;
    drawStats(ctx, P, top, W, statList(d), big, 24); top += big + 24 + gapB;
    if (d.top) { top += drawTop(ctx, P, top, W, d, 40) + gapC; }
    if (stampH) drawStamps(ctx, P, top, W, d.breweries, stampPx, rows);
    footer(ctx, P, h - 64, 26);
    return canvas;
  }

  /** The canvas as a PNG Blob. Throws (rejects) on a tainted canvas - which
   *  is exactly what drawing only same-origin blobs prevents. */
  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      try { canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("Could not draw the card here.")); }, "image/png"); }
      catch (e) { reject(e); }
    });
  }
  /** A same-origin image as something drawImage takes, via a Blob so the
   *  canvas stays clean. null on any failure: a card without its photo is
   *  still a card. */
  function loadImage(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("photo " + r.status);
      return r.blob();
    }).then(function (blob) {
      if (root.createImageBitmap) return root.createImageBitmap(blob);
      return new Promise(function (resolve, reject) {
        var img = new Image(), u = URL.createObjectURL(blob);
        img.onload = function () { resolve(img); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); };
        img.onerror = reject; img.src = u;
      });
    }).catch(function () { return null; });
  }
  function fileName(d, size) {
    return "crawl-" + (String(d.name || "recap").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "recap") + (size === "wide" ? "-wide" : "") + ".png";
  }

  var api = { SIZES: SIZES, INK: INK, cardData: cardData, fitText: fitText, wrap: wrap, clean: clean, draw: draw, toBlob: toBlob, loadImage: loadImage, fileName: fileName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RecapCard = api;
})(typeof window !== "undefined" ? window : globalThis);
