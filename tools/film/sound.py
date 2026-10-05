"""Music bed and sound design for the Flowdeck film, synthesised from scratch and mixed under the voiceover."""
import json
import numpy as np
import soundfile as sf
from scipy import signal

SR = 48000
DUR = 60.0
N = int(SR * DUR)
rng = np.random.default_rng(7)
cues = json.load(open('/tmp/claude-0/film/vo/cues.json'))
cs = lambda i: cues[i]['start']
ce = lambda i: cues[i]['end']
t = np.arange(N) / SR


def lp(x, f, order=2):
    b, a = signal.butter(order, f / (SR / 2), 'low')
    return signal.lfilter(b, a, x)


def hp(x, f, order=2):
    b, a = signal.butter(order, f / (SR / 2), 'high')
    return signal.lfilter(b, a, x)


def bp(x, lo, hi, order=2):
    b, a = signal.butter(order, [lo / (SR / 2), hi / (SR / 2)], 'band')
    return signal.lfilter(b, a, x)


def env_ad(n, a, d):
    """attack/decay envelope in seconds over n samples"""
    x = np.arange(n) / SR
    e = np.minimum(1, x / max(a, 1e-4)) * np.exp(-np.maximum(0, x - a) / max(d, 1e-4))
    return e


def place(buf, sig, at, gain=1.0):
    s = int(at * SR)
    if s >= len(buf):
        return
    e = min(len(buf), s + len(sig))
    buf[s:e] += sig[: e - s] * gain


def saw(f, tt, detune=0.0):
    ph = (f * (1 + detune)) * tt
    return 2 * (ph - np.floor(ph + 0.5))


def note(m):
    return 440 * 2 ** ((m - 69) / 12)


def smooth_env(points):
    """piecewise-linear envelope from (time, value) points, smoothed"""
    ts, vs = zip(*points)
    e = np.interp(t, ts, vs)
    return lp(e, 3, 1)


music = np.zeros(N)

# ---------------------------------------------------------------- drone: D1 + A1, slowly breathing
drone = np.zeros(N)
for f, g in ((note(26), 0.5), (note(33), 0.32), (note(38), 0.18)):
    for d in (-0.004, 0.0, 0.0045):
        drone += g * saw(f, t, d)
drone = lp(drone, 220, 2) * (0.75 + 0.25 * np.sin(2 * np.pi * t / 7.5))
drone *= smooth_env([(0, 0), (1.5, 0.55), (10.6, 0.7), (11.0, 0.9), (46.2, 0.9), (47.0, 0.5), (52.8, 0.6), (53.1, 1.0), (58.5, 0.8), (60, 0)])
music += drone * 0.35

# ---------------------------------------------------------------- pad chords (D minor world), enters with the light
chords = [  # (start, midi notes)
    (10.8, [50, 53, 57, 62]),   # Dm
    (19.1, [46, 50, 53, 58]),   # Bb
    (26.9, [53, 57, 60, 65]),   # F
    (31.5, [48, 52, 55, 60]),   # C
    (38.5, [50, 53, 57, 62]),   # Dm
    (47.1, [46, 50, 53, 58]),   # Bb
    (53.0, [50, 57, 62, 65, 69]),  # Dm add, open
]
pad = np.zeros(N)
for k, (st, notes) in enumerate(chords):
    en = chords[k + 1][0] if k + 1 < len(chords) else DUR
    n0, n1 = int(st * SR), int(min(DUR, en + 1.2) * SR)
    tt = t[n0:n1] - st
    seg = np.zeros(n1 - n0)
    for m in notes:
        for d in (-0.006, 0.0, 0.007):
            seg += saw(note(m), tt, d)
    seg = lp(seg, 1400 if k < 6 else 1900, 2)
    L = len(seg)
    fade = np.minimum(1, tt / 0.9) * np.clip((en + 1.2 - st - tt) / 1.2, 0, 1)
    pad[n0:n1] += seg * fade / len(notes)
