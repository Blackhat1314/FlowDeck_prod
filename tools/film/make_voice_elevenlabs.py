"""Generate the Flowdeck film voiceover with ElevenLabs (David - Movie Trailer Narrator).

Run from this folder, in any terminal (Command Prompt, PowerShell, VS Code):
    python make_voice_elevenlabs.py

It asks for your API key (typing is hidden; the key is never saved), then writes
voice\\01 ... voice\\24 - one file per line, so each line can be placed exactly in the film.
Re-running skips lines that are already done. Only the Python standard library is used.
"""
import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

KEY = os.environ.get("ELEVEN_API_KEY", "").strip() or getpass.getpass("Paste your ElevenLabs API key (hidden): ").strip()
if not KEY:
    sys.exit("No API key given.")

API = "https://api.elevenlabs.io"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice")
os.makedirs(OUT, exist_ok=True)

LINES = [
    "Every second, thousands of Bitcoin orders wait in the dark.",
    "Walls are built.",
    "Walls are pulled.",
    "And most traders never see it.",
    "Flowdeck turns the order book into light.",
    "A live heatmap of every resting order on the Binance Bitcoin perpetual.",
    "Trades burst as bubbles.",
    "Footprint.",
    "Delta.",
    "And volume profile.",
    "Tick by tick.",
    "Options gamma levels from Deribit, drawn right on the chart.",
    "Every number is checked against the exchange.",
    "Twenty-four of twenty-four minutes.",
    "Identical.",
    "No downloads.",
    "No eight-gigabyte installs.",
    "A browser tab,",
    "on your desk,",
    "or in your pocket.",
    "Start free for three days.",
    "Then four hundred and ninety-nine rupees a month.",
    "Flowdeck.",
    "See where the size is sitting.",
]
SETTINGS = {"stability": 0.5, "similarity_boost": 0.75, "style": 0.3, "use_speaker_boost": True, "speed": 0.92}
MODEL = "eleven_multilingual_v2"
BRIAN = "nPczCjzI2devNBz1zQrb"  # built-in deep narrator, works on every plan
FORMATS = ["pcm_44100", "mp3_44100_192", "mp3_44100_128"]  # best first; the plan decides which is allowed


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"xi-api-key": KEY, "Content-Type": "application/json", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=120) as r:
        payload = r.read()
    return payload if raw else json.loads(payload or b"{}")


def err(e):
    try:
        return f"{e.code} {e.read()[:300].decode(errors='replace')}"
    except Exception:
        return str(e)


def find_david():
    try:  # already in "My voices"?
        for v in call("GET", "/v1/voices").get("voices", []):
            n = v.get("name", "").lower()
            if "david" in n and "trailer" in n:
                return v["voice_id"], v["name"]
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("The API key was rejected (401). Check it and try again.")
        print("Could not list your voices:", err(e))
    q = urllib.parse.urlencode({"search": "David Movie Trailer Narrator", "page_size": 30})
    try:  # find it in the Voice Library and add it to your voices
        found = call("GET", f"/v1/shared-voices?{q}").get("voices", [])
    except urllib.error.HTTPError as e:
        print("Voice Library search failed:", err(e))
        found = []
    for v in found:
        n = v.get("name", "").lower()
        if "david" in n and "trailer" in n:
            try:
                added = call("POST", f"/v1/voices/add/{v['public_owner_id']}/{v['voice_id']}", {"new_name": v["name"]})
                print("Added to your voices:", v["name"])
                return added.get("voice_id", v["voice_id"]), v["name"]
            except urllib.error.HTTPError as e:
                print("Could not add David to your voices:", err(e))
    return None, None


def speak(voice_id, i, fmt_list):
    body = {
        "text": LINES[i],
        "model_id": MODEL,
        "voice_settings": SETTINGS,
        "previous_text": " ".join(LINES[max(0, i - 2):i]) or None,
        "next_text": " ".join(LINES[i + 1:i + 3]) or None,
        "seed": 4242,
    }
    body = {k: v for k, v in body.items() if v is not None}
    last = None
    for f in fmt_list:
        try:
            return call("POST", f"/v1/text-to-speech/{voice_id}?output_format={f}", body, raw=True), f
        except urllib.error.HTTPError as e:
            last = e
            msg = err(e)
            print(f"   {f} not available: {msg[:160]}")
    raise last


voice_id, name = find_david()
if not voice_id:
    print("David - Movie Trailer Narrator is not available on this account; using Brian instead.")
    voice_id, name = BRIAN, "Brian"

# make sure the chosen voice can actually be used through the API on this plan (library voices may need a paid plan)
try:
    audio0, fmt = speak(voice_id, 0, FORMATS)
except urllib.error.HTTPError as e:
    if voice_id == BRIAN:
        sys.exit(f"Text-to-speech failed: {err(e)}")
    print(f"{name} can't be used through the API on this plan ({e.code}); using Brian instead.")
    voice_id, name = BRIAN, "Brian"
    audio0, fmt = speak(voice_id, 0, FORMATS)
print(f"Voice: {name} ({voice_id})  format: {fmt}\n")

ext = "pcm" if fmt.startswith("pcm") else "mp3"
marker = os.path.join(OUT, "info.json")
prev = json.load(open(marker)) if os.path.exists(marker) else {}
if prev.get("voice_id") != voice_id or prev.get("format") != fmt:  # different voice/format: start clean
    for f in os.listdir(OUT):
        if f[:2].isdigit():
            os.remove(os.path.join(OUT, f))
with open(marker, "w") as fh:
    json.dump({"voice": name, "voice_id": voice_id, "model": MODEL, "format": fmt, "settings": SETTINGS}, fh, indent=1)

for i, text in enumerate(LINES):
    path = os.path.join(OUT, f"{i + 1:02d}.{ext}")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        print(f"{i + 1:02d}  done already  {text}")
        continue
    audio = audio0 if i == 0 else speak(voice_id, i, [fmt])[0]
    with open(path, "wb") as fh:
        fh.write(audio)
    print(f"{i + 1:02d}  {len(audio) // 1024:>4} KB  {text}")
    time.sleep(0.3)

print(f"\nDone: {len(LINES)} lines in {OUT}. Tell Claude they're ready.")
