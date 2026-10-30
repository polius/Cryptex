#!/usr/bin/env python3
"""Generate the score: a quiet clockwork that turns into a groove when the secret opens.

Synthesized from scratch (no samples, no licensing), so the video never depends
on a music asset. It shares one beat grid with the picture: web/engine.js
anchors it on the first ring locking into place, and marks the moment Alex
presses Reveal; cues.json carries both ("beat0", "groove"). The voice ducks the
score later, in build.py.

  open           a riser under the glyphs gathering into the mark, dropping
                 out on the frame it clasps shut
  send, key      D minor, sealed: a celesta ticking in sixteenths like a
                 mechanism, felt piano chords, a soft pulse that firms up on
                 the key
  reveal .. ask  the drop on the Reveal tap: kick, claps, ticking hats, a bass
                 that moves, the progression turns towards F major
  selfhost ..    breakdown: drums out, the clockwork alone
  outro          the last ring locks: D major, a celesta roll up

  music.py --timeline timeline.json --cues cues.json --out music.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
BPM = 100
BEAT = 60 / BPM
BAR = 4 * BEAT
END = 2.4                          # the last chord, alone under the end card

# (bass, voicing) per bar, four-bar loops
SEALED = [(38, [57, 60, 64, 65]),      # Dm9      (A C E F over D)
          (34, [57, 62, 65, 69]),      # B♭maj7   (A D F A over B♭)
          (31, [58, 62, 65, 69]),      # Gm9      (B♭ D F A over G)
          (33, [55, 60, 62, 64])]      # A7sus4   (G C D E over A)
OPEN = [(38, [57, 60, 64, 65]),        # Dm9
        (34, [57, 62, 65, 69]),        # B♭maj7
        (41, [57, 60, 64, 67]),        # Fmaj9    (A C E G over F)
        (36, [55, 60, 62, 67])]        # Cadd9    (G C D G over C)
FINAL = (38, [54, 57, 61, 64, 66, 69])  # Dmaj9: the cryptex opens
# the celesta's clockwork: chord tones in sixteenths, a figure per bar
FIGURE = [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 3, 1, 2]
# the hook, over the groove: (bar-in-4, beat, MIDI)
HOOK = [(0, 0.0, 81), (0, 0.75, 77), (0, 1.5, 76), (0, 2.5, 74), (1, 0.0, 77), (1, 1.5, 74), (1, 2.5, 72),
        (2, 0.0, 76), (2, 0.75, 72), (2, 1.5, 74), (2, 2.5, 76), (3, 0.0, 74), (3, 1.0, 72), (3, 2.0, 69)]

rng = np.random.default_rng(31)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return signal.sosfilt(signal.butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(signal.butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def add(buf, start, x, pan=0.0):
    """Mix mono `x` into stereo `buf` at `start` seconds, equal-power pan."""
    i = int(round(start * SR))
    if i >= buf.shape[0] or i + x.size <= 0:
        return
    if i < 0:
        x, i = x[-i:], 0
    x = x[: buf.shape[0] - i]
    a = (pan + 1) * np.pi / 4
    buf[i:i + x.size, 0] += x * np.cos(a)
    buf[i:i + x.size, 1] += x * np.sin(a)


def env(n, a, d, r=None):
    """attack/decay envelope over n samples (exponential decay, linear attack)."""
    t = np.arange(n) / SR
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / d)
    if r:
        e *= np.clip((n / SR - t) / r, 0, 1)
    return e


def reverb_ir(seconds=2.4, decay=0.75):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((n, 2)) * np.exp(-t / decay)[:, None]
    ir[:, 0] = lp(ir[:, 0], 5200); ir[:, 1] = lp(ir[:, 1], 5200)
    ir[: int(0.012 * SR)] = 0                     # pre-delay
    return ir / np.sqrt((ir ** 2).sum(axis=0))


# ---- instruments --------------------------------------------------------------
def piano(m, dur, vel=1.0):
    """a felt piano: three slightly detuned strings, soft hammer, warm decay"""
    n = int((dur + 1.6) * SR)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.zeros(n)
    for det in (-0.6, 0.0, 0.7):
        ff = f * 2 ** (det / 1200)
        for k, a in ((1, 1.0), (2, 0.38), (3, 0.16), (4, 0.07), (5, 0.03)):
            fk = ff * k * (1 + 0.00035 * k * k)             # a little stiffness
            x += a * np.sin(2 * np.pi * fk * t + rng.random() * 6) * np.exp(-t * (0.9 + 0.8 * k) / (1 + vel * 0.4))
    x /= 3
    felt = lp(rng.standard_normal(n), 1400) * np.exp(-t / 0.012) * 0.25
    e = np.minimum(1, t / 0.006) * np.where(t < dur, 1, np.exp(-(t - dur) / 0.35))
    return lp((x + felt) * e, 3200 + 2400 * vel) * 0.09 * vel


def celesta(m, vel=1.0):
    """a celesta / music-box tine: bright, short, a bell partial"""
    n = int(1.3 * SR)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 4.0 * t) * np.exp(-t / 0.05) + 0.12 * np.sin(2 * np.pi * f * 6.8 * t) * np.exp(-t / 0.02)
    x *= np.minimum(1, t / 0.001) * np.exp(-t / 0.42)
    return x * 0.05 * vel


def pad(notes, dur, bright=1.0):
    """a soft pad: detuned saws through a gentle low-pass, slow in and out"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for m in notes:
        for det in (-7, 0, 6):
            f = hz(m) * 2 ** (det / 1200)
            ph = (f * t + rng.random()) % 1
            x += 2 * ph - 1
    x = lp(x / (3 * len(notes)), 700 + 900 * bright, 2)
    a = min(0.8, dur / 3)
    e = np.minimum(1, t / a) * np.clip((dur - t) / a, 0, 1)
    return x * e * 0.11


