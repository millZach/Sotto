# Talk to Text (Sotto) — engineering notes

## 2026-08-29 — Made the visual gate deterministic instead of refreshing it again
Third sub-perceptual gate failure in one day broke my patience with baseline
refreshes. Root causes found: the scripted E2E dictation stamped its history
entry with the wall clock, so every capture baked the run's minute into the
RECENT log; the processing breath line's infinite keyframes got captured at
whatever phase the screenshot landed on; and Chromium rasterization jitters by
1–5 channel units run to run. Three fixes: E2E entries now get one constant
timestamp, the harness pins infinite animations to phase zero before each
shot, and the comparator ignores per-channel deltas of 6 or less (real changes
measured 100+). Verified green minutes apart — the failure mode that used to
trip it. Playwright's clock API was a dead end first: page.clock.setFixedTime
does not work on Electron pages in 1.61.

## 2026-08-29 — Adding an auto-updater quietly added 16 packages to app.asar
Wiring electron-updater in was easy; the invariant it broke was not. Production
`dependencies` must stay exactly `['zod']`, so the updater gets compiled into
the main chunk as a devDependency — which means its whole CommonJS tree comes
along. One gate noticed: the external-dependency allowlist went from 11 to 25
entries (rollup leaves bare `require('http')` specifiers unprefixed, so the
list now carries both spellings). The notices gate did not, because it only
ever scanned the renderer bundle — so 16 packages were about to ship inside
app.asar unattributed. Added a bundled-dependency inventory to the main build
and those 16 components, including a Blue Oak license I had never met, to
THIRD_PARTY_NOTICES.md. Compiling a dependency in does not compile its license
away.

## 2026-08-29 — The design gate failed on pixels no human can see
Adding one <option> to a settings dropdown tripped the visual gate — on an
onboarding capture the change cannot touch. The diff: 1157 changed pixels, max
channel delta 5, all antialiasing on one button's border. Not my code (clean
HEAD failed identically — the lesson from last time, applied), not hover (I
parked the cursor at 0,0 by script and it still failed), not Windows updates
(none since Aug 12). The machine's rendering just drifted a hair in two days;
7 more baselines had the same drift under threshold. Refreshed all 8. If the
gate flaps back, the comparator needs a small per-channel noise floor.

## 2026-08-29 — Benched the new flash models: the 20x-cheaper one hallucinates
Ran the polish-pass bench against Gemini 3.7 Flash, DeepSeek v4 Flash 0731, and
GLM-5.3 Flash (8 models × 11 fixtures × 2 runs). DeepSeek at $0.045/M looked
like a steal until one fixture came back as pure word salad — OpenRouter spread
the calls across seven providers and one of them is just broken. GLM-5.3 Flash
was the real find: Haiku-grade cleanup at 7x cheaper than Nova, cold-start
spikes aside. Bonus lesson: the bench's saved API key had been quietly revoked,
so last month's all-ERROR run was an auth failure wearing a model-failure mask.

## 2026-08-28 — The release gate tripped on a chunk name, not a real bug
Cutting 3.4.0, the packaging verifier failed with "unsafe root-relative worklet
URL" — scary, because that check exists to catch a worklet path that breaks in
packaged builds. The worklet URL was fine; the redesign had shuffled Rollup's
module graph so audioRecorder landed in accelerator-*.js instead of main-*.js,
and the verifier only scanned main-*.js chunks. One regex widening and a full
rebuild (the provenance check rightly refused the stale installer) and the gate
went green. Checks pinned to bundler chunk names are time bombs.

## 2026-08-27 — The "clipped widget text" failing our visual gate was the widget working as designed
design:capture had been red on clean checkouts and everyone assumed stale
baselines. The actual failure: the harness flags any scrollWidth overrun in the
widget status line as clipped content, but that element literally declares
text-overflow: ellipsis — "Waiting for microphone" truncating IS the design.
One condition in the harness (skip the check when ellipsis+nowrap are declared)
and the whole 112-tuple capture suite went green again.

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
