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
      const p = ramp(t, when - 0.25, when + 0.3);
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
  function phone(parent, { x, y, w = 420, h = 876, clock = "9:41" }) {
    const P = el("div", "phone", parent);
    Object.assign(P.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
    const scr = el("div", "scr", P);
    el("div", "bar", scr, `<span>${clock}</span><span style="letter-spacing:2px">●●● ▮</span>`);
    el("div", "island", scr);
    const sw = w - 26;
    const B = appFrame(scr, { x: 0, y: 50, w: sw, h: h - 26 - 50, zoom: sw / 390, ox: x + 13, oy: y + 13 });
    B.phone = P;
    B.sleep = el("div", "sleep", scr);
    return B;
  }

  /* whose screen this is, above a phone: the person on the other end */
  const PHONE_X = 1150;
  const deviceTag = (parent, x, y, text = "Their phone") => at(parent, x, y, "tag devtag", `${ic("user", "sm")}${text}`);

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
        + `<div class="items">${rows}</div>` + cmpBar(true, true, !o.seal) + (o.seal ? SEAL_OVER : "") + `</section>`;
    }
    const ruleFoot = (live, change) => `<div class="send-foot"><div class="rule${live ? " live" : ""}">${rule}${change ? `<button type="button" class="btn sm ghost change">${ic("sliders", "sm")}Change</button>` : ""}</div></div>`;
    const below = o.seal ? ruleFoot(false, false) : o.options
      ? `<section class="panel"><div class="panel-h"><span class="h3">Link options</span><button type="button" class="btn sm ghost">Done</button></div>`
        + `<div class="opt"><span class="lbl">Expires after</span><div><div class="choices"><button type="button" class="choice${o.hour ? " on" : ""}">1 hour</button><button type="button" class="choice${o.hour ? "" : " on"}">1 day</button><button type="button" class="choice">7 days</button><button type="button" class="choice">Custom</button></div></div></div>`
        + `<div class="opt"><span class="lbl">One-time link</span><label class="check"><input type="checkbox"${once ? " checked" : ""}><span><b>Destroy it after it’s opened</b><small>${once ? "It opens once, then it’s deleted for good." : "Anyone with the link can open it, as often as they like, until it expires."}</small></span></label></div>`
        + `<div class="opt"><span class="lbl">Passphrase</span><div class="stack" style="gap: 12px;"><label class="check"><input type="checkbox"><span><b>Ask for a passphrase</b><small>They type it to open the link. Tell it to them another way, like on a call.</small></span></label></div></div></section>` + ruleFoot(false, true)
      : ruleFoot(true, true);
    return hdOwner("new", 3) + `<main class="main send-page"><div class="send-head"><div class="head-row"><h1 class="h1">Send a secret</h1>`
      + (o.seal ? "" : `<div class="page-acts"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button></div>`) + `</div>`
      + `<p class="lede">${lede}</p></div>${body}${below}</main>` + foot();
  }
  function cmpBar(filled, env, go = true) {
    return `<div class="cmp-bar"><button type="button" class="btn sm ghost">${ic("clip", "sm")}Attach files</button><button type="button" class="btn sm ghost">${ic("plus", "sm")}Add field</button>`
      + `<button type="button" class="btn sm ghost cmp-expand">${ic("expand", "sm")}<span class="cmp-expand-l">Expand</span></button><span class="cmp-end">`
      + (env ? `<span class="detected">${ic("scan", "sm")}Read as a .env file · <button type="button" class="link">Undo</button></span>` : `<span class="detected drop-only">Or drop files here</span>`)
      + (go ? `<span class="cmp-go"><button type="button" class="btn primary" id="send-go"${filled ? "" : ' aria-disabled="true"'}>${ic("link", "sm")}Create link</button></span>` : "") + `</span></div>`;
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
    tag.style.fontSize = "56px";
    const tw = words(tag, "Share passwords and logins from your own server.");
    tw[6].style.color = tw[7].style.color = "var(--accent)";
    const IN = 0.7, CLASP = IN + 0.3, OPEN0 = CLASP + 0.35, OPEN1 = OPEN0 + 0.9;
    api.grid("t0", CLASP);
    api.cue("swell", IN - 0.7, 0.6);
    api.cue("hit", CLASP, 1);
    api.cue("scramble", OPEN0 + 0.05, 0.25);   // quiet: the name is being said over it
    api.cue("sweep", OPEN0, 0.2);
    return function (t) {
      camera(cam, t, [[0, 1.06, 0, 0], [CLASP, 1.0, 0, 0, 4]], 0.5);
      const solid = ramp(t, IN, IN + 0.3);
      sw(t, 0, IN, solid);
      const punch = t > CLASP ? Math.exp(-(t - CLASP) * 7) * 0.06 : 0;
      lk.set(t, { show: solid, clasp: ramp(t, CLASP - 0.06, CLASP + 0.42), open: ramp(t, OPEN0, OPEN1), punch });
      flash.style.opacity = (t > CLASP ? Math.exp(-(t - CLASP) * 3.0) : 0).toFixed(3);
      flash.style.transform = `scale(${(t > CLASP ? lerp(0.6, 1.4, outCubic(ramp(t, CLASP, CLASP + 0.8))) : 0.6).toFixed(3)})`;
      halo.style.opacity = (ramp(t, 0.2, IN) * (0.55 + 0.45 * (t > CLASP ? Math.exp(-(t - CLASP) * 1.2) : 1))).toFixed(3);
      kin(tw, t, api.on("brand1", "share") - 0.3, 0.05, 0.6);
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
    const facts = [["Opens", "Once"], opened ? ["Ended", "09:42 AM", "now"] : ["Expires", "10:41 AM", "in 1 hour"], ["Contains", "3 fields"]];
    const ev = [`<li><span class="dot ink">${ic("check")}</span><span><b>Created on this device</b><small>Opens once · expires in 1 hour</small></span><time>09:41 AM</time></li>`];
    ev.push(opened ? `<li class="fresh"><span class="dot ok">${ic("check")}</span><span><b>Revealed</b><small>And deleted right away</small></span><time>09:42 AM</time></li>`
      : `<li class="pending"><span class="dot pending"></span><span><b>Waiting to be opened</b><small>Expires in 1 hour</small></span><span></span></li>`);
    const note = opened ? `<p class="rc-note">${ic("alert", "sm")}<span><b>Didn’t expect it to be opened yet?</b> Someone else may have the link. Change the password and send a new one.</span></p>` : "";
    return hdOwner("links", opened ? 3 : 4) + `<main class="main"><a class="btn sm ghost rc-back" href="#">${ic("back", "sm")}Your links</a>`
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
      + `<button type="button" class="btn danger sm show-m" style="justify-self:start">${ic("eyeoff", "sm")}Clear now</button>`
      + `<p class="fine">Copied values stay in your clipboard. Paste them into your password manager.</p></main>` + foot();
  }

  /* ------------------------------------------------------------------ *
   *  asking for a secret (AskDialog.tsx, LinkReady.tsx, Answer.tsx)
   * ------------------------------------------------------------------ */
  const NOTE = "Hi Sam! Could you send me the staging API token? — Maya";
  function askPage(note, caret) {
    return sendPage({}).replace(`<div class="page-acts"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button></div>`,
      `<div class="page-acts"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button>`
      + `<div class="scrim" style="z-index: 31;"><div class="dialog wide"><div class="dialog-b"><div class="stack ask-dialog"><h2 class="h3">Ask for a secret</h2><p class="muted">Make a link and send it to someone. What they put in it is encrypted for you, and only you can open it.</p>`
      + `<div><label class="label">Note for them<span class="opt-tag">Optional</span></label><textarea class="input textarea focus" rows="3">${note}</textarea><p class="help">Say who you are and what you need. Anyone with the link can read it.</p></div>`
      + `<div class="stack" style="gap: 8px;"><span class="label">Expires after</span><div class="choices"><button type="button" class="choice">1 hour</button><button type="button" class="choice on">1 day</button><button type="button" class="choice">7 days</button><button type="button" class="choice">Custom</button></div><p class="help">The link and its answer expire together.</p></div></div></div>`
      + `<div class="dialog-f"><button type="button" class="btn secondary">Cancel</button><button type="button" class="btn primary create-req">${ic("link", "sm")}Create request link</button></div></div></div></div>`);
  }

  function askReadyPage() {
    return hdOwner("links", 4) + `<main class="main send-page arrive anim"><div class="stack" style="gap: 10px;"><span class="copied">${ic("check")}Request link copied</span><h1 class="h1">Your request link is ready</h1><span class="status waiting"><i></i>Waiting for an answer</span></div>`
      + `<div class="stack" style="gap: 10px;"><div class="linkbox"><span class="url"><span>${linkHTML("a", "wmDntvggVs", "IiezRO0wMgQ71gtJk7YAlA")}</span></span><button type="button" class="btn primary">${ic("copy", "sm")}Copy</button><button type="button" class="btn secondary icon">${ic("qr", "sm")}</button></div><p class="muted small">Send it to the person who has the secret. They don’t need an account, and they can answer once.</p></div>`
      + `<div class="facts"><div><small>Request code</small><b>GS9-HDJ</b></div><div><small>Expires</small><b>Sat, Oct 31, 09:43 AM</b><span>tomorrow</span></div></div>`
      + `<div class="actions-m between"><button type="button" class="btn danger hide-m">${ic("trash", "sm")}Destroy</button><div class="row"><button type="button" class="btn secondary">${ic("inbox", "sm")}<span class="ask-l">Ask for a secret</span></button><button type="button" class="btn primary">Done</button></div></div></main>` + foot();
  }
  const SSH = "stg_tok_9fK2qLmX8vR1tZ7bN3wP6yD4hJ0cA5sE";   // what Sam sends: a staging API token
  function answerPage(text, busy = false) {
    const filled = !!text;
    return hdRecipient() + `<main class="main send-page"><div class="send-head has-note"><h1 class="h1">Someone is asking you for a secret</h1><p class="lede">Put it below. It’s encrypted on this device before it’s sent.</p>`
      + `<figure class="ask-said"><figcaption>${ic("user", "sm")}From the person asking</figcaption><blockquote>${NOTE}</blockquote></figure></div>`
      + `<section class="composer${filled ? " focus" : ""}">` + (filled
        ? `<div class="cmp-title"><input class="t" placeholder="Add a title (optional)"><div class="hint-wrap"><p class="hint">${ic("eye", "sm")}Shown to them before they open it.</p></div></div><div class="cmp-note"><textarea class="note-area" rows="1" style="height: 102px;">${text}</textarea></div>`
        : `<div class="cmp-empty"><textarea class="ph-area" rows="1" placeholder="Type or paste a password, a login, a private note…" style="height: 140px;"></textarea></div>`)
      + `<div class="cmp-bar"><button type="button" class="btn sm ghost">${ic("clip", "sm")}Attach files</button><button type="button" class="btn sm ghost">${ic("plus", "sm")}Add field</button><span class="cmp-end">`
      + (filled ? `<span class="detected counter">${text.length} / 10,000 characters</span>` : "")
      + (busy ? "" : `<span class="cmp-go"><button type="button" class="btn primary send-sec"${filled ? "" : ' aria-disabled="true"'}>${ic("lock", "sm")}Send securely</button></span>`) + `</span></div></section>`
      + (busy ? `<p class="fine" role="status">Encrypting and sending…</p>`
        : `<div class="answer-opts"><label class="check"><input type="checkbox"><span><b>Ask for a passphrase</b><small>They type it to open the link. Tell it to them another way, like on a call.</small></span></label></div>`)
      + `<ul class="list ask-facts"><li>${ic("lock")}<span>Encrypted on this device. Only the person who asked can open it, not even ${HOST}.</span></li><li>${ic("clock")}<span>You can answer until Sat, Oct 31, 09:43 AM.</span></li>`
      + `<li>${ic("inbox")}<span>Request code <b class="mono">GS9-HDJ</b></span></li></ul></main>` + foot();
  }
  /* Maya's request, answered (Receipt.tsx RequestView), and the answer opened on its own page (Output.tsx) */
  function askAnsweredPage() {
    return hdOwner("links", 4) + `<main class="main"><a class="btn sm ghost rc-back" href="#">${ic("back", "sm")}Your links</a>`
      + `<section class="card rc-hero"><div class="rc-head"><span class="rc-icon ok">${ic("inbox")}</span><div class="rc-titles"><span class="status opened"><i></i>Answered</span>`
      + `<div class="title-row"><h1 class="rc-title">Request GS9-HDJ</h1><button type="button" class="btn icon sm ghost">${ic("pencil", "sm")}</button></div><p class="rc-meta"><time>Asked 09:43 AM</time></p></div></div>`
      + `<div class="rc-link"><button type="button" class="btn primary lg open-ans">${ic("eye", "sm")}Open answer</button><p class="muted small">It opens on its own page, like any link. Only this account has its key.</p></div>`
      + `<div class="facts rc-facts"><div><small>Answered</small><b>09:44 AM</b><span>now</span></div><div><small>Expires</small><b>Sat, Oct 31, 09:43 AM</b><span>tomorrow</span></div></div></section>`
      + `<section class="rc-activity"><div class="rc-sec-h"><h2 class="h3">Activity</h2><span class="rc-live"><i></i>Live</span></div>`
      + `<div class="card"><div class="card-b"><ol class="events"><li><span class="dot ink">${ic("check")}</span><span><b>Request created</b></span><time>09:43 AM</time></li>`
      + `<li class="fresh"><span class="dot ok">${ic("check")}</span><span><b>Answered</b></span><time>09:44 AM</time></li>`
      + `<li class="pending"><span class="dot pending"></span><span><b>Waiting to be opened</b><small>Expires tomorrow</small></span><span></span></li></ol></div></div></section></main>` + foot();
  }
  function answerOutPage() {
    return hdRecipient() + `<main class="main narrow"><div class="banner ok">${ic("check")}<span>The link keeps working until it expires. This page is your copy.</span><span class="sp"></span><span class="timer">Clears in 5:00</span></div>`
      + `<section class="out reveal-in anim"><div class="out-h"><h1 class="h3">Secret</h1></div><div class="note out-note"><pre>${SSH}</pre>`
      + `<span class="acts"><button class="btn icon sm ghost">${ic("copy", "sm")}</button></span></div></section>`
      + `<button type="button" class="btn danger" style="justify-self:start">${ic("eyeoff", "sm")}Clear now</button>`
      + `<p class="fine">Copied values stay in your clipboard. Paste them into your password manager.</p></main>` + foot();
  }
  function answerSentPage() {
    return hdRecipient() + `<main class="main narrow"><section class="outcome anim"><div class="outcome-top tint"><span class="outcome-icon ok">${ic("check", "lg")}</span></div>`
      + `<div class="outcome-body"><h1 class="h2">Sent</h1><div class="outcome-text"><p>It’s encrypted for the person who asked, and nobody else. You can close this page.</p></div></div></section></main>` + foot();
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
   *  lasts, create the link; the camera follows the hand. The window shows
   *  the whole page at once (no scrolling), so the camera alone moves.
   * ====================================================================== */
  function send(cam, api) {
    const B = browser(cam, { x: 250, y: 80, w: 1420, h: 960, zoom: 1.0 });
    const clip = at(cam, 0, 0, "clip", ENV.map(([k, v]) => `<span class="k">${k}</span>=${k === "DB_PASSWORD" ? `"${v}"` : v}`).join("\n"));
    const kcap = at(cam, 0, 0, "keycap", "⌘ V");
    const cur = pointer(cam);

    const PASTE = api.on("send1", "paste") + 0.35, FIELDS = PASTE + 0.4, TY = FIELDS + 0.45, RATE = 0.035;
    const CHANGE = api.on("send2", "choose") - 0.05, HOUR = api.on("send2", "lasts") + 0.05, ONCE = api.on("send3", "once") - 0.05;
    const GO = Math.max(ONCE + 0.7, api.on("send3", "create") + 0.15);
    // the app's seal, slowed down so each step lands on the voice: locking on "encrypted on your device", saving on "leaves"
    const T = { S1: GO + 0.05 };
    T.S2 = Math.max(T.S1 + 1.2, api.on("send4", "leaves") - 0.25); T.S3 = T.S2 + 0.7; T.LEAVE = T.S3 + 0.7; T.ARRIVE = T.LEAVE + 0.35;
    // a short caption for each step, for people watching without sound
    const CAPS = [["Paste.", api.segStart("send1") - 0.1, -1], ["Choose how long it lasts.", api.segStart("send2") - 0.1, -1],
      ["Make it open once.", api.segStart("send3") - 0.1, 3], ["Encrypted on your device.", api.segStart("send4") - 0.1, 0],
      ["Send the link.", api.segStart("send5") - 0.1, 2]];
    const scrim = el("div", "abs capscrim", api.layer);
    const caps = CAPS.map(([txt, , acc]) => { const n = el("div", "abs headline caption", api.layer); const w = words(n, txt); if (acc >= 0) w[acc].style.color = "var(--accent)"; return w; });
    api.cue("key", PASTE - 0.02, 0.6); api.cue("key", PASTE + 0.05, 0.5);
    api.cue("whoosh", PASTE + 0.08, 0.3);
    ENV.forEach((_, i) => api.cue("pop", FIELDS + 0.04 + i * 0.1, 0.32));
    for (let i = 0; i < TITLE.length; i += 2) api.cue("key", TY + i * RATE, 0.18);
    api.cue("click", CHANGE, 0.6); api.cue("click", HOUR, 0.6); api.cue("tick", ONCE, 0.8);
    api.cue("click", GO, 0.8);
    api.cue("scramble", T.S1 + 0.02, 0.7); api.cue("sweep", T.S1 + 0.1, 0.5);
    api.cue("clasp", T.S2, 0.9); api.cue("chime", T.S3, 0.7);

    let P = { change: [1300, 860], hour: [1100, 700], once: [1000, 800], go: [1600, 700], comp: [960, 560], panel: [960, 700], box: [960, 500] };
    afterFonts(() => {
      B.html(sendPage({ fields: 3, title: TITLE, options: true }));
      P.hour = B.at(".choice:nth-child(1)", 0.5, 0.55); P.once = B.at(".panel .check input", 0.5, 0.5); P.go = B.at("#send-go", 0.45, 0.55);
      P.panel = B.at(".panel", 0.5, 0.5);
      B.html(sendPage({ fields: 3, title: TITLE }));
      P.change = B.at(".change", 0.45, 0.55); P.comp = B.at(".composer", 0.5, 0.5);
      B.html(sentPage()); P.box = B.at(".linkbox", 0.5, 0.5);
    });

    return function (t) {
      // wide, then in on the composer as it fills, down to the options, back to Create link, then on the link
      // (at 1.3 the whole window width, logo included, stays in frame)
      camera(cam, t, [aim(0, 1.0, [960, 560], [960, 545]), aim(PASTE - 1.0, 1.3, P.comp, [960, 590], 1.4),
        aim(CHANGE + 0.1, 1.3, P.panel, [960, 470], 1.3),
        aim(GO + 0.1, 1.3, P.comp, [960, 470], 1.2),
        aim(T.LEAVE, 1.3, P.box, [960, 470], 0.9)], 0.35);
      CAPS.forEach(([, t0], i) => kin(caps[i], t, t0, 0.05, 0.45, i < CAPS.length - 1 ? CAPS[i + 1][1] - 0.5 : null));
      scrim.style.opacity = ramp(t, CAPS[0][1] - 0.3, CAPS[0][1] + 0.3).toFixed(3);
      reveal(B.win, ramp(t, -0.2, 0.6), { dy: 40, scale: 0.98 });
      if (t < T.S1) {
        const st = { fields: t >= FIELDS ? 3 : 0, focus: t < CHANGE - 0.1, title: typed(TITLE, t, TY, RATE), options: t >= CHANGE + 0.2, hour: t >= HOUR, once: t >= ONCE };
        B.html(sendPage(st));
        if (st.fields) B.$$(".field").forEach((f, i) => { const p = outQuint(ramp(t, FIELDS + i * 0.1, FIELDS + i * 0.1 + 0.45)); f.style.opacity = p.toFixed(3); f.style.transform = `translateY(${(10 * (1 - p)).toFixed(1)}px)`; });
        const pn = B.$(".panel");
        if (pn) { const p = outQuint(ramp(t, CHANGE + 0.2, CHANGE + 0.65)); pn.style.opacity = p.toFixed(3); pn.style.transform = `translateY(${(-10 * (1 - p)).toFixed(1)}px)`; }
      } else if (t < T.ARRIVE) {
        B.html(sendPage({ fields: 3, title: TITLE, once: true, hour: true, options: true, seal: true }));
        if (t >= T.LEAVE) { const m = B.$("main"); setClass(m, "leaving", true); setClass(m, "anim", true); B.seek(m, ((t - T.LEAVE) * 1000) / 2.2); }
        sealDrive(B, t, T);
      } else {
        B.html(sentPage()); B.seek(B.$("main"), ((t - T.ARRIVE) * 1000) / 1.7);
      }
      // the clipboard drops into the composer
      clip.parentElement.style.left = P.comp[0] + "px"; clip.parentElement.style.top = P.comp[1] - 10 + "px";
      kcap.parentElement.style.left = P.comp[0] + 250 + "px"; kcap.parentElement.style.top = P.comp[1] - 110 + "px";
      const cp = ramp(t, PASTE - 0.8, PASTE - 0.4), flyIn = inCubic(ramp(t, PASTE + 0.05, FIELDS));
      reveal(clip, cp, { dy: 30, alpha: 1 - flyIn, base: `scale(0.8) translateY(${(-50 * flyIn).toFixed(1)}px) scale(${lerp(1, 0.7, flyIn).toFixed(3)})` });
      reveal(kcap, ramp(t, PASTE - 0.7, PASTE - 0.35) * (1 - ramp(t, PASTE + 0.2, PASTE + 0.5)), { dy: 16, base: `scale(0.8) translateY(${(4 * Math.sin(Math.PI * ramp(t, PASTE - 0.06, PASTE + 0.12))).toFixed(1)}px)` });
      const pos = path([[CHANGE - 1.0, P.change[0] + 180, P.change[1] + 140], [CHANGE - 0.05, ...P.change], [HOUR - 0.05, ...P.hour],
        [ONCE - 0.05, ...P.once], [GO - 0.05, ...P.go], [GO + 0.9, P.go[0] + 150, P.go[1] - 40]])(t);
      cur(t, pos, [CHANGE, HOUR, ONCE, GO], ramp(t, CHANGE - 1.0, CHANGE - 0.65) * (1 - ramp(t, GO + 0.3, GO + 0.6)));
    };
  }

  /* ====================================================================== *
   *  KEY — the one idea: the key is in the link, so the server can't read it
   * ====================================================================== */
  function vcard(parent, x, y, head, cls) {
    const n = at(parent, x, y, "vcard " + cls, `<div class="vh">${head}</div>` + PLAIN.map(() => `<div class="vl"></div>`).join(""));
    return { n, lines: [...n.querySelectorAll(".vl")] };
  }
  // what the server keeps: one opaque, still block of base64url, the same shape whatever was sent
  const BLOB = Array.from({ length: 4 }, (_, i) => Array.from({ length: 30 }, (_, j) =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(rnd(i * 97.3 + j * 3.71 + 11) * 64)]).join(""));
  function key(cam, api) {
    const layer = api.layer;
    api.grid("tense", 0);
    const t2 = bigtype(layer, "The key travels in the link.", [1], { x: 960, y: 260, size: 96, center: true });
    const t3 = bigtype(layer, "Your server can’t read it.", [3], { x: 960, y: 260, size: 96, center: true });
    const HP = `${HOST}/s/${ID}`, FR = `#${KEY}`;
    const hero = at(cam, 960, 610, "biglink", `<span class="h"></span><span class="frag"><span class="ft"></span><span class="ktag tag acc big">${ic("key")}The key</span></span>`);
    const hp = hero.querySelector(".h"), fr = hero.querySelector(".frag"), ft = hero.querySelector(".ft"), ktag = hero.querySelector(".ktag");
    const L = vcard(cam, 530, 640, `${ic("user")}<span>What you send</span>`, "plain");
    const R = vcard(cam, 1390, 640, `${SERVER_IC}<span>What your server stores</span>`, "noise");

    const KEYT = api.on("key2", "key") - 0.15;
    const SPLIT = api.on("key2", "never") + 0.2;   // "…and your server never sees it": what it gets instead
    api.cue("scramble", 0.15, 0.6); api.cue("swell", KEYT - 0.4, 0.5); api.cue("hit", KEYT + 0.05, 0.5);
    api.cue("whoosh", SPLIT, 0.4); api.cue("pop", SPLIT + 0.25, 0.4); api.cue("pop", SPLIT + 0.45, 0.4);
    api.cue("deny", api.on("key3", "read") + 0.05, 0.35);

    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [0, 1.0, 0, 0, api.dur]], 0.4);
      kin(t2, t, api.segStart("key2") - 0.2, 0.06, 0.6, SPLIT - 0.3);
      kin(t3, t, SPLIT + 0.45, 0.06, 0.6);
      // the link resolves out of noise, then its key lifts out and glows
      const out = inOutCubic(ramp(t, SPLIT - 0.3, SPLIT + 0.55));
      reveal(hero, ramp(t, 0.0, 0.4) * (1 - out), { dy: 0, scale: 0.94, base: `translateY(${(-60 * out).toFixed(1)}px)` });
      setText(hp, A.decrypt(HP, t, 0.15, 0.9, 3));
      setText(ft, A.decrypt(FR, t, 0.55, 0.9, 5));
      // the key slides apart from the address, on the same line, and lights up
      const sep = inOutCubic(ramp(t, KEYT, KEYT + 0.9));
      hp.style.transform = `translateX(${(-22 * sep).toFixed(1)}px)`;
      fr.style.transform = `translateX(${(22 * sep).toFixed(1)}px)`;
      fr.style.setProperty("--hi", sep.toFixed(3));
      hp.style.opacity = lerp(1, 0.4, sep).toFixed(3);
      // (the tag leaves with the link: hidden outright, so a visible child can't show through the faded parent)
      reveal(ktag, ramp(t, KEYT + 0.4, KEYT + 1.0) * (1 - out), { dy: 12, base: "translateX(-50%)" });
      ktag.style.display = out >= 1 ? "none" : "";
      // what you send, and what your server stores
      reveal(L.n, ramp(t, SPLIT + 0.35, SPLIT + 1.15), { dy: 40 });
      reveal(R.n, ramp(t, SPLIT + 0.6, SPLIT + 1.4), { dy: 40 });
      L.lines.forEach((l, i) => setText(l, PLAIN[i]));
      R.lines.forEach((l, i) => setText(l, BLOB[i]));
    };
  }

  /* ====================================================================== *
   *  REVEAL — it opens once; then it's gone
   * ====================================================================== */
  function reveal_(cam, api) {
    const layer = api.layer;
    const tA = bigtype(layer, "Opens once.", [1]);
    const tB = bigtype(layer, "Then it’s gone.", [2]);
    const PH = phone(cam, { x: PHONE_X, y: 80, w: 470, h: 980, clock: "9:42" });
    const dtag = deviceTag(cam, PHONE_X + 235, 50);
    const scr = PH.phone.querySelector(".scr");
    const light = el("div", "abs sweeplight", scr);
    const tap = tapper(cam);
    const TAP = api.snap(api.on("open1", "opens") + 0.05);
    api.grid("drop", TAP);
    // gone: the opened page's own banner ("The link no longer works") lights up on the word
    const OPEN = TAP + 0.35, GONE = api.on("open2", "gone") - 0.1;
    api.cue("tap", TAP, 1); api.cue("unseal", TAP + 0.02, 0.9);
    api.cue("poof", GONE, 0.6);
    let P = [1295, 800];
    afterFonts(() => { PH.html(sealedPage(false)); P = PH.at(".btn.primary.lg", 0.5, 0.5); });
    return function (t) {
      camera(cam, t, [[0, 1.0, 0, 0], [0, 1.03, -10, 0, api.dur]], 0.4);
      reveal(PH.phone, ramp(t, -0.15, 0.5), { dy: 70 });
      reveal(dtag, ramp(t, 0.1, 0.6), { dy: 10 });
      PH.sleep.style.opacity = 0;
      kin(tA, t, api.segStart("open1") - 0.25, 0.06, 0.6, GONE - 0.6);
      kin(tB, t, GONE - 0.1, 0.06, 0.6);
      if (t < OPEN) {
        PH.html(sealedPage(t >= TAP));
        const rb = PH.$(".btn.primary.lg");   // the button gives under the finger
        if (rb) rb.style.transform = `scale(${(1 - 0.03 * Math.sin(Math.PI * ramp(t, TAP - 0.1, TAP + 0.15))).toFixed(4)})`;
      } else { PH.html(openPage()); PH.seek(PH.$(".out"), (t - OPEN) * 1000); }
      const bn = PH.$(".banner");
      if (bn) {
        const g = t >= GONE ? Math.exp(-(t - GONE) * 1.4) : 0, k = spring(ramp(t, GONE, GONE + 0.6) * 1.3, 12, 5);
        bn.style.transformOrigin = "50% 50%";
        bn.style.transform = `scale(${(t >= GONE ? lerp(0.96, 1, k) : 1).toFixed(3)})`;
        bn.style.boxShadow = `0 0 0 ${(10 * g).toFixed(1)}px rgba(79,194,133,${(0.28 * g).toFixed(3)})`;
      }
      tap(t, P, TAP);
      const lp = ramp(t, OPEN - 0.1, OPEN + 0.6);
      light.style.opacity = lp > 0 && lp < 1 ? Math.sin(Math.PI * lp).toFixed(3) : 0;
      light.style.transform = `translateY(${lerp(-100, 110, inOutCubic(lp)).toFixed(1)}%)`;
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
    let SCR = 0, DY = 0;
    afterFonts(() => {
      B.html(receiptPage(false)); SCR = Math.max(0, B.$(".rc-back").getBoundingClientRect().top - 30);
      const a0 = B.$(".rc-activity").getBoundingClientRect().top;
      B.html(receiptPage(true)); DY = a0 - B.$(".rc-activity").getBoundingClientRect().top;   // the link row folds away
    });
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
        // what was below the link slides up into its place, rather than jumping
        const sl = DY * (1 - inOutCubic(ramp(t, OPENED, OPENED + 0.45)));
        B.$$(".rc-activity, .rc-actions").forEach((n) => { n.style.transform = `translateY(${sl.toFixed(1)}px)`; });
        const nt = B.$(".rc-note");
        if (nt) nt.style.opacity = ramp(t, OPENED + 0.45, OPENED + 0.8).toFixed(3);
      }
    };
  }

  /* ====================================================================== *
   *  ASK — a link for someone else to fill in; only you can open it.
   *  Maya asks in the real dialog; Sam answers on their phone; Maya opens it.
   * ====================================================================== */
  function ask(cam, api) {
    const layer = api.layer;
    const tA = bigtype(layer, "Ask for\na secret.", [3]);
    const tS = bigtype(layer, "Encrypted\nbefore it’s sent.", [1, 2, 3]);
    const tB = bigtype(layer, "Only you\ncan open it.", [0, 1]);
    const B = browser(cam, { x: 740, y: 120, w: 1120, h: 1020, zoom: 1.3 });
    const PH = phone(cam, { x: PHONE_X, y: 80, w: 470, h: 980, clock: "9:44" });
    const dtag = deviceTag(cam, PHONE_X + 235, 50);
    const light = el("div", "abs sweeplight", PH.phone.querySelector(".scr"));
    const cur = pointer(cam), tap = tapper(cam);

    const NOTE0 = api.on("ask1", "need") + 0.05, NRATE = 0.022;
    const CREATE = api.on("ask1", "request") + 0.15, READY = CREATE + 0.5;   // the ripple finishes on the button it pressed
    const SWAP = api.segStart("ask2") - 0.6;                          // from Maya's window to Sam's phone
    const FILL = SWAP + 1.3, SEND = Math.max(FILL + 0.6, api.on("ask2", "encrypted") - 0.1), SENT = SEND + 1.15;
    const BACK = api.segStart("ask3") - 1.0;                          // and back to Maya: answered
    const OPENA = Math.max(BACK + 1.5, api.on("ask3", "open") - 0.15), OUT = OPENA + 0.4;
    for (let i = 0; i < NOTE.length; i += 4) api.cue("key", NOTE0 + i * NRATE, 0.25);
    api.cue("click", CREATE, 0.7); api.cue("chime", READY + 0.1, 0.4);
    api.cue("whoosh", SWAP, 0.35); api.cue("pop", FILL, 0.4);
    api.cue("tap", SEND, 0.8); api.cue("scramble", SEND + 0.1, 0.6); api.cue("sweep", SENT - 0.25, 0.45); api.cue("chime", SENT + 0.15, 0.6);
    api.cue("whoosh", BACK, 0.35); api.cue("pop", BACK + 0.9, 0.4);
    api.cue("click", OPENA, 0.7); api.cue("unseal", OPENA + 0.05, 0.8);

    let P = [1500, 900], Q = [1340, 760], R = [1100, 500], O = [1300, 500];
    afterFonts(() => {
      B.html(askPage(NOTE)); P = B.at(".create-req", 0.5, 0.55);
      B.html(askAnsweredPage()); R = B.at(".open-ans", 0.5, 0.55);
      B.html(answerOutPage()); O = B.at(".out", 0.5, 0.5);
      PH.html(answerPage(SSH)); Q = PH.at(".send-sec", 0.5, 0.5);
    });
    return function (t) {
      // at the end, in on the answer, so the token can be read
      camera(cam, t, [[0, 1.0, 0, 0], [0, 1.03, -18, -6, api.dur], aim(OUT + 0.1, 1.15, O, [1400, 560], 1.1)], 0.4);
      reveal(dtag, ramp(t, SWAP + 0.75, SWAP + 1.3) * (1 - ramp(t, BACK, BACK + 0.4)), { dy: 10 });
      kin(tA, t, api.segStart("ask1") - 0.25, 0.06, 0.6, SWAP - 0.2);
      kin(tS, t, SWAP + 0.6, 0.06, 0.6, BACK - 0.1);
      kin(tB, t, api.segStart("ask3") - 0.25, 0.06, 0.6);
      // Maya: the dialog, her note, the request link; later her request, answered, and the answer
      const out = inOutCubic(ramp(t, SWAP, SWAP + 0.75)), back = inOutCubic(ramp(t, BACK + 0.35, BACK + 1.05));
      const away = t < BACK ? out : 1 - back;
      reveal(B.win, ramp(t, -0.2, 0.5) * (1 - away), { dy: 40, base: `translateX(${(-80 * away).toFixed(1)}px)` });
      B.win.style.display = away >= 1 ? "none" : "";
      if (t < READY) { B.url([HOST, ""]); B.html(askPage(typed(NOTE, t, NOTE0, NRATE))); }
      else if (t < BACK) { B.url([HOST, "/r/wmDntvggVs"]); B.html(askReadyPage()); B.seek(B.$("main"), (t - READY) * 1000); }
      else if (t < OUT) {
        B.url([HOST, "/r/wmDntvggVs"]); B.html(askAnsweredPage());
        const fresh = B.$(".events li.fresh");
        if (fresh) { const hi = Math.exp(-Math.max(0, t - BACK - 0.9) * 0.9); fresh.style.borderRadius = "12px";
          fresh.style.background = `rgba(79,194,133,${(0.08 + 0.14 * hi).toFixed(3)})`; }
      } else { B.url([HOST, "/s/Qm7RtZp2Lx"]); B.html(answerOutPage()); B.seek(B.$(".out"), (t - OUT) * 1000); }
      const pos = t < BACK
        ? path([[CREATE - 0.8, P[0] + 110, P[1] + 70], [CREATE - 0.05, ...P], [CREATE + 0.9, P[0] + 100, P[1] + 120]])(t)
        : path([[OPENA - 0.8, R[0] + 160, R[1] + 180], [OPENA - 0.05, ...R], [OPENA + 0.9, R[0] + 110, R[1] + 130]])(t);
      const ca = t < BACK ? ramp(t, CREATE - 0.8, CREATE - 0.5) * (1 - ramp(t, CREATE + 0.5, CREATE + 0.8))
        : ramp(t, OPENA - 0.8, OPENA - 0.5) * (1 - ramp(t, OPENA + 0.45, OPENA + 0.75));
      cur(t, pos, [CREATE, OPENA], ca);
      // Sam: the request, the key pasted in, sent
      const pin = inOutCubic(ramp(t, SWAP + 0.65, SWAP + 1.4)) * (1 - inOutCubic(ramp(t, BACK, BACK + 0.6)));   // never two screens at once
      reveal(PH.phone, pin, { dy: 0, base: `translateX(${(90 * (1 - pin)).toFixed(1)}px)` });
      PH.phone.style.display = pin <= 0 ? "none" : "";
      PH.sleep.style.opacity = 0;
      // Send securely: the button turns busy, the key in the box encrypts, a sweep of light, then Sent
      if (t < SEND + 0.2) {   // the button takes the press, then the page turns busy
        PH.html(answerPage(t >= FILL ? SSH : ""));
        const ta = PH.$(".note-area");   // the paste lands, softly
        if (ta) ta.style.opacity = ramp(t, FILL, FILL + 0.3).toFixed(3);
      }
      else if (t < SENT) {
        PH.html(answerPage(SSH, true));
        const ta = PH.$(".note-area");
        if (ta) ta.value = A.scramble(SSH, t, SEND + 0.25, 0.6, 7);
        const sp = PH.$(".send-sec .spin");
        if (sp) sp.style.transform = `rotate(${((t - SEND) * 515).toFixed(1)}deg)`;
        const cmp = PH.$(".composer");
        const lv = ramp(t, SENT - 0.3, SENT);
        if (cmp) { cmp.style.opacity = (1 - lv).toFixed(3); cmp.style.transform = `translateY(${(-14 * lv).toFixed(1)}px)`; }
      } else {
        PH.html(answerSentPage());
        PH.seek(PH.$(".outcome"), ((t - SENT) * 1000) / 1.4);
        const ic_ = PH.$(".outcome-icon");
        if (ic_) { const k = spring(ramp(t, SENT + 0.1, SENT + 0.8) * 1.3, 11, 5); ic_.style.transform = `scale(${lerp(0.4, 1, k).toFixed(3)})`;
          ic_.style.boxShadow = `0 0 0 ${(18 * ramp(t, SENT + 0.15, SENT + 0.9)).toFixed(1)}px rgba(79,194,133,${(0.3 * (1 - ramp(t, SENT + 0.15, SENT + 0.9))).toFixed(3)})`; }
      }
      const lp = ramp(t, SENT - 0.35, SENT + 0.45);
      light.style.opacity = lp > 0 && lp < 1 ? Math.sin(Math.PI * lp).toFixed(3) : 0;
      light.style.transform = `translateY(${lerp(-100, 110, inOutCubic(lp)).toFixed(1)}%)`;
      tap(t, Q, SEND);
    };
  }

  /* ====================================================================== *
   *  SELF-HOST — free, open source, built for teams; try it in one command
   * ====================================================================== */
  function selfhost(cam, api) {
    const layer = api.layer;
    bloom(cam, 1450, 540, 1300, "rgba(70,96,160,0.22)");
    const tA = bigtype(layer, "Free and\nopen source.", [2, 3], { y: 500 });
    const tB = bigtype(layer, "Built\nfor teams.", [1, 2], { y: 500 });
    const sub = el("div", "abs meta", layer, `MIT License<b>·</b><span class="mono" style="color:var(--ink-2)">github.com/polius/Cryptex</span>`);
    Object.assign(sub.style, { left: "113px", top: "680px" });
    const TM = el("div", "term", cam);
    Object.assign(TM.style, { left: "1080px", top: "380px", width: "740px", height: "300px" });
    TM.innerHTML = `<div class="tb"><i></i><i></i><i></i><div class="ttl">you@laptop — zsh</div></div><div class="body"></div>`;
    const body = TM.querySelector(".body");
    const after = el("div", "abs meta", cam, `then open <span class="mono" style="color:var(--ink-2)">http://localhost:8080</span>`);
    Object.assign(after.style, { left: "1083px", top: "712px" });
    const CMD = 'docker run -d \\\n  -p 127.0.0.1:8080:8080 \\\n  -v "$PWD/data:/data" \\\n  poliuscorp/cryptex';
    // docker run -d prints the new container's id, and nothing else
    const CID = "3f9c2a71d0e4b8c65a1f7e2d9b0c4a8e6f1d3b7c2e9a5f0d8c4b1e6a7f3d2c9b";
    // the command is typed while "one Docker command" is said, and runs on "command"
    const RATE = 0.02, c0 = api.segStart("self2") - 0.3, RUN = Math.max(c0 + CMD.length * RATE + 0.12, api.on("self2", "command") + 0.05);
    for (let i = 0; i < CMD.length; i += 5) api.cue("key", c0 + i * RATE, 0.25);
    api.cue("enter", RUN, 0.8);
    api.cue("tick", RUN + 0.3, 0.4);
    const TEAMS = api.on("self1", "teams") - 0.3;
    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [0, 1.0, 0, 0, api.dur]], 0.4);
      kin(tA, t, api.segStart("self1") - 0.3, 0.06, 0.55, TEAMS - 0.45);
      kin(tB, t, TEAMS, 0.06, 0.55);
      reveal(sub, ramp(t, api.on("self1", "open"), api.on("self1", "open") + 0.5), { dy: 14 });
      reveal(TM, ramp(t, -0.1, 0.6), { dy: 50, scale: 0.96 });
      reveal(after, ramp(t, RUN + 0.5, RUN + 0.9), { dy: 10 });
      const glow = t > RUN ? Math.exp(-(t - RUN) * 4) : 0;
      TM.style.boxShadow = `0 60px 120px -40px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.13), 0 0 ${(70 * glow).toFixed(0)}px rgba(79,194,133,${(0.3 * glow).toFixed(3)})`;
      let html = typed(CMD, t, c0, RATE).split("\n").map((ln, i) => `<div>${i === 0 ? '<span class="p">$ </span>' : ""}${ln.replace(/</g, "&lt;")}</div>`).join("");
      if (t < RUN) html = html.replace(/<\/div>$/, `${blink(t, 0.9) ? '<span class="caret"></span>' : ""}</div>`);
      if (t >= RUN + 0.3) html += `<div class="d">${CID.slice(0, 40)}…</div>`;
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
    const wrap = at(cam, 960, 400, "");
    const lk = lockup(wrap, 130);
    const tag = at(cam, 960, 610, "headline");
    tag.style.fontSize = "64px";
    const tw = words(tag, "Share a secret. Keep it secret.");
    const pill = at(cam, 960, 750, "pill", `${GITHUB}<span>github.com/polius/Cryptex</span>`);
    const meta = at(cam, 960, 850, "meta", `Threat model and HTTPS setup in the README<b>·</b>MIT License`);
    const s1 = api.segStart("outro2");
    const CLASP = api.segStart("outro1") - 0.55, IN = Math.min(0.1, CLASP - 0.45), OPEN0 = CLASP + 0.3, OPEN1 = OPEN0 + 0.8;   // no second swarm: the mark fades in as the cut lands, then clasps
    api.cue("swell", IN - 0.6, 0.5);
    api.cue("hit", CLASP, 0.85);
    api.cue("scramble", OPEN0 + 0.05, 0.25);   // quiet: the name is being said over it
    api.cue("sweep", OPEN0, 0.2);
    return function (t) {
      camera(cam, t, [[0, 1.04, 0, 0], [CLASP, 1.0, 0, 0, 4]], 0.5);
      const solid = ramp(t, IN, IN + 0.3);
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