def kick():
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    f = 46 + 90 * np.exp(-t / 0.028)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.24)
    click = lp(rng.standard_normal(n), 3000) * np.exp(-t / 0.003) * 0.18
    return lp(np.tanh(1.6 * (x + click)), 3500) * 0.8


def clap():
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    for d in (0.0, 0.011, 0.023):
        tt = np.maximum(0, t - d)
        x += (t >= d) * np.exp(-tt / (0.012 if d < 0.02 else 0.13))
    noise = bp(rng.standard_normal(n), 900, 5500)
    return lp(noise * x, 8000) * 0.34


def hat(open_=False):
    n = int((0.2 if open_ else 0.05) * SR)
    x = hp(rng.standard_normal(n), 7500, 4) * env(n, 0.0008, 0.07 if open_ else 0.016)
    return lp(x, 12500) * 0.3


def tick():
    """a woody clock tick (the off-beats)"""
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * 1900 * t) * np.exp(-t / 0.006) + bp(rng.standard_normal(n), 2500, 6000) * np.exp(-t / 0.003) * 0.4
    return x * 0.12


def bass_note(m, dur, vel=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t) + 0.1 * np.sin(2 * np.pi * 3 * f * t)
    x = np.tanh(1.5 * x) * np.minimum(1, t / 0.008) * np.exp(-t / 1.4) * np.clip((dur - t) / 0.04, 0, 1)
    return lp(x, 700) * 0.36 * vel


def riser(dur):
    """filtered noise rising into the drop"""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    out = np.zeros(n)
    hop = int(0.02 * SR)
    for i in range(0, n, hop):
        c = 400 * (9000 / 400) ** (i / n)
        seg = bp(x[max(0, i - 4 * hop): i + hop], c * 0.7, min(c * 1.3, SR / 2.2))
        out[i:i + hop] = seg[-min(hop, n - i):]
    return out * (t / dur) ** 2.2 * 0.16