pad *= smooth_env([(0, 0), (10.6, 0), (11.6, 0.55), (46.3, 0.6), (47.0, 0.35), (53.0, 0.75), (59.0, 0.6), (60, 0)])
music += pad * 0.28

# ---------------------------------------------------------------- pulse: soft kick + ticking hats from the heatmap onwards
BEAT = 0.5  # 120 bpm
kick = np.sin(2 * np.pi * (45 * np.arange(int(0.45 * SR)) / SR + 60 * (1 - np.exp(-np.arange(int(0.45 * SR)) / SR / 0.04)) * 0.04)) * env_ad(int(0.45 * SR), 0.002, 0.18)
hat = hp(rng.standard_normal(int(0.06 * SR)), 7000, 2) * env_ad(int(0.06 * SR), 0.001, 0.018)
start_pulse = cs(5)
b = 0
while True:
    at = start_pulse + b * BEAT
    if at > ce(21) + 0.2:
        break
    quiet = cs(20) - 0.6 < at < cs(20) + 0.9
    if not quiet:
        if at > cs(6) - 0.05:
            place(music, kick, at, 0.55 if b % 2 == 0 else 0.35)
        for s in range(4):
            place(music, hat, at + s * BEAT / 4, (0.10 if s == 0 else 0.05) * (1.4 if at > cs(6) else 0.8))
    b += 1

# ---------------------------------------------------------------- sound design
sfx = np.zeros(N)


def riser(at, dur, gain=0.5):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    # sweep a band-pass upwards in steps
    steps = 24
    for k in range(steps):
        a0, a1 = k * n // steps, (k + 1) * n // steps
        f = 300 * (12000 / 300) ** (k / steps)
        out[a0:a1] = bp(noise[a0:a1], f * 0.7, min(f * 1.4, 22000))
    out *= np.linspace(0, 1, n) ** 2.2
    place(sfx, out, at, gain)


def boom(at, gain=0.9, f0=52):
    n = int(2.6 * SR)
    x = np.arange(n) / SR
    s = np.sin(2 * np.pi * (f0 * x + 40 * (1 - np.exp(-x / 0.06)) * 0.06)) * np.exp(-x / 0.9)
    s += lp(rng.standard_normal(n), 900, 2) * np.exp(-x / 0.12) * 0.6
    place(sfx, s, at, gain)


def whoosh(at, gain=0.35, dur=0.55):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    steps = 16
    for k in range(steps):
        a0, a1 = k * n // steps, (k + 1) * n // steps
        ph = k / steps
        f = 500 + 4500 * np.sin(np.pi * ph)
        out[a0:a1] = bp(noise[a0:a1], f * 0.6, f * 1.6)
    out *= np.sin(np.pi * np.linspace(0, 1, n)) ** 1.5
    place(sfx, out, at - dur * 0.5, gain)


def thud(at, gain=0.5, f0=70):
    n = int(0.9 * SR)
    x = np.arange(n) / SR
    s = np.sin(2 * np.pi * f0 * x * (1 + 0.6 * np.exp(-x / 0.05))) * np.exp(-x / 0.22)
    s += bp(rng.standard_normal(n), 120, 900) * np.exp(-x / 0.05) * 0.4
    place(sfx, s, at, gain)


def glitch(at, gain=0.35):
    n = int(0.35 * SR)
    x = np.arange(n) / SR
    s = np.sign(np.sin(2 * np.pi * 180 * x * (1 - x * 1.8))) * (rng.random(n) > 0.6)
    s = bp(s, 300, 4000) * np.exp(-x / 0.12)
    place(sfx, s, at, gain)


def chime(at, gain=0.45, root=880):
    n = int(3.0 * SR)
    x = np.arange(n) / SR
    s = np.zeros(n)
    for r, g, d in ((1, 1, 1.4), (2.01, 0.5, 0.9), (2.76, 0.35, 0.6), (4.07, 0.2, 0.35), (1.5, 0.4, 1.1)):
        s += g * np.sin(2 * np.pi * root * r * x) * np.exp(-x / d)
    s *= np.minimum(1, x / 0.004)
    place(sfx, s / 2.4, at, gain)


