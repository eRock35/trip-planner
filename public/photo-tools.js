/*
 * Photo helpers for the trip apps' pages: shrink a photo before it leaves the
 * phone, read when it was taken, group a trip's photos by day, and play them
 * as a full-screen picture show.
 *
 * Shared by Trip Planner and the vacation app (synced by
 * scripts/sync-shared.js into each app's public/). No dependencies, one
 * global: window.PhotoTools.
 *
 * WHY SHRINK ON THE PHONE: a 12-megapixel iPhone photo is 3-5 MB. Redrawn at
 * 2048px it is ~500 KB and looks the same on any screen these apps draw on;
 * the upload is ten times faster on a beach's one bar of signal, and storage
 * and serving cost follow. Redrawing through a canvas also drops the photo's
 * embedded metadata - including GPS - so where a photo was taken never leaves
 * the phone. The one thing kept is WHEN, read here first and sent as a plain
 * field, because that is what files a photo under the right day.
 */
(function () {
  "use strict";

  /* ---------------- reading and shrinking ---------------- */

  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () { return viaImg(file); });
    }
    return viaImg(file);
  }
  function viaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { resolve(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("That photo could not be opened.")); };
      img.src = url;
    });
  }
  function draw(src, max, quality) {
    var w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    var k = Math.min(1, max / Math.max(w0, h0));
    var w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, w, h);
    var url = c.toDataURL("image/jpeg", quality);
    c.width = c.height = 0; // iOS keeps canvas memory until told otherwise
    return { data: url.slice(url.indexOf(",") + 1), width: w, height: h };
  }

  /* EXIF DateTimeOriginal, as the camera's wall-clock time:
     "2026-09-24T18:32:05", or null. Only JPEG carries readable EXIF here;
     anything else (or a photo that lost its metadata) returns null and the
     caller falls back to the upload time. */
  function exifDate(file) {
    return file.slice(0, 256 * 1024).arrayBuffer().then(function (buf) {
      var v = new DataView(buf);
      if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
      var off = 2;
      while (off + 10 < v.byteLength) {
        var marker = v.getUint16(off), len = v.getUint16(off + 2);
        if ((marker & 0xff00) !== 0xff00) return null;
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return tiffDate(v, off + 10);
        off += 2 + len;
      }
      return null;
    }).catch(function () { return null; });
  }
  function tiffDate(v, t) {
    try {
      var le = v.getUint16(t) === 0x4949;
      var u16 = function (o) { return v.getUint16(o, le); }, u32 = function (o) { return v.getUint32(o, le); };
      var ascii = function (e) {
        var n = u32(e + 4), o = n > 4 ? t + u32(e + 8) : e + 8, s = "";
        for (var i = 0; i < n - 1 && o + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(o + i));
        return s;
      };
      var scan = function (ifd, want) {
        var n = u16(ifd);
        for (var i = 0; i < n && i < 400; i++) { var e = ifd + 2 + i * 12, tag = u16(e); if (want[tag]) want[tag](e); }
      };
      var exif = null, plain = null, original = null;
      scan(t + u32(t + 4), { 0x8769: function (e) { exif = t + u32(e + 8); }, 0x0132: function (e) { plain = ascii(e); } });
      if (exif) scan(exif, { 0x9003: function (e) { original = ascii(e); } });
      var m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(original || plain || "");
      return m && m[1] !== "0000" ? m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + m[6] : null;
    } catch (e) { return null; }
  }

  /* One photo, ready to upload: { full: {data,width,height}, thumb: {data},
     takenAt }. `data` is base64 JPEG without the data: prefix. */
  function prepare(file, opts) {
    opts = opts || {};
    return exifDate(file).then(function (takenAt) {
      return decode(file).then(function (bmp) {
        var full = draw(bmp, opts.max || 2048, opts.quality || 0.84);
        var thumb = draw(bmp, opts.thumb || 480, 0.78);
        if (bmp.close) bmp.close();
        return { full: full, thumb: { data: thumb.data }, takenAt: takenAt };
      });
    });
  }

  /* A receipt, shrunk for reading: legible at 1600px, a few hundred KB. */
  function receipt(file) {
    return decode(file).then(function (bmp) {
      var r = draw(bmp, 1600, 0.86);
      if (bmp.close) bmp.close();
      return { mediaType: "image/jpeg", data: r.data };
    });
  }

  /* ---------------- grouping ---------------- */

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function localDay(iso) { // an ISO instant -> this phone's calendar day
    var d = new Date(iso);
    if (isNaN(d)) return null;
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function label(key) {
    var p = key.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]);
    return WEEKDAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();
  }
  function dayOf(photo) {
    return (photo.takenAt && photo.takenAt.slice(0, 10)) || (photo.uploadedAt && localDay(photo.uploadedAt)) || null;
  }
  function when(photo) { return photo.takenAt || photo.uploadedAt || ""; }

  /* Photos filed under the itinerary's days. `days` is the itinerary as the
     apps store it ({ date: "YYYY-MM-DD", title, dateLabel }); a photo from a
     day the itinerary does not name still gets its own group, dated. */
  function groupByDay(photos, days) {
    var byDate = {};
    (days || []).forEach(function (d, i) { if (d && d.date) byDate[String(d.date).slice(0, 10)] = { title: d.title || "", label: d.dateLabel || "", n: i + 1 }; });
    var groups = {};
    (photos || []).forEach(function (p) {
      var key = dayOf(p) || "undated";
      (groups[key] = groups[key] || []).push(p);
    });
    return Object.keys(groups).sort(function (a, b) { return a === "undated" ? 1 : b === "undated" ? -1 : a < b ? -1 : 1; })
      .map(function (key) {
        var day = byDate[key];
        return {
          key: key,
          dayNumber: day ? day.n : null,
          title: day && day.title ? day.title : (key === "undated" ? "More photos" : label(key)),
          dateLabel: key === "undated" ? "" : (day && day.label) || label(key),
          photos: groups[key].slice().sort(function (a, b) { return when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0; }),
        };
      });
  }

  /* Slides for a picture show: a title card, then each day's own title card
     and photos. `src(photo)` returns the URL to draw it from. */
  function slidesFrom(groups, opts) {
    opts = opts || {};
    var slides = [];
    if (opts.title) slides.push({ type: "title", title: opts.title, subtitle: opts.subtitle || "" });
    groups.forEach(function (g) {
      if (!g.photos.length) return;
      if (groups.length > 1 || !opts.title) {
        // A day the itinerary does not name is titled by its date already;
        // repeating the date underneath would say it twice.
        slides.push({ type: "title", title: g.title, subtitle: g.dayNumber ? "Day " + g.dayNumber + (g.dateLabel ? " · " + g.dateLabel : "") : (g.dateLabel !== g.title ? g.dateLabel : "") });
      }
      g.photos.forEach(function (p) {
        slides.push({ type: "photo", src: opts.src(p), caption: p.caption || "", sub: g.dateLabel });
      });
    });
    return slides;
  }

  /* ---------------- the picture show ---------------- */

  var CSS =
    ".pt-show{position:fixed;inset:0;z-index:2147483000;background:#000;color:#fff;overflow:hidden;touch-action:none;" +
    "font:16px/1.4 -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',Arial,sans-serif;-webkit-user-select:none;user-select:none}" +
    ".pt-layer{position:absolute;inset:0;opacity:0;transition:opacity .9s ease}" +
    ".pt-layer.on{opacity:1}" +
    ".pt-bg{position:absolute;inset:-8%;background-size:cover;background-position:center;filter:blur(34px) brightness(.55) saturate(1.2)}" +
    ".pt-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}" +
    ".pt-layer.kb1 .pt-img{animation:ptkb1 var(--d,6s) ease-out forwards}" +
    ".pt-layer.kb2 .pt-img{animation:ptkb2 var(--d,6s) ease-out forwards}" +
    ".pt-layer.kb3 .pt-img{animation:ptkb3 var(--d,6s) ease-out forwards}" +
    ".pt-layer.kb4 .pt-img{animation:ptkb4 var(--d,6s) ease-out forwards}" +
    "@keyframes ptkb1{from{transform:scale(1)}to{transform:scale(1.09) translate(1.5%,1%)}}" +
    "@keyframes ptkb2{from{transform:scale(1.09) translate(-1.5%,0)}to{transform:scale(1)}}" +
    "@keyframes ptkb3{from{transform:scale(1.02) translate(0,1.5%)}to{transform:scale(1.1) translate(0,-1%)}}" +
    "@keyframes ptkb4{from{transform:scale(1.1) translate(1%,-1%)}to{transform:scale(1.02) translate(-1%,1%)}}" +
    "@media (prefers-reduced-motion:reduce){.pt-layer .pt-img{animation:none!important}.pt-layer{transition-duration:.3s}}" +
    ".pt-title{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 28px;" +
    "background:radial-gradient(120% 90% at 50% 20%,#1f4e79 0%,#0b1f33 55%,#05080d 100%)}" +
    ".pt-title h2{margin:0;font-size:clamp(30px,7vw,64px);font-weight:700;letter-spacing:-.02em;line-height:1.08;max-width:18ch}" +
    ".pt-title p{margin:14px 0 0;font-size:clamp(15px,3.2vw,22px);opacity:.8;letter-spacing:.02em}" +
    ".pt-layer.on .pt-title h2{animation:ptrise 1.2s ease-out both}.pt-layer.on .pt-title p{animation:ptrise 1.2s .25s ease-out both}" +
    "@keyframes ptrise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}" +
    ".pt-cap{position:absolute;left:0;right:0;bottom:0;padding:60px 22px calc(26px + env(safe-area-inset-bottom));" +
    "background:linear-gradient(transparent,rgba(0,0,0,.6));font-size:17px;text-shadow:0 1px 3px rgba(0,0,0,.6);transition:opacity .5s}" +
    ".pt-cap small{display:block;font-size:13px;opacity:.75;margin-top:3px}" +
    ".pt-cap:empty{opacity:0}" +
    ".pt-bar{position:absolute;top:calc(10px + env(safe-area-inset-top));left:12px;right:12px;display:flex;gap:3px;z-index:3}" +
    ".pt-bar i{flex:1;height:2.5px;border-radius:2px;background:rgba(255,255,255,.3);overflow:hidden}" +
    ".pt-bar i b{display:block;height:100%;width:0;background:#fff}" +
    ".pt-bar i.done b{width:100%}" +
    ".pt-ui{position:absolute;inset:0;z-index:4;transition:opacity .35s}" +
    ".pt-show.idle .pt-ui{opacity:0}" +
    ".pt-btn{position:absolute;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border:0;border-radius:22px;" +
    "background:rgba(0,0,0,.38);color:#fff;font-size:20px;cursor:pointer;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}" +
    ".pt-close{top:calc(22px + env(safe-area-inset-top));right:14px}" +
    ".pt-play{bottom:calc(22px + env(safe-area-inset-bottom));right:14px}" +
    ".pt-prev{top:50%;left:10px;margin-top:-22px}.pt-next{top:50%;right:10px;margin-top:-22px}" +
    "@media (hover:none){.pt-prev,.pt-next{display:none}}" +
    ".pt-end{position:absolute;inset:0;z-index:5;display:none;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(0,0,0,.55)}" +
    ".pt-show.ended .pt-end{display:flex}" +
    ".pt-end button{border:0;border-radius:999px;padding:12px 22px;font:600 16px/1 inherit;cursor:pointer}" +
    ".pt-end .again{background:#fff;color:#000}.pt-end .done{background:rgba(255,255,255,.18);color:#fff}";

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* Plays `slides` full screen. Returns { close }. Options: start (index),
     photoMs (default 5000), titleMs (3200), onClose. */
  function slideshow(slides, opts) {
    opts = opts || {};
    slides = (slides || []).filter(Boolean);
    if (!slides.length) return { close: function () {} };
    if (!document.getElementById("pt-css")) { var st = el("style"); st.id = "pt-css"; st.textContent = CSS; document.head.appendChild(st); }
    var photoMs = opts.photoMs || 5000, titleMs = opts.titleMs || 3200;
    var root = el("div", "pt-show");
    root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Picture show");
    var layers = [el("div", "pt-layer"), el("div", "pt-layer")];
    var cap = el("div", "pt-cap");
    var bar = el("div", "pt-bar");
    var many = slides.length <= 60;
    if (many) slides.forEach(function () { bar.appendChild(el("i", "", "<b></b>")); });
    var ui = el("div", "pt-ui");
    var bClose = el("button", "pt-btn pt-close", "✕"); bClose.setAttribute("aria-label", "Close");
    var bPlay = el("button", "pt-btn pt-play", "❚❚"); bPlay.setAttribute("aria-label", "Pause");
    var bPrev = el("button", "pt-btn pt-prev", "‹"); bPrev.setAttribute("aria-label", "Previous");
    var bNext = el("button", "pt-btn pt-next", "›"); bNext.setAttribute("aria-label", "Next");
    [bClose, bPlay, bPrev, bNext].forEach(function (b) { b.type = "button"; ui.appendChild(b); });
    var end = el("div", "pt-end", '<button type="button" class="again">Play again</button><button type="button" class="done">Done</button>');
    root.appendChild(layers[0]); root.appendChild(layers[1]); root.appendChild(cap); root.appendChild(bar); root.appendChild(ui); root.appendChild(end);
    document.body.appendChild(root);
    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    var i = -1, front = 0, playing = true, timer = null, token = 0, closed = false, lock = null;
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (l) { lock = l; }).catch(function () {}); } catch (e) {}

    function preload(n) {
      var s = slides[n];
      if (!s || s.type !== "photo" || s._img) return s && s._img ? s._img : Promise.resolve();
      s._img = new Promise(function (resolve) {
        var im = new Image(); var done = function () { resolve(); };
        im.onload = done; im.onerror = done; setTimeout(done, 6000); im.src = s.src;
      });
      return s._img;
    }
    function progress(n, ms) {
      if (!many) return;
      Array.prototype.forEach.call(bar.children, function (c, k) {
        var b = c.firstChild; c.className = k < n ? "done" : ""; b.style.transition = "none"; b.style.width = k < n ? "100%" : "0";
      });
      var cur = bar.children[n] && bar.children[n].firstChild;
      if (cur && playing) { void cur.offsetWidth; cur.style.transition = "width " + ms + "ms linear"; cur.style.width = "100%"; }
    }
    function show(n) {
      if (closed) return;
      clearTimeout(timer);
      root.classList.remove("ended");
      i = Math.max(0, Math.min(slides.length - 1, n));
      var my = ++token, s = slides[i];
      preload(i).then(function () {
        if (my !== token || closed) return;
        var ms = s.type === "photo" ? photoMs : titleMs;
        var back = layers[1 - front];
        back.className = "pt-layer";
        back.style.setProperty("--d", (ms + 1200) + "ms");
        if (s.type === "photo") {
          back.innerHTML = '<div class="pt-bg" style="background-image:url(\'' + esc(s.src).replace(/'/g, "%27") + '\')"></div><img class="pt-img" alt="" src="' + esc(s.src) + '">';
          back.classList.add("kb" + (1 + (i % 4)));
          cap.innerHTML = s.caption ? esc(s.caption) + (s.sub ? "<small>" + esc(s.sub) + "</small>" : "") : "";
        } else {
          back.innerHTML = '<div class="pt-title"><h2>' + esc(s.title) + "</h2>" + (s.subtitle ? "<p>" + esc(s.subtitle) + "</p>" : "") + "</div>";
          cap.innerHTML = "";
        }
        void back.offsetWidth;
        back.classList.add("on");
        layers[front].classList.remove("on");
        front = 1 - front;
        progress(i, ms);
        preload(i + 1);
        if (playing) timer = setTimeout(next, ms);
      });
    }
    function next() {
      if (i >= slides.length - 1) { playing = false; setPlay(); root.classList.add("ended"); return; }
      show(i + 1);
    }
    function prev() { show(i - 1); }
    function setPlay() { bPlay.innerHTML = playing ? "❚❚" : "▶"; bPlay.setAttribute("aria-label", playing ? "Pause" : "Play"); }
    function toggle() {
      playing = !playing; setPlay();
      if (playing) { if (i >= slides.length - 1) show(0); else show(i); } else { clearTimeout(timer); progress(i, 0); }
    }
    var idleT = null;
    function wake() { root.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(function () { if (playing) root.classList.add("idle"); }, 2600); }
    function close() {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(idleT);
      document.removeEventListener("keydown", onKey); document.removeEventListener("visibilitychange", onVis);
      document.body.style.overflow = prevOverflow;
      try { if (lock) lock.release(); } catch (e) {}
      root.remove();
      if (opts.onClose) opts.onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") { wake(); next(); }
      else if (e.key === "ArrowLeft") { wake(); prev(); }
      else if (e.key === " ") { e.preventDefault(); wake(); toggle(); }
    }
    function onVis() { if (document.hidden && playing) toggle(); }
    bClose.onclick = function (e) { e.stopPropagation(); close(); };
    bPlay.onclick = function (e) { e.stopPropagation(); wake(); toggle(); };
    bPrev.onclick = function (e) { e.stopPropagation(); wake(); prev(); };
    bNext.onclick = function (e) { e.stopPropagation(); wake(); next(); };
    end.querySelector(".again").onclick = function () { playing = true; setPlay(); show(0); };
    end.querySelector(".done").onclick = close;
    // Tap the left third to go back, the right third to go on, the middle to
    // show or hide the controls; swipe sideways to move.
    var sx = null, sy = null;
    ui.addEventListener("touchstart", function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    ui.addEventListener("touchend", function (e) {
      if (sx == null) return;
      var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { wake(); if (dx < 0) next(); else prev(); e.preventDefault(); }
    });
    ui.addEventListener("click", function (e) {
      if (e.target !== ui) return;
      var x = e.clientX / window.innerWidth;
      if (x < 0.3) { wake(); prev(); } else if (x > 0.7) { wake(); next(); }
      else if (root.classList.contains("idle")) wake(); else root.classList.add("idle");
    });
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVis);
    wake();
    show(opts.start || 0);
    return { close: close };
  }

  window.PhotoTools = {
    prepare: prepare, receipt: receipt, exifDate: exifDate,
    groupByDay: groupByDay, slidesFrom: slidesFrom, slideshow: slideshow,
    dayOf: dayOf, dayLabel: label,
  };
})();
