"""Place 24 recorded voice lines (01..24 .mp3/.pcm) on the film timeline: trim, light polish, schedule, cue sheet."""
import glob
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf

SRC = sys.argv[1]
OUT = '/tmp/claude-0/film/vo'
SR = 48000
SECTIONS = ["A", "B", "B", "B", "C", "D", "E", "E", "E", "E", "E", "F", "G", "G", "G", "H", "H", "H", "H", "H", "I", "I", "J", "J"]
TEXT = json.load(open('/home/claude/HeatMap_BTC_USD/frontend/film/cues.json'))
info = json.load(open(os.path.join(SRC, 'info.json'))) if os.path.exists(os.path.join(SRC, 'info.json')) else {}

clips = []
for i in range(24):
    f = sorted(glob.glob(os.path.join(SRC, f'{i + 1:02d}.*')))
    f = [x for x in f if not x.endswith('.json')][0]
    inp = ['-f', 's16le', '-ar', '44100', '-ac', '1', '-i', f] if f.endswith('.pcm') else ['-i', f]
    tmp = f'{OUT}/el_{i:02d}.wav'
    # light polish only: the voice is already deep. Gentle low-end warmth, de-mud, presence, soft compression.
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', *inp, '-af',
                    'aresample=48000,highpass=f=50,equalizer=f=120:t=q:w=1:g=1.5,equalizer=f=350:t=q:w=1.2:g=-1.5,'
                    'equalizer=f=3500:t=q:w=1.5:g=1.5,acompressor=threshold=-20dB:ratio=2.5:attack=10:release=150:makeup=2',
                    '-ac', '1', '-ar', str(SR), tmp], check=True)
    a, _ = sf.read(tmp, dtype='float32')
    idx = np.where(np.abs(a) > 0.012)[0]
    a = a[max(0, idx[0] - int(0.01 * SR)): idx[-1] + int(0.08 * SR)]
    clips.append(a)

durs = [len(c) / SR for c in clips]
speech = sum(durs)
print('speech total %.2fs' % speech)


def schedule(gap_in, gap_sec):
    t, out, prev = 0.9, [], None
    for i, d in enumerate(durs):
        if i > 0:
            t += gap_in if SECTIONS[i] == prev else gap_sec
        out.append((t, t + d))
        t += d
        prev = SECTIONS[i]
    return out


gi, gs = 0.26, 0.75
sch = schedule(gi, gs)
TARGET = 56.0
while sch[-1][1] > TARGET and gs > 0.45:
    gi, gs = gi * 0.94, gs * 0.94
    sch = schedule(gi, gs)
tempo = 1.0
if sch[-1][1] > TARGET:  # still long: speed the read up a touch (max 6%)
    tempo = min(1.06, (sch[-1][1] - 0.9) / (TARGET - 0.9))
    for i in range(24):
        tmp = f'{OUT}/el_{i:02d}.wav'
        sf.write(tmp, clips[i], SR)
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', tmp, '-af', f'atempo={tempo:.4f}', f'{OUT}/el_{i:02d}_t.wav'], check=True)
        clips[i], _ = sf.read(f'{OUT}/el_{i:02d}_t.wav', dtype='float32')
    durs = [len(c) / SR for c in clips]
    sch = schedule(gi, gs)
print(f'gaps {gi:.2f}/{gs:.2f}  tempo {tempo:.3f}  ends {sch[-1][1]:.2f}s')

track = np.zeros(int(SR * 60.5), dtype=np.float32)
cues = []
for i, ((s, e), c) in enumerate(zip(sch, clips)):
    s0 = int(s * SR)
    track[s0:s0 + len(c)] += c
    cues.append({"i": i, "sec": SECTIONS[i], "text": TEXT[i]["text"], "start": round(s, 3), "end": round(e, 3)})
    print(f'{i:2d} {s:6.2f} -> {e:6.2f}  {TEXT[i]["text"]}')
track = track / (np.abs(track).max() + 1e-9) * 0.89
sf.write(f'{OUT}/vo_track.wav', track[: SR * 60], SR)
json.dump(cues, open(f'{OUT}/cues.json', 'w'), indent=1)
print('voice:', info.get('voice'), info.get('format'))