def tick(at, gain=0.12):
    n = int(0.03 * SR)
    s = hp(rng.standard_normal(n), 3000, 2) * env_ad(n, 0.0005, 0.006)
    place(sfx, s, at, gain)


# opening: low swell of the dark book
riser(0.0, 4.6, 0.12)
# walls built (thuds), pulled (glitches)
for k, w in enumerate([0.05, 0.25, 0.45, 0.6, 0.75, 0.9]):
    thud(cs(1) + w, 0.45 if k % 2 == 0 else 0.35, 62 + k * 4)
for w in (0.35, 0.55, 0.75):
    glitch(cs(2) + w, 0.3)
# into the light
riser(cs(4) - 1.6, 1.65, 0.5)
boom(cs(4) + 0.32, 0.9)
chime(cs(4) + 0.34, 0.25, 587.3)
# heatmap -> tools
riser(cs(6) - 1.2, 1.2, 0.35)
boom(cs(6) - 0.02, 0.6, 46)
whoosh(cs(5) + 3.7, 0.25, 0.9)    # camera rise over the terrain
whoosh(18.6, 0.3, 0.9)            # dashboard stands up
for i in (7, 8, 9, 10):
    whoosh(cs(i) + 0.05, 0.42)
whoosh(cs(11) + 0.12, 0.42)
# accuracy
whoosh(cs(12) + 0.15, 0.4, 0.7)
riser(cs(12) + 0.4, 2.0, 0.12)
for k in range(24):
    tick(cs(13) + 0.1 + 1.8 * (1 - (1 - (k + 1) / 24) ** (1 / 3)), 0.16)
boom(cs(14) - 0.03, 0.55, 58)
chime(cs(14) - 0.02, 0.55, 880)
# devices
whoosh(cs(15) + 0.1, 0.45, 0.8)
whoosh(cs(19) - 0.2, 0.3, 0.9)    # screen lifts into a phone
# trial
whoosh(cs(20) + 0.1, 0.42, 0.7)
whoosh(cs(20) + 1.1, 0.35, 0.6)   # through the button
whoosh(cs(21) + 1.9, 0.3, 0.7)
# finale
riser(cs(22) - 1.8, 1.85, 0.45)
boom(cs(22) - 0.02, 1.0, 44)
chime(cs(22), 0.35, 587.3)
chime(cs(23) + 0.05, 0.22, 880)

# ---------------------------------------------------------------- mix: duck the music under the voice
vo, _ = sf.read('/tmp/claude-0/film/vo/vo_track.wav', dtype='float64')
vo = np.pad(vo, (0, max(0, N - len(vo))))[:N]
venv = lp(np.abs(vo), 6, 1)
venv = venv / (venv.max() + 1e-9)
duck = 1 - 0.55 * np.clip(venv * 4, 0, 1)
bed = (music * duck + sfx * (1 - 0.25 * np.clip(venv * 4, 0, 1)))
bed = bed / (np.abs(bed).max() + 1e-9) * 0.7
# gentle stereo: duplicate with tiny delay on one side for width
left = bed + vo * 1.15
right = np.roll(bed, int(0.011 * SR)) + vo * 1.15
st = np.stack([left, right], 1)
st *= np.clip(np.minimum(t / 0.05, (DUR - t) / 1.0), 0, 1)[:, None]
st /= np.abs(st).max() / 0.95
sf.write('/tmp/claude-0/film/mix_raw.wav', st.astype(np.float32), SR)
sf.write('/tmp/claude-0/film/bed_only.wav', np.stack([bed, np.roll(bed, int(0.011 * SR))], 1).astype(np.float32), SR)
print('ok', np.abs(st).max())
