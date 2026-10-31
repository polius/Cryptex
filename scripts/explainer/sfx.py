#!/usr/bin/env python3
"""Sound design: render the scenes' cue list (cues.json) into one effects track.

The scenes register every cue themselves (api.cue in web/), so a sound always
sits on the frame that causes it. Every effect is synthesized, like the music:
the mark's latch and the cuts are small mechanical clicks, the seal and the
reveal are the app's own moments.

  sfx.py --cues cues.json --duration 63.2 --out sfx.wav
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import soundfile as sf
from scipy import signal

from music import SR, add, bp, env, hp, lp, reverb_ir

HERE = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(7)


def T(sec):
    return np.arange(int(sec * SR)) / SR


def sweep_noise(sec, f0, f1, q=0.5):
    """Noise through a band that glides from f0 to f1, with a bell envelope."""
    n = int(sec * SR)
    x = rng.standard_normal(n)
    out = np.zeros(n)
    hop = int(0.02 * SR)
    for i in range(0, n, hop):
        c = f0 * (f1 / f0) ** (i / n)
        seg = bp(x[max(0, i - 4 * hop): i + hop], c * (1 - q), min(c * (1 + q), SR / 2.2))
        out[i:i + hop] = seg[-min(hop, n - i):]
    u = np.arange(n) / n
    return out * np.sin(np.pi * u) ** 1.6




def hit():
    """the mark clasps shut: a soft, heavy latch with a shimmer (D major, high)"""
    t = T(3.0)
    f = 48 + 60 * np.exp(-t / 0.05)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.45) * 0.8
    latch = lp(rng.standard_normal(t.size), 2400) * np.exp(-t / 0.015) * 0.4
    shim = sum(np.sin(2 * np.pi * f0 * t + i) for i, f0 in enumerate((1174.7, 1480.0, 1760.0, 2217.5)))
    shim *= np.minimum(1, t / 0.02) * np.exp(-t / 1.3) * 0.04
    return np.tanh(1.2 * (sub + latch)) * 0.6 + shim


def clasp():
    """the app's seal clasping shut (the mark closes)"""
    t = T(0.35)
    x = np.sin(2 * np.pi * 300 * t) * np.exp(-t / 0.05) + hp(rng.standard_normal(t.size), 1800) * np.exp(-t / 0.004) * 0.7
    return lp(x, 5000) * 0.22


def scramble():
    """text turning to ciphertext: a quick granular shimmer"""
    n = int(0.7 * SR)
    x = np.zeros((n, 2))
    for k in range(40):
        at = k / 40 * 0.62
        tt = T(0.03)
        f = 1800 + rng.random() * 4200
        g = np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.006) * 0.045 * np.sin(np.pi * k / 40) ** 0.5
        add(x, at, g, pan=rng.random() * 1.4 - 0.7)
    return x


def sweep():
    """the guilloche sweeping over the composer"""
    return lp(sweep_noise(0.6, 600, 5200, 0.5), 8000) * 0.2


def unseal():
    """the seal lifts: an airy rising chord and a release"""
    t = T(1.6)
    x = sum(np.sin(2 * np.pi * f0 * t) * np.exp(-t / 0.8) for f0 in (587.3, 740.0, 880.0, 1108.7)) / 4
    x *= np.minimum(1, t / 0.01) * 0.09
    air = sweep_noise(0.9, 1200, 7000, 0.5)
    out = np.zeros(t.size)
    out[: air.size] += air * 0.22
    return out + x


def swell():
    """a soft reverse swell into the clasp"""
    t = T(0.8)
    x = sum(np.sin(2 * np.pi * f0 * t) for f0 in (587.3, 880.0, 1174.7)) / 3
    return x * (t / 0.8) ** 2.5 * np.clip((0.8 - t) / 0.03, 0, 1) * 0.08 + sweep_noise(0.8, 400, 3000, 0.5) * (t / 0.8) ** 2 * 0.15


def burst():
    """the plaintext tears loose: a granular shatter and a deep air pull"""
    n = int(1.6 * SR)
    x = np.zeros((n, 2))
    for k in range(70):
        at = (k / 70) ** 1.6 * 0.6
        tt = T(0.04)
        f = 2500 + rng.random() * 5000
        add(x, at, np.sin(2 * np.pi * f * tt) * np.exp(-tt / 0.005) * 0.06 * (1 - k / 90), pan=rng.random() * 1.6 - 0.8)
    air = sweep_noise(1.5, 3000, 300, 0.6) * 0.3
    sub = np.sin(2 * np.pi * np.cumsum(60 + 40 * np.exp(-T(1.5) / 0.2)) / SR) * np.exp(-T(1.5) / 0.4) * 0.35
    mono = air + sub
    add(x, 0.0, mono)
    return x


def key():
    t = T(0.05)
    f = 1800 + rng.random() * 1400
    click = hp(rng.standard_normal(t.size), 2500) * np.exp(-t / 0.004)
    body = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.006) * 0.4
    thock = np.sin(2 * np.pi * (240 + rng.random() * 60) * t) * np.exp(-t / 0.012) * 0.5
    return (click * 0.6 + body + thock) * 0.16


def enter():
    t = T(0.12)
    return (hp(rng.standard_normal(t.size), 1500) * np.exp(-t / 0.006) * 0.5
            + np.sin(2 * np.pi * 170 * t) * np.exp(-t / 0.03)) * 0.26


