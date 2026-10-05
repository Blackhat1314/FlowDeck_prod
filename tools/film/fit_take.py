"""Cut one continuous voiceover take into the film's 24 lines and place each line on the film's timeline.

    python fit_take.py voice/David.mp3

The film's choreography (camera, type) hangs off the line START times in frontend/film/cues.json, so each line
is placed at its existing start; only the end times change. The take is split at its pauses: of all the quiet
gaps, the 23 that make each line's length closest to a reference read (REF) are chosen.
Writes vo/vo_track.wav (48 kHz, 60 s) and vo/cues.json (copy it to frontend/film/).
"""
import json
import math
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
TAKE = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'vo')
CUES = os.path.join(HERE, '..', '..', 'frontend', 'film', 'cues.json')
SR = 48000
# reference length of each line (s), from a line-by-line read; only the proportions matter
REF = [3.46, 1.18, 1.1, 2.47, 1.88, 4.2, 1.5, 0.93, 0.62, 1.27, 0.83, 2.86, 1.86, 1.3, 1.05, 1.3, 1.36, 0.98, 0.84, 1.37, 1.62, 2.96, 1.07, 1.21]
os.makedirs(OUT, exist_ok=True)

wav = os.path.join(OUT, 'take48.wav')
# light polish only: highpass, a little warmth, de-mud, presence, gentle compression
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', TAKE, '-af',
                'aresample=48000,highpass=f=50,equalizer=f=120:t=q:w=1:g=1.5,equalizer=f=350:t=q:w=1.2:g=-1.5,'
                'equalizer=f=3500:t=q:w=1.5:g=1.5,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2',
                '-ac', '1', '-ar', str(SR), wav], check=True)
a, _ = sf.read(wav, dtype='float32')
HOP = SR // 100
rms = np.array([np.sqrt(np.mean(a[i:i + 2 * HOP] ** 2)) for i in range(0, len(a) - 2 * HOP, HOP)])
db = 20 * np.log10(rms + 1e-9)
loud = db > -45
first, last = np.argmax(loud), len(loud) - np.argmax(loud[::-1]) - 1

# quiet gaps (>= 0.12 s) between first and last speech
gaps, s = [], None
for k in range(first, last + 1):
    if not loud[k] and s is None:
        s = k
    if loud[k] and s is not None:
        if k - s >= 12:
            gaps.append(((s + k) / 2 / 100, (k - s) / 100))
        s = None
t0, t1 = first / 100, (last + 1) / 100
n = len(REF)
scale = (t1 - t0) / sum(REF)
M = len(gaps)
assert M >= n - 1, f'only {M} pauses found; need {n - 1}'


def seg_cost(k, a_, b_):
    return math.log(max(b_ - a_, 0.05) / (REF[k] * scale)) ** 2


INF = float('inf')
# best[j][k]: lines 0..k end at gap j
best = [[INF] * n for _ in range(M)]
back = [[-1] * n for _ in range(M)]
for j in range(M):
    best[j][0] = seg_cost(0, t0, gaps[j][0]) - 0.08 * math.log(gaps[j][1])
for k in range(1, n - 1):
    for j in range(M):
        for i in range(j):
            if best[i][k - 1] == INF:
                continue
            c = best[i][k - 1] + seg_cost(k, gaps[i][0], gaps[j][0]) - 0.08 * math.log(gaps[j][1])
            if c < best[j][k]:
                best[j][k], back[j][k] = c, i
end = min(range(M), key=lambda j: best[j][n - 2] + seg_cost(n - 1, gaps[j][0], t1))
splits = [end]
for k in range(n - 2, 0, -1):
    splits.append(back[splits[-1]][k])
splits = [gaps[j][0] for j in reversed(splits)]
bounds = [t0] + splits + [t1]

cues = json.load(open(CUES))
track = np.zeros(SR * 60, dtype=np.float32)
out = []
for i in range(n):
    lo, hi = int(bounds[i] * 100), int(bounds[i + 1] * 100)
    seg = np.where(loud[lo:hi + 1])[0]
    s0 = (lo + seg[0]) * HOP - int(0.02 * SR)
    s1 = (lo + seg[-1] + 2) * HOP + int(0.08 * SR)
    clip = a[max(0, s0):s1].copy()
    fade = int(0.01 * SR)
    clip[:fade] *= np.linspace(0, 1, fade)
    clip[-fade:] *= np.linspace(1, 0, fade)
    st = cues[i]['start']
    p = int(st * SR)
    track[p:p + len(clip)] += clip[: len(track) - p]
    en = st + len(clip) / SR - 0.06
    nxt = cues[i + 1]['start'] if i + 1 < n else 60
    flag = '  <-- runs into the next line' if en > nxt - 0.05 else ''
    out.append({**cues[i], 'end': round(en, 3)})
    print(f'{i + 1:2d} take {bounds[i]:6.2f}-{bounds[i + 1]:6.2f}  film {st:6.2f} -> {en:6.2f}  {cues[i]["text"]}{flag}')
track = track / (np.abs(track).max() + 1e-9) * 0.89
sf.write(os.path.join(OUT, 'vo_track.wav'), track, SR)
json.dump(out, open(os.path.join(OUT, 'cues.json'), 'w'), indent=1)
print('wrote', os.path.join(OUT, 'vo_track.wav'))
