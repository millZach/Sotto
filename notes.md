# Talk to Text (Sotto) — engineering notes

## 2026-08-27 — Retheming the whole app without moving one widget pixel
Redesigning the management window meant rewriting tokens.css, and the widget read
the same tokens, so any new teal would have leaked into the one surface that had
to stay frozen. The fix was two lines: give the widget its own copy of the old
token values in `widget/widget-tokens.css` and point `widget.css` at that instead
of `styles/tokens.css`. 16 pixel-baseline tests still report changedPixels === 0.
Then `npm run design:capture` scared me — the widget captured 124x54 against a
124x56 baseline, which looked like I'd broken it. Reverting my two widget-adjacent
files and re-running gave the same 124x54, so those app-review baselines were
already 2px stale at HEAD. Cost about 40 minutes; the lesson is to reproduce a
"regression" against the untouched tree before believing it.

## 2026-08-27 — Wiring remote ASR: the CSP decided the architecture, and jsdom lied about it
Adding the optional Parakeet server path looked like a renderer job until I read
the CSP: `connect-src 'self' sotto-model: sotto-runtime:` blocks any cross-origin
fetch, so the upload had to go through main over IPC — renderer encodes a PCM16
WAV, ships the ArrayBuffer across contextBridge, main owns the multipart POST.
Two things nearly cost me an evening. My live smoke test failed with HTTP 4xx
under vitest's default jsdom environment and passed instantly under `node` —
jsdom's Blob/FormData build a multipart body the server rejects, which has
nothing to do with Electron main. And Playwright's `electron.launch` died with a
useless "Process failed to launch!" because `ELECTRON_RUN_AS_NODE=1` was set in
my shell; Electron ran the entry as a plain Node script and `electron.app` came
back undefined. Once both were sorted: 10.3 s of audio, 185 ms round trip,
correct transcript.

## 2026-08-27 — Parakeet on the home GPU box: 6x faster than local Moonshine, not more accurate
Stood up NVIDIA Parakeet TDT 0.6B v3 (ONNX, CUDA) in Docker on the always-on
Linux box and benched it over Tailscale from the Windows machine: 48 ms for a
2 s clip vs Moonshine's 195 ms on-device, and 232 ms vs 1.3 s for a 16.6 s clip
— LAN round trip included. The surprise: mean WER came back worse (8.2% vs
6.0%), fumbling the same proper nouns as the 10x-smaller local model plus a few
more. The GPU bought a 6x speedup, not accuracy.

## 2026-08-14 — "Local model broken" was actually a silent microphone
Sotto stopped transcribing on Aug 12 and everything pointed at the local model.
Benchmarked the Moonshine weights directly (6% WER, fine), then scripted a full
dictation through both the dev build and the installed 3.3.4 with Chromium's
fake-microphone flag — both transcribed perfectly. Same test with the real mic:
"No speech was detected." The default capture device had fallen back to the
built-in Realtek mic array (AirPods Pro hands-free endpoint gone, external mic
unplugged), and it delivers ~0.003 RMS against the app's 0.01 silence gate.
Three hours of model forensics; the model was never the problem.
