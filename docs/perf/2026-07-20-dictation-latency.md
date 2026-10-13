# Dictation latency: where the time goes (2026-07-20)

Investigation of why TalkType feels ~60% slower than Wispr Flow end-to-end.
All numbers measured on this machine (24-core CPU, Intel iGPU) with the
harness in `scripts/perf-bench/` (inference) and `Measure-Command` (paste stage).

## Latency model after the user stops speaking

```
stop hotkey
  → recorder finalize + resample          ~20 ms
  → whisper-base q8, 4-thread WASM        ~800 ms  (2 s utterance)
                                          ~1050 ms (4.4 s utterance)
                                          ~1690 ms (16.6 s utterance)
  → clipboard write + hideWidget          ~30 ms
  → pasteDelayMs (settings default)        150 ms
  → spawn powershell.exe + Add-Type        ~750–900 ms
  → SendInput Ctrl+V                      ~0 ms
─────────────────────────────────────────
total for a short phrase                  ~1.8–2.1 s
```

Wispr Flow streams to a cloud ASR while the user speaks, so its post-stop cost
is only finalization + native text injection (~0.2–0.5 s). Our gap is real and
comes from two places in roughly equal measure: **batch inference after stop**
and **~0.9 s of fixed output-delivery overhead**.

## Measurements

### Inference (transcribe wall time, steady state, run 2+)

| Model | 2.0 s clip | 4.4 s clip | 16.6 s clip |
|---|---|---|---|
| whisper-base q8 WASM 4t (current default) | ~800 ms | ~1030 ms | ~1690 ms |
| whisper-tiny q8 WASM 4t ("Fast" preset) | — | ~640 ms | ~1000 ms |
| moonshine-base q8 WASM 4t | **~80 ms** | **~220 ms** | **~870 ms** |
| whisper-base q8 WebGPU (Intel iGPU) | — | ~4100 ms | ~9800 ms |

- Whisper pads every utterance to a 30 s window, so the encoder pays a fixed
  cost regardless of clip length — that is why a 2 s phrase costs 800 ms.
  Moonshine's cost scales with audio length, which is exactly the dictation
  workload; transcript quality on the fixtures was equal or better
  (kept punctuation), but Moonshine is **English-only**.
- Thread scaling: 8 and 12 WASM threads measured identical to 4. The existing
  `MAX_INFERENCE_THREADS = 4` cap is correct; more CPU won't help.
- First transcribe after pipeline load is ~150–200 ms slower than subsequent
  runs. `prewarm()` loads the pipeline but never runs a warm-up inference, so
  the first dictation of a session always pays this.
- WebGPU: the packaged app ships only `ort-wasm-simd-threaded{,.asyncify}` in
  `resources/runtime` — no `.jsep` build — so ORT WebGPU can never initialize
  in production. With `inferencePreference: 'auto'` the adapter probe succeeds,
  the load fails, and the client tears down and restarts the worker before
  falling back to WASM (one wasted load per fresh worker, mostly at startup).
  Measured WebGPU on this machine's iGPU is 4–6× *slower* than WASM for the
  q8 graphs, so shipping jsep would be a regression, not a fix.

### Output delivery (per dictation, after transcription)

| Component | Cost |
|---|---|
| plain `powershell.exe` spawn | ~530 ms |
| spawn + `Add-Type` C# compile (3 runs) | 718 / 775 / 784 ms |
| `pasteDelayMs` default | 150 ms |

`buildPasteInvocation()` spawns a fresh PowerShell and recompiles the P/Invoke
helper on every paste. This is ~0.9 s of pure overhead added to every single
dictation after the transcript is already ready.

## Ranked fixes

1. **Replace the per-paste PowerShell spawn** (~−800 ms, low risk).
   Options: compile the SendInput helper once to a tiny cached .exe at first
   run and spawn that (~50 ms), or keep a persistent hidden helper process fed
   over stdin (~5 ms). Revisit whether `pasteDelayMs` default can drop to ~50 ms
   once the helper is fast (the 150 ms exists to let focus settle after
   `hideWidget`).
2. **Add Moonshine as the English fast path** (~−700 ms on typical phrases).
   `@huggingface/transformers` 4.2.0 supports `onnx-community/moonshine-base-ONNX`
   (q8, ~60 MB). Use it when the language is English; keep Whisper for
   multilingual. This is the single biggest inference win and removes the
   30 s-padding tax entirely.
3. **Warm-up inference in `prewarm()`** (~−200 ms on first dictation).
   Run ~1 s of silence through the pipeline after load.
4. **Stop attempting WebGPU in the packaged app** (startup churn only).
   `auto` should resolve straight to WASM (or the probe should verify the jsep
   runtime is actually present) instead of paying a doomed load + worker
   restart. Do not ship jsep: measured slower on iGPU.
5. **Not worth doing:** raising the WASM thread cap (no scaling past 4);
   WebGPU on q8 graphs (measured regression).

With fixes 1–3 a short English dictation lands around **0.3–0.45 s** after
stop — Wispr Flow territory — without any architectural change. Streaming
inference during recording remains the long-term option but is likely
unnecessary once Moonshine is in.

## Implementation status (same day)

All four fixes landed on `perf/dictation-latency`:

1. Warm paste helper (`src/main/output/pasteHelper.ts`) — persistent hidden
   PowerShell process compiled once at startup, ~5 ms per paste, one-shot spawn
   kept as fallback. Verified with the gated Windows smoke test.
2. Moonshine ships as the **Instant** preset (`onnx-community/moonshine-base-ONNX`,
   q8, ~67 MB optional download, MIT). English-only; Whisper presets remain for
   multilingual. Local-files inference verified at ~126 ms for a 2 s clip using
   exactly the seven locked files.
3. `prewarm()` now runs 1 s of silence through a newly loaded pipeline before
   reporting ready.
4. `auto` inference preference resolves straight to WASM.

## Reproducing

```
powershell -File scripts/perf-bench/gen-fixtures.ps1        # once
node scripts/perf-bench/bench-inference.mjs --clip tiny     # current stack
node scripts/perf-bench/bench-inference.mjs --model onnx-community/moonshine-base-ONNX --remote --clip tiny
node scripts/perf-bench/bench-inference.mjs --device webgpu --runtime full --headed
```