# ---- arrangement --------------------------------------------------------------
def build(timeline, cues):
    dur = timeline["video_end"]
    n = int(dur * SR) + SR
    keys = np.zeros((n, 2))       # ducked by the kick
    bass = np.zeros((n, 2))
    drums = np.zeros((n, 2))
    send = np.zeros((n, 2))       # into the reverb

    starts = {s["name"]: s["start"] for s in timeline["scenes"]}
    b0 = next(c["t"] for c in cues if c["type"] == "beat0")
    drop = next(c["t"] for c in cues if c["type"] == "groove")
    end_hit = sorted(c["t"] for c in cues if c["type"] == "hit")[-1]
    snapb = lambda t, g: g + round((t - g) / BEAT) * BEAT
    pulse0 = snapb(starts["send"], b0)
    tense = snapb(next(c["t"] for c in cues if c["type"] == "tense"), b0)
    brk = snapb(starts["selfhost"], drop)
    pre_bars = [b0 + k * BAR for k in range(int((drop - b0) / BAR) + 2) if b0 + k * BAR < drop - 1e-6]
    bars = [drop + k * BAR for k in range(int((end_hit - drop) / BAR) + 2) if drop + k * BAR < end_hit - 0.05]

    # before the drop: piano chords and the celesta's clockwork, sealed in D minor
    for k, t in enumerate(pre_bars):
        bass_n, voice = SEALED[k % 4]
        d = min(BAR, drop - t)
        for j, m in enumerate(voice):
            x = piano(m, d * 0.95, 0.55 + 0.1 * (t >= tense))
            add(keys, t + j * 0.014, x, pan=-0.3 + 0.18 * j); add(send, t + j * 0.014, x * 0.35)
        add(keys, t, pad(voice[:3], d + 0.4, 0.5 + 0.5 * (t >= tense)), pan=0)
        if t >= pulse0 - 1e-6:
            add(bass, t, bass_note(bass_n, d * 0.95, 0.7))
        for s in range(16):
            tt = t + s * BEAT / 4
            if tt >= drop - 0.02:
                break
            v = (0.55 if s % 4 == 0 else 0.32) * (0.7 if t < pulse0 else 1.0)
            x = celesta(voice[FIGURE[s]] + 12, v)
            add(keys, tt, x, pan=0.35 if s % 2 else -0.15); add(send, tt, x * 0.6)
    # a heartbeat from the seal, firmer from the key
    for i in range(int((drop - pulse0) / BEAT) + 1):
        b = pulse0 + i * BEAT
        if b >= drop - 1e-6:
            break
        if i % 2 == 0:
            add(drums, b, kick() * (0.35 if b < tense else 0.5))
        add(drums, b + BEAT / 2, tick() * 0.8, pan=0.25)
    # the hook, before the mark clasps: a low drone, a clock ticking, a slow
    # heartbeat, and a riser that drops out just before the clasp
    x = pad([38, 45, 50, 53], b0 + 0.6, 0.25) * 2.2
    add(keys, 0.0, x * np.minimum(1, np.arange(x.size) / SR / 1.5))
    for i in range(1, int(b0 / BEAT) + 1):
        b = b0 - i * BEAT
        if b < 0.6:
            break
        add(drums, b, tick() * (0.55 if i % 2 else 0.35), pan=0.2)
        if i % 4 == 0 and b > 2.5:
            add(drums, b, kick() * 0.3)
    r = riser(2.6)
    r[-int(0.25 * SR):] *= np.linspace(1, 0, int(0.25 * SR))
    add(drums, b0 - 2.6, r * 1.3)
    add(drums, drop - 1.6, riser(1.6))

    # from the drop: the groove, turned towards F major
    for k, t in enumerate(bars):
        bass_n, voice = OPEN[k % 4]
        live = t < brk - 1e-6
        for at_beat, d, v in ((0, 1.6, 0.85), (1.5, 0.45, 0.5), (2.5, 1.2, 0.7)):
            for j, m in enumerate(voice):
                x = piano(m, d * BEAT, v * (0.8 if live else 0.6))
                add(keys, t + at_beat * BEAT + j * 0.01, x, pan=-0.3 + 0.18 * j); add(send, t + at_beat * BEAT, x * 0.3)
        add(keys, t, pad(voice[:3], BAR + 0.3, 1.0 if live else 0.4))
        for s in range(16):
            v = (0.4 if s % 4 == 0 else 0.22) * (1.0 if live else 0.8)
            x = celesta(voice[FIGURE[s]] + 12, v)
            add(keys, t + s * BEAT / 4, x, pan=0.35 if s % 2 else -0.15); add(send, t + s * BEAT / 4, x * 0.5)
        if not live:
            continue
        for at_beat, d, m in ((0, 0.9, bass_n), (1.5, 0.4, bass_n), (2.0, 0.45, bass_n + 12), (2.5, 0.9, bass_n + 7), (3.5, 0.4, bass_n + 10)):
            add(bass, t + at_beat * BEAT, bass_note(m, d * BEAT))
        # the hook, every other four bars
        if (k // 4) % 2 == 1:
            for barN, bt, m in HOOK:
                if barN == k % 4:
                    for x in (celesta(m, 1.2), piano(m, 0.4, 0.5) * 0.6):
                        add(keys, t + bt * BEAT, x, pan=0.15); add(send, t + bt * BEAT, x * 0.8)

    K, C = kick(), clap()
    kicks = []
    for t in bars:
        for bb in range(4):
            b = t + bb * BEAT
            if b >= brk - 1e-6:
                break
            if bb in (0, 2):
                add(drums, b, K); kicks.append(b)
            if bb == 2:
                add(drums, b + BEAT * 0.75, K * 0.55); kicks.append(b + BEAT * 0.75)
            if bb in (1, 3):
                add(drums, b, C, pan=0.05); add(send, b, C * 0.5)
            for s in range(4):
                add(drums, b + s * BEAT / 4, hat() * (0.5, 0.2, 0.36, 0.2)[s], pan=0.3)
            if bb == 3:
                add(drums, b + BEAT / 2, hat(open_=True) * 0.3, pan=0.3)
    # the breakdown keeps the clock ticking
    for i in range(int((end_hit - brk) / BEAT) + 1):
        b = brk + i * BEAT
        if b < end_hit - 0.05:
            add(drums, b + BEAT / 2, tick() * 0.7, pan=0.25)

    # the end: the last ring locks, D major rings, the celesta rolls up
    for j, m in enumerate(FINAL[1]):
        x = piano(m, dur - end_hit - 0.8, 0.8)
        add(keys, end_hit + j * 0.025, x * 1.6, pan=-0.35 + 0.14 * j); add(send, end_hit + j * 0.025, x * 0.8)
    add(keys, end_hit, pad(FINAL[1][:4], dur - end_hit, 0.8) * 1.3)
    add(bass, end_hit, bass_note(FINAL[0], dur - end_hit - 0.5, 0.9))
    for k, m in enumerate([66, 69, 73, 76, 78, 81, 85, 90]):
        x = celesta(m, 1.3 * np.exp(-k / 7))
        add(keys, end_hit + 0.2 + k * BEAT / 4, x, pan=0.35 if k % 2 else -0.35); add(send, end_hit + 0.2 + k * BEAT / 4, x)

    # the open carries the film alone (no pulse yet): lift it, easing back as the pulse starts
    tt = np.arange(n) / SR
    keys *= (1 + 1.6 * np.clip((pulse0 - tt) / 1.2, 0, 1))[:, None]

    # sidechain: keys and bass lean back under the kick
    duck = np.ones(n)
    for b in kicks:
        i0 = int(b * SR)
        k = np.arange(min(int(0.3 * SR), n - i0)) / SR
        duck[i0:i0 + k.size] = np.minimum(duck[i0:i0 + k.size], 1 - 0.32 * np.exp(-k / 0.09))
    keys *= duck[:, None]; bass *= duck[:, None]

    ir = reverb_ir(2.8, 0.85)
    wet = np.stack([signal.fftconvolve(send[:, c], ir[:, c])[:n] for c in range(2)], axis=1)
    out = keys + bass + drums * 0.85 + wet * 0.45
    out = out[: int(dur * SR)]

    # warmth + fades, then leave headroom for the voice
    t = np.arange(out.shape[0]) / SR
    out *= np.minimum(1, t / 0.3)[:, None]
    out *= np.clip((dur - t) / END, 0, 1)[:, None]
    out[:, 0] = lp(out[:, 0], 13000); out[:, 1] = lp(out[:, 1], 13000)
    out = np.tanh(out * 1.25) / 1.25
    return out / max(1e-9, np.abs(out).max()) * 0.6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", default=os.path.join(HERE, "timeline.json"))
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--out", default=os.path.join(HERE, "music.wav"))
    args = ap.parse_args()
    data = build(json.load(open(args.timeline)), json.load(open(args.cues)))
    sf.write(args.out, data, SR, subtype="PCM_24")
    print(f"music: {args.out}  {data.shape[0] / SR:.1f}s")


if __name__ == "__main__":
    main()
