/* Cryptex video — deterministic render engine.
 *
 * Everything on screen is a pure function of the video timestamp t. The capture
 * harness calls window.__render(t) once per frame and screenshots the page; no
 * wall-clock animation is ever used, so every frame is reproducible.
 *
 * Scenes register into window.SCENES (see scenes.js). Each gets its own layer
 * with an inner camera; the engine owns the cuts between layers (a slow
 * dissolve), the security-print background, the real app in
 * iframes, and the sound-effect cue list.
 */
(function () {
  const SCENES = (window.SCENES = {});

  // ---- math / easing ------------------------------------------------------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ramp = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a)));
  const outQuint = (t) => 1 - Math.pow(1 - clamp(t), 5);
  const outCubic = (t) => 1 - Math.pow(1 - clamp(t), 3);
  const outExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(t)));
  const inCubic = (t) => Math.pow(clamp(t), 3);
  const inOutCubic = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  const inOutSine = (t) => -(Math.cos(Math.PI * clamp(t)) - 1) / 2;
  const outBack = (t, s = 1.4) => { t = clamp(t); return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); };
  // a damped spring settling on 1 — for things that land with a little weight
  const spring = (t, k = 7, z = 5) => (t <= 0 ? 0 : 1 - Math.exp(-z * t) * Math.cos(k * t));

  // seeded noise, so "random" things are identical on every render
  function rnd(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  /* fade + rise (+ scale, + a short de-blur) from p = 0..1 */
  function reveal(node, p, o = {}) {
    if (!node) return p;
    const e = (o.ease || outQuint)(p);
    if (p <= 0) { node.style.visibility = "hidden"; return p; }
    node.style.visibility = "visible";
    node.style.opacity = clamp(e * (o.alpha ?? 1)).toFixed(4);
    const dy = (o.dy ?? 30) * (1 - e), dx = (o.dx ?? 0) * (1 - e);
    const sc = lerp(o.scale ?? 1, 1, e);
    node.style.transform = `${o.base || ""} translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${sc.toFixed(4)})`;
    const bl = (o.blur ?? 0) * (1 - e);
    node.style.filter = bl > 0.3 ? `blur(${bl.toFixed(2)}px)` : "none";
    return p;
  }

  // ---- DOM helpers ----------------------------------------------------------
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, cls, parent, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    if (parent) parent.appendChild(n);
    return n;
  }
  /* centre-anchored box at (x, y); its own transform stays free for reveal() */
  function at(parent, x, y, cls, html) {
    const wrap = el("div", "ctr", parent);
    wrap.style.left = x + "px"; wrap.style.top = y + "px";
    return el("div", cls || "", wrap, html);
  }
  const cache = new WeakMap();
  function setText(node, s) { if (cache.get(node) !== s) { node.textContent = s; cache.set(node, s); } }
  function setHTML(node, s) { if (cache.get(node) !== s) { node.innerHTML = s; cache.set(node, s); } }
  function setClass(node, cls, on) { if (node.classList.contains(cls) !== !!on) node.classList.toggle(cls, !!on); }

  /* kinetic words: split `text` into masked words. Returns the inner spans. */
  function words(parent, text, wordCls) {
    return text.split(" ").map((w, i, all) => {
      const k = el("span", "kt", parent);
      const s = el("span", wordCls || "", k);
      s.textContent = w;
      if (i < all.length - 1) parent.appendChild(document.createTextNode(" "));
      return s;
    });
  }
  /* rise each word out of its mask, staggered, starting at t0 (and leave upward from `out`) */
  function kin(spans, t, t0, stagger = 0.06, dur = 0.55, out = null) {
    spans.forEach((s, i) => {
      const p = outQuint(ramp(t, t0 + i * stagger, t0 + i * stagger + dur));
      let y = (1 - p) * 120;
      if (out != null) y -= inCubic(ramp(t, out + i * stagger * 0.5, out + i * stagger * 0.5 + 0.5)) * 120;
      s.style.transform = `translateY(${y.toFixed(2)}%)`;
    });
  }

  // ---- ciphertext -----------------------------------------------------------
  // The app's own glyphs (web/src/screens/Home.tsx), so the film scrambles text
  // the way the composer does when it seals.
  const GLYPHS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789#%&*+=?@$/";
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  /* a glyph that changes `rate` times a second, the same for the same (i, t) */
  const glyph = (i, t, rate = 22, set = GLYPHS) => set[Math.floor(rnd(i * 7.31 + Math.floor(t * rate) * 1.17) * set.length)];
  /* `src` turning into gibberish from left to right over [t0, t0 + dur] (p = 0..1),
     then shuffling; whitespace is kept, as in the app */
  function scramble(src, t, t0, dur, seed = 0) {
    const cut = ramp(t, t0, t0 + dur) * src.length * 1.1;
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      out += /\s/.test(ch) || i > cut || t < t0 ? ch : glyph(i + seed * 101, t);
    }
    return out;
  }
  /* the reverse: gibberish settling into `src` from left to right */
  function decrypt(src, t, t0, dur, seed = 0) {
    const cut = ramp(t, t0, t0 + dur) * src.length * 1.1;
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      out += /\s/.test(ch) || i < cut - 1 ? ch : glyph(i + seed * 101, t);
    }
    return out;
  }
  /* a deterministic base64url string, for ids, keys and ciphertext */
  const b64 = (n, seed) => Array.from({ length: n }, (_, i) => B64[Math.floor(rnd(seed * 31.7 + i * 3.1) * 64)]).join("");

  // ---- fonts and frames -------------------------------------------------------
  // measured layouts must wait for real metrics; the harness awaits __ready
  const AFTER_FONTS = [];
  const WAIT = [];
  let fontsSettled = false;
  function afterFonts(fn) { AFTER_FONTS.push(fn); }
  function settleFonts() { if (!fontsSettled) { fontsSettled = true; AFTER_FONTS.forEach((fn) => fn()); } }

  /* The real app, in an iframe: web/dist/index.html with its scripts taken out,
     styled by the real stylesheet. Scenes fill #app with the markup the app
     renders (copied from its DOM) and drive it. CSS animations are paused and
     seeked by the scene (seek()), so a frame never depends on when it was
     painted. The app is enlarged with CSS zoom, never a transform: zoom lays
     the page out at the bigger size, so text is rasterized sharp. */
  let APP_HTML = "";
  function appFrame(parent, { x = 0, y = 0, w, h, zoom = 1, theme = "dark", ox = 0, oy = 0 }) {
    const f = el("iframe", "appframe", parent);
    f.setAttribute("scrolling", "no");
    Object.assign(f.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    const B = { frame: f, zoom, doc: null, app: null, pending: null, x, y, w, h };
    const ready = new Promise((res) => f.addEventListener("load", res, { once: true })).then(() => {
      B.doc = f.contentDocument;
      B.doc.documentElement.style.zoom = zoom;
      B.doc.documentElement.setAttribute("data-theme", theme);
      B.app = B.doc.getElementById("app");
      // a frame without the app's stylesheet must stop the capture, never render
      const styled = [...B.doc.styleSheets].some((sh) => { try { return sh.cssRules.length > 50; } catch (e) { return false; } });
      if (!styled) throw new Error("the app's stylesheet did not load in an iframe");
      if (B.pending != null) B.app.innerHTML = B.pending;
      return B.doc.fonts.ready;
    });
    WAIT.push(ready);
    f.srcdoc = APP_HTML;
    B.ready = ready;
    B.html = (s) => { if (B.app) setHTML(B.app, s); else B.pending = s; };
    B.$ = (s) => B.doc.querySelector(s);
    B.$$ = (s) => [...B.doc.querySelectorAll(s)];
    B.scroll = (yy) => { const want = Math.round(yy); if (f.contentWindow.scrollY !== want) f.contentWindow.scrollTo(0, want); };
    /* where a node sits, in camera coordinates (ox, oy: where the iframe's parent sits in the camera).
       Inside the zoomed page, rects and scroll offsets are already in on-screen pixels. */
    B.at = (node, fx = 0.5, fy = 0.5) => {
      if (typeof node === "string") node = B.$(node);
      const r = node.getBoundingClientRect();
      return [ox + x + r.left + r.width * fx, oy + y + r.top + r.height * fy];
    };
    /* pause the app's CSS animations under `node` and put them at `ms` from their start */
    B.seek = (node, ms) => {
      if (!node) return;
      node.getAnimations({ subtree: true }).forEach((a) => {
        a.pause();
        a.currentTime = Math.max(0, typeof ms === "function" ? ms(a.animationName) : ms);
      });
    };
    return B;
  }
  function stripApp(html) {
    // No transitions, and no animations outside an .anim subtree, whose
    // animations the scene seeks frame by frame (B.seek).
    const css = "<style>html,body{overflow:hidden!important;scrollbar-width:none}" +
      "*,*::before,*::after{transition:none!important;caret-color:transparent}" +
      ":not(.anim,.anim *),:not(.anim,.anim *)::before,:not(.anim,.anim *)::after{animation:none!important}" +
      // pages start at the top: centred, they would jump when a panel opens and leave empty space above
      ".send-page{align-content:start!important}</style>";
    return html
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<link rel="(modulepreload|manifest|icon|apple-touch-icon)"[^>]*>/g, "")
      .replace("</head>", css + "</head>");
  }

  // ---- the app's icons and mark (web/src/ui/icons.tsx), read at load --------------
  let ICONS = {};
  let MARK = "";
  const icon = (name, size = "") => `<svg class="ic${size ? " " + size : ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  const mark = (cls = "mark") => `<svg class="${cls}" viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${MARK}"/></svg>`;

  const A = { clamp, lerp, ramp, rnd, outQuint, outCubic, outExpo, inCubic, inOutCubic, inOutSine, outBack, spring,
              reveal, el, at, setText, setHTML, setClass, words, kin, afterFonts, appFrame, scramble, decrypt, glyph, b64,
              icon, mark, GLYPHS, MARK: () => MARK };
  window.Toolkit = A;

  // ---- timeline, cues -------------------------------------------------------------
  let TL = null;
  const CUES = [];                 // sound effects: { t, type, gain }
  const BPM = 100, BEAT = 60 / BPM;
  const GRID = { t0: 0, tense: 1e9, drop: 1e9 };

  function api(scene, layer, cam) {
    const t0 = scene.start;
    return Object.assign({
      tl: TL.d, scene, layer, cam, t0, W: 1920, H: 1080,
      dur: scene.end - scene.start,
      on: (id, label) => TL.byId[id].onsets[label] - t0,
      segStart: (id) => TL.byId[id].start - t0,
      segEnd: (id) => TL.byId[id].end - t0,
      cue: (type, t, gain = 1) => CUES.push({ t: +(t0 + t).toFixed(3), type, gain }),
      /* the beat grid: anchor it (open), mark where the score tightens and where it drops (story) */
      grid: (key, t) => { GRID[key] = t0 + t; },
      /* the nearest beat to scene time t, in scene time */
      snap: (t) => GRID.t0 + Math.round((t0 + t - GRID.t0) / BEAT) * BEAT - t0,
      BEAT,
    }, A);
  }

  // ---- background: security print -----------------------------------------------
  /* A guilloche rosette, the circular form of the app's sealed pattern (two
     waves crossing): rings of sine waves, each a little out of phase with the
     next, drawn once into a canvas and turned slowly. */
  function rosette(canvas, size, { rings, r0, r1, petals, amp, color, alpha, width = 1 }) {
    const k = 1.25;                                   // backing resolution
    canvas.width = canvas.height = Math.round(size * k);
    canvas.style.width = canvas.style.height = size + "px";
    const g = canvas.getContext("2d");
    g.scale(k, k);
    g.translate(size / 2, size / 2);
    g.strokeStyle = color; g.lineWidth = width;
    for (let fam = 0; fam < 2; fam++) {
      for (let i = 0; i < rings; i++) {
        const r = lerp(r0, r1, i / (rings - 1));
        const ph = (fam ? Math.PI : 0) + i * 0.33;
        g.globalAlpha = alpha * (0.55 + 0.45 * Math.sin(Math.PI * i / (rings - 1)));
        g.beginPath();
        for (let s = 0; s <= 1440; s++) {
          const a = (s / 1440) * Math.PI * 2;
          const rr = r + amp * Math.sin(petals * a + ph) + amp * 0.35 * Math.sin((petals * 3) * a - ph);
          const px = rr * Math.cos(a), py = rr * Math.sin(a);
          s ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.stroke();
      }
    }
  }
  function paintBackground(t) {
    const bg = document.getElementById("bg");
    bg.querySelector(".ro1").style.transform = `translate(-50%, -50%) rotate(${(t * 1.1).toFixed(3)}deg)`;
    bg.querySelector(".ro2").style.transform = `translate(-50%, -50%) rotate(${(-t * 1.6).toFixed(3)}deg)`;
    const l = bg.querySelector(".light");
    l.style.transform = `translate(${(60 * Math.sin(t * 0.07)).toFixed(1)}px, ${(40 * Math.cos(t * 0.05)).toFixed(1)}px)`;
  }

  // ---- build + render -----------------------------------------------------------
  /* The cut: a push-through, as in the fsend, FileSync and Flow films. The
     scene leaving moves towards the viewer and softens; the next one settles
     in from just behind it, with a whoosh. Unhurried, so the eye can follow. */
  const CUT_OUT = 0.5, CUT_IN = 0.75;
  let built = null;

  function build() {
    const root = document.getElementById("scenes");
    built = [];
    TL.scenes.forEach((scene, idx) => {
      const layer = el("div", "layer", root);
      layer.style.zIndex = 10 + idx;
      const cam = el("div", "cam", layer);
      const render = SCENES[scene.name](cam, api(scene, layer, cam));
      built.push({ scene, layer, render });
      if (idx > 0) CUES.push({ t: +(scene.start - 0.32).toFixed(3), type: "whoosh", gain: 0.55 });
    });
    CUES.sort((a, b) => a.t - b.t);
  }

  function render(t) {
    settleFonts();
    paintBackground(t);

    for (let i = 0; i < built.length; i++) {
      const { scene: s, layer, render: r } = built[i];
      const last = i === built.length - 1;
      const outP = last ? 0 : ramp(t, s.end - CUT_OUT, s.end + 0.05);
      const inP = i === 0 ? 1 : ramp(t, s.start - 0.05, s.start + CUT_IN);
      // display, not visibility: a revealed child would show through a hidden parent
      if (outP >= 1 || inP <= 0) { layer.style.display = "none"; continue; }
      layer.style.display = "";
      const eo = inCubic(outP), ei = outQuint(inP);
      layer.style.opacity = ((1 - eo) * ei).toFixed(4);
      const sc = lerp(1, 1.1, eo) * lerp(0.93, 1, ei);
      layer.style.transform = sc !== 1 ? `scale(${sc.toFixed(5)})` : "";
      const bl = 8 * eo + 6 * (1 - ei);
      layer.style.filter = bl > 0.4 ? `blur(${bl.toFixed(2)}px)` : "none";
      r(t - s.start, t);
    }

    const fadeIn = ramp(t, 0, 0.5);
    const fadeOut = 1 - ramp(t, TL.d.video_end - 1.2, TL.d.video_end - 0.05);
    document.getElementById("whiteout").style.opacity = (1 - Math.min(fadeIn, fadeOut)).toFixed(4);
  }

  // ---- capture API --------------------------------------------------------------
  window.__init = async function (data) {
    const byId = {};
    data.segments.forEach((s) => (byId[s.id] = s));
    TL = { d: data, byId, scenes: data.scenes };
    APP_HTML = stripApp(await (await fetch("/index.html")).text());
    // the app's icon set and mark, straight from its source
    const src = await (await fetch("/src/ui/icons.tsx")).text();
    const p0 = src.indexOf("const P = {") + 10, p1 = src.indexOf("\n}", p0) + 2;
    ICONS = JSON.parse(src.slice(p0, p1).replace(/,\s*}$/, "}"));
    MARK = src.match(/MARK_PATH = '([^']+)'/)[1];
    rosette(document.querySelector("#bg .ro1"), 2600, { rings: 26, r0: 520, r1: 1250, petals: 18, amp: 34, color: "#5f78b8", alpha: 0.22 });
    rosette(document.querySelector("#bg .ro2"), 1500, { rings: 16, r0: 260, r1: 700, petals: 12, amp: 26, color: "#5f78b8", alpha: 0.18 });
    build();
    window.__ready = Promise.all([
      document.fonts.load('700 132px "Red Hat Display"'),
      document.fonts.load('600 40px "Red Hat Display"'),
      document.fonts.load('500 26px "Red Hat Text"'),
      document.fonts.load('500 26px "Red Hat Mono"'),
      ...WAIT,
    ]).then(() => document.fonts.ready).then(() => true);
  };
  window.__render = render;
  // the score reads the beat grid from the same list: where it starts, where it drops
  window.__cues = () => CUES.concat([{ t: +GRID.t0.toFixed(3), type: "beat0", gain: 0 }, { t: +GRID.tense.toFixed(3), type: "tense", gain: 0 },
    { t: +GRID.drop.toFixed(3), type: "groove", gain: 0 }])
    .sort((a, b) => a.t - b.t);
  window.__duration = () => (TL ? TL.d.video_end : 0);
  /* the README's poster: the scenes' own composition (window.POSTER), with a play button */
  window.__poster = async function () {
    if (window.POSTER) await window.POSTER(document.getElementById("stage"));
    el("div", "", document.getElementById("stage")).id = "poster-play";
  };
})();
