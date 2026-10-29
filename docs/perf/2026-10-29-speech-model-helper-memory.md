# Speech model memory with Parakeet in its helper

October 29, 2026, for #1787. What main holds with the speech model loaded, after dictation is turned off and after it is turned back on, with Parakeet running in main (`main` at `027fb5c96`) and in its own helper process (the fix). Measured with

```
npm run build
node scripts/measure-dictation-memory.mjs --profile <folder> --out <file>.json
```

The script runs the built app on a throwaway profile and chooses Parakeet Ultra (`parakeet-ultra-int8`) through the same bridge Settings uses. At each step it transcribes a 16.6-second clip (`scripts/asr-bench/fixtures/speech-long.wav`) and reads `app.getAppMetrics()` for main and the helper. It checks from outside the process whether main has the ONNX Runtime library loaded: `/proc/<pid>/maps` on Linux, PowerShell's module list on Windows. Every transcription succeeded, 38 words each time. The raw readings are in [`data/2026-10-29-speech-model-helper-memory/`](data/2026-10-29-speech-model-helper-memory/).

- **Linux:** forge (Core i5-14400F, Omarchy), under Xvfb.
- **Windows:** a `windows-latest` GitHub Actions runner, from a throwaway workflow on a branch deleted afterwards. The first Windows run asked main itself which libraries it had loaded (`process.report.getReport()`), and main died with `STATUS_HEAP_CORRUPTION`, once before any helper had started. The script now asks from outside.

## Main's working set, MB

| Step | Linux, main | Linux, fix | Windows, main | Windows, fix |
| --- | ---: | ---: | ---: | ---: |
| Model loaded | 1,083 | 398 | 1,017 | 318 |
| After one transcription | 1,261 | 401 | 1,135 | 318 |
| Dictation off, 5 s later | **1,034** | 427 | 251 | 317 |
| Back on, model loaded | 1,336 | 427 | 921 | 318 |
| After one transcription | **1,490** | 434 | 1,096 | 322 |
| ONNX Runtime loaded in main | always | never | always | never |

Windows private bytes follow the working set: 985, 1,201, 215, 888 and 1,162 MB with the model in main, and 297 to 300 MB at every step with the fix. On a fresh profile the fix's main read 397 MB just after the model downloaded and 362 after a transcription, then 235 with dictation off, 231 back on and 235 after a transcription, with the ONNX Runtime library never loaded.

## The helper, MB

Working set: about 750 to 790 once the model is loaded, 944 to 970 after a transcription, on both systems. It is gone within a second of dictation turning off, and the next one starts afresh when dictation comes back on.

## Reading

With the model in main, letting it go depends on V8 collecting sherpa's small JavaScript wrapper. On forge it never did. Main kept 1,034 MB with dictation off, and each time dictation came back on it loaded a second model beside the first, reaching 1,490 MB. On the Windows runner V8 did collect it this time, and main fell to 251 MB with the runtime library still loaded. The owner's laptop had kept about 1 GB. With the fix, main's working set does not move with the model on either system: what changes from step to step is startup settling, not the model. The model's memory is the helper's, and it goes when the helper does.
