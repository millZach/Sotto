# Agent startup correction — 2026-09-09

The first real development launch exposed two setup blockers and a recovery defect: T3 could not be found for pairing, missing wake settings produced an internal IPC error, and the connection button remained on “Connecting…” after failure.

## Cause and correction

The installed T3 executable and `resources/server.asar` were present. In Electron, `fs.promises.access()` on the archive root returned `ENOENT`; checking the executable, the archive with `stat()`, and its CLI entry separately all succeeded. The earlier live compatibility probe ran in ordinary Node, where the same archive-root access succeeds. That difference let the discovery defect escape the original check.

Discovery now uses `stat()` for the archive while retaining the executable accessibility check. Connection failure closes the host connection and restores the disconnected state, enabling deliberate retry. The UI displays the error once. Native voice errors retain their actionable message without Electron's IPC prefix, and missing voice folders expose **Set up voice**.

## Regression evidence

- `npx playwright test tests/e2e/t3Pairing.spec.ts --workers=1` first failed with the exact “T3 could not be located for local pairing” error. It now passes. It executes the production host in Electron against a real temporary ASAR fixture; only T3 CLI/network effects are controlled, so it creates no account session or model turn.
- `tests/e2e/agentSetup.spec.ts` first failed because the retry button never returned. It now verifies one visible error, an enabled retry button, and successful reconnection.
- The combined neighboring agent Electron run passed 16 tests; the corrected CLI fixture then passed its separate archive-discovery test. All 17 cases passed across those invocations.
- Eight focused voice tests passed, including an Electron-wrapped setup error and no capture before setup succeeds. Typecheck, lint and production build passed.

The CLI test fixture preserves Node's special promisified `execFile` result (`stdout` and `stderr`); the initial generic callback stub did not preserve that contract and was corrected before the final pass.

## Local application result

While Sotto was closed, the four previously verified wake-model files were copied from the task's temporary proof folder into a stable model directory in Sotto's local user profile. Only the empty wake model/runtime configuration fields were set; the runtime points to this checkout's existing pinned development dependency. The production wake probe revalidated both file sets at their configured location. No download or model redistribution was performed.

The normal development app was reopened in the existing user profile, with real local T3, OS credentials, microphone capture and wake service. Its visible Agents view showed **T3 Code connected · 0.0.38** and **Say “Hey Sotto”**, with projects/threads present and no startup errors. No thread was assigned or prompted during this correction. Human spoken recognition, acoustic accuracy and speaker quality are still unverified.

This correction is a local source/development fix. The previously built packaged application predates it; no updated installer, push or publication was made. The original wake distribution, billing and macOS release gates remain open.
