# The 60-second film

The film is rendered by the browser, frame by frame, from `frontend/film/` (Three.js scene + kinetic type).
Everything is a function of time, so the same frames come out on every run.

1. Voiceover. The film's choreography hangs off the line start times in `frontend/film/cues.json`.
   - **ElevenLabs (current voice: David - Movie Trailer Narrator).** Generate the script in
     `elevenlabs-script.txt` as one take on the ElevenLabs website and save it as `voice/David.mp3`, then
     `python fit_take.py voice/David.mp3`. It finds the 24 lines in the take by its pauses, places each line at
     its start time in the film and writes `vo/vo_track.wav` plus `vo/cues.json` (copy that to `frontend/film/`).
     Or run `python make_voice_elevenlabs.py` (asks for your API key) to fetch the lines one by one over the API;
     library voices such as David need a paid plan for API use.
   - **Offline fallback (Kokoro TTS).** `pip install kokoro-onnx soundfile`, download `kokoro-v1.0.onnx` and
     `voices-v1.0.bin` from the kokoro-onnx GitHub releases, then `python voiceover.py`.
2. Music and sound effects are synthesised by `python sound.py` and mixed under the voice (`mix_raw.wav`).
   Normalise: `ffmpeg -i mix_raw.wav -af loudnorm=I=-14:TP=-1.5 mix.wav`.
3. Frames: run `npm run dev` in `frontend/`, then `python render.py 0 1800` (Playwright + Chromium).
   It saves `frames/f_0000.jpg` … `f_1799.jpg`; run two copies with different ranges to use two cores.
   Don't edit files under `frontend/` while it renders: the dev server reloads the page and the render stops
   (re-run it; finished frames are skipped).
4. Encode: `ffmpeg -framerate 30 -i frames/f_%04d.jpg -i mix.wav -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart flowdeck-film.mp4`

Type in the film: Big Shoulders Display (headlines, weight animated thin to heavy as words land), Geist (supporting
lines) and Bricolage Grotesque (the Flowdeck wordmark, as on the website).

Paths inside the scripts point at a scratch folder; change them to suit your machine.

## Landing-page background loop

`frontend/film/loop.html` renders the silent 12-second hero loop (a corridor of light-strand liquidity walls,
locked-off camera). Every motion is periodic, so frame 360 equals frame 0. Render it like the film
(`render.py` pointed at `film/loop.html`, frames 0-359), then encode 387 frames: the 360 plus a repeat of the first 27,
so the page's two-video cross-fade at the loop point blends identical frames:
`ffmpeg -framerate 30 -i seq/s_%04d.jpg -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -an -movflags +faststart -g 30 hero-loop.mp4`
(and a VP9 `hero-loop.webm` for browsers without H.264). Both go in `frontend/src/landing/media/`.

For 4K screens, render `loop.html?pr=2` (3840 x 2160; point sizes scale with it) and encode the same way at
`-crf 24` as `hero-loop-4k.mp4`. The page only fetches it on large high-density displays.

