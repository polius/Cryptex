# Cryptex video

The Cryptex promo: a **~1-minute, 1920×1080, 60 fps MP4** with a neural
voice-over, an original synthesized score, and sound design cued from the
picture. The README links to it from the poster at the top.

It is built from scratch: a small **web "video engine"** (HTML/CSS/JS)
rendered deterministically by headless Chromium, one frame at a time. The
pipeline is the one behind the [fsend](https://github.com/polius/fsend),
[FileSync](https://github.com/polius/filesync) and
[Flow](https://github.com/polius/Flow) videos.

Design rules the film follows, so any future edit stays on-model:

- **The product from the first seconds.** No problem set-up: the film opens
  on the name and is in the app within six seconds.
- **One idea per shot, and the voice never stops for long.** About 90 spoken
  words. On-screen type is used only where the idea is the message (the key
  scene, opening, tracking, asking, self-hosting), and it complements the voice rather than reading
  it back.
- **The product is the hero, shown big.** Every app screen is the real one:
  the built stylesheet, fonts and icons from `web/`, in an iframe, filled with
  the markup the app renders and its own copy (`web/src/copy/en.json`), in its
  dark theme. When the UI changes, the film changes with it. The send scene is
  one continuous shot whose camera follows the hand.
- **Show the result, not the mechanism.** Security is one image and one
  sentence: the key lifting out of the link, then what you send next to what
  your server stores. No diagrams, no algorithm names.
- **Few, unhurried cuts.** Eight scenes joined by the push-through of the
  fsend, FileSync and Flow films: the scene leaving moves towards the viewer
  and softens, the next settles in, with a whoosh. Every scene holds on its
  point before it cuts. No montages.
- **The app's own moments.** Create link plays the app's seal (the text
  scrambles, the guilloche sweeps over it, the mark clasps shut), with its own
  CSS animations, seeked frame by frame.
- **The cryptex.** The film opens and closes on the mark: glyphs gather into
  it, it clasps shut as in the app's seal, and the name decrypts behind a
  sweep of light. The background is security print: the app's sealed pattern
  drawn in the round. One accent, the sealed indigo; green means opened.
- **Only true claims.** Everything said or shown matches the app, the README,
  `docs/crypto.md` and `docs/threat-model.md`. Check there before changing a line.
- **Every sound has a cause on screen.** Scenes register their own cues, so
  sound and picture cannot drift apart.

This folder holds **only the source**. Frames, audio, the model weights and the
MP4 itself are all generated and git-ignored. Regenerate with `./make.sh`.

---

## Why not a screen recording

If every pixel is a **pure function of the timestamp**, then

- the same input always produces the same frame (reviews are meaningful),
- we can render at 2× and downsample, so type and thin strokes stay crisp at
  1080p (supersampling),
- timing is driven by the *measured* narration audio, so the visuals stay in
  sync no matter how fast the voice reads.

So the "renderer" is a web page, and the "render farm" is `page.screenshot()`
in a loop.

Scene arc, timed to the narration (about 70 s):

```
open ("Meet Cryptex": the mark clasps, the name decrypts)
  →  send (paste, choose how long it lasts, create the link: the app's seal)
  →  key (the key lifts out of the link; what you send / what your server stores)
  →  reveal (they open it once; then it's gone)  →  track (the link's own page)
  →  ask (Maya asks in the real dialog; Sam answers on their phone)
  →  selfhost (free and open source; run your own: the Docker command)  →  outro
```

---

## Setup

Needs **Python 3.10+**, **ffmpeg**, **Node** (the app's build), and a network
connection for the first run.

```sh
cd web && npm ci && cd ..               # once, for the app's build and fonts
cd scripts/explainer
./setup.sh --models                     # venv + deps + chromium + Kokoro weights (~340 MB)
```

Everything is installed *inside this folder* (`.venv/`, `models/`).

## Build

```sh
./make.sh                                   # the whole pipeline -> cryptex-video.mp4
./make.sh --output ~/Desktop/cryptex-video.mp4
```

Stages (`build.py` prints them as `[n/7]`):

0. **app**: `npm run build` in `web/`, so the film shows the current stylesheet.
1. **narration**: `narration.py` synthesizes every line with **Kokoro-82M**
   (local ONNX, voice `af_heart`) and lays out `timeline.json`: scene windows
   plus *word onsets*. Each clip is transcribed back with **faster-whisper**
   (`small.en`, fetched once into `models/whisper/`): its word timestamps place
   the onsets, so a visual lands on the exact word it is spoken, and the
   transcript is printed as `heard:`, so a mispronounced word shows up in the
   build log.
2. **cues**: the page is loaded once and the scenes' sound-effect cues, plus
   the beat grid, are dumped to `cues.json`.
3. **capture**: `capture.py` drives headless Chromium, calling
   `window.__render(t)` and screenshotting every frame at **2×**, across
   parallel workers.
4. **audio**: `sfx.py` renders the cues, `music.py` composes the score, the
   voice ducks the score through a sidechain compressor, and the mix is
   two-pass loudness-normalized.
5. **encode**: lanczos-downscale to 1080p, BT.709 tags, a whisper of grain,
   x264 CRF 17.
6. **captions**: a `.srt` sidecar, one cue per sentence.
7. **mux**.

Useful flags:

```sh
./make.sh --skip-capture          # re-encode / re-mix from frames/ on disk
./make.sh --skip-narration        # reuse audio/ + timeline.json
./make.sh --workers 4 --crf 16 --grain 0
FPS=30 ./make.sh                  # a faster draft (also re-times the narration)
```

To look at stills while iterating on the visuals (fast, 1×, no encode):

```sh
.venv/bin/python capture.py --preview 9.5,17,38      # -> preview/*.png
```

The README's poster, `docs/video-poster.png`, is the app's composer in a window
on the film's paper, with a play button (`POSTER` in `web/scenes.js`):

```sh
./make.sh --poster 10
```

---

## Files

| File | Role |
|---|---|
| `narration.py` | the script and pacing. **Start here** to change the wording. |
| `web/engine.js` | the renderer: `render(t)`, scene layers and cameras, the cuts, the security-print background, the app in iframes (`appFrame`), the scramble, the beat grid, the cue registry |
| `web/scenes.js` | the eight scenes, the app's pages as it renders them, the big type, the lockup, the pointer, the poster |
| `web/style.css` | the film's palette and type (the app's), windows, the phone, the diagram, the terminal |
| `capture.py` | http server (the app's build at the root, the film under `/film/`) + Playwright frame loop (`--preview`, `--poster`, `--cues`) |
| `music.py` | the score: 100 BPM; a celesta clockwork and felt piano in D minor, the groove dropping on the Reveal tap, a breakdown under the end card, D major at the end |
| `sfx.py` | the sound design: swell, hit, scramble, sweep, clasp, unseal, chime, key, click, tap, pop, poof, deny, … |
| `build.py` | orchestrates all stages |
| `setup.sh` / `make.sh` | one-time setup / one-shot build |

## Customizing

- **Wording and pacing**: edit `LINES` in `narration.py`. Keep it short:
  the whole film is about 90 spoken words. `HOLD` / `SCENE_HOLD` (how long a
  scene stays on its point after its last word), `LEAD` / `SCENE_LEAD` (how
  long it shows before its first), `GAP_SAME` and `GAP_EXTRA` decide how
  fast the film feels. Adding a line?
  Give it a scene and, if a visual should land on a word, an anchor
  (`{"key": "key"}`); scenes read it with `api.on("<line-id>", "<anchor>")`.
- **Visuals**: `web/scenes.js` and `web/style.css`. A scene moves its camera
  with `camera(cam, t, keys)`, puts a moment on the beat with `api.snap(t)`,
  and makes a sound with `api.cue(type, t, gain)`.
- **The app changed?** Update the page templates in `scenes.js` (`sendPage`,
  `sealedPage`, `receiptPage`, …) from the app's DOM, so the markup matches what
  it renders. The stylesheet, fonts and icons follow on their own.

## Notes

- **Capture** rasterizes on the GPU (Metal on macOS) and serves the page from
  a threaded server: the iframes ask for the stylesheet and fonts all at once.
  An iframe whose stylesheet didn't load stops the capture with an error.
- **The app's animations** are switched off in the iframes, except under an
  element with the `anim` class: the scene seeks those (`B.seek`), so they
  play at the film's time, not the clock's.
- **Inside a zoomed iframe**, `getBoundingClientRect()` and scroll offsets are
  already in on-screen pixels: `B.at()` adds the frame's position only.
- **Rendering cost is fill-rate bound.** Soft light is drawn with radial
  gradients, never `filter: blur()` on large layers. The guilloche is drawn
  once into canvases and only turned. Film grain is added once by ffmpeg.
- Hidden scene layers use `display: none`, not `visibility: hidden`: a child
  set to `visibility: visible` by a reveal would otherwise show through.
- Layout that depends on text size is measured in `afterFonts()`, which runs
  on the first rendered frame, before any transform is applied.
- The beat grid is set by the scenes (`api.grid("t0", …)` in the open,
  `api.grid("tense", …)` in key, `api.grid("drop", …)` in reveal) and reaches
  `music.py` through `cues.json` as the `beat0`, `tense` and `groove` entries.
- **Do not commit** `frames/`, `preview/`, `audio/`, `captions/`,
  `timeline.json`, `cues.json`, `*.wav`, `*.mp4`, `models/` or `.venv/`.