def click():
    t = T(0.06)
    return (hp(rng.standard_normal(t.size), 3000) * np.exp(-t / 0.0025) * 0.5
            + np.sin(2 * np.pi * 1300 * t) * np.exp(-t / 0.008) * 0.3) * 0.5


def tap():
    t = T(0.12)
    return (lp(rng.standard_normal(t.size), 1200) * np.exp(-t / 0.008) * 0.5
            + np.sin(2 * np.pi * 300 * t) * np.exp(-t / 0.02) * 0.4) * 0.45


def tick():
    t = T(0.08)
    return np.sin(2 * np.pi * 2600 * t) * np.exp(-t / 0.012) * 0.12


def pop():
    """a woody pop"""
    t = T(0.3)
    f = 880 + rng.random() * 220
    x = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.05) + 0.4 * np.sin(2 * np.pi * f * 3.9 * t) * np.exp(-t / 0.012)
    return x * np.minimum(1, t / 0.001) * 0.16


def blip():
    t = T(0.18)
    return (np.sin(2 * np.pi * 1320 * t) + 0.4 * np.sin(2 * np.pi * 1980 * t)) * env(t.size, 0.002, 0.04) * 0.14


def chime():
    t = T(1.8)
    x = np.zeros(t.size)
    for f0, d in ((1174.7, 0.0), (1760.0, 0.09)):      # D6 then A6
        tt = np.maximum(0, t - d)
        for k, a in ((1, 1), (2.76, 0.3), (5.4, 0.12)):
            x += np.sin(2 * np.pi * f0 * k * tt) * a * np.exp(-tt / (0.6 / k)) * (t >= d)
    return x * np.minimum(1, t / 0.003) * 0.08


def deny():
    """a soft, low "no": two muted notes falling a third"""
    t = T(0.5)
    x = np.zeros(t.size)
    for f0, d in ((349.2, 0.0), (293.7, 0.13)):
        tt = np.maximum(0, t - d)
        x += np.sin(2 * np.pi * f0 * tt) * np.exp(-tt / 0.09) * (t >= d)
    return lp(x, 2000) * 0.13


def poof():
    """a link destroyed: a short, dry crumple"""
    x = sweep_noise(0.35, 3000, 500, 0.6) * 0.3
    t = T(0.35)
    return lp(x, 6000) + np.sin(2 * np.pi * 110 * t) * np.exp(-t / 0.05) * 0.15


def thud():
    t = T(0.6)
    f = 55 + 70 * np.exp(-t / 0.04)
    return np.tanh(1.5 * (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)
                          + hp(rng.standard_normal(t.size), 2000) * np.exp(-t / 0.004) * 0.3)) * 0.4




def wake():
    """the phone wakes: two soft notes, a fifth apart"""
    t = T(1.2)
    x = np.zeros(t.size)
    for f0, d in ((587.3, 0.0), (880.0, 0.08)):
        tt = np.maximum(0, t - d)
        x += np.sin(2 * np.pi * f0 * tt) * np.exp(-tt / 0.35) * (t >= d)
    return x * np.minimum(1, t / 0.004) * 0.07


def swish():
    return sweep_noise(0.5, 900, 6000, 0.45) * 0.5


def whoosh():
    x = sweep_noise(0.75, 250, 4200, 0.6) * 0.55
    t = T(0.75)
    return x + lp(rng.standard_normal(t.size), 180) * np.sin(np.pi * t / 0.75) ** 2 * 0.6




FX = {"hit": hit, "clasp": clasp, "scramble": scramble, "sweep": sweep, "unseal": unseal,
      "key": key, "enter": enter, "click": click, "tap": tap, "tick": tick, "pop": pop, "blip": blip, "chime": chime,
      "deny": deny, "poof": poof, "thud": thud, "wake": wake, "swish": swish, "whoosh": whoosh, "swell": swell, "burst": burst}
# how much of each effect goes to the reverb
SEND = {"swell": 0.5, "hit": 0.5, "chime": 0.6, "unseal": 0.5, "whoosh": 0.3, "swish": 0.3, "pop": 0.25, "wake": 0.5,
        "blip": 0.3, "clasp": 0.3, "deny": 0.3}
PAN = {"whoosh": 0.0, "hit": 0.0, "unseal": 0.0}


def build(cues, duration):
    n = int(duration * SR) + SR
    dry = np.zeros((n, 2))
    wet_in = np.zeros((n, 2))
    for c in cues:
        if c["type"] not in FX:          # grid markers for the score, not sounds
            continue
        x = FX[c["type"]]() * c.get("gain", 1)
        if x.ndim == 2:
            i = int(c["t"] * SR)
            dry[i: i + x.shape[0]] += x[: max(0, n - i)]
            continue
        pan = PAN.get(c["type"], (rng.random() - 0.5) * 0.3)
        add(dry, c["t"], x, pan=pan)
        if c["type"] in SEND:
            add(wet_in, c["t"], x * SEND[c["type"]], pan=pan)
    ir = reverb_ir(2.6, 0.85)
    wet = np.stack([signal.fftconvolve(wet_in[:, ch], ir[:, ch])[:n] for ch in range(2)], axis=1)
    out = (dry + wet * 0.6)[: int(duration * SR)]
    return np.clip(out, -0.98, 0.98)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cues", default=os.path.join(HERE, "cues.json"))
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--out", default=os.path.join(HERE, "sfx.wav"))
    args = ap.parse_args()
    cues = json.load(open(args.cues))
    sf.write(args.out, build(cues, args.duration), SR, subtype="PCM_24")
    print(f"sfx: {len(cues)} cues -> {args.out}")


if __name__ == "__main__":
    main()
