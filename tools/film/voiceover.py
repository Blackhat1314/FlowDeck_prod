import soundfile as sf, numpy as np, json, subprocess
from kokoro_onnx import Kokoro
k = Kokoro("/tmp/claude-0/tts/kokoro-v1.0.onnx", "/tmp/claude-0/tts/voices-v1.0.bin")
P = [
 ("A", "Every second, thousands of Bitcoin orders wait in the dark."),
 ("B", "Walls are built."),
 ("B", "Walls are pulled."),
 ("B", "And most traders never see it."),
 ("C", "Flowdeck turns the order book into light."),
 ("D", "A live heatmap of every resting order on the Binance Bitcoin perpetual."),
 ("E", "Trades burst as bubbles."),
 ("E", "Footprint."),
 ("E", "Delta."),
 ("E", "And volume profile."),
 ("E", "Tick by tick."),
 ("F", "Options gamma levels from Deribit, drawn right on the chart."),
 ("G", "Every number is checked against the exchange."),
 ("G", "Twenty-four of twenty-four minutes."),
 ("G", "Identical."),
 ("H", "No downloads."),
 ("H", "No eight-gigabyte installs."),
 ("H", "A browser tab,"),
 ("H", "on your desk,"),
 ("H", "or in your pocket."),
 ("I", "Start free for three days."),
 ("I", "Then four hundred and ninety-nine rupees a month."),
 ("J", "Flowdeck."),
 ("J", "See where the size is sitting."),
]
style = 0.55 * k.get_voice_style("am_michael") + 0.45 * k.get_voice_style("am_onyx")
SR = 48000
cues = []
t_end = 0
prev = None
track = np.zeros(int(SR * 60.5), dtype=np.float32)
for i, (plan, text) in enumerate(P):
    a, sr = k.create(text, voice=style, speed=0.95, lang="en-us")
    idx = np.where(np.abs(a) > 0.012)[0]
    a = a[max(0, idx[0] - 200): idx[-1] + 1800]
    sf.write(f"p_{i:02d}_raw.wav", a, sr)
    # deepen: -2 semitones with formants kept, then voice EQ + gentle compression
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", f"p_{i:02d}_raw.wav", "-af",
        "aresample=48000,rubberband=pitch=0.8909:formant=preserved:pitchq=quality,"
        "highpass=f=55,equalizer=f=110:t=q:w=1:g=3.5,equalizer=f=320:t=q:w=1.2:g=-2,"
        "equalizer=f=3200:t=q:w=1.5:g=2.5,equalizer=f=7500:t=q:w=2:g=-1.5,"
        "acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=3",
        "-ac", "1", "-ar", "48000", f"p_{i:02d}.wav"], check=True)
    b, _ = sf.read(f"p_{i:02d}.wav", dtype="float32")
    gap = 0.8 if i == 0 else (0.26 if plan == prev else 0.75)
    start = 0.9 if i == 0 else t_end + gap
    prev = plan
    s0 = int(start * SR)
    track[s0:s0 + len(b)] += b
    dur = len(b) / SR
    t_end = start + dur
    cues.append({"i": i, "sec": plan, "text": text, "start": round(start, 3), "end": round(t_end, 3)})
    print(f"{i:2d} {start:6.2f} -> {t_end:6.2f}  {text}")
peak = np.abs(track).max()
track = track / peak * 0.89
sf.write("vo_track.wav", track[: int(SR * 60)], SR)
json.dump(cues, open("cues.json", "w"), indent=1)
