/* Cryptex video — the scenes.
 *
 * Every scene is a function (cam, api) -> render(t) where t is seconds since the
 * scene's start (negative while it is cutting in). `cam` is the scene's camera:
 * transform it to push, pan or drift the whole shot. Moments come from the
 * narration via api.on(line, anchor) / api.segStart(line), so a frame is a pure
 * function of t and the visuals track the voice. Sound effects are registered
 * up front with api.cue(type, t) and mixed by sfx.py.
 *
 * The app on screen is the real one: its stylesheet, fonts and icons, in
 * iframes, filled with the markup it renders (copied from its DOM; see app()
 * and the page templates below) and its own copy (web/src/copy/en.json). The
 * story: Maya seals a database login into a link; it opens once.
 */
(function () {
  const A = window.Toolkit;
  const { clamp, lerp, ramp, rnd, outQuint, outCubic, inCubic, inOutCubic, inOutSine, outBack, spring,
          reveal, el, at, setText, setHTML, setClass, words, kin, afterFonts, appFrame, scramble, glyph, icon, mark } = A;
  const ic = icon;

  // the story's fixed values: one link, one server, one morning
  const HOST = "secrets.example.com";
  const ID = "kf3EJGT1ba", KEY = "eagrM95CDBgoHA1Mtodmrw";
  const ENV = [["DB_HOST", "db.internal:5432"], ["DB_USER", "app"], ["DB_PASSWORD", "k7#Qp2-vR9mL"]];
  const TITLE = "Production database";

  /* ------------------------------------------------------------------ *
   *  film helpers
   * ------------------------------------------------------------------ */
  /* camera: interpolate between keyframes [t, scale, x, y, dur] with an ease */
  function camera(cam, t, keys, drift = 1) {
    let s = keys[0][1], x = keys[0][2], y = keys[0][3];
    for (let i = 1; i < keys.length; i++) {
      const [t1, s1, x1, y1, d = 0.9] = keys[i];
      const p = inOutCubic(ramp(t, t1, t1 + d));
      s = lerp(s, s1, p); x = lerp(x, x1, p); y = lerp(y, y1, p);
    }
    x += drift * 4 * Math.sin(t * 0.45); y += drift * 3 * Math.cos(t * 0.37);
    s *= 1 + 0.003 * drift * Math.sin(t * 0.3);
    cam.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(5)})`;
  }


  /* the camera keyframe that puts camera-space point p at screen point `to`, at scale s */
  const aim = (t, s, p, to = [960, 540], d = 0.9) => [t, s, to[0] - 960 - (p[0] - 960) * s, to[1] - 540 - (p[1] - 540) * s, d];



  const blink = (t, period = 1.0) => (((t % period) + period) % period < period * 0.55 ? 1 : 0);
  const typed = (text, t, t0, rate) => (t < t0 ? "" : text.slice(0, clamp(Math.floor((t - t0) / rate) + 1, 0, text.length)));

  /* a position that eases between waypoints [t, x, y] */
  function path(keys) {
    return (t) => {
      if (t <= keys[0][0]) return [keys[0][1], keys[0][2]];
      for (let i = 1; i < keys.length; i++) {
        if (t < keys[i][0]) {
          const p = inOutCubic(ramp(t, keys[i - 1][0], keys[i][0]));
          return [lerp(keys[i - 1][1], keys[i][1], p), lerp(keys[i - 1][2], keys[i][2], p)];
        }
      }
      const k = keys[keys.length - 1];
      return [k[1], k[2]];
    };
  }

  /* the pointer, with a press and a ripple on each click */
  const POINTER = `<svg viewBox="0 0 24 24" width="46" height="46" style="overflow:visible"><path d="M5 2.5l14.5 8-6.4 1.7-3.2 6.6z"
    fill="#0F1419" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  function pointer(parent) {
    const n = el("div", "cursor", parent, POINTER);
    const rip = el("div", "ripple", parent);
    n.style.transformOrigin = "9px 4px";
    return function (t, [x, y], clicks, alpha = 1) {
      let press = 0, rp = -1;
      for (const c of clicks) {
        if (t > c - 0.08 && t < c + 0.18) press = Math.max(press, Math.sin(Math.PI * ramp(t, c - 0.08, c + 0.18)));
        if (t >= c && t < c + 0.55) rp = ramp(t, c, c + 0.55);
      }
      n.style.opacity = alpha.toFixed(3);
      n.style.transform = `translate(${(x - 9).toFixed(1)}px, ${(y - 4).toFixed(1)}px) scale(${(1 - 0.16 * press).toFixed(3)})`;
      if (rp >= 0) {
        rip.style.opacity = ((1 - rp) * 0.8 * alpha).toFixed(3);
        rip.style.left = x + "px"; rip.style.top = y + "px";
        rip.style.transform = `scale(${(0.3 + 0.9 * outCubic(rp)).toFixed(3)})`;
      } else rip.style.opacity = 0;
    };
  }
  /* a finger tap (phone): a soft disc that presses and fades */
  function tapper(parent) {
    const n = el("div", "tap", parent);
    return function (t, [x, y], when) {
      const p = ramp(t, when - 0.25, when + 0.45);
      if (p <= 0 || p >= 1) { n.style.opacity = 0; return; }
      n.style.left = x + "px"; n.style.top = y + "px";
      const press = Math.sin(Math.PI * ramp(t, when - 0.1, when + 0.15));
      n.style.opacity = (Math.sin(Math.PI * p) * 0.95).toFixed(3);
      n.style.transform = `scale(${(1 - 0.18 * press).toFixed(3)})`;
    };
  }
  /* a soft light, drawn as a gradient (no blur filters) */
  function bloom(parent, x, y, size, color) {
    const b = el("div", "abs", parent);
    Object.assign(b.style, { left: x - size / 2 + "px", top: y - size / 2 + "px", width: size + "px", height: size + "px",
      borderRadius: "50%", background: `radial-gradient(closest-side, ${color}, transparent)` });
    return b;
  }

  /* a browser window holding the app; url: [host, path] */
  function browser(parent, { x, y, w, h, zoom = 1, url = [HOST, ""] }) {
    const win = el("div", "win", parent);
    Object.assign(win.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    const chrome = el("div", "chrome", win, `<i></i><i></i><i></i><div class="url"><svg viewBox="0 0 24 24">${ICON_LOCK}</svg><span class="u"></span></div>`);
    const B = appFrame(win, { x: 0, y: 52, w, h: h - 52, zoom, ox: x, oy: y });
    B.win = win;
    const u = chrome.querySelector(".u");
    B.url = ([hst, pth]) => setHTML(u, `${hst}<span class="p">${pth}</span>`);
    B.url(url);
    return B;
  }
  const ICON_LOCK = `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`;

  /* a phone holding the app (390 css px wide, as the app's mobile layout) */
  function phone(parent, { x, y, w = 420, h = 876 }) {
    const P = el("div", "phone", parent);
    Object.assign(P.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    const scr = el("div", "scr", P);
    el("div", "bar", scr, `<span>9:41</span><span style="letter-spacing:2px">●●● ▮</span>`);
    el("div", "island", scr);
    const sw = w - 26;
    const B = appFrame(scr, { x: 0, y: 50, w: sw, h: h - 26 - 50, zoom: sw / 390, ox: x + 13, oy: y + 13 });
    B.phone = P;
    B.sleep = el("div", "sleep", scr);
    return B;
  }

  /* ------------------------------------------------------------------ *
   *  the app's pages, as it renders them (web/src/screens, en.json)
   * ------------------------------------------------------------------ */
  const MENU = `<option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option>`;
  function hdOwner(on, count) {
    return `<header class="hd"><a class="brand" href="/">${mark()}<span class="wordmark">cryptex</span></a><span class="sp"></span>`
      + `<nav><a class="navlink nav-new${on === "new" ? " on" : ""}" href="/">${ic("plus", "sm")}<span class="nav-l">New secret</span><span class="nav-s">New</span></a>`
      + `<a class="navlink${on === "links" ? " on" : ""}" href="/links">Your links${count ? `<span class="count">${count}</span>` : ""}</a>`
      + `<a class="navlink hide-m${on === "server" ? " on" : ""}" href="/server">${ic("gauge", "sm")}Server</a></nav>`
      + `<div class="has-pop"><button class="avatar">M</button></div></header>`;
  }
  function hdRecipient(brand) {
    const b = brand ? `<img class="op-logo img" src="${brand.logo}" alt=""><span class="op-name">${brand.name}</span><span class="op-sub">Secure share</span>`
      : `${mark()}<span class="wordmark">cryptex</span>`;
    return `<header class="hd"><span class="brand">${b}</span><span class="sp"></span><span class="theme-pick">${ic("contrast", "sm")}<select>${MENU}</select></span></header>`;
  }
  const foot = () => `<footer class="ft"><span class="ft-i"><span>Powered by</span><a class="ft-brand" href="#">${mark()}<b>cryptex</b></a></span><span class="ft-i dot"><span>End-to-end encrypted</span></span></footer><div class="toasts"></div>`;

  const linkHTML = (kind = "s", id = ID, key = KEY) => `${HOST}/${kind}/${id}<span class="frag">#<span class="frag-head">${key.slice(0, 6)}</span>…${key.slice(-4)}</span>`;

  /* Send a secret (Home.tsx), from an empty composer to the seal. o: { fields, title, options, once, hour, seal } */
  function sendPage(o) {
    const once = !!o.once;
    const lede = once ? "Only the person you send the link to can read it, and it deletes itself once it’s opened."
      : "Only the people you send the link to can read it, until it expires.";
    const rule = `<div class="rule-facts"><span>${ic("eye", "sm")}${once ? "Opens once" : "Opens until it expires"}</span><span>${ic("clock", "sm")}Expires in ${o.hour ? "1 hour" : "1 day"}</span></div>`;
    let body;
    if (!o.fields) {
      body = `<section class="composer${o.focus ? " focus" : ""}"><div class="cmp-empty"><textarea class="ph-area" rows="1" placeholder="Type or paste a password, a login, a private note…" style="height: 180px;"></textarea></div>`
        + cmpBar(false, false) + `</section>`;
    } else {
      const rows = ENV.map(([k, v], i) => `<div class="field edit"${i >= o.fields ? ' style="display:none"' : ""}><span class="k"><input placeholder="Name" value="${k}"></span>`
        + `<input class="v${k === "DB_PASSWORD" ? " secret" : ""}" type="${k === "DB_PASSWORD" ? "password" : "text"}" placeholder="Value" value="${v}">`
        + `<span class="acts">${k === "DB_PASSWORD" ? `<button type="button" class="btn icon sm ghost">${ic("eye", "sm")}</button><button type="button" class="btn sm ghost">Generate</button>` : ""}`
        + `<button type="button" class="btn icon sm ghost">${ic("x", "sm")}</button></span></div>`).join("");
      body = `<section class="composer${o.focus ? " focus" : ""}"><div class="cmp-title"><input class="t" placeholder="Add a title (optional)" value="${o.title || ""}"><div class="hint-wrap"><p class="hint">${ic("eye", "sm")}Shown to them before they open it.</p></div></div>`
        + `<div class="cmp-note"><textarea class="note-area slim" rows="1" placeholder="Add a note (optional)" style="height: 26px;"></textarea></div>`
        + `<div class="items">${rows}</div>` + cmpBar(true, true) + (o.seal ? SEAL_OVER : "") + `</section>`;
    }
    const below = o.options
      ? `<section class="panel"><div class="panel-h"><span class="h3">Link options</span><button type="button" class="btn sm ghost">Done</button></div>`
        + `<div class="opt"><span class="lbl">Expires after</span><div><div class="choices"><button type="button" class="choice${o.hour ? " on" : ""}">1 hour</button><button type="button" class="choice${o.hour ? "" : " on"}">1 day</button><button type="button" class="choice">7 days</button><button type="button" class="choice">Custom</button></div></div></div>`
        + `<div class="opt"><span class="lbl">One-time link</span><label class="check"><input type="checkbox"${once ? " checked" : ""}><span><b>Destroy it after it’s opened</b><small>${once ? "It opens once, then it’s deleted for good." : "Anyone with the link can open it, as often as they like, until it expires."}</small></span></label></div>`
        + `<div class="opt"><span class="lbl">Passphrase</span><div class="stack" style="gap: 12px;"><label class="check"><input type="checkbox"><span><b>Ask for a passphrase</b><small>They type it to open the link. Tell it to them another way, like on a call.</small></span></label></div></div></section>`
      : `<div class="send-foot"><div class="rule live">${rule}<button type="button" class="btn sm ghost change">${ic("sliders", "sm")}Change</button></div></div>`;
    return hdOwner("new", 3) + `<main class="main send-page"><div class="send-head"><div class="head-row"><h1 class="h1">Send a secret</h1>`
      + `<div class="page-acts"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button></div></div>`
      + `<p class="lede">${lede}</p></div>${body}${below}</main>` + foot();
  }
  function cmpBar(filled, env) {
    return `<div class="cmp-bar"><button type="button" class="btn sm ghost">${ic("clip", "sm")}Attach files</button><button type="button" class="btn sm ghost">${ic("plus", "sm")}Add field</button>`
      + `<button type="button" class="btn sm ghost cmp-expand">${ic("expand", "sm")}<span class="cmp-expand-l">Expand</span></button><span class="cmp-end">`
      + (env ? `<span class="detected">${ic("scan", "sm")}Read as a .env file · <button type="button" class="link">Undo</button></span>` : `<span class="detected drop-only">Or drop files here</span>`)
      + `<span class="cmp-go"><button type="button" class="btn primary" id="send-go"${filled ? "" : ' aria-disabled="true"'}>${ic("link", "sm")}Create link</button></span></span></div>`;
  }
  /* the seal closing over the composer while the link is made (Home.tsx SealOverlay) */
  const SEAL_OVER = `<div class="seal-over s1 anim" style="--lock:600ms;--save:300ms;--ready:380ms"><div class="seal-cipher"></div><div class="seal-cover tint"></div>`
    + `<span class="seal-mark"></span><div class="seal-status"><span class="seal-txt"></span><span class="seal-bar"><i><b></b></i><i><b></b></i><i><b></b></i></span></div></div>`;

  /* the link is ready (LinkReady.tsx) */
  function sentPage() {
    return hdOwner("new", 4) + `<main class="main send-page arrive anim"><div class="stack" style="gap: 10px;"><span class="copied">${ic("check")}Link copied</span><h1 class="h1">${TITLE}</h1><span class="status waiting"><i></i>Waiting to be opened</span></div>`
      + `<div class="stack" style="gap: 10px;"><div class="linkbox"><span class="url"><span>${linkHTML()}</span></span><button type="button" class="btn primary">${ic("copy", "sm")}Copy</button><button type="button" class="btn secondary icon">${ic("qr", "sm")}</button></div><p class="muted small">Paste it into a chat or email to the person you’re sending it to.</p></div>`
      + `<div class="facts"><div><small>Opens</small><b>Once</b></div><div><small>Expires</small><b>Fri, Oct 30, 10:41 AM</b><span>in 1 hour</span></div><div><small>Contains</small><b>3 fields</b></div></div>`
      + `<div class="actions-m between"><button type="button" class="btn danger hide-m">${ic("trash", "sm")}Destroy</button><div class="row"><button type="button" class="btn secondary">${ic("plus", "sm")}Send another</button><a class="btn primary" href="#">Done</a></div></div></main>` + foot();
  }

  /* ------------------------------------------------------------------ *
   *  the lockup: the mark clasps shut (as in the app's seal), then the name
   *  decrypts beside it, left to right, behind a sweep of light
   * ------------------------------------------------------------------ */
  const WORD = "cryptex";
  function lockup(parent, size) {
    const n = el("div", "lockup", parent);
    n.style.fontSize = size + "px";
    const ring = el("div", "lring", n);
    const lm = el("div", "lmark", n, mark("m"));
    const msvg = lm.querySelector("svg");
    const word = el("div", "lword", n);
    const letters = WORD.split("").map((c) => el("span", "", word, c));
    const sweep = el("div", "lsweep", n);
    // the header's proportions: mark 1.37x the wordmark's size, gap 0.53x
    const ms = 1.37 * size, gap = 0.53 * size;
    lm.style.width = lm.style.height = ms + "px";
    let ww = 3.6 * size, lx = [];
    afterFonts(() => {
      const w0 = word.getBoundingClientRect();
      ww = w0.width;
      lx = letters.map((sp) => { const r = sp.getBoundingClientRect(); sp.style.width = r.width + "px"; return r.left - w0.left; });
    });
    return {
      node: n,
      /* show 0..1 the mark in; clasp 0..1 shut; open 0..1 the name decrypts (and the mark moves aside) */
      set(t, { show, clasp, open, punch = 0 }) {
        const total = ms + gap + ww;
        const slide = inOutCubic(ramp(open, 0, 0.42));
        const markX = lerp(0, -total / 2 + ms / 2, slide);
        const e = outQuint(show);
        lm.style.opacity = clamp(show * 2.5).toFixed(3);
        lm.style.transform = `translate(${(markX - ms / 2).toFixed(2)}px, -50%)`;
        const rot = lerp(-24, 0, outBack(clasp, 2.2)), sc = lerp(1.15, 1, outBack(clasp, 2.2)) * lerp(0.7, 1, e) * (1 + punch);
        msvg.style.transform = `rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(4)})`;
        // the open mark is the sealed indigo; shut, it is the ink of the wordmark
        msvg.style.color = clasp >= 1 ? "var(--ink)" : `color-mix(in srgb, var(--accent) ${(100 * (1 - clasp)).toFixed(0)}%, var(--ink))`;
        // a ring of light leaves the mark as it clasps
        const rp = clasp > 0 ? ramp(clasp, 0.15, 1) : 0;
        ring.style.opacity = (rp > 0 && rp < 1 ? (1 - rp) * 0.8 : 0).toFixed(3);
        ring.style.width = ring.style.height = (ms * lerp(1.0, 2.6, outCubic(rp))).toFixed(1) + "px";
        ring.style.transform = `translate(${(markX).toFixed(1)}px, 0) translate(-50%, -50%)`;
        // the name: each letter scrambles, then settles as the sweep passes it
        const x0 = -total / 2 + ms + gap;
        word.style.transform = `translate(${x0.toFixed(2)}px, -50%)`;
        const front = ramp(open, 0.32, 1) * (ww + 0.5 * size);
        letters.forEach((sp, i) => {
          const lxi = lx[i] ?? i * size * 0.5;
          const d = front - lxi;                         // how far the sweep is past this letter
          const on = clamp(d / (0.35 * size));
          setText(sp, d > 0.5 * size || open >= 1 ? WORD[i] : A.glyph(i * 11, t, 18, "abcdefghijkmnpqrstuvwxyz"));
          sp.style.opacity = clamp(on * 1.4).toFixed(3);
          sp.style.color = d > 0.5 * size ? "" : "var(--accent)";
        });
        const so = ramp(open, 0.32, 1), sw = so > 0 && so < 1;
        sweep.style.opacity = sw ? (Math.sin(Math.PI * so) * 0.95).toFixed(3) : 0;
        sweep.style.transform = `translate(${(x0 + front).toFixed(1)}px, -50%)`;
      },
    };
  }

  /* ====================================================================== *
   *  OPEN — the name. Glyphs spiral in from every edge and become the mark,
   *  which clasps shut as it does in the app's seal; the name decrypts.
   * ====================================================================== */
  /* points inside the mark (its 32-unit grid), for the glyphs to land on */
  function markPoints(step) {
    const c = document.createElement("canvas").getContext("2d");
    const path = new Path2D(A.MARK());
    const pts = [];
    for (let y = 0; y <= 32; y += step) for (let x = 0; x <= 32; x += step) {
      const jx = x + (rnd(x * 13.1 + y) - 0.5) * step * 0.6, jy = y + (rnd(y * 7.7 + x) - 0.5) * step * 0.6;
      if (c.isPointInPath(path, jx, jy, "evenodd")) pts.push([jx, jy]);
    }
    return pts;
  }
  /* glyphs from every edge that spiral in and land on the open mark of a lockup of `size` at (cx, cy);
     draw(t, t0, t1, fade) moves them from t0 to t1 and fades them as the mark takes their place */
  function swarm(parent, cx, cy, size) {
    const cv = el("canvas", "abs", parent);
    cv.width = 1920 * 2; cv.height = 1080 * 2;
    Object.assign(cv.style, { left: 0, top: 0, width: "1920px", height: "1080px", pointerEvents: "none" });
    const g = cv.getContext("2d");
    const MS = 1.37 * size, SC = (MS / 32) * 1.15, ROT = (-24 * Math.PI) / 180;
    const pts = markPoints(0.7).map(([x, y], i) => {
      const dx = (x - 16) * SC, dy = (y - 16) * SC, a = rnd(i * 3.1) * Math.PI * 2, r = 900 + rnd(i * 5.3) * 500;
      return { tg: [cx + dx * Math.cos(ROT) - dy * Math.sin(ROT), cy + dx * Math.sin(ROT) + dy * Math.cos(ROT)],
               src: [cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.6], i, d: rnd(i * 7.7) * 0.4, sw: (rnd(i * 2.2) - 0.5) * 2.4 };
    });
    return function draw(t, t0, t1, fade) {
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, 1920, 1080);
      if (t < t0 || fade >= 1) return;
      const span = t1 - t0;
      g.textAlign = "center"; g.textBaseline = "middle"; g.globalCompositeOperation = "lighter";
      pts.forEach((p) => {
        const s = t0 + p.d * span * 0.27;
        const u = inOutCubic(ramp(t, s, t1 + 0.05 + p.d * 0.3));
        const ang = p.sw * (1 - u);
        const dx = (p.src[0] - p.tg[0]) * (1 - u), dy = (p.src[1] - p.tg[1]) * (1 - u);
        const x = p.tg[0] + dx * Math.cos(ang) - dy * Math.sin(ang), y = p.tg[1] + dx * Math.sin(ang) + dy * Math.cos(ang);
        g.globalAlpha = clamp(ramp(t, s, s + 0.3) * (1 - fade)) * 0.9;
        g.fillStyle = u > 0.85 ? "#c9d6ff" : "#8FA9F0";
        g.font = `500 ${lerp(20, 8, u).toFixed(1)}px "Red Hat Mono"`;
        g.fillText(A.glyph(p.i, t, u > 0.9 ? 30 : 14), x, y);
      });
      g.globalCompositeOperation = "source-over";
    };
  }
  function open(cam, api) {
    const halo = bloom(cam, 960, 440, 1500, "rgba(70,96,160,0.32)");
    const flash = bloom(cam, 960, 440, 900, "rgba(170,195,255,0.55)");
    const sw = swarm(cam, 960, 440, 150);
    const wrap = at(cam, 960, 440, "");
    const lk = lockup(wrap, 150);
    const tag = at(cam, 960, 660, "headline soft");
    tag.style.fontSize = "50px";
    const tw = words(tag, "The secure way to share passwords, keys and files.");
    tw[1].style.color = "var(--accent)";
    const IN = 1.0, CLASP = IN + 0.3, OPEN0 = CLASP + 0.35, OPEN1 = OPEN0 + 0.9;
    api.grid("t0", CLASP);
    api.cue("swell", IN - 0.7, 0.6);
    api.cue("hit", CLASP, 1);
    api.cue("scramble", OPEN0 + 0.05, 0.45);
    api.cue("sweep", OPEN0, 0.35);
    return function (t) {
      camera(cam, t, [[0, 1.06, 0, 0], [CLASP, 1.0, 0, 0, 4]], 0.5);
      const solid = ramp(t, IN, IN + 0.3);
      sw(t, 0, IN, solid);
      const punch = t > CLASP ? Math.exp(-(t - CLASP) * 7) * 0.06 : 0;
      lk.set(t, { show: solid, clasp: ramp(t, CLASP - 0.06, CLASP + 0.42), open: ramp(t, OPEN0, OPEN1), punch });
      flash.style.opacity = (t > CLASP ? Math.exp(-(t - CLASP) * 3.0) : 0).toFixed(3);
      flash.style.transform = `scale(${(t > CLASP ? lerp(0.6, 1.4, outCubic(ramp(t, CLASP, CLASP + 0.8))) : 0.6).toFixed(3)})`;
      halo.style.opacity = (ramp(t, 0.2, IN) * (0.55 + 0.45 * (t > CLASP ? Math.exp(-(t - CLASP) * 1.2) : 1))).toFixed(3);
      kin(tw, t, api.on("brand1", "secure") - 0.45, 0.05, 0.6);
    };
  }

  /* ------------------------------------------------------------------ *
   *  the seal, as the app plays it when Create link is pressed (Home.tsx:
   *  lock, save, ready, then the page leaves). Here each step lasts as long
   *  as the voice explains it: the app's step texts ("Locking it on this
   *  device…", "Saving it…", "Link ready") are what the narration says.
   *  Its CSS animations are the app's own, seeked per frame.
   * ------------------------------------------------------------------ */
  const CIPHER = [TITLE, ...ENV.map(([k, v]) => `${k}  ${v}`)].join("\n");
  function sealDrive(B, t, T) {
    const step = t < T.S2 ? 1 : t < T.S3 ? 2 : 3;
    const over = B.$(".seal-over");
    if (!over) return;
    over.style.setProperty("--lock", ((T.S2 - T.S1) * 1000).toFixed(0) + "ms");
    over.style.setProperty("--save", ((T.S3 - T.S2) * 1000).toFixed(0) + "ms");
    setClass(over, "s1", step === 1); setClass(over, "s2", step === 2); setClass(over, "s3", step === 3);
    setText(over.querySelector(".seal-cipher"), T.enc ? CIPHER.split("\n").map((ln, i) => A.scramble(ln, t, T.enc[i], 0.4, i)).join("\n") : A.scramble(CIPHER, t, T.S1, 0.9));
    const mk = over.querySelector(".seal-mark");
    if (mk.dataset.step !== String(step)) {
      mk.dataset.step = step;
      mk.innerHTML = step === 1 ? mark("mark open") : step === 2 ? mark() : ic("check");
      const txt = step === 1 ? "Locking it on this device…" : step === 2 ? "Saving it…" : "Link ready";
      over.querySelector(".seal-txt").outerHTML = `<span class="seal-txt">${ic(step === 3 ? "check" : "lock", "sm")}${txt}</span>`;
      over.querySelectorAll(".seal-bar i").forEach((b, i) => { b.className = i + 1 < step ? "done" : i + 1 === step ? "now" : ""; });
    }
    const since = step === 1 ? T.S1 : step === 2 ? T.S2 : T.S3;
    B.seek(over, (name) => (name === "seal-fill" ? (t - since) * 1000
      : ["step-in", "seal-pop", "seal-ring"].includes(name) ? ((t - since) * 1000) / 1.6 : ((t - T.S1) * 1000) / 1.8));
  }

  const SERVER_IC = `<svg viewBox="0 0 24 24" class="ic"><rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>`;

  /* ------------------------------------------------------------------ *
   *  the link's own page in Your links (Receipt.tsx): status, facts, activity
   * ------------------------------------------------------------------ */
  // built when used, never at load: the icons are only there once the app's source is read
  const linkbox = () => `<div class="linkbox"><span class="url"><span>${linkHTML()}</span></span><button type="button" class="btn primary">${ic("copy", "sm")}Copy</button><button type="button" class="btn secondary icon">${ic("qr", "sm")}</button></div>`;
  function receiptPage(opened) {
    const [tone, icn] = opened ? ["ok", "check"] : ["info", "hourglass"];
    const status = opened ? `<span class="status opened"><i></i>Opened and destroyed</span>` : `<span class="status waiting"><i></i>Not opened yet</span>`;
    const facts = [["Opens", "Once"], opened ? ["Ended", "09:42 AM", "1 minute ago"] : ["Expires", "10:41 AM", "in 1 hour"], ["Contains", "3 fields"]];
    const ev = [`<li><span class="dot ink">${ic("check")}</span><span><b>Created on this device</b><small>Opens once · expires in 1 hour</small></span><time>09:41 AM</time></li>`];
    ev.push(opened ? `<li class="fresh"><span class="dot ok">${ic("check")}</span><span><b>Revealed</b><small>And deleted right away</small></span><time>09:42 AM</time></li>`
      : `<li class="pending"><span class="dot pending"></span><span><b>Waiting to be opened</b><small>Expires in 1 hour</small></span><span></span></li>`);
    const note = opened ? `<p class="rc-note">${ic("alert", "sm")}<span><b>Didn’t expect it to be opened yet?</b> Someone else may have the link. Change the password and send a new one.</span></p>` : "";
    return hdOwner("links", opened ? 2 : 3) + `<main class="main"><a class="btn sm ghost rc-back" href="#">${ic("back", "sm")}Your links</a>`
      + `<section class="card rc-hero"><div class="rc-head"><span class="rc-icon ${tone}">${ic(icn)}</span><div class="rc-titles">${status}`
      + `<div class="title-row"><h1 class="rc-title">${TITLE}</h1><button type="button" class="btn icon sm ghost">${ic("pencil", "sm")}</button></div><p class="rc-meta"><time>Sent 09:41 AM</time></p></div></div>`
      + (opened ? "" : `<div class="rc-link">${linkbox()}</div>`)
      + `<div class="facts rc-facts">${facts.map(([k, v, s]) => `<div><small>${k}</small><b>${v}</b>${s ? `<span>${s}</span>` : ""}</div>`).join("")}</div></section>`
      + `<section class="rc-activity"><div class="rc-sec-h"><h2 class="h3">Activity</h2>${opened ? "" : `<span class="rc-live"><i></i>Live</span>`}</div>`
      + `<div class="card"><div class="card-b"><ol class="events">${ev.join("")}</ol>${note}</div></div></section>`
      + `<div class="rc-actions"><span class="sp"></span><button class="btn secondary danger">${ic("trash", "sm")}Destroy</button></div></main>` + foot();
  }
  /* ------------------------------------------------------------------ *
   *  the recipient's pages (Reveal.tsx, Output.tsx)
   * ------------------------------------------------------------------ */
  function sealedPage(lifting) {
    return hdRecipient() + `<main class="main narrow"><section class="sealed"><div class="sealed-top tint${lifting ? " lifting" : ""}"><span class="seal-badge">${mark(lifting ? "mark open" : "mark")}Sealed</span></div>`
      + `<div class="sealed-body"><p class="from">Someone sent you</p><h1 class="h1">${TITLE}</h1><ul class="list"><li>${ic("key")}<span><b>3 fields</b></span></li>`
      + `<li>${ic("eye")}<span><b>Opens once.</b> After you reveal it, it’s gone for good.</span></li><li>${ic("clock")}<span>Available until Fri, Oct 30, 10:41 AM</span></li></ul>`
      + `<div class="actions-m"><button type="button" class="btn primary lg full">${ic("eye", "sm")}Reveal secret</button></div>`
      + `<p class="fine">It stays sealed until you press Reveal. Expecting something from this sender? Check that the address is <span class="mono">${HOST}</span>.</p></div></section></main>` + foot();
  }
  function openPage() {
    const rows = ENV.map(([k, v]) => `<div class="field"><span class="k">${k}</span><span class="v${k === "DB_PASSWORD" ? " secret" : ""}">${k === "DB_PASSWORD" ? "••••••••••••" : v}</span>`
      + `<span class="acts">${k === "DB_PASSWORD" ? `<button class="btn icon sm ghost">${ic("eye", "sm")}</button>` : ""}<button class="btn icon sm ghost">${ic("copy", "sm")}</button></span></div>`).join("");
    return hdRecipient() + `<main class="main narrow"><div class="banner ok">${ic("check")}<span>The link no longer works. Save what you need before you leave this page.</span><span class="sp"></span><span class="timer">Clears in 5:00</span></div>`
      + `<section class="out reveal-in anim"><div class="out-h"><h1 class="h3">${TITLE}</h1></div>${rows}</section>`
      + `<div class="actions-m between"><div class="row"><button type="button" class="btn secondary">${ic("copy", "sm")}Copy all as .env</button></div><button type="button" class="btn danger hide-m">${ic("eyeoff", "sm")}Clear now</button></div>`
      + `<p class="fine">Copied values stay in your clipboard. Paste them into your password manager.</p></main>` + foot();
  }
  function gonePage() {
    return hdRecipient() + `<main class="main narrow"><section class="sealed"><div class="sealed-body"><span class="status warn"><i></i>Already opened</span><h1 class="h1">This secret was opened on Fri, Oct 30, 09:42 AM</h1>`
      + `<p class="lede">It could be opened only once. If that wasn’t you, someone else may have seen it.</p><div class="banner warn">${ic("alert")}<span>Tell the sender so they can change the password and send a new link.</span></div>`
      + `<div class="row"><a class="btn secondary" href="#">Go to Cryptex</a></div></div></section></main>` + foot();
  }

  /* ------------------------------------------------------------------ *
   *  asking for a secret (AskDialog.tsx, LinkReady.tsx, Answer.tsx)
   * ------------------------------------------------------------------ */
  const NOTE = "Hi Sam! Could you send me the staging SSH key? — Maya";
  function askPage(note, caret) {
    return sendPage({}).replace(`<div class="page-acts"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button></div>`,
      `<div class="page-acts"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button>`
      + `<div class="scrim" style="z-index: 31;"><div class="dialog wide"><div class="dialog-b"><div class="stack ask-dialog"><h2 class="h3">Ask for a secret</h2><p class="muted">Make a link and send it to someone. What they put in it is encrypted for you, and only you can open it.</p>`
      + `<div><label class="label">Note for them<span class="opt-tag">Optional</span></label><textarea class="input textarea focus" rows="3">${note}</textarea><p class="help">Say who you are and what you need. Anyone with the link can read it.</p></div>`
      + `<div class="stack" style="gap: 8px;"><span class="label">Expires after</span><div class="choices"><button type="button" class="choice">1 hour</button><button type="button" class="choice on">1 day</button><button type="button" class="choice">7 days</button><button type="button" class="choice">Custom</button></div><p class="help">The link and its answer expire together.</p></div></div></div>`
      + `<div class="dialog-f"><button type="button" class="btn secondary">Cancel</button><button type="button" class="btn primary create-req">${ic("link", "sm")}Create request link</button></div></div></div></div>`);
  }

  function askReadyPage() {
    return hdOwner("links", 3) + `<main class="main send-page arrive anim"><div class="stack" style="gap: 10px;"><span class="copied">${ic("check")}Request link copied</span><h1 class="h1">Your request link is ready</h1><span class="status waiting"><i></i>Waiting for an answer</span></div>`
      + `<div class="stack" style="gap: 10px;"><div class="linkbox"><span class="url"><span>${linkHTML("a", "wmDntvggVs", "IiezRO0wMgQ71gtJk7YAlA")}</span></span><button type="button" class="btn primary">${ic("copy", "sm")}Copy</button><button type="button" class="btn secondary icon">${ic("qr", "sm")}</button></div><p class="muted small">Send it to the person who has the secret. They don’t need an account, and they can answer once.</p></div>`
      + `<div class="facts"><div><small>Request code</small><b>GS9-HDJ</b></div><div><small>Expires</small><b>Sat, Oct 31, 09:43 AM</b><span>tomorrow</span></div></div>`
      + `<div class="actions-m between"><button type="button" class="btn danger hide-m">${ic("trash", "sm")}Destroy</button><div class="row"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button><button type="button" class="btn primary">Done</button></div></div></main>` + foot();
  }
  const SSH = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----";
  function answerPage(text) {
    const filled = !!text;
    return hdRecipient() + `<main class="main send-page"><div class="send-head has-note"><h1 class="h1">Someone is asking you for a secret</h1><p class="lede">Put it below. It’s encrypted on this device before it’s sent.</p>`
      + `<figure class="ask-said"><figcaption>${ic("user", "sm")}From the person asking</figcaption><blockquote>${NOTE}</blockquote></figure></div>`
      + `<section class="composer${filled ? " focus" : ""}">` + (filled
        ? `<div class="cmp-title"><input class="t" placeholder="Add a title (optional)"><div class="hint-wrap"><p class="hint">${ic("eye", "sm")}Shown to them before they open it.</p></div></div><div class="cmp-note"><textarea class="note-area" rows="1" style="height: 102px;">${text}</textarea></div>`
        : `<div class="cmp-empty"><textarea class="ph-area" rows="1" placeholder="Type or paste a password, a login, a private note…" style="height: 140px;"></textarea></div>`)
      + `<div class="cmp-bar"><button type="button" class="btn sm ghost">${ic("clip", "sm")}Attach files</button><button type="button" class="btn sm ghost">${ic("plus", "sm")}Add field</button><span class="cmp-end">`
      + (filled ? `<span class="detected counter">${text.length} / 10,000 characters</span>` : "")
      + `<span class="cmp-go"><button type="button" class="btn primary send-sec"${filled ? "" : ' aria-disabled="true"'}>${ic("lock", "sm")}Send securely</button></span></span></div></section>`
      + `<ul class="list ask-facts"><li>${ic("lock")}<span>Encrypted on this device. Only the person who asked can open it, not even ${HOST}.</span></li><li>${ic("clock")}<span>You can answer until Sat, Oct 31, 09:43 AM.</span></li></ul></main>`;
  }
  function answerSentPage() {
    return hdRecipient() + `<main class="main narrow"><section class="outcome"><div class="outcome-top tint"><span class="outcome-icon ok">${ic("check", "lg")}</span></div>`
      + `<div class="outcome-body"><h1 class="h2">Sent</h1><div class="outcome-text"><p>It’s encrypted for the person who asked, and nobody else. You can close this page.</p></div></div></section></main>`;
  }



  /* ------------------------------------------------------------------ *
   *  the film's grammar: one big line of type at the left, the product
   *  large at the right, bleeding off the frame
   * ------------------------------------------------------------------ */
  function bigtype(layer, text, acc = [], { x = 110, y = 540, size = 120, center = false } = {}) {
    const n = center ? at(layer, x, y, "headline big") : el("div", "abs headline big", layer);
    if (!center) Object.assign(n.style, { left: x + "px", top: y + "px", transform: "translateY(-50%)" });
    n.style.fontSize = size + "px";
    const ws = [];
    text.split("\n").forEach((line, i) => { if (i) el("br", "", n); ws.push(...words(n, line)); });
    acc.forEach((i) => { ws[i].style.color = "var(--accent)"; });
    return ws;
  }
  const PLAIN = [TITLE, ...ENV.map(([k, v]) => `${k}=${v}`)];

  /* ====================================================================== *
   *  SEND — one continuous shot of the app: paste, choose how long it
   *  lasts, create the link; the camera follows the hand
   * ====================================================================== */
  function send(cam, api) {
    const B = browser(cam, { x: 250, y: 110, w: 1420, h: 900, zoom: 1.18 });
    const clip = at(cam, 0, 0, "clip", ENV.map(([k, v]) => `<span class="k">${k}</span>=${k === "DB_PASSWORD" ? `"${v}"` : v}`).join("\n"));
    const kcap = at(cam, 0, 0, "keycap", "⌘ V");
    const cur = pointer(cam);

    const PASTE = api.on("send1", "paste") + 0.25, FIELDS = PASTE + 0.35, TY = FIELDS + 0.3, RATE = 0.03;
    const CHANGE = api.on("send1", "choose") + 0.05, HOUR = api.on("send1", "lasts") + 0.05, ONCE = HOUR + 0.6;
    const GO = api.on("send2", "create") + 0.1;
    const T = { S1: GO + 0.05 };
    T.S2 = T.S1 + 1.0; T.S3 = T.S2 + 0.55; T.LEAVE = T.S3 + 0.7; T.ARRIVE = T.LEAVE + 0.32;
    api.cue("key", PASTE - 0.02, 0.6); api.cue("key", PASTE + 0.05, 0.5);
    api.cue("whoosh", PASTE + 0.08, 0.3);
    ENV.forEach((_, i) => api.cue("pop", FIELDS + 0.04 + i * 0.08, 0.32));
    for (let i = 0; i < TITLE.length; i += 2) api.cue("key", TY + i * RATE, 0.18);
    api.cue("click", CHANGE, 0.6); api.cue("click", HOUR, 0.6); api.cue("tick", ONCE, 0.8);
    api.cue("click", GO, 0.8);
    api.cue("scramble", T.S1 + 0.02, 0.7); api.cue("sweep", T.S1 + 0.1, 0.5);
    api.cue("clasp", T.S2, 0.9); api.cue("chime", T.S3, 0.7);

    let P = { change: [1300, 860], hour: [1100, 700], once: [1000, 800], go: [1600, 700], comp: [960, 560], panel: [960, 700], box: [960, 500] }, SCR = 0;
    afterFonts(() => {
      B.html(sendPage({ fields: 3, title: TITLE, options: true }));
      SCR = Math.max(0, B.$(".panel").getBoundingClientRect().bottom + 40 - B.h);
      P.hour = B.at(".choice:nth-child(1)", 0.5, 0.55); P.once = B.at(".panel .check input", 0.5, 0.5); P.go = B.at("#send-go", 0.45, 0.55);
      P.panel = B.at(".panel", 0.5, 0.42);
      B.html(sendPage({ fields: 3, title: TITLE }));
      P.change = B.at(".change", 0.45, 0.55); P.comp = B.at(".composer", 0.5, 0.5);
      B.html(sentPage()); P.box = B.at(".linkbox", 0.5, 0.5);
    });

    return function (t) {
      // in on the composer as it fills, down to the options, over to Create link, back to the link
      camera(cam, t, [aim(0, 1.0, [960, 560], [960, 545]), aim(PASTE - 0.7, 1.24, P.comp, [960, 560], 1.1),
        aim(CHANGE + 0.05, 1.2, [P.panel[0], P.panel[1] - SCR], [960, 560], 1.1),
        aim(ONCE + 0.45, 1.3, P.comp, [960, 590], 1.1),
        aim(T.ARRIVE - 0.1, 1.22, P.box, [960, 520], 1.1)], 0.4);
      reveal(B.win, ramp(t, -0.2, 0.5), { dy: 40, scale: 0.98 });
      if (t < T.S1) {
        const st = { fields: t >= FIELDS ? 3 : 0, focus: t < CHANGE - 0.1, title: typed(TITLE, t, TY, RATE), options: t >= CHANGE && t < ONCE + 0.7, hour: t >= HOUR, once: t >= ONCE };
        B.html(sendPage(st));
        if (st.fields) B.$$(".field").forEach((f, i) => { const p = outQuint(ramp(t, FIELDS + i * 0.08, FIELDS + i * 0.08 + 0.35)); f.style.opacity = p.toFixed(3); f.style.transform = `translateY(${(10 * (1 - p)).toFixed(1)}px)`; });
        B.scroll(SCR * inOutCubic(ramp(t, CHANGE + 0.05, CHANGE + 0.55)) * (1 - inOutCubic(ramp(t, ONCE + 0.3, ONCE + 0.8))));
      } else if (t < T.ARRIVE) {
        B.html(sendPage({ fields: 3, title: TITLE, once: true, hour: true, seal: true }));
        if (t >= T.LEAVE) { const m = B.$("main"); setClass(m, "leaving", true); setClass(m, "anim", true); B.seek(m, (t - T.LEAVE) * 1000); }
        sealDrive(B, t, T);
        B.scroll(0);
      } else {
        B.html(sentPage()); B.seek(B.$("main"), (t - T.ARRIVE) * 1000); B.scroll(0);
      }
      // the clipboard drops into the composer
      clip.parentElement.style.left = P.comp[0] + "px"; clip.parentElement.style.top = P.comp[1] - 10 + "px";
      kcap.parentElement.style.left = P.comp[0] + 300 + "px"; kcap.parentElement.style.top = P.comp[1] - 130 + "px";
      const cp = ramp(t, PASTE - 0.7, PASTE - 0.35), flyIn = inCubic(ramp(t, PASTE + 0.05, FIELDS));
      reveal(clip, cp, { dy: 30, alpha: 1 - flyIn, base: `translateY(${(-50 * flyIn).toFixed(1)}px) scale(${lerp(1, 0.7, flyIn).toFixed(3)})` });
      reveal(kcap, ramp(t, PASTE - 0.6, PASTE - 0.3) * (1 - ramp(t, PASTE + 0.2, PASTE + 0.45)), { dy: 16, base: `translateY(${(4 * Math.sin(Math.PI * ramp(t, PASTE - 0.06, PASTE + 0.12))).toFixed(1)}px)` });
      const off = (p, s) => [p[0], p[1] - s];
      const pos = path([[CHANGE - 0.9, P.change[0] + 220, P.change[1] + 160], [CHANGE - 0.05, ...P.change], [HOUR - 0.05, ...off(P.hour, SCR)],
        [ONCE - 0.05, ...off(P.once, SCR)], [GO - 0.05, ...P.go], [GO + 0.8, P.go[0] + 110, P.go[1] + 130]])(t);
      cur(t, pos, [CHANGE, HOUR, ONCE, GO], ramp(t, CHANGE - 0.9, CHANGE - 0.6) * (1 - ramp(t, GO + 0.4, GO + 0.8)));
    };
  }

  /* ====================================================================== *
   *  KEY — the one idea: the key is in the link, so the server can't read it
   * ====================================================================== */
  function vcard(parent, x, y, head, cls) {
    const n = at(parent, x, y, "vcard " + cls, `<div class="vh">${head}</div>` + PLAIN.map(() => `<div class="vl"></div>`).join(""));
    return { n, lines: [...n.querySelectorAll(".vl")] };
  }
  function key(cam, api) {
    const layer = api.layer;
    api.grid("tense", 0);
    const t1 = bigtype(layer, "Encrypted on your device.", [0], { x: 960, y: 300, size: 96, center: true });
    const t2 = bigtype(layer, "The key stays in the link.", [1], { x: 960, y: 300, size: 96, center: true });
    const t3 = bigtype(layer, "Your server can’t read it.", [3], { x: 960, y: 250, size: 96, center: true });
    const HP = `${HOST}/s/${ID}`, FR = `#${KEY}`;
    const hero = at(cam, 960, 610, "biglink", `<span class="h"></span><span class="frag"></span>`);
    const hp = hero.querySelector(".h"), fr = hero.querySelector(".frag");
    const ktag = at(cam, 0, 0, "tag acc big", `${ic("key")}The key`);
    const L = vcard(cam, 530, 640, `${ic("user")}<span>What you send</span>`, "plain");
    const R = vcard(cam, 1390, 640, `${SERVER_IC}<span>What your server stores</span>`, "noise");

    const KEYT = api.on("key2", "key") - 0.15;
    const SPLIT = api.on("key2", "server") - 0.45;
    api.cue("scramble", 0.15, 0.6); api.cue("swell", KEYT - 0.4, 0.5); api.cue("hit", KEYT + 0.05, 0.5);
    api.cue("whoosh", SPLIT, 0.4); api.cue("pop", SPLIT + 0.25, 0.4); api.cue("pop", SPLIT + 0.45, 0.4);
    api.cue("deny", api.on("key2", "read") + 0.05, 0.35);
    afterFonts(() => {
      setText(hp, HP); setText(fr, FR);
      const c = cam.getBoundingClientRect(), r = fr.getBoundingClientRect();
      ktag.parentElement.style.left = r.left - c.left + r.width / 2 + "px"; ktag.parentElement.style.top = r.bottom - c.top + 70 + "px";
    });

    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [0, 1.0, 0, 0, api.dur]], 0.4);
      kin(t1, t, api.segStart("key1") - 0.25, 0.06, 0.5, KEYT - 0.5);
      kin(t2, t, KEYT - 0.2, 0.06, 0.5, SPLIT - 0.1);
      kin(t3, t, SPLIT + 0.2, 0.06, 0.5);
      // the link resolves out of noise, then its key lifts out and glows
      const out = inOutCubic(ramp(t, SPLIT - 0.2, SPLIT + 0.3));
      reveal(hero, ramp(t, 0.0, 0.4) * (1 - out), { dy: 0, scale: 0.94, base: `translateY(${(-60 * out).toFixed(1)}px)` });
      setText(hp, A.decrypt(HP, t, 0.15, 0.9, 3));
      setText(fr, A.decrypt(FR, t, 0.55, 0.9, 5));
      const lift = spring(ramp(t, KEYT, KEYT + 0.9) * 1.3, 8, 5.5);
      fr.style.transform = `translateY(${(-26 * lift).toFixed(1)}px) scale(${lerp(1, 1.06, lift).toFixed(3)})`;
      fr.style.setProperty("--hi", clamp(lift).toFixed(3));
      hp.style.opacity = lerp(1, 0.35, ramp(t, KEYT, KEYT + 0.5)).toFixed(3);
      reveal(ktag, ramp(t, KEYT + 0.25, KEYT + 0.7) * (1 - out), { dy: 14 });
      // what you send, and what your server stores
      reveal(L.n, ramp(t, SPLIT + 0.2, SPLIT + 0.7), { dy: 40 });
      reveal(R.n, ramp(t, SPLIT + 0.4, SPLIT + 0.9), { dy: 40 });
      L.lines.forEach((l, i) => setText(l, PLAIN[i]));
      R.lines.forEach((l, i) => setText(l, A.scramble(PLAIN[i], t, -99, 0.01, i + 2)));
    };
  }

  /* ====================================================================== *
   *  REVEAL — it opens once; then it's gone
   * ====================================================================== */
  function reveal_(cam, api) {
    const layer = api.layer;
    const tA = bigtype(layer, "Opens once.", [1]);
    const tB = bigtype(layer, "Then it’s gone.", [2]);
    const PH = phone(cam, { x: 1060, y: 50, w: 470, h: 980 });
    const scr = PH.phone.querySelector(".scr");
    const light = el("div", "abs sweeplight", scr);
    const flash = el("div", "abs", scr); Object.assign(flash.style, { inset: 0, background: "#fff", zIndex: 8, opacity: 0 });
    const tap = tapper(cam);
    const TAP = api.snap(api.on("open1", "opens") + 0.05);
    api.grid("drop", TAP);
    const OPEN = TAP + 0.35, GONE = api.segStart("open2") - 0.3;
    api.cue("tap", TAP, 1); api.cue("unseal", TAP + 0.02, 0.9);
    api.cue("poof", GONE, 0.7); api.cue("deny", GONE + 0.25, 0.5);
    let P = [1295, 800];
    afterFonts(() => { PH.html(sealedPage(false)); P = PH.at(".btn.primary.lg", 0.5, 0.5); });
    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0], [0, 1.03, -10, 0, api.dur]], 0.4);
      reveal(PH.phone, ramp(t, -0.15, 0.5), { dy: 70 });
      PH.sleep.style.opacity = 0;
      kin(tA, t, api.segStart("open1") - 0.25, 0.06, 0.5, GONE - 0.35);
      kin(tB, t, GONE - 0.1, 0.06, 0.5);
      if (t < OPEN) PH.html(sealedPage(t >= TAP));
      else if (t < GONE) { PH.html(openPage()); PH.seek(PH.$(".out"), (t - OPEN) * 1000); }
      else PH.html(gonePage());
      tap(t, P, TAP);
      const lp = ramp(t, OPEN - 0.1, OPEN + 0.6);
      light.style.opacity = lp > 0 && lp < 1 ? Math.sin(Math.PI * lp).toFixed(3) : 0;
      light.style.transform = `translateY(${lerp(-100, 110, inOutCubic(lp)).toFixed(1)}%)`;
      // gone: a white blink, and the phone settles on the page that says so
      flash.style.opacity = (t >= GONE ? 0.5 * Math.exp(-(t - GONE) * 9) : 0).toFixed(3);
      const k = t >= GONE ? Math.exp(-(t - GONE) * 6) * Math.sin((t - GONE) * 40) * 8 : 0;
      PH.phone.style.marginLeft = k.toFixed(1) + "px";
    };
  }

  /* ====================================================================== *
   *  TRACK — the link's own page: you know the moment it's opened
   * ====================================================================== */
  function track(cam, api) {
    const layer = api.layer;
    const t1 = bigtype(layer, "Know when\nit’s opened.", [3], { size: 104 });
    const B = browser(cam, { x: 740, y: 120, w: 1120, h: 1020, zoom: 1.42, url: [HOST, "/r/" + ID] });
    const OPENED = api.on("track1", "opened") - 0.2;
    api.cue("pop", OPENED, 0.7); api.cue("chime", OPENED + 0.05, 0.4);
    let SCR = 0;
    afterFonts(() => { B.html(receiptPage(false)); SCR = Math.max(0, B.$(".rc-back").getBoundingClientRect().top - 30); });
    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0], [0, 1.03, -20, -6, api.dur]], 0.4);
      reveal(B.win, ramp(t, -0.15, 0.5), { dy: 50 });
      kin(t1, t, api.segStart("track1") - 0.3, 0.06, 0.5);
      B.html(receiptPage(t >= OPENED)); B.scroll(SCR);
      const fresh = B.$(".events li.fresh"), st = B.$(".rc-titles .status");
      if (fresh) {
        const hi = Math.exp(-Math.max(0, t - OPENED) * 0.9);
        fresh.style.borderRadius = "12px";
        fresh.style.opacity = outCubic(ramp(t, OPENED, OPENED + 0.35)).toFixed(3);
        fresh.style.background = `rgba(79,194,133,${(0.08 + 0.14 * hi).toFixed(3)})`;
        fresh.style.boxShadow = `0 0 0 ${(8 * hi).toFixed(1)}px rgba(79,194,133,${(0.14 * hi).toFixed(3)})`;
        st.style.transformOrigin = "0 50%"; st.style.transform = `scale(${lerp(0.8, 1, spring(ramp(t, OPENED, OPENED + 0.5) * 1.3, 12, 5)).toFixed(3)})`;
      }
    };
  }

  /* ====================================================================== *
   *  ASK — a link for someone else to fill in; only you can open it.
   *  Maya asks in the real dialog; Sam answers on their phone.
   * ====================================================================== */
  function ask(cam, api) {
    const layer = api.layer;
    const tA = bigtype(layer, "Ask for\na secret.", [3]);
    const tB = bigtype(layer, "Only you\ncan open it.", [0, 1]);
    const B = browser(cam, { x: 740, y: 120, w: 1120, h: 1020, zoom: 1.3 });
    const PH = phone(cam, { x: 1110, y: 50, w: 470, h: 980 });
    const cur = pointer(cam), tap = tapper(cam);

    const NOTE0 = api.on("ask1", "need") + 0.05, NRATE = 0.022;
    const CREATE = api.on("ask1", "request") + 0.15, READY = CREATE + 0.2;
    const SWAP = api.segStart("ask2") - 0.55;                         // from Maya's window to Sam's phone
    const FILL = SWAP + 0.75, SEND = api.on("ask2", "encrypted") + 0.05, SENT = SEND + 0.4;
    for (let i = 0; i < NOTE.length; i += 2) api.cue("key", NOTE0 + i * NRATE, 0.16);
    api.cue("click", CREATE, 0.7); api.cue("chime", READY + 0.1, 0.4);
    api.cue("whoosh", SWAP, 0.35); api.cue("pop", FILL, 0.4);
    api.cue("tap", SEND, 0.8); api.cue("clasp", SEND + 0.15, 0.6); api.cue("chime", SENT + 0.1, 0.5);

    let P = [1500, 900], Q = [1340, 760];
    afterFonts(() => {
      B.html(askPage(NOTE)); P = B.at(".create-req", 0.5, 0.55);
      PH.html(answerPage(SSH)); Q = PH.at(".send-sec", 0.5, 0.5);
    });
    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0], [0, 1.03, -18, -6, api.dur]], 0.4);
      kin(tA, t, api.segStart("ask1") - 0.25, 0.06, 0.5, SWAP - 0.1);
      kin(tB, t, api.segStart("ask2") - 0.1, 0.06, 0.5);
      // Maya: the dialog, her note, the request link
      const out = inOutCubic(ramp(t, SWAP, SWAP + 0.6));
      reveal(B.win, ramp(t, -0.2, 0.5) * (1 - out), { dy: 40, base: `translateX(${(-80 * out).toFixed(1)}px)` });
      B.win.style.display = out >= 1 ? "none" : "";
      if (t < READY) B.html(askPage(typed(NOTE, t, NOTE0, NRATE)));
      else { B.html(askReadyPage()); B.seek(B.$("main"), (t - READY) * 1000); }
      const pos = path([[CREATE - 0.8, P[0] + 140, P[1] + 160], [CREATE - 0.05, ...P], [CREATE + 0.7, P[0] + 100, P[1] + 120]])(t);
      cur(t, pos, [CREATE], ramp(t, CREATE - 0.8, CREATE - 0.5) * (1 - ramp(t, CREATE + 0.4, CREATE + 0.7)));
      // Sam: the request, the key pasted in, sent
      const pin = inOutCubic(ramp(t, SWAP + 0.15, SWAP + 0.8));
      reveal(PH.phone, pin, { dy: 0, base: `translateX(${(90 * (1 - pin)).toFixed(1)}px)` });
      PH.sleep.style.opacity = 0;
      if (t < SENT) PH.html(answerPage(t >= FILL ? SSH : ""));
      else { PH.html(answerSentPage()); }
      tap(t, Q, SEND);
    };
  }

  /* ====================================================================== *
   *  SELF-HOST — free, open source, yours to run
   * ====================================================================== */
  function selfhost(cam, api) {
    bloom(cam, 1400, 540, 1300, "rgba(70,96,160,0.22)");
    const h1 = el("div", "abs headline", cam); Object.assign(h1.style, { left: "110px", top: "352px", fontSize: "84px" });
    const h1w = words(h1, "Free and open source.");
    const h2 = el("div", "abs headline", cam); Object.assign(h2.style, { left: "110px", top: "462px", fontSize: "84px", color: "var(--accent)" });
    const h2w = words(h2, "Run your own.");
    const sub = el("div", "abs meta", cam, `MIT License<b>·</b><span class="mono" style="color:var(--ink-2)">github.com/polius/Cryptex</span>`);
    Object.assign(sub.style, { left: "113px", top: "600px", fontSize: "30px" });
    const TM = el("div", "term", cam);
    Object.assign(TM.style, { left: "1060px", top: "330px", width: "760px", height: "400px" });
    TM.innerHTML = `<div class="tb"><i></i><i></i><i></i><div class="ttl">you@server — zsh</div></div><div class="body"></div>`;
    const body = TM.querySelector(".body");
    const CMD = 'docker run -d \\\n  -p 127.0.0.1:8080:8080 \\\n  -v "$PWD/data:/data" \\\n  poliuscorp/cryptex';
    const OUT = [["d", "Status: Downloaded newer image"], ["ok", "→ open http://localhost:8080"]];
    const RATE = 0.02, c0 = api.on("self1", "open") + 0.3, RUN = Math.max(c0 + CMD.length * RATE + 0.12, api.on("self2", "command") + 0.05);
    for (let i = 0; i < CMD.length; i += 3) api.cue("key", c0 + i * RATE, 0.2);
    api.cue("enter", RUN, 0.8);
    OUT.forEach((_, i) => api.cue("tick", RUN + 0.3 + i * 0.25, 0.4));
    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [0, 1.0, 0, 0, api.dur]], 0.4);
      kin(h1w, t, api.segStart("self1") - 0.3, 0.07, 0.55);
      kin(h2w, t, api.on("self2", "own") - 0.35, 0.07, 0.55);
      reveal(sub, ramp(t, api.on("self1", "open"), api.on("self1", "open") + 0.5), { dy: 14 });
      reveal(TM, ramp(t, -0.1, 0.6), { dy: 50, scale: 0.96 });
      const glow = t > RUN ? Math.exp(-(t - RUN) * 4) : 0;
      TM.style.boxShadow = `0 60px 120px -40px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.13), 0 0 ${(70 * glow).toFixed(0)}px rgba(79,194,133,${(0.3 * glow).toFixed(3)})`;
      let html = typed(CMD, t, c0, RATE).split("\n").map((ln, i) => `<div>${i === 0 ? '<span class="p">$ </span>' : ""}${ln.replace(/</g, "&lt;")}</div>`).join("");
      if (t < RUN) html = html.replace(/<\/div>$/, `${blink(t, 0.9) ? '<span class="caret"></span>' : ""}</div>`);
      OUT.forEach(([c, x], i) => { if (t >= RUN + 0.3 + i * 0.25) html += `<div class="${c}">${x}</div>`; });
      setHTML(body, html);
    };
  }

  /* ====================================================================== *
   *  OUTRO — the name, the promise, where to get it
   * ====================================================================== */
  const GITHUB = `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.25-1.28-5.25-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.27 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>`;
  function outro(cam, api) {
    const halo = bloom(cam, 960, 400, 1500, "rgba(70,96,160,0.28)");
    const flash = bloom(cam, 960, 400, 800, "rgba(170,195,255,0.5)");
    const sw = swarm(cam, 960, 400, 130);
    const wrap = at(cam, 960, 400, "");
    const lk = lockup(wrap, 130);
    const tag = at(cam, 960, 610, "headline");
    tag.style.fontSize = "64px";
    const tw = words(tag, "Share a secret. Keep it secret.");
    const pill = at(cam, 960, 750, "pill", `${GITHUB}<span>github.com/polius/Cryptex</span>`);
    const meta = at(cam, 960, 850, "meta", `docker run poliuscorp/cryptex<b>·</b>MIT License`);
    const s1 = api.segStart("outro2");
    const CLASP = api.segStart("outro1") - 0.25, IN = CLASP - 0.45, OPEN0 = CLASP + 0.3, OPEN1 = OPEN0 + 0.8, SW0 = Math.max(0, IN - 2.1);   // the glyphs are already moving as the cut lands
    api.cue("swell", IN - 0.6, 0.5);
    api.cue("hit", CLASP, 0.85);
    api.cue("scramble", OPEN0 + 0.05, 0.45);
    api.cue("sweep", OPEN0, 0.35);
    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [CLASP, 1.0, 0, 0, 4]], 0.5);
      const solid = ramp(t, IN, IN + 0.3);
      sw(t, SW0, IN, solid);
      const punch = t > CLASP ? Math.exp(-(t - CLASP) * 7) * 0.05 : 0;
      lk.set(t, { show: solid, clasp: ramp(t, CLASP - 0.06, CLASP + 0.42), open: ramp(t, OPEN0, OPEN1), punch });
      flash.style.opacity = (t > CLASP ? Math.exp(-(t - CLASP) * 3.0) : 0).toFixed(3);
      halo.style.opacity = (0.5 + 0.5 * (t > CLASP ? Math.exp(-(t - CLASP) * 1.2) : ramp(t, IN, CLASP))).toFixed(3);
      kin(tw, t, s1 - 0.1, 0.06, 0.6);
      reveal(pill, ramp(t, s1 + 1.0, s1 + 1.5), { dy: 24, scale: 0.96 });
      reveal(meta, ramp(t, s1 + 1.3, s1 + 1.8), { dy: 14 });
    };
  }

  /* the README poster: the composer, filled in and set to open once, in a window on the film's paper */
  window.POSTER = async function (stage) {
    document.getElementById("scenes").style.display = "none";
    const layer = el("div", "layer", stage);
    layer.style.zIndex = 50;
    const B = browser(layer, { x: 170, y: 64, w: 1580, h: 952, zoom: 1.24 });
    await B.ready;
    B.html(sendPage({ fields: 3, title: TITLE, once: true, hour: true }));
  };

  Object.assign(window.SCENES, { open, send, key, reveal: reveal_, track, ask, selfhost, outro });
})();
