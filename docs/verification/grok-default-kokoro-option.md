# Grok default and Kokoro option

Implemented locally on 2026-09-11. Fresh configuration uses Grok Altair. Kokoro Heart is an explicit lower-cost choice using the shared OpenRouter credential. Existing saved provider/voice selections survive restart; selecting one provider never silently falls back to another. Legacy system selection remains readable but is not offered for a new selection.

Kokoro requests fixed model hexgrad/kokoro-82m and voice af_heart. The main process holds the credential, validates and wraps PCM audio, bounds response size and duration, and cancels active synthesis when speech stops. Renderer receives WAV audio, never the key.

## Verification

- Typecheck, lint and production build passed.
- Focused service, IPC, recovery and renderer tests passed, including 47 Kokoro service cases.
- Three Electron journeys passed: natural voice selection, Grok rejected-key recovery/custom voice persistence, and Grok defaults plus Kokoro shared-key recovery/preview/persistence. Tests replace provider HTTP only. Old tests were corrected to close the current modal explicitly.
- Live Kokoro preview in the normal dev profile completed the speaking-to-wake transition with no voice error. This verifies application playback completion, not acoustic quality or speaker-onset timing.
- Inspected both the full settings sheet and footer Voice sheet. Fixed inherited no-wrap styling that clipped the footer sheet; its content width and scroll width now both measure 499 CSS pixels. Screenshots: artifacts/agent-control-smoke/kokoro-live.png and grok-default-live.png.
- Dev app restarted with the updated main process and renderer. Restored Grok Altair and the user's existing muted spoken-replies setting.

Final validation: 2,177 app unit/integration tests passed (eight skipped) with four workers, seven Node benchmark tests passed, and all three focused Electron voice journeys passed. Typecheck, lint and production build passed. The Node benchmark tests have a separate runner and are excluded from Vitest. The first unrestricted-concurrency run hit fixture timeouts; the four-worker rerun passed.

The [completed Windows playback benchmark](../perf/2026-09-11-tts-playback.md) adds 219 real-output trials and six cancellation/replacement checks. The additional listening page was checked in Electron for three voices, 24 fixtures, playback, choice persistence and layout. No release installer or macOS test was performed.
